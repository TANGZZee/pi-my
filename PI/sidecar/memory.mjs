// 长期记忆 LTM（2-2，设计移植自 pi-agent-desktop：SQLite FTS5 + trigram）
//
// 数据模型：memories(id, project, content, tags, created_at, updated_at, superseded_by)
//   - project 隔离：记忆按项目（cwd 归一）分域，互不可见
//   - superseded_by：取代链——新记忆取代旧记忆时不删除（可追溯），查询时排除被取代的
//   - FTS5 trigram：英文天然支持；中文 3 字以上走 MATCH，2 字回退 LIKE（trigram 最小 token 限制）
//
// schema 演进守卫（pi-agent-desktop 的核心经验）：
//   FTS5 虚拟表 CREATE 后**无法改分词器**，只能 drop→recreate→repopulate。
//   因此用 PRAGMA user_version 守卫 schema 版本，未来分词器/表结构变更时
//   版本不匹配 → drop 重建并重灌（memories 主表数据保留）。
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const SCHEMA_VERSION = 1

let db = null

/** 打开（或迁移）项目级记忆库。库文件全局共用，行级 project 字段隔离。 */
export function openMemoryDb(agentDir) {
  if (db) return db
  const dir = path.join(agentDir, 'memory')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'ltm.db')
  db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')

  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0)
  if (version !== SCHEMA_VERSION) {
    // 版本不匹配：FTS 表无法原地改分词器 → drop 重建（主表数据保留重灌）
    if (version > 0) {
      db.exec('DROP TABLE IF EXISTS memories_fts')
      // 旧主表结构兼容时保留数据；否则一并重建
      const hasTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'")
        .get()
      if (hasTable) {
        const rows = db.prepare('SELECT * FROM memories').all()
        db.exec('DROP TABLE memories')
        createTables(db)
        const insert = db.prepare(
          'INSERT INTO memories (id, project, content, tags, created_at, updated_at, superseded_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        for (const row of rows) {
          insert.run(row.id, row.project, row.content, row.tags, row.created_at, row.updated_at, row.superseded_by)
        }
        db.prepare(`PRAGMA user_version = ${SCHEMA_VERSION}`).run()
        return db
      }
    }
    db.exec('DROP TABLE IF EXISTS memories_fts')
    db.exec('DROP TABLE IF EXISTS memories')
    createTables(db)
    db.prepare(`PRAGMA user_version = ${SCHEMA_VERSION}`).run()
  }
  return db
}

function createTables(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      superseded_by INTEGER
    )
  `)
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      tokenize='trigram',
      content='memories',
      content_rowid='id'
    )
  `)
  // 外部内容表：用触发器保持 FTS 与主表同步
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END
  `)
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END
  `)
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END
  `)
}

/** 项目键：与权限引擎/信任同一路径归一口径 */
export function memoryProjectKey(cwd) {
  return path.resolve(String(cwd || '.')).replaceAll('\\', '/').toLowerCase()
}

/** 写入记忆；返回 id。 */
export function rememberMemory(agentDir, cwd, content, tags = []) {
  const database = openMemoryDb(agentDir)
  const now = Date.now()
  const result = database
    .prepare('INSERT INTO memories (project, content, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(memoryProjectKey(cwd), String(content ?? '').trim(), (Array.isArray(tags) ? tags : []).join(','), now, now)
  return { id: Number(result.lastInsertRowid) }
}

/**
 * 搜索记忆（活跃的、未被取代的）。
 * 中文 2 字查询回退 LIKE；≥3 字走 FTS5 trigram MATCH。
 */
export function searchMemories(agentDir, cwd, query, limit = 20) {
  const database = openMemoryDb(agentDir)
  const project = memoryProjectKey(cwd)
  const trimmed = String(query ?? '').trim()
  if (!trimmed) return []
  const base = 'FROM memories WHERE project = ? AND superseded_by IS NULL AND '
  const params = [project]
  let where
  const isCjkShort = /^[\u4e00-\u9fff]{1,2}$/.test(trimmed.replace(/\s+/g, ''))
  let likeFilter = null
  if (isCjkShort || trimmed.length < 3) {
    // trigram 最小 3 字符：短查询回退 LIKE
    where = 'content LIKE ?'
    params.push(`%${trimmed.replace(/["%_\\]/g, (m) => `\\${m}`)}%`)
  } else {
    // FTS5：拆词后用 AND 连接（用户预期"都包含"）；每词加双引号防运算符注入。
    // 注意：MATCH 的查询表达式必须是**一个**参数（"a" AND "b" 整体），
    // 不能展开成多个 ? —— 那是另一个谓词，不是 AND 检索。
    // trigram 最小 3 字符：<3 的词（含 2 字中文词）进不了 MATCH，
    // 改为附加 LIKE 过滤（AND 语义保持）。
    const matchTerms = []
    const likeTerms = []
    for (const term of trimmed.split(/\s+/)) {
      const isShort = term.length < 3 && !/[\u4e00-\u9fff]{3}/.test(term)
      if (isShort) likeTerms.push(term)
      else matchTerms.push(`"${term.replace(/"/g, '""')}"`)
    }
    if (!matchTerms.length) {
      where = 'content LIKE ?'
      params.push(`%${trimmed.replace(/["%_\\]/g, (m) => `\\${m}`)}%`)
    } else {
      where = 'id IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?)'
      params.push(matchTerms.join(' AND '))
      if (likeTerms.length) {
        for (const term of likeTerms) {
          where += ' AND content LIKE ?'
          params.push(`%${term.replace(/["%_\\]/g, (m) => `\\${m}`)}%`)
        }
      }
    }
  }
  const sql = `SELECT id, content, tags, created_at, updated_at ${base} ${where} ORDER BY updated_at DESC LIMIT ?`
  params.push(Math.min(Math.max(1, limit), 100))
  return database.prepare(sql).all(...params).map(hydrateMemory)
}

/** 取项目全部活跃记忆（带取代链标注）。 */
export function listMemories(agentDir, cwd, limit = 100) {
  const database = openMemoryDb(agentDir)
  return database
    .prepare('SELECT id, content, tags, created_at, updated_at, superseded_by FROM memories WHERE project = ? ORDER BY updated_at DESC LIMIT ?')
    .all(memoryProjectKey(cwd), Math.min(Math.max(1, limit), 500))
    .map((row) => ({ ...hydrateMemory(row), supersededBy: row.superseded_by ?? null }))
}

/** 取代：新记忆取代旧记忆（旧条目不删除，打上取代标记——可追溯）。 */
export function supersedeMemory(agentDir, cwd, oldId, newContent, tags = []) {
  const database = openMemoryDb(agentDir)
  const created = rememberMemory(agentDir, cwd, newContent, tags)
  database
    .prepare('UPDATE memories SET superseded_by = ? WHERE id = ? AND project = ?')
    .run(created.id, Number(oldId), memoryProjectKey(cwd))
  return { oldId: Number(oldId), newId: created.id }
}

/** 删除记忆（真删；取代链里的标记保留原值）。 */
export function deleteMemory(agentDir, cwd, id) {
  const database = openMemoryDb(agentDir)
  const result = database
    .prepare('DELETE FROM memories WHERE id = ? AND project = ?')
    .run(Number(id), memoryProjectKey(cwd))
  return { deleted: Number(result.changes) > 0 }
}

function hydrateMemory(row) {
  return {
    id: Number(row.id),
    content: String(row.content),
    tags: row.tags ? String(row.tags).split(',').filter(Boolean) : [],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

/** 测试用：关闭并释放连接。 */
export function closeMemoryDb() {
  if (db) {
    db.close()
    db = null
  }
}
