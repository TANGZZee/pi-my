// 运行槽纯逻辑单测（0-5 第二步抽取自 App.svelte）
//
// 这些逻辑决定用户看到的"思考/工具/回复"时间线。旧实现内嵌在 2700 行组件里
// 无法测试；抽取后第一次可验证。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  appendThinkToSteps,
  assistantErrorFrom,
  brief,
  closeOpenSteps,
  describeProviderError,
  endToolStep,
  ensureThinkingStep,
  historyToTimeline,
  isCancellationText,
  lastAssistantReply,
  liveLabel,
  mergeHistoryIntoTimeline,
  processSummary,
  removeProviderError,
  sentFromTimeline,
  stashProviderError,
  takeProviderError,
} from '../src/run-slot.ts'

const step = (over = {}) => ({ id: 's', kind: 'tool', title: 'bash', body: '', done: false, ...over })

test('brief：截断超长值并保留类型', () => {
  assert.equal(brief(null), '')
  assert.equal(brief(undefined), '')
  assert.equal(brief('ok'), 'ok')
  assert.equal(brief('x'.repeat(300)).length, 221, '220 字符 + 省略号')
  assert.ok(brief({ a: 1 }).includes('"a"'), '对象应 JSON 序列化')
})

test('closeOpenSteps：未完成的标记完成，已完成的不动', () => {
  const steps = [step({ done: true }), step({ id: 'b', done: false }), step({ id: 'c', done: false })]
  const next = closeOpenSteps(steps)
  assert.equal(next.filter((s) => s.done).length, 3)
  assert.equal(next[0], steps[0], '已完成的引用不变')
  assert.notEqual(next[1], steps[1], '未完成的应生成新对象')
})

test('appendThinkToSteps：三种分支（占位替换/续写/新开）', () => {
  // 占位：waiting-think → 替换 body
  const placeholder = [{ id: 'waiting-think', kind: 'think', title: '思考', body: '等待中…', done: false }]
  const r1 = appendThinkToSteps(placeholder, '真实思考', 1)
  assert.equal(r1.length, 1)
  assert.equal(r1[0].body, '真实思考')
  // 续写：最后一步是未完成思考
  const thinking = [step({ id: 't', kind: 'think', title: '思考', body: '前半', done: false })]
  const r2 = appendThinkToSteps(thinking, '后半', 2)
  assert.equal(r2[0].body, '前半后半')
  assert.equal(r2.length, 1, '续写不新开步骤')
  // 新开：最后一步是工具
  const toolLast = [step({ id: 'tool-1', done: true })]
  const r3 = appendThinkToSteps(toolLast, '新思考', 3)
  assert.equal(r3.length, 2)
  assert.equal(r3[1].id, 'think-3')
})

test('appendThinkToSteps：不修改入参（组件可能持有旧引用）', () => {
  const input = [step({ id: 'tool-1' })]
  appendThinkToSteps(input, 'x', 1)
  assert.equal(input.length, 1)
})

test('ensureThinkingStep：已有未完成思考时幂等', () => {
  const steps = [{ id: 't', kind: 'think', title: '思考', body: '', done: false }]
  assert.equal(ensureThinkingStep(steps, 9), steps, '已存在就不新开')
  assert.deepEqual(ensureThinkingStep([], 1).length, 1, '空时新开')
  assert.deepEqual(ensureThinkingStep([step({ done: true })], 1).length, 2, '已完成则新开')
})

test('endToolStep：按 toolCallId 精确匹配，附加结果摘要', () => {
  const steps = [step({ id: 'call-1', body: '正在执行' }), step({ id: 'call-2' })]
  const next = endToolStep(steps, 'call-1', 'bash', '结果文本', false)
  assert.equal(next[0].done, true)
  assert.ok(next[0].body.includes('正在执行'))
  assert.ok(next[0].body.includes('结果文本'))
  assert.equal(next[1].done, false, '未命中的不动')
})

test('endToolStep：无 toolCallId 时退化为"最后一个同名未完成步骤"', () => {
  const steps = [step({ id: 'a', title: 'bash', done: true }), step({ id: 'b', title: 'bash', done: false })]
  const next = endToolStep(steps, '', 'bash', 'ok', false)
  assert.equal(next[0].done, true, '已完成的保持')
  assert.equal(next[1].done, true, '命中的是未完成的那个')
})

