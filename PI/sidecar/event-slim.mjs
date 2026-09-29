// 流式事件瘦身（纯函数，零 IO、零依赖，可独立单测）
//
// 背景：SDK 的 message_update 每条 delta 都携带**两份全量累积快照**——顶层 `message`
// 与 `assistantMessageEvent.partial`（见 pi-coding-agent dist/core/extensions/types.d.ts
// 的 MessageUpdateEvent，及 pi-ai dist/types.d.ts 的 AssistantMessageEvent）。
// 直接转发会按 delta 条数平方放大。实测（2000 个 text_delta，SDK 真实 usage 形状）：
//   无瘦身层（SDK 原始事件）        20.16 MB
//   改动前内联版（已剥 partial，
//     但顶层 message 仍是全量快照） 10.18 MB   ← 本次改动的真实基线
//   本模块                          0.54 MB   ← 对真实基线降 94.7%，19×
// 参考项目 percho 记录过同源事故：「3 分钟 12.7GB trace / renderer 堆爆」。
//
// SDK 官方的 RPC 出口已用 toJsonEvent 剥掉快照（pi-coding-agent dist/modes/json-event.js，
// rpc-mode.js:266 调用）。该模块未从 package 主入口导出（实测 'toJsonEvent' in m === false），
// 深路径 import 会在 SDK 小版本升级时断裂，故此处按同样语义内联实现。
//
// 第二层：同一份 toolResult 会被**五处**重复携带，是第二大载荷来源
// （percho 实测 504KB×4 ≈ 2MB/次；本项目的第 5 处 agent_end.messages 会累积整个 run）：
//   ① tool_execution_end.result   ② message_start.message   ③ message_end.message
//   ④ turn_end.toolResults[]      ⑤ agent_end.messages[]（累积整个 run，体量最大）
//
// 下游实际消费的字段（务必同步核对后再收窄）：
//   PI/src/App.svelte:1225-1262
//     message_update   → assistantMessageEvent.{type,delta,thinking}
//     tool_execution_* → toolCallId,toolName,args,partialResult,result,isError
//     agent_end        → willRetry（messages 零消费）
//     error            → message（错误文本，注意与 message_update 的 message 同名不同义！）
//     其余             → 只读 type
//   PI/sidecar/lan.mjs:19-23
//     message_update   → 顶层 delta（兼容层，见下）
//
// 第二层只动 content 数组里的 image.data 与超长 text.text。
// **details 一律不动**——理由不是"某些工具要用"，而是 details 的形状由工具/扩展自定义
// 且无上界（SDK 的 edit 工具就声明了不定的 diff/patch），截断它无法判断哪些字段可丢；
// 实测一条 2000 行 diff 的 details 能占该事件 99.9%。
// 文本截断保头 4KB 是安全的：前端 brief() 只取前 220 字符做预览。

/** 单块文本超过该长度 → 截断保头（开头是命令/文件上下文，诊断价值最高） */
const TEXT_TRUNCATE_AT = 16 * 1024
const TEXT_KEEP_HEAD = 4 * 1024
/** 图片 base64 超过该长度 → 换占位符（终端 UI 不发图，下游零消费） */
const IMAGE_DATA_STRIP_AT = 512

let warnHandler = () => {}
/** 注入告警出口（index.mjs 接到 log）。默认 no-op，保证模块在测试中无副作用。 */
export function setWarnHandler(fn) {
  warnHandler = typeof fn === 'function' ? fn : () => {}
}

/** 单块 toolResult 内容瘦身；不认识的块原样返回（引用稳定，避免无谓拷贝）。 */
function slimContentBlock(block) {
  if (!block || typeof block !== 'object') return block
  if (block.type === 'image' && typeof block.data === 'string' && block.data.length > IMAGE_DATA_STRIP_AT) {
    return { ...block, data: `[image data stripped: ${block.data.length}B]` }
  }
  if (block.type === 'text' && typeof block.text === 'string' && block.text.length > TEXT_TRUNCATE_AT) {
    const head = block.text.slice(0, TEXT_KEEP_HEAD)
    return { ...block, text: `${head}\n[tool output truncated: kept ${TEXT_KEEP_HEAD}B of ${block.text.length}B]` }
  }
  return block
}

/**
 * toolResult 载荷瘦身。只动 content 数组里的 image.data 与超长 text.text；
 * **details 一律不动**——其形状由工具/扩展自定义且无上界，无法安全通用截断。
 * 非对象、无 content 数组时原样返回。
 */
export function slimToolResult(result) {
  if (!result || typeof result !== 'object') return result
  const content = result.content
  if (!Array.isArray(content)) return result
  let changed = false
  const next = content.map((block) => {
    const slim = slimContentBlock(block)
    if (slim !== block) changed = true
    return slim
  })
  return changed ? { ...result, content: next } : result
}

