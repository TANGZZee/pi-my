/**
 * T1-①②③ 升级能力承接测试：
 * - toolResultBrief：bash/powershell 结构化结果（SDK 0.99.x structuredContent）的摘要行为
 * - cache_warming / compaction_budget 四个新 RPC 的 sidecar↔rpc-policy 三方一致
 * - Settings「上下文」页接线形状
 * 视图 A = squash(stripComments(raw))（含字面量）；视图 B = 再 maskStrings（纯代码区）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { toolResultBrief } from '../src/run-slot.ts'
import { TIMEOUT_BY_TYPE, requestTimeoutMs } from '../src/rpc-policy.ts'
import { squash, stripComments, maskStrings, shapeWithLiteralMask, indexOfCode } from './helpers/source-assert.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function viewA(relative) {
  return squash(stripComments(readFileSync(join(root, relative), 'utf8')))
}
function viewB(relative) {
  return maskStrings(squash(stripComments(readFileSync(join(root, relative), 'utf8'))))
}

/**
 * 防诱饵计数（审查 E2 修补）：只统计「真实代码区」的命中。
 * maskStrings 会把字面量内容整个抹掉（type==='x' 在 viewB 里无法定位），
 * 所以用 shapeWithLiteralMask + indexOfCode：字面量/注释里的同形文本不计入。
 */
function countCodeHits(rawSource, needle) {
  const { shape, literal } = shapeWithLiteralMask(stripComments(rawSource))
  let count = 0
  let pos = 0
  while (true) {
    const idx = indexOfCode(shape, literal, needle, pos)
    if (idx < 0) break
    count++
    pos = idx + 1
  }
  return count
}

// ---------- T1-③ toolResultBrief 行为 ----------

test('toolResultBrief：结构化截断结果给出退出码 + 截断提示 + 完整输出路径', () => {
  const result = {
    structuredContent: {
      output: 'x'.repeat(2000),
      truncated: true,
      full_output_path: 'C:/tmp/pi-out-1.txt',
      exit_code: 0,
      wall_time_seconds: 1.2,
    },
  }
  const brief = toolResultBrief(result, 'bash')
  assert.ok(brief.startsWith('退出码 0'), `应以退出码开头: ${brief.slice(0, 40)}`)
  assert.ok(brief.includes('输出已截断'), '必须提示截断')
  assert.ok(brief.includes('C:/tmp/pi-out-1.txt'), '必须给出完整输出路径')
  // 1MiB 的 output 不该整体进预览（brief 已截断）
  assert.ok(brief.length < 600, `预览过长: ${brief.length}`)
})

test('toolResultBrief：非截断结构化结果只给退出码 + 短预览', () => {
  const brief = toolResultBrief(
    { structuredContent: { output: 'hello world', truncated: false, exit_code: 2 } },
    'bash',
  )
  assert.ok(brief.startsWith('退出码 2'), brief)
  assert.ok(brief.includes('hello world'), '非截断时保留输出预览')
  assert.ok(!brief.includes('截断'), '未截断不得提示截断')
})

test('toolResultBrief：非结构化结果回落旧行为（brief）', () => {
  assert.equal(toolResultBrief('plain text'), 'plain text')
  assert.equal(toolResultBrief(null), '')
  // show_image 的 details 形状：无 structuredContent → 整体 JSON 预览（旧行为）
  const legacy = toolResultBrief({ details: { images: [] } }, 'show_image')
  assert.ok(legacy.includes('details'), legacy)
})

// ---------- T1-①② sidecar 新 RPC 形状 ----------

const sidecarA = viewA('sidecar/index.mjs')
const sidecarB = viewB('sidecar/index.mjs')
const sidecarRaw = readFileSync(join(root, 'sidecar/index.mjs'), 'utf8')
// squash 后的分支区间定位用 viewA（字面量保留），计数用 countCodeHits（防诱饵）
const sectionOf = (startNeedle, endNeedle) => {
  const start = sidecarA.indexOf(startNeedle)
  const end = endNeedle ? sidecarA.indexOf(endNeedle, start + 1) : -1
  return sidecarA.slice(start, end > start ? end : start + 2000)
}

test('get/set_cache_warming：sidecar 分支存在且模式白名单 + 会话守卫齐全（防诱饵计数）', () => {
  // E2 修补：计数只算真实代码区命中，字符串/注释里的同形诱饵无效
  assert.equal(countCodeHits(sidecarRaw, "type==='get_cache_warming'"), 1, 'get_cache_warming 分支缺失或被诱饵污染')
  assert.equal(countCodeHits(sidecarRaw, "type==='set_cache_warming'"), 1, 'set_cache_warming 分支缺失或被诱饵污染')
  // set：模式白名单 + cacheWarmingStatus 读自 session
  assert.ok(sidecarA.includes("['off','streaming','idle']"), '模式白名单缺失')
  assert.ok(sidecarA.includes("entry.session.setCacheWarmingMode(mode)"), '必须走 session.setCacheWarmingMode')
  assert.ok(sidecarA.includes('entry.session.cacheWarmingStatus'), 'get 必须读 session.cacheWarmingStatus')
})

