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
// 内置保留 customType："ui.plugin"（保留前缀 "ui." 禁止第三方注册，防劫持）。

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
const htmlForbidden = () => /<\s*(script|style|iframe|object|embed|link|meta|form|input|button|a)\b/gi

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
  if (!raw || typeof raw !== 'object') return null
  const customType = String(raw.customType ?? '').slice(0, 64)
  if (!customType) return null
  if (customType.startsWith('ui.') && customType !== 'ui.plugin') return null // 保留前缀

  const display = (raw.display && typeof raw.display === 'object' ? raw.display : {}) as Record<string, unknown>
  const slotRaw = String(display.slot ?? 'timeline')
  const slot: PluginSlot = ['timeline', 'float', 'settings', 'status'].includes(slotRaw) ? (slotRaw as PluginSlot) : 'timeline'
  const componentRaw = String(display.component ?? 'card')
  const component: PluginComponent = ['card', 'text', 'html'].includes(componentRaw) ? (componentRaw as PluginComponent) : 'card'
  const toneRaw = String(display.tone ?? 'accent')
  const tone: PluginDisplay['tone'] = ['accent', 'warn', 'danger', 'ok'].includes(toneRaw) ? (toneRaw as PluginDisplay['tone']) : 'accent'

  // fields：优先 display.fields；否则从 details（对象）派生键值对
  let fields: PluginMessage['fields'] = []
  const rawFields = display.fields
  if (Array.isArray(rawFields)) {
    fields = rawFields
      .slice(0, 24)
      .map((item) => {
        const record = (item ?? {}) as Record<string, unknown>
        const label = String(record.label ?? '').slice(0, 64)
        let value = record.value
        if (typeof value === 'object' && value !== null) value = JSON.stringify(value)
        return { label, value: value as string | number | boolean }
      })
      .filter((f) => f.label)
  } else if (raw.details && typeof raw.details === 'object') {
    fields = Object.entries(raw.details as Record<string, unknown>)
      .slice(0, 24)
      .map(([label, value]) => {
        let v = value
        if (typeof v === 'object' && v !== null) v = JSON.stringify(v)
        return { label: label.slice(0, 64), value: v as string | number | boolean }
      })
  }

  let body = ''
  if (component === 'text' || component === 'html') {
    const source = typeof display.body === 'string' ? display.body : contentText(raw.content)
    body = component === 'html' ? sanitizeHtml(source).slice(0, 20000) : String(source).slice(0, 20000)
  }

  const title = String(display.title ?? customType).slice(0, 120)
  const timestamp = Number(raw.timestamp) || Date.now()
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

/** 受控 HTML 清洗：白名单标签 + **剥除全部属性**（含事件属性/href/src/title——
 *  任何属性都可能携带 javascript: 或成为攻击载荷）。
 *  不做完整 sanitize —— 插件数据来自受信任检查的扩展，这里是纵深防御。 */
export function sanitizeHtml(source: string): string {
  let out = String(source ?? '')
  if (htmlForbidden().test(out)) return '<p>[已移除：包含不允许的标签]</p>'
  // 白名单标签：剥掉全部属性，只留标签名
  out = out.replace(/<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*?)?)>/g, (tag, name) => {
    const lower = String(name).toLowerCase()
    if (!HTML_ALLOWED_TAGS.has(lower)) return tag.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const selfClose = /\/>$/.test(tag) ? ' />' : '>'
    return `<${lower}${selfClose}`
  })
  out = out.replace(/<\/([a-zA-Z][a-zA-Z0-9]*)\s*>/g, (tag, name) => {
    const lower = String(name).toLowerCase()
    return HTML_ALLOWED_TAGS.has(lower) ? `</${lower}>` : tag.replace(/</g, '&lt;').replace(/>/g, '&gt;')
  })
  return out
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