test('historyToTimeline：过滤空文本与非对话角色', () => {
  const timeline = historyToTimeline([
    { id: '1', role: 'user', text: '你好' },
    { id: '2', role: 'toolResult', text: 'xx' },
    { id: '3', role: 'assistant', text: '   ' }, // 空白 → 过滤
    { id: '4', role: 'assistant', text: '回复' },
  ])
  assert.equal(timeline.length, 2)
  assert.deepEqual(timeline.map((m) => m.role), ['user', 'assistant'])
})

test('historyToTimeline：id 优先 entryId，缺失时用时间戳+序号兜底（且同批内稳定）', () => {
  const timeline = historyToTimeline([
    { role: 'user', text: 'a', entryId: 'e1' },
    { role: 'assistant', text: 'b' },
  ])
  assert.equal(timeline[0].id, 'e1')
  assert.match(timeline[1].id, /^history-/)
  // 同一批内兜底 id 不重复
  assert.notEqual(timeline[0].id, timeline[1].id)
})

test('historyToTimeline：userIndex 缺失/负数钳到 0', () => {
  const timeline = historyToTimeline([
    { role: 'user', text: 'a', userIndex: -3 },
    { role: 'assistant', text: 'b', userIndex: 7 },
  ])
  assert.equal(timeline[0].userIndex, 0)
  assert.equal(timeline[1].userIndex, 7)
})

test('historyToTimeline：undefined 入参安全', () => {
  assert.deepEqual(historyToTimeline(undefined), [])
  assert.deepEqual(historyToTimeline(null ), [])
})

test('sentFromTimeline：只取 user 消息', () => {
  const timeline = historyToTimeline([
    { id: '1', role: 'user', text: 'q1', timestamp: 1700000000000 },
    { id: '2', role: 'assistant', text: 'a1', timestamp: 1700000001000 },
    { id: '3', role: 'user', text: 'q2', timestamp: 1700000002000 },
  ])
  assert.deepEqual(sentFromTimeline(timeline).map((m) => m.text), ['q1', 'q2'])
})

test('lastAssistantReply：取最后一条助手回复', () => {
  const timeline = historyToTimeline([
    { id: '1', role: 'user', text: 'q', timestamp: 1700000000000 },
    { id: '2', role: 'assistant', text: '第一版', timestamp: 1700000001000 },
    { id: '3', role: 'assistant', text: '第二版', timestamp: 1700000002000 },
  ])
  assert.equal(lastAssistantReply(timeline)?.text, '第二版')
  assert.equal(lastAssistantReply([]), undefined)
})

// ── 缺陷 10（外部审计 P2）：迟到磁盘历史合并 ───────────────────────────
// 场景：会话正在运行（或 dispatchTurn 已置 historyLoaded:true）时点开它，
// applySessionHistory 早退把磁盘历史丢掉，此后没有任何重试点 →
// 用户看到"打开有历史的会话，transcript 只有当前这一轮"。
// 修法不是"覆盖"而是"合并"：历史在前、现有在后、按 id 去重。

test('缺陷10：合并后历史在前、现有条目在后（顺序即时间顺序）', () => {
  const existing = historyToTimeline([{ id: 'now-1', role: 'user', text: '当前这轮', timestamp: 1700000009000 }])
  const merged = mergeHistoryIntoTimeline(
    [
      { id: 'old-1', role: 'user', text: '很久以前', timestamp: 1700000000000 },
      { id: 'old-2', role: 'assistant', text: '那时的回答', timestamp: 1700000001000 },
    ],
    existing,
  )
  assert.deepEqual(merged.map((m) => m.text), ['很久以前', '那时的回答', '当前这轮'])
})

test('缺陷10：正在流式输出的现有时间线绝不被覆盖（合并的核心约束）', () => {
  const streaming = historyToTimeline([
    { id: 'u-new', role: 'user', text: '新问题', timestamp: 1700000009000 },
    { id: 'a-new', role: 'assistant', text: '写了一半的回复', timestamp: 1700000009500 },
  ])
  const merged = mergeHistoryIntoTimeline(
    [{ id: 'a-old', role: 'assistant', text: '旧回答', timestamp: 1700000000000 }],
    streaming,
  )
  assert.equal(merged[merged.length - 1].text, '写了一半的回复', '当前回复必须留在最后（未被覆盖）')
  assert.equal(merged.length, 3)
})

