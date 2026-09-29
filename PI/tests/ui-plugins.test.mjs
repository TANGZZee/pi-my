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

test('HTML 清洗：危险标签整体拒绝，白名单标签剥全部属性', () => {
  assert.equal(sanitizeHtml('<script>alert(1)</script>'), '<p>[已移除：包含不允许的标签]</p>')
  assert.equal(sanitizeHtml('<iframe src="https://x"></iframe>'), '<p>[已移除：包含不允许的标签]</p>')
  assert.equal(sanitizeHtml('<a href="javascript:alert(1)">x</a>'), '<p>[已移除：包含不允许的标签]</p>', 'a 标签（可导航）也在拒绝名单')
  // 白名单标签剥全部属性（任何属性都可能是载荷：onclick/title/class/id）
  const stripped = sanitizeHtml('<b onclick="alert(1)">bold</b>')
  assert.equal(stripped, '<b>bold</b>', '白名单标签剥事件属性后保留')
  const titled = sanitizeHtml('<p title="javascript:void(0)" class="x" id="y">t</p>')
  assert.equal(titled, '<p>t</p>', 'title/class/id 等属性同样剥除')
  const img = sanitizeHtml('<img src=x onerror=alert(1)>')
  assert.equal(img.includes('<img'), false, 'img 标签不得以可执行形式保留（应被转义）')
  assert.ok(img.startsWith('&lt;'), '非白名单标签转义为文本')
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
