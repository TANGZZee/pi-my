// 会话功能缺陷 B/C/D/F/G/H 修复的**接线保护**测试（针对 App.svelte / sidecar 源码）
//
// 为什么必须有它：m04746 审计发现的这些缺陷都在组件的事件/异步续体里，纯函数单测
// （session-run.test.mjs / session-confirms.test.mjs）只能证明**算法**对，证明不了
// 组件**真的调用了**它。provider-error 的两轮审查已用 M8/M9/M11 变异证明：
// 源码子串匹配是假防线 —— 把真实调用注释掉、退化成旧行为，测试照样全绿。
//
// 因此本文件：
//   ① 复用 tests/helpers/source-assert.mjs 的评论区剥离断言（不用裸子串匹配）；
//   ② 对每个缺陷断言"修复后的标记序列存在"，并且对关键处断言"**旧写法不得回来**"
//      （只断言新写法存在，保留旧写法也能通过 —— 那正是缺陷本身）。
//
// 局限（诚实声明）：仍是源码结构断言，只证明可执行代码里存在该标记序列，不证明运行时
// 行为。行为守卫在对应的纯函数单测里；本文件是防"接线被删/被改写回旧实现"的护栏。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  codeShapeOf,
  eventConditionTypesOf,
  functionBodyCodeOf,
  functionBodyOf,
  indexOfCode,
  maskStrings,
  shapeWithLiteralMask,
  squash,
  stripComments,
} from './helpers/source-assert.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

const rawSource = readFileSync(path.join(root, 'src', 'App.svelte'), 'utf8')
const appSource = stripComments(rawSource)
const flat = squash(appSource)
// 逐字符记录 flat 里每个字符是否来自字符串/模板字面量。flat 与 appShape 逐字符一致，
// 所以这里记录的字面量标签可以直接和 flat 的偏移对齐。
//   f15bc3a3 对抗性审查的 M1/M3/M5 实测：stripComments **不剥字符串内容**，把真实修复
//   整块删掉、换成一个字符串 `const __shapeNote = "…真实形状…"` 就能让所有
//   "存在该子串"的断言继续命中（110/0 全绿）。存在性断言因此必须走 codeAt()，
//   它要求命中起点来自真实代码。
const { shape: appShape, literal: appLiteral } = shapeWithLiteralMask(rawSource)
// 在 appShape 里定位 needle，但**命中起点必须来自真实代码**（不在字面量内）。
// `from` 用于把搜索限制在某个窗口内，避免命中文件别处的同名标识符。
const codeAtFrom = (needle, from = 0) => {
  let cursor = from
  for (;;) {
    const at = appShape.indexOf(needle, cursor)
    if (at < 0) return -1
    if (!appLiteral[at]) return at
    cursor = at + 1
  }
}
const codeAt = (needle) => codeAtFrom(needle, 0)
const codeHas = (needle) => codeAt(needle) >= 0
// 代码形状视图（屏蔽字符串字面量内容）。**计数类断言必须用它**：第二轮外部审计 V2 实测，
// squash 只去空白、不去字面量内容，一行 `const __note = 'if(!stillMine())return ×5'`
// 就能在 5 道守卫全被注释掉的情况下让"计数 ≥ 5"通过（125/125 全绿）。
const codeFlat = squash(maskStrings(appSource))
const functionBody = (name) => functionBodyOf(appSource, name)
const functionBodyCode = (name) => functionBodyCodeOf(appSource, name)

const sidecarSource = readFileSync(path.join(root, 'sidecar', 'index.mjs'), 'utf8')
const sidecarFlat = squash(stripComments(sidecarSource))
// sidecar 的字面量来源视图（同 appShape 的用途）：钉 turnId 回显形状时，
// 命中起点必须来自真实代码 —— 否则把整条 `.catch(...)` 塞进一个字符串就能骗过存在性断言。
const { shape: sideShape, literal: sideLiteral } = shapeWithLiteralMask(sidecarSource)

// ── G：turn id 必须来自单调工厂 ──────────────────────────────────────────

test('接线 G：dispatchTurn 必须用 nextTurnId()，不得回退到 `turn-${Date.now()}`', () => {
  const body = functionBody('dispatchTurn')
  assert.match(body, /constactiveTurnId=nextTurnId\(\)/, 'dispatchTurn 不再使用单调工厂：同毫秒派发会撞 id，timeline 的 Svelte key 重复')
  assert.doesNotMatch(body, /activeTurnId=`turn-\$\{timestamp\}`/, '旧的非单调写法又回来了')
})

