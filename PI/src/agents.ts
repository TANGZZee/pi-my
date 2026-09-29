export type AgentMode = 'plan' | 'ask' | 'full'

export type AgentDef = {
  name: string
  description: string
  systemPrompt: string
  mode: AgentMode
  builtin?: boolean
  /** U5：per-agent 模型覆盖（`provider:id` 键，同 App.svelte 的 modelKey）。
   *  缺省时继承发起时会话的模型。 */
  model?: string
  /** U5：per-agent 思考档位（off/minimal/low/medium/high/xhigh）。缺省 'low'（子代理要快）。 */
  thinking?: string
}

const KEY = 'pdn.agents'

export const SCOUT: AgentDef = {
  name: 'scout',
  description: '只读侦察：读文件、总结上下文，不改任何东西。',
  systemPrompt: 'You are scout, a read-only reconnaissance agent. Inspect files and answer the assigned task concisely. Never modify files or run mutating commands. Reply in the user\'s language.',
  mode: 'plan',
  builtin: true
}

export function loadAgents(): AgentDef[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || '[]') as AgentDef[]
    const custom = Array.isArray(parsed) ? parsed.filter((item) => item?.name && item.name !== 'scout') : []
    return [SCOUT, ...custom]
  } catch {
    return [SCOUT]
  }
}

export function saveCustomAgents(list: AgentDef[]) {
  const custom = list.filter((item) => !item.builtin && item.name && item.name !== 'scout')
  localStorage.setItem(KEY, JSON.stringify(custom))
}

export function findAgent(name: string): AgentDef | undefined {
  const key = name.trim().toLowerCase()
  return loadAgents().find((item) => item.name.toLowerCase() === key)
}

export function upsertAgent(def: AgentDef) {
  const name = def.name.trim().toLowerCase().replace(/\s+/g, '-')
  if (!name || name === 'scout') return loadAgents()
  const next = loadAgents().filter((item) => item.name !== name && !item.builtin)
  next.push({ ...def, name, builtin: false })
  saveCustomAgents(next)
  return loadAgents()
}

export function removeAgent(name: string) {
  saveCustomAgents(loadAgents().filter((item) => item.name !== name))
  return loadAgents()
}

export function wrapTask(def: AgentDef, task: string) {
  return `${def.systemPrompt}\n\nAssigned task:\n${task.trim()}`
}
