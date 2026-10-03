// UI 插件协议单测（1-5）
//
// 核心契约：数据非代码（前端永不 eval 插件 JS）、保留前缀防劫持、
// fail-safe 规范化（一条坏消息不能炸渲染）、HTML 白名单纵深防御。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  makePluginMessage,
  normalizePluginMessage,
  sanitizeHtml,
} from '../src/ui-plugins.ts'

test('规范化：标准插件消息（display.fields）', () => {
  const raw = makePluginMessage({
    title: '构建结果',
    fields: [
      { label: '状态', value: '成功' },
      { label: '耗时', value: 1234 },
    ],
    tone: 'ok',
  })
  const m = normalizePluginMessage({ ...raw, timestamp: 1700000000000 })
  assert.ok(m)
  assert.equal(m.customType, 'ui.plugin')
  assert.equal(m.title, '构建结果')
  assert.equal(m.slot, 'timeline')
  assert.equal(m.component, 'card')
  assert.equal(m.tone, 'ok')
  assert.equal(m.fields.length, 2)
  assert.equal(m.fields[0].value, '成功')
  assert.equal(m.fields[1].value, 1234)
})

test('规范化：从 details 对象派生字段（无 display.fields 时）', () => {
  const m = normalizePluginMessage({
    customType: 'deploy-status',
    content: '',
    details: { env: 'prod', version: 3, nested: { a: 1 } },
    display: { component: 'card' },
    timestamp: 1700000000000,
  })
  assert.ok(m)
  assert.equal(m.fields.length, 3, 'details 的三个键派生三行')
  assert.equal(m.fields[2].value, '{"a":1}', '嵌套对象 JSON 序列化')
})

test('规范化：非法 slot/component/tone 全部回退缺省（fail-safe）', () => {
  const m = normalizePluginMessage({
    customType: 'x',
    content: '',
    display: { slot: 'nowhere', component: 'react-root', tone: 'neon' },
    timestamp: 1,
  })
  assert.ok(m)
  assert.equal(m.slot, 'timeline')
  assert.equal(m.component, 'card')
  assert.equal(m.tone, 'accent')
})

test('规范化：保留前缀劫持防护（ui. 前缀仅 ui.plugin 合法）', () => {
  assert.equal(normalizePluginMessage({ customType: 'ui.fake', content: '' }), null, 'ui.fake 必须被拒')
  assert.equal(normalizePluginMessage({ customType: 'ui.plugin.fake', content: '' }), null, 'ui.plugin.fake 也是保留前缀')
  // ui.plugin 无 display：走缺省（fail-safe 语义，不拒绝）
  const ok = normalizePluginMessage({ customType: 'ui.plugin', content: '', timestamp: 1 })
  assert.ok(ok, 'ui.plugin + 空 display 应正常规范化为缺省卡片')
  assert.equal(ok.customType, 'ui.plugin')
  assert.equal(normalizePluginMessage({ customType: '', content: '' }), null, '空 customType 拒绝')
  assert.equal(normalizePluginMessage(null), null)
  assert.equal(normalizePluginMessage('string'), null)
})

test('规范化：字段数量钳制（防一条消息撑爆 UI）', () => {
  const manyFields = Array.from({ length: 100 }, (_, i) => ({ label: `f${i}`, value: i }))
  const m = normalizePluginMessage({
    customType: 'bulk',
    content: '',
    display: { fields: manyFields },
    timestamp: 1,
  })
  assert.ok(m)
  assert.equal(m.fields.length, 24, '最多 24 个字段')
  // 超长 label/value 截断
  const long = normalizePluginMessage({
    customType: 'long',
    content: '',
    display: { fields: [{ label: 'x'.repeat(200), value: 'y'.repeat(200) }] },
    timestamp: 1,
  })
  assert.ok(long)
  assert.ok(long.fields[0].label.length <= 64)
})

