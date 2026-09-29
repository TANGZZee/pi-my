// 权限子系统 barrel（与 percho 的组织方式一致）
//
// - bash-chain.ts   bash 命令链解析（切段 / 替换提取 / 包装剥壳 / 候选收集）
// - pattern.ts     规则求值 + 通配匹配 + 模式键建议
// - config.ts      permissions.json 读写 + 默认配置（宽松 + 高危兜底）
// - tmp-zone.ts    系统临时区判定 + rm 目标提取（fail-safe 豁免）
// - extension.ts   接到 SDK tool_call 钩子的门控扩展
export {
  collectBashCandidates,
  extractShellExecArg,
  extractSubstitutions,
  splitShellSegments,
} from './bash-chain.ts'
export {
  DEFAULT_PERMISSION_CONFIG,
  createPermissionConfigLoader,
  loadPermissionConfig,
  mergeWithDefaults,
  permissionActionLabel,
  permissionConfigPath,
  type PermissionConfig,
} from './config.ts'
export {
  evaluateBashCommand,
  evaluateRules,
  evaluateSingle,
  isPermissionAction,
  matchPattern,
  matchTextFor,
  memoryMatchesCommand,
  pathToolPattern,
  strictest,
  suggestPattern,
  type PermissionAction,
  type PermissionOutside,
  type PermissionRule,
  type PermissionRules,
} from './pattern.ts'
export {
  isRmSegment,
  isTemporaryPath,
  needsTemporaryExempt,
  resetTemporaryRootsCache,
  rmSegmentExempt,
  temporaryRoots,
} from './tmp-zone.ts'
export { createPermissionGateExtension, type PermissionGateOptions } from './extension.ts'
