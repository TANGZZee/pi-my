// 会话状态快照（1-8 get_state / U4 状态栏面板的数据形状与格式化，纯函数）
//
// get_state 聚合了 SDK 官方 getSessionStats/getContextUsage + Pi-My 的模式/队列/工具集。
// U4 要求展示：会话 Token、缓存用量、上下文容量、费用。

export interface StateTokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

export interface StateSnapshot {
  sessionId: string
  mode: string
  running: boolean
  file?: string
  model?: { provider: string; id: string; name?: string } | null
  thinkingLevel?: string | null
  steering?: string[]
  followUp?: string[]
  stats?: {
    userMessages?: number
    assistantMessages?: number
    toolCalls?: number
    totalMessages?: number
    tokens?: StateTokens
    cost?: number
    contextUsage?: { percent?: number; tokens?: number; window?: number } | null
  }
  /** Pi-My 本地口径（App.svelte 既有 CtxStats 形状） */
  currentContext?: number
  window?: number
  costUsd?: number
  cacheHitRate?: number
  tools?: string[]
}

/** 把任意数字钳成有限非负数（sidecar/模型字段缺失或 NaN 时兜底）。 */
export function safeNum(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/** Token 计数展示：1.2万 / 8,432。 */
export function formatTokens(value: unknown): string {
  const n = safeNum(value)
  if (n >= 10000) return `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}万`
  return n.toLocaleString('en-US')
}

/** 费用展示：精确到美分；为 0 时显示占位。 */
export function formatCost(value: unknown): string {
  const n = safeNum(value)
  if (n === 0) return '—'
  if (n < 0.01) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}

/** 百分比展示：钳到 0-100，缺窗口容量时返回 null（UI 显示"—"）。 */
export function formatPercent(part: unknown, whole: unknown): number | null {
  const p = safeNum(part)
  const w = safeNum(whole)
  if (w === 0) return null
  return Math.max(0, Math.min(100, Math.round((p / w) * 100)))
}

/** 缓存命中率展示。 */
export function formatCacheRate(rate: unknown): string {
  const n = safeNum(rate)
  if (n <= 0) return '—'
  return `${Math.round(n * 100)}%`
}

/** 上下文占比：优先用本地口径（currentContext/window），否则回退 SDK 的 contextUsage。 */
export function contextPercent(snapshot: StateSnapshot): number | null {
  const local = formatPercent(snapshot.currentContext, snapshot.window)
  if (local !== null) return local
  const usage = snapshot.stats?.contextUsage
  if (usage && typeof usage === 'object') {
    const record = usage as Record<string, unknown>
    if (safeNum(record.window) > 0) return formatPercent(record.tokens, record.window)
  }
  return null
}

/** U4 面板的四行摘要（一次性算好，模板保持薄）。 */
export function stateSummary(snapshot: StateSnapshot) {
  const tokens = snapshot.stats?.tokens ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  }
  const percent = contextPercent(snapshot)
  return {
    mode: snapshot.mode,
    model: snapshot.model ? `${snapshot.model.provider}/${snapshot.model.id}` : null,
    thinking: snapshot.thinkingLevel || null,
    totalTokens: formatTokens(tokens.total),
    inputTokens: formatTokens(tokens.input),
    outputTokens: formatTokens(tokens.output),
    cacheRead: formatTokens(tokens.cacheRead),
    cacheWrite: formatTokens(tokens.cacheWrite),
    cacheRate: formatCacheRate(snapshot.cacheHitRate),
    cost: formatCost(snapshot.stats?.cost ?? snapshot.costUsd),
    contextPercent: percent,
    contextUsed: formatTokens(snapshot.currentContext),
    contextWindow: snapshot.window ? formatTokens(snapshot.window) : null,
    queued: (snapshot.steering?.length ?? 0) + (snapshot.followUp?.length ?? 0),
    running: snapshot.running,
  }
}