test('接线 G：nextTurnId 必须是 session-run 工厂的产物，而非组件内自建', () => {
  assert.match(
    flat,
    /constnextTurnId=createTurnIdFactory\(/,
    'nextTurnId 不再是 createTurnIdFactory() 的实例：唯一性语义重新变成零覆盖',
  )
})

// ── C：队列出队必须走 CAS 计划函数 ────────────────────────────────────────

test('接线 C：drainQueue 必须走 planDrain 的显式 CAS 三元组（不得回退到纯读→写）', () => {
  const body = functionBody('drainQueue')
  // 缺陷 8（外部审计 P2）：current 与 expected 传同一个值会让"陈旧即拒绝"分支永不可达。
  // 现在必须把读到的 revision 显式落到 expected 变量上再传入 —— 这样断言能区分
  // "真的做了 CAS（即使当前无 await 间隙）"与"只写了注释宣称做了 CAS"。
  assert.match(
    body,
    /constexpected=slot\.queueRevision/,
    'drainQueue 不再显式钉住 expected：CAS 的语义又被折叠成"current 与 expected 同一个值"（缺陷 8 回归）',
  )
  assert.match(
    body,
    /planDrain\(slot\.queue,slot\.queueRevision,expected\)/,
    'drainQueue 不再使用三参 planDrain：与 removeQueue/moveQueue 交错会复活已删项或重复派发',
  )
  assert.match(body, /if\(!plan\)return/, 'planDrain 返回 null（stale）时必须放弃，否则会重复派发')
  assert.match(body, /queueRevision:plan\.revision/, '必须写回 CAS 递增后的 revision')
  assert.doesNotMatch(
    body,
    /const\[,\.\.\.rest\]=slot\.queue/,
    '旧的"读旧数组再 +1 revision"写法又回来了：它不带任何并发校验',
  )
})

test('接线 C：moveQueue / removeQueue 同样必须显式钉住 expected（缺陷 8 的第二、三处）', () => {
  for (const [name, call] of [
    ['moveQueue', /casReorder\(slot\.queue,slot\.queueRevision,expected,/],
    ['removeQueue', /casRemove\(slot\.queue,slot\.queueRevision,expected,/],
  ]) {
    const body = functionBody(name)
    assert.match(body, /constexpected=slot\.queueRevision/, `${name} 不再显式钉住 expected（缺陷 8 回归）`)
    assert.match(body, call, `${name} 的 CAS 调用不再是 (current, revision, expected) 三元组形状`)
    assert.doesNotMatch(
      body,
      /cas(Reorder|Remove)\(slot\.queue,slot\.queueRevision,slot\.queueRevision,/,
      `${name} 把 current 与 expected 传成同一个值：陈旧拒绝分支永不可达（缺陷 8 原样回归）`,
    )
  }
})

// ── H：子会话回填必须走纯函数收集 ────────────────────────────────────────

test('接线 H：finishSubRun 必须走 collectSubRunUpdates（不得回退到遍历旧快照）', () => {
  const body = functionBody('finishSubRun')
  assert.match(
    body,
    /for\(constupdateofcollectSubRunUpdates\(runState,id,status,reply\)\)/,
    'finishSubRun 不再使用两段式收集：用遍历时的旧 slot.subRuns 做 map 会丢更新',
  )
  assert.doesNotMatch(
    body,
    /for\(const\[parentId,slot\]ofObject\.entries\(runState\)\)/,
    '旧的"边遍历边用旧 slot 覆盖"写法又回来了',
  )
})

// ── F：sidecar 未就绪分支必须收掉看门狗并校验回代 ────────────────────────

test('接线 F：dispatchTurn 的 sidecar-未就绪分支必须立刻 clearRunWatchdog', () => {
  const body = functionBody('dispatchTurn')
  // 未就绪分支是函数尾部那个 else；取 `} else {` 到函数结尾
  const elseAt = body.lastIndexOf('}else{')
  assert.ok(elseAt > 0, 'dispatchTurn 里找不到 sidecar-未就绪的 else 分支')
  const branch = body.slice(elseAt)
  assert.match(
    branch,
    /clearRunWatchdog\(id\)/,
    '未就绪分支没有清看门狗：180 秒后会把"模型超过 3 分钟没有返回任何结果"盖到界面上',
  )
  // 必须出现两次：进入时立刻清一次，延时回调里再清一次（防回调自身留下的定时器）
  const clears = branch.match(/clearRunWatchdog\(id\)/g) ?? []
  assert.ok(clears.length >= 2, `未就绪分支只清了 ${clears.length} 次看门狗`)
})

test('接线 F：未就绪分支的延时回调必须校验 activeTurnId（防抹掉新回合）', () => {
  const body = functionBody('dispatchTurn')
  const branch = body.slice(body.lastIndexOf('}else{'))
  assert.match(
    branch,
    /if\(slotFor\(id\)\.activeTurnId!==activeTurnId\)return/,
    '延时收起运行态时未校验回合归属性：期间用户又发一条会被无条件置 idle 抹掉运行态',
  )
})

test('接线 F：看门狗必须跳过 auto_retry_* 心跳', () => {
  // D3/D4（外部对抗性审查确证）：这里原先是
  //   const at = appSource.indexOf('const id = payload.sessionId || activeSessionId')
  //   assert.match(squash(appSource.slice(at, at + 900)), /…/)
  // 两个毛病：
  //  1) 固定 900 字符窗口的余量只剩 15 个原始字符（`stripComments` 只删注释文本，
  //     保留注释行的缩进与换行，这些空白仍占窗口预算却被 squash 抹掉）⇒ 在入口附近
  //     插 ≥14 个空白、或插**任何一行真实语句**都会假失败（误伤）；
  //  2) `stripComments` 不剥字符串字面量，而断言用的是 `assert.match` ⇒ 把真实条件
  //     掏空、再在窗口内随便放一个内容相同的字符串常量，就能整体绕过（假通过）。
  // 改为「字面量来源闸门 + 连续形状」：命中起点必须来自真实代码，且必须是完整一条语句。
  const at = appShape.indexOf('constid=payload.sessionId||activeSessionId')
  assert.ok(at > 0, '找不到事件归约入口')
  const watchdogShape = "if(event.type!=='auto_retry_start'&&event.type!=='auto_retry_end')touchRunWatchdog(id)"
  assert.notEqual(
    codeAtFrom(watchdogShape, at),
    -1,
    '看门狗又对 auto_retry_* 无条件续期（或缺了 touchRunWatchdog 本身）：反复失败的模型可让界面永远停在 Thinking',
  )
})

// ── B：会话切换代数守卫 ──────────────────────────────────────────────────

test('接线 B：sessionEpoch 必须是 createEpochGuard() 的实例', () => {
  assert.match(
    flat,
    /constsessionEpoch=createEpochGuard\(\)/,
    'sessionEpoch 不再是代数守卫实例：latest-request-wins 语义重新变成零覆盖（纯数字无法单测）',
  )
})

test('接线 B：selectSession 必须推进代数，并在 await 之后复检', () => {
  const body = functionBody('selectSession')
  assert.match(body, /constepoch=sessionEpoch\.bump\(\)/, 'selectSession 未推进代数')
  const awaitAt = body.indexOf("awaitrequestRaw('open_session'")
  assert.ok(awaitAt > 0, 'selectSession 找不到 open_session 调用点')
  const after = body.slice(awaitAt)
  assert.match(
    after,
    /if\(!sessionEpoch\.check\(epoch\)\|\|activeSessionId!==session\.id\)return/,
    'await 之后没有复检代数：切走时的晚到历史/错误会盖到新状态上',
  )
})

test('接线 B：closeTab 只在关闭当前会话时作废在飞响应（不能无条件 bump）', () => {
  const body = functionBody('closeTab')
  assert.match(
    body,
    /constclosingActive=activeSessionId===session\.id/,
    'closeTab 未判断是否为当前会话',
  )
  assert.match(
    body,
    /if\(closingActive\)sessionEpoch\.bump\(\)/,
    'closeTab 的 bump 必须受 closingActive 约束：无条件 bump 会让「关闭一个后台标签」连带作废当前会话正在加载的历史',
  )
  // bump 只能出现一次：若有人既保留这个条件调用、又补回一次无条件 bump，
  // 上一条断言仍会通过，所以按次数锁死。
  const bumps = body.match(/sessionEpoch\.bump\(\)/g) ?? []
  assert.equal(
    bumps.length,
    1,
    `closeTab 里 sessionEpoch.bump() 应恰好出现 1 次，实际 ${bumps.length} 次（多出的无条件 bump 会作废其他会话在飞的历史加载）`,
  )
})

test('接线 B：rebindSessionsAfterRestart 必须继续绑定所有会话，不得因切换而整体中断', () => {
  const body = functionBody('rebindSessionsAfterRestart')
  // 重连的职责是把**所有**会话重新绑回 sidecar。用户在逐条重开期间切标签同样会推进
  // 代数，若据此 break，剩下那些会话的 file 就与 sidecar 内存态脱钩 → 下次发送静默
  // 新建文件、丢掉历史（这正是本函数存在要防的事）。
  assert.doesNotMatch(body, /aborted=true;break/, 'rebind 又变回"切换即整体中断"，会让未重绑的会话静默丢历史')
  assert.doesNotMatch(body, /constepoch=sessionEpoch\.current\(\)/, 'rebind 不应再快照代数')
  // 单个会话已被关闭/删除时，只能跳过它自己
  assert.match(
    body,
    /if\(!sessions\.some\(\(item\)=>item\.id===session\.id\)\)continue/,
    'rebind 缺少"该会话已被关闭"的单条跳过守卫（会凭空造出无人持有的 runState 槽）',
  )
  const awaitAt = body.indexOf("awaitrequestRaw('open_session'")
  assert.ok(awaitAt > 0, 'rebindSessionsAfterRestart 找不到 open_session 调用点')
  assert.match(
    body.slice(awaitAt, awaitAt + 600),
    /if\(!sessions\.some\(/,
    'await 之后必须立刻复检该会话是否仍然存在',
  )
})

// ── D：sidecar 关闭会话必须放行待决权限确认 ──────────────────────────────

test('接线 D：sidecar 必须使用纯函数放行待决确认', () => {
  // import 名字顺序不做假设（写成顺序敏感会让改名/重排变成假失败）
  assert.match(
    sidecarFlat,
    /import\{[^}]*releaseSessionConfirm[^}]*\}from'\.\/session-confirms\.mjs'/,
    'sidecar 未从 session-confirms.mjs 导入 releaseSessionConfirm：待决确认的清理语义重新变成不可测',
  )
  assert.match(
    sidecarFlat,
    /import\{[^}]*releaseAllConfirms[^}]*\}from'\.\/session-confirms\.mjs'/,
    'sidecar 未从 session-confirms.mjs 导入 releaseAllConfirms',
  )
})

test('接线 D：会话销毁路径必须全部走 ./session-teardown.mjs（文本正则测不出顺序）', () => {
  // D1 的根因就是"顺序"：放行若写在 abort() 之后，abort() 会永远等不到 waitForIdle。
  // 顺序无法靠源码子串匹配验证（审查 T1），因此正确做法是：**所有**销毁路径都必须
  // 委托给纯逻辑模块（它由 tests/session-teardown.test.mjs 行为化把关），组件里
  // 不得再手写顺序。这里就断言"没有任何一处自己拼顺序"。
  assert.match(
    sidecarFlat,
    /import\{[^}]*teardownSession[^}]*cancelSessionInteractions[^}]*\}from'\.\/session-teardown\.mjs'/,
    'sidecar 未从 session-teardown.mjs 导入顺序承重函数：D1 的顺序语义重新变成不可测的裸代码',
  )
  const teardowns = sidecarFlat.match(/teardownSession\(\{/g) ?? []
  assert.equal(
    teardowns.length,
    3,
    `teardownSession 应恰好被 3 处销毁路径调用（openSession 重建分支 / closeSession / deleteSession），实际 ${teardowns.length}`,
  )
  const cancels = sidecarFlat.match(/cancelSessionInteractions\(\{/g) ?? []
  assert.equal(
    cancels.length,
    2,
    `cancelSessionInteractions 应恰好被 2 处中止路径调用（handle 的 abort / 局域网 stop），实际 ${cancels.length}`,
  )
  const wired = sidecarFlat.match(/releaseConfirms:releaseSessionConfirms/g) ?? []
  assert.equal(
    wired.length,
    5,
    `5 处销毁/中止路径都必须传入 releaseConfirms: releaseSessionConfirms，实际 ${wired.length} 处 —— ` +
      '漏传的那条路径会让扩展的工具调用永久悬挂在永不被 resolve 的 Promise 上',
  )
})

test('接线 D：closeSession / deleteSession / openSession 重建分支的放行必须排在 abort 之前', () => {
  const sidecarClean = stripComments(sidecarSource)
  const sidecarBody = (name) => functionBodyOf(sidecarClean, name)
  for (const name of ['closeSession', 'deleteSession', 'openSession']) {
    const body = sidecarBody(name)
    const releaseAt = body.indexOf('releaseConfirms:releaseSessionConfirms')
    assert.notEqual(releaseAt, -1, `${name} 未传入 releaseConfirms`)
    const abortAt = body.search(/abort:\(\)=>(?:entry|existing)\.session\?\.abort\(\)/)
    assert.notEqual(abortAt, -1, `${name} 未把 abort() 作为回调交给 teardownSession（顺序语义不可控）`)
    assert.ok(
      releaseAt < abortAt,
      `${name} 把放行写在 abort() 之后 —— 这正是 D1 死锁：abort() 会永远等不到 waitForIdle（顺序断言仅为护栏，真正的行为守卫在 session-teardown.test.mjs）`,
    )
  }
  assert.match(
    sidecarFlat,
    /functionreleaseSessionConfirms\(sessionId\)\{[\s\S]{0,260}?releaseSessionConfirm\(pendingConfirms,pendingConfirmsBySession,sessionId\)/,
    '包装函数体内必须调用真正的纯函数，而不是自己重写一遍清理逻辑',
  )
})

test('接线 D：abort 必须按会话收窄（不得再全局清零其它会话的待决确认）', () => {
  // 缺陷 5（外部审计 P1）：用户停止会话 A 时，原先的 releaseAllConfirms +
  // 无归属 drainPendingDialogs 会把**会话 B** 正在等待的工具确认一起作废，
  // B 的模型于是拿到一个凭空出现的"拒绝"。
  const at = sidecarFlat.indexOf("if(type==='abort')")
  assert.ok(at > 0, 'sidecar 找不到 abort 处理器')
  const branch = sidecarFlat.slice(at, at + 520)
  assert.match(
    branch,
    /awaitcancelSessionInteractions\(\{/,
    'abort 不再走 cancelSessionInteractions：放行/abort 的顺序又变成手写（D1 可回归）',
  )
  assert.match(branch, /sessionId:payload\.sessionId/, 'cancelSessionInteractions 未收到本会话 id')
  assert.match(branch, /reason:'用户中止'/, 'abort 未标注中止原因（对话框 drain 需要它做日志与归属）')
  assert.match(
    branch,
    /releaseConfirms:releaseSessionConfirms/,
    'abort 未放行本会话的待决确认：扩展工具调用会永久悬挂',
  )
  assert.doesNotMatch(
    branch,
    /releaseAllConfirms/,
    'abort 又变回全局清零：会波及**其它**会话正在等待的确认（缺陷 5）',
  )
  // 局域网中止路径同构
  const lanAt = sidecarFlat.indexOf("stop:async({sessionId})=>{")
  assert.ok(lanAt > 0, 'sidecar 找不到局域网 stop 处理器')
  const lanBranch = sidecarFlat.slice(lanAt, lanAt + 420)
  assert.match(
    lanBranch,
    /awaitcancelSessionInteractions\(\{[\s\S]{0,120}?releaseConfirms:releaseSessionConfirms/,
    '局域网 stop 未走 cancelSessionInteractions 按会话放行（缺陷 5 在遥控路径上回归）',
  )
})

test('接线 D：进程级退出仍然必须全量放行（releaseAllConfirms 只剩这一个调用点）', () => {
  const calls = sidecarFlat.match(/releaseAllConfirms\(pendingConfirms,pendingConfirmsBySession\)/g) ?? []
  assert.equal(
    calls.length,
    1,
    `releaseAllConfirms 应只剩 1 处（stdin 关闭时的进程级 teardown），实际 ${calls.length} —— ` +
      '多出来的那处几乎一定是"中止一个会话却清掉全部会话"的缺陷 5 又回来了',
  )
  assert.match(
    sidecarFlat,
    /rl\.on\('close',\(\)=>\{[\s\S]{0,500}?releaseAllConfirms\(pendingConfirms,pendingConfirmsBySession\)/,
    '进程退出路径未放行全部待决确认：扩展侧会留下永不 resolve 的 await',
  )
  assert.match(
    sidecarFlat,
    /for\(constsidof\[\.\.\.sessions\.keys\(\)\]\)releaseSessionConfirms\(sid\)/,
    '进程退出路径未逐会话放行（按会话的索引也要一起清，否则局域网页残留陈旧待确认项）',
  )
})

test('接线 D：confirm_response 必须免于串行链（否则 D1 会以另一种形式死锁）', () => {
  // 权限确认的 await 卡在 handle() 里时，用户的"允许/拒绝"应答若排在串行链尾部，
  // 就永远轮不到执行：abort 请求在等 handle 返回，应答在等 abort 返回。
  const at = sidecarFlat.indexOf('constNON_BLOCKING_REQUESTS=')
  assert.ok(at > 0, 'sidecar 找不到 NON_BLOCKING_REQUESTS 定义')
  const decl = sidecarFlat.slice(at, at + 200)
  for (const type of ['oauth_login', 'ui_dialog_response', 'mcp_test', 'confirm_response']) {
    assert.match(
      decl,
      new RegExp(`'${type}'`),
      `${type} 不在 NON_BLOCKING_REQUESTS 里：该请求会排在一个可能永远不返回的 handle 之后（死锁）`,
    )
  }
})

// ── 接线 B 家族（二次复核新增）：慢请求返回后不得劫持导航 / 写错会话 ──────

test('接线 B：compactSession 在 await 之后必须复检 activeSessionId（防劫持导航）', () => {
  const body = functionBody('compactSession')
  const awaitAt = body.indexOf("awaitrequestRaw('compact_session'")
  assert.notEqual(awaitAt, -1, 'compactSession 不再是 await compact_session 的形状，断言失去意义')
  const after = body.slice(awaitAt)
  assert.match(
    after,
    /if\(activeSessionId!==id\)return/,
    '压缩是慢请求：用户期间切走后，返回时会把界面强行拉回旧会话（陈旧响应劫持导航）',
  )
  // 顺序必须正确：复检要在这条请求的返回之后、写回状态之前
  assert.ok(
    after.indexOf('if(activeSessionId!==id)return') < after.indexOf('patchSlot(id,{error:'),
    '复检位置不对：必须在任何 patchSlot 写回之前',
  )
})

test('接线 B：forkAtUserIndex 必须把来源会话钉在 await 之前，catch 不得现读 activeSessionId', () => {
  const body = functionBody('forkAtUserIndex')
  const awaitAt = body.indexOf("awaitrequestRaw('fork_session'")
  assert.notEqual(awaitAt, -1, 'forkAtUserIndex 不再是 await fork_session 的形状，断言失去意义')
  const before = body.slice(0, awaitAt)
  assert.match(
    before,
    /constparentId=activeSessionId/,
    'parentId 必须在 fork 请求之前捕获：否则分叉期间用户切走后，失败提示会落到无关会话上',
  )
  assert.doesNotMatch(
    body,
    /patchSlot\(activeSessionId,\{error:/,
    'catch 里现读 activeSessionId 会把分叉失败糊到用户当前所在的别的会话上',
  )
  assert.match(body, /patchSlot\(parentId,\{error:/, 'catch 必须把错误写回发起分叉的那个会话')
  assert.match(body, /sourceSessionId:parentId/, '请求参数也必须用捕获的来源会话，不得现读 activeSessionId')
  assert.doesNotMatch(body, /sourceSessionId:activeSessionId/, '分叉请求不得现读 activeSessionId')
})

test('接线 B：forkWorktree 同样必须把来源会话钉在 await 之前，catch 不得现读 activeSessionId', () => {
  const body = functionBody('forkWorktree')
  const awaitAt = body.indexOf("awaitrequestRaw('create_worktree_fork'")
  assert.notEqual(awaitAt, -1, 'forkWorktree 不再是 await create_worktree_fork 的形状，断言失去意义')
  const before = body.slice(0, awaitAt)
  assert.match(
    before,
    /constparentId=activeSessionId/,
    'parentId 必须在 worktree 分叉请求之前捕获（同样要落盘 + 重扫目录）',
  )
  assert.doesNotMatch(
    body,
    /patchSlot\(ensureActiveId\(\),\{error:/,
    'catch 里现读当前会话会把分叉失败提示糊到无关会话上',
  )
  assert.match(body, /patchSlot\(parentId,\{error:/, 'catch 必须把错误写回发起分叉的那个会话')
  assert.match(body, /branchParentId:parentId/, '新建会话记录的分支父级也必须是捕获的来源，而非此刻的当前会话')
  assert.match(body, /sourceSessionId:parentId/, 'worktree 分叉请求也必须用捕获的来源会话')
  assert.doesNotMatch(body, /sourceSessionId:activeSessionId/, 'worktree 分叉请求不得现读 activeSessionId')
})

// ── G：所有 timeline key 与会话 id 都必须走单调工厂 ────────────────────────

test('接线 G：插话分支的 timeline key 也必须走 nextTurnId()', () => {
  const body = functionBody('submit')
  assert.match(
    body,
    /id:`user-\$\{nextTurnId\(\)\}`/,
    'submit 的插话分支又用 `user-${Date.now()}` 造 key：同一毫秒连发两条插话会撞出重复 key',
  )
  assert.doesNotMatch(
    body,
    /id:`user-\$\{Date\.now\(\)\}`/,
    '插话分支回退到了非单调的 Date.now() key',
  )
})

test('接线 G：会话 id 必须走 nextSessionId() 工厂，不得用 Date.now()', () => {
  assert.match(
    flat,
    /constnextSessionId=createTurnIdFactory\('session'\)/,
    'nextSessionId 不再是单调工厂的实例：同毫秒新建两个会话会撞同一个 id',
  )
  assert.match(flat, /activeSessionId=nextSessionId\(\)/, 'ensureActiveId 必须用单调工厂生成会话 id')
  assert.match(flat, /constforkId=nextSessionId\(\)/, '分叉会话 id 必须用单调工厂')
  assert.match(flat, /constdraftId=nextSessionId\(\)/, '草稿会话 id 必须用单调工厂')
  assert.match(flat, /constid=nextSessionId\(\)/, 'newSession 的会话 id 必须用单调工厂')
  // 四类旧写法都不得回来。
  assert.doesNotMatch(flat, /activeSessionId=`session-\$\{Date\.now\(\)\}`/, 'ensureActiveId 回退到了 Date.now()')
  assert.doesNotMatch(flat, /constforkId=`session-\$\{Date\.now\(\)\}`/, '分叉 id 回退到了 Date.now()')
  assert.doesNotMatch(flat, /constdraftId=`draft-\$\{Date\.now\(\)\}`/, '草稿 id 回退到了 Date.now()')
})

// ── 缺陷 1：陈旧终态事件不得替当前回合收尾（世代守卫） ────────────────────

test('接线 1：事件入口必须有 runEpoch 世代守卫（agent_start 清标记，其余被取代即丢弃）', () => {
  const at = codeAt("if(payload.type==='event')")
  assert.ok(at > 0, '找不到事件归约入口（字面量来源视图定位失败）')
  // ⚠️ 存在性断言走 codeAtFrom（命中起点必须来自真实代码）：字符串承载变异
  //    （`const __shapeNote = "…正确形状…"`）能骗过 squash 视图的 match/includes。
  // ⚠️ 这里是**带条件的**清除（D-A 残留修复）：被停掉那一轮的 agent_start 不得解标记，
  // 否则旧轮迟到的 agent_end 会把用户随后新发的回合打死。无条件写法曾在此被锁成契约，
  // 已纠正为 `&& !startedButAborted`（详见"接线 D-A"用例里的完整推导）。
  assert.notEqual(
    codeAtFrom("if(event.type==='agent_start'&&!startedButAborted)runEpoch.clearSuperseded(id)", at),
    -1,
    '事件入口缺世代守卫（或退化回无条件清除）：点 Stop 后立刻再发一条，上一个回合迟到的 agent_end/agent_settled 会把**新**回合当已结束收尾（缺陷 1 / D-A 残留）',
  )
  // 顺序必须正确：世代守卫要排在 touchRunWatchdog 之前，否则陈旧事件仍会续命看门狗。
  // 顺序用**位置**比较（不是 indexOf 返回值 >= 0 的两次断言）：位置比较天然要求两边都
  // 真的命中，不需要额外的窗口宽度假设。
  const guardAt = codeAtFrom('runEpoch.isSuperseded(id)', at)
  const watchdogAt = codeAtFrom('touchRunWatchdog(id)', at)
  assert.ok(guardAt >= 0, '事件入口里找不到世代守卫 runEpoch.isSuperseded(id)')
  assert.ok(watchdogAt >= 0, '事件入口里找不到 touchRunWatchdog(id)')
  assert.ok(
    guardAt < watchdogAt,
    '世代守卫位置不对：必须在 touchRunWatchdog / 状态写入之前',
  )
})

test('接线 1：runEpoch 必须是 createRunEpoch() 的实例，且派发时登记新世代', () => {
  assert.match(flat, /construnEpoch=createRunEpoch\(\)/, 'runEpoch 不再是 createRunEpoch() 实例：世代语义重回零覆盖')
  const body = functionBody('dispatchTurn')
  assert.match(body, /runEpoch\.dispatch\(id\)/, 'dispatchTurn 未登记新世代：abort 后的终态事件无法被识别为陈旧')
  // 反向断言：派发时**不得**提前解除取代标记。曾经的写法是 dispatch + clearSuperseded
  // 一起做，导致 event 入口的 isSuperseded 在"abort 之后、新一轮 agent_start 之前"这段
  // 唯一该起作用的窗口里恒为 false —— 缺陷 1 的守卫被自己的解除调用抵消。标记必须由
  // 事件入口在 agent_start 时解除（见上面的"接线 1：事件入口"用例）。
  assert.doesNotMatch(
    body,
    /runEpoch\.clearSuperseded\(id\)/,
    'dispatchTurn 不得提前清取代标记：必须在 agent_start 时由事件入口解除，否则缺陷 1 守卫失效',
  )
})

// ── 缺陷 3：取消/关闭后，迟到事件不得复活僵尸槽 ──────────────────────────

test('接线 3：closedIds 必须拦住"关闭后复活"的三条路径', () => {
  assert.match(flat, /constclosedIds=newSet<string>\(\)/, '缺少 closedIds 集合：缺陷 3 失去防线')
  assert.match(
    functionBody('patchSlot'),
    /if\(closedIds\.has\(id\)\)return/,
    'patchSlot 未拒绝已关闭 id：agent_start 会无条件写 running:true 并重新武装 180s 看门狗，长出无人能停的僵尸槽（缺陷 3）',
  )
  const at = codeAt("if(payload.type==='event')")
  assert.ok(at >= 0, '找不到事件入口（字面量来源视图定位失败）')
  assert.notEqual(
    codeAtFrom('if(closedIds.has(id))return', at),
    -1,
    '事件入口未拦住已关闭 id：事件涟漪里有 touchRunWatchdog/markSession/startToolStep 等不经过 patchSlot 的副作用',
  )
  const closed = functionBody('markSlotClosed')
  assert.match(closed, /closedIds\.add\(id\)/, 'markSlotClosed 未登记关闭：之后的事件仍能复活槽位')
  assert.match(closed, /teardownRun\(id\)/, 'markSlotClosed 未清运行侧状态（看门狗/定时器/暂存/世代）')
  // markSlotOpen 必须是**恰好这一行**（外部审计 D3/C5）：只断言"存在 closedIds.delete(id) 子串"
  // 时，一行 `; for (const k of [...closedIds]) closedIds.delete(k)` 就同时满足子串断言并把
  // 所有会话一次性解禁（等价于 clear()），缺陷 3 的两条闸门同时失效。精确等值比黑名单更强：
  // 任何追加、任何批量循环、任何包装都会破坏等值。
  assert.equal(
    functionBody('markSlotOpen'),
    'functionmarkSlotOpen(id:string){closedIds.delete(id)}',
    'markSlotOpen 的函数体形状变了：解禁必须且只能是"按 id 删一个"（批量解禁 = 缺陷 3 的两条闸门同时失效）',
  )
  // 抗变异（外部审计 C5）：`closedIds.clear()` 会把**所有**会话一次性解禁，两条闸门
  // 同时失效，而所有"存在 if(closedIds.has(id)) return 子串"的断言依然全过。全局清空
  // 在本组件里没有任何合法用途（解禁一律走 markSlotOpen 的按 id delete）。
  // 抗变异（第二轮外部审计 V4）：`closedIds.clear()` 的等价形态是"遍历全部键逐个 delete"，
  // 一行 `; for (const k of Array.from(closedIds)) closedIds.delete(k)` 就绕过上面那条
  // doesNotMatch，同时把所有会话一次性解禁。合法解禁只有 markSlotOpen 里按 id delete 一种。
  // 第三轮把黑名单放宽到 `[...closedIds]` / `Array.from(closedIds)` / `closedIds.forEach`
  // 等全部批量形态，并补一条"不变量"断言：`closedIds` 在全文件只允许出现
  // add/has/delete 三种逐 id 操作（见下面的 closedIdsOps）。
  assert.doesNotMatch(
    codeFlat,
    /for\([^)]*of(Array\.from\()?\s*\??\.{0,3}closedIds/,
    '出现了对 closedIds 的遍历删除：会一次性解除全部会话的封禁（与 clear() 等价），缺陷 3 的两条闸门同时失效',
  )
  assert.doesNotMatch(
    codeFlat,
    /\[\s*\.{0,3}closedIds\s*\]/,
    '出现了 `[...closedIds]` 展开：必然用于批量遍历/解禁，而合法路径只有 markSlotOpen 的按 id delete',
  )
  assert.doesNotMatch(
    codeFlat,
    /closedIds\.(clear|forEach|keys|values|entries)\(/,
    '出现了 closedIds 的批量操作：解禁必须逐 id 进行（markSlotOpen 的 closedIds.delete(id)）',
  )
  assert.doesNotMatch(
    codeFlat,
    /Array\.from\(closedIds\)/,
    '出现了 Array.from(closedIds)：批量遍历 closedIds 在本组件里没有任何合法用途',
  )
  // 不变量（第三轮新增）：`closedIds` 的每一次出现都必须紧接一个**逐 id** 操作
  // （add/has/delete，参数为单个 id），不得出现任何其他用法。
  {
    const ops = codeFlat.match(/closedIds(\.\w+\([^)]*\))?/g) ?? []
    const illegal = ops.filter(
      (op) => !/^closedIds\.(add|has|delete)\((id|session\.id)\)$/.test(op) && op !== 'closedIds',
    )
    assert.deepEqual(
      illegal,
      [],
      `closedIds 出现了逐 id add/has/delete 之外的用法：${illegal.join(' | ')}`,
    )
  }
  assert.match(
    functionBody('markSlotClosed'),
    /deletepruned\[id\]/,
    'markSlotClosed 未清理 pendingHistory：被关掉的会话残留的停泊历史会在 id 被重建后并进新会话（缺陷 13）',
  )
  assert.match(
    functionBody('dispatchTurn'),
    /markSlotOpen\(id\)/,
    'dispatchTurn 未解除关闭封禁：重新派发同一会话 id 时所有事件都会被入口丢弃',
  )
  // 缺口回归：封禁的解除不能只有 dispatchTurn 一条路。用户显式打开会话（selectSession）
  // 与 sidecar 重启后重绑（rebindSessionsAfterRestart）都必须解禁，否则一旦这个 id 被
  // remember() 放回侧栏（关闭期间在飞的 open_session 回读 mode 就会调它），点开后
  // patchSlot 会把历史与错误提示全部静默丢弃，界面永远空白。
  assert.match(
    functionBody('selectSession'),
    /markSlotOpen\(session\.id\)/,
    'selectSession 未解除关闭封禁：关标签后同一 id 重新出现在侧栏时，打开它会一片空白（历史/错误写入被 patchSlot 丢弃）',
  )
  assert.match(
    functionBody('rebindSessionsAfterRestart'),
    /markSlotOpen\(session\.id\)/,
    'rebindSessionsAfterRestart 未解除关闭封禁：重启后重绑已关闭的 id 时，历史写入会被静默丢弃',
  )
})

// ── 缺陷 4：派发异步前奏期间关标签，不得再发 prompt ──────────────────────

test('接线 4：dispatchTurn 的异步前奏必须在每个 await 之后复检存活', () => {
  const body = functionBody('dispatchTurn')
  const codeBody = functionBodyCode('dispatchTurn')
  // 精确等值（外部审计 C1/D2）：这条判据必须**恰好**是这一串。任何尾部追加
  // （`|| true` / `|| Boolean(true)` / `|| []` / `|| (()=>true)()` / `|| parseInt('1')`
  // / `|| __alwaysTrue` / `|| Date.now()` / `|| !(void 0)` / `|| -1 < 0` …）都会破坏等值，
  // 因此"恒真尾巴黑名单"式的正则不再承重 —— 黑名单永远追不上等价写法，等值可以。
  const STILL_MINE_DECL =
    'conststillMine=()=>isTurnAlive(closedIds.has(id),slotFor(id).activeTurnId,activeTurnId)'
  // ⚠️ 这里**不能**用 `body.includes(STILL_MINE_DECL)`：includes 是子串（前缀）测试，
  // 在声明尾部追加 `|| !false` / `|| Date.now()` 之后 includes 仍为 true，而守卫已恒真。
  // 变异重放实测 C1 与 D2 正是这样 SURVIVED 的（黑名单也追不上等价写法）。
  // 改为**取出箭头函数体并要求等值**：声明与紧随其后的 `void (async () => {` 之间
  // 不允许有任何多余字符。
  const declAt = body.indexOf(STILL_MINE_DECL)
  assert.ok(
    declAt >= 0,
    'dispatchTurn 的 stillMine 判据形状不对（应恰好是 isTurnAlive(closedIds.has(id), slotFor(id).activeTurnId, activeTurnId)）：关标签/换回合后仍在飞行中的前奏会发出 prompt，在 sidecar 里造出无人可管的运行（缺陷 4）',
  )
  const stillMineBody = body.slice(declAt + STILL_MINE_DECL.length)
  assert.ok(
    /^void\(async\(\)=>\{/.test(stillMineBody),
    `stillMine 判据尾部被追加了内容（合法形态后必须紧接 void (async () => {）：\n  实际尾部：${stillMineBody.slice(0, 80)}\n  守卫被追加恒真尾巴（如 || true / || Date.now() / || (()=>1)()）后依然"通过"字符串断言但已是死代码 —— 缺陷 4 的第一道防线失效（变异重放 C1/D2）`,
  )
  // 双保险：把箭头体单独截出来做**等值**比较（比"前缀 + 紧邻"更直白地表达意图）。
  const stillMineArrow = body.match(/conststillMine=\(\)=>(.+?)(?=void\(async\(\)=>\{)/)
  assert.equal(
    stillMineArrow?.[1],
    'isTurnAlive(closedIds.has(id),slotFor(id).activeTurnId,activeTurnId)',
    'stillMine 的箭头函数体被改动：它必须**恰好**求值为 isTurnAlive(...)，任何 || 兜底都会让守卫恒真',
  )
  // 判据只允许声明一次：多一份声明就能让"真实的那份"被改成恒真、而断言命中的是诱饵。
  assert.equal(
    (body.match(/conststillMine=/g) ?? []).length,
    1,
    'dispatchTurn 里出现了多份 stillMine 声明：断言无法确定守卫用的是哪一份',
  )
  // 抗变异（外部审计 C4 + 第二轮 V3/V3b + 第三轮 D2）：黑名单只能挡已知写法，
  // 保留一条兜底（挡住 `|| true` 这类最直白的形态）并在上方用精确等值作为主防线。
  assert.doesNotMatch(
    body,
    /\|\|\s*(true|1|'[^']*'|"[^"]*")/,
    'stillMine 被追加了恒真尾巴（如 `|| true`）：守卫会变成死代码而字符串断言照样通过',
  )
  assert.doesNotMatch(
    codeBody,
    /\|\|(?:(?:Boolean|Number|String|Array|Object)\(|\[|\{|!0|!!|``)/,
    'stillMine 被追加了恒真表达式（Boolean(true) / [] / {} / !0 等）：守卫会变成死代码',
  )
  // 计数必须用**代码形状**视图（第二轮外部审计 V2 实测）：squash 只去空白，不去字符串
  // 字面量内容，一行 `const __note = 'if(!stillMine())return ×5'` 就能在 5 道守卫被全部
  // 注释掉之后让计数通过。
  const guards = codeBody.match(/if\(!stillMine\(\)\)return/g) ?? []
  assert.ok(
    guards.length >= 5,
    `stillMine 复检只有 ${guards.length} 处（已屏蔽字符串字面量后统计）：create_session / set_model / read_attachment / vision_describe 每个 await 之后都必须复检`,
  )
  // 位置关系（外部审计 D4：旧版左侧用 codeBody、右侧用 body，两边坐标不同 ⇒ 假防线）：
  // 旧版拿 `codeBody.lastIndexOf('if(!stillMine())return')` 与 `body.indexOf("awaitrequest('prompt'")`
  // 比较 —— codeBody 被 maskStrings 缩短（3079→2752），索引整体前移，把最后一道守卫整块
  // 搬到 prompt 之后（变异 w1b）测试依然全绿。改成用**同一个视图**断言"最后一道守卫与
  // prompt 直接相邻"：这比比较两个索引更强 —— 搬迁、插入、包裹都会破坏相邻性，而
  // prompt 的实参是被屏蔽的字符串字面量，只能在未屏蔽视图里定位。
  const promptAt = body.indexOf("awaitrequest('prompt'")
  assert.notEqual(promptAt, -1, '找不到 dispatchTurn 里真正发出 prompt 的调用点')
  assert.ok(
    body.includes("if(!stillMine())returnawaitrequest('prompt'"),
    '最后一次 stillMine 复检没有与 await request(\'prompt\') 直接相邻：await 与守卫之间不得插入任何代码，否则守卫可能被搬到 prompt 之后（D4 变异 w1b）',
  )
  // 发送侧回合身份（外部审计 S-1 的**前半**，变异 M11 实测 SURVIVED）：
  //   接线 15 只断言了 error 分支**读取** `(event as {turnId?: string}).turnId`，
  //   即接收侧；而 sidecar 之所以能在事件上回显 turnId，靠的是这里把 turnId
  //   **发出去**。把 `attachments: bridged, turnId: activeTurnId })` 改成
  //   `attachments: bridged })` 后，接收侧代码一字未动、全部测试仍然绿 —— 但
  //   sidecar 收到的 payload 没有 turnId，`turnId: payload.turnId` 回显的就是
  //   undefined，晚到的 type:error 于是落到当前回合上（S-1 完整回归）。
  //   契约：prompt 请求必须携带本次派发的回合号，且必须取自 activeTurnId。
  assert.ok(
    body.includes("attachments:bridged,turnId:activeTurnId})"),
    'prompt 请求没有携带 turnId（S-1 的发送侧缺失）：sidecar 只能回显 undefined，type:error 的回合身份退化为"当前回合"，晚到的错误会写到新回合上（变异 M11）',
  )
  // S-1 有**三条**会造出 `type:'error'` 的 prompt 路径，上面只钉住了 dispatchTurn 一条
  // （红队确证缺陷 1：S-1 只关闭了 1/3）。第二条是 submit() 里的 steer 插话分支 ——
  // 它同样是 prompt、同样会在 sidecar 的 prompt().catch 里产生 turnId 回显。
  // 不带上回合号时 sidecar 回显 undefined，而 `isTurnCurrent(X, undefined)` 恒放行：
  // 晚到的 error 会把**新回合**整个收尾（running 归零、activeTurnId 清空、半截回复
  // 被提交成终态）。插话注入的正是当前轮，所以回合号必须取 slotFor(id).activeTurnId。
  // 这里必须用文件级 codeAt（保留字面量内容的 shape + 命中起点必须来自真实代码），
  // 不能用 functionBodyCodeOf：它把字符串字面量连定界符一起屏蔽成空格，
  // `'prompt'` 与 `'steer'` 都会消失，断言永远不成立。而纯 `functionBody` 视图
  // 又不设字面量来源闸门 —— 把整条调用塞进一个字符串就能骗过它。
  assert.notEqual(
    codeAt("voidrequest('prompt',{sessionId:id,text,cwd:workspacePath,behavior:'steer',turnId:slotFor(id).activeTurnId})"),
    -1,
    'steer 插话分支的 prompt 没有携带 turnId（红队确证缺陷 1：S-1 只覆盖了 dispatchTurn）：'
    + 'sidecar 回显的 turnId 是 undefined，晚到的 type:error 会被 isTurnCurrent 放行并收尾新回合。'
    + '该分支还必须带 .catch，否则 RPC 失败会变成未处理的 rejection',
  )
  assert.notEqual(
    codeAt("turnId:slotFor(id).activeTurnId}).catch(()=>{})"),
    -1,
    'steer 插话分支的 request 缺少 .catch：RPC 层失败时 void request(...) 会变成未处理的 rejection',
  )
  // 子代理路径（红队确认缺陷 1 的第三条）**不需要** turnId，但必须把这份"不需要"的理由
  // 固定在代码里，否则下一个人会照 dispatchTurn 的形状乱补一个回合号。
  assert.notEqual(
    codeAt("awaitrequest('prompt',{sessionId:childId,text:wrapTask(def,task),cwd:workspacePath,behavior:'steer',mode:def.mode})"),
    -1,
    'spawnSubagent 的 prompt 形状变了：它每个 childId 只跑一轮，不需要 turnId；'
    + '若给子代理补上 turnId，反而会把 undefined 判据换成可能失配的严格比较',
  )
})

// ── 缺陷 2：40ms 静默派发的定时器必须可取消 ──────────────────────────────

test('接线 2：drain 定时器必须走 scheduleDrain/clearDrainTimer，不得裸 setTimeout', () => {
  const finish = functionBody('finishRun')
  assert.match(finish, /scheduleDrain\(id\)/, 'finishRun 未用 scheduleDrain：Stop 时无法取消，队列项会在 40ms 后被静默派发（缺陷 2）')
  assert.doesNotMatch(
    finish,
    /setTimeout\(\(\)=>drainQueue\(id\),40\)/,
    '裸 setTimeout(()=>drainQueue(id),40) 又回来了：它的句柄不在任何清理集合里',
  )
  assert.match(
    functionBody('scheduleDrain'),
    /clearDrainTimer\(id\)[\s\S]*?drainTimers=\{\.\.\.drainTimers,\[id\]:window\.setTimeout/,
    'scheduleDrain 未先清旧句柄再登记新句柄：重复调度会留下不可取消的定时器',
  )
  assert.match(functionBody('teardownRun'), /clearDrainTimer\(id\)/, 'teardownRun 未清 drain 定时器')
  assert.match(functionBody('stop'), /clearDrainTimer\(id\)/, 'stop 未清 drain 定时器：中止后队列仍会被自动派发')
})

// ── 缺陷 7：销毁清理必须统一走 teardownRun ───────────────────────────────

test('接线 7：teardownRun 必须覆盖五项清理，且 closeTab/deleteSession 不得手写删 runState', () => {
  const teardown = functionBody('teardownRun')
  for (const call of ['clearRunWatchdog(id)', 'clearDrainTimer(id)', 'clearProviderError(id)', 'runEpoch.forget(id)', 'runEpoch.clearSuperseded(id)']) {
    assert.match(teardown, new RegExp(call.replace(/[()[\]]/g, '\\$&')), `teardownRun 漏了 ${call}`)
  }
  assert.match(functionBody('closeTab'), /markSlotClosed\(session\.id\)/, 'closeTab 未走 markSlotClosed')
  const del = functionBody('deleteSession')
  assert.match(del, /markSlotClosed\(session\.id\)/, 'deleteSession 未走 markSlotClosed：关闭路径与删除路径清理不对称（缺陷 7）')
  assert.match(
    del,
    /constwasRunning=slotFor\(session\.id\)\.running/,
    'deleteSession 未快照运行态：中途再读一次会在槽位被自己收回后得到 false，abort 请求再也发不出去',
  )
  assert.match(
    del,
    /if\(wasRunning\)\{runEpoch\.markAborted\(session\.id\)/,
    'deleteSession 未先标记中止世代（外部审计 D-C）：abort 到 markSlotClosed 之间迟到的 agent_end/agent_settled 会被当成正常收尾，把 running 归零、会话标记 done、还弹"任务已完成"通知 —— 与 closeTab/archiveSession 不对称',
  )
  assert.match(
    del,
    /if\(wasRunning&&sidecarReady\)awaitrequest\('abort'/,
    'deleteSession 未先中止在跑的运行：删除后 sidecar 仍在跑该会话',
  )
  // deleteSession 的 sessionEpoch.bump() 必须与 archiveSession/closeTab 对称（红队
  // M25-dc-nobump SURVIVED 的补强）。诚实定级：:1012 的 `activeSessionId !== session.id`
  // 第二条件目前已兜底，未证明线上可达危害；但这条 bump 是"作废在飞响应"的**唯一**直接
  // 手段，只靠第二条件守，一旦它被放宽就再无人守。
  assert.match(
    del,
    /if\(activeSessionId===session\.id\)sessionEpoch\.bump\(\)/,
    'deleteSession 未作废在飞响应（红队 M25）：删掉当前会话后，迟到的历史/错误响应会落到新状态上。archiveSession/closeTab 都有这条断言，deleteSession 不得例外',
  )
  // D-C 的**次序不变量**（红队 M24-dc-abort-before-mark SURVIVED 的补强）。
  // 上面三条都是存在性正则，把实现细节钉成了契约却没有守住真正的不变量：
  // 在 :989 之后插一次提前 `await request('abort', …)`、其余原文一字不动，就能让
  // 时间线变成 "abort 先行 → agent_end 被放行 → 完整收尾 → notifyDone 误报'任务已完成'"。
  // 不变量是：**世代标记与槽位收回必须同步完成，且严格早于第一次 await**。
  const bumpAt = del.indexOf('sessionEpoch.bump()')
  const markAt = del.indexOf('runEpoch.markAborted(session.id)')
  const patchAt = del.indexOf("patchSlot(session.id,{running:false,phase:'idle',activeTurnId:undefined,steer:[]})")
  const abortAt = del.indexOf("awaitrequest('abort'")
  assert.ok(
    bumpAt >= 0 && markAt >= 0 && patchAt >= 0 && abortAt >= 0,
    `deleteSession 的四步序列表不全：bumpAt=${bumpAt} markAt=${markAt} patchAt=${patchAt} abortAt=${abortAt}`,
  )
  assert.ok(bumpAt < markAt, 'deleteSession 的 sessionEpoch.bump() 必须在收运行侧之前（先作废在飞响应）')
  assert.ok(markAt < patchAt, '必须先记中止世代再收回槽位：顺序反了时 running 已清而标记未立，迟到终态仍会被当成正常收尾')
  assert.ok(
    patchAt < abortAt,
    'deleteSession 的四步次序错了（红队 M24）：必须 bump → markAborted → patchSlot → abort。'
    + '任何"先 await abort 再记状态"的写法都会让 abort 触发的 agent_end 在 closedIds 尚未封禁、'
    + 'markAborted 尚未立标记的窗口里被当成正常收尾完整提交（会话被标 done、还弹"任务已完成"）',
  )
  assert.doesNotMatch(
    del.slice(markAt, abortAt),
    /await/,
    'deleteSession 在"记中止世代"与"发出 abort"之间出现了 await：这段时间里槽位尚未收回、'
    + '终态事件仍会穿过闸门（红队 M24-dc-abort-before-mark 正是靠这一点存活的）',
  )
})

test('接线 7：archiveSession 必须对称（作废在飞响应 + 清运行侧），但不得封禁 id', () => {
  const body = functionBody('archiveSession')
  assert.match(body, /if\(activeSessionId===session\.id\)sessionEpoch\.bump\(\)/, 'archiveSession 未作废在飞响应：归档当前会话后迟到的历史/错误会落到新状态上')
  assert.match(body, /runEpoch\.markAborted\(session\.id\)/, 'archiveSession 未标记中止：陈旧终态事件会替新回合收尾')
  assert.match(body, /teardownRun\(session\.id\)/, 'archiveSession 未清运行侧状态')
  assert.doesNotMatch(
    body,
    /markSlotClosed/,
    'archiveSession 不得 markSlotClosed：归档可撤销，封禁 id 会让"取消归档"后的会话永久收不到事件',
  )
})

// ── 缺陷 10：运行中打开会话时历史不得被永久丢弃 ──────────────────────────

test('接线 10：applySessionHistory 运行中必须暂存历史，并在收尾后合并回填', () => {
  const apply = functionBody('applySessionHistory')
  assert.match(
    apply,
    /if\(current\.running\)\{if\(history\.length\)pendingHistory=\{\.\.\.pendingHistory,\[id\]:history\}return\}/,
    'applySessionHistory 又直接丢弃运行中的历史：用户打开有历史的会话只会看到当前这一轮（缺陷 10）',
  )
  assert.match(
    apply,
    /constmerged=mergeHistoryIntoTimeline\(history,current\.timeline\)/,
    'historyLoaded 分支必须走合并而不是覆盖：覆盖会抹掉正在流式输出的半截回复',
  )
  const flush = functionBody('flushPendingHistory')
  assert.match(flush, /mergeHistoryIntoTimeline\(parked,slotFor\(id\)\.timeline\)/, 'flushPendingHistory 未把暂存历史合并到当前时间线')
  assert.match(flush, /historyLoaded:true/, 'flushPendingHistory 未标记历史已加载')
  // 抗变异（外部审计缺陷 13 + 第三轮 C6）：停泊项只能在合并**真正落盘之后**才删。若改回
  // "先 delete 再 patchSlot"，会话在这两步之间被关掉时 patchSlot 会被 closedIds 拒绝，
  // 整段磁盘历史静默消失且无重试点。
  // 旧版用 `flush.indexOf('patchSlot(id,') < flush.lastIndexOf('deletenext[id]')` —— 两个弱点：
  // ① `lastIndexOf` 只要在函数尾部补一句 `if (false) delete next[id]` 就能把索引推到最大，
  // 断言仍通过；② 两侧只断言"存在该子串"，不要求各出现一次。第三轮改成：两种形状
  // **各恰好出现一次**，再用 `indexOf` 比较。
  assert.equal(
    (flush.match(/patchSlot\(id,/g) ?? []).length,
    1,
    'flushPendingHistory 里 patchSlot(id,…) 应恰好出现一次（多余的一处会让位置比较失去意义）',
  )
  assert.equal(
    (flush.match(/deletenext\[id\]/g) ?? []).length,
    1,
    'flushPendingHistory 里 delete next[id] 应恰好出现一次（尾部补的死分支能把 lastIndexOf 顶到最大，绕过位置断言 —— C6）',
  )
  assert.ok(
    flush.indexOf('patchSlot(id,') < flush.indexOf('deletenext[id]'),
    'flushPendingHistory 先删停泊项再写槽：被 closedIds 拒绝时历史会静默丢失（缺陷 13）',
  )
  // 抗变异（外部审计 C4）：`flushPendingHistory` 的 closedIds 分支如果被 `&& id === '__never__'`
  // / `if (false && pendingHistory[id])` 之类短路掉，仅断言 `if(closedIds.has(id)){` 子串照样通过。
  // 这里要求"关掉后的清理动作"是**分支体内的第一条语句**并与 return 直接相邻。
  assert.ok(
    flush.includes(
      'if(closedIds.has(id)){constpruned={...pendingHistory}deletepruned[id]pendingHistory=prunedreturn}',
    ),
    'flushPendingHistory 的 closedIds 分支形状变了：必须是"关掉即逐出停泊项并直接返回"（C4：死条件短路会让这段清理不再执行）',
  )
  assert.ok(
    functionBody('finishRun').indexOf('flushPendingHistory(id)') > functionBody('finishRun').indexOf('markSession(id,'),
    'flushPendingHistory 必须在状态写回之后调用，否则合并的是旧时间线',
  )
})

// ── 缺陷 11 / 12：stop 的收尾面与 recall 的等待 ──────────────────────────

test('接线 11：stop 必须清 steer[] 与 activeTurnId（两条分支都要）', () => {
  const body = functionBody('stop')
  const clears = body.match(/activeTurnId:undefined,steer:\[\]/g) ?? []
  assert.equal(
    clears.length,
    2,
    `stop 里 activeTurnId/steer 的清理应出现 2 次（未就绪分支 + finally），实际 ${clears.length} —— 残留的 activeTurnId 会让下一条消息的终态事件被误判归属（缺陷 11）`,
  )
  assert.match(body, /runEpoch\.markAborted\(id\)/, 'stop 未标记中止世代：被 abort 的回合迟到终态会误收当前回合（缺陷 1 的上游）')
  assert.match(body, /clearProviderError\(id\)/, 'stop 未清暂存错误')
})

test('接线 12：recallMessage 必须钉住入口会话 id、await stop() 后复检', () => {
  const body = functionBody('recallMessage')
  assert.match(body, /constidAtEntry=activeSessionId/, 'recallMessage 未把发起时的会话 id 钉住：await stop() 期间用户切走后会写到**另一个**会话（外部审计缺陷 12 回归）')
  assert.match(body, /if\(slot\.running\)awaitstop\(\)/, 'recallMessage 未 await stop()：迟到的 text_delta 会污染重发的历史（缺陷 12）')
  assert.match(body, /if\(activeSessionId!==idAtEntry\)return/, 'recallMessage 在 await 之后未复检会话是否已切走（外部审计缺陷 12 回归）')
  // 取槽必须用钉住的 id；重读模块级 activeSessionId 正是原来的 bug。
  assert.match(body, /constcurrent=slotFor\(idAtEntry\)/, 'recallMessage 在 await 之后未按钉住的 id 重新取槽')
  assert.doesNotMatch(body, /slotFor\(activeSessionId\)/, 'recallMessage 又去读模块级 activeSessionId：等待期间的切换会写到错误的会话')
  assert.match(body, /patchSlot\(idAtEntry,/, 'recallMessage 的写入目标不再是钉住的 id')
  assert.match(body, /activeTurnId:undefined/, 'recallMessage 未清 activeTurnId：撤回后残留的回合归属会让旧终态事件误收尾')
  // 抗变异（外部审计 C2）：把**真实**函数改名成 `recallMessageImpl`、再插一个"形状正确"的
  // 假 `recallMessage`，`functionRangeOf` 只找得到一处声明 ⇒ 全部断言照过，而模板点的是假的。
  // 对策：全文件只允许存在一个 `function recall` 声明，且模板的唯一调用点必须保持原样。
  const recallDecls = codeFlat.match(/functionrecall\w*\(/g) ?? []
  assert.deepEqual(
    recallDecls,
    ['functionrecallMessage('],
    `App.svelte 里出现了 ${recallDecls.length} 处 recall 函数声明（${recallDecls.join(' | ')}）：改名留旧体 + 插诱饵可让断言作用在诱饵上`,
  )
  assert.match(
    flat,
    /on:click=\{\(\)=>recallMessage\(message\.userIndex\)\}/,
    '模板里的撤回调用点形状变了：断言作用的 recallMessage 必须是界面真正调用的那一个',
  )
})

// ── 缺陷 6 / B1：慢请求返回后不得劫持导航、写错会话 ──────────────────────

test('接线 B1：newSession 建好会话后必须复检代数与来源，未换会话才抢焦点', () => {
  const body = functionBody('newSession')
  assert.match(body, /constepoch=sessionEpoch\.current\(\)/, 'newSession 未快照代数：创建期间用户切走后会被强行拉回新会话')
  assert.match(body, /conststartedFrom=activeSessionId/, 'newSession 未钉住发起时的会话')
  assert.match(
    body,
    /if\(!sessionEpoch\.check\(epoch\)\|\|activeSessionId!==startedFrom\)\{/,
    'newSession 缺少 await 之后的双重复检（缺陷 B1：劫持用户已切到的会话）',
  )
  // 复检分支不得直接丢掉新会话：磁盘上已有文件却没有标签
  const guardAt = body.indexOf('if(!sessionEpoch.check(epoch)||activeSessionId!==startedFrom){')
  const guardBlock = body.slice(guardAt, guardAt + 220)
  assert.match(guardBlock, /created\.id/, '复检分支必须仍然把新会话登记进列表（否则磁盘有文件却没有标签）')
})

test('接线 6：两条分叉路径都必须在 await 之后校验 epoch 才接管导航', () => {
  const guards = flat.match(/if\(activeSessionId===parentId&&sessionEpoch\.check\(epoch\)\)/g) ?? []
  assert.equal(
    guards.length,
    2,
    `forkWorktree 与 forkAtUserIndex 各自都要有 epoch 守卫，实际 ${guards.length} 处 —— 缺失的那条会把用户已经切过去的会话夺走（缺陷 6）`,
  )
  assert.doesNotMatch(
    flat,
    /if\(!response\.ok\)thrownewError\(response\.error\|\|'创建 worktree 分叉失败'\)[\s\S]{0,200}?activeSessionId=created\.id/,
    'worktree 分叉无条件接管导航的旧写法又回来了',
  )
})

test('接线 S1：dispatchTurn 的 catch 必须用 isTurnCurrent 精确判据并带上回合号', () => {
  const body = functionBody('dispatchTurn')
  assert.match(
    body,
    /if\(!isTurnCurrent\(slotFor\(id\)\.activeTurnId,activeTurnId\)\)return/,
    'catch 未做精确回合校验：上一轮 prompt 的迟到失败会把新一轮的 running 收掉（审查者 S1）',
  )
  assert.match(
    body,
    /finishRun\(id,[\s\S]{0,120}?,activeTurnId\)/,
    'catch 调 finishRun 时未传 expectedTurnId',
  )
})

test('接线 14：被取代的轮次不得吞掉 sidecar 的 type:error（新一轮 preflight 失败）', () => {
  // ⚠️ 全部走字面量来源视图（codeAt/codeAtFrom）：固定窗口 `squash(appSource.slice(...))`
  //    上的 `includes` 有两个可绕过点 —— ①字符串承载（stripComments 不剥字符串内容，
  //    把真实分支删掉、留一个含同样文本的字符串即可命中）；②诱饵分支（在真实分支前插一个
  //    条件永假的同 marker 块）。②已由"分支契约表"用例兜住，①必须靠这里。
  const entryStart = codeAt("if(payload.type==='event')")
  assert.ok(entryStart >= 0, '找不到事件入口（字面量来源视图定位失败）')
  // 让 preflight 失败的那一条 error 事件必须放行；其余（迟到的 agent_end/agent_settled）
  // 仍要被拦住，否则缺陷 1 的守卫失效。
  // 抗变异（外部审计 C3 + 第三轮）：只断言"分支里出现过 if(event.type!=='error')return"
  // 时，把整个分支包进 `if (false) { … }` / 在例外之前插入 `if(!true)return` 就能让守卫
  // 永不执行而断言照样通过。要求"例外判据是该分支体内的**第一条语句**"，且分支体
  // 恰好只有这一条语句 —— 这是精确形状等值，追加任何东西都会破坏它。
  assert.notEqual(
    codeAtFrom("elseif(runEpoch.isSuperseded(id)){if(event.type!=='error')return}", entryStart),
    -1,
    '世代守卫分支的形状变了：必须恰好是 `else if (runEpoch.isSuperseded(id)) { if (event.type !== \'error\') return }`（C3：外套死条件壳 / 在例外之前插死代码都能让这条守卫永不执行；只留字符串副本也不算命中）',
  )
  // 抗变异（第三轮全局）：死分支是绕过一切"存在性"断言的通用手法 —— 把真实代码整段
  // 搬进 `if (false) { … }` 后，所有子串断言依然命中。本组件里没有任何合法用途。
  assert.doesNotMatch(
    codeFlat,
    /if\(!?false\)|if\(!true\)|while\(false\)|while\(!true\)|&&false\)|\|\|false\)|&&false,|\|\|true\)|__never__/,
    'App.svelte 里出现了恒假/恒真条件或 __never__ 哨兵：真实代码可以被整段搬进永不执行的分支，而"存在该子串"的断言全部照过',
  )
})

// ── 缺陷 11：终态分支的调用形状（第二轮外部审计 V5 / S-1 的覆盖缺口） ──────
//
// V5 变异给 error 分支的 finishRun 补了第三个参数，125/125 全绿 —— 这条改动没有任何断言。
// 需要说清契约（本节把"为什么"写在测试里，避免下次又被"看起来更严格"的改动骗过去）：
//
//   SDK 的事件总线**不携带回合身份**：agent_end 只有 messages，agent_settled 什么都没有。
//   前端因此无法在事件里构造出精确回合判据 —— 这正是缺陷 1 要用"时间序 + runEpoch
//   世代标记"间接推断的原因。在这两处 `slotFor(id).activeTurnId` 是**恒等**的：
//   isTurnCurrent(X, X) 恒真，X 为 undefined 时也恒真 —— 补上去既不增加保护，也不会出错，
//   纯粹是"看起来更安全"的噪音。契约：agent_end / agent_settled 只传两个参数。
//
//   但 `type:'error'` 是**例外**（外部审计 S-1）：它来自 sidecar 里 prompt 的 .catch，
//   整轮不被 await，可以晚到 —— 若期间已派发新回合，不带回合身份就会把上一轮的错误
//   写到新回合上（红条闪现）。sidecar 已把请求里的 turnId 回显到该事件上，前端必须
//   原样把它当 expectedTurnId 传下去。用 `slotFor(id).activeTurnId` 不是"同一种噪音"：
//   它读的是**当前**回合，恰好在晚到场景下等于新回合的 id，会把错误写成新回合的收尾。
test('接线 15：终态分支的 finishRun 形状 —— agent_end/agent_settled 不带回合号，type:error 必须带', () => {
  // ⚠️ 存在性走字面量来源视图（挡字符串承载），块边界由分支契约表用例兜底（挡诱饵分支）。
  const entryStart = codeAt("if(payload.type==='event')")
  assert.ok(entryStart >= 0, '找不到事件入口（字面量来源视图定位失败）')
  assert.notEqual(
    codeAtFrom("if(event.willRetry)patchSlot(id,{running:true,phase:'thinking',processOpen:true})elsefinishRun(id,consumeProviderError(id))", entryStart),
    -1,
    'agent_end 的终态分支形状变了：willRetry 为真时必须保留运行态，为假时才收尾并消费暂存错误',
  )
  assert.notEqual(
    codeAtFrom("if(event.type==='agent_settled')finishRun(id,consumeProviderError(id))", entryStart),
    -1,
    'agent_settled 兜底分支被改写：它是 SDK 保证到达的唯一终态信号，必须无条件收尾',
  )
  // S-1：error 分支必须把事件回显的 turnId 当作 expectedTurnId。
  assert.notEqual(
    codeAtFrom(
      "if(event.type==='error'){clearProviderError(id)finishRun(id,String(event.message||'Agent请求失败'),(eventas{turnId?:string}).turnId)}",
      entryStart,
    ),
    -1,
    'type:error 分支被改写：必须先清暂存错误再收尾，错误文案来自事件本身，且必须把事件上回显的 turnId 当 expectedTurnId（sidecar 的 prompt 回调可晚到，否则上一轮的错误会写到新回合上）',
  )
  // 抗变异 V5：agent_end / agent_settled 这两处不得出现第三个参数（理由见上）。
  assert.doesNotMatch(
    flat,
    /finishRun\(id,[^)]{0,80},\s*slotFor\(id\)\.activeTurnId\)/,
    '终态分支被补上了伪回合判据：isTurnCurrent(X, X) 恒真，既无保护又掩盖了"事件无回合身份"这一事实',
  )
  // S-1 的**回显侧**（定向变异重放实测 SURVIVED，本段补上）：上面三条钉住了前端的
  //   读取侧与两个发送侧，但没人断言 sidecar 把 payload.turnId 原样写到 type:error
  //   事件上。把 `turnId: payload.turnId } }))` 改成 `turnId: undefined } }))` 后
  //   全部 164 条断言仍然全绿 —— 而 sidecar 一旦不回显，前端那行
  //   `(event as {turnId?: string}).turnId` 拿到的永远是 undefined，
  //   `isTurnCurrent(X, undefined)` 恒放行，S-1 的整个修复在运行时被静默废除
  //   （晚到的 error 照样收尾新回合）。契约：prompt 的 .catch 必须把请求里的 turnId
  //   原样回显到那条 error 事件上。
  assert.notEqual(
    indexOfCode(sideShape, sideLiteral, "turnId:payload.turnId}}))", 0),
    -1,
    'sidecar 的 prompt().catch 没有把 payload.turnId 回显到 type:error 事件上：'
    + '前端收到的 turnId 恒为 undefined，isTurnCurrent 恒放行，晚到的错误会收尾新回合（S-1 回显侧回归）',
  )
})

test('接线 1：finishRun 的回合守卫必须在清理动作之前', () => {
  const body = functionBody('finishRun')
  const guardAt = body.indexOf('if(!isTurnCurrent(current.activeTurnId,expectedTurnId))return')
  assert.notEqual(guardAt, -1, 'finishRun 缺 expectedTurnId 守卫')
  assert.ok(
    guardAt < body.indexOf('clearRunWatchdog(id)') && guardAt < body.indexOf('clearProviderError(id)'),
    '守卫位置不对：陈旧终态事件会先把**新**回合的看门狗与暂存错误一起清掉',
  )
  // 抗变异（第二轮外部审计 M15）：`patchSlot(id, { …, error: errorMessage, … })` 改成
  // `error: ''` 后全部测试仍然通过 ⇒ 用户报的"模型提供商出错但没有反馈"这个**原始症状**
  // 其实零断言覆盖：调用链修好了，但最后一步没把文案写进槽位，界面上依旧什么都不显示。
  assert.match(
    body,
    /error:errorMessage,/,
    'finishRun 未把错误文案写进槽位（M15）：整条链路修好也没用 —— 用户看不到任何提示，这正是原始 bug 的症状',
  )
  // 错误出口必须真的渲染（否则写进槽位也无人消费）。
  assert.match(
    flat,
    /\{#ifslotFor\(activeSessionId\)\.error\}[\s\S]{0,200}?<divclass="agent-error"role="alert">/,
    '错误槽位缺少渲染出口：写进 slot.error 的文案没有 DOM 消费者',
  )
})

// ── 第四轮外部审计新确证缺陷的接线保护（D-A / D-B / D-D / D-F / S-4） ─────

// D-A（P1）：preflight 阶段按"停止"会被随后的 agent_start 无条件撤销。
// SDK 侧铁证：pi-agent-core/dist/agent.js 的 `abort()` 只对**已经在跑的** activeRun 有效
// （`this.activeRun?.abortController.abort()`），而 preflight（压缩检查/鉴权/emitBeforeAgentStart）
// 期间 activeRun 尚不存在 ⇒ abort 是空操作；随后 preflight 通过、`agent-loop.js:49` 无条件
// emit `agent_start`，旧代码的 `patchSlot(id, { running: true, error: '' })` 就把用户的停止
// 撤销了，且 activeTurnId 已被 stop() 清空 ⇒ 此后该轮所有回合判据恒真，只能等 180s 看门狗。
// 修法：事件入口在 agent_start 处先看"这一轮是否已被标记中止"，是则补发一次 abort（此时
// activeRun 已存在，这次真的能停）并直接早退，不打 running。
test('接线 D-A：agent_start 不得撤销 preflight 期间发出的"停止"', () => {
  const at = appSource.indexOf("if (payload.type === 'event')")
  assert.notEqual(at, -1, '找不到事件入口')
  const entry = squash(appSource.slice(at))
  // ⚠️ 存在性断言必须走 codeAt/appShape（字面量来源视图），不能用 squash+substring。
  //    f15bc3a3 审查的 M1 实测：把真实早退分支整块删掉、换成一个字符串
  //    `const __shapeNote = "if(startedButAborted){…}"`，用 squash 视图的断言照样全绿
  //    （stripComments 不剥字符串内容）—— 真实代码零防线。
  const entryCodeAt = codeAtFrom('if(payload.type===', 0)
  assert.ok(entryCodeAt >= 0, '找不到事件入口（字面量来源视图定位失败）')
  const entryStart = appShape.indexOf('conststartedButAborted=')
  assert.notEqual(entryStart, -1, '找不到 startedButAborted 判据：事件入口结构已改，请同步本断言')
  // 把窗口限制在事件入口内（下一个顶层函数声明之前），避免误命中别处的同形状代码。
  const windowEnd = appShape.indexOf('functiondrainQueue(', entryStart)
  assert.notEqual(windowEnd, -1, '找不到 dispatchTurn 之后的下一个函数边界，窗口无法限定')
  const windowAt = (needle) => {
    const at = codeAtFrom(needle, entryStart)
    return at >= 0 && at < windowEnd ? at : -1
  }
  assert.notEqual(
    windowAt("conststartedButAborted=event.type==='agent_start'&&runEpoch.isAborted(id)"),
    -1,
    '事件入口缺少 startedButAborted 判据（外部审计 D-A）：preflight 期间 Stop 后，preflight 通过时 agent_start 会把 running 打回来，用户停不掉',
  )
  // ★ 主防线：把 agent_start 的**整个真分支**当成连续形状来要求，但拆成"早退头 + 收尾体"
  //   两段、中间用区间切片断言，避免把 `console.warn` 的文案钉进测试（文案是可改的，
  //   语义（补发了 abort / 保留了看门狗 / 后面才点亮 running）才是契约）。
  //   这一条同时杀死五种变异（f15bc3a3 审查实测全部 SURVIVED）：
  //     M0/M1/M1b —— 删掉早退分支、或换成同形状字符串 `const __shapeNote = "…"`；
  //     M2/M12    —— 只把早退分支**搬到别处**（文本仍在 `running:true` 之前，位置断言拦不住）。
  //   三种做法都会让这条连续形状对不上，而"存在该子串 + 位置在 running:true 之前"的写法
  //   全都拦不住。注意 `shape` 视图保留字符串字面量内容（与 `squash(stripComments())` 逐字符
  //   一致），所以形状里能原样写 `request('abort', …)`；`codeAtFrom` 只要求**命中起点**是
  //   真实代码，避免命中文件别处的同形状字符串。
  const earlyHead = windowAt("if(event.type==='agent_start'){if(startedButAborted){")
  assert.notEqual(
    earlyHead,
    -1,
    'agent_start 的早退分支不见了。停下来的那一轮在 preflight 通过后仍会发出 agent_start，' +
      '必须在这一分支里补发一次 abort 把它真正停掉，否则点 Stop 会被重新点亮成无人能停的假运行',
  )
  const resumeAt = windowAt(
    "touchRunWatchdog(id)return}markThinking(id)patchSlot(id,{running:true,error:''})markSession(id,'active')",
  )
  assert.notEqual(
    resumeAt,
    -1,
    "agent_start 的真分支形状不对。它必须**恰好**是「早退分支（补发 abort → 保留看门狗 → return）" +
      "紧接 markThinking + patchSlot(running:true,error:'') + markSession(active)」这一整块，" +
      '且早退分支必须在同一个分支体内。任何一步被删除、被换成同形状字符串、被搬到别的分支' +
      '（message_end/turn_end），都会让这条形状对不上 —— 那些写法实测都能让"只断言存在某子串"' +
      '的旧写法全绿，而缺陷完整回归（D-A 早退分支失效 ⇒ 点 Stop 后可被 preflight 通过的 ' +
      'agent_start 重新点亮成无人能停的假运行）',
  )
  assert.ok(earlyHead < resumeAt, 'agent_start 的早退分支必须排在 running:true 之前')
  const earlyBody = appShape.slice(earlyHead, resumeAt)
  assert.ok(
    earlyBody.includes("voidrequest('abort',{sessionId:id})"),
    '早退分支没有补发 abort：被停掉的那一轮会在 SDK 里继续跑完（D-A 回归）',
  )
  // D2（外部对抗性审查确证回归）：早退分支**不得**撤掉看门狗。:1741 刚为这个事件重新
  // 武装了 180s 看门狗，而那正是补发 abort 丢失时唯一还能自救的兜底 —— 一旦在此拆掉，
  // 界面会永久停在 thinking（stop().then 永不落地，没人再清 running）。
  assert.ok(
    !earlyBody.includes('clearRunWatchdog(id)'),
    '早退分支又撤掉了 180s 看门狗（D2 回归）：补发的 abort 一旦丢失（IPC 失败 / sidecar 悬挂），' +
      'stop() 的 .then 永不落地，界面就永久停在 Thinking。此处必须是 touchRunWatchdog(id)，' +
      '它在 running 已为假时是空转、仍为真时给出真正的超时反馈',
  )
  // ⚠️ D-A 残留（Lead 探针复现的真实空档，必须锁住）：解标记本身也要防止撤销停止。
  // 原写法是无条件 `if (event.type === 'agent_start') runEpoch.clearSuperseded(id)`，
  // 被停掉那一轮的 agent_start 一到就把标记删了 —— 早退分支注释里"标记要留着拦住这一轮
  // 随后迟到的 agent_end/agent_settled"于是变成空话。后果可复现：早退后 running 恒假、
  // activeTurnId 恒空，用户随即再发一条 ⇒ dispatch 推进世代、running 重新为真；旧轮迟到的
  // agent_end 因为标记已删而不算 superseded 被放行，而 isTurnCurrent(新回合, undefined)
  // 恒真且 running 为真 ⇒ 旧轮终态把**新回合**完整收尾打死（探针输出"旧轮终态提交收尾，
  // 新轮被打死"）。修法：仅当本轮**不是**被停掉的那一轮时才解标记。
  assert.notEqual(
    windowAt("if(event.type==='agent_start'&&!startedButAborted)runEpoch.clearSuperseded(id)"),
    -1,
    '发现 D-A 残留：agent_start 仍无条件 clearSuperseded —— 被停掉那一轮的 agent_start 会提前删掉中止标记，' +
      '此后旧轮迟到的 agent_end/agent_settled 不再被判定为 superseded，会把用户随后新发的回合当成已结束打回 idle（新轮被打死）',
  )
  assert.equal(
    windowAt("if(event.type==='agent_start')runEpoch.clearSuperseded(id)"),
    -1,
    'agent_start 又变回无条件清除中止标记（D-A 残留回归）',
  )
})

// D-B（P1）：后台会话的权限确认不可见、不可答。
// 确认卡片原来只渲染 active 槽（`runState[activeSessionId]?.confirm`），回答函数也只取
// active 槽 ⇒ 用户切走后整段确认在界面上不存在，sidecar 要挂 600s 超时后按
// confirm→false 保守拒绝。修法：非 active 槽的待确认单独派生成一个列表并渲染卡片，
// answerConfirm 接受显式 sessionId。
test('接线 D-B：后台会话的权限确认必须可见、可答', () => {
  assert.match(
    flat,
    /\$:pendingConfirms=Object\.keys\(runState\)\.filter\(\(id\)=>runState\[id\]\?\.confirm&&id!==activeSessionId\)/,
    '缺少 pendingConfirms 派生（外部审计 D-B）：非当前会话的权限确认在界面上不可见，只能等 600s 超时被拒',
  )
  // ⚠️ 存在性必须走字面量来源视图（codeAt）：M1/M3/M5 一类的"字符串承载"变异
  //    把真实代码删掉、只留一个含同样文本的字符串即可骗过 squash 视图。
  assert.notEqual(
    codeAt('functionanswerConfirm(ok:boolean,sessionId=activeSessionId)'),
    -1,
    'answerConfirm 未接受显式 sessionId：回答只能落到当前会话，后台会话的确认永远答不上',
  )
  // ⚠️ M6-db-clobber：保留形参与全部文本，只在函数体首行插 `sessionId = activeSessionId`，
  //    回答就又落到当前会话、后台卡片永远清不掉 —— 这是"文本都在但语义已反转"型变异，
  //    只有对函数体做**精确形状**断言才能拦住。
  const confirmCode = functionBodyCode('answerConfirm')
  assert.match(
    confirmCode,
    /^functionanswerConfirm\(ok:boolean,sessionId=activeSessionId\)\{constid=sessionId/,
    'answerConfirm 的函数体首条语句必须原样取用传入的 sessionId（`const id = sessionId`）：在它前面插任何重绑（如 `sessionId = activeSessionId`）都会让后台确认的回答又落到当前会话',
  )
  // 只看函数体（跳过签名里的默认值 `sessionId = activeSessionId`）：体内任何把 sessionId
  // 重新指回 activeSessionId 的赋值都是本缺陷的回归。
  const confirmInner = confirmCode.slice(confirmCode.indexOf('{') + 1)
  assert.doesNotMatch(
    confirmInner,
    /sessionId=activeSessionId/,
    'answerConfirm 内出现了对 sessionId 的重绑：参数被丢弃，回答落不到后台会话（缺陷 D-B 回归）',
  )
  assert.doesNotMatch(
    confirmInner,
    /constid=activeSessionId/,
    'answerConfirm 未用传入的 sessionId 取槽（写了 `const id = activeSessionId`）：后台确认的回答会落到当前会话',
  )
  assert.match(
    flat,
    /\{#eachpendingConfirmsasitem\(item\.id\)\}/,
    '缺少后台确认卡片的 {#each} 渲染块：列表渲染不出来，缺陷 D-B 未真正修复',
  )
  assert.match(flat, /answerConfirm\(true,item\.id\)/, '后台确认的"允许"按钮未把 item.id 传给 answerConfirm')
  assert.match(flat, /answerConfirm\(false,item\.id\)/, '后台确认的"拒绝"按钮未把 item.id 传给 answerConfirm')

  // ⚠️ 位置也是这个修复的一部分：消息区整体包在 `{#if activeSessionIdle}` 的 `{:else}` 里，
  // 把卡片放进那个分支，等于"active 槽是空会话时（刚启动、刚切到新会话、刚清空）后台确认
  // 又变回不可见" —— 那恰好是最常见的场景。必须渲染在空白页分支之外。
  const blockEnd = (source, marker) => {
    const tokens = /\{#(if|each|await|key)\b|\{:(else|then|catch)\}|\{\/(if|each|await|key)\}/g
    let started = false
    let depth = 0
    let m
    while ((m = tokens.exec(source))) {
      if (m[1] || m[3]) {
        if (!started) {
          if (m.index < marker || !m[1]) continue
          started = true
          depth = 1
          continue
        }
        if (m[1]) depth += 1
        else if (--depth === 0) return m.index
      }
    }
    return -1
  }
  const idleIf = flat.indexOf('{#ifactiveSessionIdle}')
  assert.notEqual(idleIf, -1, '找不到 `{#if activeSessionIdle}`：空白页判据被改写过，请同步本断言')
  const idleEnd = blockEnd(flat, idleIf)
  assert.notEqual(idleEnd, -1, '`{#if activeSessionIdle}` 的配平 `{/if}` 定位失败：模板结构已损坏或本断言需同步')
  const remoteEach = flat.indexOf('{#eachpendingConfirms')
  assert.notEqual(remoteEach, -1, '找不到后台确认卡片的 {#each} 渲染块')
  assert.ok(
    remoteEach > idleEnd,
    '后台确认卡片被渲染在 `{#if activeSessionIdle}` 的空白页分支**内部**：active 槽为空会话时整段消息区都不渲染，后台确认重新变回不可见（缺陷 D-B 回归）',
  )
})

// D-D（P2）：remember() 不查 closedIds ⇒ 关标签时在飞的 set_model/set_thinking 回包
// 会复活出无会话文件的"新会话"幽灵标签（侧栏数据源就是 sessions 数组）。
test('接线 D-D：remember 不得复活已关闭的会话', () => {
  // ⚠️ 必须走 functionBodyCode（maskStrings 视图）：M3-dd-string 实测把真实的
  //    `if (closedIds.has(id)) return` 删掉，插一个含同样文本的字符串常量
  //    `const __shapeNote = "if(!id)returnif(closedIds.has(id))return"`，
  //    stripComments 视图的断言照样命中（字符串内容不被剥除）。maskStrings 视图里
  //    那个字符串已变成空格，只有真实代码才能命中。
  const body = functionBodyCode('remember')
  assert.match(
    body,
    /^functionremember\(id:string,patch:Partial<Session>\)\{if\(!id\)returnif\(closedIds\.has\(id\)\)return/,
    'remember 缺少 closedIds 闸门（外部审计 D-D）：关闭标签期间在飞的 set_model/set_thinking 回包会复活出无会话文件的幽灵标签',
  )
})

// D-F（P2）：extDialog 原来是全局单值，后到的请求整体覆盖先到的 ⇒ 先到的 dialogId
// 永远收不到回答，只能等 600s 超时。修法：改成队列（extDialogs），渲染队首，
// 入队/超时/回答三条路径都要维护队列。
test('接线 D-F：扩展对话框必须排队，不得单值覆盖', () => {
  assert.match(flat, /letextDialogs:ExtDialog\[\]=\[\]/, '扩展对话框未改为队列（外部审计 D-F）：全局单值会让先到的对话框永远收不到回答')
  assert.match(flat, /\$:extDialog=extDialogs\[0\]\?\?null/, 'extDialog 不再是"队首视图"：渲染源与队列脱钩')
  assert.doesNotMatch(
    flat,
    /letextDialog:ExtDialog\|null=null/,
    '单值 extDialog 又回来了：两个扩展/两个会话并发请求时，先到的那个必然被覆盖',
  )
  assert.match(flat, /extDialogs=\[\.\.\.extDialogs,dialog\]/, 'ui_dialog_request 未入队：新对话框会覆盖正在显示的那个')
  // ⚠️ M4-df-overwrite：保留入队与两条 filter 的文本，仅在入队后追加 `extDialogs = [dialog]`
  //    （后到者覆盖先到者 = D-F 缺陷完整回归）。因此必须断言**不存在整体覆盖赋值**，
  //    且 extDialogs 的赋值点恰好是这三处（入队 / 超时出队 / 回答出队）。
  assert.doesNotMatch(
    flat,
    /extDialogs=\[dialog\]/,
    '出现 `extDialogs = [dialog]` 式整体覆盖：后到的对话框会顶掉先到的，先到的 dialogId 永远收不到回答（缺陷 D-F 回归）',
  )
  const dialogAssigns = flat.match(/extDialogs=\[[^\[\]]*\]/g) ?? []
  assert.deepEqual(
    dialogAssigns,
    ['extDialogs=[...extDialogs,dialog]'],
    `extDialogs 的赋值形态变了（期望只有一处入队式的展开赋值，实际 ${JSON.stringify(dialogAssigns)}）：出现整体覆盖赋值就意味着 D-F 回归`,
  )
  assert.match(
    flat,
    /constnextQueue=extDialogs\.filter\(\(item\)=>item\.dialogId!==expiredId\)/,
    'dialog_expired 未把超时的对话框移出队列：它会被换掉但队列里仍占位',
  )
  assert.match(
    flat,
    /constrest=extDialogs\.filter\(\(item\)=>item\.dialogId!==dialog\.dialogId\)/,
    'answerExtDialog 未把已回答的对话框移出队列：答完之后会立刻弹出下一个本不该显示的对话框',
  )
})

// S-4（疑点，零成本消除）：stop() 的 .then 原来零守卫 —— 若在 abort 回执之前又派发了
// 新回合，旧 stop 的回调会把新回合打回 idle 并清掉它的 activeTurnId。
test('接线 S-4：stop 的收尾必须校验世代与回合', () => {
  // ⚠️ 必须走 functionBodyCode（maskStrings 视图）挡 M5-s4-string：实测把 `stop()` 里
  //    两条真守卫删掉、插一个含同样文本的字符串常量即可骗过 stripComments 视图。
  const body = functionBodyCode('stop')
  assert.match(body, /constgeneration=runEpoch\.generationOf\(id\)/, 'stop 未在 await 之前快照世代：回执到达时无法判断是否已换轮')
  assert.match(body, /constturnId=slotFor\(id\)\.activeTurnId/, 'stop 未在 await 之前快照回合号')
  // 两条守卫必须是 .then 回调体里的**前两条语句**（前面可以有 catch(()=>undefined) 这类前置）。
  assert.match(
    body,
    /\.then\(\(\)=>\{if\(runEpoch\.generationOf\(id\)!==generation\)returnif\(slotFor\(id\)\.activeTurnId!==turnId\)return/,
    'stop 的 .then 回调体前两条语句必须恰好是世代守卫与回合守卫：少一条或次序颠倒，期间派发的新回合会被旧 stop 打回 idle、看门狗被清掉',
  )
  const genAt = body.indexOf('if(runEpoch.generationOf(id)!==generation)return')
  const clearAt = body.indexOf('clearRunWatchdog(id)', genAt)
  assert.ok(genAt >= 0 && clearAt > genAt, '两个守卫必须排在任何清理动作之前，否则新回合的看门狗/暂存错误会被旧 stop 清掉')

  // D1（f15bc3a3 对抗性审查确证的运行时回归，默认交互即可踩中）：stop() 必须在**发
  // `request('abort')` 之前**就乐观清空 running/activeTurnId。机理：SDK 的 abort() 要
  // `await waitForIdle()`（agent-session.js:1222-1228），回执必然很晚；若这段时间里 running
  // 仍为真，用户在同一个会话再回车会命中 submit() 的 steer 分支（`:2324`）—— 它只发 prompt、
  // **不调用 dispatchTurn**，于是世代不推进、仍停在被中止的世代。等 SDK 因
  // `hasQueuedMessages()` 为真而 `continue()` 去服务那条插话（agent-loop.js:67 无条件发
  // agent_start），入口的 startedButAborted 判为真 ⇒ 走 agent_start 早退分支把**用户刚发的
  // 那一轮**补发 abort 杀掉：消息丢失、没有回复。乐观清空后下一次提交就走 dispatchTurn 推进
  // 世代，被停掉的旧轮终态由 isSuperseded 拦下，新轮的 agent_start 正常流动。
  const markAt = body.indexOf('runEpoch.markAborted(id)')
  // 注意：functionBodyCode 是 maskStrings 视图，字符串（含定界符）被屏蔽成空白再 squash，
  // 所以 `phase: 'idle'` 在这里表现为 `phase:,`、`request('abort'` 表现为 `request(,`。
  const optimisticAt = body.indexOf(
    'patchSlot(id,{running:false,phase:,activeTurnId:undefined,steer:[]})',
    markAt,
  )
  const abortReqAt = body.indexOf('returnrequest(,{sessionId:id})', optimisticAt)
  assert.ok(markAt >= 0, 'stop 里找不到 runEpoch.markAborted(id)')
  assert.notEqual(optimisticAt, -1, "stop() 缺少发 abort 前的乐观清空（D1 回归）：abort 回执飞行期间 running 仍为真，" +
    '用户此时再回车会走 steer 分支（不推进世代），SDK 服务那条插话时发出的 agent_start 会被早退分支当' +
    '「被停掉的旧轮」补发 abort 杀掉 —— 用户消息丢失且没有回复')
  assert.ok(abortReqAt > optimisticAt, '乐观清空必须排在 request("abort") 之前：写在回执之后等于没写（D1 回归）')
  // 世代/回合快照必须在乐观清空**之后**取：此刻 activeTurnId 已是 undefined，
  // 于是"期间有人派发过新一轮"表现为 turnId 被写成新值，守卫照样命中。
  const genSnapAt = body.indexOf('constgeneration=runEpoch.generationOf(id)')
  assert.ok(genSnapAt > optimisticAt, '世代快照必须取在乐观清空之后，否则守卫比较的是已被自己清掉的值')
})

// ── 归约器分支契约 ──────────────────────────────────────────────────────
// ⚠️ 这是挡"诱饵分支"（f15bc3a3 审查的 M7/M8）的主防线。eventBlockOf 取的是"第一处带
//    花括号的同 marker 分支"，所以在真实分支**前面**插一个条件永假（如 `id === '__decoy__'`）、
//    形状完整的同 marker 分支，就能让所有基于 eventBlockOf 的断言在诱饵上求值通过，
//    真实分支改成 `void 0` 也照样全绿（M8 实测 provider-error-wiring 14/0）。
//    这张表列出归约器里**所有** `if (event.type === 'X' …)` 的类型名（按出现顺序），
//    任何插入/删除/移动事件分支都会改变它 —— 诱饵分支无处可藏。
//    实现走 maskStrings（字符串里假造的 `event.type === 'x'` 不算），见 eventConditionTypesOf。
test('接线：事件归约器的分支契约表不得改变（诱饵分支防线）', () => {
  assert.deepEqual(
    eventConditionTypesOf(appSource),
    [
      'agent_start',
      'message_end',
      'turn_end',
      'message_update',
      'turn_start',
      'message_start',
      'message_end',
      'tool_execution_start',
      'tool_execution_update',
      'tool_execution_end',
      'agent_start',
      'auto_retry_start',
      'auto_retry_end',
      'compaction_start',
      'compaction_end',
      'agent_end',
      'agent_settled',
      'turn_end',
      'error',
    ],
    '事件归约器的分支表变了：插入/删除/移动事件分支（含条件永假的诱饵分支）都会改变这张表。' +
      '如果这是有意的结构改动，请同步本表并确认 eventBlockOf 仍只能取到真实分支。',
  )
})

// ── 守卫文件自身 ────────────────────────────────────────────────────────

test('接线：注释剥离器对这些断言仍有效（防止本文件退化成子串匹配）', () => {
  const sample = stripComments('// planDrain(a)\n/* clearRunWatchdog(b) */\nrealCall(c)\n')
  assert.doesNotMatch(sample, /planDrain|clearRunWatchdog/, '注释未被剥离：本文件的断言会重新变成假防线')
  assert.match(sample, /realCall\(c\)/, '真实代码被误删')
})
