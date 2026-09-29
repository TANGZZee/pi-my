// P0-A 事件瘦身单测（node --test，零依赖）
//
// 核心断言两条：
//   1. 形状——瘦身后不含 partial / 顶层全量 message，且下游消费的字段一个不少
//   2. 体量——N 个 delta 的总字节数随 N **线性**增长（回归前是平方）
import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizeEvent, slimToolResult, setWarnHandler } from '../sidecar/event-slim.mjs'

/** 构造一个"到目前为止的完整 assistant 消息"快照，模拟 SDK 的累积语义 */
function partialMessage(textLength) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'x'.repeat(textLength) }],
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
  }
}

function textDeltaEvent(accumulated) {
  return {
    type: 'message_update',
    message: partialMessage(accumulated),
    assistantMessageEvent: {
      type: 'text_delta',
      contentIndex: 0,
      delta: 'xxxx',
      partial: partialMessage(accumulated),
    },
  }
}

test('message_update：剥掉 partial 与顶层全量 message', () => {
  const slim = summarizeEvent(textDeltaEvent(5000))
  assert.equal(slim.type, 'message_update')
  assert.equal('message' in slim, false, '顶层 message 必须被剥除（它是第二份全量快照）')
  assert.equal('partial' in slim.assistantMessageEvent, false, 'partial 必须被剥除')
  assert.equal(slim.assistantMessageEvent.type, 'text_delta')
  assert.equal(slim.assistantMessageEvent.delta, 'xxxx')
  assert.equal(slim.delta, 'xxxx', '兼容层：顶层 delta 必须保留（lan.mjs:23 依赖）')
})

test('message_update：保留 usage（恒定大小，用量统计需要）', () => {
  const slim = summarizeEvent(textDeltaEvent(100))
  assert.deepEqual(slim.usage, { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 })
})

test('message_update：thinking_delta 走同一路径', () => {
  const event = {
    type: 'message_update',
    message: partialMessage(2000),
    assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: '想…', partial: partialMessage(2000) },
  }
  const slim = summarizeEvent(event)
  assert.equal(slim.assistantMessageEvent.type, 'thinking_delta')
  assert.equal(slim.assistantMessageEvent.delta, '想…')
  assert.equal(slim.thinking, '想…', '兼容层：顶层 thinking 必须保留')
  assert.equal('partial' in slim.assistantMessageEvent, false)
})

test('toolcall_start：partial 提炼为 {id,toolName} 后再剥除（工具名唯一来源）', () => {
  const event = {
    type: 'message_update',
    message: partialMessage(100),
    assistantMessageEvent: {
      type: 'toolcall_start',
      contentIndex: 0,
      partial: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' }],
      },
    },
  }
  const slim = summarizeEvent(event)
  const inner = slim.assistantMessageEvent
  assert.equal(inner.type, 'toolcall_start')
  assert.equal(inner.id, 'call_1')
  assert.equal(inner.toolName, 'bash')
  assert.equal('partial' in inner, false)
})

test('toolcall_start：partial 形状异常时降级而非抛错（不打断整条流）', () => {
  const event = {
    type: 'message_update',
    message: partialMessage(100),
    assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, partial: { content: [{}] } },
  }
  const slim = summarizeEvent(event)
  assert.equal(slim.assistantMessageEvent.type, 'toolcall_start')
  assert.equal('partial' in slim.assistantMessageEvent, false)
})

test('toolcall_end：保留 toolCall（id+name+arguments）', () => {
  const event = {
    type: 'message_update',
    message: partialMessage(100),
    assistantMessageEvent: {
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall: { id: 'call_2', name: 'read', arguments: '{}' },
      partial: partialMessage(100),
    },
  }
  const slim = summarizeEvent(event)
  assert.deepEqual(slim.assistantMessageEvent.toolCall, { id: 'call_2', name: 'read', arguments: '{}' })
  assert.equal('partial' in slim.assistantMessageEvent, false)
})

