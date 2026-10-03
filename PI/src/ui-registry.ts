// UI 插件注册表（1-5 完整版 · 批次①）
//
// ui-plugins.ts 文件头声称存在 "PluginHost.svelte 维护插件注册表（UIPluginRegistry）"。
// 本模块就是那个注册表 —— 让注释成真：
//   【挂载点注册】registerSlotHost(slot, hostId)：声明"某个 slot 已有渲染宿主挂载"。
//                四个 slot 是封闭联合类型，第三方无法凭空发明新槽位。
//   【渲染器注册】registerRenderer(...)：按 customType 或 component 决定"这条消息谁渲染"。
//                内置三个渲染器（card/text/html）走 Component 形态；
//                第三方渲染器（批次③ 的 iframe 沙箱）走 kind:'iframe'。
//
// 关键设计：本模块是**纯数据 + 纯函数**，不 import 任何 .svelte、不碰 DOM ——
// 因此可以直接被 node:test 覆盖（见 tests/ui-registry.test.mjs）。
// 真正的「描述符 → Svelte 组件」解析发生在 PluginHost.svelte 里。
//
// 信任边界（与 ui-plugins.ts 一致）：注册表只存声明式描述符，**永不存可执行代码**；
// 保留前缀 "ui." 的 customType 不允许第三方注册，防止恶意扩展劫持内置插件类型。
//
// 身份规则（批次①对抗审查 S3 修补后）：内置身份只由 registerBuiltins() 内部授予 ——
// registerRenderer **永不**接受 builtin:true 或 `builtin:` 前缀 id；source 必填且
// 'core' 为内部保留来源，第三方冒充一律拒绝。iframe 渲染器的 target 在注册时锁定
// 协议白名单（`sandbox:` 前缀或 https:// URL）—— 批次③ 开放 iframe 前的先决条件。

import type { PluginComponent, PluginMessage, PluginSlot } from './ui-plugins.ts'

/** 渲染器类型。builtin = 内置声明式渲染；iframe = 同源沙箱（批次③）。 */
export type RendererKind = 'builtin' | 'iframe'

/** 渲染描述符 —— 只是数据，PluginHost 负责把它解析成具体组件。 */
export interface RendererSpec {
  kind: RendererKind
  /** builtin: 'card'|'text'|'html'；iframe: 沙箱页标识 */
  target: string
}

/** 匹配条件：customType 精确匹配优先于 component 形态匹配。 */
export interface RendererMatch {
  customType?: string
  component?: PluginComponent
}

export interface RendererRegistration {
  id: string
  /** 注册来源：'core' 或扩展标识。用于诊断/归因。 */
  source: string
  builtin: boolean
  spec: RendererSpec
  match: RendererMatch
}

export interface RegisterResult {
  ok: boolean
  error?: string
}

/** 保留前缀：第三方不得注册以此开头的 customType。 */
export const RESERVED_CUSTOM_TYPE_PREFIX = 'ui.'

/** 四个挂载点，与 ui-plugins.ts 的 PluginSlot 一一对应。 */
export const PLUGIN_SLOTS: readonly PluginSlot[] = ['timeline', 'float', 'settings', 'status']

const RENDERER_KINDS: readonly RendererKind[] = ['builtin', 'iframe']
const COMPONENTS: readonly PluginComponent[] = ['card', 'text', 'html']

const ID_MAX = 96

// 模块级单例（PI/src 全项目不用 svelte/store，共享态一律走模块级 + 订阅回调，
// 与 i18n.ts 的 listener 模式保持一致）。
const renderers = new Map<string, RendererRegistration>()
const rendererListeners: Array<() => void> = []

// slot → 已挂载宿主 id 集合。Set 而非单值：同槽允许多宿主（如 timeline 主区 + 侧栏）。
const slotHosts = new Map<PluginSlot, Set<string>>()

function notifyRenderers() {
  for (const listener of [...rendererListeners]) {
    try {
      listener()
    } catch {
      // 订阅者异常不能影响注册表本身（与 i18n.ts 的 listener 隔离同构）
    }
  }
}

