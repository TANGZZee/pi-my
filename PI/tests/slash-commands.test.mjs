// 斜杠命令注册表单测
//
// 核心目的：从结构上杜绝"命令列出来了、但分派里没实现"这一类缺陷。
// 旧实现就是这个 bug —— 命令面板列 10 条，分派只有 5 条有分支，
// 其余全部落到兜底 `else void chooseWorkspace()`，于是打 `/compact` 会弹出「选择工作区」。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { SLASH_COMMANDS, SLASH_KINDS, filterSlashCommands, findSlashCommand, slashTriggerQuery } from '../src/slash-commands.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const appSource = readFileSync(path.join(here, '..', 'src', 'App.svelte'), 'utf8')
// 0-5 批次 C：mention/applyMention 随 Composer 组件走，scout 预填断言改读组件源码。
const composerSource = readFileSync(path.join(here, '..', 'src', 'Composer.svelte'), 'utf8')

/** 从 App.svelte 的 runSlashCommand 里提取所有 `case 'xxx':` 分支 */
function dispatchedKinds() {
  const start = appSource.indexOf('function runSlashCommand')
  assert.ok(start > 0, 'App.svelte 里找不到 runSlashCommand')
  // 取到下一个顶层函数定义之前
  const rest = appSource.slice(start)
  const end = rest.indexOf('\n  /** 压缩当前会话上下文')
  const body = end > 0 ? rest.slice(0, end) : rest
  const kinds = new Set()
  for (const match of body.matchAll(/case '([a-z-]+)':/g)) kinds.add(match[1])
  return kinds
}

test('每条命令的 kind 都有对应的分派分支（杜绝"列了但没实现"）', () => {
  const dispatched = dispatchedKinds()
  assert.ok(dispatched.size >= 8, `只解析到 ${dispatched.size} 个分支，解析逻辑可能失效`)
  const missing = SLASH_COMMANDS.filter((command) => !dispatched.has(command.kind))
  assert.deepEqual(
    missing.map((c) => `/${c.id}(${c.kind})`),
    [],
    '以下命令没有分派分支，选中后会静默无反应或做错事',
  )
})

test('注册表没有声明未使用的 kind（避免僵尸类别）', () => {
  const dispatched = dispatchedKinds()
  const declared = new Set(SLASH_COMMANDS.map((command) => command.kind))
  const unused = [...declared].filter((kind) => !dispatched.has(kind))
  assert.deepEqual(unused, [], `注册表声明了但没人分派的 kind: ${unused.join(', ')}`)
})

test('SLASH_KINDS 与注册表实际用到的 kind 一致', () => {
  const declared = new Set(SLASH_COMMANDS.map((command) => command.kind))
  assert.deepEqual([...declared].sort(), [...new Set(SLASH_KINDS)].sort())
})

test('命令 id 唯一且非空（防止 findSlashCommand 取到错的那个）', () => {
  const ids = SLASH_COMMANDS.map((command) => command.id)
  assert.equal(new Set(ids).size, ids.length, 'id 有重复')
  for (const command of SLASH_COMMANDS) {
    assert.ok(command.id && typeof command.id === 'string')
    assert.ok(command.label, `/${command.id} 缺少 label`)
    assert.ok(command.desc, `/${command.id} 缺少 desc（命令面板要展示）`)
    // id 不应含空格，否则无法用 /id 触发
    assert.equal(/\s/.test(command.id), false, `/${command.id} 的 id 含空格`)
  }
})

test('此前是假命令的三条现在确有实现（回归保护）', () => {
  // /compact 曾弹出「选择工作区」，/export 与 /workspace 同样走错分支
  const compact = findSlashCommand('/compact')
  assert.equal(compact?.kind, 'compact', '/compact 必须映射到 compact')
  const exportCmd = findSlashCommand('/export')
  assert.equal(exportCmd?.kind, 'export-session')
  const workspace = findSlashCommand('/workspace')
  assert.equal(workspace?.kind, 'choose-workspace')
  // 且分派里真的有这些分支
  const dispatched = dispatchedKinds()
  for (const kind of ['compact', 'export-session', 'choose-workspace']) {
    assert.ok(dispatched.has(kind), `分派缺少 ${kind}`)
  }
})

test('兜底分支不再默默做别的事', () => {
  // 旧实现的 default 是 `else void chooseWorkspace()`；现在必须是显式告警。
  const start = appSource.indexOf('function runSlashCommand')
  const body = appSource.slice(start, start + 1200)
  assert.match(body, /default:/, 'runSlashCommand 应有 default 分支')
  assert.match(body, /console\.warn/, 'unknown kind 必须告警而不是静默执行别的命令')
})

test('findSlashCommand 大小写不敏感、支持 label、拒绝非命令', () => {
  assert.equal(findSlashCommand('/COMPACT')?.id, 'compact', 'id 匹配应大小写不敏感')
  assert.equal(findSlashCommand('/压缩上下文')?.id, 'compact', '应支持用中文 label 触发')
  assert.equal(findSlashCommand('compact'), null, '没有前导 / 不算命令')
  assert.equal(findSlashCommand('/'), null)
  assert.equal(findSlashCommand(''), null)
  assert.equal(findSlashCommand('/不存在的命令'), null)
})

test('filterSlashCommands 空查询返回全部，查询可过滤', () => {
  assert.equal(filterSlashCommands('').length, SLASH_COMMANDS.length)
  const hits = filterSlashCommands('comp')
  assert.ok(hits.some((command) => command.id === 'compact'))
  assert.equal(filterSlashCommands('zzz').length, 0)
})

test('slashTriggerQuery：仅行首 / 且无空格时触发补全', () => {
  assert.equal(slashTriggerQuery('/'), '')
  assert.equal(slashTriggerQuery('/com'), 'com')
  assert.equal(slashTriggerQuery('/compact '), null, '有空格说明参数开始了，不该继续补全命令')
  assert.equal(slashTriggerQuery('a /compact'), null, '不在行首不触发')
  assert.equal(slashTriggerQuery('普通文本'), null)
  assert.equal(slashTriggerQuery('/a\n/b'), null, '多行不触发')
})

test('需要参数的命令在注册表里有据可依（scout 预填）', () => {
  // applyMention 对 scout 做预填而非直接执行；这里确认 scout 确实用它自己的 id
  const scout = SLASH_COMMANDS.find((command) => command.id === 'scout')
  assert.ok(scout, 'scout 命令应存在')
  assert.match(composerSource, /command\.id === 'scout'/, 'applyMention 应对 scout 预填参数')
})
