// UI 插件注册表单测（1-5 完整版 · 批次①）
//
// 这一批的核心承诺是 ui-plugins.ts:10 那句注释——"PluginHost.svelte 维护插件注册表，
// 按 slot 分发"。本文件同时守住两件事：
//   ① 注册表本身的契约（形状校验、优先级、注销、挂载点诊断、订阅隔离）；
//   ② 四个槽位在真实源码里**确实被挂上**（不是字符串诱饵、不是只写了 import）。
//
// 为什么源码断言必须走 shapeWithLiteralMask + indexOfCode：
//   stripComments 不剥字符串字面量。把整段 `<PluginHost slot="float" …/>` 从模板里删掉、
//   换成一个内容相同的字符串常量，assert.match / includes 依旧命中 —— 真实渲染为零，
//   测试全绿。indexOfCode 要求命中起点来自真实代码，诱饵字符串一律不算。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { indexOfCode, shapeWithLiteralMask } from './helpers/source-assert.mjs'
import {
  PLUGIN_SLOTS,
  RESERVED_CUSTOM_TYPE_PREFIX,
  getRenderer,
  isSlotMounted,
  listRenderers,
  listSlotHosts,
  messagesForSlot,
  pluginEntryKey,
  registerRenderer,
  registerSlotHost,
  resetRegistry,
  resolveRenderer,
  selectVisibleEntries,
  slotHasContent,
  subscribeRenderers,
  unhostedSlotsWithContent,
  unregisterRenderer,
  unregisterSource,
} from '../src/ui-registry.ts'

const appSourceRaw = readFileSync(new URL('../src/App.svelte', import.meta.url), 'utf8')
const settingsSourceRaw = readFileSync(new URL('../src/Settings.svelte', import.meta.url), 'utf8')
const hostSourceRaw = readFileSync(new URL('../src/PluginHost.svelte', import.meta.url), 'utf8')

/**
 * 剥掉 Svelte 模板注释 `<!-- … -->`，**但只剥代码区的注释**。
 *
 * 为什么必须有（本文件变异 M1 实测发现）：stripComments 只认 JS 的 `//` 与 `/* *\/`，
 * 完全不认识模板注释。把整块 `<PluginHost slot="timeline" … />` 用 `<!-- -->` 包起来，
 * 它就彻底不渲染了，但注释文本还在源码里 —— 所有源码断言照旧全绿。
 *
 * 为什么不能只用裸正则 `src.replace(/<!--[\s\S]*?-->/g,'')`（批次①对抗审查 D4 实测）：
 *   裸正则连字符串字面量里的 `<!--` 也认。变异方把真实宿主删掉、在字符串里放
 *   `const __d = '前面 <!-- 后面的真实代码'`，正则会从字符串内的 `<!--` 开始吞到
 *   代码区真正的 `-->`（或吞掉后续真实代码），产生假阳/假阴。
 *   正确做法：先按 source-assert 的同款词法规则屏蔽字符串字面量（保长度），
 *   只在**屏蔽视图**里找注释定界，再按等长偏移回原文删除 —— 字符串里的诱饵永远不算。
 */
function stripHtmlComments(src) {
  // 屏蔽字符串/模板字面量内容（批次②对抗审查实证：`masked += ch` 保留原文 = 假屏蔽，
  // indexOf 在字符串内的 `<!--` 上照样命中。必须把字面量内容**替换成占位符**，
  // 占位符不含 `<`/`-`，保证 `<!--`/`-->` 只可能在代码区出现。
  const MASK = 'X'
  const maskedChars = src.split('')
  let quote = ''
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]
    if (quote) {
      if (ch === '\\') {
        maskedChars[i] = MASK
        i += 1
        if (i < src.length) maskedChars[i] = MASK
        continue
      }
      maskedChars[i] = ch === quote ? quote : MASK
      if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      continue
    }
  }
  const masked = maskedChars.join('')
  // 只在屏蔽视图里定位注释区间（起止定界符都必须在代码区），再回原文删除。
  let out = ''
  let cursor = 0
  for (;;) {
    const start = masked.indexOf('<!--', cursor)
    if (start < 0) break
    const end = masked.indexOf('-->', start + 4)
    if (end < 0) break
    out += src.slice(cursor, start)
    cursor = end + 3
  }
  return out + src.slice(cursor)
}

const appSource = stripHtmlComments(appSourceRaw)
const settingsSource = stripHtmlComments(settingsSourceRaw)
const hostSource = stripHtmlComments(hostSourceRaw)

/** 在源码里定位一段真实代码（命中起点必须在代码区，不能在字符串/模板字面量里）。 */
function codeAt(source, needle) {
  const { shape, literal } = shapeWithLiteralMask(source)
  return indexOfCode(shape, literal, needle)
}

function assertCode(source, needle, message) {
  assert.ok(codeAt(source, needle) >= 0, `${message}（在真实代码里找不到：${needle}）`)
}

/** 把 needle 塞进一个字符串常量里当诱饵 —— 断言这套探针确实不吃诱饵。 */
function decoyOnly(needle) {
  return `const __decoy = '${needle}'\n`
}

// ---------------------------------------------------------------------------
// 一、注册表契约
// ---------------------------------------------------------------------------