/**
 * 注册一个渲染器。输入是**未受信任的**（批次③ 里来自扩展），
 * 因此全程做形状校验，非法输入返回 { ok:false, error } 而不是抛错。
 */
export function registerRenderer(input: unknown): RegisterResult {
  // fail-safe（S5）：getter 抛错的 id 不能让注册函数本身抛错。
  let id = ''
  try {
    id = typeof (input as Record<string, unknown> | null | undefined)?.id === 'string'
      ? ((input as Record<string, unknown>).id as string).slice(0, ID_MAX).trim()
      : ''
  } catch {
    id = ''
  }
  if (!input || typeof input !== 'object') return { ok: false, error: '渲染器注册必须是对象' }
  const record = input as Record<string, unknown>
  if (!id) return { ok: false, error: '渲染器 id 不能为空' }
  if (renderers.has(id)) return { ok: false, error: `渲染器 id 重复：${id}` }

  // 身份只由内部授予（批次①对抗审查 S3）：registerRenderer **永不**授予内置身份。
  // 内置渲染器由 registerBuiltins() 结构化写入（不经本函数）。任何自带 builtin:true
  // 或伪造 `builtin:` 前缀 id 的注册一律拒绝 —— 否则第三方能拿到"不可注销"特权。
  const rawSource = typeof record.source === 'string' ? record.source.slice(0, ID_MAX).trim() : ''
  if (record.builtin === true || id.startsWith('builtin:')) {
    return { ok: false, error: '内置身份由内部授予，不得通过注册接口申请' }
  }
  const builtin = false
  const source = rawSource
  // 批次②对抗审查 #13：'CORE' 大写不得伪装成保留来源（注册时放行、注销时又能
  // 以 'CORE' 删掉别人的核心渲染器 → 归属自洽破防）。统一 lower 后再判。
  if (!source || source.toLowerCase() === 'core') {
    return { ok: false, error: "渲染器必须声明来源 source（'core' 是内部保留来源）" }
  }

  const specRaw = (record.spec ?? {}) as Record<string, unknown>
  const kind = String(specRaw.kind ?? '') as RendererKind
  if (!RENDERER_KINDS.includes(kind)) return { ok: false, error: `未知渲染器类型：${String(specRaw.kind)}` }
  const target = typeof specRaw.target === 'string' ? specRaw.target.slice(0, ID_MAX).trim() : ''
  if (!target) return { ok: false, error: '渲染器 target 不能为空' }
  // 只有内置身份可以声称自己渲染"内置形态"，否则第三方能伪装成 card 渲染器劫持全部卡片。
  if (kind === 'builtin' && !builtin) return { ok: false, error: "非内置来源不得注册 kind:'builtin' 渲染器" }
  if (kind === 'builtin' && !COMPONENTS.includes(target as PluginComponent)) {
    return { ok: false, error: `内置渲染器 target 必须是 card/text/html 之一：${target}` }
  }
  // iframe 目标协议白名单（批次①对抗审查 S4；批次③开放 iframe 前的前置锁定）：
  // 只允许 https 与应用内沙箱页标识（sandbox: 前缀，批次③ 的同源 iframe 用）。
  // javascript:/data:/file: 是脚本执行/本地文件读取，http(s) 私网地址是 SSRF 面。
  // 批次②对抗审查 #2/#13：白名单必须大小写敏感锚定 —— `/i` 让 'HTTPS://evil.com'
  // 大写绕过；sandbox: 后只允许 [a-z0-9._-] 页面标识（拒 'sandbox:javascript:…'、
  // 'sandbox:../../escape' 这类语义逃逸）。
  if (kind === 'iframe') {
    const sandboxId = target.startsWith('sandbox:') ? target.slice(8) : ''
    const isSandboxPage = sandboxId !== '' && /^[a-z0-9._-]+$/.test(sandboxId)
    const isHttps = /^https:\/\/[a-z0-9.-]+(:\d+)?(\/|$)/.test(target)
    if (!isSandboxPage && !isHttps) {
      return { ok: false, error: "iframe target 只允许 https:// URL 或 'sandbox:' 前缀的沙箱页标识" }
    }
  }

  const matchRaw = (record.match ?? {}) as Record<string, unknown>
  const match: RendererMatch = {}
  if (typeof matchRaw.customType === 'string' && matchRaw.customType) {
    // 规范化（批次①对抗审查 S2）：trim + lower 后再判保留前缀与查重，
    // 否则 ' ui.plugin' / 'UI.evil' 可绕过保留前缀防线。
    const customType = matchRaw.customType.trim().toLowerCase().slice(0, 64)
    if (customType.startsWith(RESERVED_CUSTOM_TYPE_PREFIX)) {
      return { ok: false, error: `保留前缀不得注册：${customType}` }
    }
    if (findByCustomType(customType)) return { ok: false, error: `customType 已被占用：${customType}` }
    match.customType = customType
  }
  if (typeof matchRaw.component === 'string' && matchRaw.component) {
    const component = matchRaw.component as PluginComponent
    if (!COMPONENTS.includes(component)) return { ok: false, error: `未知组件形态：${String(matchRaw.component)}` }
    // 形态级匹配只能由内置来源持有：否则扩展 A 注册 {component:'card'} 就能抢走
    // 扩展 B（乃至内置 ui.plugin 协议）的全部消息 —— 跨扩展伪造/劫持。
    // 第三方要渲染自己的 UI，必须声明自己的 customType，改别人的消息无从下手。
    if (!builtin) return { ok: false, error: "非内置来源不得按 component 形态注册（请用自己的 customType）" }
    match.component = component
  }
  if (!match.customType && !match.component) return { ok: false, error: '渲染器必须指定 match.customType 或 match.component' }

  renderers.set(id, { id, source, builtin, spec: { kind, target }, match })
  notifyRenderers()
  return { ok: true }
}

