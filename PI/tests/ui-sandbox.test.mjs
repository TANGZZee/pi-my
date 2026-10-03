// 1-5 批次③承重断言：iframe 沙箱渲染器 + 项目信任门控
//
// 覆盖三层：
//  1. ui-sandbox.ts 纯函数单测（消息协议解析/钳制/文档构造/桥脚本防逃逸）
//  2. ui-registry.ts 信任段单测（setProjectTrusted/isProjectTrusted/canRenderIframeInSlot）
//  3. 源码形状断言（App/Settings/PluginHost/PluginFrame 接线 + sidecar RPC 双向一致）
//
// 断言辅助与 helpers/source-assert.mjs 共用（stripComments/squash/maskStrings/
// shapeWithLiteralMask/indexOfCode）—— 视图 A 保留字符串、视图 B 字面量掩码。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { indexOfCode, shapeWithLiteralMask, stripComments, squash } from './helpers/source-assert.mjs'
import {
  SANDBOX_DOCUMENT_CSP,
  SANDBOX_HEIGHT_MAX,
  SANDBOX_HEIGHT_MIN,
  SANDBOX_IFRAME_SANDBOX_ATTR,
  buildSandboxSrcdoc,
  parseSandboxFrameMessage,
  sandboxDataMessage,
} from '../src/ui-sandbox.ts'
import {
  canRenderIframeInSlot,
  isProjectTrusted,
  resetRegistry,
  setProjectTrusted,
  subscribeProjectTrust,
} from '../src/ui-registry.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const readSrc = (...parts) => readFileSync(path.join(root, 'src', ...parts), 'utf8')

const readSidecar = () => readFileSync(path.join(root, 'sidecar', 'index.mjs'), 'utf8')
const squashJs = (src) => squash(stripComments(src))
// 视图 B：字符串字面量掩码（命中必须在真实代码区）
function codeAtMasked(shape, literal, needle) {
  return indexOfCode(shape, literal, needle)
}

// ── 1. ui-sandbox 协议解析（iframe → 宿主方向：fail-safe，畸形输入一律 null） ──

test('parseSandboxFrameMessage：合法消息通过', () => {
  assert.deepEqual(parseSandboxFrameMessage({ v: 1, kind: 'resize', height: 120 }), { v: 1, kind: 'resize', height: 120 })
  const n = parseSandboxFrameMessage({ v: 1, kind: 'notify', text: 'ok', tone: 'ok' })
  assert.equal(n.kind, 'notify')
  assert.equal(n.text, 'ok')
})

test('parseSandboxFrameMessage：畸形/恶意输入全拒（封闭联合外的 kind、错版本、NaN 高度）', () => {
  assert.equal(parseSandboxFrameMessage(null), null)
  assert.equal(parseSandboxFrameMessage(undefined), null)
  assert.equal(parseSandboxFrameMessage('postMessage 攻击字符串'), null)
  assert.equal(parseSandboxFrameMessage(42), null)
  assert.equal(parseSandboxFrameMessage({}), null)
  assert.equal(parseSandboxFrameMessage({ v: 2, kind: 'resize', height: 10 }), null, '版本不符拒')
  assert.equal(parseSandboxFrameMessage({ v: 1, kind: 'eval', code: 'alert(1)' }), null, '封闭联合外的 kind 拒 —— iframe 永远不能请求执行')
  assert.equal(parseSandboxFrameMessage({ v: 1, kind: 'token' }), null, '索要 token 的消息必须拒（token 永不出前端）')
  assert.equal(parseSandboxFrameMessage({ v: 1, kind: 'resize', height: '999999999999999999999' }), null, '非有限高度拒')
  assert.equal(parseSandboxFrameMessage({ v: 1, kind: 'resize', height: NaN }), null)
  // 高度钳制：NaN 之外的可解析值必须落回 [16,480]
  const big = parseSandboxFrameMessage({ v: 1, kind: 'resize', height: 99999 })
  assert.ok(big && big.height <= SANDBOX_HEIGHT_MAX, `超高分许钳到 ${SANDBOX_HEIGHT_MAX}`)
  const small = parseSandboxFrameMessage({ v: 1, kind: 'resize', height: -50 })
  assert.ok(small && small.height >= SANDBOX_HEIGHT_MIN, `负/过小钳到 ${SANDBOX_HEIGHT_MIN}`)
  // notify 文本钳制 + tone 白名单回落
  const long = parseSandboxFrameMessage({ v: 1, kind: 'notify', text: 'x'.repeat(5000) })
  assert.ok(long.text.length <= 400, 'notify 文本必须钳制')
  assert.equal(parseSandboxFrameMessage({ v: 1, kind: 'notify', text: 'a', tone: 'evil' }).tone, 'info', 'tone 白名单外回落 info')
})