test('缺陷10：同 id 条目去重，不得重复插入', () => {
  const shared = [
    { id: 'only-old', role: 'assistant', text: '只在历史里', timestamp: 1700000000500 },
    { id: 'dup', role: 'user', text: '同一轮', timestamp: 1700000000000 + 1000 },
  ]
  const existing = historyToTimeline([{ id: 'dup', role: 'user', text: '同一轮', timestamp: 1700000001000 }])
  const merged = mergeHistoryIntoTimeline(shared, existing)
  assert.equal(merged.filter((m) => m.id === 'dup').length, 1, '同 id 只能出现一次')
  assert.deepEqual(merged.map((m) => m.text), ['只在历史里', '同一轮'])
})

// ── 缺陷12（外部审计 P1）：撤回重发后，迟到的磁盘历史不得把删掉的消息复活 ──
// 时间线是对话的**后缀**，磁盘历史里比它更靠后的条目 = 用户刚撤回删掉的。
// 早期实现无条件把"历史中时间线没有的条目"全部前置，于是
//   history h1 h2 h3 h4 → 时间线 h1 h2（对 userIndex=1 撤回）→ 再次加载 →
//   h3 h4 h1 h2：被删的两条复活，还排到了最前面（时间戳 1002、1003 跑到 1000 之前）。

const recalledConversation = [
  { id: 'h1', role: 'user', text: 'q1', timestamp: 1000, userIndex: 0 },
  { id: 'h2', role: 'assistant', text: 'a1', timestamp: 1001 },
  { id: 'h3', role: 'user', text: 'q2', timestamp: 1002, userIndex: 1 },
  { id: 'h4', role: 'assistant', text: 'a2', timestamp: 1003 },
]

test('缺陷12：撤回后重新加载历史，被删掉的尾部条目不得复活', () => {
  const timeline = historyToTimeline(recalledConversation.slice(0, 2))
  const merged = mergeHistoryIntoTimeline(recalledConversation, timeline)
  assert.deepEqual(
    merged.map((m) => m.text),
    ['q1', 'a1'],
    '撤回删掉的 q2/a2 又被合并回来了（外部审计缺陷 12/13 原症状）',
  )
})

test('缺陷12：磁盘历史单调时（sidecar 保证的前提），合并结果的时间戳必须单调不减', () => {
  // 第三轮外部审计 D5：旧版用 `slice(0, 2)` 当时间线 ⇒ `headAt = 0` ⇒ `older = []` ⇒
  // `missing` 为空 ⇒ 第 184 行提前返回时间线本身，这条"单调性"断言其实什么都没测
  // （把实现里的 slice 反转成非单调，它也照样通过）。改成"时间线只覆盖历史尾部"的
  // 夹具：此时历史的前半段会**真的被插到前面**，单调性才有内容。
  const timeline = historyToTimeline(recalledConversation.slice(2, 4)) // h3, h4
  const merged = mergeHistoryIntoTimeline(recalledConversation, timeline)
  assert.equal(merged.length, 4, '夹具必须让历史条目真的被合并进来，否则单调性断言是空转（D5）')
  assert.deepEqual(merged.map((m) => m.id), ['h1', 'h2', 'h3', 'h4'])
  const times = merged.map((m) => m.timestamp)
  for (let i = 1; i < times.length; i += 1) {
    assert.ok(times[i] >= times[i - 1], `时间戳在第 ${i} 项倒退：${times[i - 1]} → ${times[i]}`)
  }
})

test('缺陷12：时间线只覆盖历史中段时，只有它之前的条目被补回', () => {
  const timeline = historyToTimeline(recalledConversation.slice(2, 3)) // 只剩 h3
  const merged = mergeHistoryIntoTimeline(recalledConversation, timeline)
  assert.deepEqual(merged.map((m) => m.text), ['q1', 'a1', 'q2'], 'h3 之前的 h1/h2 应补回；h4 在它之后不得插入')
})

test('缺陷12：时间线首条不在历史里（刚派发的那一轮尚未落盘）时按时间戳补历史', () => {
  const timeline = historyToTimeline([{ id: 'user-turn-9', role: 'user', text: '刚发的问题', timestamp: 2000, userIndex: 0 }])
  const merged = mergeHistoryIntoTimeline(recalledConversation, timeline)
  assert.deepEqual(
    merged.map((m) => m.text),
    ['q1', 'a1', 'q2', 'a2', '刚发的问题'],
    '历史全部早于当前轮，应整体补在前面',
  )
})