test('注册表：内置渲染器随模块加载就位，resolveRenderer 永不返回 undefined', () => {
  resetRegistry()
  const ids = listRenderers().map((item) => item.id).sort()
  assert.deepEqual(ids, ['builtin:card', 'builtin:html', 'builtin:text'])
  for (const item of listRenderers()) {
    assert.equal(item.builtin, true)
    assert.equal(item.source, 'core')
    assert.equal(item.spec.kind, 'builtin')
  }
  // 未知 component 也必须兜底到内置 card，而不是 undefined（否则 PluginHost 渲染崩溃）
  const fallback = resolveRenderer({ customType: 'nobody-registered-this', component: 'card' })
  assert.ok(fallback, 'resolveRenderer 必须永远有返回值')
  assert.equal(fallback.id, 'builtin:card')
})

test('注册表：PLUGIN_SLOTS 是封闭的四槽，且与 ui-plugins 的 PluginSlot 一致', () => {
  assert.deepEqual([...PLUGIN_SLOTS], ['timeline', 'float', 'settings', 'status'])
  assert.equal(RESERVED_CUSTOM_TYPE_PREFIX, 'ui.')
})

test('注册表：registerRenderer 拒绝全部非法形状（且不抛错）', () => {
  resetRegistry()
  const rejects = [
    [null, '非对象'],
    ['renderer', '字符串'],
    [{}, '缺 id'],
    [{ id: '   ' }, '空白 id'],
    [{ id: 'r1', spec: { kind: 'native', target: 'x' }, match: { component: 'card' } }, '未知 kind'],
    [{ id: 'r1', spec: { kind: 'iframe', target: '' }, match: { component: 'card' } }, '空 target'],
    [{ id: 'r1', spec: { kind: 'builtin', target: 'card' }, match: { component: 'card' } }, '非内置来源不得注册 builtin'],
    [{ id: 'r1', spec: { kind: 'builtin', target: 'canvas' }, match: { component: 'card' }, builtin: true }, '内置 target 必须是三大形态'],
    [{ id: 'r1', spec: { kind: 'iframe', target: 'sandbox' }, match: {} }, '既无 customType 又无 component'],
    [{ id: 'r1', spec: { kind: 'iframe', target: 'sandbox' }, match: { component: 'react-root' } }, '未知 component'],
    [{ id: 'builtin:card', spec: { kind: 'iframe', target: 'sandbox:x' }, match: { component: 'card' } }, '重复 id'],
    [{ id: 'r1', builtin: true, spec: { kind: 'iframe', target: 'sandbox:x' }, match: { customType: 'bt1' } }, '自贴 builtin 不得注册'],
    [{ id: 'builtin:evil', spec: { kind: 'iframe', target: 'sandbox:x' }, match: { customType: 'bt2' } }, '伪造 builtin: 前缀 id 不得注册'],
    [{ id: 'r1', spec: { kind: 'iframe', target: 'sandbox:x' }, match: { customType: 'c1' } }, '缺 source 不得注册'],
    [{ id: 'r1', source: 'core', spec: { kind: 'iframe', target: 'sandbox:x' }, match: { customType: 'c2' } }, "冒充 'core' 来源不得注册"],
    [{ id: 'r1', source: 'ext-a', spec: { kind: 'iframe', target: 'javascript:alert(1)' }, match: { customType: 'c3' } }, 'iframe javascript: 不得注册'],
    [{ id: 'r1', source: 'ext-a', spec: { kind: 'iframe', target: 'data:text/html,x' }, match: { customType: 'c4' } }, 'iframe data: 不得注册'],
    [{ id: 'r1', source: 'ext-a', spec: { kind: 'iframe', target: 'file:///C:/' }, match: { customType: 'c5' } }, 'iframe file: 不得注册'],
    [{ id: 'r1', source: 'ext-a', spec: { kind: 'iframe', target: 'http://127.0.0.1:8080/admin' }, match: { customType: 'c6' } }, 'iframe 明文 http 私网不得注册'],
  ]
  for (const [input, why] of rejects) {
    const result = registerRenderer(input)
    assert.equal(result.ok, false, `${why} 必须被拒`)
    assert.equal(typeof result.error, 'string', `${why} 必须给出原因`)
  }
  // 全部被拒后注册表里仍然只有三个内置项 —— 拒绝对注册表零副作用
  assert.equal(listRenderers().length, 3)
})

test('注册表：保留前缀 ui. 不得被第三方注册（防劫持内置插件类型）', () => {
  resetRegistry()
  const reserved = registerRenderer({
    id: 'hijack',
    source: 'evil-ext',
    spec: { kind: 'iframe', target: 'sandbox:evil' },
    match: { customType: 'ui.plugin' },
  })
  assert.equal(reserved.ok, false, 'ui.plugin 是内置类型，第三方不得抢占')
  assert.match(reserved.error, /保留前缀/)
  assert.equal(getRenderer('hijack'), undefined)
  // 批次①对抗审查 S2/D3b：空白与大小写变体同样不得绕过
  for (const variant of [' ui.plugin', 'UI.plugin', 'ui.PLUGIN ', '\tui.plugin']) {
    const result = registerRenderer({
      id: 'hijack',
      source: 'evil-ext',
      spec: { kind: 'iframe', target: 'sandbox:evil' },
      match: { customType: variant },
    })
    assert.equal(result.ok, false, `保留前缀变体 ${JSON.stringify(variant)} 不得注册`)
    assert.match(result.error, /保留前缀/)
  }
})