/** 注销一个渲染器。内置渲染器不可注销（返回 false）；带归属校验（S3）。 */
export function unregisterRenderer(id: string, source?: string): boolean {
  const existing = renderers.get(id)
  if (!existing || existing.builtin) return false
  // 指定了来源时必须归属匹配：扩展 A 不得注销扩展 B 的渲染器。
  // 批次②对抗审查 #13：归属比较统一 lower —— 注册侧已拒 'CORE'，注销侧
  // 也按小写归一，保证审计与比较自洽。
  if (typeof source === 'string' && existing.source.toLowerCase() !== source.toLowerCase()) return false
  renderers.delete(id)
  notifyRenderers()
  return true
}

/** 批量注销某来源的全部渲染器（扩展卸载时调用）。返回注销数量。'core'（含大小写变体）不可批量注销。 */
export function unregisterSource(source: string): number {
  if (source.toLowerCase() === 'core') return 0
  let removed = 0
  for (const [id, reg] of [...renderers]) {
    if (reg.source.toLowerCase() !== source.toLowerCase() || reg.builtin) continue
    renderers.delete(id)
    removed += 1
  }
  if (removed) notifyRenderers()
  return removed
}

function findByCustomType(customType: string): RendererRegistration | undefined {
  for (const reg of renderers.values()) {
    if (reg.match.customType === customType) return reg
  }
  return undefined
}

/**
 * 为一条插件消息挑选渲染器。优先级：customType 精确匹配 → component 形态 → 内置回落。
 * 永远返回一个注册项（内置 card 兜底），保证**永远有东西可渲染**。
 */
