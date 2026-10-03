// 0-5 拆分 App.svelte · 批次 A：模型/思考纯逻辑（从 App.svelte :275-286、:888-915 抽出）
//
// 与 session-tree.ts / session-run.ts 同一路线：纯函数 + 常量收进可单测模块，
// 组件只留接线。本模块**禁止**持有组件状态——只做「输入 → 输出」的变换。

// 显式 .ts 扩展名：本文件被 PI/tests 下的 node --test 直接加载，
// node 不做扩展名补全（与 session-run.ts → './queue-cas.ts' 同例）。

export interface AppModelInfo {
  provider: string
  id: string
  name: string
  reasoning: boolean
  source?: 'config' | 'extension'
}

/** 会话记忆的最小形状（App.svelte 的 Session 超集，这里只取用到的字段）。 */
export interface SessionLike {
  id: string
  model?: string
  thinking?: string
  mode?: string
  [key: string]: unknown
}

// ---- 常量（原 App.svelte :275-286；与 SDK THINKING_LEVEL_OPTIONS / DEFAULT_THINKING_LEVEL 对齐）----

/** 模型唯一键分隔符：provider 与 id 都可能含常见标点，用 \u0000 保证无碰撞。 */
export const MODEL_SEPARATOR = '\u0000'

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export const THINKING_LABELS: Record<string, string> = { off: '关', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最大' }

export const THINKING_HELP: Record<string, string> = { off: '不做额外思考', minimal: '最少推理，响应最快', low: '轻度推理，适合简单任务', medium: '均衡推理深度', high: '深入推理，适合复杂任务', xhigh: '更充分的推理与校验', max: '最深推理，耗时最长' }

export const DEFAULT_THINKING = 'medium'

export const MODE_LABELS: Record<string, string> = { plan: '计划', ask: '默认', full: '完全访问' }

export const MODE_OPTIONS: Array<{ value: string; label: string; desc: string }> = [
  { value: 'plan', label: '计划', desc: '只读探索，不改任何文件' },
  { value: 'ask', label: '默认', desc: '写与命令逐次确认' },
  { value: 'full', label: '完全访问', desc: '不拦截，仅建议可信项目' }
]

// ---- 纯函数（原 App.svelte :888-915，逻辑逐字保留）----

export function modelKey(model: Pick<AppModelInfo, 'provider' | 'id'>): string {
  return `${model.provider}${MODEL_SEPARATOR}${model.id}`
}

export function modelGroups(list: AppModelInfo[]): Array<{ provider: string; items: AppModelInfo[] }> {
  const groups: Array<{ provider: string; items: AppModelInfo[] }> = []
  for (const model of list) {
    const group = groups.find((item) => item.provider === model.provider)
    if (group) group.items.push(model)
    else groups.push({ provider: model.provider, items: [model] })
  }
  return groups
}

/** 无会话记忆时回退到模型列表第一项。 */
export function modelChoice(list: AppModelInfo[], records: SessionLike[], id: string): string {
  const remembered = records.find((item) => item.id === id)?.model
  if (remembered && list.some((model) => modelKey(model) === remembered)) return remembered
  return list.length ? modelKey(list[0]) : ''
}

export function thinkingChoice(records: SessionLike[], id: string): string {
  return records.find((item) => item.id === id)?.thinking ?? DEFAULT_THINKING
}

export function sessionMode(records: SessionLike[], id: string): string {
  return records.find((item) => item.id === id)?.mode ?? 'ask'
}