test('缺陷12：撤回后再次合并是幂等的（反复开关不会越并越乱）', () => {
  const timeline = historyToTimeline(recalledConversation.slice(0, 2))
  const once = mergeHistoryIntoTimeline(recalledConversation, timeline)
  const twice = mergeHistoryIntoTimeline(recalledConversation, once)
  assert.deepEqual(twice.map((m) => m.text), once.map((m) => m.text))
})

test('缺陷10：历史为空时原样返回现有引用（避免无意义重渲）', () => {
  const existing = historyToTimeline([{ id: 'a', role: 'assistant', text: 'x', timestamp: 1 }])
  assert.equal(mergeHistoryIntoTimeline([], existing), existing)
  assert.equal(mergeHistoryIntoTimeline(undefined, existing), existing)
})

test('缺陷10：全部历史都已存在时同样返回原引用（重启重绑重复读盘的情形）', () => {
  const history = [{ id: 'a', role: 'user', text: 'x', timestamp: 1700000000000 }]
  const existing = historyToTimeline(history)
  assert.equal(mergeHistoryIntoTimeline(history, existing), existing)
})

test('缺陷10：两边都空时安全', () => {
  assert.deepEqual(mergeHistoryIntoTimeline([], []), [])
  assert.deepEqual(mergeHistoryIntoTimeline(undefined, undefined), [])
})

test('缺陷10：历史里的 userIndex 沿用 historyToTimeline 的钳位（撤回重发仍可定位）', () => {
  const merged = mergeHistoryIntoTimeline(
    [
      { id: 'u1', role: 'user', text: 'q1', timestamp: 1700000000000, userIndex: 0 },
      { id: 'u2', role: 'user', text: 'q2', timestamp: 1700000001000, userIndex: 1 },
    ],
    [],
  )
  assert.deepEqual(sentFromTimeline(merged).map((m) => m.text), ['q1', 'q2'])
})

// ── 第二轮外部审计 probe-A-merge.mjs 的四处边界 ─────────────────────────
// 其中 A3 是**真问题**（会让被撤回删掉的消息复活，与缺陷 12 的修复目标直接矛盾），
// A4 会产生重复的 Svelte key；A1/A2 是"依赖未写明的隐含前提"，用测试固化当前行为。

test('缺陷10（A3）：时间线首条时间戳非有限值时，不得无条件前置全部历史', () => {
  // 诚实标注可达性：当前**没有**一条真实路径能造出这种时间线 —— `historyToTimeline` 用
  // `Number(item.timestamp) || Date.now()` 兜底（NaN/缺失都会被换成当前时间），
  // dispatchTurn 写的是 `Date.now()`，finishRun 写的是 `replyAt || Date.now()`。
  // 因此这里的字面量构造是**防御性**的：只要有人在别处新建 timeline 条目（例如将来的
  // 会话导入、时间戳可选的新事件源），旧实现的 `: fromHistory` 分支就会把整段历史
  // 无条件前置，让撤回删掉的消息复活。断言锁的是"无法判定先后时必须保守"。
  const timeline = [{ id: 'mine', role: 'user', text: '新消息', timestamp: Number.NaN, userIndex: 0 }]
  const merged = mergeHistoryIntoTimeline(recalledConversation, timeline)
  assert.deepEqual(
    merged.map((m) => m.text),
    ['新消息'],
    '无法判定先后时把整段历史前置了：被撤回删掉的 q2/a2 会复活并排到最前面（缺陷 12 的二次伤害）',
  )
  const undef = mergeHistoryIntoTimeline(recalledConversation, [
    { id: 'mine', role: 'user', text: '新消息', timestamp: undefined },
  ])
  assert.deepEqual(undef.map((m) => m.text), ['新消息'], 'timestamp 缺失时同样必须保守放弃合并')
})

