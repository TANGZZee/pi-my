/**
 * T2⑦ 上下文编辑原生化 承重测试：
 * - sidecar：list_context（buildContextEntries 口径，message/custom_message 条目 +
 *   collectContextEdits 汇总）/ apply_context_edit（running 守卫 + targetId 存在性 +
 *   replacement 形状守卫 + SDK appendContextEdit）；context_edit 不进聊天时间线（语义锁定）。
 * - rpc-policy：list_context / apply_context_edit 超时登记。
 * - App.svelte：剔除按钮 → window.confirm → apply_context_edit(replacement:null) →
 *   刷新编辑清单；selectSession 重置并拉取；面板 keyed each；双位置按钮禁用绑定。
 * - run-slot.ts：TimelineMessage.entryId 字段与 historyToTimeline 透传（SDK 条目 id 直达 UI）。
 * 视图 A = squash(stripComments(raw))；计数用 countCodeHits（防字面量诱饵）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { TIMEOUT_BY_TYPE, requestTimeoutMs } from '../src/rpc-policy.ts'
import {
  squash,
  stripComments,
  shapeWithLiteralMask,
  indexOfCode,
  functionBodyOf,
} from './helpers/source-assert.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function viewA(relative) {
  return squash(stripComments(readFileSync(join(root, relative), 'utf8')))
}

/** 防诱饵计数：只统计「真实代码区」的命中（字符串/注释里的同形文本不计入）。 */
function countCodeHits(rawSource, needle) {
  const { shape, literal } = shapeWithLiteralMask(stripComments(rawSource))
  let count = 0
  let pos = 0
  for (;;) {
    const idx = indexOfCode(shape, literal, needle, pos)
    if (idx < 0) break
    count += 1
    pos = idx + 1
  }
  return count
}

const sidecarA = viewA('sidecar/index.mjs')
const sidecarRaw = readFileSync(join(root, 'sidecar/index.mjs'), 'utf8')
const sectionOf = (startNeedle, endNeedle) => {
  const start = sidecarA.indexOf(startNeedle)
  const end = endNeedle ? sidecarA.indexOf(endNeedle, start + 1) : -1
  return sidecarA.slice(start, end > start ? end : start + 2600)
}

// ---------- sidecar：list_context ----------

test('list_context：buildContextEntries 口径 + message/custom_message 条目 + edits 汇总', () => {
  assert.equal(countCodeHits(sidecarRaw, "type==='list_context'"), 1, 'list_context 分支缺失或被诱饵污染')
  const section = sectionOf("type==='list_context'", "type==='apply_context_edit'")
  // 会话寻址守卫（缺会话必须 throw，不能静默空列表）
  assert.ok(section.includes('会话不存在'), 'list_context 缺少会话寻址守卫')
  // 口径锁定：与 sessionHistory 一致走 buildContextEntries()（compaction 感知、沿当前叶路径）
  assert.ok(section.includes('session.sessionManager.buildContextEntries()'), 'list_context 必须走 buildContextEntries()')
  // message 条目：role 三态 + 文本抽取
  assert.ok(section.includes("message.role!=='user'&&message.role!=='assistant'&&message.role!=='toolResult'"), 'message 条目必须覆盖 user/assistant/toolResult 三态')
  assert.ok(section.includes('contentText(message.content)'), 'message 条目文本必须经 contentText 抽取')
  // custom_message 条目（插件消息也是模型可见形态，可被治理）
  assert.ok(section.includes("kind:'custom_message'"), 'custom_message 条目缺失')
  // edits 汇总 + 响应形状
  assert.ok(section.includes('collectContextEdits(entry.session.sessionManager)'), 'list_context 必须汇总 collectContextEdits')
  assert.ok(section.includes('reply(id,{items,edits})'), 'list_context 响应必须含 items 与 edits')
})

test('apply_context_edit：running 守卫 + targetId 存在性 + replacement 形状守卫 + SDK appendContextEdit', () => {
  assert.equal(countCodeHits(sidecarRaw, "type==='apply_context_edit'"), 1, 'apply_context_edit 分支缺失或被诱饵污染')
  const section = sectionOf("type==='apply_context_edit'", "type==='set_model'")
  // 运行中禁止编辑（与 compact_session 同款守卫）
  assert.ok(section.includes('会话正在运行，无法编辑上下文'), 'apply_context_edit 缺少 running 守卫')
  // 目标必须真实存在（appendContextEdit 对幽灵 targetId 不报错，必须先行校验）
  assert.ok(section.includes('session.sessionManager.getEntry(targetId)'), 'targetId 必须先经 getEntry 校验')
  // replacement 形状：null 直通（剔除）；否则 {content}，content 必须 string 或数组
  assert.ok(section.includes('constreplacement=payload.replacement===null?null:{content:payload.replacement?.content}'), 'replacement 归一缺失（null 直通 + {content} 包裹）')
  assert.ok(section.includes('replacement.content必须是字符串或TextContent/ImageContent数组'), '非法 content 形状必须 throw')
  // 必须走 SDK 原生 API 追加编辑条目
  assert.ok(section.includes('appendContextEdit(targetId,replacement)'), '必须调 SDK appendContextEdit')
  // tokens 假功能反转（对抗审查【中】级发现）：SDK SessionProjection 没有 tokens 字段，
  // 曾写的 `projection?.tokens ?? 0` 恒为 0 —— 响应必须不带 tokens，也不得保留死投影调用。
  assert.ok(!section.includes('tokens'), 'apply_context_edit 响应不得携带 tokens（SessionProjection 无此字段，恒 0 属假功能）')
  assert.ok(!section.includes('buildSessionProjection()'), '不得保留死投影调用（其结果无消费）')
})