export function resolveRenderer(message: Pick<PluginMessage, 'customType' | 'component'>): RendererRegistration {
  // fail-safe（批次①对抗审查 S5；批次②对抗审查 #10 实测破防）：
  // ① null/undefined/非对象输入不得抛错；② **getter 抛错对象**不得抛错 ——
  // `typeof safe?.customType` 本身就会触发 getter，与 registerRenderer 的
  // try/catch 必须对称。一条恶意插件消息曾能炸掉整个渲染管线
  // （异常从 selectVisibleEntries 的 map 冒出）。
  let customType = ''
  let component: PluginComponent | undefined
  try {
    const safe = message as Partial<Pick<PluginMessage, 'customType' | 'component'>> | null | undefined
    if (typeof safe?.customType === 'string') customType = safe.customType
    if (typeof safe?.component === 'string') component = safe.component as PluginComponent
  } catch {
    // getter/Proxy 抛错：按"无法识别"处理，回落内置 card
  }
  const byType = customType ? findByCustomType(customType) : undefined
  if (byType) return byType
  for (const reg of renderers.values()) {
    if (!reg.match.customType && reg.match.component === component) return reg
  }
  const fallback = renderers.get('builtin:card')
  if (fallback) return fallback
  // 注册表被清空过（只可能出现在测试里）：返回一个自洽的最小描述符。
  return { id: 'builtin:card', source: 'core', builtin: true, spec: { kind: 'builtin', target: 'card' }, match: { component: 'card' } }
}

export function listRenderers(): RendererRegistration[] {
  return [...renderers.values()]
}

export function getRenderer(id: string): RendererRegistration | undefined {
  return renderers.get(id)
}

/** 订阅注册表变化（返回取消订阅函数）。 */
export function subscribeRenderers(listener: () => void): () => void {
  rendererListeners.push(listener)
  return () => {
    const at = rendererListeners.indexOf(listener)
    if (at >= 0) rendererListeners.splice(at, 1)
  }
}

// ---- 挂载点（slot）注册 ----

/**
 * 声明某个 slot 已有渲染宿主挂载。返回注销函数。
 * 这是 ui-plugins.ts:10 注释里 "按 slot 分发" 的落点：没有宿主的槽位，
 * 插件消息会被挂起而不是静默丢失（PluginHost 据此上报诊断）。
 */
export function registerSlotHost(slot: PluginSlot, hostId: string): () => void {
  if (!PLUGIN_SLOTS.includes(slot)) return () => {}
  const id = String(hostId || '').slice(0, ID_MAX) || 'host'
  let bucket = slotHosts.get(slot)
  if (!bucket) {
    bucket = new Set()
    slotHosts.set(slot, bucket)
  }
  bucket.add(id)
  return () => {
    const current = slotHosts.get(slot)
    if (!current) return
    current.delete(id)
    if (!current.size) slotHosts.delete(slot)
  }
}

export function isSlotMounted(slot: PluginSlot): boolean {
  return (slotHosts.get(slot)?.size ?? 0) > 0
}

export function listSlotHosts(): Array<{ slot: PluginSlot; hosts: string[] }> {
  return PLUGIN_SLOTS.map((slot) => ({ slot, hosts: [...(slotHosts.get(slot) ?? [])] }))
}

// ---- 项目信任门控（批次③） ----
//
// 信任语义（用户拍板）：项目不受信 ⇒ **拒绝非 timeline 槽的沙箱（iframe）渲染，
// 并显式通知用户**（绝不静默丢弃）。timeline 槽放行：时间线里的插件消息本来就是
// 声明式数据卡片，没有第三方代码执行面。信任真值由 sidecar 持有（get/list 时下发），
// 这里只是前端的只读缓存 + 订阅。
let projectTrusted = true
const trustListeners: Array<() => void> = []

/** 前端信任缓存更新（sidecar 应答 / Settings 切换时调用）。 */
export function setProjectTrusted(trusted: boolean): void {
  const next = trusted === true
  if (next === projectTrusted) return
  projectTrusted = next
  for (const listener of [...trustListeners]) {
    try { listener() } catch { /* listener 抛错不阻断其他订阅者 */ }
  }
}

/** 当前信任态（缺省 true —— 无扩展/未拉取时不拦正常卡片渲染）。 */
export function isProjectTrusted(): boolean {
  return projectTrusted
}

export function subscribeProjectTrust(listener: () => void): () => void {
  trustListeners.push(listener)
  return () => {
    const at = trustListeners.indexOf(listener)
    if (at >= 0) trustListeners.splice(at, 1)
  }
}