test('缺陷10（A4）：历史内部重复 id 只能保留一条（timeline 以 message.id 为 key）', () => {
  const dupHistory = [
    { id: 'h1', role: 'user', text: 'q1', timestamp: 1000, userIndex: 0 },
    { id: 'h1', role: 'user', text: 'q1(重复)', timestamp: 1001, userIndex: 0 },
    { id: 'h2', role: 'assistant', text: 'a1', timestamp: 1002 },
  ]
  const timeline = historyToTimeline([{ id: 'h2', role: 'assistant', text: 'a1', timestamp: 1002 }])
  const merged = mergeHistoryIntoTimeline(dupHistory, timeline)
  const ids = merged.map((m) => m.id)
  assert.equal(new Set(ids).size, ids.length, `合并结果出现重复 id：${ids.join(',')} —— Svelte each 块会因 key 重复错乱`)
  assert.deepEqual(merged.map((m) => m.text), ['q1', 'a1'])
})

test('缺陷10（A1）：历史数组非单调时，只取时间线首条之前的部分（固化：依赖磁盘追加顺序）', () => {
  // 磁盘历史按追加顺序写入 = 时间升序（sidecar 侧保证，见 run-slot.ts 的 A1 说明）。
  // 这里刻意构造**超出前提**的输入，记录实现"不做排序、只按数组位置切分"这一取舍。
  // 第三轮外部审计 D5 指出：上面那条"单调不减"断言与本条的期望值看似矛盾 —— 并不矛盾，
  // 但边界必须写清楚：单调性只对**满足前提的输入**成立（上一条用的是单调夹具），
  // 本条是**前提被违反**时的行为记录，不是"允许输出非单调"的契约。
  // 之所以不按时间戳排序：时间戳相等/缺失时排序不稳定，反而会让撤回删掉的消息复活
  // （缺陷 12 的修复目标）。若将来有人改成排序，这条断言会提醒他重新评估那个取舍。
  const messy = [
    { id: 'h1', role: 'user', text: 'q1', timestamp: 5000, userIndex: 0 },
    { id: 'h2', role: 'assistant', text: 'a1', timestamp: 1001 },
    { id: 'h3', role: 'user', text: 'q2', timestamp: 1002, userIndex: 1 },
  ]
  const timeline = historyToTimeline([{ id: 'h2', role: 'assistant', text: 'a1', timestamp: 1001 }])
  const merged = mergeHistoryIntoTimeline(messy, timeline)
  assert.deepEqual(merged.map((m) => m.id), ['h1', 'h2'], '切分依据是数组位置（findIndex），不是时间戳排序')
})

test('缺陷10：时间线首条不在历史里且时间戳极小 ⇒ 历史被全部过滤（固化 A2）', () => {
  const timeline = historyToTimeline([{ id: 'mine', role: 'user', text: '新消息', timestamp: 1, userIndex: 0 }])
  const merged = mergeHistoryIntoTimeline(recalledConversation, timeline)
  assert.deepEqual(merged.map((m) => m.text), ['新消息'], '真实时间戳来自 Date.now()，不会落在历史之前')
})

test('liveLabel：五种状态映射正确', () => {
  assert.equal(liveLabel({ running: false, phase: 'writing' }), '', '未运行不显示')
  assert.equal(liveLabel({ running: true, confirm: {} }), 'Waiting', '有确认卡优先显示 Waiting')
  assert.equal(liveLabel({ running: true, phase: 'waiting' }), 'Waiting')
  assert.equal(liveLabel({ running: true, phase: 'thinking' }), 'Thinking')
  assert.equal(liveLabel({ running: true, phase: 'writing' }), 'Writing')
  assert.equal(liveLabel({ running: true, phase: 'working' }), 'Working')
  assert.equal(liveLabel({ running: true, phase: 'idle' }), '')
})

test('processSummary：区分统计思考/工具，showThinking=false 时隐藏思考', () => {
  const process = [
    step({ id: 't1', kind: 'think', title: '思考' }),
    step({ id: 't2', kind: 'think', title: '思考' }),
    step({ id: 'b1', kind: 'tool', title: 'bash' }),
  ]
  assert.equal(processSummary(process, true), '过程 · 思考 2 · 工具 1')
  assert.equal(processSummary(process, false), '过程 · 工具 1')
  assert.equal(processSummary([], true), '过程')
})

// ─── provider 错误归因（真实事故：模型 404 时前端没有任何反馈，永久 Thinking）───
// SDK 在 provider 失败时**不抛异常、也不发 type:'error' 事件**，只产出一条
// stopReason:'error' + errorMessage 的 assistant 终态消息，随后照常发 agent_end
// 与 agent_settled（源码：pi-coding-agent/dist/core/agent-session.js:386,772）。
// 前端此前完全不读这两个字段，错误文本被整条丢弃 → 用户只看到思考球一直转。

