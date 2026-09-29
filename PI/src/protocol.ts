// sidecar 协议类型（Rust 桥 → 前端的 'agent-message' 事件载荷）
//
// 为什么单独成文件：旧代码在 `listen<AgentEnvelope>(...)` 里引用了一个**从未声明**的
// 类型名 `AgentEnvelope`。`vite build` 不做类型检查，所以它一直没被发现，
// 直到引入 svelte-check 才报出来——与 `abandoned` 未定义变量同属一类问题。

/** sidecar 对某个请求的应答 */
export interface SidecarResponse {
  type: 'response'
  id: number
  ok: boolean
  result: unknown
  error?: string
  command?: string
}

/** sidecar 转发的 Agent 事件（已瘦身，详见 sidecar/event-slim.mjs） */
export interface SidecarAgentEvent {
  type: string
  sessionId?: string
  /** message_update 的增量 */
  delta?: string
  thinking?: string
  text?: string
  usage?: unknown
  assistantMessageEvent?: {
    type?: string
    contentIndex?: number
    delta?: string
    text?: string
    thinking?: string
    content?: string
    toolCall?: { id?: string; name?: string; arguments?: unknown }
  }
  toolCallId?: string
  toolName?: string
  args?: unknown
  partialResult?: unknown
  result?: unknown
  isError?: boolean
  willRetry?: boolean
  message?: string
  [key: string]: unknown
}

/** ask 模式下的工具确认请求 */
export interface ConfirmRequestEnvelope {
  type: 'confirm_request'
  sessionId?: string
  confirmId?: string | number
  toolName?: string
  summary?: string
}

/** OAuth 登录过程中 sidecar 推给 UI 的事件 */
export interface LoginEventEnvelope {
  type: 'login_event'
  provider?: string
  event: {
    type?: string
    userCode?: string
    verificationUri?: string
    instructions?: string
    url?: string
    message?: string
    [key: string]: unknown
  }
}

/** OAuth 登录需要用户输入时 sidecar 推给 UI 的提问 */
export interface LoginPromptEnvelope {
  type: 'login_prompt'
  provider?: string
  promptId?: string | number
  prompt?: {
    type?: string
    message?: string
    placeholder?: string
    options?: Array<{ id: string; label: string }>
  }
}

/** sidecar 进程重启（P0-B 自愈）通知 */
export interface SidecarRestartedEnvelope {
  type: 'sidecar-restarted'
  reason?: string
  /** Rust 侧重启后已重新发起的那个请求 id —— 前端必须保留它，否则响应无人接收 */
  keepId?: number
}

/** sidecar 反复退出、停止自动重启 */
export interface SidecarFailedEnvelope {
  type: 'sidecar-failed'
  message?: string
}

/** 扩展发起的对话框请求（0-4）：select / input / editor / confirm */
export interface ExtDialogRequestEnvelope {
  type: 'ui_dialog_request'
  dialogId: string | number
  kind: 'confirm' | 'select' | 'input' | 'editor'
  title?: string
  message?: string
  options?: unknown[]
  placeholder?: string
  prefill?: string
  [key: string]: unknown
}

/** 扩展发出的通知（带来源归因） */
export interface ExtNotifyEnvelope {
  type: 'ext_notify'
  message?: string
  notifyType?: 'info' | 'warning' | 'error'
  /** 发起调用的扩展名（stack 启发式，可能为空串） */
  source?: string
}

/** 扩展对话框超时/被中止（sidecar 侧兜底，防止扩展 await 永久挂住） */
export interface DialogExpiredEnvelope {
  type: 'dialog_expired'
  dialogId?: string | number
  kind?: string
  count?: number
  reason?: string
  /** 2-7：超时时 sidecar 采取的回落语义——'default' = 用该 kind 的安全默认值继续；'cancel' = 如实取消 */
  fallback?: 'default' | 'cancel'
}

/** 1-2 上下文蒸发：SDK 自动/手动压缩的开始与结束（事件默认透传，此前前端忽略） */
export interface CompactionEventEnvelope {
  type: 'compaction_start' | 'compaction_end'
  sessionId?: string
}

/** 扩展要求把文本放进输入框（setEditorText / pasteToEditor） */
export interface ExtEditorTextEnvelope {
  type: 'ext_editor_text'
  text?: string
  source?: string
}

/** 事件转发信封 */
export interface AgentEventEnvelope {
  type: 'event'
  sessionId?: string
  event: SidecarAgentEvent
}

/**
 * 'agent-message' 频道的全部载荷类型。
 * 新增 sidecar 主动推送类型时，请在此追加并让监听回调收窄。
 */
export type AgentEnvelope =
  | SidecarResponse
  | AgentEventEnvelope
  | ConfirmRequestEnvelope
  | LoginEventEnvelope
  | LoginPromptEnvelope
  | SidecarRestartedEnvelope
  | SidecarFailedEnvelope
  | ExtDialogRequestEnvelope
  | ExtNotifyEnvelope
  | ExtEditorTextEnvelope
  | DialogExpiredEnvelope
  | CompactionEventEnvelope

/** 会话在「已归档」列表里的形状（与 Session 的区别是没有 time 字段） */
export interface ArchivedSession {
  id: string
  title: string
  file?: string
  cwd?: string
  archived?: boolean
  modifiedAt?: number
}

/** 把归档会话补齐成 UI 需要的 Session 形状 */
export function toSessionLike(session: ArchivedSession, time: string) {
  return { ...session, time }
}