test('HTML 清洗：危险标签整体拒绝，白名单标签只在「裸标签」形态下还原', () => {
  assert.equal(sanitizeHtml('<script>alert(1)</script>'), '<p>[已移除：包含不允许的标签]</p>')
  assert.equal(sanitizeHtml('<iframe src="https://x"></iframe>'), '<p>[已移除：包含不允许的标签]</p>')
  assert.equal(sanitizeHtml('<a href="javascript:alert(1)">x</a>'), '<p>[已移除：包含不允许的标签]</p>', 'a 标签（可导航）也在拒绝名单')
  // 白名单标签**带任何属性**时保持转义态（纯文本），不得保留可执行形态。
  // 批次①对抗审查 S1 的教训：旧"白名单正则剥属性"策略被斜杠分隔标签整体绕过。
  const stripped = sanitizeHtml('<b onclick="alert(1)">bold</b>')
  assert.equal(stripped.includes('<b onclick'), false, '带属性的标签不得以可执行形态保留')
  assert.ok(stripped.includes('&lt;b'), '带属性的标签转义为文本')
  assert.ok(stripped.endsWith('bold</b>'), '闭标签（无属性）仍还原，内容排版不塌')
  const titled = sanitizeHtml('<p title="javascript:void(0)" class="x" id="y">t</p>')
  assert.equal(titled.includes('<p title'), false, 'title/class/id 等属性同样不得保留')
  assert.ok(titled.includes('&lt;p'))
  const img = sanitizeHtml('<img src=x onerror=alert(1)>')
  assert.equal(img.includes('<img'), false, 'img 标签不得以可执行形式保留（img 在拒绝名单 → 整体替换）')
  assert.ok(img.startsWith('<p>'), 'img 走整体拒绝路径')
  const address = sanitizeHtml('<address>x</address>')
  assert.ok(address.startsWith('&lt;'), '非白名单且不在拒绝名单的标签转义为文本')
})

test('HTML 清洗：真实浏览器解析向量（批次①对抗审查 S1 的三类绕过必须全部拦截）', () => {
  // 斜杠分隔属性（旧正则要求属性前有空白 → 整条不匹配 → 原样透传执行）
  for (const attack of [
    '<svg/onload=alert(document.cookie)>',
    '<img/src=x onerror=alert(1)>',
    '<details/open ontoggle=alert(1)>',
    '<!--><svg/onload=alert(1)>-->', // 注释闭合混淆
    '<img alt="<"src=x onerror=alert(1)>', // 属性值内嵌 <
    '<svg><script>alert(1)</script>',
  ]) {
    const out = sanitizeHtml(attack)
    assert.equal(
      /<\s*(svg|img|details|script|iframe|math)/i.test(out),
      false,
      `攻击向量不得以可执行形态存活：${attack} => ${out}`
    )
  }
})

test('有状态正则回归：sanitizeHtml 连续调用结果一致（g 标志 lastIndex 陷阱）', () => {
  const iframe = '<iframe src="https://x"></iframe>'
  assert.equal(sanitizeHtml(iframe), sanitizeHtml(iframe), '同一输入两次调用必须同结果')
  assert.equal(sanitizeHtml(iframe), '<p>[已移除：包含不允许的标签]</p>', '连续调用不得因 lastIndex 漏判')
  const b = sanitizeHtml('<b onclick="x">t</b>')
  assert.equal(sanitizeHtml('<b onclick="x">t</b>'), b, '剥属性路径同样稳定')
})

test('HTML 清洗：白名单内标签与结构保留', () => {
  const html = '<p>状态 <b>良好</b></p><ul><li>一</li><li>二</li></ul><hr />'
  const out = sanitizeHtml(html)
  assert.equal(out, html, '白名单结构原样保留')
})

test('makePluginMessage：构造的载荷经规范化后保真', () => {
  const raw = makePluginMessage({
    title: '图表',
    slot: 'timeline',
    component: 'html',
    body: '<table><tr><td>12</td></tr></table>',
  })
  const m = normalizePluginMessage({ ...raw, timestamp: 1700000000000 })
  assert.ok(m)
  assert.equal(m.component, 'html')
  assert.equal(m.body, '<table><tr><td>12</td></tr></table>')
})

test('text 形态：body 缺省时取 content 文本', () => {
  const m = normalizePluginMessage({
    customType: 'note',
    content: '纯文本内容',
    display: { component: 'text', title: '笔记' },
    timestamp: 1,
  })
  assert.ok(m)
  assert.equal(m.component, 'text')
  assert.equal(m.body, '纯文本内容')
})
