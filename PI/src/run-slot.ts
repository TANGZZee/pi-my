// 运行槽（RunSlot）纯逻辑（0-5 第二步抽取）
//
// 抽取范围：不触碰组件状态、不依赖 Svelte 响应式的部分 ——
// 时间线构建、过程步骤归约、历史映射。副作用（patchSlot/看门狗）仍留在组件里。
//
// 抽取动机：这些逻辑决定用户看到的"思考/工具/回复"时间线，此前内嵌在
// App.svelte（2700+ 行）中无法测试。

export type RunPhase = 'idle' | 'thinking' | 'working' | 'writing' | 'waiting'

/** 0-5 批次 B：子代理运行条目（此前内嵌在 App.svelte，多个面板组件共用） */
export type SubRun = { id: string; agent: string; task: string; status: 'running' | 'done' | 'error'; reply: string }

export interface ProcessStep {
  id: string
  kind: 'think' | 'tool'
  title: string
  body: string
  done: boolean
}

export interface TimelineMessage {
  id: string
  role: 'user' | 'assistant' | 'plugin'
  text: string
  at: string
  timestamp: number
  userIndex: number
  entryId?: string
  /** 1-5 批次②：role==='plugin' 时的扩展 customType（App.svelte 规范化成 PluginMessage 用） */
  pluginCustomType?: string
  /** 1-5 批次②：role==='plugin' 时的原始 display（slot/component/title/fields/body/tone） */
  pluginDisplay?: Record<string, unknown>
}

/** 把任意值缩略为 ≤maxLen 的展示文本（工具步骤预览用）。 */
export function brief(value: unknown, maxLen = 220): string {
  if (value == null) return ''
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text
}

/**
 * 工具结果摘要（T1-③，SDK 0.99.x bash/powershell 结构化结果对接）：
 * 优先读 structuredContent（output/truncated/full_output_path/exit_code），
 * 截断时给出明确提示而不是把 1MiB JSON 塞进 220 字符预览；非结构化结果回落 brief。
 */
export function toolResultBrief(result: unknown, toolName = '', maxLen = 220): string {
  if (result != null && typeof result === 'object') {
    const structured = (result as { structuredContent?: Record<string, unknown> }).structuredContent
    if (structured && typeof structured === 'object') {
      const exit = Number.isFinite(structured.exit_code) ? Number(structured.exit_code) : null
      const parts: string[] = []
      if (exit !== null) parts.push(`退出码 ${exit}`)
      if (structured.truncated === true) {
        parts.push('输出已截断')
        if (typeof structured.full_output_path === 'string' && structured.full_output_path) {
          parts.push(`完整输出：${structured.full_output_path}`)
        }
      }
      if (parts.length) {
        const preview = typeof structured.output === 'string' ? brief(structured.output, maxLen) : ''
        return [parts.join(' · '), preview].filter(Boolean).join('\n')
      }
    }
  }
  // show_image 等自定义工具保留原有 details 预览；其余回落旧行为
  return brief(result, maxLen)
}

/** 把所有未完成的步骤标记为完成（新事件到来时收束前一步）。 */
export function closeOpenSteps(steps: ProcessStep[]): ProcessStep[] {
  return steps.map((step) => (step.done ? step : { ...step, done: true }))
}

/**
 * 运行终态（正常收尾/失败/侧车中止）时的过程步骤收束。
 *
 * 与 closeOpenSteps 的差别：把"等待思考"占位（id=waiting-think）的未定文案换成
 * 明确的结束语。占位在 dispatchTurn 里创建，正文要等第一段真实思考文本到来才会
 * 被替换（appendThinkToSteps）；当本轮以失败告终（402/404、侧车崩溃、超时），
 * 思考内容永远不会来 —— 只 closeOpenSteps 的话，占位挂着"正在等待模型返回思考
 * 内容…"并标成已完成，看起来像"还在思考"或"思考被吃掉了"。
 *
 * 正常收尾也走这里：占位若已被真实内容替换（id 变为 think-N）则原样保留；
 * 若真的一个字都没思考就结束了（罕见），显示"未产生思考内容"也比"正在等待"准确。
 */