test('assistantErrorFrom：真实事故消息（404）必须被提取', () => {
  const messages = [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: [], stopReason: 'error', errorMessage: '404 404 page not found\n' },
  ]
  assert.equal(assistantErrorFrom(messages), '404 404 page not found', '去掉尾部换行')
})

test('assistantErrorFrom：数组倒序取最后一条 assistant 终态', () => {
  const messages = [
    { role: 'assistant', content: ['旧'], stopReason: 'error', errorMessage: '第一次失败' },
    { role: 'user', content: '再来' },
    { role: 'assistant', content: ['新'], stopReason: 'error', errorMessage: '第二次失败' },
  ]
  assert.equal(assistantErrorFrom(messages), '第二次失败')
})

test('assistantErrorFrom：stopReason 非 error 一律返回空串（不能误报）', () => {
  // 用户主动中止不该显示"请求失败"
  assert.equal(assistantErrorFrom([{ role: 'assistant', stopReason: 'aborted', errorMessage: 'x' }]), '')
  assert.equal(assistantErrorFrom([{ role: 'assistant', stopReason: 'stop' }]), '')
  assert.equal(assistantErrorFrom([{ role: 'assistant' }]), '')
})

test('assistantErrorFrom：provider 报了错但没给详情 → 兜底文案', () => {
  const result = assistantErrorFrom([{ role: 'assistant', stopReason: 'error', errorMessage: '   ' }])
  assert.equal(result, '模型提供商返回了错误，但没有给出错误详情。')
})

test('assistantErrorFrom：兼容 turn_end.message 单条消息形态', () => {
  assert.equal(
    assistantErrorFrom({ role: 'assistant', stopReason: 'error', errorMessage: 'single 500' }),
    'single 500'
  )
})

test('assistantErrorFrom：空/畸形入参安全（不抛、返回空串）', () => {
  assert.equal(assistantErrorFrom(undefined), '')
  assert.equal(assistantErrorFrom(null), '')
  assert.equal(assistantErrorFrom([]), '')
  assert.equal(assistantErrorFrom([null, 42, 'x']), '')
  assert.equal(assistantErrorFrom([{ role: 'toolResult', stopReason: 'error', errorMessage: 'x' }]), '')
})

test('describeProviderError：真实 404 命中"接口地址不正确"归因', () => {
  const text = describeProviderError('404 404 page not found')
  assert.match(text, /接口地址不正确/)
  assert.match(text, /baseUrl/)
  assert.ok(text.includes('404 404 page not found'), '原始错误文本必须保留，便于用户自查')
})

test('describeProviderError：各 hint 命中', () => {
  assert.match(describeProviderError('401 Unauthorized'), /API Key/)
  assert.match(describeProviderError('invalid api key'), /API Key/)
  assert.match(describeProviderError('429 Too Many Requests'), /限流|额度/)
  assert.match(describeProviderError('insufficient_quota'), /限流|额度/)
  assert.match(describeProviderError('503 Service Unavailable'), /服务端临时故障/)
  assert.match(describeProviderError('fetch failed'), /网络/)
  assert.match(describeProviderError('getaddrinfo ENOTFOUND api.example.com'), /网络/)
})

test('describeProviderError：未识别错误原样透传；空串给兜底', () => {
  assert.equal(describeProviderError('some weird provider failure'), '模型请求失败：some weird provider failure')
  assert.equal(describeProviderError(''), '模型请求失败，且没有返回错误详情。')
  assert.equal(describeProviderError('   '), '模型请求失败，且没有返回错误详情。')
})

test('describeProviderError：正则无全局标志（避免 lastIndex 串位）', () => {
  // 同一文本连续调用必须得到同样结果：若 hint 正则误加 /g，第二次会失配。
  const text = '404 page not found'
  const first = describeProviderError(text)
  const second = describeProviderError(text)
  assert.equal(first, second)
  assert.match(first, /接口地址不正确/)
})

test('isCancellationText：识别 SDK 的主动取消文案（误报修复的承重点）', () => {
  // 真实事故：503 退避期间点 Stop，SDK 发 auto_retry_end{finalError:"Retry cancelled"}，
  // 此前无条件暂存 → 收尾时弹出"请求失败：Retry cancelled"。
  // 源码：pi-coding-agent/dist/core/agent-session.js:2315-2326。
  assert.equal(isCancellationText('Retry cancelled'), true)
  assert.equal(isCancellationText('retry canceled'), true, '美式拼写也要认')
  assert.equal(isCancellationText('  Retry Cancelled.  '), true, '空白与句点应被容忍')
})