/**
 * assistantMessageEvent 瘦身：剥掉 partial 快照。
 * toolcall_start 特殊——它的 partial.content[contentIndex] 是工具名的唯一来源，
 * 必须先提炼成 {id,toolName} 再丢弃 partial（与官方 toJsonEvent 同构）。
 * 官方在此处会 throw；这里降级为只留 type 并告警，避免一个异常打断整条流。
 */
export function slimAssistantMessageEvent(inner) {
  if (!inner || typeof inner !== 'object') return inner
  if (inner.type === 'toolcall_start') {
    const slot = inner.partial?.content?.[inner.contentIndex]
    if (slot?.type === 'toolCall') {
      const { partial: _partial, ...rest } = inner
      return { ...rest, id: slot.id, toolName: slot.name }
    }
    warnHandler('toolcall_start 的 partial 不是 toolCall，已降级为仅保留 type', inner.contentIndex)
    return { type: inner.type, contentIndex: inner.contentIndex }
  }
  if (!('partial' in inner)) return inner
  const { partial: _partial, ...rest } = inner
  return rest
}

/**
 * 事件瘦身总入口。非流式事件原样返回（引用稳定）。
 * 注意：绝不笼统剥除顶层 `message`——`error` 事件的 message 是错误文本，前端要读。
 */
export function summarizeEvent(event) {
  if (!event || typeof event !== 'object') return event

  if (event.type === 'message_update') {
    const inner = slimAssistantMessageEvent(event.assistantMessageEvent)
    const slim = { type: 'message_update', assistantMessageEvent: inner }
    // usage 保留以对齐官方 toJsonEvent 形状。
    // 注意：**当前没有任何消费者**——用量走 session_stats / usage_stats 请求，
    // 而 sessionStats 遍历的是 entry.session.messages 而非事件流（index.mjs:569-601）。
    // 实测 SDK 真实 usage 的 JSON 约 158B，在 delta 场景占瘦身后总量 ~55%（是当前单一最大字段）。
    // 保留是为了形状一致；若未来要删，请先重新核对消费者。
    if (event.message?.usage) slim.usage = event.message.usage
    // 兼容层：旧版前端与 lan.mjs 读顶层 delta/thinking。
    // lan.mjs:23 依赖顶层 delta（局域网观察页实时文本）；App.svelte:1240 读 delta/thinking。
    // 注意：不再设顶层 text —— 全仓零消费者（App.svelte:1229 读的是 assistantEvent.text，
    // 而 inner 只被剥 partial、其余字段原样保留），且 text_end/thinking_end 的 inner.content
    // 是全量内容，复制一份会让该类事件体量翻倍。
    // SDK 的 thinking_delta 只带 delta，故按 type 分流，让顶层 thinking 真正可用。
    if (typeof inner?.delta === 'string') {
      slim.delta = inner.delta
      if (String(inner.type || '').startsWith('thinking')) slim.thinking = inner.delta
    }
    return slim
  }

  if (event.type === 'tool_execution_end') {
    return {
      type: event.type,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
      result: slimToolResult(event.result),
      isError: event.isError,
    }
  }

  if (event.type === 'tool_execution_start' || event.type === 'tool_execution_update') {
    return {
      type: event.type,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
      partialResult: slimToolResult(event.partialResult),
      result: slimToolResult(event.result),
      isError: event.isError,
    }
  }

  // 同一份 toolResult 的四份冗余载体之二、之三
  if (event.type === 'message_start' || event.type === 'message_end') {
    if (event.message?.role !== 'toolResult') return event
    const message = slimToolResult(event.message)
    return message === event.message ? event : { ...event, message }
  }

  // 之四：turn_end 的 toolResults 数组（turn_end.message 是 assistant 终态，不动）
  if (event.type === 'turn_end') {
    if (!Array.isArray(event.toolResults)) return event
    let changed = false
    const toolResults = event.toolResults.map((item) => {
      const slim = slimToolResult(item)
      if (slim !== item) changed = true
      return slim
    })
    return changed ? { ...event, toolResults } : event
  }

  // 之五：agent_end.messages 累积了**整个 run** 的全部消息（含每个 toolResult），
  // 是体量最大的一份载体——一次读 20 张图可达单行 20MB，经 lib.rs 逐行 JSON.parse 跨 IPC。
  // 前端对 agent_end 只读 willRetry（App.svelte:1255-1258），messages 零消费，故可安全瘦身。
  // 注意：只碰 role === 'toolResult' 的项，assistant/user 终态一律不动。
  if (event.type === 'agent_end') {
    if (!Array.isArray(event.messages)) return event
    let changed = false
    const messages = event.messages.map((item) => {
      if (item?.role !== 'toolResult') return item
      const slim = slimToolResult(item)
      if (slim !== item) changed = true
      return slim
    })
    return changed ? { ...event, messages } : event
  }

  return event
}