/**
 * 承重：给定槽位 + 信任态，判断沙箱渲染器能否渲染。
 * 规则：timeline 永远可以；其余槽仅在 trusted 时可以。
 */
export function canRenderIframeInSlot(slot: PluginSlot, trusted: boolean): boolean {
  return trusted || slot === 'timeline'
}

// ---- 消息分发助手 ----

/** 取某槽位的插件消息（缺省空数组，永不返回 undefined）。非数组输入按空数组处理（S6）。 */
export function messagesForSlot(slot: PluginSlot, messages: PluginMessage[] | undefined): PluginMessage[] {
  return (Array.isArray(messages) ? messages : []).filter((message) => message?.slot === slot)
}

export function slotHasContent(slot: PluginSlot, messages: PluginMessage[] | undefined): boolean {
  return messagesForSlot(slot, messages).length > 0
}

/** 有内容但没宿主挂载的槽位 —— 用于"插件 UI 无声消失"的诊断。 */
export function unhostedSlotsWithContent(messages: PluginMessage[] | undefined): PluginSlot[] {
  return PLUGIN_SLOTS.filter((slot) => slotHasContent(slot, messages) && !isSlotMounted(slot))
}

// ---- 渲染管线（批次①对抗审查 D3 的产物）----
//
// 为什么要把管线抽成纯函数：PluginHost.svelte 是渲染组件，源码形状断言只能证明
// "文本存在"，证明不了"会执行"。审查员实测 5 个渲染变异（删 slot 过滤、{#if false}、
// {#each []}、删 PluginCard、本地同名 resolveRenderer）全部测试全绿。
// 现在槽过滤 / limit 截取 / 渲染器解析全部收进这个**可单测**的纯函数，
// PluginHost 模板只剩对它的调用 —— 每个环节都有真实执行断言。

/** 渲染条目：消息 + 已解析的渲染器。 */
export interface PluginEntry {
  message: PluginMessage
  renderer: RendererRegistration
}

/**
 * 渲染管线（纯函数）：槽过滤 → 取最近 N 条 → 按注册表解析渲染器。
 * 非数组输入按空数组处理；limit ≤ 0 表示不限制。
 */
export function selectVisibleEntries(slot: PluginSlot, messages: PluginMessage[] | undefined, limit: number): PluginEntry[] {
  const pool = messagesForSlot(slot, messages)
  const visible = Number.isFinite(limit) && limit > 0 ? pool.slice(-limit) : pool
  return visible.map((message) => ({ message, renderer: resolveRenderer(message) }))
}

/**
 * each 块的 key（批次①对抗审查 D2 的产物）：旧实现
 * `timestamp + customType + index` 无分隔符拼接（"0"+"a1"+1 ≡ "0"+"a11"+1）会碰撞。
 * 有 entryId 用 entryId（App.svelte 写入的会话回放定位 id），否则用带分隔符的复合键。
 */
export function pluginEntryKey(entry: PluginEntry, index: number): string {
  const { message } = entry
  if (message.entryId) return message.entryId
  return `${message.timestamp}:${message.customType}:${index}`
}

// ---- 内置渲染器 ----

/** 注册三个内置渲染器。模块加载时调用一次；重复调用是幂等的。 */
function registerBuiltins() {
  // 结构化键值卡片 / 纯文本块 / 白名单 HTML
  for (const component of COMPONENTS) {
    if (renderers.has(`builtin:${component}`)) continue
    renderers.set(`builtin:${component}`, {
      id: `builtin:${component}`,
      source: 'core',
      builtin: true,
      spec: { kind: 'builtin', target: component },
      match: { component },
    })
  }
}

registerBuiltins()

/**
 * 重置注册表到"仅内置渲染器"状态。**仅供测试**使用，避免用例间互相污染。
 */
export function resetRegistry(): void {
  renderers.clear()
  slotHosts.clear()
  registerBuiltins()
  notifyRenderers()
}