test('collectContextEdits：只收集 context_edit 条目，removed=replacement 为 null', () => {
  const body = functionBodyOf(sidecarRaw, 'collectContextEdits')
  assert.ok(body.includes("if(item.type!=='context_edit')continue"), '必须按 type===context_edit 过滤')
  assert.ok(body.includes('removed:replacement===null'), 'removed 语义必须锁定为 replacement===null（剔除）')
  assert.ok(body.includes('targetId:typeofitem.targetId===\'string\'?item.targetId:\'\''), 'targetId 透传缺失')
})

test('语义锁定：context_edit 不进聊天时间线（sessionHistory 保持跳过非 message/custom_message 条目）', () => {
  const body = functionBodyOf(sidecarRaw, 'sessionHistory')
  assert.ok(!body.includes('context_edit'), 'sessionHistory 不得消费 context_edit（剔除≠撤回，时间线仍显示原文）')
})

// ---------- rpc-policy：超时登记 ----------

test('list_context / apply_context_edit 超时登记：rpc-policy ↔ sidecar 分支一致', () => {
  for (const type of ['list_context', 'apply_context_edit']) {
    assert.equal(countCodeHits(sidecarRaw, `type==='${type}'`), 1)
    assert.ok(TIMEOUT_BY_TYPE[type] > 0, `TIMEOUT_BY_TYPE 缺少 ${type}`)
    assert.equal(requestTimeoutMs(type), TIMEOUT_BY_TYPE[type])
  }
  // M17 存活缺口修补：数值漂移（如 61_000）原先只查 key 存在抓不住，锁精确值。
  assert.equal(TIMEOUT_BY_TYPE.list_context, 60_000, 'list_context 超时必须为 60s（大会话几千条目全量列举）')
  assert.equal(TIMEOUT_BY_TYPE.apply_context_edit, 30_000, 'apply_context_edit 超时必须为 30s（append-only JSONL 写）')
})

// ---------- App.svelte：UI 接线 ----------

const appA = viewA('src/App.svelte')

test('removeContextEntry：守卫 + confirm 门 + apply_context_edit(replacement:null) + busy 释放 + 刷新', () => {
  const body = functionBodyOf(appSourceRaw(), 'removeContextEntry')
  // 守卫：入口钉死 activeSessionId；会话 id 缺失/sidecar 未就绪/busy 直接 return；会话在跑不得编辑
  assert.ok(body.includes('constidAtEntry=activeSessionId'), '入口必须钉死 activeSessionId（防 await 后切会话写错目标）')
  assert.ok(body.includes('if(!idAtEntry||!sidecarReady||ctxEditBusyId)return'), 'removeContextEntry 缺少就绪/busy 守卫')
  assert.ok(body.includes('if(slotFor(idAtEntry).running)return'), 'removeContextEntry 缺少运行中守卫')
  // 剔除不可逆，必须有 confirm 门
  assert.ok(body.includes('window.confirm('), '剔除操作缺少 confirm 门（append-only 不可逆，用户必须知情）')
  // 必须带 replacement:null 发起剔除（与 SDK ContextEditEntry 的 null=剔除语义对齐）；会话 id 用钉死变量
  assert.ok(body.includes("requestOk('apply_context_edit',{sessionId:idAtEntry,targetId:entryId,replacement:null})"), '必须调 apply_context_edit 且 replacement:null')
  // busy 状态必须释放
  assert.ok(body.includes('ctxEditBusyId=entryId'), 'busy 标记缺失')
  assert.ok(body.includes("ctxEditBusyId=''"), 'busy 释放缺失')
  // 成功后按钉死的会话刷新编辑清单（否则按钮态与面板陈旧；await 保证失败能进 catch 提示）
  assert.ok(body.includes('awaitrefreshCtxEdits(idAtEntry)'), '剔除成功后必须刷新编辑清单')
})

function appSourceRaw() {
  return readFileSync(join(root, 'src/App.svelte'), 'utf8')
}