test('注册表：customType 独占，重复注册被拒（防止两条消息被两个渲染器抢）', () => {
  resetRegistry()
  const first = registerRenderer({
    id: 'ext-a',
    source: 'ext-a',
    spec: { kind: 'iframe', target: 'sandbox:a' },
    match: { customType: 'build-status' },
  })
  assert.equal(first.ok, true)
  const second = registerRenderer({
    id: 'ext-b',
    source: 'ext-b',
    spec: { kind: 'iframe', target: 'sandbox:b' },
    match: { customType: 'build-status' },
  })
  assert.equal(second.ok, false, '同一 customType 不得被两个渲染器注册')
  assert.match(second.error, /已被占用/)
  // 批次①对抗审查 S2：大小写/空白变体也算占用
  const third = registerRenderer({
    id: 'ext-c',
    source: 'ext-c',
    spec: { kind: 'iframe', target: 'sandbox:c' },
    match: { customType: ' Build-Status ' },
  })
  assert.equal(third.ok, false, '规范化后相同的 customType 同样占用')
})

test('注册表：第三方只能按 customType 注册，不得抢占 component 形态（跨扩展劫持防线）', () => {
  resetRegistry()
  // 形态级匹配是"按消息长相选渲染器"，谁都能注册就等于谁都能接走别人的消息：
  // 扩展 A 注册 {component:'card'} 即可渲染扩展 B（乃至内置 ui.plugin）的全部卡片。
  const grab = registerRenderer({
    id: 'grab-all-cards',
    source: 'ext-grab',
    spec: { kind: 'iframe', target: 'sandbox:evil' },
    match: { component: 'card' },
  })
  assert.equal(grab.ok, false, '非内置来源不得按 component 形态注册')
  assert.match(grab.error, /component/)
  assert.equal(getRenderer('grab-all-cards'), undefined)
  // 内置来源自己可以（三个形态渲染器就是这么装上的）
  assert.equal(listRenderers().filter((item) => item.match.component).length, 3)
})

test('注册表：解析优先级 customType 精确匹配 > 内置 component 形态 > 内置 card 兜底', () => {
  resetRegistry()
  assert.equal(registerRenderer({
    id: 'ext-chart',
    source: 'ext-chart',
    spec: { kind: 'iframe', target: 'sandbox:chart' },
    match: { customType: 'chart' },
  }).ok, true)

  assert.equal(
    resolveRenderer({ customType: 'chart', component: 'html' }).id,
    'ext-chart',
    'customType 精确匹配优先于任何 component 形态'
  )
  assert.equal(
    resolveRenderer({ customType: 'other', component: 'text' }).id,
    'builtin:text',
    '未命中 customType 时回落到内置同名形态'
  )
  assert.equal(
    resolveRenderer({ customType: 'other', component: 'html' }).id,
    'builtin:html'
  )
  assert.equal(
    resolveRenderer({ customType: 'other', component: 'card' }).id,
    'builtin:card'
  )
  // 第三方渲染器只对自己声明的 customType 生效，绝不越界
  assert.equal(resolveRenderer({ customType: 'text', component: 'text' }).id, 'builtin:text')
})

test('注册表：内置渲染器不可注销，unregisterSource 只清第三方且返回真实数量', () => {
  resetRegistry()
  assert.equal(unregisterRenderer('builtin:card'), false, '内置渲染器不得被注销')
  assert.ok(getRenderer('builtin:card'), '内置渲染器必须还在')

  registerRenderer({ id: 'x1', source: 'ext-x', spec: { kind: 'iframe', target: 'sandbox:s' }, match: { customType: 'x1' } })
  registerRenderer({ id: 'x2', source: 'ext-x', spec: { kind: 'iframe', target: 'sandbox:s' }, match: { customType: 'x2' } })
  registerRenderer({ id: 'y1', source: 'ext-y', spec: { kind: 'iframe', target: 'sandbox:s' }, match: { customType: 'y1' } })

  assert.equal(unregisterSource('ext-x'), 2, '必须返回实际注销数量')
  assert.equal(getRenderer('x1'), undefined)
  assert.equal(getRenderer('y1')?.id, 'y1', '别的来源不受影响')
  assert.equal(listRenderers().length, 4, '三个内置 + y1')
  // 卸载不存在的来源返回 0（不得误报）
  assert.equal(unregisterSource('ext-none'), 0)

  assert.equal(unregisterRenderer('y1'), true)
  assert.equal(unregisterRenderer('y1'), false, '重复注销返回 false')
})

test('注册表：非受信输入不会抛错（形状校验必须 fail-safe）', () => {
  resetRegistry()
  const weird = [
    { id: 'a', spec: null, match: { component: 'card' } },
    { id: 'b', spec: 'not-an-object', match: { component: 'card' } },
    { id: 'c', spec: { kind: 'iframe', target: 42 }, match: { component: 'card' } },
    { id: 'd', spec: { kind: 'iframe', target: 's' }, match: { customType: 42 } },
    { id: 'e', spec: { kind: 'iframe', target: 's' }, match: { customType: 'ok', component: 7 } },
    { id: 42, spec: { kind: 'iframe', target: 's' }, match: { component: 'card' } },
  ]
  for (const input of weird) {
    assert.doesNotThrow(() => registerRenderer(input), `输入 ${JSON.stringify(input)} 不得抛错`)
  }
})

// ---------------------------------------------------------------------------
// 二、挂载点（slot）注册与"插件无声消失"诊断
// ---------------------------------------------------------------------------

