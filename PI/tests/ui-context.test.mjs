// 扩展 UI 上下文桥单测（0-4）
//
// 这些断言的依据来自两个参考项目踩过的坑：
//   - percho issue #28：ui.theme 给成字符串 → 所有 MCP 服务器永久无法连接
//     （pi-mcp-adapter 在 updateStatusBar 里调 ui.theme.fg() 抛 TypeError）
//   - percho issue #32/#36：降级静默返回 undefined → "零线索"不可诊断
//   - pi-agent-desktop issue #31：插件在 CLI 能用、桌面端不能用（~25 个 no-op 空壳）
import test from 'node:test'
import assert from 'node:assert/strict'
import { createUiContext, extensionNameFromStack, resetUnsupportedReportCache } from '../sidecar/ui-context.ts'

function makeContext(overrides = {}) {
  const logs = []
  const notifications = []
  const editorTexts = []
  const ctx = createUiContext({
    dialogs: {
      confirm: async () => true,
      select: async () => 'picked',
      input: async () => 'typed',
      editor: async () => 'edited',
      ...(overrides.dialogs ?? {}),
    },
    notify: (message, type, source) => notifications.push({ message, type, source }),
    setEditorText: (text, source) => editorTexts.push({ text, source }),
    log: (message, detail) => logs.push({ message, detail }),
    ...(overrides.rest ?? {}),
  })
  return { ctx, logs, notifications, editorTexts }
}

test('theme 必须是真实 Theme 类实例（percho #28：字符串会让 MCP 全挂）', () => {
  const { ctx } = makeContext()
  assert.ok(ctx.theme, 'theme 必须存在')
  assert.equal(typeof ctx.theme, 'object', 'theme 不能是字符串')
  assert.equal(typeof ctx.theme.fg, 'function', 'theme.fg 必须可调用')
  // 扩展实际会调用的方法都要在（漏一个就 TypeError）
  for (const method of ['fg', 'bg', 'bold', 'italic', 'getFgAnsi', 'getBgAnsi']) {
    assert.equal(typeof ctx.theme[method], 'function', `theme.${method} 缺失`)
  }
  // 真调用一次，确认不抛（这就是 pi-mcp-adapter 崩溃的那行）
  assert.doesNotThrow(() => ctx.theme.fg('accent', 'hello'))
})

test('四件套桥到宿主并返回值', async () => {
  const { ctx } = makeContext()
  assert.equal(await ctx.confirm('t', 'm'), true)
  assert.equal(await ctx.select('t', ['a', 'b']), 'picked')
  assert.equal(await ctx.input('t', 'ph'), 'typed')
  assert.equal(await ctx.editor('t', 'pre'), 'edited')
})

test('取消语义诚实：宿主返回 undefined 时不得伪造输入', async () => {
  const { ctx } = makeContext({
    dialogs: { select: async () => undefined, input: async () => undefined, editor: async () => undefined },
  })
  assert.equal(await ctx.select('t', ['a']), undefined, 'select 取消必须是 undefined')
  assert.equal(await ctx.input('t'), undefined, 'input 取消必须是 undefined')
  assert.equal(await ctx.editor('t'), undefined, 'editor 取消必须是 undefined')
  // confirm 是布尔，取消即 false
  const denied = makeContext({ dialogs: { confirm: async () => false } })
  assert.equal(await denied.ctx.confirm('t', 'm'), false)
})

test('未实现的 TUI 方法必须记日志（percho #32/#36：不能静默）', () => {
  resetUnsupportedReportCache()
  const { ctx, logs } = makeContext()
  ctx.setWidget('k', ['x'])
  ctx.setFooter(() => {})
  ctx.setHeader(() => {})
  ctx.setWorkingMessage('busy')
  assert.ok(logs.length >= 4, `应记录至少 4 条未实现告警，实际 ${logs.length}`)
  for (const entry of logs) {
    assert.match(entry.message, /未在桌面端实现|未实现/, `日志内容应可诊断: ${entry.message}`)
  }
})

