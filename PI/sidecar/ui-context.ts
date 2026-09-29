// 扩展 UI 上下文桥（0-4）
//
// 背景：Pi-My 之前**完全没有**传 `uiContext` 给 createAgentSession，于是任何第三方
// 扩展调用 `ctx.ui.confirm/select/input/editor/notify` 都会失败 —— 与 pi-agent-desktop
// issue #31「插件在 Pi CLI 里能用、桌面端不能用」同源（维护者自述"适配不过来"）。
//
// 三条从参考项目踩坑里学到的铁律（务必保留）：
//  1. **`theme` 必须是真实的 Theme 类实例**，不能是字符串或手写 pass-through 对象。
//     percho issue #28：把 ui.theme 给成字符串后，pi-mcp-adapter 在 updateStatusBar 里调
//     `ui.theme.fg("accent", ...)` 直接抛 TypeError，**所有 MCP 服务器永久无法连接**。
//  2. **降级必须留日志**（percho issue #32/#36：静默返回 undefined 导致"零线索"）。
//  3. **取消语义要诚实**：select/input/editor 无宿主时返回 undefined（契约的"用户取消"），
//     **不要伪造"第一项"或空串**当作用户输入（percho 的"诚实取消"设计）。
import { Theme } from '@earendil-works/pi-coding-agent'

/**
 * 给扩展的 Theme 实例。
 *
 * 桌面端不消费 ANSI 输出（颜色全落到 no-op sink），但对象本身**必须是真类实例**：
 * 扩展会调 fg()/bg()/bold()/italic()/getFgAnsi() 等十多个方法，手写 pass-through
 * 对象一旦漏掉某个方法就会崩。色盘取中性暗色（与 Pi-My 默认皮肤接近）。
 */
function createExtensionTheme() {
  const fg = {
    accent: '#7aa2f7',
    border: '#3b4261',
    borderAccent: '#7aa2f7',
    borderMuted: '#292e42',
    success: '#9ece6a',
    error: '#f7768e',
    warning: '#e0af68',
    muted: '#78849b',
    dim: '#565f89',
    text: '#c0caf5',
    thinkingText: '#9d7cd8',
    userMessageText: '#c0caf5',
    customMessageText: '#c0caf5',
    customMessageLabel: '#7aa2f7',
    toolTitle: '#7dcfff',
    toolOutput: '#a9b1d6',
    mdHeading: '#7aa2f7',
    mdLink: '#7dcfff',
    mdLinkUrl: '#565f89',
    mdCode: '#9ece6a',
    mdCodeBlock: '#a9b1d6',
    mdCodeBlockBorder: '#3b4261',
    mdQuote: '#a9b1d6',
    mdQuoteBorder: '#3b4261',
    mdHr: '#3b4261',
    mdListBullet: '#7dcfff',
    toolDiffAdded: '#9ece6a',
    toolDiffRemoved: '#f7768e',
    toolDiffContext: '#565f89',
    syntaxComment: '#565f89',
    syntaxKeyword: '#bb9af7',
    syntaxFunction: '#7aa2f7',
    syntaxVariable: '#e0af68',
    syntaxString: '#9ece6a',
    syntaxNumber: '#ff9e64',
    syntaxType: '#2ac3de',
    syntaxOperator: '#89ddff',
    syntaxPunctuation: '#c0caf5',
    thinkingOff: '#565f89',
    thinkingMinimal: '#6183bb',
    thinkingLow: '#7aa2f7',
    thinkingMedium: '#89ddff',
    thinkingHigh: '#b4f9f8',
    thinkingXhigh: '#d2e5ff',
    bashMode: '#e0af68',
  }
  const bg = {
    selectedBg: '#33467c',
    userMessageBg: '#24283b',
    customMessageBg: '#1f2335',
    toolPendingBg: '#2f334d',
    toolSuccessBg: '#20303b',
    toolErrorBg: '#2d202a',
  }
  try {
    return new Theme(fg, bg, 'truecolor', { name: 'pi-my-desktop' })
  } catch {
    // 构造失败时返回 undefined 让 SDK 用它自己的默认；绝不返回字符串/空对象。
    return undefined
  }
}

/**
 * 从 Error stack 推断发起调用的扩展名（用于 notify 归因；失败返回空串）。
 * 纯启发式：跳过宿主与加载器帧，找 extensions/<name> 或 node_modules/<pkg>。
 */