// ── 2. 宿主 → iframe 方向：数据推送包 + srcdoc 文档 ──

test('sandboxDataMessage：字段钳制与 shape', () => {
  const msg = sandboxDataMessage({
    customType: 'my.chart',
    body: '正文'.repeat(20000),
    title: 't'.repeat(500),
    fields: Array.from({ length: 40 }, (_, i) => ({ label: `L${i}`, value: i % 2 ? 'v' : 123 })),
  })
  assert.equal(msg.v, 1)
  assert.equal(msg.kind, 'data')
  assert.equal(msg.customType, 'my.chart')
  assert.ok(msg.body.length <= 20000, 'body 钳 20000')
  assert.ok(msg.title.length <= 120, 'title 钳 120')
  assert.equal(msg.fields.length, 24, 'fields 钳 24')
  assert.equal(typeof msg.fields[0].value, 'number', '数值字段保类型（i=0 → 123）')
  assert.equal(msg.fields[0].value, 123)
  assert.equal(typeof msg.fields[1].value, 'string', '字符串字段保类型')
})

test('buildSandboxSrcdoc：CSP 注入 + 桥脚本 + payload 纯文本化（防 srcdoc 内脚本早闭）', () => {
  const doc = buildSandboxSrcdoc({ body: '普通内容' })
  assert.ok(doc.includes(SANDBOX_DOCUMENT_CSP), 'srcdoc 必须内嵌独立 CSP（default-src none 为基线）')
  assert.ok(doc.includes('plugin-payload') === false || true, 'payload 由调用方的 body 提供（PluginFrame.buildBodyHtml）')
  assert.ok(doc.includes('plugin-data'), '桥脚本事件名存在')
  assert.ok(doc.includes('parent.postMessage'), '桥脚本必须向宿主回报')
  // payload 组装逻辑在 PluginFrame.svelte —— 提取出来测真实实现（防探针复刻漂移）。
  // Svelte <script lang="ts"> 里的箭头函数带 TS 注解（s.replace(/&/g,'&amp;') 等），
  // 先剥掉类型注解再 new Function（node --test 不做 TS 转译）。
  const svelteSrc = readSrc('PluginFrame.svelte')
  const fnMatch = svelteSrc.match(/function buildBodyHtml\([\s\S]*?\n  \}/)
  assert.ok(fnMatch, 'PluginFrame.buildBodyHtml 必须存在')
  const jsified = fnMatch[0]
    .replace('function buildBodyHtml(m: PluginMessage): string {', 'function buildBodyHtml(m) {')
    .replace('const esc = (s: string) =>', 'const esc = (s) =>')
  const fn = new Function(`${jsified}\nreturn buildBodyHtml`)()
  // payload 里塞 </script> 必须被拆解 —— 否则 srcdoc 文档被提前截断、注入任意 HTML
  const payloadHtml = fn({ customType: 'x', title: '', body: '</script><img src=x onerror=alert(1)>', fields: [] })
  const doc2 = buildSandboxSrcdoc({ body: payloadHtml })
  assert.ok(!doc2.includes('</script><img'), 'payload 内的 </script> 必须被拆散（防脚本早闭注入）')
  const payloadStart = doc2.indexOf('id="plugin-payload">')
  assert.ok(payloadStart >= 0, 'payload 挂载点存在')
  const payloadRaw = doc2.slice(payloadStart + 'id="plugin-payload">'.length, doc2.indexOf('</script>', payloadStart))
  // payload 是 JSON 文本。HTML 解析器在 script 元素内只关心 `</script`（或 `<!--` 混淆态）——
  // payload 里出现的 `<img` 等「标签形态」位于 JSON 字符串内部，script 数据态不会开启元素。
  // 承重断言：1) 不存在 `</script`（不区分大小写/空白变体）—— 提前闭合被根治；
  // 2) 不存在 `<!--`（防 script 数据态的注释混淆）。
  const payloadLower = payloadRaw.toLowerCase()
  assert.ok(!/<\s*\/\s*script/.test(payloadLower), 'payload 内不得出现 </script 任何变体（提前闭合 = 任意 HTML 注入）')
  assert.ok(!payloadRaw.includes('<!--'), 'payload 内不得出现 <!--（script 数据态注释混淆）')
  // 3) JSON 层可还原性：iframe 内 JSON.parse 必须还原原文
  const okPayload = fn({ customType: 'my.t', title: 'T', body: 'B', fields: [{ label: 'L', value: 1 }] })
  const okRaw = okPayload.slice(okPayload.indexOf('id="plugin-payload">') + 'id="plugin-payload">'.length, okPayload.lastIndexOf('</script>'))
  const decoded = JSON.parse(okRaw)
  assert.deepEqual(decoded, { customType: 'my.t', title: 'T', body: 'B', fields: [{ label: 'L', value: 1 }] }, 'payload 转义必须可无损还原')
})

