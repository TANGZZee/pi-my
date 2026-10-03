// 批次②承重断言：sidecar 桥接层（bindUiContext / ext_error / status/title / reload / 历史）
//
// 为什么必须有它（承接批次②对抗审查的教训：修补可以被无红还原）：
//   sidecar-integration.test.mjs 只覆盖模式切换类行为；本文件锁定 1-5 批次②的
//   sidecar 侧接线形状 —— 每条断言对应一个"删掉/改写它会让某承诺悄悄失效"的变异点：
//     M1 删某站点 bindUiContext 调用 → 该路径的扩展拿到 null uiContext（静默失效）
//     M2 bindUiContext 内再调 bindUiContext / 4 站点外多出第 5 处 → session_start 二次发射
//     M3 死选项 uiContext: uiContext(...) 回潮 → 绑定被 SDK 静默忽略（0.85.x 实测）
//     M4 删 onError → ext_error 推送消失，扩展崩了用户无感（既有缺陷回归）
//     M5 删 convertToLlm 过滤 → 插件消息以 user 身份进 LLM（上下文污染回归）
//     M6 reload 后补绑 bindUiContext → session_start 重复发射（SDK 行为已验证）
//     M7 sessionHistory 丢 custom_message 分支 → 历史重放插件卡片消失（批次②缺陷回归）
//   视图约定（与 source-assert 的语义一致）：
//     视图 A = stripComments（剥 JS 注释、保留字符串）→ 含字面量的 needle；
//     视图 B = 再 maskStrings（字符串屏蔽）→ 纯代码 needle，字符串诱饵不算数。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { maskStrings, shapeWithLiteralMask, squash, stripComments } from './helpers/source-assert.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const sidecarRaw = readFileSync(path.join(root, 'sidecar', 'index.mjs'), 'utf8')
const appRaw = readFileSync(path.join(root, 'src', 'App.svelte'), 'utf8')
const protocolRaw = readFileSync(path.join(root, 'src', 'protocol.ts'), 'utf8')

const viewA = squash(stripComments(sidecarRaw))
const viewB = squash(maskStrings(stripComments(sidecarRaw)))
const countA = (re) => (viewA.match(re) ?? []).length
const countB = (re) => (viewB.match(re) ?? []).length

// 在 App.svelte 真实代码区（非字符串字面量）定位 needle
const { shape: appShape, literal: appLiteral } = shapeWithLiteralMask(appRaw)
const appCodeAt = (needle) => {
  let cursor = 0
  for (;;) {
    const at = appShape.indexOf(needle, cursor)
    if (at < 0) return -1
    if (!appLiteral[at]) return at
    cursor = at + 1
  }
}

// ── M1/M2：绑定次数契约 ──────────────────────────────────────────────────