test('线性体量：N 个 delta 的总字节数随 N 线性增长（回归前为平方）', () => {
  const N = 500
  let total = 0
  for (let i = 0; i < N; i++) {
    // 累积长度随 i 线性增长 —— 正是触发平方放大的形状
    total += JSON.stringify(summarizeEvent(textDeltaEvent(4 * (i + 1)))).length
  }

  // 真正的不变量：单事件体量必须与"累积长度"无关。
  // 不用绝对字节阈值——那会随着 SDK 给 usage 增加字段而误报（实测 SDK 真实 usage
  // 含 cost 子对象时单事件可达 285B，逼近硬编码 300B 的余量只剩 5%）。
  const short = JSON.stringify(summarizeEvent(textDeltaEvent(4))).length
  const long = JSON.stringify(summarizeEvent(textDeltaEvent(20000))).length
  assert.equal(short, long, `事件体量随累积长度变化：${short}B vs ${long}B，说明仍携带累积载荷`)

  // 与"未瘦身"对照：必须显著更小
  let raw = 0
  for (let i = 0; i < N; i++) raw += JSON.stringify(textDeltaEvent(4 * (i + 1))).length
  assert.ok(total * 5 < raw, `瘦身收益不足：瘦身后 ${total}B vs 原始 ${raw}B`)
})

test('输入不可变：瘦身绝不就地改写 SDK 事件（否则会污染会话持久化）', () => {
  // SDK 在 _emit() 之后才用 event.message 做持久化，就地改写会污染会话历史。
  const events = [
    textDeltaEvent(5000),
    { type: 'message_start', message: { role: 'toolResult', content: [{ type: 'image', data: 'z'.repeat(2000) }] } },
    { type: 'message_end', message: { role: 'toolResult', content: [{ type: 'text', text: 'y'.repeat(20 * 1024) }] } },
    { type: 'turn_end', message: { role: 'assistant', content: [] }, toolResults: [{ content: [{ type: 'image', data: 'z'.repeat(2000) }] }] },
    { type: 'agent_end', willRetry: true, messages: [{ role: 'toolResult', content: [{ type: 'image', data: 'z'.repeat(2000) }] }] },
    { type: 'tool_execution_end', toolCallId: 'c', result: { content: [{ type: 'image', data: 'z'.repeat(2000) }], details: { a: 1 } } },
  ]
  for (const event of events) {
    const snapshot = JSON.stringify(event)
    summarizeEvent(event)
    assert.equal(JSON.stringify(event), snapshot, `${event.type} 的输入被就地改写了`)
  }
})

test('text_end / thinking_end：inner.content 保留，且不再复制到顶层（避免体量翻倍）', () => {
  const content = 'z'.repeat(30 * 1024)
  for (const type of ['text_end', 'thinking_end']) {
    const event = {
      type: 'message_update',
      message: partialMessage(100),
      assistantMessageEvent: { type, contentIndex: 0, content, partial: partialMessage(content.length) },
    }
    const slim = summarizeEvent(event)
    assert.equal(slim.assistantMessageEvent.content, content, 'inner.content 必须保留（权威终态）')
    assert.equal('text' in slim, false, `顶层 text 是死载荷（零消费者），不应出现：${type}`)
    assert.equal('partial' in slim.assistantMessageEvent, false)
  }
})

test('toolcall_start 降级分支保留 contentIndex（前端定位降级事件需要）', () => {
  const event = {
    type: 'message_update',
    message: partialMessage(100),
    assistantMessageEvent: { type: 'toolcall_start', contentIndex: 3, partial: { content: [{}] } },
  }
  const slim = summarizeEvent(event)
  assert.equal(slim.assistantMessageEvent.type, 'toolcall_start')
  assert.equal(slim.assistantMessageEvent.contentIndex, 3, '降级时不得丢掉 contentIndex')
  assert.equal('partial' in slim.assistantMessageEvent, false)
})

test('setWarnHandler：降级路径必须触发告警（接线不可静默失效）', () => {
  const captured = []
  setWarnHandler((...args) => captured.push(args))
  try {
    summarizeEvent({
      type: 'message_update',
      message: partialMessage(100),
      assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, partial: { content: [{}] } },
    })
  } finally {
    setWarnHandler(() => {}) // 还原，避免影响其他测试
  }
  assert.equal(captured.length, 1, 'toolcall_start 降级必须告警一次')
})