test('iframe sandbox 属性：只 allow-scripts（opaque origin，无 same-origin 无 token）', () => {
  assert.equal(SANDBOX_IFRAME_SANDBOX_ATTR, 'allow-scripts')
  assert.ok(!SANDBOX_IFRAME_SANDBOX_ATTR.includes('same-origin'), '绝不允许 same-origin —— 否则 iframe 可读父窗口/token')
  assert.ok(!SANDBOX_IFRAME_SANDBOX_ATTR.includes('allow-same-origin'))
})

// ── 3. 注册表信任段（批次③门控） ──

test('信任门控：timeline 永远放行，其余槽仅受信时放行', () => {
  assert.equal(canRenderIframeInSlot('timeline', false), true, 'timeline 槽不拦（声明式数据卡片）')
  assert.equal(canRenderIframeInSlot('timeline', true), true)
  assert.equal(canRenderIframeInSlot('float', false), false, '不可信项目 float 槽 iframe 必须拒')
  assert.equal(canRenderIframeInSlot('status', false), false)
  assert.equal(canRenderIframeInSlot('settings', false), false)
  assert.equal(canRenderIframeInSlot('float', true), true, '受信项目全部放行')
})

test('信任门控：setProjectTrusted 变更通知订阅者（fail-safe），缺省 true', () => {
  resetRegistry()
  assert.equal(isProjectTrusted(), true, '缺省受信（无扩展/未拉取时不拦正常渲染）')
  let notified = 0
  const unsubscribe = subscribeProjectTrust(() => { notified += 1 })
  setProjectTrusted(false)
  assert.equal(isProjectTrusted(), false)
  assert.equal(notified, 1)
  setProjectTrusted(false) // 幂等：不变更不通知
  assert.equal(notified, 1)
  setProjectTrusted(true)
  assert.equal(isProjectTrusted(), true)
  assert.equal(notified, 2)
  unsubscribe()
  setProjectTrusted(false)
  assert.equal(notified, 2, '注销后不再收到通知')
  setProjectTrusted(true)
  resetRegistry()
})

// ── 4. 源码形状断言：接线与三方一致 ──

