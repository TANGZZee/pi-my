// i18n 框架（2-11 第一阶段：框架 + 核心域字典）
//
// 设计原则（刻意从简）：
//   - 不引库。扁平 key → 字典，缺 key 时回退 zh（源语言），再缺则回显 key 本身
//   - 语言存 prefs.language；缺省 'zh'（现状全中文，英文是渐进补充）
//   - t(key, params) 插值用 {name} 占位，无复数/日期本地化（当前产品无此需求）
//   - 翻译域按 UI 分区拆文件（locales/zh.ts、locales/en.ts），避免单文件膨胀
//
// 渐进策略：既有 1 万+ 中文字符**不一次性迁移**（机械替换风险大于收益），
// 新增 UI 与核心高频区（导航/按钮/通用状态）先走 t()，其余域逐步搬迁。

import { loadPrefs } from './prefs.ts'

export type LocaleId = 'zh' | 'en'

export type Dict = Record<string, string>

const dicts = new Map<LocaleId, Dict>()
let current: LocaleId = 'zh'
let listener: Array<() => void> = []

/** 注册一种语言的字典（可多次调用合并，后注册的键优先）。 */
export function registerLocale(id: LocaleId, dict: Dict) {
  const existing = dicts.get(id) ?? {}
  dicts.set(id, { ...existing, ...dict })
}

/** 当前语言（跟随 prefs；prefs 未加载时缺省 zh）。 */
export function getLocale(): LocaleId {
  return current
}

/** 切换语言并广播。 */
export function setLocale(id: LocaleId) {
  if (id === current) return
  current = id
  for (const fn of listener) {
    try {
      fn()
    } catch {
      /* 单个监听者出错不影响其他 */
    }
  }
}

/** 语言变化订阅（Svelte 组件用 $: 读取 t 结果后手动触发重渲染）。 */
export function onLocaleChange(fn: () => void): () => void {
  listener.push(fn)
  return () => {
    listener = listener.filter((item) => item !== fn)
  }
}

/** 启动时调用：从 prefs 读取语言偏好。 */
export function initLocaleFromPrefs() {
  try {
    const stored = loadPrefs().language
    if (stored === 'en' || stored === 'zh') current = stored
  } catch {
    /* 非 DOM 环境（测试）保持 zh */
  }
}

/**
 * 翻译：t('settings.title')、t('queue.count', { n: 3 })。
 * 回退链：当前语言 → zh → key 本身（开发期能立刻发现漏翻）。
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const dict = dicts.get(current)
  let text = dict?.[key]
  if (text === undefined && current !== 'zh') text = dicts.get('zh')?.[key]
  if (text === undefined) return key
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
  }
  return text
}

// ---------------------------------------------------------------------------
// 启动即注册内置字典（当前源语言是中文，zh 字典同时是 key 的"人类可读版"）
// ---------------------------------------------------------------------------
registerLocale('zh', {
  // 通用
  'common.copy': '复制',
  'common.copied': '已复制',
  'common.cancel': '取消',
  'common.save': '保存',
  'common.delete': '删除',
  'common.retry': '重试',
  'common.loading': '加载中…',
  'common.refresh': '刷新',
  // 会话状态（run-slot 的 live 标签）
  'live.thinking': 'Thinking',
  'live.writing': 'Writing',
  'live.working': 'Working',
  'live.waiting': 'Waiting',
  // 状态栏面板（U4）
  'ctx.title': '上下文容量（估算）',
  'ctx.current': '当前上下文',
  'ctx.available': '可用容量',
  'ctx.window': '上下文窗口',
  'ctx.tokensTotal': '总 Token',
  'ctx.tokensInput': '输入',
  'ctx.tokensOutput': '输出',
  'ctx.cacheRead': '缓存读取',
  'ctx.cacheWrite': '缓存写入',
  'ctx.cost': '本地费率估算',
  'ctx.cacheRate': '平均缓存命中率',
  'ctx.quotaTitle': 'Provider 额度',
  'ctx.quotaNote': '重置时间为按周期估算；接口提供真实重置时间时优先展示',
  // 队列（2-4）
  'queue.title': '排队 {n} 条',
  'queue.hint': '当前回合结束后按顺序发送 · 可上移/下移/移除',
  'queue.up': '上移',
  'queue.down': '下移',
  'queue.remove': '移除',
  // 分支 / worktree（2-3/2-6）
  'branch.nav': '分支 {i}/{n}',
  'branch.worktreeFork': 'worktree 分叉',
  'branch.worktreeHint': '独立目录 · 与主工作区隔离',
  'branch.worktreeCreating': '创建中…',
  // 重试（1-7）
  'retry.line': '自动重试（第 {attempt} 次）· {reason}',
  // 图片展示（1-3）
  'showImage.aria': '查看大图',
})

registerLocale('en', {
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.delete': 'Delete',
  'common.retry': 'Retry',
  'common.loading': 'Loading…',
  'common.refresh': 'Refresh',
  'live.thinking': 'Thinking',
  'live.writing': 'Writing',
  'live.working': 'Working',
  'live.waiting': 'Waiting',
  'ctx.title': 'Context usage (estimated)',
  'ctx.current': 'Current context',
  'ctx.available': 'Available',
  'ctx.window': 'Context window',
  'ctx.tokensTotal': 'Total tokens',
  'ctx.tokensInput': 'Input',
  'ctx.tokensOutput': 'Output',
  'ctx.cacheRead': 'Cache read',
  'ctx.cacheWrite': 'Cache write',
  'ctx.cost': 'Local cost estimate',
  'ctx.cacheRate': 'Avg. cache hit rate',
  'ctx.quotaTitle': 'Provider quotas',
  'ctx.quotaNote': 'Reset times are cycle-based estimates; real values are used when the API provides them',
  'queue.title': '{n} queued',
  'queue.hint': 'Sent in order after the current turn · reorder or remove',
  'queue.up': 'Up',
  'queue.down': 'Down',
  'queue.remove': 'Remove',
  'branch.nav': 'Branch {i}/{n}',
  'branch.worktreeFork': 'worktree fork',
  'branch.worktreeHint': 'Isolated directory · separate from the main workspace',
  'branch.worktreeCreating': 'Creating…',
  'retry.line': 'Auto-retry (attempt {attempt}) · {reason}',
  'showImage.aria': 'View full size',
})
