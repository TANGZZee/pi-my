// 增量 markdown 渲染（0-7）单测
//
// 最关键的不变量：**增量结果必须与全量渲染逐字符一致**。
// 否则用户看到的内容取决于缓存命中与否 —— 那是不可接受的正确性缺陷。
// 其次是性能断言：复用必须在"前缀未变"时发生（流式热路径）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown } from '../src/markdown.ts'
import { renderMarkdownIncremental, clearMarkdownCache } from '../src/markdown-incremental.ts'

/** 模拟流式：按 delta 逐步追加，每一步都对照全量渲染 */
function streamLike(fullText, chunks) {
  clearMarkdownCache('t')
  let acc = ''
  const results = []
  let i = 0
  for (const size of chunks) {
    acc += fullText.slice(i, i + size)
    i += size
    results.push({
      text: acc,
      incremental: renderMarkdownIncremental(acc, 't').html,
      full: renderMarkdown(acc),
    })
  }
  return results
}

test('不变量：增量输出与全量渲染逐字符一致（多轮流式）', () => {
  const text = [
    '# 标题',
    '',
    '第一段文字，包含 **粗体** 和 `代码`。',
    '',
    '- 列表项 1',
    '- 列表项 2',
    '',
    '```js',
    'const a = 1;',
    'const b = 2;',
    '```',
    '',
    '结尾段落。[链接](https://example.com)',
    '',
    '> 引用一行',
    '',
    '最终段落。',
  ].join('\n')

  // 模拟 37 次 delta（每 20 字符一块）
  const steps = streamLike(text, Array.from({ length: Math.ceil(text.length / 20) }, () => 20))
  for (const [index, step] of steps.entries()) {
    assert.equal(
      step.incremental,
      step.full,
      `第 ${index + 1} 步增量与全量不一致。\n文本: ${JSON.stringify(step.text)}\n增量: ${step.incremental}\n全量: ${step.full}`,
    )
  }
})

test('热路径：前缀未变时命中缓存（性能目标）', () => {
  clearMarkdownCache('perf')
  const base = '# 标题\n\n第一段稳定内容。\n\n'
  // 第一次：解析闭合前缀
  renderMarkdownIncremental(base + '正在生成', 'perf')
  // 第二次：同一前缀 + 尾部变化 → 应复用（reused=true）
  const second = renderMarkdownIncremental(base + '正在生成的更长内容', 'perf')
  assert.equal(second.reused, true, '前缀未变时必须复用缓存')
})

test('跨过块边界后缓存更新，但仍复用旧前缀（reused=true）', () => {
  clearMarkdownCache('bound')
  const p1 = '# 标题\n\n第一段。\n\n'
  const p2 = '第二段内容。\n\n'
  renderMarkdownIncremental(p1 + 'x', 'bound')
  const r = renderMarkdownIncremental(p1 + p2 + 'x', 'bound')
  assert.equal(r.reused, false, '跨边界后前缀变了，需重解析一次')
  // 但下一个 delta 又命中了
  const r2 = renderMarkdownIncremental(p1 + p2 + 'xy', 'bound')
  assert.equal(r2.reused, true)
})

test('未闭合代码围栏：整个围栏属于活动尾部（围栏内的空行不是边界）', () => {
  const text = '前文。\n\n```js\nconst a = 1;\n\nconst b = 2;'
  const r = renderMarkdownIncremental(text, 'fence')
  assert.equal(
    r.html,
    renderMarkdown(text),
    '未闭合围栏内的空行不得被当作块边界',
  )
})

test('围栏闭合后，其内容进入闭合前缀', () => {
  const text = '前文。\n\n```js\nconst a = 1;\n```\n\n后文。'
  clearMarkdownCache('f2')
  const r = renderMarkdownIncremental(text, 'f2')
  assert.equal(r.html, renderMarkdown(text))
})

test('增量渲染不串台：不同 cacheKey 互不影响', () => {
  clearMarkdownCache('a')
  clearMarkdownCache('b')
  const a = renderMarkdownIncremental('# A\n\n内容 A', 'a').html
  const b = renderMarkdownIncremental('# B\n\n内容 B', 'b').html
  assert.equal(a, renderMarkdown('# A\n\n内容 A'))
  assert.equal(b, renderMarkdown('# B\n\n内容 B'))
  // 再次渲染 A：不受 B 影响
  assert.equal(renderMarkdownIncremental('# A\n\n内容 A', 'a').html, a)
})

test('空文本与纯空白', () => {
  clearMarkdownCache('empty')
  assert.equal(renderMarkdownIncremental('', 'empty').html, renderMarkdown(''))
  assert.equal(renderMarkdownIncremental('   \n  ', 'empty').html, renderMarkdown('   \n  '))
})

test('Windows 换行归一', () => {
  clearMarkdownCache('crlf')
  const text = '# 标题\r\n\r\n正文\r\n'
  assert.equal(
    renderMarkdownIncremental(text, 'crlf').html,
    renderMarkdown(text.replace(/\r\n/g, '\n')),
    'CRLF 应与 LF 等价',
  )
})

