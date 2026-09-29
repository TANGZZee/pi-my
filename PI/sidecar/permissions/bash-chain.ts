// bash 命令链解析（引号感知，纯函数）
//
// 为什么需要它：只按"工具名 === 'bash'"弹确认是不够的——agent 可以把危险命令藏进链里：
//   cd x && rm -rf y        （只看第一个 token 会以为是 cd）
//   echo $(rm -rf y)        （命令替换）
//   sh -c 'rm -rf y'        （包装执行）
// 这里把一条命令拆成"求值候选"集合，规则引擎对每个候选求值后取**最严**动作，
// 因此上述三种写法都无法绕过。
//
// 移植自 percho（Jaxton07/percho, MIT）packages/backend/src/permissions/bash-chain.ts，
// 做了少量适配（不依赖其日志模块）。

/**
 * 引号感知切段：`&&` `||` `&` `|` `;` 与换行在引号外才分隔。
 * 例：`echo "a && rm x"` 不会被切开；`2>&1` 的 `>&` 不算分隔符。
 */
export function splitShellSegments(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: string | null = null
  let escaped = false
  const push = () => {
    const trimmed = current.trim()
    if (trimmed.length > 0) segments.push(trimmed)
    current = ''
  }
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (escaped) { current += ch; escaped = false; continue }
    if (ch === '\\' && quote !== "'") { current += ch; escaped = true; continue }
    if (quote) { current += ch; if (ch === quote) quote = null; continue }
    if (ch === "'" || ch === '"') { current += ch; quote = ch; continue }
    if (ch === '&' || ch === '|') {
      const prev = current.trimEnd()
      // 重定向复制 fd（2>&1、<&0）不是命令分隔
      if (ch === '&' && (prev.endsWith('>') || prev.endsWith('<'))) { current += ch; continue }
      if (command[i + 1] === ch) i++
      push()
      continue
    }
    if (ch === ';' || ch === '\n' || ch === '\r') { push(); continue }
    current += ch
  }
  push()
  return segments
}

/**
 * 提取顶层命令替换内容（`$( )` 与反引号）；单引号内不执行故跳过。
 * 双引号内的替换仍会执行，照常提取。嵌套由 collectBashCandidates 递归处理。
 */
export function extractSubstitutions(text: string): string[] {
  const found: string[] = []
  let quote: string | null = null
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (escaped) { escaped = false; continue }
    if (ch === '\\' && quote !== "'") { escaped = true; continue }
    if (quote === "'") { if (ch === "'") quote = null; continue }
    if (ch === "'" && quote === null) { quote = "'"; continue }
    if (ch === '"') { quote = quote === '"' ? null : '"'; continue }
    if (ch === '`') {
      const end = text.indexOf('`', i + 1)
      if (end < 0) break
      found.push(text.slice(i + 1, end))
      i = end
      continue
    }
    if (ch === '$' && text[i + 1] === '(') {
      let depth = 1
      let innerQuote: string | null = null
      let innerEscaped = false
      let j = i + 2
      for (; j < text.length && depth > 0; j++) {
        const c = text[j]
        if (innerEscaped) { innerEscaped = false; continue }
        if (c === '\\' && innerQuote !== "'") { innerEscaped = true; continue }
        if (innerQuote) { if (c === innerQuote) innerQuote = null; continue }
        if (c === "'" || c === '"') { innerQuote = c; continue }
        if (c === '(') depth++
        if (c === ')') depth--
      }
      if (depth === 0) { found.push(text.slice(i + 2, j - 1)); i = j - 1 }
      else break
    }
  }
  return found
}

const WRAPPER_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ash', 'ksh', 'fish'])

/** 去外层配对引号；有尾随内容时截取引号内部分（`'cmd' extra` → `cmd`） */
function extractQuoted(text: string): string {
  const q = text[0]
  if (q !== "'" && q !== '"') return text
  const end = text.indexOf(q, 1)
  return end > 0 ? text.slice(1, end) : text.slice(1)
}

/**
 * 提取包装执行的真实命令：`sh|bash|... -c <cmd>`（含 `-lc` 等合并 flag）与 `eval <cmd>`。
 * 无法提取返回 null。xargs / find -exec / python -c 等不在覆盖范围（模式方案的天花板）。
 */
export function extractShellExecArg(segment: string): string | null {
  const tokens = segment.trim().split(/\s+/)
  if (tokens[0] === 'eval' && tokens.length > 1) {
    return extractQuoted(tokens.slice(1).join(' ').trim())
  }
  if (!WRAPPER_SHELLS.has(tokens[0] ?? '')) return null
  for (let i = 1; i < tokens.length; i++) {
    const flag = tokens[i]
    if (!flag || !/^-[a-zA-Z]+$/.test(flag)) break
    if (flag.includes('c')) {
      const rest = tokens.slice(i + 1).join(' ').trim()
      return rest.length > 0 ? extractQuoted(rest) : null
    }
  }
  return null
}

/**
 * 收集 bash 求值候选：整串（兼容 `curl * | sh*` 这类整串模式）+ 各段 +
 * 命令替换内容与 `-c`/`eval` 包装参数（递归，逐层剥开）。
 * 去重并保持发现顺序，便于测试与定位危险段。
 */
export function collectBashCandidates(command: string): string[] {
  const candidates = new Set<string>()
  const visited = new Set<string>()
  const walk = (text: string) => {
    if (visited.has(text)) return
    visited.add(text)
    candidates.add(text)
    for (const segment of splitShellSegments(text)) {
      candidates.add(segment)
      const execArg = extractShellExecArg(segment)
      if (execArg) { candidates.add(execArg); walk(execArg) }
    }
    for (const sub of extractSubstitutions(text)) { candidates.add(sub); walk(sub) }
  }
  walk(command)
  return [...candidates]
}
