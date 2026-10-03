// UI 插件系统（1-5）
//
// 三层架构：
//   【数据层】扩展通过 SDK 的 ctx.sendMessage(customType/content/display/details)
//            发"UI 插件消息"；role=custom 的消息经 message_start/end 进入事件流；
//            sidecar 原样透传（summarizeEvent 默认透传），并持久化在会话 jsonl 里。
//   【协议层】本模块定义插件消息的规范形状：customType = "ui.plugin"，
//            display = { slot, component, props, title }；扩展的任意 customType
//            也可注册渲染器（后向兼容）。
//   【渲染层】PluginHost.svelte 维护插件注册表（UIPluginRegistry），按 slot 分发；
//            内置两类渲染器：card（结构化卡片）/ html（受控 HTML 白名单渲染）。
//
// 信任模型（重要）：插件消息是**数据**不是代码 —— 扩展在 Node 侧受 Project Trust
// 把关；前端只渲染声明式数据（文本/键值对/受控 HTML 白名单），**永不 eval 插件 JS**。
// 这让它可以安全支持第三方，而不把前端进程暴露给任意代码。
//
// ⚠️ 注意（批次①对抗审查 D16 措辞修正）：应用的 CSP 是 script-src 'self' 'unsafe-inline'
// —— 内联事件处理不被阻止。sanitizeHtml 不是"纵深防御的锦上添花"，而是 {@html}
// 渲染的**唯一防线**；重写后的策略是"默认全文本，只还原裸白名单标签"（见该函数注释）。
//
// 内置保留 customType："ui.plugin"（保留前缀 "ui." 禁止第三方注册，防劫持；
// 校验前先 trim + 小写比较 —— 批次①对抗审查 S2/D3b：' ui.plugin'/'UI.plugin'
// 曾经可以绕过 startsWith 检查）。

/** 挂载点：渲染位置。 */
export type PluginSlot = 'timeline' | 'float' | 'settings' | 'status'

/** 组件形态。card = 键值卡片；html = 白名单内联 HTML；text = 纯文本块。 */
export type PluginComponent = 'card' | 'text' | 'html'

export interface PluginDisplay {
  /** 挂载点，缺省 timeline */
  slot?: PluginSlot
  /** 组件形态，缺省 card */
  component?: PluginComponent
  title?: string
  /** 卡片字段（card 形态）：label → value（值可以是字符串/数字/布尔） */
  fields?: Array<{ label: string; value: string | number | boolean }>
  /** text/html 形态的内容。html 走白名单清洗后渲染。 */
  body?: string
  /** 主题色提示（accent/warn/danger/ok），缺省 accent */
  tone?: 'accent' | 'warn' | 'danger' | 'ok'
}

export interface PluginMessage {
  /** 来源 customType（"ui.plugin" 或扩展自定义类型） */
  customType: string
  title: string
  slot: PluginSlot
  component: PluginComponent
  fields: Array<{ label: string; value: string | number | boolean }>
  body: string
  tone: PluginDisplay['tone']
  /** 消息时间戳（会话回放时保持顺序） */
  timestamp: number
  /** 会话回放定位用 */
  entryId?: string
}

/** html 白名单：只允许这些标签与其无危险属性（事件属性/on* 全剥） */
const HTML_ALLOWED_TAGS = new Set([
  'b', 'i', 'em', 'strong', 'code', 'pre', 'br', 'p', 'span', 'div',
  'ul', 'ol', 'li', 'table', 'tr', 'td', 'th', 'thead', 'tbody', 'hr',
])
// ⚠️ 带全局标志的正则有 lastIndex 状态——并发/多次调用会串位。
// 一律用「每次调用重建」的工厂函数，杜绝有状态正则。
const htmlForbidden = () =>
  /<\s*(script|style|iframe|object|embed|link|meta|form|input|button|a|svg|img|math|details|body|video|audio|source|template|marquee|textarea|select|isindex)\b/gi