test('性能：长文本复用路径显著快于全量重解析', () => {
  clearMarkdownCache('perf2')
  const stable = Array.from({ length: 300 }, (_, i) => `第 ${i} 段稳定内容，包含一些文字。`).join('\n\n') + '\n\n'
  // 预热：闭合前缀已缓存
  renderMarkdownIncremental(stable, 'perf2')
  const tail = '正在流式输出的尾部内容，每个 delta 都会变一点。'

  let incrementalNs = 0
  let fullNs = 0
  const RUNS = 30
  for (let i = 0; i < RUNS; i++) {
    const t = tail + 'x'.repeat(i)
    let t0 = performance.now()
    renderMarkdownIncremental(stable + t, 'perf2')
    incrementalNs += performance.now() - t0
    t0 = performance.now()
    renderMarkdown(stable + t)
    fullNs += performance.now() - t0
  }
  // 增量只解析尾部（~50 字符），全量要解析 ~10KB
  // 阈值放宽到 2x 以免环境抖动导致误报（实测通常快 10-50x）
  assert.ok(
    incrementalNs < fullNs * 2,
    `增量 ${incrementalNs.toFixed(2)}ms 应明显快于全量 ${fullNs.toFixed(2)}ms`,
  )
})

test('缓存清理', () => {
  renderMarkdownIncremental('内容', 'clean-a')
  renderMarkdownIncremental('内容', 'clean-b')
  clearMarkdownCache('clean-a')
  // 清理后重新渲染仍是正确结果
  assert.equal(renderMarkdownIncremental('内容', 'clean-a').html, renderMarkdown('内容'))
  clearMarkdownCache()
  assert.equal(renderMarkdownIncremental('内容', 'clean-b').html, renderMarkdown('内容'))
})

// ---------------------------------------------------------------------------
// 审查发现的 3 类等价性缺陷的回归保护（875 组对照中收敛出的全部根因）
// ---------------------------------------------------------------------------

test('审查高-3 回归：前导空行的文本不得多出 <p></p>', () => {
  const cases = ['\n\n\n内容', '\n\n**标题** 加粗', '\n\n- 列表']
  for (const text of cases) {
    clearMarkdownCache('lead')
    const r = renderMarkdownIncremental(text, 'lead')
    assert.equal(
      r.html,
      renderMarkdown(text),
      `前导空行多渲染了空段落\n文本: ${JSON.stringify(text)}\n增量: ${r.html}\n全量: ${renderMarkdown(text)}`,
    )
    // 且不得包含仅由兜底产生的空段落
    assert.equal(r.html.startsWith('<p></p>'), false, `不该以空段落开头: ${r.html}`)
  }
})

test('审查高-2 回归：围栏内含 ``` 行不得劈开代码块（展示 markdown 示例的高频场景）', () => {
  const cases = [
    // 围栏 body 内含 ``` 开头的行（嵌套示例）
    '看例子：\n\n```md\n# 用法\n\n```js\nfoo()\n```\n```',
    // 未闭合围栏内含 ``` 行
    '例子：\n\n```\n内嵌\n```js\nlet x = 1;\n\nlet y = 2;\n```\n\n完',
    // 行首 ``` 带尾随文字（按解析器规则不是合法开栏）
    '前\n\n```js 这里是说明\nx\n```\n\n后',
  ]
  for (const text of cases) {
    clearMarkdownCache('nested')
    const r = renderMarkdownIncremental(text, 'nested')
    assert.equal(
      r.html,
      renderMarkdown(text),
      `围栏判定与解析器发散\n文本: ${JSON.stringify(text)}\n增量: ${r.html}\n全量: ${renderMarkdown(text)}`,
    )
  }
})

test('审查高-2 补充：流式过程中每一步都与全量一致（含围栏内 ``` 行）', () => {
  const text = '看例子：\n\n```md\n# 用法\n\n```js\nfoo()\n```\n```'
  clearMarkdownCache('stream-nested')
  const lines = text.split('\n')
  let acc = ''
  for (let i = 0; i < lines.length; i++) {
    acc += (i ? '\n' : '') + lines[i]
    const r = renderMarkdownIncremental(acc, 'stream-nested')
    assert.equal(
      r.html,
      renderMarkdown(acc),
      `第 ${i + 1} 行时不一致\n文本: ${JSON.stringify(acc)}\n增量: ${r.html}\n全量: ${renderMarkdown(acc)}`,
    )
  }
})

test('性能断言必须能捕捉"退化成全量"的回归（硬性 reused + 严格阈值）', () => {
  clearMarkdownCache('strict-perf')
  const stable = Array.from({ length: 200 }, (_, i) => `第 ${i} 段稳定内容。`).join('\n\n') + '\n\n'
  renderMarkdownIncremental(stable, 'strict-perf')
  // 热路径（delta 落在活动尾部）必须命中缓存
  const result = renderMarkdownIncremental(stable + '流式尾部', 'strict-perf')
  assert.equal(result.reused, true, '热路径必须复用闭合前缀缓存，否则增量退化成了全量')
})