test('挂载点：注册/注销/列举，注销函数幂等', () => {
  resetRegistry()
  assert.equal(isSlotMounted('float'), false)
  const off = registerSlotHost('float', 'float')
  assert.equal(isSlotMounted('float'), true)
  assert.deepEqual(listSlotHosts().find((item) => item.slot === 'float').hosts, ['float'])
  // 同槽多宿主
  const off2 = registerSlotHost('float', 'sidebar')
  assert.deepEqual(listSlotHosts().find((item) => item.slot === 'float').hosts.sort(), ['float', 'sidebar'])
  off()
  assert.equal(isSlotMounted('float'), true, '还有一个宿主，槽位仍算已挂载')
  off2()
  assert.equal(isSlotMounted('float'), false)
  off2()
  assert.equal(isSlotMounted('float'), false, '重复注销不得抛错')
  // listSlotHosts 永远覆盖四个槽（缺省空数组，便于诊断面板直接渲染）
  assert.equal(listSlotHosts().length, 4)
})

test('挂载点：非法 slot 返回 noop 注销函数', () => {
  resetRegistry()
  const off = registerSlotHost('nowhere', 'x')
  assert.equal(typeof off, 'function')
  assert.doesNotThrow(() => off())
  assert.equal(listSlotHosts().every((item) => item.hosts.length === 0), true)
})

test('诊断：有内容却没有宿主的槽位必须被点名（插件消息不得无声消失）', () => {
  resetRegistry()
  const messages = [
    { slot: 'timeline', customType: 'ui.plugin' },
    { slot: 'float', customType: 'ui.plugin' },
  ]
  assert.deepEqual(unhostedSlotsWithContent(messages).sort(), ['float', 'timeline'])
  const off = registerSlotHost('timeline', 'timeline')
  assert.deepEqual(unhostedSlotsWithContent(messages), ['float'], '已挂载的槽位不再被点名')
  off()
  assert.deepEqual(unhostedSlotsWithContent([]), [], '没有消息就不是问题')
  assert.deepEqual(unhostedSlotsWithContent(undefined), [], 'undefined 输入不得崩')
})

test('分发：messagesForSlot 只挑本槽消息，永不返回 undefined', () => {
  resetRegistry()
  const messages = [
    { slot: 'status', customType: 'a' },
    { slot: 'settings', customType: 'b' },
    { slot: 'status', customType: 'c' },
  ]
  assert.deepEqual(messagesForSlot('status', messages).map((m) => m.customType), ['a', 'c'])
  assert.deepEqual(messagesForSlot('float', messages), [])
  assert.deepEqual(messagesForSlot('float', undefined), [])
  assert.equal(slotHasContent('status', messages), true)
  assert.equal(slotHasContent('float', messages), false)
})

// ---------------------------------------------------------------------------
// 三、订阅
// ---------------------------------------------------------------------------

test('订阅：一个 listener 抛错不得影响其它 listener，也不得影响注册表写入', () => {
  resetRegistry()
  let good = 0
  const offThrow = subscribeRenderers(() => {
    throw new Error('监听器内部炸了')
  })
  const offGood = subscribeRenderers(() => {
    good += 1
  })
  const result = registerRenderer({
    id: 'sub-1',
    source: 'ext-sub',
    spec: { kind: 'iframe', target: 'sandbox:s' },
    match: { customType: 'sub-1' },
  })
  assert.equal(result.ok, true, '订阅者异常不得让注册失败')
  assert.ok(getRenderer('sub-1'), '注册必须已生效')
  assert.equal(good, 1, '坏 listener 不得阻断好 listener')

  offGood()
  registerRenderer({ id: 'sub-2', source: 'ext-sub', spec: { kind: 'iframe', target: 'sandbox:s' }, match: { customType: 'sub-2' } })
  assert.equal(good, 1, '取消订阅后不得再接通知')
  offThrow()
})

// ---------------------------------------------------------------------------
// 四、四槽在真实源码里确实挂上了（承重断言）
// ---------------------------------------------------------------------------

const MOUNTS = {
  timeline: '<PluginHostslot="timeline"hostId="timeline"',
  float: '<PluginHostslot="float"hostId="float"limit={2}',
  status: '<PluginHostslot="status"hostId="composer"variant="inline"',
  settings: '<PluginHostslot="settings"hostId="settings"messages={pluginSettingsMessages}',
}

test('承重：四个槽位各有真实宿主挂载（timeline/float/status 在主界面，settings 在设置页）', () => {
  for (const slot of ['timeline', 'float', 'status']) {
    assertCode(appSource, MOUNTS[slot], `${slot} 槽宿主的真实挂载点`)
  }
  assertCode(settingsSource, MOUNTS.settings, 'settings 槽宿主的真实挂载点')
})

