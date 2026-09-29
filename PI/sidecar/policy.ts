// Agent 权限三模式策略（纯函数，无 IO）
// plan = 只读探索；ask = 默认，高危工具逐次确认；full = 全放行

/** Agent 权限模式 */
export type AgentMode = 'plan' | 'ask' | 'full'

export const AGENT_MODES: readonly AgentMode[] = ['plan', 'ask', 'full']
export const DEFAULT_MODE: AgentMode = 'ask'

// plan 模式只保留只读工具（白名单：拦截比放行安全）
export const PLAN_TOOLS: readonly string[] = ['read', 'grep', 'find', 'ls']
// ask/full 模式的核心工具集
export const CORE_TOOLS: readonly string[] = ['read', 'bash', 'edit', 'write']
/**
 * 会话注册表应包含的工具 = 核心集 ∪ 只读集。
 *
 * 为什么需要并集：SDK 的注册表在 createAgentSession 时就被 `tools` 参数**永久裁剪**，
 * 且 getAllTools() 之后只反映裁剪结果。若按初始模式分别传入（plan 传 PLAN_TOOLS、
 * ask 传 CORE_TOOLS），就会导致后续模式切换**只能往小里切**：
 *   - plan 中创建的会话切到 ask → 拿不回 bash（基准里没有）
 *   - ask 中创建的会话切到 plan → 拿不到 grep/find/ls（基准里没有）
 * 传入并集后，任何初始模式都能双向切换。
 */
export const BASE_TOOLS: readonly string[] = [
  ...CORE_TOOLS,
  ...PLAN_TOOLS.filter((tool) => !CORE_TOOLS.includes(tool)),
]
// ask 模式下需要用户确认的工具
export const CONFIRM_TOOLS: readonly string[] = ['bash', 'powershell', 'edit', 'write']

/** 工具调用事件里我们关心的输入字段（其余字段不读） */
export interface ToolCallInput {
  command?: unknown
  path?: unknown
  [key: string]: unknown
}

export function isAgentMode(value: unknown): value is AgentMode {
  return typeof value === 'string' && (AGENT_MODES as readonly string[]).includes(value)
}

/**
 * 模式切换时的工具集计算（P0-2 修复）。
 *
 * ⚠️ 实测结论（务必理解，否则会误改）：SDK 的注册表在 createAgentSession 时就被
 * `tools` 参数**永久裁剪**，且 `getAllTools()` 之后只反映裁剪结果——所以**必须**
 * 用并集 BASE_TOOLS 创建会话，否则后续 set_mode 无论怎么算都拿不回被裁掉的工具
 * （例如在 plan 中创建的会话切到 ask，永远拿不回 bash）。
 *
 * 旧实现的缺陷：把硬编码的 4 个工具当基准传给 setActiveToolsByName，
 * 于是从 plan 切回 ask/full 时把 grep/find/ls 永久丢失，直到会话重建。
 *
 * 正确语义：基准是**会话可用的全部工具**（调用方从会话累积，见 sidecar 的
 * allToolNames），plan 取只读子集，ask/full 取全集。
 *
 * 健壮性：基准为空时（探测失败）退化到 BASE_TOOLS，而不是把工具集清空
 * ——清空会让 agent 什么都不能做，比旧实现更糟。
 *
 * @param mode         目标模式
 * @param allToolNames 会话可用的全部工具名
 */
export function toolsForModeSwitch(mode: AgentMode | string, allToolNames: readonly string[] | null | undefined): string[] {
  const available = Array.isArray(allToolNames) && allToolNames.length ? allToolNames : BASE_TOOLS
  if (mode === 'plan') {
    // 只保留**确实存在**的只读工具（避免请求未注册的名字）
    return available.filter((name) => PLAN_TOOLS.includes(name))
  }
  // ask / full：全部可用工具（ask 的危险工具由确认桥逐次拦截，不靠裁剪工具集）
  return [...available]
}

export function needsAskConfirm(mode: AgentMode | string, toolName: string): boolean {
  return mode === 'ask' && CONFIRM_TOOLS.includes(toolName)
}

export function summarizeToolCall(toolName: string, input: ToolCallInput = {}): string {
  if (toolName === 'bash' || toolName === 'powershell') {
    const cmd = String(input.command ?? '')
    return `${toolName === 'bash' ? '$' : 'PS>'} ${cmd}`.slice(0, 160)
  }
  if (toolName === 'write') return `写入 ${String(input.path ?? '文件')}`
  if (toolName === 'edit') return `编辑 ${String(input.path ?? '文件')}`
  return toolName
}