export function settleStepsForFinish(steps: ProcessStep[]): ProcessStep[] {
  return closeOpenSteps(steps).map((step) =>
    step.id === 'waiting-think' && step.body === '正在等待模型返回思考内容…'
      ? { ...step, body: '本回合未产生思考内容。' }
      : step,
  )
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
  role: 'user' | 'assistant' | 'plugin'
  text: string
  timestamp?: number
  userIndex?: number
  entryId?: string
  /** 1-5 批次②：role==='plugin' 时的扩展自定义类型（透传给前端规范化） */
  customType?: string
  /** 1-5 批次②：role==='plugin' 时的 display（slot/component/title/fields/body/tone） */
  display?: Record<string, unknown>
}

/** 时间线消息形态的历史条目（splitPluginHistory 的消费方 → historyToTimeline 之间传递）。 */
export interface TimelineHistoryEntry extends HistoryEntry {
  /** 1-5 批次②：role==='plugin' 时的扩展 customType（透传给规范化方） */
  pluginCustomType?: string
  /** 1-5 批次②：role==='plugin' 时的原始 display（透传给规范化方） */
  pluginDisplay?: Record<string, unknown>
}

/**
 * sidecar 历史条目 → 时间线消息。
 * - 过滤空文本与非 user/assistant/plugin 角色
 * - id 优先 entryId，其次 id，最后用时间戳+序号兜底
 * - userIndex 用于"撤回重发"定位，缺失时钳到 0
 */
export function historyToTimeline(history: Array<HistoryEntry | TimelineHistoryEntry> = []): TimelineMessage[] {
  return (history || [])
    .filter((item) => item && (item.role === 'user' || item.role === 'assistant' || item.role === 'plugin') && String(item.text || '').trim())
    .map((item, index) => {
      // timestamp 正数校验（对抗审查语义攻击 #3）：负值/0 一律回落当前时间，
      // 避免被 Date.parse 误解析的数值字符串显示成 1970 年。
      const parsed = Number(item.timestamp)
      const timestamp = Number.isFinite(parsed) && parsed > 0 ? parsed : Date.now()
      return {
        id: item.entryId || item.id || `history-${timestamp}-${index}`,
        role: item.role,
        text: String(item.text),
        timestamp,
        at: formatReplyTime(timestamp),
        userIndex: Math.max(0, Number(item.userIndex) || 0),
        entryId: item.entryId || item.id,
        // 插件历史：透传 customType/display，由消费方（App.svelte）规范化成
        // PluginMessage 后进插件时间线，而不是变成一条普通文本气泡。
        ...(item.role === 'plugin'
          ? { pluginCustomType: item.customType || 'ui.plugin', pluginDisplay: item.display ?? {} }
          : {}),
      }
    })
}

/** 从时间线提取"已发送消息"列表（撤回重发面板用）。 */
export function sentFromTimeline(timeline: TimelineMessage[]): Array<{ text: string; at: string }> {
  return timeline.filter((item) => item.role === 'user').map((item) => ({ text: item.text, at: item.at }))
}

/**
 * 1-5 批次②（对抗审查缺口 #1/#3/#8 根治）：把磁盘历史分流成插件重放与聊天两条。
 *
 * 为什么抽成纯函数：applySessionHistory 的分流原先内嵌在组件里，对抗审查实测
 * 「chatHistory 过滤谓词反转（!== → ===，普通聊天历史被清空）」变异存活——
 * session-wiring 的接线 10 断言只锚变量名形状，不看 filter 谓词方向。
 * 纯函数 + 行为测试是唯一杀得住这条变异的防线（形状断言可被德摩根等价重构逃逸）。
 *
 * 契约：
 *   - plugin = role === 'plugin' 的条目（顺序保留，透传 customType/display 原样给规范化方）
 *   - chat   = 其余条目（user/assistant；未知角色也落这里，由 historyToTimeline 的
 *              filter 再拦一道 —— 与批次②之前的语义一致）
 */
export function splitPluginHistory(history: HistoryEntry[] = []): { plugin: HistoryEntry[]; chat: HistoryEntry[] } {
  const plugin: HistoryEntry[] = []
  const chat: HistoryEntry[] = []
  for (const item of history || []) {
    if (item?.role === 'plugin') plugin.push(item)
    else chat.push(item)
  }
  return { plugin, chat }
}

/**
 * 1-5 批次②（对抗审查缺口 #1）：插件历史条目 → 待规范化载荷。
 * 缺口 #1 实测「display 透传改 display:{}」变异存活（历史重放后卡片丢
 * slot/component/title/fields，UI 静默退化）——本函数 + 行为测试锁定透传契约：
 * pluginCustomType / pluginDisplay / text / timestamp / entryId 全部到达规范化方。
 * timestamp 带正数校验（对抗审查语义攻击 #3：Date.parse('123') 为负值 → 显示 1970 年）。
 */