test('承重：宿主挂载点吃诱饵字符串 —— 掏空模板换成字符串常量必须变红', () => {
  // 变异 1：只留下一个内容完全相同的字符串常量（历史上这类诱饵让 8 条断言全绿）
  for (const [slot, needle] of Object.entries(MOUNTS)) {
    const source = slot === 'settings' ? settingsSource : appSource
    const { shape, literal } = shapeWithLiteralMask(decoyOnly(needle))
    assert.equal(indexOfCode(shape, literal, needle), -1, `${slot}：诱饵字符串不得算作命中`)
  }
  // 变异 2：真实模板被改成别的槽位（这里是 float → timeline）后，float 断言必须失败
  const mutated = appSource.replace('slot="float"', 'slot="timeline"')
  assert.notEqual(mutated, appSource, '变异必须真的改动了源码')
  assert.equal(codeAt(mutated, MOUNTS.float), -1, 'float 槽被改掉后必须找不到')
  assert.ok(codeAt(mutated, MOUNTS.timeline) >= 0, '改后的 timeline 仍在（证明只是搬运，不是整体删除）')
  // 变异 3（批次①对抗审查 D4）：字符串字面量里的 `<!--` 不得让 stripHtmlComments
  // 吞掉其后的真实代码。诱饵字符串放在真实挂载点之前，剥注释后真实挂载必须还在。
  const baited = `const __bait = '前缀 <!-- 诱饵'\n${appSource}`
  assert.ok(
    codeAt(stripHtmlComments(baited), MOUNTS.timeline) >= 0,
    '字符串内的 <!-- 不得吞掉其后的真实挂载（D4 假阴防线）'
  )
  // 而真实模板注释里的宿主必须仍被剥掉（M1 原始防线不回退）
  const commented = appSource.replace(
    '<PluginHost slot="timeline"',
    `<!-- 被注释的宿主 <PluginHost slot="timeline" -->\n  <PluginHost slot="timeline"`,
  )
  assert.equal(
    codeAt(stripHtmlComments(commented), MOUNTS.timeline),
    codeAt(appSource, MOUNTS.timeline),
    '真实模板注释仍被剥除；注释内的宿主不算命中（M1 防线）'
  )
  // 批次②对抗审查（5ad7f0d5 #1 实证吞代码场景）：字符串内 `<!--` 后面如果跟有
  // 真实 `-->`，假屏蔽实现会把中间的**真实代码**当注释吞掉。两个吞代码断言：
  // (a) 字符串内完整 `<!-- -->` 对 —— 剥注释后字符串必须原样保留、真实挂载不丢；
  const baitPair = `const __bait = 'a <!-- b -->'\n${appSource}`
  assert.ok(
    baitPair.includes("const __bait = 'a <!-- b -->'") && stripHtmlComments(baitPair).includes("const __bait = 'a <!-- b -->'"),
    '字符串内的完整注释对必须原样保留（不得被剥）'
  )
  assert.ok(
    codeAt(stripHtmlComments(baitPair), MOUNTS.timeline) >= 0,
    '字符串内注释对之后的真实挂载不得被吞'
  )
  // (b) 字符串内未闭合 `<!--` + 其后真实注释 `-->` —— 假屏蔽会把字符串闭合引号到
  // 真实 `-->` 之间的所有代码吞掉；真屏蔽必须只剥真实注释。
  const baitUnclosed = `const s = 'a <!-- b'\nkeepMarker();\n<!-- real -->\n${appSource}`
  const strippedUnclosed = stripHtmlComments(baitUnclosed)
  assert.ok(
    strippedUnclosed.includes('keepMarker()'),
    '字符串内未闭合 <!-- 不得吞掉其后的真实代码（假屏蔽实证吞 keep2() 场景）'
  )
  assert.ok(
    !strippedUnclosed.includes('<!-- real -->'),
    '真实注释 <!-- real --> 仍必须被剥掉'
  )
  assert.ok(
    codeAt(strippedUnclosed, MOUNTS.timeline) >= 0,
    '吞代码场景之后真实挂载必须幸存'
  )
})

test('承重：App.svelte 已改由注册表分发，旧的单槽硬编码装配必须消失', () => {
  assertCode(appSource, "importPluginHostfrom'./PluginHost.svelte'", 'PluginHost 导入')
  assert.equal(
    codeAt(appSource, 'filter((m)=>m.slot===\'timeline\')'),
    -1,
    '旧的 timeline-only 硬编码过滤必须被删除（否则 float/settings/status 依旧渲染不出来）'
  )
  assert.equal(
    codeAt(appSource, "importPluginCardfrom'./PluginCard.svelte'"),
    -1,
    'App.svelte 不再直接渲染 PluginCard（改由 PluginHost 按注册表解析渲染器）'
  )
  // 四槽共用同一份会话插件消息源，保证不会出现"某个槽读了空数组"
  const { shape: appShape } = shapeWithLiteralMask(appSource)
  const wired = appShape.split('messages={runState[activeSessionId]?.pluginMessages??[]}').length - 1
  assert.equal(wired, 3, 'timeline/status/float 三个宿主都必须接上会话插件消息')
})

test('承重：PluginHost 同步返回注销函数、渲染管线收在纯函数、inline 形态保留', () => {
  assertCode(
    hostSource,
    'onMount(()=>{returnregisterSlotHost(slot,hostId)})',
    'onMount 必须同步返回注销函数（否则宿主卸载后槽位永远算"已挂载"）'
  )
  // 批次①对抗审查 D3 修补：渲染管线（槽过滤/limit/解析）收进可单测的纯函数，
  // 宿主组件只剩对它的调用 —— 旧的内联管线（slice(-limit)/resolveRenderer 内联 map）已删。
  assertCode(
    hostSource,
    '$:entries=selectVisibleEntries(slot,messages,limit)',
    '渲染管线必须调用 selectVisibleEntries 纯函数（可单测，防渲染变异全绿）'
  )
  assert.equal(
    codeAt(hostSource, 'slotMessages=messages.filter'),
    -1,
    '旧的内联槽过滤必须删除（管线已收进 selectVisibleEntries）'
  )
  assert.equal(
    codeAt(hostSource, 'resolveRenderer(message)'),
    -1,
    '宿主组件内不得内联调用 resolveRenderer（必须经纯函数）'
  )
  assertCode(hostSource, '(pluginEntryKey(entry,index))', 'each key 必须经 pluginEntryKey（D2：无分隔符拼接会碰撞）')
  assertCode(hostSource, 'data-slot={slot}', '容器必须带 data-slot 便于真机排查')
  // inline 变体是 status 槽的形状，不能退化成整卡片
  assertCode(hostSource, 'class="plugin-status-chip"', 'status 槽的胶囊形态')
  assert.equal(
    codeAt(hostSource, 'entry.message.timestamp+entry.message.customType+index'),
    -1,
    '旧的 key 无分隔符拼接必须删除（"0"+"a1"+1 ≡ "0"+"a11"+1 碰撞）'
  )
})

