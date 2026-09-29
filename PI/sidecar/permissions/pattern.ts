// 权限规则求值与通配匹配（纯函数）
//
// 设计（移植自 percho packages/backend/src/permissions/pattern.ts, MIT）：
//   allow/ask/deny × 通配模式，`*` 全局兜底，同一工具的多个模式**后命中生效**；
//   bash 走命令链切段，任一段取最严动作（deny > ask > allow），
//   因此 `cd x && rm -rf y`、`echo $(rm -rf y)` 都无法绕过。
import { collectBashCandidates } from './bash-chain.ts'

export type PermissionAction = 'allow' | 'ask' | 'deny'

/** 单工具规则：直接动作，或「模式 → 动作」表（键序即评估序，后命中生效） */
export type PermissionRule = PermissionAction | Record<string, PermissionAction>

export interface PermissionRules {
  /** 全局兜底动作（未列出的工具） */
  '*': PermissionAction
  [toolName: string]: PermissionRule | undefined
}

/** 路径/删除目标越界与临时区的处置策略 */
export interface PermissionOutside {
  /** read/ls 越界动作（默认 allow：拦读不换安全、只损效率） */
  read: PermissionAction
  /** edit/write 越界动作（默认 ask） */
  write: PermissionAction
  /** 目标落在系统临时区时的动作（默认 allow，让 agent 的临时工作流不被弹窗打断） */
  temporary: PermissionAction
}

const ACTIONS: ReadonlySet<string> = new Set(['allow', 'ask', 'deny'])

export function isPermissionAction(value: unknown): value is PermissionAction {
  return typeof value === 'string' && ACTIONS.has(value)
}

/** 动作严格度：deny > ask > allow */
const ACTION_PRIORITY: Record<PermissionAction, number> = { allow: 0, ask: 1, deny: 2 }

/** 取更严的那个动作 */
export function strictest(left: PermissionAction, right: PermissionAction): PermissionAction {
  return ACTION_PRIORITY[right] > ACTION_PRIORITY[left] ? right : left
}

