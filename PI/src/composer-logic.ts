// 0-5 批次 C：Composer 输入区的纯逻辑抽取（无 Svelte/组件状态依赖，可被 node --test 直载单测）。
// 注意：本模块被 .ts 间导入与 .svelte 导入共用——.ts 内部互导必须带显式 .ts 扩展名（node 直载惯例）。
import { filterSlashCommands } from './slash-commands.ts'

// 上下文用量快照（get_state 返回的裁剪形状）。
export type CtxStats = { currentContext: number; window: number; totals: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }; costUsd: number; cacheHitRate: number }

// ctx 环形进度条的周长（r=7）与空态快照。
export const CTX_CIRC = 2 * Math.PI * 7
export const EMPTY_CTX: CtxStats = { currentContext: 0, window: 0, totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, costUsd: 0, cacheHitRate: 0 }

// 上下文占用百分比（0-100，无窗口数据时为 0）。
export function ctxProgress(stats: CtxStats | null | undefined) {
  if (!stats?.window) return 0
  return Math.max(0, Math.min(100, Math.round((stats.currentContext / stats.window) * 100)))
}

// ctx 环形 dasharray（progress 映射到周长）。
export function ctxDash(stats: CtxStats | null | undefined) {
  const length = (CTX_CIRC * ctxProgress(stats)) / 100
  return `${length.toFixed(2)} ${CTX_CIRC.toFixed(2)}`
}

// Token 数人类可读：不足一万原样，否则取整为「N万」。
export function fmtWan(value: number) {
  if (!Number.isFinite(value) || value < 10000) return String(value)
  return `${(value / 10000).toFixed(0)}万`
}

// @ 提及候选：cmd → 斜杠命令过滤；file → 路径子串匹配，上限 8 条。
export function mentionList(current: { kind: 'file' | 'cmd'; query: string; index: number } | null, list: Array<{ path: string; kind: string }>) {
  if (!current) return []
  if (current.kind === 'cmd') return filterSlashCommands(current.query)
  return list.filter((item) => item.kind === 'file' && item.path.toLowerCase().includes(current.query.toLowerCase())).slice(0, 8)
}