test('渲染管线：selectVisibleEntries 槽过滤/limit/解析每一步真实执行（杀渲染变异）', () => {
  resetRegistry()
  const mk = (customType, slot, timestamp, entryId) => ({
    customType,
    slot,
    timestamp,
    component: 'card',
    title: customType,
    fields: [],
    body: '',
    tone: 'accent',
    ...(entryId ? { entryId } : {}),
  })
  const messages = [
    mk('a', 'timeline', 1),
    mk('b', 'status', 2),
    mk('c', 'timeline', 3, 'entry-c'),
    mk('d', 'timeline', 4),
  ]
  // 槽过滤真实执行：其它槽的消息不得混入（变异"删 slot 过滤"在此变红）
  const all = selectVisibleEntries('timeline', messages, 0)
  assert.deepEqual(all.map((entry) => entry.message.customType), ['a', 'c', 'd'], '只返回本槽消息')
  // limit 保留最近 N 条（变异 slice(-limit)→slice(0,limit) 在此变红）
  const limited = selectVisibleEntries('timeline', messages, 2)
  assert.deepEqual(limited.map((entry) => entry.message.customType), ['c', 'd'], 'limit 必须保留最后 N 条')
  assert.equal(selectVisibleEntries('timeline', messages, 0).length, 3, 'limit=0 不限制')
  assert.deepEqual(selectVisibleEntries('timeline', 42, 3), [], '非数组输入按空处理（S6）')
  assert.deepEqual(selectVisibleEntries('timeline', undefined, 3), [])
  // 渲染器解析真实来自注册表（变异"本地同名 resolveRenderer 恒返回内置"在此变红）
  assert.equal(
    registerRenderer({
      id: 'pipe-a',
      source: 'ext-pipe',
      spec: { kind: 'iframe', target: 'sandbox:pipe' },
      match: { customType: 'a' },
    }).ok,
    true
  )
  const resolved = selectVisibleEntries('timeline', messages, 0)
  assert.equal(resolved[0].renderer.id, 'pipe-a', '渲染器必须来自注册表解析')
  assert.equal(resolved[1].renderer.id, 'builtin:card', '未注册的回落内置 card')
  // key：有 entryId 用 entryId（D5），无 entryId 用带分隔符复合键（D2：旧的拼接会碰撞）
  assert.equal(pluginEntryKey(resolved[1], 1), 'entry-c', '有 entryId 时 key 必须用 entryId')
  assert.equal(pluginEntryKey(resolved[0], 0), '1:a:0', `无 entryId 时复合键带分隔符（got ${pluginEntryKey(resolved[0], 0)}）`)
  // D2 碰撞回归：ts=0/ct=a1/i=1 与 ts=0/ct=a11/i=1 旧实现同为 "0a11"
  const collideA = pluginEntryKey({ message: mk('a1', 'timeline', 0) }, 1)
  const collideB = pluginEntryKey({ message: mk('a11', 'timeline', 0) }, 1)
  assert.notEqual(collideA, collideB, '旧拼接 "0a11" 的碰撞对必须产生不同 key')
})

test('承重：Settings.svelte 新增「插件 UI」页并接入注册表快照与扩展 UI 诊断', () => {
  assertCode(settingsSource, "{:elseiftab==='plugins'}", '「插件 UI」页的模板分支')
  assertCode(settingsSource, "['plugins','插件UI']", '侧栏导航项')
  assertCode(
    settingsSource,
    "typeTab='general'|'appearance'|'notify'|'keys'|'proxy'|'agents'|'imagegen'|'git'|'skills'|'extensions'|'plugins'|'mcp'",
    'Tab 联合类型必须含 plugins'
  )
  assertCode(settingsSource, "rpc('ext_ui_diagnostics',{})", '诊断数据源必须真的调用（该 RPC 此前前端零调用）')
  assertCode(settingsSource, "pluginRenderers=tab==='plugins'?listRenderers():[]", '渲染器列表取自注册表，不得硬编码')
  assertCode(settingsSource, "pluginMessages.filter((item)=>item.slot==='settings')", 'settings 槽消息过滤')
})

test('承重：App.svelte 把会话插件消息透传给设置页', () => {
  assertCode(
    appSource,
    'rpc={request}activeSessionId={activeSessionId}pluginMessages={runState[activeSessionId]?.pluginMessages??[]}',
    'Settings 必须收到 pluginMessages，否则「插件 UI」页永远是空的'
  )
})

// ---------------------------------------------------------------------------
// 五、样式接线（批次①对抗审查 D7：此前 6 个样式变异全绿 —— CSS 零防线）
// ---------------------------------------------------------------------------

