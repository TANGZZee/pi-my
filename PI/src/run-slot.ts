// 运行槽（RunSlot）纯逻辑（0-5 第二步抽取）
//
// 抽取范围：不触碰组件状态、不依赖 Svelte 响应式的部分 ——
// 时间线构建、过程步骤归约、历史映射。副作用（patchSlot/看门狗）仍留在组件里。
//
// 抽取动机：这些逻辑决定用户看到的"思考/工具/回复"时间线，此前内嵌在
// App.svelte（2700+ 行）中无法测试。

export type RunPhase = 'idle' | 'thinking' | 'working' | 'writing' | 'waiting'

export interface ProcessStep {
  id: string
  kind: 'think' | 'tool'
  title: string
  body: string
  done: boolean
}

export interface TimelineMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  at: string
  timestamp: number
  userIndex: number
  entryId?: string
}

/** 把任意值缩略为 ≤maxLen 的展示文本（工具步骤预览用）。 */
export function brief(value: unknown, maxLen = 220): string {
  if (value == null) return ''
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text
}

/** 把所有未完成的步骤标记为完成（新事件到来时收束前一步）。 */
export function closeOpenSteps(steps: ProcessStep[]): ProcessStep[] {
  return steps.map((step) => (step.done ? step : { ...step, done: true }))
}

/**
 * 追加思考文本。
 * - 若最后一步是"等待思考"占位（id=waiting-think）→ 替换其内容
 * - 若最后一步是未完成的思考 → 续写
 * - 否则新开一个思考步骤
 */
export function appendThinkToSteps(steps: ProcessStep[], text: string, seq: number): ProcessStep[] {
  const next = [...steps]
  const last = next[next.length - 1]
  if (last?.id === 'waiting-think') {
    next[next.length - 1] = { ...last, body: text }
  } else if (last?.kind === 'think' && !last.done) {
    next[next.length - 1] = { ...last, body: last.body + text }
  } else {
    next.push({ id: `think-${seq}`, kind: 'think', title: '思考', body: text, done: false })
  }
  return next
}

/** 确保存在一个未完成的思考步骤（进入思考阶段时调用）。 */
export function ensureThinkingStep(steps: ProcessStep[], seq: number): ProcessStep[] {
  const last = steps[steps.length - 1]
  if (last && last.kind === 'think' && !last.done) return steps
  return [...steps, { id: `think-${seq}`, kind: 'think', title: '思考', body: '', done: false }]
}

/**
 * 结束工具步骤：把命中的步骤标记完成，并附上结果摘要。
 * 命中规则：toolCallId 精确匹配；无 id 时退化为"最后一个同名未完成步骤"。
 */
export function endToolStep(
  steps: ProcessStep[],
  toolCallId: string,
  toolName: string,
  result: unknown,
  isError?: boolean,
): ProcessStep[] {
  const extra = brief(result)
  return steps.map((step) => {
    const hit =
      (toolCallId && step.id === toolCallId) ||
      (!toolCallId && step.kind === 'tool' && !step.done && step.title === (toolName || step.title))
    if (!hit) return step
    return { ...step, done: true, body: [step.body, extra].filter(Boolean).join('\n') }
  })
}

/** 时间戳 → HH:mm 展示。 */
export function formatReplyTime(timestamp?: number): string {
  if (!timestamp) return ''
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export interface HistoryEntry {
  id?: string
  role: 'user' | 'assistant'
  text: string
  timestamp?: number
  userIndex?: number
  entryId?: string
}

/**
 * sidecar 历史条目 → 时间线消息。
 * - 过滤空文本与非 user/assistant 角色
 * - id 优先 entryId，其次 id，最后用时间戳+序号兜底
 * - userIndex 用于"撤回重发"定位，缺失时钳到 0
 */
export function historyToTimeline(history: HistoryEntry[] = []): TimelineMessage[] {
  return (history || [])
    .filter((item) => item && (item.role === 'user' || item.role === 'assistant') && String(item.text || '').trim())
    .map((item, index) => {
      const timestamp = Number(item.timestamp) || Date.now()
      return {
        id: item.entryId || item.id || `history-${timestamp}-${index}`,
        role: item.role,
        text: String(item.text),
        timestamp,
        at: formatReplyTime(timestamp),
        userIndex: Math.max(0, Number(item.userIndex) || 0),
        entryId: item.entryId || item.id,
      }
    })
}

/** 从时间线提取"已发送消息"列表（撤回重发面板用）。 */
export function sentFromTimeline(timeline: TimelineMessage[]): Array<{ text: string; at: string }> {
  return timeline.filter((item) => item.role === 'user').map((item) => ({ text: item.text, at: item.at }))
}

/** 时间线里最后一条助手回复（重开会话时恢复"最近回复"区域用）。 */
export function lastAssistantReply(timeline: TimelineMessage[]): TimelineMessage | undefined {
  return [...timeline].reverse().find((item) => item.role === 'assistant')
}

/** live 阶段标签（事件归约用）：无内容返回空串表示不显示。 */
export function liveLabel(slot: {
  running?: boolean
  confirm?: unknown
  phase?: RunPhase
}): string {
  if (!slot.running) return ''
  if (slot.confirm || slot.phase === 'waiting') return 'Waiting'
  if (slot.phase === 'thinking') return 'Thinking'
  if (slot.phase === 'writing') return 'Writing'
  if (slot.phase === 'working') return 'Working'
  return ''
}

/** "过程"卡片摘要：N 思考 · M 工具。 */
export function processSummary(process: ProcessStep[], showThinking = true): string {
  const visible = showThinking ? process : process.filter((step) => step.kind !== 'think')
  const thinks = visible.filter((step) => step.kind === 'think').length
  const tools = visible.filter((step) => step.kind === 'tool').length
  const parts: string[] = []
  if (thinks) parts.push(`思考 ${thinks}`)
  if (tools) parts.push(`工具 ${tools}`)
  return parts.length ? `过程 · ${parts.join(' · ')}` : '过程'
}