test('未实现告警按方法去重（避免刷屏）', () => {
  resetUnsupportedReportCache()
  const { ctx, logs } = makeContext()
  ctx.setWidget('a', ['x'])
  ctx.setWidget('b', ['y'])
  ctx.setWidget('c', ['z'])
  const setWidgetLogs = logs.filter((entry) => entry.message.includes('setWidget'))
  assert.equal(setWidgetLogs.length, 1, 'setWidget 反复调用只应记一次')
})

test('setTheme 诚实返回失败（假成功会让扩展误判）', () => {
  const { ctx } = makeContext()
  const result = ctx.setTheme('dark')
  assert.equal(result.success, false)
  assert.match(result.error, /Pi-My/)
})

test('getEditorText 返回空串（同步跨进程读不可能，对齐官方 RPC 降级）', () => {
  const { ctx } = makeContext()
  assert.equal(ctx.getEditorText(), '')
})

test('notify 带来源归因', () => {
  const { ctx, notifications } = makeContext()
  ctx.notify('hello', 'warning')
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].message, 'hello')
  assert.equal(notifications[0].type, 'warning')
  // source 允许为空串（拿不到扩展名时），但字段必须存在
  assert.equal(typeof notifications[0].source, 'string')
})

test('notify 默认类型是 info', () => {
  const { ctx, notifications } = makeContext()
  ctx.notify('x')
  assert.equal(notifications[0].type, 'info')
})

test('setEditorText / pasteToEditor 都进草稿', () => {
  const { ctx, editorTexts } = makeContext()
  ctx.setEditorText('a')
  ctx.pasteToEditor('b')
  assert.deepEqual(editorTexts.map((entry) => entry.text), ['a', 'b'])
})

test('setStatus / setTitle 有回调时转发，无回调时走告警', () => {
  resetUnsupportedReportCache()
  const statuses = []
  const titles = []
  const withHost = makeContext({ rest: { onStatus: (k, t) => statuses.push([k, t]), onTitle: (t) => titles.push(t) } })
  withHost.ctx.setStatus('k', 'v')
  withHost.ctx.setTitle('T')
  assert.deepEqual(statuses, [['k', 'v']])
  assert.deepEqual(titles, ['T'])
  assert.equal(withHost.logs.length, 0, '有宿主时不该记"未实现"')

  resetUnsupportedReportCache()
  const without = makeContext()
  without.ctx.setStatus('k', 'v')
  assert.ok(without.logs.some((entry) => entry.message.includes('setStatus')))
})

test('extensionNameFromStack 从路径推断扩展名', () => {
  const fromExtensions = extensionNameFromStack(
    'Error\n    at /home/u/.pi/agent/extensions/my-tool.ts:12:3\n    at node:internal/x',
  )
  assert.equal(fromExtensions, 'my-tool')

  const fromNodeModules = extensionNameFromStack(
    'Error\n    at /app/node_modules/@scope/pkg/index.js:1:1',
  )
  assert.equal(fromNodeModules, '@scope/pkg')

  // 宿主自身帧应被跳过 → 无归因
  assert.equal(extensionNameFromStack('Error\n    at /x/node_modules/@earendil-works/pi-coding-agent/dist/index.js:1:1'), '')
  assert.equal(extensionNameFromStack(''), '')
  assert.equal(extensionNameFromStack(undefined), '')
})

test('getToolsExpanded / addAutocompleteProvider 等辅助方法存在且不抛', () => {
  resetUnsupportedReportCache()
  const { ctx } = makeContext()
  assert.equal(ctx.getToolsExpanded(), false)
  assert.equal(ctx.getEditorComponent(), undefined)
  assert.deepEqual(ctx.getAllThemes(), [])
  assert.equal(ctx.getTheme(), undefined)
  assert.doesNotThrow(() => {
    ctx.setToolsExpanded(true)
    ctx.addAutocompleteProvider(() => {})
    ctx.setEditorComponent(() => {})
    const dispose = ctx.onTerminalInput(() => {})
    if (typeof dispose === 'function') dispose()
  })
})