/** 通配匹配：`*` 任意字符序列，`?` 单字符，其余字面；整串匹配，大小写敏感。 */
export function matchPattern(pattern: string, text: string): boolean {
  const regex = pattern
    .split('')
    .map((ch) => {
      if (ch === '*') return '.*'
      if (ch === '?') return '.'
      return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('')
  return new RegExp(`^${regex}$`).test(text)
}

/**
 * 单段求值：默认值 → `*` 全局动作 → 工具动作 → 工具模式表（后命中覆盖）。
 * matchText 为 null（无结构化匹配文本的工具）时只吃工具名级动作与全局兜底。
 */
export function evaluateSingle(
  rules: PermissionRules,
  toolName: string,
  matchText: string | null,
  fallback: PermissionAction,
): PermissionAction {
  let action = fallback
  const globalRule = rules['*']
  if (isPermissionAction(globalRule)) action = globalRule
  const toolRule = rules[toolName]
  if (!toolRule) return action
  if (isPermissionAction(toolRule)) return toolRule
  if (typeof toolRule === 'object' && matchText !== null) {
    for (const [pattern, patternAction] of Object.entries(toolRule)) {
      if (isPermissionAction(patternAction) && matchPattern(pattern, matchText)) {
        action = patternAction
      }
    }
  }
  return action
}

/**
 * bash 命令链求值：所有候选分别求值，动作取最严。
 * 返回命中最终动作的 segment，供确认弹窗定位危险命令。
 */
export function evaluateBashCommand(
  rules: PermissionRules,
  command: string,
  fallback: PermissionAction = 'ask',
  segmentOverride?: (segment: string) => PermissionAction | null,
): { action: PermissionAction; segment: string } {
  let action: PermissionAction = 'allow'
  let segment = command
  for (const candidate of collectBashCandidates(command)) {
    let current = evaluateSingle(rules, 'bash', candidate, fallback)
    if (segmentOverride) {
      const override = segmentOverride(candidate)
      // deny 地板：只允许改写非 deny 的段（临时区豁免不能放松显式 deny）
      if (override !== null && current !== 'deny') current = override
    }
    const priority = ACTION_PRIORITY[current]
    if (
      priority > ACTION_PRIORITY[action] ||
      (segmentOverride !== undefined && priority === ACTION_PRIORITY[action])
    ) {
      action = current
      segment = candidate
    }
  }
  return { action, segment }
}

/** 规则求值：bash 走命令链，其余工具单段求值。 */
export function evaluateRules(
  rules: PermissionRules,
  toolName: string,
  matchText: string | null,
  fallback: PermissionAction = 'ask',
): PermissionAction {
  if (toolName === 'bash' && matchText !== null) {
    return evaluateBashCommand(rules, matchText, fallback).action
  }
  return evaluateSingle(rules, toolName, matchText, fallback)
}

/** 从工具调用输入里提取用于匹配的文本；无法提取时返回 null。 */
export function matchTextFor(toolName: string, input: Record<string, unknown>): string | null {
  const value = (() => {
    switch (toolName) {
      case 'bash':
      case 'powershell':
        return input.command
      case 'read':
      case 'edit':
      case 'write':
      case 'ls':
        return input.path
      case 'grep':
      case 'find':
        return input.pattern
      default:
        return undefined
    }
  })()
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** matchText 是文件路径的工具（用于 allowAlways 的目录粒度记忆） */
const PATH_PATTERN_TOOLS = new Set(['read', 'edit', 'write', 'ls'])

/**
 * ask 弹窗的"模式键"（会话内记忆 + 项目级持久化用）。
 * bash 取前两 token（第二 token 为子命令形态如 `git push` 或 flag 形态如 `rm -rf`），
 * flag 规整让 allowAlways 粒度是「rm -rf*」而非「rm*」；
 * 路径工具用父目录前缀，精确到文件会导致"换一个文件又弹"。
 */
export function suggestPattern(toolName: string, input: Record<string, unknown>, home?: string): string {
  const matchText = matchTextFor(toolName, input)
  if (toolName === 'bash' && matchText) {
    const tokens = matchText.trim().split(/\s+/)
    const first = tokens[0] ?? ''
    const second = tokens[1] ?? ''
    if (first && /^(?:[a-zA-Z][a-zA-Z0-9-]*|-[a-zA-Z][a-zA-Z0-9-]*)$/.test(second)) {
      return `bash: ${first} ${second}*`
    }
    return first ? `bash: ${first}*` : 'bash'
  }
  if (matchText) {
    if (PATH_PATTERN_TOOLS.has(toolName)) {
      return pathToolPattern(toolName, matchText, home)
    }
    return `${toolName}: ${matchText}`
  }
  return toolName
}

/**
 * 目录粒度过宽的守卫。
 * 以下情况用精确路径而不是目录模式，避免"点一次总是允许"就等于授权一大片：
 *   - 目录就是文件系统根（`/`、`C:\`）
 *   - 目录就是 home 目录本身
 *   - 目录是 home 的祖先（`/home` 之于 `/home/u`）
 *   - 目录是根的直接子目录（`/etc` 之于 `/`）——否则 `/etc/*` 会覆盖整个 etc
 *   - 目录是 home 的直接父目录
 */
function tooBroadDir(dir: string, home: string | undefined): boolean {
  const normalizedDir = dir.replace(/[\\/]+$/, '') || dir
  // 文件系统根：`/`、`C:\`、`C:`
  if (/^[A-Za-z]:$/.test(normalizedDir) || normalizedDir === '/' || normalizedDir === '') return true

  const sep = normalizedDir.includes('\\') ? '\\' : '/'
  const root = sep === '/' ? '/' : normalizedDir.slice(0, 3)
  // 根的直接子目录（/etc、C:\Windows）
  if (normalizedDir === root || normalizedDir === root.slice(0, -1)) return true
  if (normalizedDir.slice(root.length).indexOf(sep) === -1 && normalizedDir !== root) {
    // 形如 /etc（root='/'，去掉 root 后无分隔符）
    const rest = sep === '/' ? normalizedDir.slice(1) : normalizedDir.slice(root.length)
    if (rest && rest.indexOf(sep) === -1) return true
  }

  if (!home) return false
  const normalizedHome = home.replace(/[\\/]+$/, '')
  if (normalizedDir === normalizedHome) return true
  // home 的祖先（/home 之于 /home/u）
  if (normalizedHome.startsWith(normalizedDir + sep)) return true
  // home 的直接父目录
  const homeParent = normalizedHome.slice(0, normalizedHome.lastIndexOf(sep))
  if (normalizedDir === homeParent) return true
  return false
}

/** 路径工具的父目录前缀模式键；过宽目录退回精确路径，绝不放大到整个家目录。 */
export function pathToolPattern(toolName: string, filePath: string, home?: string): string {
  const sep = filePath.includes('\\') ? '\\' : '/'
  const idx = filePath.lastIndexOf(sep)
  if (idx <= 0) return `${toolName}: ${filePath}`
  const dir = filePath.slice(0, idx)
  if (tooBroadDir(dir, home)) return `${toolName}: ${filePath}`
  return `${toolName}: ${dir}${sep}*`
}

/**
 * 记忆（"总是允许"）与本次调用的匹配。
 *
 * ⚠️ 与 patternMatchesToolCall 的关键区别：这里**只对完整命令文本做整串匹配**，
 * 不做候选展开。原因（审查发现的 P0）：记忆若按候选匹配，确认过一次无害的 `ls`
 * 之后，`cd / && ls; rm -rf /important` 的候选里含 `ls` → 整条链被静默放行。
 * 记忆的语义必须是"这条命令我已确认过"，而不是"链里有一个我认得的段"。
 */
export function memoryMatchesCommand(
  pattern: string,
  toolName: string,
  matchText: string | null,
): boolean {
  const idx = pattern.indexOf(': ')
  const patternTool = idx > 0 ? pattern.slice(0, idx) : pattern
  const patternText = idx > 0 ? pattern.slice(idx + 2) : null
  if (patternTool !== toolName) return false
  if (patternText === null) return true
  if (matchText === null) return false
  return matchPattern(patternText, matchText)
}
