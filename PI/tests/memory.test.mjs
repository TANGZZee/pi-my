// 长期记忆 LTM 单测（2-2）
//
// 核心契约：项目隔离、FTS 中文/英文搜索、取代链、schema 版本守卫。
// 用独立的临时 agentDir（每个用例独立 db 文件），避免污染真实 ~/.pi。
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import {
  closeMemoryDb,
  deleteMemory,
  listMemories,
  rememberMemory,
  searchMemories,
  supersedeMemory,
} from '../sidecar/memory.mjs'

const sandbox = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ltm-'))
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true })

test('写入与列出：项目隔离（不同 cwd 互不可见）', () => {
  const dir = sandbox()
  try {
    rememberMemory(dir, 'D:\\Proj\\A', '项目 A 的构建命令是 pnpm build', ['build'])
    rememberMemory(dir, 'd:/proj/a/', '项目 A 的第二个记忆')
    rememberMemory(dir, 'D:/Proj/B', '项目 B 的记忆')
    // 同一项目的两种路径写法应归一（大小写/反斜杠）
    const listA = listMemories(dir, 'D:\\Proj\\A')
    assert.equal(listA.length, 2, '路径归一后同一项目')
    assert.equal(listMemories(dir, 'D:/Proj/B').length, 1)
  } finally {
    closeMemoryDb()
    cleanup(dir)
  }
})

test('FTS5 英文搜索', () => {
  const dir = sandbox()
  try {
    rememberMemory(dir, '/p', 'deploy with pnpm and docker compose')
    rememberMemory(dir, '/p', 'typescript strict mode is enabled')
    assert.equal(searchMemories(dir, '/p', 'docker').length, 1)
    assert.equal(searchMemories(dir, '/p', 'pnpm docker').length, 1, '多词 AND 语义（phrase 内）')
    assert.equal(searchMemories(dir, '/p', 'rust').length, 0)
  } finally {
    closeMemoryDb()
    cleanup(dir)
  }
})

test('FTS5 中文搜索：3 字以上走 MATCH，2 字回退 LIKE', () => {
  const dir = sandbox()
  try {
    rememberMemory(dir, '/c', '这个项目用 pnpm 而不是 npm 管理依赖')
    assert.equal(searchMemories(dir, '/c', 'pnpm 而不是').length, 1, '混合词 phrase')
    assert.equal(searchMemories(dir, '/c', '依赖').length, 1, '2 字中文回退 LIKE')
    assert.equal(searchMemories(dir, '/c', '不存在的词组').length, 0)
  } finally {
    closeMemoryDb()
    cleanup(dir)
  }
})

test('取代链：旧记忆不删除、查询排除、新记忆可见', () => {
  const dir = sandbox()
  try {
    const first = rememberMemory(dir, '/s', '部署地址是 v1.example.com')
    const r = supersedeMemory(dir, '/s', first.id, '部署地址已改为 v2.example.com')
    assert.equal(r.newId > r.oldId, true)
    const list = listMemories(dir, '/s')
    assert.equal(list.length, 2, '两条都在（可追溯）')
    const hits = searchMemories(dir, '/s', '部署地址')
    assert.equal(hits.length, 1, '搜索只命中未取代的新记忆')
    assert.match(hits[0].content, /v2/)
    // 旧内容仍可直接列出时看到 supersededBy 标记
    const old = list.find((m) => m.id === first.id)
    assert.equal(old.supersededBy, r.newId)
  } finally {
    closeMemoryDb()
    cleanup(dir)
  }
})

test('删除：真删，且 FTS 同步（搜不到已删内容）', () => {
  const dir = sandbox()
  try {
    const m = rememberMemory(dir, '/d', 'unique-zebra-marker 记忆')
    assert.equal(deleteMemory(dir, '/d', m.id).deleted, true)
    assert.equal(deleteMemory(dir, '/d', m.id).deleted, false, '重复删除幂等')
    assert.equal(searchMemories(dir, '/d', 'unique-zebra-marker').length, 0, 'FTS 触发器同步删除')
  } finally {
    closeMemoryDb()
    cleanup(dir)
  }
})

test('SQL 注入防护：MATCH 查询串里的运算符按字面处理', () => {
  const dir = sandbox()
  try {
    rememberMemory(dir, '/i', '安全测试条目')
    // FTS5 运算符注入：不应抛错、不应命中别的行
    const r = searchMemories(dir, '/i', '" OR 1=1 --')
    assert.equal(r.length, 0, '注入串按字面短语处理')
  } finally {
    closeMemoryDb()
    cleanup(dir)
  }
})

test('空查询与超限 limit 钳制', () => {
  const dir = sandbox()
  try {
    assert.deepEqual(searchMemories(dir, '/e', ''), [])
    for (let i = 0; i < 5; i++) rememberMemory(dir, '/e', `记忆 ${i}`)
    assert.equal(listMemories(dir, '/e', 3).length, 3)
  } finally {
    closeMemoryDb()
    cleanup(dir)
  }
})
