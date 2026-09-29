// 权限门控扩展：把规则引擎接到 SDK 的 tool_call 钩子
//
// 求值链（顺序很关键）：
//   ① 规则 deny → 直接拦截（不可被记忆或豁免覆盖）
//   ② 路径越界（读写分离）→ 读放行 / 写确认
//   ③ 系统临时区 → 按 outside.temporary（默认放行，让 agent 临时工作流不被弹窗打断）
//   ④ 项目级「总是允许」记忆命中 → 放行
//   ⑤ 否则 ask → 请 UI 确认
//
// 与旧实现的区别：旧实现只判断 `CONFIRM_TOOLS.includes(toolName)`，
// 于是 bash 一律弹窗、名单外工具一律静默放行，且无法识别 `cd x && rm -rf y`。
import { isAbsolute, relative, resolve } from 'node:path'
import { createPermissionConfigLoader } from './config.ts'
import {
  evaluateBashCommand,
  evaluateRules,
  matchTextFor,
  memoryMatchesCommand,
  suggestPattern,
  type PermissionAction,
} from './pattern.ts'
import { isTemporaryPath, needsTemporaryExempt } from './tmp-zone.ts'

/** 观察类路径工具：越界默认放行（outside.read） */
const READ_TOOLS = new Set(['read', 'ls'])
/** 变更类路径工具：越界默认确认（outside.write） */
const WRITE_TOOLS = new Set(['edit', 'write'])
const PATH_TOOLS = new Set([...READ_TOOLS, ...WRITE_TOOLS])

export interface PermissionGateOptions {
  agentDir: string
  /** 项目根：路径工具落在此之外时按读写分离处置 */
  getProjectRoot: () => string | undefined
  /** 项目级「总是允许」的模式键 */
  getAllowedPatterns: () => string[]
  /** 确认通道；返回 true 表示用户放行 */
  confirm: (title: string, message: string) => Promise<boolean>
  /** 当前模式（每次 tool_call 实时读取，切换即时生效） */
  getMode: () => string
  sessionId: string
  /** 记录一次「总是允许」到项目记忆 */
  rememberAllowed?: (pattern: string) => void
  home?: string
  warn?: (message: string, error?: unknown) => void
}

/** 落点在给定根之内（含根本身） */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function createPermissionGateExtension(options: PermissionGateOptions) {
  const loadConfig = createPermissionConfigLoader(options.agentDir, options.warn)
  const warn = options.warn ?? (() => {})

  return {
    name: 'pi-my-permission-gate',
    factory: (pi: any) => {
      pi.on('tool_call', async (event: any) => {
        const config = loadConfig()
        if (!config.enabled) return undefined

        const mode = options.getMode()
        // full 模式仍要走完规则求值：显式 deny 是用户写的安全红线，
        // 不能因为切到 full 就被跳过（审查发现的漏洞 2）。
        // full 的语义是"不再弹确认"，而不是"无视 deny"。
        const modeIsFull = mode === 'full'

        const toolName = String(event.toolName ?? '')
        const input = (event.input ?? {}) as Record<string, unknown>
        const matchText = matchTextFor(toolName, input)
        const projectRoot = options.getProjectRoot()

        // bash 单次求值同时拿到命中段（弹窗标题定位用）
        const bashResult =
          toolName === 'bash' && matchText
            ? evaluateBashCommand(config.rules, matchText, 'ask', (segment) =>
                needsTemporaryExempt(segment) ? config.outside.temporary : null,
              )
            : null
        let action: PermissionAction = bashResult
          ? bashResult.action
          : evaluateRules(config.rules, toolName, matchText)

        let patternText: string | null = matchText

        // 路径边界 + 临时区。
        // 修复（审查 P1-5）：projectRoot 缺省时回退到进程 cwd，**绝不跳过**越界判定
        // —— 否则首启未选工作区时界外写零弹窗。
        const base = projectRoot ?? resolve('.')
        if (PATH_TOOLS.has(toolName) && matchText) {
          const abs = isAbsolute(matchText) ? matchText : resolve(base, matchText)
          patternText = abs
          if (action === 'allow' && !isInside(base, abs)) {
            // 读写分离：界外读放行、界外写确认
            action = READ_TOOLS.has(toolName) ? config.outside.read : config.outside.write
          }
        }

        // deny 不可被任何后续步骤覆盖
        if (action === 'deny') {
          warn(`tool blocked by rule: ${toolName}`, matchText ?? '')
          return {
            block: true,
            reason: `被权限规则拒绝（${toolName}）。可在 ~/.pi/agent/permissions.json 中调整。`,
          }
        }

        // plan 模式的工具集已由 session 层收紧；这里再拦一道写工具，做纵深防御。
        if (mode === 'plan' && (WRITE_TOOLS.has(toolName) || toolName === 'bash')) {
          return { block: true, reason: `计划模式为只读，已阻止 ${toolName}。` }
        }

        // full 模式：不再弹确认，放行（但上面的 deny 已经拦截）。
        if (modeIsFull) return undefined

        if (action === 'allow') return undefined

        // 项目级「总是允许」记忆。
        // 用 memoryMatchesCommand（整串匹配）而不是候选展开——否则确认过一次 `ls`
        // 之后，`cd / && ls; rm -rf x` 会因候选里有 `ls` 被整条放行（审查 P0-1）。
        const allowed = options.getAllowedPatterns()
        if (allowed.some((pattern) => memoryMatchesCommand(pattern, toolName, patternText))) {
          return undefined
        }

        // ask：弹确认
        const title = bashResult
          ? suggestPattern('bash', { command: bashResult.segment }, options.home)
          : matchText
            ? suggestPattern(toolName, { path: patternText ?? matchText }, options.home)
            : suggestPattern(toolName, input, options.home)
        const detail = matchText ?? JSON.stringify(input).slice(0, 500)

        let ok: boolean | undefined
        try {
          ok = await options.confirm(title, detail)
        } catch (error) {
          warn('确认通道异常，按拒绝处理', error)
        }
        // 漏洞 4 修复：只有**明确为 true** 才记入"总是允许"。
        // 旧实现 `if (ok)` 会把 undefined（前端没回答/通道异常）当成 truthy，
        // 等于把未确认记成永久放行。
        if (ok === true) {
          // 漏洞 1 修复：记忆键绝不能比"本次真正确认过的东西"更宽。
          // suggestPattern 给的是 `bash: git push*` 这种前缀通配——一次确认
          // `git push --force` 会记下它，之后默认规则要求 ask 的 `git push --force`
          // 反而被记忆放行，等于把"高危确认"变成"整个命令族永久放行"。
          // 这里改记**精确的命中段/路径**，由 patternMatchesToolCall 的精确分支匹配。
          const memoryKey = bashResult
            ? `bash: ${bashResult.segment}`
            : matchText
              ? `${toolName}: ${patternText ?? matchText}`
              : toolName
          options.rememberAllowed?.(memoryKey)
          return undefined
        }
        return {
          block: true,
          reason: `用户拒绝了此 ${toolName} 调用（${title}）。不要重试同一操作，请询问用户或换一种方式。`,
        }
      })
    },
  }
}
