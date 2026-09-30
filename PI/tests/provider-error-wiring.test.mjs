// provider 错误归因的**接线保护**测试（针对 App.svelte 源码，非复刻）
//
// 为什么必须有它（第一轮对抗性审查的 M3 变异验证结论）：
//   把 App.svelte 里 `agent_settled` 的 `consumeProviderError(id)` 删掉（本次修复的
//   兜底环节、自称"唯一保证到达的终态信号"），run-slot 25/25、event-slim 21/21、
//   provider-error-e2e 2/2 **全部照常通过** —— 因为那几个测试要么测纯函数，要么在
//   provider-error-e2e 里**手写复刻**归约逻辑，组件本身被改坏它们发现不了。
//   于是修复最关键的一环处于零覆盖状态。
//
// 为什么第二版要**先剥注释再断言**（第二轮对抗性审查的 M8/M9/M11 变异结论）：
//   初版直接对源码做 assert.match（子串匹配）→ 被三个"注释绕过"变异证明是**虚假安全感**：
//     M8  把三个薄壳函数体掏空、只把纯函数名留在注释里   → 68/68 全绿（该拦的没拦）
//     M9  把 stop() 的真实 `error: ''` 改成行尾注释      → 12/12 全绿（该拦的没拦）
//     M11 把 agent_settled 真实行注释掉 + 退化成 finishRun(id)
//         → 12/12 全绿，连专门守卫 M3 缺口的那条也通过（indexOf 命中的是注释里的文本）
//   根因：源码文本里"出现某串字符"≠"该行为存在"。注释、字符串都能满足子串匹配。
//   修法：stripComments() 剥掉行注释与块注释（保留字符串字面量），再做结构断言；
//   并用 squash() 去掉全部空白，使断言只依赖**标记序列**而非缩进/换行形态
//   （顺带修掉第二轮审查的 M10 假阳性：语义等价的换行重排会误报失败）。
//
// 局限（诚实声明）：这仍是源码结构断言，只证明"可执行代码里存在该标记序列"，
// 不证明组件运行时行为。真正的行为守卫在 run-slot.ts 的纯函数单测
// （stashProviderError/removeProviderError/takeProviderError/isCancellationText）
// 与 provider-error-e2e.test.mjs 的真实 SDK 探针；本文件是防"接线被删/被注释掉"的护栏。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { eventBlockOf, eventConditionTypesOf, functionBodyOf, indexOfCode, maskStrings, shapeWithLiteralMask, squash, stripComments } from './helpers/source-assert.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

const rawSource = readFileSync(path.join(here, '..', 'src', 'App.svelte'), 'utf8')
const appSource = stripComments(rawSource)
// 与 session-wiring.test.mjs 同一套"字面量来源视图"：appShape 保留字面量内容（所以
// 仍能匹配必然含 `'abort'` 这类字符串的形状），appLiteral[k] 标记该字符是否来自字面量。
// 存在性断言走 indexOfCode(appShape, appLiteral, …)：命中起点必须来自真实代码，
// 这样"把真实语句删掉、在旁边留一个内容相同的字符串常量"不再能骗过断言（D3/D4）。
const { shape: appShape, literal: appLiteral } = shapeWithLiteralMask(rawSource)

// 取事件分支块，并**同时断言块边界是干净的**（变异重放 S-3 的后补防线）：
//   eventBlockOf 的实现一旦退化成"从标记处截固定长度窗口"（历史版本就是
//   `slice(at0, at0 + 2000)` 兜底），窗口必然仍包住该分支，于是本文件**每一条子串
//   断言照样命中** —— 实测把整个分支实现搬进另一个分支的窗口，14/0 全绿。
//   只断言"块里存在某串"永远无法证明"块到哪里结束"，所以必须显式断言：
//   这个块里不得再出现**别的** `event.type === '…'` 分支。
//   断言写在这里（而不是 eventBlockOf 里）是刻意的：只有这样，把 eventBlockOf
//   改坏才会被本文件抓住；写在 helper 内部等于让被改坏的那段代码自我认证。
const eventBlock = (type) => {
  const block = eventBlockOf(appSource, type)
  const foreign = [...block.matchAll(/event\.type==='([a-z_]+)'/g)]
    .map((match) => match[1])
    .filter((name) => name !== type)
  assert.deepEqual(
    foreign,
    [],
    `eventBlockOf('${type}') 的块越界了：块内出现了其它事件分支 ${[...new Set(foreign)].join(', ')}。` +
      '这说明定界符已不可靠（典型是退化成了固定长度窗口），此时"块内存在某标记"的断言' +
      '可能是在**别的分支的代码**上求值 —— 看起来验证过了，其实什么都没验证（S-3）',
  )
  return block
}

// ⚠️ 诱饵分支防线（f15bc3a3 审查的 M7/M8 实测）：eventBlockOf 取"第一处带花括号的同 marker
//    分支"，因此在真实分支**前面**插一个条件永假、形状完整的同 marker 块（如
//    `if (event.type === 'agent_end' && id === '__decoy__') { …正确形状… }`）并把真实分支
//    改成 `void 0`，本文件所有断言都会在诱饵上求值通过（M8 实测 14/0 全绿）。
//    这张契约表列出归约器里**所有** `if (event.type === 'X' …)` 的类型名（按出现顺序），
//    插入/删除/移动任何事件分支都会改变它 —— 诱饵无处可藏。
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
const functionBody = (name) => functionBodyOf(appSource, name)

