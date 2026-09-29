// 增量 markdown 渲染（0-7）
//
// 为什么需要：`MarkdownView` 在流式期间每个 delta 都调 `renderMarkdown(全文)`，
// 旧实现对整个文本从头解析 —— 长回复是 O(N²) CPU（每个 delta 重解析全部已确定内容）。
// 而流式的特点是**前面已闭合的块永远不再变**：只有最后一个块在生长。
//
// 策略（保持简单，宁可少缓存也不能错）：
//   1. 把文本切成「闭合前缀 + 活动尾部」。闭合前缀 = 最后一个安全边界之前的内容。
//      安全边界 = 空行，且不在未闭合代码围栏内。
//   2. 闭合前缀按其原始文本做 key 缓存 HTML；key 相同（说明前缀没变）→ 直接复用。
//      追加式生长时前缀的 key 会在块边界处"步进"变化，此时解析量只有新增块。
//   3. 活动尾部总是重新解析。
//
// 语义保证：`htmlFromParts(closedHtml, tailHtml)` 拼出的结果与 `renderMarkdown(全文)`
// 等价 —— 由 tests/markdown-incremental.test.mjs 逐字符对照验证。
import { renderMarkdown } from './markdown.ts'

interface CacheEntry {
  raw: string
  html: string
}

const cache = new Map<string, CacheEntry>()
const MAX_CACHE_KEYS = 16

export interface IncrementalResult {
  html: string
  /** 本次是否复用了闭合前缀的缓存（诊断用） */
  reused: boolean
}

/**
 * 找最后一个安全边界行号：空行且**不在**未闭合代码围栏内。
 *
 * ⚠️ 围栏判定必须与 markdown.ts 的真实解析器**逐字一致**（审查高-2）：
 *   - 开栏：`/^```([\w+-]*)\s*$/`（`` ```js 这里是说明 `` 这种带尾随文字的**不是**开栏）
 *   - 闭栏：`/^```\s*$/`
 *   - 围栏 body 内的任何 ``` 行**既不开也不闭**
 * 旧实现用 `/^```/` 计数，导致「展示 markdown 示例」这种高频场景里
 * 安全边界落进未闭合围栏内部，拼接结果与全量不一致（代码块被劈开）。
 */
function findBoundary(lines: string[]): number {
  let inFence = false
  let boundary = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (inFence) {
      // 围栏内只认闭合围栏；其余任何内容（含 ``` 开头的行）都是 body
      if (/^```\s*$/.test(line)) inFence = false
      continue
    }
    if (/^```([\w+-]*)\s*$/.test(line)) {
      // 合法开栏：围栏从此开始，内部不再是块边界
      inFence = true
      continue
    }
    if (/^\s*$/.test(line)) boundary = i
  }
  return boundary
}

/**
 * 增量渲染。`cacheKey` 标识"同一条正在生长的回复"（如消息 id）。
 * 会话切换/组件卸载时调用 `clearMarkdownCache()` 清理。
 */
export function renderMarkdownIncremental(source: string, cacheKey: string): IncrementalResult {
  const normalized = String(source ?? '').replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  const boundary = findBoundary(lines)

  // 活动尾部：从最后一个安全边界之后到结尾。
  // 若围栏未闭合，最后一个边界一定在围栏开始之前（围栏内的空行不算边界），
  // 所以尾部会包含整个未闭合围栏 —— 正确。
  let closedRaw = boundary >= 0 ? lines.slice(0, boundary + 1).join('\n') : ''
  const tailRaw = boundary >= 0 ? lines.slice(boundary + 1).join('\n') : normalized

  // 关键（审查发现的缓存失配根因）：去掉闭合前缀**尾部的空行**。
  // 否则"文本以空行结尾"时边界停在末尾空行上，下一个 delta 一到（尾行变成内容）
  // 边界就前移 → 前缀变化 → 缓存永远命中不了，增量退化成全量。
  // 去掉后，前缀只在出现**新的内容块**时才变化。被去掉的空行是块间分隔，
  // 不影响渲染结果（renderMarkdown 对连续空行不敏感），并把它们归入尾部以保证
  // 拼接语义与原文完全一致（兼容 CRLF）。
  const separatorMatch = /(?:\r?\n\s*)+$/.exec(closedRaw)
  const separator = separatorMatch ? separatorMatch[0] : ''
  closedRaw = separator ? closedRaw.slice(0, closedRaw.length - separator.length) : closedRaw
  // 被吃掉的分隔空行归还给尾部（保留原文）
  const tail = separator + tailRaw

  // 修复（审查高-3）：闭合前缀**全空白**时不得走 renderMarkdown 的 `|| '<p></p>'`
  // 兜底 —— 那会给前导空行的文本多渲染一个空段落（全量渲染会吞掉前导空行）。
  const closedHtmlFor = (raw: string) => (raw.trim() ? renderMarkdown(raw) : '')
  let closedHtml = closedHtmlFor(closedRaw)
  let reused = false

  const cached = cache.get(cacheKey)
  if (cached && cached.raw === closedRaw) {
    // 前缀没变（delta 落在活动尾部）→ 直接复用，这是流式期间的热路径
    closedHtml = cached.html
    reused = true
  } else {
    // 跨过了一个块边界：前缀变了，重新解析一次并更新缓存
    closedHtml = closedHtmlFor(closedRaw)
    cache.set(cacheKey, { raw: closedRaw, html: closedHtml })
    trimCache()
  }

  // 尾部（含被归还的分隔空行）总是重新解析 —— 它在生长。
  // 若尾部只是分隔空行（无内容），不渲染（renderMarkdown 对纯空白会产生 <p></p>，
  // 而全量渲染会吞掉首尾空行 —— 两者必须等价）。
  const tailIsBlank = !tail.trim()
  const tailHtml = tail && !tailIsBlank ? renderMarkdown(tail) : ''
  const html = (closedHtml + tailHtml) || '<p></p>'
  return { html, reused }
}

function trimCache() {
  if (cache.size > MAX_CACHE_KEYS) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
}

/** 清空增量缓存（会话切换/组件卸载时调用）。 */
export function clearMarkdownCache(cacheKey?: string) {
  if (cacheKey) cache.delete(cacheKey)
  else cache.clear()
}