test('tool_execution_end：剥掉 result 里的图片 base64 与超长文本', () => {
  const huge = 'y'.repeat(20 * 1024)
  const event = {
    type: 'tool_execution_end',
    toolCallId: 'c1',
    toolName: 'read',
    result: {
      content: [
        { type: 'image', data: 'z'.repeat(1000) },
        { type: 'text', text: huge },
      ],
      details: { todos: [{ id: 1 }], paths: ['a.png'] },
    },
    isError: false,
  }
  const slim = summarizeEvent(event)
  assert.match(slim.result.content[0].data, /^\[image data stripped: 1000B\]$/)
  assert.ok(slim.result.content[1].text.length < 5 * 1024)
  assert.match(slim.result.content[1].text, /tool output truncated/)
  // details 是 UI 数据源，绝不能动
  assert.deepEqual(slim.result.details, { todos: [{ id: 1 }], paths: ['a.png'] })
  assert.equal(slim.toolCallId, 'c1')
  assert.equal(slim.toolName, 'read')
  assert.equal(slim.isError, false)
})

test('小结果的 toolResult 引用稳定（不做无谓拷贝）', () => {
  const result = { content: [{ type: 'text', text: 'ok' }], details: { a: 1 } }
  assert.equal(slimToolResult(result), result)
})

test('error 事件的 message 必须保留（与 message_update 的 message 同名不同义）', () => {
  const slim = summarizeEvent({ type: 'error', message: '模型超过 3 分钟没有返回' })
  assert.equal(slim.message, '模型超过 3 分钟没有返回')
})

test('message_start/end 只在 role=toolResult 时瘦身，assistant 终态不动', () => {
  const assistant = { type: 'message_start', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(50 * 1024) }] } }
  assert.equal(summarizeEvent(assistant), assistant, 'assistant 终态是权威数据源，不得截断')

  const toolResult = { type: 'message_end', message: { role: 'toolResult', content: [{ type: 'image', data: 'z'.repeat(2000) }] } }
  const slim = summarizeEvent(toolResult)
  assert.match(slim.message.content[0].data, /stripped/)
})

test('turn_end：只瘦身 toolResults 数组，不动 assistant 终态 message', () => {
  const message = { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(50 * 1024) }] }
  const slim = summarizeEvent({
    type: 'turn_end',
    message,
    toolResults: [{ content: [{ type: 'image', data: 'z'.repeat(2000) }] }],
  })
  assert.equal(slim.message, message, 'assistant 终态必须原样保留')
  assert.match(slim.toolResults[0].content[0].data, /stripped/)
})

test('其他事件原样返回（引用稳定）', () => {
  for (const event of [
    { type: 'agent_start' },
    { type: 'agent_settled' },
    { type: 'turn_start' },
    { type: 'custom_thing', payload: 1 },
  ]) {
    assert.equal(summarizeEvent(event), event, `${event.type} 不应被拷贝`)
  }
  assert.equal(summarizeEvent(null), null)
  assert.equal(summarizeEvent(undefined), undefined)
})

test('agent_end：保留 willRetry，且只瘦身 role=toolResult 的项', () => {
  const assistant = { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(50 * 1024) }] }
  const event = {
    type: 'agent_end',
    willRetry: true,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      assistant,
      { role: 'toolResult', content: [{ type: 'image', data: 'z'.repeat(2000) }], details: { paths: ['a.png'] } },
    ],
  }
  const slim = summarizeEvent(event)
  assert.equal(slim.willRetry, true, '前端 App.svelte:1257 依赖 willRetry')
  assert.equal(slim.messages[0], event.messages[0], 'user 消息不应被碰')
  assert.equal(slim.messages[1], assistant, 'assistant 终态不得截断')
  assert.match(slim.messages[2].content[0].data, /stripped/)
  assert.deepEqual(slim.messages[2].details, { paths: ['a.png'] }, 'details 是 UI 数据源，不得动')
})

test('agent_end：无 toolResult 时引用稳定（不拷贝）', () => {
  const event = { type: 'agent_end', willRetry: false, messages: [{ role: 'user', content: [{ type: 'text', text: 'ok' }] }] }
  assert.equal(summarizeEvent(event), event)
})

test('agent_end：累积整个 run 的大 toolResult 被压掉（第 5 份载体）', () => {
  // 模拟一次 run 里读了 20 张 1MB 图：未处理时单行 NDJSON 可达 ~20MB
  const big = { role: 'toolResult', content: [{ type: 'image', data: 'z'.repeat(1024 * 1024) }] }
  const event = { type: 'agent_end', willRetry: false, messages: Array.from({ length: 20 }, () => big) }
  const before = JSON.stringify(event).length
  const after = JSON.stringify(summarizeEvent(event)).length
  assert.ok(after < before / 100, `瘦身不足：${after}B vs ${before}B`)
})