test('refreshCtxEdits：list_context 拉取 + 失败静默清空；editedEntryIds 派生自 ctxEdits', () => {
  const refresh = functionBodyOf(appSourceRaw(), 'refreshCtxEdits')
  assert.ok(refresh.includes("requestOk('list_context',{sessionId})"), 'refreshCtxEdits 必须调 list_context')
  assert.ok(refresh.includes('ctxEdits=result?.edits??[]'), 'edits 必须落到 ctxEdits（成功路径）')
  // M15 存活缺口修补：「失败静默清空」原先只写在测试名里，catch 行为零断言。
  // 锁三件套：入口 id 快照（会话守卫）+ 成功侧作废检查 + catch 侧守卫下的清空。
  assert.ok(refresh.includes('constidAtEntry=activeSessionId'), 'refreshCtxEdits 缺少入口会话快照（与 refreshCtxStats 同款守卫）')
  assert.ok(refresh.includes('if(activeSessionId!==idAtEntry)return'), '慢响应晚到必须作废（不得把旧会话清单写进新会话视图）')
  assert.ok(refresh.includes("if(activeSessionId===idAtEntry)ctxEdits=[]"), 'catch 失败静默清空必须在会话守卫下执行')
  const derive = functionBodyOf(appSourceRaw(), 'editedEntryIds')
  assert.ok(derive.includes('newSet(ctxEdits.map((item)=>item.targetId))'), 'editedEntryIds 必须派生自 ctxEdits 的 targetId')
})

test('selectSession：切换会话时重置编辑清单并按新会话拉取（防串会话显示）', () => {
  const body = functionBodyOf(appSourceRaw(), 'selectSession')
  assert.ok(body.includes('ctxEdits=[]'), 'selectSession 必须清空 ctxEdits（防上一会话的编辑清单串显）')
  assert.ok(body.includes('ctxPanelOpen=false'), 'selectSession 必须折叠编辑面板')
  assert.ok(body.includes('voidrefreshCtxEdits(session.id)'), 'selectSession 必须按新会话 id 拉取编辑清单')
  // 重置必须前置到 open_session 的作废守卫之前：epoch 作废/失败提前 return 时旧清单不得残留。
  // （子会话分流的 return 不在此列 —— 那条路径不切会话，viewingSub 只读，重置本就不该执行。）
  const resetAt = body.indexOf('ctxEdits=[]')
  const staleGuardAt = body.indexOf('||activeSessionId!==session.id)return')
  const firstAwait = body.indexOf('await')
  assert.ok(resetAt >= 0 && staleGuardAt >= 0 && resetAt < staleGuardAt, 'ctxEdits 重置必须先于 open_session 作废守卫的提前 return（残留修补）')
  assert.ok(firstAwait < 0 || resetAt < firstAwait, 'ctxEdits 重置必须先于首个 await（在途窗口内视图也不得残留旧清单）')
  // 但 refreshCtxEdits 的守卫快照依赖 activeSessionId 已指向新会话，拉取必须在其后。
  assert.ok(body.indexOf('activeSessionId=session.id') < body.indexOf('voidrefreshCtxEdits'), 'refreshCtxEdits 必须在 activeSessionId 赋值之后调用')
})

test('剔除按钮双位置接线：用户卡与助手卡都有入口，busy/running 统一禁用', () => {
  // 用户消息卡 + 助手回复卡两处入口
  assert.ok(countCodeHits(appSourceRaw(), 'voidremoveContextEntry(message.entryId!)') >= 2, '剔除按钮必须在用户卡与助手卡两处接线')
  // 禁用绑定：busy 或运行中
  assert.ok(countCodeHits(appSourceRaw(), 'disabled={!!ctxEditBusyId||slotFor(activeSessionId).running}') >= 2, '剔除按钮必须绑定 busy/running 禁用')
  // 三态文案：正常/已剔除/处理中
  assert.ok(appA.includes("'剔除上下文'"), '剔除按钮文案缺失')
  assert.ok(appA.includes("'已剔除'"), '已剔除态文案缺失')
  // 已编辑态判定走 editedEntryIds（单一事实来源）
  assert.ok(countCodeHits(appSourceRaw(), 'editedEntryIds().has(message.entryId)') >= 4, '已编辑态判定必须走 editedEntryIds')
})

test('编辑清单面板：折叠开关 + keyed each 稳定键 + 剔除/替换双形态展示', () => {
  assert.ok(appA.includes('ctxPanelOpen=!ctxPanelOpen'), '面板折叠开关缺失')
  assert.ok(appA.includes('上下文编辑'), '面板标题缺失')
  assert.ok(appA.includes('${edit.timestamp}:${edit.entryId}'), '面板 keyed each 必须用 timestamp+entryId 复合键')
  assert.ok(appA.includes("edit.removed?'剔除':'替换'"), '面板必须区分剔除/替换')
})

// ---------- run-slot：entryId 透传（SDK 条目 id 直达 UI） ----------

const slotA = viewA('src/run-slot.ts')

test('TimelineMessage.entryId 字段存在，historyToTimeline 优先 SDK 条目 id', () => {
  assert.ok(slotA.includes('entryId?:string'), 'TimelineMessage 缺少 entryId 字段')
  assert.ok(slotA.includes('entryId:item.entryId||item.id'), 'historyToTimeline 必须把 entryId 透传进时间线消息')
})

// ---------- 字面量诱饵防线自检 ----------

test('防诱饵自检：字面量里的 list_context 不计入代码命中', () => {
  const { shape, literal } = shapeWithLiteralMask(stripComments("const x = \"type==='list_context'\""))
  assert.equal(indexOfCode(shape, literal, "type==='list_context'"), -1)
})