export function pluginReplayPayload(item: TimelineHistoryEntry): {
  customType: string
  content: string
  display: Record<string, unknown>
  entryId?: string
  timestamp?: number
} {
  return {
    customType: item.pluginCustomType || item.customType || 'ui.plugin',
    content: item.text,
    display: item.pluginDisplay ?? (item as TimelineHistoryEntry & { display?: Record<string, unknown> }).display ?? {},
    entryId: item.entryId || item.id,
    timestamp: typeof item.timestamp === 'number' && item.timestamp > 0 ? item.timestamp : undefined,
  }
}

/**
 * 把"迟到的磁盘历史"合并进已有时间线（外部审计缺陷 10 + 缺陷 12 的二次伤害）。
 *
 * 场景：会话正在运行（或刚派发完一轮）时从侧边栏点开它 —— `applySessionHistory`
 * 早退，磁盘历史被直接丢弃，此后没有任何重试点（`finishRun` 不回头补加载），
 * 用户看到的 transcript 只有当前这一轮。更隐蔽的是 `dispatchTurn` 在 prompt 还没被
 * ack 时就写了 `historyLoaded: true`，连重启重绑的"补历史"分支也一并跳过。
 *
 * ⚠️ 早期实现是"历史条目无条件全部前置 + 按 id 去重"，这有一个用户可见的数据
 * 错误：时间线是对话的**后缀**（只会追加，"撤回重发"只会截掉尾部），所以磁盘历史
 * 里**比时间线更靠后**的条目 = 用户刚刚撤回删掉的那些。无条件前置会把它们复活，
 * 而且排在最前面（实测 `h3 → h4 → h1 → h2`，时间戳 1002、1003 跑到 1000 之前）。
 *
 * 合并规则（三步，全部只看顺序不看内容）：
 *   ① 时间线的首条若能在历史里找到 ⇒ 时间线是这段对话的一个后缀，只有历史里
 *      **严格位于它之前**的条目才属于"界面从未加载过的历史"；
 *   ② 首条不在历史里（典型：刚派发那一轮还没落盘）⇒ 退回时间戳比较，只收
 *      时间戳早于首条的条目；
 *   ③ 时间线为空 ⇒ 历史即全部。
 * 无论如何都按 `id` 去重，且**保留时间线自身的条目**（当前正在流式输出的半截
 * 回复不会被历史覆盖）。
 *
 * 第二轮外部审计（probe-A-merge.mjs）补了四处边界，其中两处是真问题，已就地修掉：
 *   A3 时间线首条的 `timestamp` 非有限值（缺字段/NaN）时，早期实现走 `: fromHistory`
 *      分支 —— **无条件把整段历史前置**。这与缺陷 12 的修复目标直接矛盾：历史里那些
 *      "比时间线更靠后"的条目（用户刚撤回删掉的）会被复活。无法判定先后时必须保守：
 *      宁可少补历史，也不能让被删的消息复活，因此直接返回时间线不动。
 *   A4 去重只查时间线的 `known` 集合，历史内部若有重复 id，两条会**都**进入结果
 *      （timeline 以 `message.id` 为 key，重复 key 会让 Svelte each 块错乱）。
 *      改为 `missing` 自身也去重。
 *   A1 历史数组非单调（`h1@5000` 排在 `h2@1001` 之前）时会取出时间戳更晚的条目前置，
 *      结果非单调。依赖"磁盘历史按追加顺序 = 时间升序"这一前提（sidecar 侧确实如此，
 *      见 `sidecar/index.mjs` 的 history 组装），故只加测试固化，不引入排序——
 *      排序会在时间戳相等/缺失时给出不稳定结果，反而破坏"撤回不复活"。
 *   A2 时间线首条既不在历史里、时间戳又极小 ⇒ 过滤后为空，历史全部丢弃。真实时间戳
 *      来自 `Date.now()`，不会落在历史之前；同样以测试固化。
 */
