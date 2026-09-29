// 运行槽纯逻辑单测（0-5 第二步抽取自 App.svelte）
//
// 这些逻辑决定用户看到的"思考/工具/回复"时间线。旧实现内嵌在 2700 行组件里
// 无法测试；抽取后第一次可验证。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  appendThinkToSteps,
  brief,
  closeOpenSteps,
  endToolStep,
  ensureThinkingStep,
  historyToTimeline,
  lastAssistantReply,
  liveLabel,
  processSummary,
  sentFromTimeline,
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