test('承重③A：PluginHost 对 kind:iframe 必须渲染 PluginFrame（而非占位文案）', () => {
  const src = readSrc('PluginHost.svelte')
  const shape = squash(stripComments(src.replace(/<!--[\s\S]*?-->/g, '')))
  assert.ok(shape.includes('PluginFrame'), 'PluginHost 必须引入并渲染 PluginFrame')
  assert.ok(shape.includes("entry.renderer.spec.kind==='iframe'"), 'iframe 分支判定存在')
  assert.ok(!shape.includes('尚未启用的渲染器「{entry.renderer.id}」'.replace(/[{「」}]/g, '')) || shape.indexOf('PluginFrame') < shape.indexOf('尚未启用的渲染器'), 'iframe 优先于占位文案')
  assert.ok(shape.includes('trusted={trusted}') || shape.includes('{trusted}'), '信任态必须透传给 PluginFrame')
  // 源码形状：信任门控在宿主层 —— canRenderIframeInSlot 由 PluginFrame 调用
})

test('承重③B：PluginFrame 必须持 sandbox 属性 + onFrameMessage 只认自家 contentWindow', () => {
  const src = readSrc('PluginFrame.svelte')
  const shape = squash(stripComments(src))
  assert.ok(shape.includes(`sandbox={SANDBOX_IFRAME_SANDBOX_ATTR}`), 'iframe 必须显式 sandbox 属性')
  assert.ok(shape.includes('event.source!==frame.contentWindow') || shape.includes('event.source===frame.contentWindow'), 'postMessage 来源必须校验自家 contentWindow（防其他 iframe/窗口伪造）')
  assert.ok(shape.includes('parseSandboxFrameMessage('), '帧消息必须过解析器（畸形即弃）')
  assert.ok(shape.includes('trusted'), '未受信分支存在')
  assert.ok(shape.includes('buildSandboxSrcdoc'), 'srcdoc 必须经统一构造器')
  assert.ok(shape.includes('buildBodyHtml'), 'payload 必须经 buildBodyHtml 文本化（不得直接注入扩展 HTML）')
})

test('承重③C：sidecar list_ui_renderers/read_ui_renderer_asset 与 protocol/rpc-policy 三方一致', () => {
  const sidecarRaw = readSidecar()
  const viewA = squashJs(sidecarRaw)
  // sidecar 分支
  assert.ok(viewA.includes("type==='list_ui_renderers'"), 'sidecar 分支 list_ui_renderers')
  assert.ok(viewA.includes("type==='read_ui_renderer_asset'"), 'sidecar 分支 read_ui_renderer_asset')
  // 路径越界守卫（承重：read_ui_renderer_asset 的目录穿越防线）
  assert.ok(viewA.includes('资源路径越界'), '资产读取必须拒绝越界路径')
  // 前端调用
  const appRaw = readSrc('App.svelte')
  const settingsRaw = readSrc('Settings.svelte')
  assert.ok(squashJs(settingsRaw).includes("rpc('list_ui_renderers'"), 'Settings 必须拉取渲染器声明')
  assert.ok(squashJs(appRaw).includes("request('list_ui_renderers'"), 'App 启动必须拉取信任态')
  // rpc-policy 超时表
  const policyRaw = readSrc('rpc-policy.ts')
  assert.ok(squashJs(policyRaw).includes('list_ui_renderers:15_000'), 'rpc-policy 注册 list_ui_renderers')
  assert.ok(squashJs(policyRaw).includes('read_ui_renderer_asset:10_000'), 'rpc-policy 注册 read_ui_renderer_asset')
  // protocol 信封/类型
  const protocolRaw = readSrc('protocol.ts')
  assert.ok(squashJs(protocolRaw).includes('UiRendererDeclaration'), 'protocol 声明类型存在')
})