export function mergeHistoryIntoTimeline(history: HistoryEntry[] = [], timeline: TimelineMessage[] = []): TimelineMessage[] {
  const fromHistory = historyToTimeline(history)
  if (!timeline.length) return fromHistory
  if (!fromHistory.length) return timeline
  const known = new Set(timeline.map((item) => item.id))
  const headAt = fromHistory.findIndex((item) => item.id === timeline[0].id)
  const headTime = timeline[0].timestamp
  if (headAt < 0 && !Number.isFinite(headTime)) return timeline // A3：无法判定先后，保守放弃合并
  const older = headAt >= 0 ? fromHistory.slice(0, headAt) : fromHistory.filter((item) => item.timestamp < headTime)
  // A4：`known` 只覆盖时间线，历史内部的重复 id 需要在这里再收一次。
  const emitted = new Set<string>()
  const missing = older.filter((item) => {
    if (known.has(item.id) || emitted.has(item.id)) return false
    emitted.add(item.id)
    return true
  })
  if (!missing.length) return timeline
  return [...missing, ...timeline]
}

/** 时间线里最后一条助手回复（重开会话时恢复"最近回复"区域用）。 */
export function lastAssistantReply(timeline: TimelineMessage[]): TimelineMessage | undefined {
  return [...timeline].reverse().find((item) => item.role === 'assistant')
}

/**
 * 从 SDK 终态消息里提取 **provider 错误文本**（纯函数，事件归约用）。
 *
 * 为什么需要它（真实事故）：模型提供商返回 404 时，SDK **不抛异常、也不发
 * `type:'error'` 事件**，而是产出一条 `stopReason:'error'` + `errorMessage` 的
 * assistant 消息，随后照常发 `agent_end` / `agent_settled`（0.99.1 的 `agent_settled`
 * 由 `_runAgentPrompt` 的 finally 调用 `_emitAgentSettled()` 发出：定义在
 * pi-coding-agent/dist/core/agent-session.js:662-672，调用点在 :1344）。
 * 前端此前只读 `agent_end.willRetry`、只处理 `type:'error'`，于是错误文本被整条丢弃
 * ——用户看到的是"没有任何反馈"，甚至（sidecar 死掉时）永久停在 Thinking。
 *
 * 取值规则：从后往前找第一条 assistant 终态消息；
 *   - `stopReason === 'error'`  → 返回 errorMessage（缺失时给兜底文案）
 *   - 其他（stop / aborted / 正常）→ 返回空串（用户主动中止不该报错）
 * 兼容两种入参：`agent_end.messages` 数组，或 `turn_end.message` 单条消息。
 */
export function assistantErrorFrom(messages: unknown): string {
  const list = Array.isArray(messages) ? messages : messages ? [messages] : []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index] as { role?: string; stopReason?: string; errorMessage?: string } | null
    if (!message || typeof message !== 'object') continue
    if (message.role !== 'assistant') continue
    if (message.stopReason !== 'error') return ''
    const detail = String(message.errorMessage ?? '').trim()
    return detail || '模型提供商返回了错误，但没有给出错误详情。'
  }
  return ''
}

/** 常见 provider 错误 → 可执行的中文归因（命中失败时原样透传错误文本）。 */
const PROVIDER_ERROR_HINTS: Array<[RegExp, string]> = [
  [/\b40[13]\b|unauthorized|invalid api key|no api key|authentication/i, 'API Key 无效或未配置，请在设置中重新登录该提供商'],
  [/\b404\b|not found|page not found/i, '接口地址不正确（baseUrl 或 API 路径有误）'],
  [/\b429\b|rate.?limit|too many requests|quota|insufficient_quota|out of budget|balance/i, '触发限流或额度不足'],
  [/\b50[0-4]\b|overloaded|service.?unavailable|server.?error|internal.?error/i, '提供商服务端临时故障，可稍后重试'],
  [/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo|fetch failed|socket hang up|ETIMEDOUT/i, '网络不通或域名无法解析（检查代理与网络）'],
]

/** 给 provider 原始错误补一句归因，便于用户直接判断该怎么修。 */
export function describeProviderError(raw: string): string {
  const text = String(raw ?? '').trim()
  if (!text) return '模型请求失败，且没有返回错误详情。'
  const hit = PROVIDER_ERROR_HINTS.find(([pattern]) => pattern.test(text))
  return hit ? `${hit[1]}：${text}` : `模型请求失败：${text}`
}

