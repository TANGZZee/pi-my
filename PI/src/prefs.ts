export type Density = 'comfortable' | 'compact'
export type SendShortcut = 'enter' | 'ctrl-enter'
export type BusySend = 'steer' | 'followUp'
export type ModePref = 'plan' | 'ask' | 'full'
export type ThemePref = 'light' | 'dark' | 'system'
import type { SkinId } from './skins'
export type { SkinId }

export type Prefs = {
  autoName: boolean
  shell: string
  thinking: string
  mode: ModePref
  sendShortcut: SendShortcut
  busySend: BusySend
  restoreWorkspace: boolean
  lastWorkspace: string
  density: Density
  theme: ThemePref
  skin: SkinId
  petEnabled: boolean
  petModel: string
  notifyDone: boolean
  notifyConfirm: boolean
  gitTemplate: string
  showQuickChips: boolean
  showThinking: boolean
  /** U2：思考指示器样式——液态思考球（liquid）或经典原子（atom） */
  thinkingOrb: 'liquid' | 'atom'
  /** 2-8/U4：provider 额度重置周期，键为 provider 名（月度网关/每周订阅/每日） */
  quotaCycles: Record<string, 'daily' | 'weekly' | 'monthly' | 'none'>
  /** 2-11：界面语言（zh 源语言 / en 渐进翻译） */
  language: 'zh' | 'en'
}

const KEY = 'pdn.prefs'

export const DEFAULT_PREFS: Prefs = {
  autoName: true,
  shell: 'cmd',
  thinking: 'medium',
  mode: 'ask',
  sendShortcut: 'enter',
  busySend: 'steer',
  restoreWorkspace: true,
  lastWorkspace: '',
  density: 'comfortable',
  theme: 'light',
  skin: 'graphite',
  petEnabled: false,
  petModel: '',
  notifyDone: false,
  notifyConfirm: true,
  gitTemplate: '',
  showQuickChips: false,
  showThinking: true,
  thinkingOrb: 'liquid',
  quotaCycles: {},
  language: 'zh',
}

function readLegacy(): Partial<Prefs> {
  const next: Partial<Prefs> = {}
  if (localStorage.getItem('pdn.autoname') === '0') next.autoName = false
  const shell = localStorage.getItem('pdn.shell')
  if (shell) next.shell = shell
  const thinking = localStorage.getItem('pdn.thinking')
  if (thinking) next.thinking = thinking
  const workspace = localStorage.getItem('pdn.workspace')
  if (workspace) next.lastWorkspace = workspace
  return next
}

export function loadPrefs(): Prefs {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || 'null') as Partial<Prefs> | null
    return { ...DEFAULT_PREFS, ...readLegacy(), ...(parsed && typeof parsed === 'object' ? parsed : {}) }
  } catch {
    return { ...DEFAULT_PREFS, ...readLegacy() }
  }
}

export function savePrefs(prefs: Prefs) {
  localStorage.setItem(KEY, JSON.stringify(prefs))
  localStorage.setItem('pdn.autoname', prefs.autoName ? '1' : '0')
  localStorage.setItem('pdn.shell', prefs.shell)
  localStorage.setItem('pdn.thinking', prefs.thinking)
  if (prefs.lastWorkspace) localStorage.setItem('pdn.workspace', prefs.lastWorkspace)
  document.documentElement.dataset.density = prefs.density
  document.documentElement.dataset.appearance = prefs.skin || 'graphite'
  applyTheme(prefs.theme)
}

export function resolvedTheme(theme: ThemePref) {
  if (theme === 'dark') return 'dark'
  if (theme === 'light') return 'light'
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyTheme(theme: ThemePref = loadPrefs().theme) {
  document.documentElement.dataset.theme = resolvedTheme(theme)
}

export function patchPrefs(partial: Partial<Prefs>): Prefs {
  const next = { ...loadPrefs(), ...partial }
  savePrefs(next)
  return next
}

let systemListener: ((event: MediaQueryListEvent) => void) | undefined

export function applyPrefsChrome() {
  const prefs = loadPrefs()
  document.documentElement.dataset.density = prefs.density
  document.documentElement.dataset.appearance = prefs.skin || 'graphite'
  applyTheme(prefs.theme)
  // 「跟随系统」时监听系统明暗切换
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
  if (mq && !systemListener) {
    systemListener = () => { if (loadPrefs().theme === 'system') applyTheme('system') }
    mq.addEventListener?.('change', systemListener)
  }
}
