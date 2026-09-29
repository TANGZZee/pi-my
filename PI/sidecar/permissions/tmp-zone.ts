// 系统临时区判定 + rm 目标提取（纯函数，带最小 IO）
//
// 目的：agent 的临时工作流（写 /tmp、清理自己刚建的临时文件）不该被弹窗打断，
// 但豁免必须**fail-safe**：判不准就不豁免（宁可多弹一次）。
//
// 移植自 percho packages/backend/src/permissions/tmp-zone.ts（MIT）。
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

let cachedRoots: string[] | undefined

/**
 * 临时区根集合。收字面拼写与 realpath 两种形态：
 * 匹配文本经 path.resolve（纯词法、不解 symlink），只收 realpath 会漏掉字面拼写。
 *
 * ⚠️ Windows 关键守卫（审查中发现的真实缺陷）：
 * 在 Windows 上 `/tmp` 会被 `resolve()`/`realpathSync()` 解析成**当前驱动器根下的
 * `\tmp`**（如 `D:\tmp`）。若把它当临时根，那么 `rm -rf /tmp/a` 或任何 `D:\tmp\*`
 * 都会被静默豁免 —— 而 `D:\tmp` 完全可能是普通用户目录！
 * 所以 Windows 上**不收** `/tmp`（只收 `os.tmpdir()`），POSIX 才收。
 */
export function temporaryRoots(): string[] {
  if (cachedRoots) return cachedRoots
  const roots = new Set<string>()
  const literal = resolve(tmpdir())
  roots.add(literal)
  try { roots.add(realpathSync(literal)) } catch { /* 目录异常消失，保留字面根即可 */ }
  if (process.platform !== 'win32') {
    roots.add('/tmp')
    try { roots.add(realpathSync('/tmp')) } catch { /* 非 POSIX 平台无 /tmp */ }
  }
  cachedRoots = [...roots]
  return cachedRoots
}

/** 仅测试用：清空临时根缓存 */
export function resetTemporaryRootsCache(): void {
  cachedRoots = undefined
}

/**
 * abs 是否落在任一临时区根下（含根本身）。abs 必须是绝对路径。
 *
 * ⚠️ Windows junction/symlink 逃逸（审查实测的 P0-3）：
 * `mklink /J %TEMP%\escape C:\Users\Tang\Desktop` 之后，
 * `resolve('%TEMP%\escape\resume.pdf')` 词法上仍在临时区内，但**物理上**在桌面。
 * 所以判定前必须先把整条路径 realpath 到真实位置；realpath 失败（目标不存在等）
 * 按 fail-safe 处理 → 不算临时区。
 */
export function isTemporaryPath(abs: string): boolean {
  let target: string
  try {
    // realpath 解析路径中所有 symlink/junction；对不存在的末段会抛错
    target = realpathSync(abs)
  } catch {
    // 末段可能尚不存在（agent 打算创建它）→ 逐级向上找最近一个真实存在的祖先，
    // 用它的真实位置判定，再拼回末段；找不到任何真实祖先也不豁免。
    const resolved = resolve(abs)
    let ancestor = dirname(resolved)
    while (true) {
      try {
        target = join(realpathSync(ancestor), resolved.slice(ancestor.length))
        break
      } catch {
        const parent = dirname(ancestor)
        if (parent === ancestor) return false // 到根了还不存在 → 无从判定
        ancestor = parent
      }
    }
  }
  return temporaryRoots().some((root) => {
    const rel = relative(root, target)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  })
}

/** 段首 token 是否为 rm（rm 家族判定；`sudo rm` / `xargs rm` 首 token 不是 rm → 不豁免）。 */
export function isRmSegment(segment: string): boolean {
  const first = segment.trim().split(/\s+/)[0] ?? ''
  return first === 'rm'
}

interface SegmentToken {
  text: string
  /** 是否曾加引号（引号内 `*`/`?` 是字面字符，不算 glob —— bash 语义） */
  quoted: boolean
}

/** 引号感知 tokenize。不处理反斜杠转义（与 fail-safe 方向一致：宁可多弹不误放）。 */
function tokenizeSegment(segment: string): SegmentToken[] {
  const tokens: SegmentToken[] = []
  let current = ''
  let quoted = false
  let quote: string | null = null
  const push = () => {
    if (current.length > 0 || quoted) { tokens.push({ text: current, quoted }); current = ''; quoted = false }
  }
  for (const ch of segment) {
    if (quote) { if (ch === quote) quote = null; else current += ch; continue }
    if (ch === "'" || ch === '"') { quote = ch; quoted = true; continue }
    if (/\s/.test(ch)) { push(); continue }
    current += ch
  }
  push()
  return tokens
}

/** env 赋值前缀形态：VAR=val */
const ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * 无法静态判定真实目标的 token：含 `$`（变量/命令替换）、`~`、反引号。
 * 这类目标必须走确认，不能豁免。
 */
const UNSAFE_PATH_TOKEN = /[$`~]/

/** 未加引号的 glob 字符 */
function isGlobToken(token: SegmentToken): boolean {
  return !token.quoted && /[*?]/.test(token.text)
}

/**
 * rm 段豁免判定：所有路径参数都落在临时区才豁免。
 * 任一 token 判不中（变量、`~`、相对路径落界外、混合目标）→ false。
 *
 * fail-safe 要点：含 shell 变量/命令替换的 token **一律不豁免**——
 * 它的真实目标在静态分析时未知，`rm -rf $HOME/x` 与 `rm -rf /tmp/x` 长得一样。
 */
export function rmSegmentExempt(segment: string, cwd?: string): boolean {
  if (!isRmSegment(segment)) return false
  const tokens = tokenizeSegment(segment)
  const paths: SegmentToken[] = []
  let endOfFlags = false
  for (const token of tokens.slice(1)) {
    if (!endOfFlags && !token.quoted && token.text === '--') { endOfFlags = true; continue }
    if (!endOfFlags && !token.quoted && token.text.startsWith('-') && token.text.length > 1) continue
    if (!endOfFlags && paths.length === 0 && !token.quoted && ASSIGNMENT_PREFIX.test(token.text)) continue
    paths.push(token)
  }
  if (paths.length === 0) return false
  // 含变量展开/替换/tilde 的目标无法静态判定 → 不豁免（宁可多弹一次）
  if (paths.some((token) => UNSAFE_PATH_TOKEN.test(token.text))) return false
  if (cwd === undefined && paths.some((token) => !isAbsolute(token.text))) return false
  return paths.every((token) => {
    const literal = isGlobToken(token) ? dirname(token.text) : token.text
    return isAbsolute(literal)
      ? isTemporaryPath(literal)
      : cwd !== undefined && isTemporaryPath(resolve(cwd, literal))
  })
}

/** 该 bash 段是否可走临时区豁免（rm 家族且目标全在临时区）。 */
export function needsTemporaryExempt(segment: string, cwd?: string): boolean {
  return rmSegmentExempt(segment, cwd)
}