test('接线：agent_settled 必须消费暂存的 provider 错误（M3 缺口，唯一保证到达的终态）', () => {
  assert.match(
    eventBlock('agent_settled'),
    /finishRun\(id,consumeProviderError\(id\)\)/,
    'agent_settled 不再消费 provider 错误：SDK 不发 type:"error"、agent_end 又可能因 willRetry 被跳过，' +
      '这里一旦退化成 finishRun(id)，provider 失败就会重新变成"没有反馈"',
  )
})

test('接线：agent_end 仅在 willRetry 为假时收尾并消费错误；为真时必须保留暂存', () => {
  const block = eventBlock('agent_end')
  assert.match(block, /if\(event\.willRetry\)/, 'agent_end 必须判断 willRetry，否则重试前会提前显示结束')
  // 允许 `else finishRun(...)` 与语义等价的 `else { finishRun(...) }` 两种形态
  assert.match(
    block,
    /else\{?finishRun\(id,consumeProviderError\(id\)\)\}?/,
    'agent_end 的非重试分支必须携带归因后的错误文本',
  )
  assert.match(block, /assistantErrorFrom\(event\.messages\)/, 'agent_end 必须从权威终态消息取错误')
})

test('接线：message_end(assistant) 与 turn_end 都必须暂存错误文本', () => {
  assert.match(
    eventBlock('message_end'),
    /role==='assistant'[\s\S]{0,120}?setProviderError\(id,assistantErrorFrom\(event\.message\)\)/,
    'message_end(assistant) 未暂存错误：可重试错误在重试前就丢了原因',
  )
  assert.match(
    eventBlock('turn_end'),
    /setProviderError\(id,assistantErrorFrom\(event\.message\)\)/,
    'turn_end 未暂存错误',
  )
})