test('承重④（审查 P2-1/P2-5 修补锁定）：非法 mode 报错不回落；get 回显当前 mode', () => {
  const setSection = sectionOf("type==='set_cache_warming'", "type==='get_compaction_budget'")
  assert.ok(setSection.includes("!MODES.includes(payload.mode)"), '缺少白名单判定')
  assert.ok(setSection.includes('throw'), '非法 mode 必须 throw（静默回落会覆盖用户 off 并回显成功）')
  assert.ok(!setSection.includes(":'streaming'"), '三元回落形态残留')
  // P2-5：get 分支必须回显 mode（getCacheWarmingMode 透传）
  const getSection = sectionOf("type==='get_cache_warming'", "type==='set_cache_warming'")
  assert.ok(getSection.includes('getCacheWarmingMode'), 'get 必须回显当前预热模式（P2-5：按钮 active 态数据源）')
})

test('get/set_compaction_budget：sidecar 分支存在且写入走 markModified+save（防诱饵计数）', () => {
  assert.equal(countCodeHits(sidecarRaw, "type==='get_compaction_budget'"), 1, 'get_compaction_budget 分支缺失或被诱饵污染')
  assert.equal(countCodeHits(sidecarRaw, "type==='set_compaction_budget'"), 1, 'set_compaction_budget 分支缺失或被诱饵污染')
  assert.ok(sidecarA.includes("compaction.modelOverrides"), '必须写 modelOverrides')
  // 持久化：markModified + save()。参数用 viewA 的正则核（viewA 保留字面量）。
  assert.ok(sidecarA.includes('manager.markModified('), '缺少 markModified（改动不会持久化）')
  assert.ok(/manager\.markModified\('compaction',\s*'modelOverrides'\)/.test(sidecarA), 'markModified 参数错误')
  assert.ok(sidecarA.includes('manager.save()'), '缺少 save()（改动不会写盘）')
  // 越界防护：modelKey 长度上限
  assert.ok(sidecarA.includes('modelKey.length>200'), 'modelKey 长度校验缺失')
})

// ---------- 三方一致：rpc-policy 超时表 ↔ sidecar 分支 ↔ Settings 调用点 ----------

test('T1 新 RPC 三方一致：sidecar 分支 / TIMEOUT_BY_TYPE / Settings 调用全部登记', () => {
  const types = ['get_cache_warming', 'set_cache_warming', 'get_compaction_budget', 'set_compaction_budget']
  const settingsA = viewA('src/Settings.svelte')
  for (const type of types) {
    assert.equal(countCodeHits(sidecarRaw, `type==='${type}'`), 1, `sidecar 缺少 ${type} 分支`)
    assert.ok(TIMEOUT_BY_TYPE[type] > 0, `TIMEOUT_BY_TYPE 缺少 ${type}`)
    assert.equal(requestTimeoutMs(type), TIMEOUT_BY_TYPE[type], `${type} 超时回落异常`)
    assert.ok(settingsA.includes(`'${type}'`), `Settings.svelte 未调用 ${type}`)
  }
})

test('承重⑤（审查 P2-2/P2-3/P2-4 修补锁定）：非法 token 报错、上界钳制、SDK 私有 API 能力检测', () => {
  const section = sectionOf("type==='set_compaction_budget'", "type==='set_auto_compaction'")
  // P2-2：字段显式出现但非法必须 throw，不得静默略去变成"删条目"
  assert.ok(section.includes('!Number.isFinite(raw)||raw<=0'), '非法 token 必须 throw（静默略去会让"写"变"删"）')
  assert.ok((section.match(/throw/g) || []).length >= 2, 'token 非法与 modelKey 非法都要 throw')
  // P2-3：上界钳制
  assert.ok(section.includes('Math.min(Math.floor(raw),TOKEN_MAX)'), '缺少上界钳制（1e21 会架空压缩预算）')
  // P2-4：SDK private API 能力检测
  assert.ok(section.includes('typeofmanager.markModified!=='), '缺少 markModified 能力检测（SDK 升级静默丢改动）')
})

test('Settings「上下文」页接线：Tab/NAV/懒加载/activeSessionId 透传齐全', () => {
  const settingsA = viewA('src/Settings.svelte')
  assert.ok(settingsA.includes("'context'"), "Tab 联合缺少 'context'")
  assert.ok(settingsA.includes("['context','上下文']"), 'NAV 缺少上下文入口')
  assert.ok(settingsA.includes("tab==='context'"), '缺少 context 页懒加载触发')
  assert.ok(settingsA.includes('loadCacheWarming'), '缺少缓存预热加载')
  assert.ok(settingsA.includes('loadCompactionBudget'), '缺少压缩预算加载')
  assert.ok(settingsA.includes('exportletactiveSessionId'), '缺少 activeSessionId prop')
  const appShape = shapeWithLiteralMask(viewA('src/App.svelte'))
  // squash 后无空格：activeSessionId={activeSessionId} 的透传必须真实存在于模板代码区
  const needle = 'activeSessionId={activeSessionId}'
  assert.ok(indexOfCode(appShape.shape, appShape.literal, squash(needle)) >= 0, 'App.svelte 未向 Settings 透传 activeSessionId')
})

test('App 工具终态走 toolResultBrief（1MiB JSON 不再硬塞预览）', () => {
  const appB = viewB('src/App.svelte')
  assert.ok(appB.includes('toolResultBrief(event.result,'), 'tool_execution_end 必须经 toolResultBrief 摘要')
  // 旧调用（直接传 event.result）必须消失
  assert.ok(!appB.includes('endToolStep(id,String(event.toolName||\'工具\'),String(event.toolCallId||\'\'),event.result,'), '旧 endToolStep 直接传 result 的调用残留')
})
