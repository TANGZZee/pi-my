// 权限规则配置读写（~/.pi/agent/permissions.json）
//
// 默认策略移植自 percho：**宽松 + 高危兜底**（coding agent 效率优先）。
// 只读/编辑/自定义工具默认放行；bash 默认放行但枚举高危命令 ask；
// 读写分离：路径越界时读放行、写确认；系统临时区默认放行；
// 并且**自保护**：改动 agent 自身的权限/凭证配置必须确认。
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { PermissionAction, PermissionOutside, PermissionRule, PermissionRules } from './pattern.ts'
import { isPermissionAction } from './pattern.ts'

export interface PermissionConfig {
  enabled: boolean
  outside: PermissionOutside
  rules: PermissionRules
}

/** agent 自身权限/信任/凭证配置（默认规则自保护：改动这些文件必须确认） */
const PROTECTED_FILES = ['permissions.json', 'workspaces.json', 'auth.json', 'trust.json'] as const

/**
 * 默认配置：宽松 + 高危兜底。
 * 注意 `rm -r *` 等的 flag 变体都列出 —— 顺序无关，后命中生效取最严。
 */
export const DEFAULT_PERMISSION_CONFIG: PermissionConfig = {
  enabled: true,
  outside: { read: 'allow', write: 'ask', temporary: 'allow' },
  rules: {
    '*': 'allow',
    bash: {
      '*': 'allow',
      'sudo *': 'ask',
      // rm 家族整体 ask（审查发现逐拼法枚举会漏：-rfv/-vrf/-Rf/-R/-rff/--recursive=…）。
      // 临时区豁免在求值链里单独处理（outside.temporary），不受这里影响。
      'rm *': 'ask',
      'rmdir *': 'ask',
      'del *': 'ask',
      'rd *': 'ask',
      'Remove-Item*': 'ask',
      'ri *': 'ask',
      'mkfs*': 'ask',
      'dd *': 'ask',
      'shred *': 'ask',
      'format *': 'ask',
      'git push --force*': 'ask',
      'git push -f*': 'ask',
      'git reset --hard*': 'ask',
      'git clean -f*': 'ask',
      'git clean --force*': 'ask',
      'curl * | sh*': 'ask',
      'curl * | bash*': 'ask',
      'curl * | zsh*': 'ask',
      'wget * | sh*': 'ask',
      'wget * | bash*': 'ask',
      'wget * | zsh*': 'ask',
      // Windows junction/symlink 创建（审查 P0-3 的攻击前置步骤）
      'mklink*': 'ask',
      'cmd /c mklink*': 'ask',
      'New-Item -ItemType*': 'ask',
      // 凭据类路径（界外读默认放行，但这些不能静默读）
      '*id_rsa*': 'ask',
      '*id_ed25519*': 'ask',
      '*.ssh\\*': 'ask',
      '*.ssh/*': 'ask',
      '*credentials*': 'ask',
      '.aws*': 'ask',
      // 自保护：任何触及权限/信任/凭证配置的命令（含重定向写入）必确认
      '*permissions.json*': 'ask',
      '*workspaces.json*': 'ask',
      '*auth.json*': 'ask',
      '*trust.json*': 'ask',
    },
    ...Object.fromEntries(
      ['edit', 'write'].map((tool) => [
        tool,
        Object.fromEntries([
          ...PROTECTED_FILES.map((file) => [`*${file}`, 'ask'] as const),
          ['*.ssh/*', 'ask'],
          ['*.ssh\\*', 'ask'],
          ['*credentials*', 'ask'],
        ]),
      ]),
    ),
  } as PermissionRules,
}

/** 配置规则与默认值按工具粒度合并：文件里的单工具规则整体替换默认的同名规则。 */
export function mergeWithDefaults(config: Partial<PermissionConfig>): PermissionConfig {
  return {
    enabled: config.enabled ?? true,
    outside: {
      read: config.outside?.read ?? DEFAULT_PERMISSION_CONFIG.outside.read,
      write: config.outside?.write ?? DEFAULT_PERMISSION_CONFIG.outside.write,
      temporary: config.outside?.temporary ?? DEFAULT_PERMISSION_CONFIG.outside.temporary,
    },
    rules: { ...DEFAULT_PERMISSION_CONFIG.rules, ...(config.rules ?? {}) } as PermissionRules,
  }
}

function isValidRule(rule: unknown): rule is PermissionRule {
  if (typeof rule === 'string') return isPermissionAction(rule)
  if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) return false
  return Object.values(rule).every((value) => isPermissionAction(value))
}

function parseOutside(raw: unknown): PermissionOutside | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const input = raw as { read?: unknown; write?: unknown; temporary?: unknown }
  const result: Partial<PermissionOutside> = {}
  if (isPermissionAction(input.read)) result.read = input.read
  if (isPermissionAction(input.write)) result.write = input.write
  if (isPermissionAction(input.temporary)) result.temporary = input.temporary
  return result.read || result.write || result.temporary ? (result as PermissionOutside) : undefined
}

function parseConfig(raw: unknown): Partial<PermissionConfig> {
  if (typeof raw !== 'object' || raw === null) return {}
  const input = raw as { enabled?: unknown; outside?: unknown; rules?: unknown }
  const result: Partial<PermissionConfig> = {}
  if (typeof input.enabled === 'boolean') result.enabled = input.enabled
  result.outside = parseOutside(input.outside)
  if (typeof input.rules === 'object' && input.rules !== null && !Array.isArray(input.rules)) {
    const rules: Record<string, PermissionRule> = {}
    for (const [tool, rule] of Object.entries(input.rules as Record<string, unknown>)) {
      if (tool === '*') {
        if (isPermissionAction(rule)) rules['*'] = rule
        continue
      }
      if (isValidRule(rule)) rules[tool] = rule
    }
    result.rules = rules as PermissionRules
  }
  return result
}

export function permissionConfigPath(agentDir: string): string {
  return join(agentDir, 'permissions.json')
}

/** 读取权限配置；文件不存在或非法时回退默认配置（绝不因为配置坏了就放行一切）。 */
export function loadPermissionConfig(
  agentDir: string,
  warn: (message: string, error?: unknown) => void = () => {},
): PermissionConfig {
  const file = permissionConfigPath(agentDir)
  if (!existsSync(file)) return mergeWithDefaults({})
  try {
    return mergeWithDefaults(parseConfig(JSON.parse(readFileSync(file, 'utf-8'))))
  } catch (error) {
    warn('permissions.json 解析失败，已回退默认配置', error)
    return mergeWithDefaults({})
  }
}

/**
 * 带 mtime 缓存的读取。扩展在**每次** tool_call 前调用，必须便宜，
 * 同时保证用户改了 permissions.json 后立即生效。
 */
export function createPermissionConfigLoader(
  agentDir: string,
  warn?: (message: string, error?: unknown) => void,
): () => PermissionConfig {
  let cached: { mtimeMs: number | null; config: PermissionConfig } | undefined
  return () => {
    const file = permissionConfigPath(agentDir)
    let mtimeMs: number | null = null
    try { mtimeMs = statSync(file).mtimeMs } catch { mtimeMs = null }
    if (cached && cached.mtimeMs === mtimeMs) return cached.config
    const config = loadPermissionConfig(agentDir, warn)
    cached = { mtimeMs, config }
    return config
  }
}

/** 允许写入的最小配置（供未来 UI 使用；当前只读） */
export function permissionActionLabel(action: PermissionAction): string {
  return action === 'allow' ? '放行' : action === 'ask' ? '确认' : '拒绝'
}