const cssSource = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8')
const cardSource = readFileSync(new URL('../src/PluginCard.svelte', import.meta.url), 'utf8')

test('承重：四槽容器样式真实存在（删 CSS 必须变红）', () => {
  for (const needle of [
    '.plugin-host{display:contents;}',
    '.plugin-message{width:min(780px,100%);margin:0auto26px;}',
    '.plugin-status-bar{display:flex;flex-wrap:wrap;',
    '.plugin-status-chip{',
    '.plugin-status-detail{position:absolute;',
    '.plugin-float-stack{position:fixed;right:16px;bottom:88px;z-index:61;',
    '.plugin-float-stack>*{pointer-events:auto;}',
    '.plugin-settings-list{display:flex;flex-direction:column;gap:10px;',
  ]) {
    assert.ok(cssSource.replace(/\s+/g, '').includes(needle), `app.css 必须包含 ${needle}`)
  }
})

test('承重：卡片外观归属（D8）—— PluginCard 不写 margin，宿主层拥有间距', () => {
  // D8：scoped margin:10px 0 与 app.css 的槽位 margin:0 特异性平局且后注入 → margin:0 永远失效。
  // D8：scoped margin:10px 0 与 app.css 的槽位 margin:0 特异性平局且后注入 → margin:0 永远失效。
  // （先剥 HTML/CSS 注释再检查——注释里的教学文字提到 margin 是允许的，不算实现。）
  const shape = cardSource.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '')
  assert.equal(shape.includes('margin:10px0'), false, 'PluginCard scoped style 不得写 margin')
  assert.ok(shape.includes('.plug-card{padding:10px12px;'), 'PluginCard 保留 padding/border 卡片外观')
  assert.ok(
    cssSource.replace(/\s+/g, '').includes('.plugin-message.plug-card{margin:0;}'),
    'timeline 槽的卡片间距由宿主层控制'
  )
  // D9：浮层 z-index 必须高于 .ext-toasts(60)，否则被 toast 盖住
  assert.ok(cssSource.includes('z-index: 61'), 'float 槽 z-index 必须 > 60（.ext-toasts）')
})

// ---------------------------------------------------------------------------
// 六、批次②对抗审查（5ad7f0d5）承重修补：让"已修缺陷"真正被测试锁定
// （本轮审查实证：多个缺陷的修补可无红还原 —— 下列断言逐一封死变异面）
// ---------------------------------------------------------------------------

test('承重②A：fail-safe getter 抛错不得炸掉渲染管线（S5 真实现，非仅形状）', () => {
  // #10 实测：resolveRenderer({ get customType(){ throw } }) 直接抛 boom。
  // 修补后必须回落 builtin:card。getter 在 typeof 读取时就触发，try/catch 必须包住它。
  assert.equal(resolveRenderer({ get customType() { throw new Error('boom') } }).id, 'builtin:card')
  assert.equal(resolveRenderer({ get component() { throw new Error('boom') } }).id, 'builtin:card')
  const proxied = new Proxy({}, { get() { throw new Error('px') } })
  assert.equal(resolveRenderer(proxied).id, 'builtin:card')
  // 既有防线不回退：null/原始值仍回落
  for (const weird of [null, undefined, 42, 'str', [], true]) {
    assert.equal(resolveRenderer(weird).id, 'builtin:card', `resolveRenderer(${String(weird)}) 必须 fail-safe`)
  }
})

test('承重②B：normalizePluginMessage getter 抛错降级不外抛（#11）', async () => {
  const { normalizePluginMessage } = await import('../src/ui-plugins.ts')
  // fields 内单条 getter 抛错：丢字段，不炸整条消息
  const partial = normalizePluginMessage({
    customType: 'x.chart',
    display: { slot: 'timeline', component: 'card', fields: [{ get label() { throw new Error('boom') } }, { label: 'ok', value: 1 }] },
  })
  assert.ok(partial, 'fields 含抛错 getter 时消息本身必须存活')
  assert.deepEqual(partial.fields, [{ label: 'ok', value: 1 }], '只丢弃抛错字段，正常字段保留')
  // display 顶层 getter 抛错：整条消息返回 null 而不是抛；
  // content getter 抛错：按"空正文"降级（text/html 组件 body 为空串），也不外抛；
  // details getter 抛错：fields 为空数组降级，消息仍存活。
  assert.equal(normalizePluginMessage({ customType: 'x.y', get display() { throw new Error('boom') } }), null)
  const degraded = normalizePluginMessage({ customType: 'x.y', get content() { throw new Error('boom') }, display: { component: 'text' } })
  assert.ok(degraded, 'content getter 抛错时消息必须存活（空正文降级）')
  assert.equal(degraded.body, '', 'content getter 抛错 → body 空串')
  const detailsDegraded = normalizePluginMessage({ customType: 'x.y', get details() { throw new Error('boom') } })
  assert.ok(detailsDegraded, 'details getter 抛错时消息必须存活')
  assert.deepEqual(detailsDegraded.fields, [], 'details getter 抛错 → fields 空数组')
})

