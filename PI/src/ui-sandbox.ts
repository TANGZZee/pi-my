/*
 * 1-5 批次③：iframe 沙箱运行时（第三方 UI 代码的隔离执行环境）。
 *
 * 信任模型（用户拍板）：
 *  - 插件消息是数据，不是代码 —— 前端进程永不评估插件 JS。
 *  - 第三方 UI 代码只跑在 <iframe sandbox="allow-scripts"> 里：没有
 *    allow-same-origin ⇒ opaque origin，读不到父页 DOM / localStorage /
 *    fetch 凭证 / token —— 物理隔离，不靠约定。
 *  - iframe 用 srcdoc 注入（继承父页 CSP：script-src 'self' 'unsafe-inline'），
 *    tauri.conf.json 无需放宽 frame-src。
 *  - postMessage 通道是**能力白名单**：iframe 只能发 resize / notify 两种
 *    消息；render/close/setStatus 等特权能力不在通道上 —— 要新能力先扩
 *    白名单并过对抗审查，不存在"顺手多用"的通道。
 *  - 信任门控：不可信项目 → 拒绝渲染非 timeline 槽，并**显式通知**用户
 *    （绝不静默丢弃）。
 */

/** iframe → 宿主：允许的消息类型（能力白名单，封闭联合） */
export type SandboxFrameMessage =
  | { v: 1; kind: 'resize'; height: number }
  | { v: 1; kind: 'notify'; text: string; tone?: 'info' | 'warn' | 'danger' | 'ok' }

/** 宿主 → iframe：单向数据推送（数据进得去，特权请求出不来） */
export type SandboxHostMessage =
  | { v: 1; kind: 'data'; customType: string; body: string; title?: string; fields?: Array<{ label: string; value: string | number | boolean }> }

/** 承重：能力白名单封闭集 —— 解析未知 kind 必须得到 null。 */
export const SANDBOX_ALLOWED_KINDS = ['resize', 'notify'] as const

/** resize 上限（px）：防 1×1 隐形层 / 万像素撑爆布局。 */
export const SANDBOX_HEIGHT_MIN = 16
export const SANDBOX_HEIGHT_MAX = 480
/** notify 文本上限。 */
export const SANDBOX_NOTIFY_MAX = 400

function safeString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

/**
 * 解析 iframe 发来的 message —— fail-safe：任何形状问题都返回 null
 * （调用方丢弃即可，绝不抛错）。
 * 只认 event.source === iframe.contentWindow 的消息（调用方先做同源校验）。
 */
export function parseSandboxFrameMessage(data: unknown): SandboxFrameMessage | null {
  if (!data || typeof data !== 'object') return null
  const raw = data as Record<string, unknown>
  if (raw.v !== 1) return null
  const kind = typeof raw.kind === 'string' ? raw.kind : ''
  if (kind === 'resize') {
    // 数字钳制而非拒绝：恶意/异常高度一律收敛到安全区间
    const height = typeof raw.height === 'number' && Number.isFinite(raw.height) ? Math.round(raw.height) : NaN
    if (Number.isNaN(height)) return null
    return { v: 1, kind: 'resize', height: Math.min(SANDBOX_HEIGHT_MAX, Math.max(SANDBOX_HEIGHT_MIN, height)) }
  }
  if (kind === 'notify') {
    const text = safeString(raw.text, SANDBOX_NOTIFY_MAX)
    if (!text) return null
    const tone = safeString(raw.tone, 8)
    const tones = ['info', 'warn', 'danger', 'ok']
    return { v: 1, kind: 'notify', text, tone: (tones as readonly string[]).includes(tone) ? (tone as 'info') : 'info' }
  }
  return null
}

/** 宿主 → iframe 的数据推送包。 */
export function sandboxDataMessage(message: { customType: string; body: string; title?: string; fields?: Array<{ label: string; value: string | number | boolean }> }): SandboxHostMessage {
  return {
    v: 1,
    kind: 'data',
    customType: safeString(message.customType, 64),
    body: safeString(message.body, 20000),
    title: message.title ? safeString(message.title, 120) : undefined,
    fields: Array.isArray(message.fields)
      ? message.fields.slice(0, 24).map((f) => ({ label: safeString(f?.label, 64), value: typeof f?.value === 'string' ? safeString(f.value, 2000) : (f?.value ?? '') }))
      : undefined,
  }
}

/**
 * iframe 文档头：注入到 srcdoc 顶部。
 * - CSP 继承父页（srcdoc 特性），这里是第二道防线：禁止 iframe 内再发网络请求
 *   与嵌套 iframe（connect-src 'none' + frame-src 'none'）。
 * - 禁止表单提交（sandbox 已挡，双重声明表达意图）。
 */
export const SANDBOX_DOCUMENT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
].join('; ')

/**
 * 组装 sandbox:xxxx 页的 srcdoc。约定（承重）：
 *  - 文档先发 ready，宿主再推 data —— iframe 不用轮询。
 *  - 宿主消息走 window.parent.postMessage(msg, '*')；iframe 发出的消息
 *    带 v/kind 封装，宿主侧 parseSandboxFrameMessage 白名单解析。
 */
export function buildSandboxSrcdoc(options: { body: string; csp?: string }): string {
  const body = typeof options.body === 'string' ? options.body : ''
  const csp = options.csp ?? SANDBOX_DOCUMENT_CSP
  const bridge = [
    '<script>',
    '(function(){',
    "'use strict';",
    'var SEQ=0;',
    'function post(msg){try{msg.v=1;msg._s=++SEQ;window.parent.postMessage(msg,"*")}catch(e){}}',
    'window.addEventListener("message",function(ev){var d=ev&&ev.data;if(!d||d.v!==1||d.kind!=="data")return;',
    'try{window.dispatchEvent(new CustomEvent("plugin-data",{detail:d}))}catch(e){}});',
    'post({kind:"notify",text:"ready"});', // 就绪信标（宿主侧识别 text==='ready' 不上浮为 toast）
    'window.pluginUI={onData:function(fn){window.addEventListener("plugin-data",function(e){fn(e.detail)})},notify:function(text,tone){post({kind:"notify",text:String(text==null?"":text).slice(0,400),tone:tone==="warn"||tone==="danger"||tone==="ok"?tone:"info"})},resize:function(h){post({kind:"resize",height:Number(h)})}};',
    '})();',
    '</script>',
  ].join('')
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, '&quot;')}">`,
    '</head><body>',
    body,
    bridge,
    '</body></html>',
  ].join('')
}

/** iframe 的 sandbox 属性值（承重：绝不加 allow-same-origin）。 */
export const SANDBOX_IFRAME_SANDBOX_ATTR = 'allow-scripts'