test('承重②S：bindUiContext 定义一处、调用恰 4 处（每会话创建路径一次）', () => {
  assert.equal(countB(/functionbindUiContext\(/g), 1, 'bindUiContext 定义必须恰好一处')
  assert.equal(countB(/awaitbindUiContext\(/g), 4, 'bindUiContext 调用必须恰好 4 处：createSession/openSession/forkSession/worktree fork —— 少一处则该路径扩展静默无 UI，多一处则 session_start 重复发射')
})

test('承重②S：bindExtensions 只出现在 bindUiContext 内（不许站点自绑）', () => {
  assert.equal(countB(/\.bindExtensions\(\{/g), 1, 'bindExtensions 必须只在 bindUiContext 里调用 —— 任何站点直接自绑都会绕开次数契约')
  // createAgentSession 与 bindUiContext 一一对应：4 个会话创建点都已接绑定
  assert.equal(countB(/createAgentSession\(/g), 4)
})

// ── M3：死选项不得回潮 ───────────────────────────────────────────────────

test('承重②S：createAgentSession 不得再传死选项 uiContext（SDK 静默忽略）', () => {
  // bindUiContext 形参内的 uiContext: uiContext(sessionId) 是合法传递；死选项只可能
  // 出现在 createAgentSession({...}) 调用里，因此用视图 B（字面量屏蔽）全局查 ——
  // 视图 B 里 :447 的 `uiContext: uiContext(sessionId)` 也会命中，基线 = 1。
  assert.equal(countB(/uiContext:uiContext\(/g), 1, 'uiContext: uiContext( 只允许出现在 bindUiContext 内部 —— createAgentSession 的死选项回潮意味着绑定再次被静默忽略')
})

// ── M4/M5：onError 与 convertToLlm 过滤 ─────────────────────────────────

test('承重②S：bindUiContext 必须含 onError→ext_error 与 convertToLlm ui. 过滤', () => {
  assert.equal(countA(/type:'ext_error'/g), 1, 'onError → ext_error 推送缺失：扩展崩溃对用户不可见（既有缺陷回归）')
  assert.equal(countB(/\.convertToLlm=/g), 1, 'convertToLlm 重写缺失：插件消息将以 user 身份进入 LLM 上下文（污染回归）')
  assert.equal(countA(/customType\.startsWith\('ui\.'\)/g), 1, 'ui. 前缀过滤条件缺失')
  assert.equal(countA(/mode:'print'/g), 1, 'bindExtensions 的 mode 必须是 print（与官方 rpc-mode 模板一致）')
})

// ── M6：reload 后不得补绑 ────────────────────────────────────────────────

test('承重②S：reload_extensions 恰好调用一次 reload() 且其后无 bindUiContext', () => {
  assert.equal(countB(/awaitentry\.session\.reload\(\)/g), 1, 'reload_extensions 分支缺失或被改写')
  // 承重形态：分支内先查 entry（缺会话要报错），成功路径回 reloaded:true
  assert.ok(viewA.includes("if(!entry?.session)"), 'reload 分支必须先校验会话存在')
  assert.ok(viewA.includes('reloaded:true'), 'reload 成功必须回 reloaded:true')
  // bindUiContext 全部 4 处调用都在 create/open/fork/worktree 路径；
  // 若有人在 reload 分支后补绑，调用数会变成 5（M6 变异）→ 由上面的 ===4 拦截。
})

// ── M7：历史重放 custom_message 分支 ────────────────────────────────────

test('承重②S：sessionHistory 必须透传 custom_message 为 role:plugin 历史条目', () => {
  assert.equal(countA(/entry\.type==='custom_message'/g), 1, 'sessionHistory 的 custom_message 分支缺失：重开 session 后插件卡片全部消失（批次②历史重放缺陷回归）')
  // T2⑦ 的 list_context RPC 也会合法发出 role:'plugin' 列表项（item.type 前缀，不碰撞
  // 上面的 entry.type 计数），因此 role:'plugin' 不再做全局唯一计数 —— 收窄为分支局部
  // 窗口锚定：custom_message 分支头之后 300 字符内必须出现 role:'plugin' 条目体。
  // 删掉/改写该分支（变异 M7）仍会变红；远处新增合法 role:'plugin' 不再误伤。
  let anchored = 0
  for (const m of viewA.matchAll(/entry\.type==='custom_message'/g)) {
    if (viewA.slice(m.index, m.index + 300).includes("role:'plugin'")) anchored++
  }
  assert.ok(anchored >= 1, "sessionHistory 的 custom_message 分支内必须发出 role:'plugin' 历史条目（分支局部锚定缺失 = 历史重放缺陷回归）")
})

// ── 三方一致性：sidecar 发送 ↔ protocol 信封 ↔ App 处理 ─────────────────

test('承重②S：plugin_status/plugin_title/ext_error 三方注册一致（sidecar↔protocol↔App）', () => {
  for (const type of ['plugin_status', 'plugin_title', 'ext_error']) {
    assert.equal(countA(new RegExp(`type:'${type}'`, 'g')), 1, `sidecar 必须恰好发送一次 ${type}`)
    // protocol.ts：信封接口 + AgentEnvelope 联合成员（type: 'X' 字面量）
    assert.ok(
      squash(stripComments(protocolRaw)).includes(`type:'${type}'`),
      `protocol.ts 缺少 ${type} 信封的 type 字面量`,
    )
    // App.svelte：真实代码区必须有处理分支（字符串诱饵不算）
    assert.ok(appCodeAt(squash(`payload.type === '${type}'`)) >= 0, `App.svelte 缺少 ${type} 的处理分支（或只出现在字符串里）`)
  }
})

// ── App 侧的桥接语义锁定（key 覆盖 / 空清除 / entryId 稳定） ────────────

test('承重②S：plugin_status 的 key 覆盖与空清除语义不得退化', () => {
  // 同 key 覆盖：先 filter 掉同 title 的旧条目（m.title === statusKey）
  assert.ok(appCodeAt('m.slot===\'status\'&&m.title===statusKey') >= 0, 'plugin_status 必须先按 statusKey 过滤旧条目（同 key 覆盖语义）')
  // 空 text = 清除：else 分支只 patch kept
  assert.ok(appCodeAt('patchSlot(sessionId,{pluginMessages:kept})') >= 0, 'plugin_status 空 text 必须走清除分支（只保留 kept）')
  // entryId 稳定：status-${sessionId}-${statusKey}，重放/覆盖时 Svelte key 不漂移
  assert.ok(appCodeAt('normalized.entryId=`status-${sessionId}-${statusKey}`') >= 0, 'status 消息必须带稳定 entryId（PluginHost 的 key 与展开态都依赖它）')
})

test('承重②S：plugin_title 必须落到标题栏（写而无读 = 死代码）', () => {
  // 批次②复审发现 :1770 只写 pluginTitle 无人消费 → 已接到 chat-title 的 h1
  assert.ok(appCodeAt('runState[activeSessionId]?.pluginTitle||activeSession') >= 0, 'pluginTitle 必须被标题栏消费（h1 回退 activeSession）—— 只写不读等于 setTitle 白做')
})

// ── 批次②对抗审查存活变异的补锁（缺口 #1/#2/#4/#6/#8） ───────────────────
// 审查实测：以下变异在纯形状断言下存活。分流/display 的行为防线在
// tests/run-slot.test.mjs（splitPluginHistory/pluginReplayPayload 行为测试）；
// 这里补 App/sidecar 侧的接线形状，与行为测试互为冗余。

test('承重②S：applySessionHistory 必须走 splitPluginHistory 纯函数（缺口 #8 接线锁定）', () => {
  // App.svelte 必须真实调用 splitPluginHistory（代码区，非字面量诱饵）——
  // 若有人把分流改回内联 filter，谓词方向将失去行为测试保护。
  assert.ok(appCodeAt('splitPluginHistory(history)') >= 0, 'applySessionHistory 必须经 splitPluginHistory 分流（内联 filter 的谓词方向曾被反转变异击穿而测试全绿）')
  assert.ok(appCodeAt('pluginReplayPayload(') >= 0, '插件重放必须经 pluginReplayPayload 透传 display（缺口 #1：display:{} 曾致重放卡片静默退化）')
  // run-slot.ts 必须真实导出这两个纯函数（防止 App 引用被改成同名空壳）
  const runSlotRaw = readFileSync(path.join(root, 'src', 'run-slot.ts'), 'utf8')
  assert.ok(squash(runSlotRaw).includes('exportfunctionsplitPluginHistory('), 'splitPluginHistory 必须从 run-slot.ts 导出')
  assert.ok(squash(runSlotRaw).includes('exportfunctionpluginReplayPayload('), 'pluginReplayPayload 必须从 run-slot.ts 导出')
})

test('承重②S：plugin_status/plugin_title 的会话归属与钳制（缺口 #2/#7）', () => {
  // 会话归属：payload.sessionId ?? activeSessionId —— 恒 activeSessionId 的变异
  // 曾存活（后台会话的状态串台到当前活跃会话）。
  assert.ok(appCodeAt('String(payload.sessionId??activeSessionId)') >= 0, 'plugin_status 必须优先归因 payload.sessionId（恒 activeSessionId 会让后台会话状态串台）')
  // title 钳制 200（缺口 #7：删 slice 曾存活）
  assert.ok(appCodeAt('String(payload.title??\'\').slice(0,200)') >= 0, 'plugin_title 必须 slice(0,200) 钳制（超长标题撑爆标题栏）')
})

test('承重②S：onError 的 err 字段读取必须逐字段透传（缺口 #6）', () => {
  // 恒空串变异曾存活：ext_error 永远显示「未知扩展：未知错误」，错误通道静默失聪。
  // 注意：视图 B（字符串屏蔽）里 err?.extensionPath 的字符串值也变占位符，
  // 但守卫表达式 `typeof err?.X === 'string' ? err.X :` 仍在代码区 → 匹配守卫头。
  for (const field of ['extensionPath', 'event', 'error']) {
    assert.ok(
      new RegExp(`typeoferr\\?\\.${field}===`).test(viewB),
      `onError 必须透传 err.${field}（恒空串曾让 ext_error 失聪）`,
    )
  }
  // 三字段都有非空分支（三目真支读取原值而非空串）：锚 `?err.X:` 传递形状
  for (const field of ['extensionPath', 'event', 'error']) {
    assert.ok(
      new RegExp(`\\?err\\.${field}:`).test(viewB),
      `err.${field} 命中时必须取原值（不能恒回空串）`,
    )
  }
})

test('承重②S：reload_extensions 会话守卫必须以真实代码存在（缺口 #4）', () => {
  // 审查发现 viewA（保留字符串）断言可被字面量诱饵满足；改用视图 B（字符串屏蔽）
  // 锚定带花括号的真实守卫语句。
  assert.ok(viewB.includes('if(!entry?.session){'), 'reload 分支必须以真实代码持有会话存在守卫（entry 未定义时 entry.session.reload 会抛裸 TypeError，协议错误消息丢失）')
})