test('承重②C：iframe https 白名单大小写敏感锚定（#2 大写绕过封死）', () => {
  // 修补前：/^https:\/\/…/i 让 'HTTPS://evil.com' 注册成功。修补后必须拒绝。
  for (const bad of [
    'HTTPS://evil.com',
    'HTTPS://good.com',
    'sandbox:javascript:alert(1)',
    'sandbox:../../escape',
    'sandbox:',
    'sandbox:has space',
    'http://intranet.local',
    'javascript:alert(1)',
  ]) {
    const res = registerRenderer({ id: `iframe-${Math.random().toString(36).slice(2)}`, source: 'ext-t', spec: { kind: 'iframe', target: bad }, match: { customType: ` t.${Math.random().toString(36).slice(2)}` } })
    assert.equal(res.ok, false, `iframe target '${bad}' 必须被拒`)
  }
  // 正例仍通：合法 https 与合法 sandbox 标识
  const okHttps = registerRenderer({ id: 'iframe-ok-https', source: 'ext-t', spec: { kind: 'iframe', target: 'https://charts.example.com/v1/' }, match: { customType: ' t.okhttps' } })
  assert.equal(okHttps.ok, true, '合法 https target 必须通过')
  const okSandbox = registerRenderer({ id: 'iframe-ok-sandbox', source: 'ext-t', spec: { kind: 'iframe', target: 'sandbox:chart-page' }, match: { customType: ' t.oksandbox' } })
  assert.equal(okSandbox.ok, true, '合法 sandbox 标识必须通过')
})

test('承重②D：来源与内置身份大小写归一（#13）', () => {
  // 'CORE' 大写不得注册（伪装保留来源）
  const res = registerRenderer({ id: 'core-cap', source: 'CORE', spec: { kind: 'builtin', target: 'card' }, match: { component: 'card' } })
  assert.equal(res.ok, false, "'CORE' 不得冒充保留来源")
  // unregisterSource('CORE') 不得删掉任何内置渲染器
  const before = listRenderers().length
  assert.equal(unregisterSource('CORE'), 0, "unregisterSource('CORE') 必须返回 0")
  assert.equal(listRenderers().length, before, '内置渲染器不得被大小写变体注销')
  // unregisterRenderer 归属校验对大小写不敏感但仍然拒绝他源
  assert.equal(unregisterRenderer('builtin:card', 'CORE'), false, '内置不可注销（含大小写变体来源）')
})

test('承重②E：Settings 订阅接线与 PluginHost 展开态锁定（#6/#7 源码形状）', () => {
  // D6 订阅（变异：删 onMount 订阅 → 必须红）
  assertCode(
    settingsSource,
    "onMount(()=>subscribeRenderers(()=>{if(tab==='plugins')pluginRenderers=listRenderers()}))",
    'Settings 必须订阅注册表变化（D6：删订阅则「插件 UI」页停在首帧快照）'
  )
  // PluginHost 展开态（M7/M11b：expanded 比较退化/反转 → 必须红）
  assertCode(hostSource, 'expanded===entry.message.entryId', '展开态必须按 entryId 比较')
  assert.equal(codeAt(hostSource, 'expanded!==entry.message.entryId'), -1, '展开态比较不得被反转')
  // 两处 PluginCard 渲染（M8/M9：删 inline detail 或 card 分支 → 必须红）
  const { shape: hostShapeMask } = shapeWithLiteralMask(hostSourceRaw)
  const cardUses = (hostSourceRaw.match(/<PluginCard/g) ?? []).length
  const cardInShape = (hostShapeMask.match(/<PluginCard/g) ?? []).length
  assert.ok(cardUses >= 2 && cardInShape >= 2, 'inline 展开层与 card 分支都必须真的渲染 PluginCard（含字面量诱饵防线）')
})

test('承重②F：unregisterSource / 归属校验 / core 保护变异锁定（#3/#4/#5）', () => {
  resetRegistry()
  assert.equal(registerRenderer({ id: 'r-a', source: 'ext-a', spec: { kind: 'iframe', target: 'sandbox:p-a' }, match: { customType: ' a.t1' } }).ok, true)
  assert.equal(registerRenderer({ id: 'r-b', source: 'ext-b', spec: { kind: 'iframe', target: 'sandbox:p-b' }, match: { customType: ' b.t1' } }).ok, true)
  // 归属校验：ext-b 不得注销 ext-a 的渲染器（删归属校验 → 红）
  assert.equal(unregisterRenderer('r-a', 'ext-b'), false, '跨源注销必须被拒')
  assert.ok(getRenderer('r-a'), '被拒注销后渲染器仍在')
  assert.equal(unregisterRenderer('r-a', 'ext-a'), true, '本源注销必须成功')
  // core 保护：内置渲染器永不可批量注销（删 core 检查 → 红）
  const withBuiltins = listRenderers().filter((r) => r.builtin).length
  assert.ok(withBuiltins >= 3, '内置渲染器就位')
  assert.equal(unregisterSource('core'), 0)
  assert.equal(listRenderers().filter((r) => r.builtin).length, withBuiltins, 'unregisterSource 不得触碰内置渲染器')
  // builtin: 前缀伪造（删 startsWith 拒绝 → 红）
  const forged = registerRenderer({ id: 'builtin:evil', source: 'ext-x', spec: { kind: 'builtin', target: 'card' }, match: { component: 'card' } })
  assert.equal(forged.ok, false, "id 'builtin:evil' 伪造内置前缀必须被拒")
  const selfBuiltin = registerRenderer({ id: 'r-self', source: 'ext-x', builtin: true, spec: { kind: 'builtin', target: 'card' }, match: { component: 'card' } })
  assert.equal(selfBuiltin.ok, false, '自贴 builtin:true 必须被拒')
})
