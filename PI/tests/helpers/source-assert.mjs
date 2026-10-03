// 源码接线断言的公共工具（provider-error-wiring 与 session-wiring 共用）
//
// 为什么需要这一层：两轮对抗性审查的变异结论 ——
//   M8  把函数体掏空、只把纯函数名留在注释里   → 子串匹配的测试全绿
//   M9  把真实的 `error: ''` 改成行尾注释      → 全绿
//   M11 把真实调用行注释掉、退化成旧行为       → 全绿
// 根因：源码文本里"出现某串字符" ≠ "该行为存在"。注释、字符串都能满足子串匹配。
//
// 所以断言必须建立在**剥掉注释之后**的源码上，并用 squash() 去掉全部空白，
// 使断言只依赖标记序列而非缩进/换行形态（后者会因语义等价的换行重排产生假阳性）。

/** 剥掉 JS/TS 注释，保留字符串字面量内容。 */
export function stripComments(src) {
  let out = ''
  let i = 0
  let quote = ''
  const n = src.length
  while (i < n) {
    const ch = src[i]
    const next = src[i + 1]
    if (quote) {
      if (ch === '\\') {
        out += ch + (next ?? '')
        i += 2
        continue
      }
      if (ch === quote) quote = ''
      out += ch
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      out += ch
      i += 1
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/** 去掉全部空白：让断言只依赖标记序列，不依赖缩进/换行。 */
export const squash = (text) => text.replace(/\s+/g, '')

/**
 * 把字符串/模板字面量的**内容与定界符**整体替换为等长空格。
 *
 * 产出与原文**同长度**，所以可以安全地 indexOf/正则定位后再回原文切片。
 *
 * 为什么必须有它（第二轮外部审计的 V2/V3/V9 变异）：
 *   V2  守卫全被注释掉，只插一行 `const __note = 'if(!stillMine())return ×5'`
 *       → "守卫计数 ≥ 5" 断言照样通过（squash 只去空白，不碰字面量内容）；
 *   V9  插一行 `const __log = 'Auditing function dispatchTurn('`
 *       → 正则命中**字符串**，functionBodyOf 去取了一个根本不存在的函数体，
 *         7 条接线断言连带炸掉（假阳性）。
 * 结论：所有"计数/定位"类断言都必须在屏蔽字面量之后再算。
 *
 * 不解析正则字面量（`/.../`）：本工具只服务于代码形状断言，正则里出现被断言的
 * 标记属于刻意构造，且为此引入完整的词法器不划算 —— 定位改用
 * functionBodyOf 自身的 `function <name> (` 词法匹配来兜底。
 */
export function maskStrings(src) {
  let out = ''
  let i = 0
  let quote = ''
  const n = src.length
  while (i < n) {
    const ch = src[i]
    if (quote) {
      if (ch === '\\') {
        out += ' '
        i += 1
        if (i < n) {
          out += ' '
          i += 1
        }
        continue
      }
      if (ch === quote) quote = ''
      out += ' '
      i += 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      out += ' '
      i += 1
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/** 代码形状视图：剥注释（调用方负责）+ 屏蔽字面量 + 去空白。计数类断言必须用它。 */
export const codeShapeOf = (src) => squash(maskStrings(src))

/**
 * 剥注释 + 去空白后的视图，**并逐字符记录它是否来自字符串/模板字面量**。
 *
 * 为什么需要它（f15bc3a3 对抗性审查的 M1/M3/M5 变异，实测 110/0 全绿）：
 *   stripComments 只剥注释，字符串字面量内容原样保留。于是把真实修复整块删掉、
 *   改写成一个字符串 `const __shapeNote = "if(startedButAborted){…}"`，所有
 *   "存在某串"的断言就会在**字符串**上命中 —— 真实代码零防线，测试全绿。
 *   functionBodyCodeOf（屏蔽字面量）能挡住函数体级别的这类攻击；但**事件分支**必须
 *   匹配带字面量的形状（`event.type === 'agent_start'`、`request('abort', …)`），
 *   不能整体屏蔽。所以这里给出"逐字符来源"视图，配合 indexOfCode 判定命中位置
 *   究竟落在代码里还是字面量里。
 *
 * 与 squash(stripComments(src)) 的输出逐字符一致（同样只去 `\s`）。
 */
export function shapeWithLiteralMask(rawSource) {
  const stripped = stripComments(rawSource)
  const chars = []
  const fromLiteral = []
  let quote = ''
  let i = 0
  while (i < stripped.length) {
    const ch = stripped[i]
    if (quote) {
      if (ch === '\\') {
        chars.push(ch)
        fromLiteral.push(true)
        i += 1
        if (i < stripped.length) {
          chars.push(stripped[i])
          fromLiteral.push(true)
          i += 1
        }
        continue
      }
      if (ch === quote) quote = ''
      chars.push(ch)
      fromLiteral.push(true)
      i += 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      chars.push(ch)
      fromLiteral.push(true)
      i += 1
      continue
    }
    chars.push(ch)
    fromLiteral.push(false)
    i += 1
  }
  let shape = ''
  const literal = []
  for (let k = 0; k < chars.length; k += 1) {
    if (/\s/.test(chars[k])) continue
    shape += chars[k]
    literal.push(fromLiteral[k])
  }
  return { shape, literal }
}

/**
 * 在 shapeWithLiteralMask 的视图里定位 needle，但**命中位置的起点必须来自真实代码**
 * （不在字符串/模板字面量内）。只在字面量里出现 ⇒ 返回 -1。
 *
 * 这是"存在某串"断言的最小修补：形状仍可包含字面量（事件名、请求名），
 * 但整段形状被搬进字符串里冒充的诱饵一律不算命中。
 */
export function indexOfCode(shape, literal, needle, start = 0) {
  // start 是可选形参，必须**显式**声明：早期版本漏了它，调用方多传的第 4 个实参被
  // JS 静默丢弃，于是"从事件入口往后找"变成了"全文件找"——命中的是文件早段的同名
  // 调用（例如 clearProviderError 里的 cancel），断言恒真，删掉真正那一处的变异全部存活。
  let from = start
  for (;;) {
    const at = shape.indexOf(needle, from)
    if (at < 0) return -1
    if (!literal[at]) return at
    from = at + 1
  }
}

/**
 * 归约器里所有 `if (event.type === 'X' …)` 条件的**类型名，按出现顺序**。
 *
 * 为什么需要它（f15bc3a3 的 M7/M8 诱饵变异，实测 provider-error-wiring 14/0 全绿）：
 *   eventBlockOf 的定界规则是"优先取第一处带花括号的主分支"。在真实分支**之前**插入
 *   一个形状完整、条件永假的同 marker 分支（`… && id === '__decoy__'`），断言就会在
 *   诱饵上求值 —— 真实分支被掏成 `void 0`（错误永不显示）也全绿。
 *   分支形状挡不住这个（诱饵的块本身是干净的），所以必须锁"**有哪些分支**"：
 *   本函数给出归约器的分支契约，任何插入/删除/移动事件分支都会改变这张表。
 *
 * 实现要点：先把字面量屏蔽（字符串里假造的 `event.type === 'x'` 一律不算），
 * 再要求 `event.type ===` 前面的非空白字符是 `(`（排除赋值/比较表达式），
 * 最后按**等长偏移**回原文读类型名（maskStrings 保长度，偏移可直接映射）。
 */
export function eventConditionTypesOf(src) {
  const masked = maskStrings(src)
  const out = []
  for (const match of masked.matchAll(/event\.type\s*===/g)) {
    let before = match.index - 1
    while (before >= 0 && /\s/.test(masked[before])) before -= 1
    if (masked[before] !== '(') continue
    // maskStrings 保长度 ⇒ 偏移在 masked 与 src 之间可直接映射；
    // 类型名本身已被屏蔽成空格，所以回 src 读字面量。
    let cursor = match.index + match[0].length
    while (cursor < src.length && /\s/.test(src[cursor])) cursor += 1
    const parsed = /^'([a-z_]+)'/.exec(src.slice(cursor, cursor + 40))
    if (!parsed) continue
    out.push(parsed[1])
  }
  return out
}

/**
 * 从剥注释后的源码里取某个**函数体**，靠花括号配平定界（与缩进/换行无关）。
 *
 * 早期实现用 `\n  }` 找同级收尾，有两个真实故障：
 *   ① 目标文件是 CRLF，锚点错位；
 *   ② 函数体内任何"2 空格缩进的块收尾"（如 `  }` 收掉一个 if）都会被当成函数结尾，
 *      于是函数体被静默截断 —— 断言随后在**被截掉的下半段**上搜标记，结果必然是
 *      "找不到"，看起来像"修复丢了"，实则是探针坏了。
 * 因此改为真正的花括号计数：跳过字符串/模板字面量，深度归零处即为函数结尾。
 */
export function functionBodyOf(source, name) {
  const [start, end] = functionRangeOf(source, name)
  return squash(source.slice(start, end))
}

/**
 * 与 functionBodyOf 同源，但**屏蔽字符串字面量内容**后再去空白。
 *
 * 计数/存在性断言必须用它（第二轮外部审计 V2 实测）：
 *   把 5 处 `if (!stillMine()) return` 全部注释掉，只插一行
 *   `const __note = 'if(!stillMine())return ×5'` —— squash 只去空白、不动字面量内容，
 *   "守卫计数 ≥ 5"照样通过，而真实的 5 道守卫已全部失效（125/125 全绿）。
 *   计数必须建立在"可执行代码形状"上：字符串里的文本不是代码。
 */
export function functionBodyCodeOf(source, name) {
  const [start, end] = functionRangeOf(source, name)
  return codeShapeOf(source.slice(start, end))
}

/**
 * 定位函数声明的 [start, end) 字符区间（end 即函数体收尾 `}` 之后一位）。
 * 所有取函数体的断言都应经由它，以共享同一套诱饵/字面量防线。
 */
export function functionRangeOf(source, name) {
  // 重复声明必须**报错**，不能"取第一个"：对抗性审查用它构造出诱饵——把真实函数体
  // 逐字节复制一份、缩进后包进一个裸块插到真实声明之前（永不执行），真实函数体换成
  // 修复前的无守卫形态。因为断言只搜"第一个同名函数体"，8/8 断言全过而真实代码零防线
  // （探针 probe-decoy-bypass.mjs / mutate-decoy-current.mjs）。
  //
  // 第一版防线只做 `source.indexOf('function '+name+'(')` 的二次匹配，被两处绕过
  // （第二轮外部审计 v8 / v9 / v10 实测 SURVIVED）：
  //   v8/v10 把**真实**函数写成 `function dispatchTurn (` —— 标识符与左括号之间多一个空格。
  //          合法 JS，却不匹配带括号的 marker：真实函数不再是"第二个匹配"，诱饵成了唯一
  //          命中，断言全部作用在永不执行的诱饵上（真实函数 0 守卫，125/125 全绿）。
  //   v9     在某处插一行 `const __log = 'Auditing function dispatchTurn('` —— 字符串字面量
  //          内容被 indexOf 命中，取到的是注释/字符串位置，7 条断言连带炸掉（假阳性）。
  // 现在：在**屏蔽字符串字面量**后的源码上用词法正则 `\bfunction\s+name\s*\(` 全量枚举，
  // 空白随意、字符串不算，命中数 ≠ 1 一律拒绝。
  const masked = maskStrings(source)
  const declRe = new RegExp(`\\bfunction\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`, 'g')
  const decls = [...masked.matchAll(declRe)].map((m) => m.index ?? -1).filter((at) => at >= 0)
  if (decls.length > 1) {
    throw new Error(
      `源码里有 ${decls.length} 处 function ${name} 声明（偏移 ${decls.join(', ')}）：断言无法确定作用于哪一个（可能是诱饵副本），已拒绝继续`
    )
  }
  if (decls.length === 0) throw new Error(`找不到函数 ${name}`)
  const start = decls[0]
  // 先配平**参数列表的圆括号**，再取紧随其后的 `{` 作为函数体开头。
  // 不能直接 indexOf('{')：TS 环境的参数里就有花括号（`session: { id: string; title?: string }`、
  // `history: Array<{...}> = []`），那会把类型字面量的 `}` 当成函数结尾而**静默截断**函数体
  // —— 断言随即在被截掉的下半段上搜标记，表现为"修复丢了"，实则是探针坏了。
  const openParen = masked.indexOf('(', start)
  let depth = 0
  let i = openParen
  let quote = ''
  let paramEnd = -1
  while (i < source.length) {
    const ch = source[i]
    if (quote) {
      if (ch === '\\') {
        i += 2
        continue
      }
      if (ch === quote) quote = ''
      i += 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      i += 1
      continue
    }
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) {
        paramEnd = i
        break
      }
    }
    i += 1
  }
  if (paramEnd < 0) throw new Error(`函数 ${name} 的参数列表未能闭合`)
  const open = source.indexOf('{', paramEnd)
  if (open < 0) throw new Error(`函数 ${name} 缺少函数体`)
  depth = 0
  i = open
  quote = ''
  while (i < source.length) {
    const ch = source[i]
    if (quote) {
      if (ch === '\\') {
        i += 2
        continue
      }
      if (ch === quote) quote = ''
      i += 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      i += 1
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return [start, i + 1]
    }
    i += 1
  }
  throw new Error(`函数 ${name} 的函数体未能闭合（源码结构可能已损坏）`)
}

/**
 * 取某个事件分支（`event.type === 'x'` 起至分支体结束），返回**去空白**后的源码片段。
 *
 * 早期实现是 `` marker 之后 `search(/\n {8}\}/)` ``，并在找不到时退化成固定 2000 字符窗口。
 * 第三轮外部审计（S-3）实测这条定界符是脆的：把 8 空格缩进改成别的宽度、或把分支改写成
 * 单语句不带花括号，`search` 就落空 ⇒ 静默返回一个"从分支起点往后 2000 字符"的大块，
 * 里面混进**其它分支**的代码，于是断言可能在别人的代码上命中而全绿（M30a/M30b 两个变异
 * 都是这样漏掉的）。
 *
 * 现在的定界符是**结构性的**：
 *   ① 从 marker 之后第一个 `(` 起做括号配平，找到条件表达式的收尾 `)`；
 *   ② 若其后（跳过空白）是 `{`，做花括号配平到配对的 `}`（跳过字符串/模板字面量）；
 *   ③ 否则是单语句分支，取到不跨越括号的该行行尾。
 * 任何一步失败都直接 **throw**，绝不退回固定窗口 —— 探针坏了必须响亮地失败，
 * 而不是给出一个"看起来验证过了"的答案。
 */
export function eventBlockOf(appSource, type) {
  const marker = `event.type === '${type}'`
  // 同一个 marker 可能出现多次，且**不都是**该事件的主分支：
  //   agent_start   `if (event.type === 'agent_start') runEpoch.clearSuperseded(id)`（单语句）
  //                 与 `if (event.type === 'agent_start') { … 真正的分支 … }` 并存；
  //   message_end   `… role === 'assistant'` 的块**在前**，`… role === 'custom'` 的块在后且更长。
  // 因此判据是：**优先取第一处带花括号的主分支**；一处都没有时才退回第一处单语句分支。
  // 只按"第一处"取会让 agent_start 拿到那行 clearSuperseded；只按"最长"取会让 message_end
  // 拿到 role==='custom' 的块 —— 两种都是"断言在错误的块上求值却全绿"的静默失败。
  let firstBraced = ''
  let firstSingle = ''
  let found = 0
  let searchFrom = 0
  // ⚠️ 候选必须落在**真实代码**里。第四轮外部审计实测（M1/M3/M5）：stripComments **不剥
  //    字符串字面量内容**，删掉真实分支、插一个 `const __shapeNote = "if (event.type === 'agent_end') { … }"`
  //    就能让本函数从字符串里"取到"一个形状完美的块，于是所有基于它的断言都在诱饵上求值。
  //    maskStrings 把字面量内容（含定界符）换成等长空格（偏移不变），因此在 masked 视图里
  //    该位置的 `event.type === ` 前缀一定已变成空格 —— 用它当"这段是不是真代码"的判据。
  const masked = maskStrings(appSource)
  const head = "event.type === "
  for (;;) {
    const start = appSource.indexOf(marker, searchFrom)
    if (start <= 0) break
    searchFrom = start + marker.length
    if (!masked.startsWith(head, start)) continue
    let open = start - 1
    while (open >= 0 && /\s/.test(appSource[open])) open -= 1
    if (appSource[open] !== '(') continue
    found += 1
    const condEnd = matchDelimiter(appSource, open, '(', ')')
    if (condEnd < 0) throw new Error(`事件分支 ${type} 的条件括号未闭合（源码结构可能已损坏）`)
    let cursor = condEnd + 1
    while (cursor < appSource.length && /\s/.test(appSource[cursor])) cursor += 1
    if (appSource[cursor] === '{') {
      const bodyEnd = matchDelimiter(appSource, cursor, '{', '}')
      if (bodyEnd < 0) throw new Error(`事件分支 ${type} 的块未闭合（源码结构可能已损坏）`)
      if (!firstBraced) firstBraced = squash(appSource.slice(start, bodyEnd + 1))
      continue
    }
    // 单语句分支：取到行尾，但不得跨越未配平的括号（换行的多行调用会被识破并抛错）。
    let lineEnd = appSource.indexOf('\n', cursor)
    if (lineEnd < 0) lineEnd = appSource.length
    const line = appSource.slice(cursor, lineEnd)
    const balance = (line.match(/[([{]/g) ?? []).length - (line.match(/[)\]}]/g) ?? []).length
    if (balance !== 0) {
      throw new Error(`事件分支 ${type} 是单语句分支但该行括号未配平：定界符不可靠，请改用花括号写法`)
    }
    if (!firstSingle) firstSingle = squash(appSource.slice(start, lineEnd))
  }
  if (!found) {
    throw new Error(`App.svelte 里的 event.type === '${type}' 不出现在任何 if (…) 条件中`)
  }
  return firstBraced || firstSingle
}

/** 从 `openAt`（指向 `open` 字符）配平到配对字符的下标；跳过字符串/模板字面量。失败返回 -1。 */
function matchDelimiter(source, openAt, open, close) {
  if (openAt < 0) return -1
  let depth = 0
  let quote = ''
  let i = openAt
  while (i < source.length) {
    const ch = source[i]
    if (quote) {
      if (ch === '\\') {
        i += 2
        continue
      }
      if (ch === quote) quote = ''
      i += 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      i += 1
      continue
    }
    if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) return i
    }
    i += 1
  }
  return -1
}