/**
 * 规范化一条插件消息（把扩展的任意形状收敛成 PluginMessage）。
 * 非法/超限字段全部按缺省处理（fail-safe），不抛错——一条坏消息不能炸掉渲染。
 */
export function normalizePluginMessage(raw: {
  customType?: unknown
  content?: unknown
  display?: unknown
  details?: unknown
  timestamp?: unknown
}): PluginMessage | null {
  // fail-safe（批次②对抗审查 #11 扩展面）：display / content / details 本身也可以是
  // getter 抛错对象，属性访问统一包一层。整条消息解析绝不外抛。
  try {
    return normalizePluginMessageInner(raw)
  } catch {
    return null
  }
}

function normalizePluginMessageInner(raw: {
  customType?: unknown
  content?: unknown
  display?: unknown
  details?: unknown
  timestamp?: unknown
}): PluginMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const customType = String(raw.customType ?? '').trim().slice(0, 64)
  if (!customType) return null
  // 保留前缀校验必须 trim（' ui.evil'）且大小写不敏感（'UI.evil'）——
  // 否则带空白/大写变体即可绕过（批次①对抗审查 S2/D3b 实测绕过）。
  const lowerType = customType.toLowerCase()
  if (lowerType.startsWith('ui.') && lowerType !== 'ui.plugin') return null // 保留前缀

  const display = (raw.display && typeof raw.display === 'object' ? raw.display : {}) as Record<string, unknown>
  const slotRaw = String(display.slot ?? 'timeline')
  const slot: PluginSlot = ['timeline', 'float', 'settings', 'status'].includes(slotRaw) ? (slotRaw as PluginSlot) : 'timeline'
  const componentRaw = String(display.component ?? 'card')
  const component: PluginComponent = ['card', 'text', 'html'].includes(componentRaw) ? (componentRaw as PluginComponent) : 'card'
  const toneRaw = String(display.tone ?? 'accent')
  const tone: PluginDisplay['tone'] = ['accent', 'warn', 'danger', 'ok'].includes(toneRaw) ? (toneRaw as PluginDisplay['tone']) : 'accent'

  // fields：优先 display.fields；否则从 details（对象）派生键值对。
  // fail-safe（批次②对抗审查 #11 实测）：getter 抛错对象（如 { get label(){throw} }）
  // 不得让 normalizePluginMessage 整体抛出 —— 单条字段异常按"丢弃该字段"降级。
  let fields: PluginMessage['fields'] = []
  // details 本身也可能是 getter 抛错对象：读取一次包 try/catch（批次②对抗审查 #11）。
  let detailsObj: Record<string, unknown> | null = null
  try {
    detailsObj = raw.details && typeof raw.details === 'object' ? (raw.details as Record<string, unknown>) : null
  } catch {
    detailsObj = null
  }
  const rawFields = display.fields
  if (Array.isArray(rawFields)) {
    for (const item of rawFields.slice(0, 24)) {
      try {
        const record = (item ?? {}) as Record<string, unknown>
        const label = String(record.label ?? '').slice(0, 64)
        let value = record.value
        if (typeof value === 'object' && value !== null) value = JSON.stringify(value)
        if (label) fields.push({ label, value: value as string | number | boolean })
      } catch {
        // 单字段 getter 抛错：丢弃该字段，不影响其余字段与整条消息
      }
    }
  } else if (detailsObj) {
    for (const [label, value] of Object.entries(detailsObj).slice(0, 24)) {
      try {
        let v = value
        if (typeof v === 'object' && v !== null) v = JSON.stringify(v)
        fields.push({ label: label.slice(0, 64), value: v as string | number | boolean })
      } catch {
        // 单字段 getter 抛错：丢弃该字段
      }
    }
  }

  let body = ''
  if (component === 'text' || component === 'html') {
    let source = ''
    try {
      source = typeof display.body === 'string' ? display.body : contentText(raw.content)
    } catch {
      // display.body / content getter 抛错：按空正文降级
      source = ''
    }
    body = component === 'html' ? sanitizeHtml(source).slice(0, 20000) : String(source).slice(0, 20000)
  }

  let title = customType
  try {
    title = String(display.title ?? customType).slice(0, 120)
  } catch {
    // title getter 抛错：回落 customType
  }
  // timestamp 也可能是 getter 抛错对象：读取包 try/catch。
  let timestamp = Date.now()
  try {
    timestamp = Number(raw.timestamp) || Date.now()
  } catch {
    // getter 抛错：用当前时间
  }
  return { customType, title, slot, component, fields, body, tone, timestamp }
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : (part as { text?: string })?.text || ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/** 受控 HTML 清洗：**先整体转义，再按白名单把裸标签名转回**。
 *
 * 为什么不用"白名单正则替换"（批次①对抗审查 S1 的教训，已在真实浏览器确认）：
 *   旧实现 `/^<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*?)?)>/` 要求属性前必须有空白，
 *   `<svg/onload=alert(1)>`（斜杠分隔属性）整条不匹配 → 原样透传 → `{@html}` 执行。
 *   任何正则白名单都要与 HTML 解析器赛跑（斜杠分隔、`<!-->` 混淆、未闭合标签、
 *   属性值内嵌 `<`……），而解析器永远赢。
 * 现在的策略反过来：**默认一切输入都是纯文本**（`<`/`>` 全部转义），
 * 只有当一个 `<` 后面紧跟**且仅紧跟**白名单标签名、且开标签里**不含任何属性字符**时，
 * 才把它转回真实标签。带任何属性（`=`、`/`、空白、引号）的标签一律保持转义态。
 * 这样解析器不一致性只影响"哪些文本没被还原"，不影响安全——最坏情况是多转义了几段文本。
 */