/**
 * 判断一句 provider 错误文本其实是不是**用户主动中止**。
 *
 * 真实误报事故：模型返回可重试错误（如 503）后 SDK 进入退避 sleep，此时用户点 Stop
 * → SDK 发 `auto_retry_end{success:false, finalError:"Retry cancelled"}`
 * （源码 pi-coding-agent/dist/core/agent-session.js:2942 的硬编码字面量，触发点
 *  :2977 `_prepareRetry` 的 catch → `_finishCancelledRetry()`）→ 若前端无条件把它
 * 当成 provider 故障暂存，收尾时就会弹出"请求失败 / Retry cancelled"红条 ——
 * 用户明明是自己按的停止，却被告知请求失败。
 *
 * 只认 SDK 那条固定字面文案（整串匹配），避免把 "socket hang up (aborted)"
 * 这类真实网络错误也误判成中止而漏报。
 */
export function isCancellationText(raw: string): boolean {
  return /^retry\s+cancel?led\.?$/i.test(String(raw ?? '').trim())
}

/**
 * 错误展示闸门：这一轮的 provider 错误文本是否应当**展示给用户**。
 *
 * 为什么抽成纯函数（第五/六/九轮对抗性审查的结论）：这条闸门原先在 App.svelte 里写作
 * `if (errorMessage && !runEpoch.isAborted(id))`，测试只能用子串正则去匹配源码文本。
 * 审查者用 9 条写法实测那条正则**既漏又误杀**：
 *  - 漏（语义已反转却放行）：`!!isAborted(id)`、`(false || !isAborted(id))`；
 *  - 误杀（语义完全正确却判死）：`isAborted(id) === false`、`!(isAborted(id) === true)`。
 * 结论是"用语法特征去判定语义"这条路走不通，故把判据搬进纯函数，语义由
 * tests/run-slot.test.mjs 的真值表逐格锁定，接线测试只负责断言调用点传了 aborted。
 *
 * 两个入参的含义与"绝不误报"的承重点：
 *  - `errorMessage` 为空表示这一轮没有 provider 错误（用户按 Stop 时 SDK 发的终态
 *    消息 stopReason 是 aborted、errorMessage 为空），必须返回 false；
 *  - `aborted` 为真表示当前世代就是被用户中止的那一代（runEpoch.isAborted），
 *    即便上游塞了一条错误文案也不能把它说成"请求失败"。
 */
export function shouldSurfaceProviderError(errorMessage: unknown, aborted: boolean): boolean {
  if (aborted === true) return false
  return String(errorMessage ?? '').trim().length > 0
}

/**
 * provider 错误暂存（纯逻辑；App.svelte 只留一层 state 绑定的薄壳）。
 *
 * 为什么要抽出来：对抗性审查的 M11/M12 变异实证 —— 把 App.svelte 里
 * `setProviderError` / `consumeProviderError` 的函数体整个清成 `return`，**61/61 测试
 * 照样全过**（wiring 测试只做源码文本匹配，验不了函数语义；e2e 的复刻归约又各自漂移）。
 * 而暂存正是"provider 报错必须有反馈"这条修复的语义核心：写坏了用户就重新看不见错误。
 * 抽成纯函数后，语义本身即可在 tests/run-slot.test.mjs 直接单测。
 *
 * `stash` 视为不可变：返回新对象（无变化时返回原引用），由调用方负责写回组件状态。
 */
export function stashProviderError(
  stash: Record<string, string>,
  id: string,
  raw: string,
): Record<string, string> {
  const text = String(raw ?? '').trim()
  // 空串表示"这条终态消息没有错误"，即**清掉**旧记录：重试成功后必须抹掉上一次的失败，
  // 否则上一轮的错误会污染本轮的成功结果（用户看到莫名其妙的"请求失败"）。
  if (!text) return removeProviderError(stash, id)
  if (stash[id] === text) return stash
  return { ...stash, [id]: text }
}

/** 丢弃某会话的暂存错误；没有记录时原样返回（避免无意义的状态更新触发重渲）。 */
export function removeProviderError(stash: Record<string, string>, id: string): Record<string, string> {
  if (!stash[id]) return stash
  const next = { ...stash }
  delete next[id]
  return next
}

/**
 * 取走某会话的暂存错误，并转成给用户看的中文归因。
 *
 * 返回 `message` 为空串表示"本轮没有 provider 错误" —— 正常结束（stop / aborted /
 * 无错误）绝不能报错，这是"用户主动中止不弹红条"的承重点。
 */
export function takeProviderError(
  stash: Record<string, string>,
  id: string,
): { stash: Record<string, string>; message: string } {
  const raw = stash[id]
  if (!raw) return { stash, message: '' }
  return { stash: removeProviderError(stash, id), message: describeProviderError(raw) }
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