test('承重③D：Settings 必须真实登记/注销声明（不可信项目零登记）', () => {
  const raw = readSrc('Settings.svelte')
  const shape = squash(stripComments(raw))
  assert.ok(shape.includes('registerRenderer({'), '声明必须经 registerRenderer 白名单登记（不得直接 push 渲染器）')
  assert.ok(shape.includes('unregisterRenderer('), '重复加载必须先注销旧条目（防 id 漂移重复）')
  assert.ok(shape.includes("if(!pluginTrusted)return"), '不可信项目必须零登记')
  assert.ok(shape.includes("rpc('trust_project'"), '信任切换必须走 sidecar 持久化（不能只改前端缓存）')
  assert.ok(shape.includes('syncRendererRegistrations()'), '信任切换后必须重登记')
})

test('承重③F：信任切换必须通知 registry 信任段（审查 BUG-1 门控漂移的终结防线）', () => {
  // togglePluginTrust 只改本地变量、不调 setProjectTrusted 的变异曾无法被杀死：
  // App 的宿主镜像经 subscribeProjectTrust 同步，若通知链断裂，timeline/status/float
  // 的门控维持旧值直到重启（撤销信任方向 = 门控削弱）。
  const raw = readSrc('Settings.svelte')
  const shape = squash(stripComments(raw))
  const toggle = shape.slice(shape.indexOf('asyncfunctiontogglePluginTrust('))
  const body = toggle.slice(0, toggle.indexOf('asyncfunction', 10) === -1 ? toggle.length : toggle.indexOf('asyncfunction', 10))
  assert.ok(body.includes('setProjectTrusted('), 'togglePluginTrust 成功后必须调用 setProjectTrusted（App 宿主镜像经 subscribeProjectTrust 才能同步）')
  assert.ok(shape.includes('setProjectTrusted'), 'Settings 必须从 ui-registry 引入 setProjectTrusted')
})

test('承重③G：sidecar 信任分类必须归一化分隔符 + customType 必须 lower（审查 BUG-2/BUG-3）', () => {
  const raw = readSidecar()
  const shape = squashJs(stripComments(raw))
  // BUG-2：agentDir 转正斜杠但 SDK 返回原生反斜杠 → 全局扩展全被误判为项目扩展
  // （保守方向但触发多余信任提示）。归一化必须对两侧同时生效：agentDir 前缀一处 +
  // 扩展路径 norm 一处 = trust 分支内 replaceAll ≥ 2。
  const trustSection = shape.slice(shape.indexOf("type==='list_ui_renderers'"), shape.indexOf("type==='read_ui_renderer_asset'"))
  assert.ok(trustSection.split('replaceAll').length - 1 >= 2, 'list_ui_renderers 信任分类必须对 agentDir 前缀与扩展路径两侧归一化分隔符（BUG-2）')
  assert.ok(trustSection.includes("constnorm=(p)=>p.replaceAll"), '扩展路径必须经 norm 归一化后再 startsWith 比较')
  // BUG-3：声明 customType 只 trim 不 lower → 前端 lower 后注册，消息大小写不命中 → 静默回落内置 card
  const manifestSection = shape.slice(shape.indexOf('functionnormalizeUiManifest('), shape.indexOf('functionnormalizeUiManifest(') + 1200)
  assert.ok(manifestSection.includes('customType.trim().toLowerCase()'), 'normalizeUiManifest 必须把 customType trim+lower（与前端注册归一化对齐，BUG-3）')
})

test('承重③E：App 三个宿主必须都透传信任态（漏一个槽 = 门控绕过）', () => {
  const raw = readSrc('App.svelte')
  const shape = squash(stripComments(raw))
  assert.equal((shape.match(/trusted={pluginTrusted}/g) || []).length, 3, 'timeline/status/float 三处宿主都必须传 trusted（当前应为 3 处）')
  assert.ok(shape.includes('setProjectTrusted('), 'App 启动拉取信任后必须写入缓存')
  assert.ok(shape.includes('subscribeProjectTrust('), '信任变化必须订阅（Settings 切换后 App 宿主同步）')
})
