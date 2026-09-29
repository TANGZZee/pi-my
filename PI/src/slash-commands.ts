// 斜杠命令注册表（纯数据 + 纯函数，可单测）
//
// 为什么要单独成模块：旧实现把命令列表写在 App.svelte 里（10 条），
// 而分派逻辑是另一段 if-else，**只有 5 条有分支**，其余全部落到兜底
// `else void chooseWorkspace()` —— 于是打 `/compact` 会弹出「选择工作区」。
// 这类"列了但没实现"的 bug 在单一列表 + 单一分派里无法被发现。
//
// 现在每条命令都必须声明 `kind`，分派按 kind 走，`tests/slash-commands.test.mjs`
// 会断言"注册表里每条命令的 kind 都有对应的处理分支"，从结构上杜绝该问题。

/** 命令类别。新增类别必须在 App.svelte 的分派里实现，否则测试会失败。 */
export const SLASH_KINDS = [
  'new-session',   // 新建会话
  'open-settings', // 打开设置
  'choose-workspace', // 选择工作区
  'split-subagents',  // 并行拆分子代理
  'todo-panel',       // 打开待办面板
  'compact',          // 压缩上下文
  'export-session',   // 导出会话
  'set-mode-plan',    // 切到计划模式
  'login',            // 订阅登录
]

/**
 * 命令注册表。`label` 用于中文展示，`id` 是唯一键。
 * `insertText` 为需要参数的命令提供预填文本。
 */
export const SLASH_COMMANDS = [
  { id: 'new', label: '新建会话', desc: '打开一个空白会话', kind: 'new-session' },
  { id: 'settings', label: '打开设置', desc: '打开系统设置与配置管理', kind: 'open-settings' },
  { id: 'workspace', label: '选择工作区', desc: '更换当前项目目录', kind: 'choose-workspace' },
  { id: 'scout', label: '派 scout 侦察', desc: '只读探索，不改文件', kind: 'split-subagents' },
  { id: 'split', label: '并行拆分子代理', desc: '把任务拆给多个子代理', kind: 'split-subagents' },
  { id: 'todo', label: '添加待办', desc: '写入本会话待办列表', kind: 'todo-panel' },
  { id: 'compact', label: '压缩上下文', desc: '压缩会话上下文，释放上下文容量', kind: 'compact' },
  { id: 'login', label: '订阅登录', desc: 'OAuth / API Key 登录', kind: 'login' },
  { id: 'export', label: '导出会话', desc: '导出当前会话为 HTML / Markdown / JSON', kind: 'export-session' },
  { id: 'plan', label: '计划模式', desc: '切换只读探索', kind: 'set-mode-plan' },
]

/** 按 id 或展示名查找命令（大小写不敏感）。 */
export function findSlashCommand(text) {
  const raw = String(text || '').trim()
  if (!raw.startsWith('/')) return null
  const name = raw.slice(1).trim()
  if (!name) return null
  const lower = name.toLowerCase()
  return SLASH_COMMANDS.find((item) => item.id.toLowerCase() === lower || item.label.toLowerCase() === lower) || null
}

/** 供 @ 提及菜单过滤。 */
export function filterSlashCommands(query) {
  const q = String(query || '').trim()
  if (!q) return [...SLASH_COMMANDS]
  return SLASH_COMMANDS.filter((item) => item.id.startsWith(q) || item.label.includes(q))
}

/** 以 '/' 开头的补全触发判定：返回查询词，未触发时返回 null。 */
export function slashTriggerQuery(value) {
  const match = /^\/([^\s]*)$/.exec(String(value || ''))
  return match ? match[1] : null
}