test('isCancellationText：真实 provider 故障不得被误判为取消（漏报防护）', () => {
  // 只有整串等于 SDK 固定文案才算取消。含 "cancelled" 的真实网络错误必须照常上报，
  // 否则用户主动中止与网络故障会混为一谈，真错误被静默吞掉。
  assert.equal(isCancellationText('socket hang up (cancelled)'), false)
  assert.equal(isCancellationText('request was cancelled by proxy'), false)
  assert.equal(isCancellationText('503 Service Unavailable'), false)
  assert.equal(isCancellationText('Retry cancelled due to timeout'), false)
  assert.equal(isCancellationText(''), false)
  assert.equal(isCancellationText('   '), false)
})

// ── provider 错误暂存（M11/M12 缺口：此前整套测试对这三个函数体零覆盖）──────────
// 变异实证：把 App.svelte 里的函数体清成 return，61/61 全过。故把语义抽到 run-slot.ts
// 并在此直接单测——暂存是"provider 报错必须有反馈"的语义核心。

test('stashProviderError：写入并保留原始文本（trim 后）', () => {
  const stash = stashProviderError({}, 's1', '  503 Service Unavailable  ')
  assert.equal(stash.s1, '503 Service Unavailable')
})

test('stashProviderError：空串表示清除，而非写入空值（重试成功必须抹掉上一轮错误）', () => {
  const withError = stashProviderError({}, 's1', '404 page not found')
  const cleared = stashProviderError(withError, 's1', '')
  assert.equal(cleared.s1, undefined, '空串必须清掉旧记录')
  assert.equal('s1' in cleared, false)
  assert.equal(stashProviderError(withError, 's1', '   ').s1, undefined, '纯空白同样按清除处理')
})

test('stashProviderError：同文本幂等（返回原引用，避免无意义重渲）', () => {
  const first = stashProviderError({}, 's1', '404 x')
  assert.equal(stashProviderError(first, 's1', '404 x'), first, '同值应返回原引用')
  assert.notEqual(stashProviderError(first, 's1', '500 y'), first, '异值应返回新对象')
})

test('stashProviderError：会话级隔离（一个会话的错误不得串到另一个）', () => {
  const both = stashProviderError(stashProviderError({}, 's1', 'err-1'), 's2', 'err-2')
  assert.equal(both.s1, 'err-1')
  assert.equal(both.s2, 'err-2')
  assert.equal(removeProviderError(both, 's1').s2, 'err-2', '清 s1 不得动 s2')
})

test('removeProviderError：无记录时返回原引用（避免多余状态更新）', () => {
  const stash = { s1: 'e' }
  assert.equal(removeProviderError(stash, 'nope'), stash)
  assert.equal(removeProviderError(stash, 's1').s1, undefined)
  assert.equal(stash.s1, 'e', '不得原地修改传入对象')
})

test('takeProviderError：取走后清空，message 是归因后的中文文案', () => {
  const stash = stashProviderError({}, 's1', '404 page not found')
  const taken = takeProviderError(stash, 's1')
  assert.match(taken.message, /接口地址不正确/, '必须经过 describeProviderError 归因')
  assert.ok(taken.message.includes('404 page not found'), '原始文本必须保留')
  assert.equal(taken.stash.s1, undefined, '取走后必须清空，否则下一次收尾会重复报错')
})

test('takeProviderError：无暂存时返回空串（正常结束/用户中止绝不能报错）', () => {
  const stash = {}
  const taken = takeProviderError(stash, 's1')
  assert.equal(taken.message, '', '没有错误就不得产生任何"请求失败"文案')
  assert.equal(taken.stash, stash, '无变化应返回原引用')
})

test('takeProviderError：连续两次取，第二次必须为空（不得重复弹出同一个错误）', () => {
  const stash = stashProviderError({}, 's1', '503 Service Unavailable')
  const first = takeProviderError(stash, 's1')
  assert.match(first.message, /服务端临时故障/)
  const second = takeProviderError(first.stash, 's1')
  assert.equal(second.message, '', '同一错误只能被消费一次')
})