export function sanitizeHtml(source: string): string {
  const out = String(source ?? '')
  if (htmlForbidden().test(out)) return '<p>[已移除：包含不允许的标签]</p>'
  // 第一步：全部转义（含注释定界符——`<!-->` 类混淆在这里就失去结构）。
  let text = out.replace(/</g, '&lt;').replace(/>/g, '&gt;')
  // 第二步：仅还原「无属性的裸白名单标签」。还原在已转义文本上进行，
  // 匹配的候选是 `&lt;name&gt;`——其中 name 必须整个是白名单标签名，
  // 中间夹带的任何字符（属性、斜杠、空白）都会让匹配失败而保持转义。
  text = text.replace(/&lt;(\/?)([a-zA-Z][a-zA-Z0-9]*)&gt;/g, (entity, slash: string, name: string) => {
    const lower = name.toLowerCase()
    return HTML_ALLOWED_TAGS.has(lower) ? `<${slash}${lower}>` : entity
  })
  // 第三步：自闭合 `&lt;hr /&gt;` 同款（标签名与 `&gt;` 之间只允许一个 `/`）。
  text = text.replace(/&lt;(hr|br)\s*\/&gt;/gi, (_entity, name: string) => `<${name.toLowerCase()} />`)
  return text
}

/** 扩展侧发消息的辅助（Node 侧用）：构造符合 "ui.plugin" 约定的 sendMessage 载荷。 */
export function makePluginMessage(input: {
  title: string
  slot?: PluginSlot
  component?: PluginComponent
  fields?: Array<{ label: string; value: string | number | boolean }>
  body?: string
  tone?: PluginDisplay['tone']
}) {
  return {
    customType: 'ui.plugin',
    content: input.component === 'html' || input.component === 'text' ? input.body ?? '' : '',
    display: {
      slot: input.slot ?? 'timeline',
      component: input.component ?? 'card',
      title: input.title,
      fields: input.fields,
      body: input.body,
      tone: input.tone,
    },
  }
}