export function extensionNameFromStack(stack) {
  for (const line of String(stack || '').split('\n')) {
    if (line.includes('@earendil-works') || line.includes('node_modules/jiti/') || line.includes('ui-context')) continue
    const ext = line.match(/[\\/]extensions[\\/]([^\\/()\s]+?)\.(?:tsx?|mjs|cjs|js)(?:[?#:]|$)/)
    if (ext?.[1] && ext[1] !== 'index') return ext[1]
    const pkg = line.match(/node_modules[\\/]((?:@[\w.-]+[\\/])?[\w.-]+)[\\/]/)
    if (pkg?.[1]) return pkg[1]
  }
  return ''
}

/** 未实现的 TUI 能力统一走这里：记日志而不是静默吞掉。
 *  用一个**模块级**集合去重，避免同一方法在同一会话里反复刷日志。 */
const reportedUnsupported = new Set()
function reportUnsupported(method: string, log: (message: string, detail?: unknown) => void) {
  const label = extensionNameFromStack(new Error().stack ?? '')
  const key = `${label}:${method}`
  if (reportedUnsupported.has(key)) return
  reportedUnsupported.add(key)
  log(`扩展 UI 方法未在桌面端实现，已忽略: ${method}`, label ? `(来源: ${label})` : '')
}

/** 测试用：清空去重集合 */
export function resetUnsupportedReportCache(): void {
  reportedUnsupported.clear()
}

export interface UiContextDeps {
  /** 对话框宿主：confirm / select / input / editor 四件套 */
  dialogs: {
    confirm: (title: string, message: string) => Promise<boolean>
    select: (title: string, options: string[]) => Promise<string | undefined>
    input: (title: string, placeholder?: string) => Promise<string | undefined>
    editor: (title: string, prefill?: string) => Promise<string | undefined>
  }
  /** 通知（toast / 桌面通知） */
  notify: (message: string, type: 'info' | 'warning' | 'error', source: string) => void
  /** 扩展要求把文本放进输入框（pasteToEditor / setEditorText） */
  setEditorText: (text: string, source: string) => void
  /** 状态/title 变化（可选） */
  onStatus?: (key: string, text: string | undefined) => void
  onTitle?: (title: string) => void
  log: (message: string, detail?: unknown) => void
}

/**
 * 构造传给 createAgentSession 的 `uiContext`。
 *
 * 只实现桌面端真正有意义的子集；TUI 专属方法（setWidget/setFooter/setHeader/custom…）
 * 以 no-op 提供，但**每次调用都会记一次日志**，使"插件静默失效"变成可诊断事件
 * ——这正是 pi-agent-desktop issue #31 缺失的那一环。
 */
export function createUiContext(deps: UiContextDeps) {
  const theme = createExtensionTheme()
  const unsupported = (method: string) => reportUnsupported(method, deps.log)

  return {
    // ---- 四件套：桥到前端弹窗；无宿主时返回"用户取消"的诚实值 ----
    confirm: (title: string, message: string) => deps.dialogs.confirm(String(title ?? ''), String(message ?? '')),
    select: async (title: string, options: string[]) => {
      const value = await deps.dialogs.select(String(title ?? ''), Array.isArray(options) ? options : [])
      return typeof value === 'string' ? value : undefined
    },
    input: async (title: string, placeholder?: string) => {
      const value = await deps.dialogs.input(String(title ?? ''), placeholder ? String(placeholder) : undefined)
      return typeof value === 'string' ? value : undefined
    },
    editor: async (title: string, prefill?: string) => {
      const value = await deps.dialogs.editor(String(title ?? ''), prefill ? String(prefill) : undefined)
      return typeof value === 'string' ? value : undefined
    },

    // ---- notify：带来源归因，便于用户定位是哪个扩展在说话 ----
    notify: (message: string, type?: 'info' | 'warning' | 'error') =>
      deps.notify(String(message ?? ''), type ?? 'info', extensionNameFromStack(new Error().stack ?? '')),

    // ---- 编辑器草稿 ----
    setEditorText: (text: string) => deps.setEditorText(String(text ?? ''), extensionNameFromStack(new Error().stack ?? '')),
    pasteToEditor: (text: string) => deps.setEditorText(String(text ?? ''), extensionNameFromStack(new Error().stack ?? '')),
    // 同步跨进程读草稿做不到；返回空串（对齐官方 RPC 的降级语义）
    getEditorText: () => '',

    // ---- 状态行 / 标题：有回调就转发，否则记日志 ----
    setStatus: (key: string, text?: string) => {
      if (deps.onStatus) deps.onStatus(String(key), text === undefined ? undefined : String(text))
      else unsupported('setStatus')
    },
    setTitle: (title: string) => {
      if (deps.onTitle) deps.onTitle(String(title))
      else unsupported('setTitle')
    },

    // ---- TUI 专属：桌面端无对应物，no-op 但留痕 ----
    onTerminalInput: () => { unsupported('onTerminalInput'); return () => {} },
    setWorkingMessage: () => unsupported('setWorkingMessage'),
    setWorkingVisible: () => unsupported('setWorkingVisible'),
    setWorkingIndicator: () => unsupported('setWorkingIndicator'),
    setHiddenThinkingLabel: () => unsupported('setHiddenThinkingLabel'),
    setWidget: () => unsupported('setWidget'),
    setFooter: () => unsupported('setFooter'),
    setHeader: () => unsupported('setHeader'),
    custom: (async () => { unsupported('custom'); return undefined }) as never,
    addAutocompleteProvider: () => unsupported('addAutocompleteProvider'),
    setEditorComponent: () => unsupported('setEditorComponent'),
    getEditorComponent: () => undefined,

    // ---- 主题：真类实例（percho issue #28 的核心教训）----
    ...(theme ? { theme } : {}),
    getAllThemes: () => [],
    getTheme: () => undefined,
    // 诚实化：主题主权归宿主；假成功会让扩展据返回值分支误判
    setTheme: () => ({ success: false, error: 'Pi-My 的主题由应用自身管理' }),

    getToolsExpanded: () => false,
    setToolsExpanded: () => { unsupported('setToolsExpanded') },
  }
}
