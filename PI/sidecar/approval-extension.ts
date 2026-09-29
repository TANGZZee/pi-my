// 审批内联扩展：把权限规则引擎接到 UI 确认桥
//
// 演进说明（0-3）：旧实现只做 `CONFIRM_TOOLS.includes(toolName)`——按工具名一刀切，
// 于是 bash 一律弹窗、名单外的工具一律静默放行，且无法识别
// `cd x && rm -rf y` / `echo $(rm -rf y)` / `sh -c 'rm -rf y'` 这类藏起来的危险命令。
// 现在委托给 sidecar/permissions/ 的规则引擎：allow/ask/deny × 通配模式，
// bash 走命令链求值取最严段，并支持项目级「总是允许」记忆与临时区 fail-safe 豁免。
import { createPermissionGateExtension } from './permissions/index.ts'
import type { PermissionAction } from './permissions/index.ts'

export interface ApprovalDeps {
  /** 当前权限模式（每次 tool_call 实时读取，切换即时生效） */
  getMode: () => string
  /** 经协议桥请 UI 确认；返回 true 表示放行 */
  requestConfirm: (info: { sessionId: string; toolName: string; summary: string }) => Promise<boolean>
  sessionId: string
  /** agentDir（读取 ~/.pi/agent/permissions.json） */
  agentDir: string
  /** 会话工作目录（路径边界判定基准） */
  getProjectRoot: () => string | undefined
  /** 项目级「总是允许」的模式键 */
  getAllowedPatterns?: () => string[]
  /** 被放行时把模式键记入项目记忆 */
  rememberAllowed?: (pattern: string) => void
  warn?: (message: string, error?: unknown) => void
}

export function createApprovalExtension(deps: ApprovalDeps) {
  return createPermissionGateExtension({
    agentDir: deps.agentDir,
    getMode: deps.getMode,
    sessionId: deps.sessionId,
    getProjectRoot: deps.getProjectRoot,
    getAllowedPatterns: deps.getAllowedPatterns ?? (() => []),
    rememberAllowed: deps.rememberAllowed,
    warn: deps.warn,
    confirm: (title, message) => deps.requestConfirm({
      sessionId: deps.sessionId,
      toolName: title,
      summary: message,
    }),
  })
}

/** 兼容旧调用：保留按工具名判断的能力（新代码应使用规则引擎） */
export { needsAskConfirm, summarizeToolCall } from './policy.ts'
export type { PermissionAction }