test('接线：type:"error" 分支必须先清暂存再收尾（避免上报过期原因）', () => {
  const block = eventBlock('error')
  assert.match(block, /clearProviderError\(id\)/, 'type:"error" 分支未清暂存')
  assert.match(block, /finishRun\(id,String\(event\.message/, 'type:"error" 分支必须把 SDK 文案交给用户')
})

test('接线：看门狗必须跳过 auto_retry_* 心跳（否则永久 Thinking 依旧成立）', () => {
  // D3/D4（外部对抗性审查确证）：原先是固定 900 字符窗口 + `assert.match(squash(...))`。
  // 固定窗口的余量只剩 15 个原始字符（`stripComments` 保留注释行的缩进/换行，这些空白
  // 仍占窗口预算却被 squash 抹掉）⇒ 插任意一行真实语句即假失败；而 `stripComments` 不剥
  // 字符串字面量 ⇒ 把真实条件掏空、再放一个内容相同的字符串常量就能整体绕过。
  // 改为「字面量来源闸门 + 连续形状」：命中起点必须来自真实代码，且必须是一条完整语句。
  const start = appShape.indexOf('constid=payload.sessionId||activeSessionId')
  assert.ok(start > 0, '找不到事件归约入口')
  const watchdogShape = "if(event.type!=='auto_retry_start'&&event.type!=='auto_retry_end')touchRunWatchdog(id)"
  assert.notEqual(
    indexOfCode(appShape, appLiteral, watchdogShape, start),
    -1,
    '看门狗又对 auto_retry_* 无条件续期了：一个反复失败的模型可以让界面永远停在 Thinking',
  )
})

test('接线：finishRun 必须清暂存（防止下一次正常结束被上一次错误污染）', () => {
  assert.match(functionBody('finishRun'), /clearProviderError\(id\)/, 'finishRun 未清暂存')
})

test('接线：stop() 必须在入口与收尾各清一次，并把 error 显式写空', () => {
  const body = functionBody('stop')
  const clears = body.match(/clearProviderError\(id\)/g) ?? []
  assert.ok(
    clears.length >= 2,
    `stop() 只清了 ${clears.length} 次：退避期间点 Stop 时 SDK 的` +
      '"Retry cancelled" 是在 abort 请求飞行途中才到达的，入口那次拦不住',
  )
  assert.match(
    body,
    /error:''/,
    "stop() 收尾的 patchSlot 必须显式带 error: ''：patchSlot 是浅合并，漏掉该字段会保留旧值，" +
      '让"请求失败"红条留在界面上',
  )
})

test('接线：auto_retry_end 的 finalError 必须过滤主动取消文案（误报修复）', () => {
  const block = eventBlock('auto_retry_end')
  assert.match(block, /isCancellationText\(finalError\)/, '未过滤 "Retry cancelled"：用户自己按 Stop 却被告知请求失败')
  assert.match(block, /setProviderError\(id,finalError\)/, '真实的最终重试失败原因仍必须上报（漏报防护）')
})

test('接线：sidecar 死亡与重启都必须收回 running 槽（永久 Thinking 的直接成因）', () => {
  const restart = functionBody('onSidecarRestarted')
  assert.match(restart, /abortRunningRuns\(/, '侧车重启未收回 running 槽')
  const failedStart = appSource.indexOf("payload.type === 'sidecar-failed'")
  assert.ok(failedStart > 0, '找不到 sidecar-failed 分支')
  const failedBlock = squash(appSource.slice(failedStart, failedStart + 1200))
  assert.match(
    failedBlock,
    /abortRunningRuns\(/,
    'sidecar-failed 未收回 running 槽：此前只 fail pending 请求，用户看到的是永久 Thinking',
  )
})

test('接线：abortRunningRuns 必须清 activeTurnId（否则提示可被 later finishRun 抹掉）', () => {
  const body = functionBody('abortRunningRuns')
  assert.match(
    body,
    /activeTurnId:undefined/,
    'abortRunningRuns 未清 activeTurnId：finishRun 的早退条件是 `!running && !activeTurnId`，' +
      "留着它会让之后任何一次 finishRun(id, '') 用空串抹掉\"侧车已停止\"的提示",
  )
  assert.match(body, /error:message/, 'abortRunningRuns 必须写入原因')
  assert.match(body, /clearRunWatchdog\(id\)/, 'abortRunningRuns 必须清看门狗')
})

test('接线：App.svelte 必须真的引用归因与暂存函数（防止 import 被删后静默失效）', () => {
  // 注：describeProviderError 自 M11/M12 修复起只在 run-slot.ts 内部被 takeProviderError
  // 调用，故这里断言的是组件真正用到的那些；describeProviderError 的行为由
  // tests/run-slot.test.mjs 直接单测，不再依赖源码文本匹配。
  for (const name of [
    'assistantErrorFrom',
    'isCancellationText',
    'stashProviderError',
    'removeProviderError',
    'takeProviderError',
  ]) {
    assert.match(squash(appSource), new RegExp(name), `${name} 未被 App.svelte 引用：归因链路断开`)
  }
})

test('接线：暂存三函数必须是 run-slot 纯逻辑的薄壳（语义不得内联回组件，否则重新变成零覆盖）', () => {
  // M11/M12 变异实证：把函数体内联写在组件里时，整条暂存语义改坏了也无人发现。
  // M8 变异实证：函数名只出现在注释里也能骗过子串匹配 —— 故这里断言的是剥注释后的代码。
  for (const [fn, pure] of [
    ['setProviderError', 'stashProviderError'],
    ['clearProviderError', 'removeProviderError'],
    ['consumeProviderError', 'takeProviderError'],
  ]) {
    assert.match(
      functionBody(fn),
      new RegExp(`${pure}\\(`),
      `${fn} 不再是 ${pure} 的薄壳：暂存语义重回零覆盖状态（修正见 run-slot.ts 的 M11/M12 注释）`,
    )
  }
})

test('接线：closeTab 必须一并清暂存（否则 providerErrors 永久残留）', () => {
  // 第二轮对抗性审查疑点 B：closeTab 只删 runState[session.id]，不删 providerErrors，
  // 关标签时若仍有暂存错误，字典项永久残留（低危内存泄漏）。
  // 缺陷 7 之后清理已统一收进 markSlotClosed → teardownRun，故断言接线而非直接调用。
  const body = functionBody('closeTab')
  assert.match(
    body,
    /markSlotClosed\(session\.id\)/,
    'closeTab 未走 markSlotClosed：暂存错误、看门狗、drain 定时器与 runEpoch 世代都会残留',
  )
  const teardown = functionBody('teardownRun')
  assert.match(teardown, /clearProviderError\(id\)/, 'teardownRun 未清暂存：关标签后 providerErrors 永久残留')
  assert.match(
    functionBody('markSlotClosed'),
    /teardownRun\(id\)/,
    'markSlotClosed 未委托 teardownRun：关标签路径的清理语义断裂',
  )
  // 反向：不得退回"组件里手写删 runState"的老写法（那样又会漏掉看门狗与 drain 定时器）
  assert.doesNotMatch(
    body,
    /constnext=\{\s*\.\.\.runState\s*\}/,
    'closeTab 又变回手写删 runState：这正是缺陷 7（看门狗/定时器/世代三处漏清）的原始形态',
  )
})

test('接线：注释剥离器本身必须有效（防止它被改坏后本文件退化成虚假安全感）', () => {
  const sample = stripComments(
    ['// fakeCall(a)', '/* blockFake(b) */', "const s = 'https://real.example/x' // tail", 'realCall(c)'].join('\n'),
  )
  assert.doesNotMatch(sample, /fakeCall|blockFake/, '行注释/块注释未被剥离：本文件的断言会重新变成子串匹配')
  assert.doesNotMatch(sample, /tail/, '行尾注释未被剥离')
  assert.match(sample, /https:\/\/real\.example\/x/, '字符串字面量被误伤：注释剥离器会吃掉代码')
  assert.match(sample, /realCall\(c\)/, '真实代码被误删')
})
