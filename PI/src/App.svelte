<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { invoke } from '@tauri-apps/api/core'
  import { listen } from '@tauri-apps/api/event'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import { open, confirm } from '@tauri-apps/plugin-dialog'
  import Terminal from './Terminal.svelte'
  import Settings from './Settings.svelte'
  import Atom from './Atom.svelte'
  import ThinkingOrb from './ThinkingOrb.svelte'
  import VirtualFile from './VirtualFile.svelte'
  import { t as tt } from './i18n.ts'
  import PluginCard from './PluginCard.svelte'
  import { normalizePluginMessage, type PluginMessage } from './ui-plugins'

  /** 2-11：把 liveLabel 的英文标签翻译成本地语言（缺 key 回退英文原文）。 */
  function liveLabelKey(slot: RunSlot): string {
    const label = liveLabel(slot)
    if (!label) return ''
    return tt(`live.${label.toLowerCase()}`)
  }
  import Icon from './Icon.svelte'
  import MarkdownView from './MarkdownView.svelte'
  import Pet from './Pet.svelte'
  import LazyPet from './LazyPet.svelte'
  import { petById, petModelUrl } from './pets'
  import { version } from '../package.json'
  import logoUrl from './assets/pi-my-logo.png'
  import { applyPrefsChrome, loadPrefs, patchPrefs } from './prefs'
  import { findAgent, loadAgents, wrapTask, type AgentDef } from './agents'
  import { requestTimeoutMs, partitionPendingOnRestart, timeoutMessage } from './rpc-policy'
  import { SLASH_COMMANDS, filterSlashCommands, findSlashCommand, slashTriggerQuery } from './slash-commands'
  import type { AgentEnvelope } from './protocol'
  import { activeBranchSiblingsOf, buildSessionRows, sessionRootId as sessionRootIdOf } from './session-tree'
  import {
    appendThinkToSteps,
    brief,
    closeOpenSteps,
    endToolStep as endToolStepIn,
    ensureThinkingStep,
    formatReplyTime,
    historyToTimeline,
    lastAssistantReply,
    liveLabel,
    processSummary as processSummaryOf,
    sentFromTimeline,
  } from './run-slot'
  import { stateSummary, type StateSnapshot } from './session-state'
  import { withResetEstimate, formatResetCountdown } from './quota-reset'
  import { casRemove, casReorder } from './queue-cas'
  import { cycleTodoStatus, loadTodos, newTodo, saveTodos, todoTree, type TodoItem, type TodoStatus } from './todos'

  type PanelTab = '文档' | '变更' | '终端' | '运行' | '待办'
  type Session = { id: string; title: string; time: string; file?: string; cwd?: string; branch?: string; parentFile?: string; state?: 'active' | 'done'; model?: string; thinking?: string; mode?: string; pinned?: boolean; archived?: boolean; parentId?: string; branchParentId?: string; forkedFrom?: string; createdAt?: number; modifiedAt?: number; readOnly?: boolean }
  type ModelInfo = { provider: string; id: string; name: string; reasoning: boolean; source?: 'config' | 'extension' }
  type GitChange = { code: string; path: string }
  type SidecarResponse = { type: 'response'; id: number; ok: boolean; result: unknown; error?: string }
  type SentMessage = { text: string; at: string }
  type TimelineMessage = { id: string; role: 'user' | 'assistant'; text: string; at: string; timestamp: number; userIndex: number; entryId?: string }
  type SubRun = { id: string; agent: string; task: string; status: 'running' | 'done' | 'error'; reply: string }
  type Phase = 'idle' | 'thinking' | 'working' | 'writing' | 'waiting'
  type ProcessStep = { id: string; kind: 'think' | 'tool'; title: string; body: string; done: boolean }
  type QueuedMessage = { id: string; text: string }
  type RunSlot = { reply: string; thinking: string; tool: string; phase: Phase; running: boolean; error?: string; queue: QueuedMessage[]; queueRevision: number; steer: string[]; sent: SentMessage[]; timeline: TimelineMessage[]; subRuns: SubRun[]; process: ProcessStep[]; processOpen: boolean; replyAt?: number; historyLoaded?: boolean; activeTurnId?: string; confirm?: { confirmId: string; toolName: string; summary: string }; images?: Array<{ id: string; src: string; name: string }>; retry?: { attempt: number; reason: string }; compacting?: boolean; pluginMessages?: PluginMessage[] }
  type SettingsInfo = { node: string; sdk: string; agentDir: string; sessionDir: string; authProviders: string[]; providers?: Array<{ provider: string; modelCount: number; configured: boolean }> }
  type CtxStats = { currentContext: number; window: number; totals: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }; costUsd: number; cacheHitRate: number }
  type UsageStats = { sessions: number; turns: number; activeDays: number; totals: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }; costUsd: number; costKnown: boolean; byModel: Array<{ model: string; tokens: number; turns: number }>; byProject?: Array<{ project: string; tokens: number; turns: number }>; byDay?: Record<string, number> }
  type ImageGenConfig = { baseUrl: string; apiKey: string; model: string; size: string }
  type AgentUpdateInfo = { current: string; latest: string; installedVersion?: string; updateAvailable: boolean; url: string; repoUrl?: string; source?: string; sourceLabel?: string; updated?: boolean; restartRequired?: boolean; message?: string; checkedAt?: number }
  type WorkspaceProject = { path: string; name: string; addedAt: number }
  const CTX_CIRC = 2 * Math.PI * 7
  const EMPTY_CTX: CtxStats = { currentContext: 0, window: 0, totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, costUsd: 0, cacheHitRate: 0 }

  let sessions: Session[] = []

  const appWindow = getCurrentWindow()
  let maximized = false

  function toggleMaximize() {
    void appWindow.toggleMaximize().then(() => appWindow.isMaximized().then((value) => (maximized = value)))
  }

  let activeSession = '新会话'
  let activeSessionId = ''
  let panel: PanelTab = '文档'
  let leftTab: 'Activity' | 'Chats' | 'Projects' = 'Projects'
  let showLeft = true
  let showRight = true
  let showSettings = false
  let settingsInitialTab: 'about' | undefined = undefined
  type LoginPrompt = { promptId: string; type: string; message: string; placeholder?: string; options?: Array<{ id: string; label: string }> }
  type LoginState = { provider: string; status: string; userCode?: string; verificationUri?: string; prompt?: LoginPrompt; value: string }
  let loginState: LoginState | null = null

  // 扩展 UI 对话框（0-4）：select / input / editor / confirm
  type ExtDialog = {
    dialogId: string
    kind: 'confirm' | 'select' | 'input' | 'editor'
    title: string
    message?: string
    options?: string[]
    placeholder?: string
    prefill?: string
  }
  let extDialog: ExtDialog | null = null
  let extDialogValue = ''
  let extToasts: Array<{ id: string; text: string; type: string }> = []
  let petStatus: { base: string; pets: Array<{ id: string; model?: string | null; sprite?: string }> } = { base: '', pets: [] }
  let workspacePath = '.'
  let projects: WorkspaceProject[] = []
  let projectBusy = ''
  let filesLoading = false
  let files: Array<{ path: string; kind: 'file' | 'directory' }> = []
  let selectedFile = ''
  let fileContent = ''
  // 2-12：大文件走分块 + 虚拟化预览（read_file 对 >512KB 会报错，捕获后切此路径）
  let largeFile: { path: string } | null = null
  let editingFile = false
  let gitChanges: GitChange[] = []
  let diffContent = ''
  let staged: Record<string, boolean> = {}
  let commitMessage = ''
  let gitError = ''
  let inputText = ''
  let query = ''
  let runState: Record<string, RunSlot> = {}
  let runWatchdogs: Record<string, number> = {}
  let sidecarReady = false
  let models: ModelInfo[] = []
  let composerInput: HTMLTextAreaElement
  let modelOpen = false
  let modelMenuUp = false
  let modelQuery = ''
  let hiddenProviders: string[] = []
  let collapsedModelProviders: Record<string, boolean> = {}
  let providers: Array<{ provider: string; modelCount: number; configured: boolean }> = []
  let agentUpdate: AgentUpdateInfo | null = null
  let dismissedAgentUpdate = ''
  let agentUpdateBusy = false
  let agentUpdateTimer: number | undefined

  function loadHiddenProviders() {
    try { hiddenProviders = JSON.parse(localStorage.getItem('pdn.hidden-providers') ?? '[]') as string[] } catch { hiddenProviders = [] }
  }
  function loadCollapsedModelProviders() {
    try { collapsedModelProviders = JSON.parse(localStorage.getItem('pdn.collapsed-model-providers') ?? '{}') as Record<string, boolean> } catch { collapsedModelProviders = {} }
  }
  function toggleModelProvider(provider: string) {
    collapsedModelProviders = { ...collapsedModelProviders, [provider]: !collapsedModelProviders[provider] }
    try { localStorage.setItem('pdn.collapsed-model-providers', JSON.stringify(collapsedModelProviders)) } catch { /* ignore */ }
  }
  function providerCollapsed(provider: string) {
    return !modelQuery.trim() && Boolean(collapsedModelProviders[provider])
  }
  function refreshPrefs() {
    uiPrefs = loadPrefs()
    applyPrefsChrome()
    loadHiddenProviders()
    loadCollapsedModelProviders()
    void refreshPetStatus()
  }
  function desktopNotify(title: string, body: string) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return
    try { new Notification(title, { body }) } catch { /* ignore */ }
  }
  let modelSearchInput: HTMLInputElement
  let modelButtonRef: HTMLButtonElement
  let settingsInfo: SettingsInfo | null = null
  let usageStats: UsageStats | null = null
  let ctxStats: CtxStats = EMPTY_CTX
  let ctxOpen = false
  let ctxMenuUp = false
  let ctxButtonRef: HTMLButtonElement
  let thinkingOpen = false
  let thinkingMenuUp = false
  let thinkingDraft = ''
  let thinkingHelp = false
  let thinkingButtonRef: HTMLButtonElement
  let modeOpen = false
  let modeMenuUp = false
  let modeButtonRef: HTMLButtonElement
  let kindOpen = false
  let kindButtonRef: HTMLButtonElement
  let moreOpen = false
  let uiPrefs = loadPrefs()
  let todos: TodoItem[] = []
  let todoDraft = ''
  let todoParentId = ''
  let agentDefs: AgentDef[] = loadAgents()
  let splitOpen = false
  let splitRows: Array<{ agent: string; task: string }> = [{ agent: 'scout', task: '' }]
  let viewingSub: SubRun | null = null
  let attachments: Array<{ kind: 'image' | 'text'; name: string; mimeType?: string; data?: string; content?: string }> = []
  let imageGenMode = false
  let imageGenBusy = false
  let imageGenError = ''
  let imageGenResult: { src: string; prompt: string } | null = null
  let imageGenConfig: ImageGenConfig = { baseUrl: '', apiKey: '', model: '', size: '1024x1024' }
  let copiedReplyId = ''
  let forkBusy = false
  let branchOpen = false
  let attachError = ''
  let rightWidth = 280
  let sessionMenu: { session: Session; x: number; y: number } | null = null
  let dragging: 'left' | 'right' | null = null
  let dragStartX = 0
  let dragStartWidth = 0
  // 与 SDK 保持一致：THINKING_LEVEL_OPTIONS / DEFAULT_THINKING_LEVEL
  const MODEL_SEPARATOR = '\u0000'
  const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  const THINKING_LABELS: Record<string, string> = { off: '关', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最大' }
  const THINKING_HELP: Record<string, string> = { off: '不做额外思考', minimal: '最少推理，响应最快', low: '轻度推理，适合简单任务', medium: '均衡推理深度', high: '深入推理，适合复杂任务', xhigh: '更充分的推理与校验', max: '最深推理，耗时最长' }
  const DEFAULT_THINKING = 'medium'
  const MODE_LABELS: Record<string, string> = { plan: '计划', ask: '默认', full: '完全访问' }
  const MODE_OPTIONS: Array<{ value: string; label: string; desc: string }> = [
    { value: 'plan', label: '计划', desc: '只读探索，不改任何文件' },
    { value: 'ask', label: '默认', desc: '写与命令逐次确认' },
    { value: 'full', label: '完全访问', desc: '不拦截，仅建议可信项目' }
  ]
  const pending = new Map<number, (value: SidecarResponse) => void>()
  let requestSequence = 0

  $: openTabs = sessions.filter((item) => !item.archived && !item.parentId)
  $: filteredSessions = sessions.filter((item) => !item.archived && !item.parentId && item.title.toLowerCase().includes(query.toLowerCase())).sort((a, b) => Number(b.pinned) - Number(a.pinned))
  $: listedSessions = leftTab === 'Activity'
    ? filteredSessions.filter((item) => item.state === 'active' || slotFor(item.id).running)
    : filteredSessions

  // 会话树构建与关系判定已抽到 session-tree.ts（纯函数，可单测；0-5 第一步）
  $: sessionRows = buildSessionRows(listedSessions)
  $: activeBranchSiblings = activeBranchSiblingsOf(sessions, activeSessionId)
  $: activeBranchIndex = Math.max(0, activeBranchSiblings.findIndex((item) => item.id === activeSessionId))
  // 2-6 分支导航器：当前根下的完整树（带缩进深度），含归档过滤
  $: branchTreeRows = buildSessionRows(sessions.filter((item) => {
    if (item.archived) return false
    const rootId = sessionRootIdOf(item, sessions)
    const active = sessions.find((s) => s.id === activeSessionId)
    return active ? rootId === sessionRootIdOf(active, sessions) : true
  }))

  $: filteredFiles = files.filter((item) => item.path.toLowerCase().includes(query.toLowerCase()))
  let openDirs: Record<string, boolean> = {}
  function fileName(path: string) {
    return path.split('/').pop() || path
  }
  function treeChildren(prefix: string) {
    const base = prefix ? `${prefix}/` : ''
    return filteredFiles.filter((item) => {
      const rest = prefix ? (item.path.startsWith(base) ? item.path.slice(base.length) : '') : item.path
      return rest !== '' && !rest.includes('/')
    })
  }
  function toggleDir(path: string) {
    openDirs = { ...openDirs, [path]: !openDirs[path] }
  }
  $: currentModelKey = modelChoice(models, sessions, activeSessionId)
  $: currentModel = models.find((item) => modelKey(item) === currentModelKey)
  $: currentModelLabel = currentModel ? currentModel.name : '选择模型'
  $: modelFilter = modelQuery.trim().toLowerCase()
  $: modelMatches = (modelFilter ? models.filter((item) => item.name.toLowerCase().includes(modelFilter) || item.provider.toLowerCase().includes(modelFilter)) : models).filter((item) => !hiddenProviders.includes(item.provider))
  // 修复：让模型分组订阅折叠状态，点击后菜单会立即重绘。
  $: modelDropdownGroups = modelGroups(modelMatches).map((group) => ({
    ...group,
    collapsed: !modelQuery.trim() && Boolean(collapsedModelProviders[group.provider])
  }))
  // 修复：此前空白页判断藏在函数里，异步载入历史后不会自动刷新。
  $: activeSessionIdle = (() => {
    const slot = runState[activeSessionId]
    return !slot?.timeline.length && !slot?.reply && !slot?.running && !slot?.queue.length && !slot?.process.length
  })()
  $: currentThinking = thinkingChoice(sessions, activeSessionId)
  $: currentMode = sessionMode(sessions, activeSessionId)
  $: thinkingLevel = thinkingDraft || currentThinking
  $: thinkingIndex = Math.max(0, THINKING_LEVELS.indexOf(thinkingLevel))
  $: thinkingLabel = THINKING_LABELS[thinkingLevel] ?? thinkingLevel
  $: thinkingPercent = THINKING_LEVELS.length > 1 ? thinkingIndex / (THINKING_LEVELS.length - 1) : 0
  $: if (typeof document !== 'undefined') document.body.classList.toggle('resizing', dragging !== null)

  let processSeq = 0

  function emptySlot(): RunSlot {
    return { reply: '', thinking: '', tool: '', phase: 'idle', running: false, error: '', queue: [], queueRevision: 0, steer: [], sent: [], timeline: [], subRuns: [], process: [], processOpen: false, replyAt: undefined, historyLoaded: false, activeTurnId: undefined }
  }

  // brief / liveLabel / 过程摘要 / 历史映射已抽到 run-slot.ts（纯函数，0-5 第二步）

  function visibleProcess(slot: RunSlot) {
    return slot.process.filter((step) => uiPrefs.showThinking !== false || step.kind !== 'think')
  }

  function processSummary(slot: RunSlot) {
    return processSummaryOf(slot.process, uiPrefs.showThinking !== false)
  }

  function appendThink(id: string, text: string) {
    const slot = slotFor(id)
    patchSlot(id, {
      process: appendThinkToSteps(slot.process, text, ++processSeq),
      processOpen: true,
      phase: 'thinking',
      thinking: slot.thinking + text
    })
  }

  function markThinking(id: string) {
    const slot = slotFor(id)
    patchSlot(id, { process: ensureThinkingStep(slot.process, ++processSeq), processOpen: true, phase: 'thinking' })
  }

  function appendReply(id: string, text: string) {
    const slot = slotFor(id)
    patchSlot(id, {
      reply: slot.reply + text,
      phase: 'writing',
      replyAt: slot.replyAt || Date.now(),
      process: closeOpenSteps(slot.process)
    })
  }

  function applySessionHistory(id: string, history: Array<{ id?: string; role: 'user' | 'assistant'; text: string; timestamp?: number; userIndex?: number; entryId?: string }> = []) {
    const current = slotFor(id)
    if (current.running || current.historyLoaded) return
    const timeline = historyToTimeline(history)
    const lastReply = lastAssistantReply(timeline)
    patchSlot(id, {
      timeline,
      sent: sentFromTimeline(timeline),
      reply: lastReply?.text || '',
      replyAt: lastReply?.timestamp,
      historyLoaded: true,
      phase: 'idle',
      running: false,
      error: '',
      process: [],
      processOpen: false
    })
  }

  function clearRunWatchdog(id: string) {
    if (!runWatchdogs[id]) return
    window.clearTimeout(runWatchdogs[id])
    const next = { ...runWatchdogs }
    delete next[id]
    runWatchdogs = next
  }

  function touchRunWatchdog(id: string) {
    clearRunWatchdog(id)
    runWatchdogs = {
      ...runWatchdogs,
      [id]: window.setTimeout(() => {
        if (!slotFor(id).running) return
        clearRunWatchdog(id)
        finishRun(id, '模型超过 3 分钟没有返回任何结果。请检查当前模型的网络连接、额度或中转服务是否正常。')
      }, 180000)
    }
  }

  function startToolStep(id: string, toolName: string, toolCallId: string, args: unknown) {
    const slot = slotFor(id)
    const steps = closeOpenSteps(slot.process)
    steps.push({ id: toolCallId || `tool-${++processSeq}`, kind: 'tool', title: toolName || '工具', body: brief(args), done: false })
    patchSlot(id, { process: steps, processOpen: true, phase: 'working', tool: `正在执行 ${toolName || '工具'}…` })
  }

  function endToolStep(id: string, toolName: string, toolCallId: string, result: unknown, isError?: boolean) {
    const slot = slotFor(id)
    patchSlot(id, {
      process: endToolStepIn(slot.process, toolCallId, toolName, result, isError),
      phase: 'thinking',
      tool: isError ? `${toolName || '工具'} 失败` : ''
    })
  }

  function slotFor(id: string): RunSlot {
    return { ...emptySlot(), ...runState[id] }
  }

  // 整体替换 runState，保证 Svelte 检测到变化
  function patchSlot(id: string, patch: Partial<RunSlot>) {
    runState = { ...runState, [id]: { ...emptySlot(), ...runState[id], ...patch } }
  }

  function finishRun(id: string, errorMessage = '') {
    clearRunWatchdog(id)
    const current = slotFor(id)
    if (!current.running && !current.activeTurnId) return
    const process = closeOpenSteps(current.process)
    const replyAt = current.reply && !current.replyAt ? Date.now() : current.replyAt
    const assistantId = `assistant-${current.activeTurnId || Date.now()}`
    const timeline = current.reply.trim() && !current.timeline.some((item) => item.id === assistantId)
      ? [...current.timeline, {
          id: assistantId,
          role: 'assistant' as const,
          text: current.reply,
          at: formatReplyTime(replyAt),
          timestamp: replyAt || Date.now(),
          userIndex: Math.max(0, current.sent.length - 1)
        }]
      : current.timeline
    patchSlot(id, {
      running: false,
      phase: 'idle',
      tool: '',
      error: errorMessage,
      replyAt,
      activeTurnId: undefined,
      confirm: undefined,
      retry: undefined,
      compacting: false,
      steer: [],
      process,
      // 修改：结束后只保留一行“过程”摘要，用户点击后再展开。
      processOpen: false,
      timeline
    })
    markSession(id, 'done')
    finishSubRun(id, errorMessage ? 'error' : 'done')
    void refreshCtxStats()
    if (!errorMessage && loadPrefs().notifyDone && !sessions.find((item) => item.id === id)?.parentId) desktopNotify('Pi-My', '任务已完成')
    if (!errorMessage) window.setTimeout(() => drainQueue(id), 40)
  }

  $: if (activeSessionId) todos = loadTodos(activeSessionId)
  $: todoView = todoTree(todos)

  function persistTodos(next: TodoItem[]) {
    todos = next
    saveTodos(activeSessionId, next)
  }

  function addTodo(parentId?: string) {
    const content = todoDraft.trim()
    if (!content) return
    persistTodos([...todos, newTodo(content, parentId || undefined)])
    todoDraft = ''
    todoParentId = ''
  }

  function setTodoStatus(id: string, status: TodoStatus) {
    persistTodos(todos.map((item) => item.id === id ? { ...item, status } : item))
  }

  function removeTodo(id: string) {
    persistTodos(todos.filter((item) => item.id !== id && item.parentId !== id))
  }

  function finishSubRun(id: string, status: SubRun['status']) {
    const reply = slotFor(id).reply
    for (const [parentId, slot] of Object.entries(runState)) {
      if (!slot.subRuns?.some((run) => run.id === id)) continue
      patchSlot(parentId, {
        subRuns: slot.subRuns.map((run) => run.id === id ? { ...run, status, reply } : run)
      })
    }
    if (viewingSub?.id === id) viewingSub = { ...viewingSub, status, reply }
  }

  function recallMessage(index: number) {
    const slot = slotFor(activeSessionId)
    const message = slot.sent[index]
    if (!message) return
    if (slot.running) stop()
    inputText = message.text
    mention = null
    const cutIndex = slot.timeline.findIndex((item) => item.role === 'user' && item.userIndex === index)
    const timeline = cutIndex >= 0 ? slot.timeline.slice(0, cutIndex) : slot.timeline
    const previousReply = [...timeline].reverse().find((item) => item.role === 'assistant')
    patchSlot(activeSessionId, {
      sent: slot.sent.slice(0, index),
      timeline,
      reply: previousReply?.text || '',
      replyAt: previousReply?.timestamp,
      thinking: '',
      tool: '',
      queue: [],
      queueRevision: 0,
      process: [],
      processOpen: false,
      phase: 'idle'
    })
    window.setTimeout(() => composerInput?.focus(), 0)
  }

  async function spawnSubagent(agentName: string, task: string) {
    const def = findAgent(agentName) ?? findAgent('scout')
    if (!def || !task.trim()) return
    const parentId = ensureActiveId()
    const childId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const run: SubRun = { id: childId, agent: def.name, task: task.trim(), status: 'running', reply: '' }
    patchSlot(parentId, { subRuns: [...slotFor(parentId).subRuns, run] })
    sessions = [{ id: childId, title: `${def.name} · ${task.trim().slice(0, 24)}`, time: '刚刚', parentId, readOnly: true, mode: def.mode, model: def.model, thinking: def.thinking }, ...sessions]
    if (!sidecarReady) {
      window.setTimeout(() => finishSubRun(childId, 'done'), 800)
      return
    }
    try {
      // U5：思考档位可被 per-agent 定义覆盖（默认 low —— 子代理要快）。
      // 模型覆盖同理：def.model 是 `provider${MODEL_SEPARATOR}modelId` 键。
      const created = await request('create_session', { sessionId: childId, cwd: workspacePath, mode: def.mode, thinking: def.thinking ?? 'low' }) as { id: string; file?: string }
      remember(childId, { file: created.file, mode: def.mode, readOnly: true, parentId, thinking: def.thinking })
      if (def.model) {
        const [provider, modelId] = def.model.split(MODEL_SEPARATOR)
        if (provider && modelId) {
          // 审查 P2-①：set_model 失败（模型不存在/未配置）时不能静默降级——
          // 会话记录里也不能留着未生效的 model，否则 UI 显示与实际不符。
          const result = await request('set_model', { sessionId: childId, provider, modelId }) as { provider: string; id: string } | null
          if (result) remember(childId, { model: `${result.provider}${MODEL_SEPARATOR}${result.id}` })
          else console.warn(`[pi-my] 子代理 "${def.name}" 的模型 ${def.model} 设置失败，已回退默认模型`)
        }
      }
      await request('prompt', { sessionId: childId, text: wrapTask(def, task), cwd: workspacePath, behavior: 'steer', mode: def.mode })
    } catch {
      finishSubRun(childId, 'error')
    }
  }

  function runSplit() {
    const jobs = splitRows.map((row) => ({ agent: row.agent.trim() || 'scout', task: row.task.trim() })).filter((row) => row.task)
    splitOpen = false
    splitRows = [{ agent: 'scout', task: '' }]
    for (const job of jobs) void spawnSubagent(job.agent, job.task)
  }

  function markSession(id: string, state: 'active' | 'done') {
    sessions = sessions.map((item) => (item.id === id ? { ...item, state } : item))
  }

  // 记住会话级的模型 / 思考档位选择；无记录时建占位会话
  function remember(id: string, patch: Partial<Session>) {
    if (!id) return
    const now = Date.now()
    if (!sessions.some((item) => item.id === id)) sessions = [{ id, title: '新会话', time: '刚刚', createdAt: now, modifiedAt: now, ...patch }, ...sessions]
    else sessions = sessions.map((item) => (item.id === id ? { ...item, ...patch, modifiedAt: now } : item))
  }

  function ensureActiveId() {
    if (!activeSessionId) {
      activeSessionId = `session-${Date.now()}`
      activeSession = '新会话'
    }
    return activeSessionId
  }

  function modelKey(model: ModelInfo) {
    return `${model.provider}${MODEL_SEPARATOR}${model.id}`
  }

  function modelGroups(list: ModelInfo[]) {
    const groups: Array<{ provider: string; items: ModelInfo[] }> = []
    for (const model of list) {
      const group = groups.find((item) => item.provider === model.provider)
      if (group) group.items.push(model)
      else groups.push({ provider: model.provider, items: [model] })
    }
    return groups
  }

  // 无会话记忆时回退到模型列表第一项
  function modelChoice(list: ModelInfo[], records: Session[], id: string) {
    const remembered = records.find((item) => item.id === id)?.model
    if (remembered && list.some((model) => modelKey(model) === remembered)) return remembered
    return list.length ? modelKey(list[0]) : ''
  }

  function thinkingChoice(records: Session[], id: string) {
    return records.find((item) => item.id === id)?.thinking ?? DEFAULT_THINKING
  }

  function sessionMode(records: Session[], id: string) {
    return records.find((item) => item.id === id)?.mode ?? 'ask'
  }

  function workspaceBase() {
    if (workspacePath === '.') return '当前目录'
    return workspacePath.split(/[\\/]/).pop() || workspacePath
  }

  function loadProjects() {
    try {
      const parsed = JSON.parse(localStorage.getItem('pdn.projects') ?? '[]') as WorkspaceProject[]
      return Array.isArray(parsed) ? parsed.filter((item) => item?.path && item?.name) : []
    } catch {
      return []
    }
  }

  function saveProjects() {
    try { localStorage.setItem('pdn.projects', JSON.stringify(projects)) } catch { /* ignore */ }
  }

  function projectName(path: string) {
    return path.split(/[\\/]/).filter(Boolean).pop() || path
  }

  function addProjectPath(path: string) {
    if (!path || path === '.') return
    const normalized = path.replace(/[\\/]+$/, '')
    const existing = projects.find((item) => item.path.toLowerCase() === normalized.toLowerCase())
    if (existing) {
      projects = [{ ...existing, name: projectName(normalized) }, ...projects.filter((item) => item !== existing)]
    } else {
      projects = [{ path: normalized, name: projectName(normalized), addedAt: Date.now() }, ...projects]
    }
    saveProjects()
  }

  async function activateProject(path: string) {
    if (!path || path === '.' || projectBusy === path) return
    workspacePath = path
    projectBusy = path
    selectedFile = ''
    fileContent = ''
    files = []
    gitChanges = []
    diffContent = ''
    panel = '文档'
    uiPrefs = patchPrefs({ lastWorkspace: path })
    addProjectPath(path)
    try {
      if (sidecarReady) {
        await request('set_workspace', { cwd: path })
        await Promise.all([loadFiles(path), refreshGit(path)])
      }
    } finally {
      if (projectBusy === path) projectBusy = ''
    }
  }

  async function removeProject(path: string) {
    projects = projects.filter((item) => item.path.toLowerCase() !== path.toLowerCase())
    saveProjects()
    if (workspacePath.toLowerCase() !== path.toLowerCase()) return
    const next = projects[0]
    if (next) await activateProject(next.path)
    else {
      workspacePath = '.'
      files = []
      selectedFile = ''
      fileContent = ''
      gitChanges = []
      diffContent = ''
      patchPrefs({ lastWorkspace: '' })
    }
  }

  function workspaceLabel() {
    return workspacePath === '.' ? '选择工作区' : workspaceBase()
  }

  function statusDotTitle(session: Session) {
    if (session.state === 'active') return '运行中'
    if (session.state === 'done') return '已完成'
    return '空闲'
  }

  function openSessionMenu(event: MouseEvent, session: Session) {
    event.preventDefault()
    const width = 190
    const height = 360
    sessionMenu = {
      session,
      x: Math.min(event.clientX, window.innerWidth - width - 8),
      y: Math.min(event.clientY, window.innerHeight - height - 8)
    }
  }

  function togglePin(session: Session) {
    sessions = sessions.map((item) => item.id === session.id ? { ...item, pinned: !item.pinned } : item)
    sessionMenu = null
  }

  async function renameSession(session: Session) {
    sessionMenu = null
    const name = window.prompt('重命名会话', session.title)?.trim()
    if (!name || name === session.title) return
    sessions = sessions.map((item) => item.id === session.id ? { ...item, title: name } : item)
    if (sidecarReady && session.file) await request('rename_session', { sessionId: session.id, name })
    if (activeSessionId === session.id) activeSession = name
  }

  async function archiveSession(session: Session) {
    sessionMenu = null
    const response = await requestRaw('set_session_archived', { sessionId: session.id, archived: true })
    if (!response.ok) {
      window.alert(response.error || '归档会话失败')
      return
    }
    sessions = sessions.map((item) => item.id === session.id ? { ...item, archived: true } : item)
    if (activeSessionId === session.id) {
      const next = sessions.find((item) => !item.archived && !item.parentId && item.id !== session.id)
      if (next) void selectSession(next)
      else {
        activeSessionId = ''
        activeSession = '新会话'
      }
    }
  }

  // 只依赖会话的最小形状：设置页的「已归档」列表用的是 ArchivedSession（没有 time 字段），
  // 所以这里不能要求完整的 Session 类型。
  async function unarchiveSession(session: { id: string; title?: string; file?: string }) {
    const response = await requestRaw('set_session_archived', { sessionId: session.id, archived: false })
    if (!response.ok) throw new Error(response.error || '取消归档失败')
    sessions = sessions.map((item) => item.id === session.id ? { ...item, archived: false } : item)
  }

  async function deleteSession(session: { id: string; title?: string; file?: string }, skipConfirm = false) {
    sessionMenu = null
    if (!skipConfirm) {
      const ok = await confirm(`确定永久删除会话「${session.title}」吗？删除后无法恢复。`, { title: '删除会话', kind: 'warning' })
      if (!ok) return
    }
    const response = await requestRaw('delete_session', { sessionId: session.id, file: session.file })
    if (!response.ok) {
      window.alert(response.error || '删除会话失败')
      return
    }
    const rest = sessions.filter((item) => item.id !== session.id)
    sessions = rest
    if (runState[session.id]) {
      const nextState = { ...runState }
      delete nextState[session.id]
      runState = nextState
    }
    if (activeSessionId === session.id) {
      const next = rest.find((item) => !item.archived && !item.parentId)
      if (next) await selectSession(next)
      else {
        activeSessionId = ''
        activeSession = '新会话'
      }
    }
  }

  function tabTitle(session: Session) {
    return session.title === '新会话' || !session.title ? 'Pi-My agent' : session.title
  }

  async function closeTab(session: Session) {
    if (slotFor(session.id).running) {
      if (sidecarReady) await request('abort', { sessionId: session.id }).catch(() => {})
      clearRunWatchdog(session.id)
      patchSlot(session.id, { running: false, phase: 'idle', tool: '', processOpen: false, confirm: undefined })
    }
    if (sidecarReady) await request('close_session', { sessionId: session.id }).catch(() => {})
    const rest = sessions.filter((item) => item.id !== session.id)
    sessions = rest
    if (runState[session.id]) {
      const nextState = { ...runState }
      delete nextState[session.id]
      runState = nextState
    }
    if (activeSessionId !== session.id) return
    const next = rest.find((item) => !item.archived && !item.parentId)
    if (next) await selectSession(next)
    else {
      activeSessionId = ''
      activeSession = '新会话'
    }
  }

  function chooseSessionModel(session: Session) {
    sessionMenu = null
    void selectSession(session).then(() => { modelOpen = true })
  }

  function copySessionValue(value: string) {
    void navigator.clipboard?.writeText(value)
    sessionMenu = null
  }

  async function exportSession(session: Session) {
    let data = JSON.stringify({ id: session.id, title: session.title, file: session.file, workspace: workspacePath }, null, 2)
    if (sidecarReady && session.file) {
      const response = await requestRaw('export_session', { sessionId: session.id, file: session.file })
      if (response.ok && response.result && typeof response.result === 'object' && 'content' in response.result) {
        data = String((response.result as { content: unknown }).content)
      }
    }
    const blob = new Blob([data], { type: 'application/json' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `${session.title || session.id}.json`
    link.click()
    URL.revokeObjectURL(link.href)
    sessionMenu = null
  }

  function documentStats() {
    if (!selectedFile) return ''
    const lines = fileContent ? fileContent.split('\n').length : 0
    const kb = Math.max(1, Math.ceil(new TextEncoder().encode(fileContent).length / 1024))
    return `${lines} 行 · ${kb} KB`
  }

  function clickOutside(node: HTMLElement) {
    function onMouseDown(event: MouseEvent) {
      if (!node.contains(event.target as Node)) modelOpen = false
    }
    function onKeydown(event: KeyboardEvent) {
      if (event.key === 'Escape') modelOpen = false
    }
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKeydown)
    return {
      destroy() {
        window.removeEventListener('mousedown', onMouseDown)
        window.removeEventListener('keydown', onKeydown)
      }
    }
  }

  function clickOutsideCtx(node: HTMLElement) {
    function onMouseDown(event: MouseEvent) {
      if (!node.contains(event.target as Node)) ctxOpen = false
    }
    function onKeydown(event: KeyboardEvent) {
      if (event.key === 'Escape') ctxOpen = false
    }
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKeydown)
    return {
      destroy() {
        window.removeEventListener('mousedown', onMouseDown)
        window.removeEventListener('keydown', onKeydown)
      }
    }
  }

  function clickOutsideThinking(node: HTMLElement) {
    function onMouseDown(event: MouseEvent) {
      if (!node.contains(event.target as Node)) thinkingOpen = false
    }
    function onKeydown(event: KeyboardEvent) {
      if (event.key === 'Escape') thinkingOpen = false
    }
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKeydown)
    return {
      destroy() {
        window.removeEventListener('mousedown', onMouseDown)
        window.removeEventListener('keydown', onKeydown)
      }
    }
  }

  function clickOutsideMode(node: HTMLElement) {
    function onMouseDown(event: MouseEvent) {
      if (!node.contains(event.target as Node)) modeOpen = false
    }
    function onKeydown(event: KeyboardEvent) {
      if (event.key === 'Escape') modeOpen = false
    }
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKeydown)
    return {
      destroy() {
        window.removeEventListener('mousedown', onMouseDown)
        window.removeEventListener('keydown', onKeydown)
      }
    }
  }

  function clickOutsideKind(node: HTMLElement) {
    function onMouseDown(event: MouseEvent) {
      if (!node.contains(event.target as Node)) kindOpen = false
    }
    function onKeydown(event: KeyboardEvent) {
      if (event.key === 'Escape') kindOpen = false
    }
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKeydown)
    return {
      destroy() {
        window.removeEventListener('mousedown', onMouseDown)
        window.removeEventListener('keydown', onKeydown)
      }
    }
  }

  function clickOutsideBranch(node: HTMLElement) {
    function onMouseDown(event: MouseEvent) {
      if (!node.contains(event.target as Node)) branchOpen = false
    }
    function onKeydown(event: KeyboardEvent) {
      if (event.key === 'Escape') branchOpen = false
    }
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKeydown)
    return {
      destroy() {
        window.removeEventListener('mousedown', onMouseDown)
        window.removeEventListener('keydown', onKeydown)
      }
    }
  }

  function toggleKind() {
    kindOpen = !kindOpen
    if (kindOpen) {
      modeOpen = false
      modelOpen = false
      thinkingOpen = false
      ctxOpen = false
    }
  }

  function toggleMore() {
    moreOpen = !moreOpen
    if (moreOpen) { kindOpen = false; modeOpen = false; modelOpen = false; thinkingOpen = false; ctxOpen = false }
  }

  function clickOutsideMore(node: HTMLElement) {
    function onMouseDown(event: MouseEvent) {
      if (!node.contains(event.target as Node)) moreOpen = false
    }
    function onKeydown(event: KeyboardEvent) {
      if (event.key === 'Escape') moreOpen = false
    }
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKeydown)
    return {
      destroy() {
        window.removeEventListener('mousedown', onMouseDown)
        window.removeEventListener('keydown', onKeydown)
      }
    }
  }

  function setAgentKind(next: boolean) {
    imageGenMode = next
    imageGenError = ''
    kindOpen = false
  }

  function toggleMode() {
    modeOpen = !modeOpen
    if (modeOpen) {
      kindOpen = false
      modelOpen = false
      thinkingOpen = false
      ctxOpen = false
      const rect = modeButtonRef?.getBoundingClientRect()
      if (rect) modeMenuUp = window.innerHeight - rect.bottom < 220
    }
  }

  async function setMode(mode: string) {
    modeOpen = false
    if (!mode) return
    const id = ensureActiveId()
    remember(id, { mode })
    if (!sidecarReady || !sessions.some((item) => item.id === id && item.file)) return
    await request('set_mode', { sessionId: id, mode })
  }

  function toggleThinking() {
    thinkingOpen = !thinkingOpen
    thinkingDraft = ''
    if (thinkingOpen) {
      thinkingHelp = false
      modelOpen = false
      modeOpen = false
      ctxOpen = false
      kindOpen = false
      const rect = thinkingButtonRef?.getBoundingClientRect()
      if (rect) thinkingMenuUp = window.innerHeight - rect.bottom < 220
    }
  }

  function clampWidth(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value))
  }

  function startDrag(event: MouseEvent, side: 'right') {
    event.preventDefault()
    dragging = side
    dragStartX = event.clientX
    dragStartWidth = rightWidth
    window.addEventListener('mousemove', onDragMove)
    window.addEventListener('mouseup', stopDrag)
  }

  function onDragMove(event: MouseEvent) {
    if (!dragging) return
    const delta = event.clientX - dragStartX
    rightWidth = clampWidth(dragStartWidth - delta, 240, 480)
  }

  function stopDrag() {
    dragging = null
    window.removeEventListener('mousemove', onDragMove)
    window.removeEventListener('mouseup', stopDrag)
  }

  function resetDrag(side: 'right') {
    rightWidth = 280
  }

  // 窗口变窄时收回侧栏宽度，避免左/右栏与聊天区合计超出窗口
  function clampToViewport() {
    if (window.innerWidth <= 1050) return
    const grid = document.querySelector('.window') as HTMLElement | null
    const total = grid?.clientWidth ?? window.innerWidth
    let left = showLeft ? 220 : 0
    let right = showRight ? rightWidth : 0
    let overflow = left + right + 430 - total
    if (overflow <= 0) return
    const rightCut = Math.min(overflow, Math.max(0, right - 240))
    right -= rightCut
    if (showRight) rightWidth = right
  }

  onDestroy(() => {
    stopDrag()
    if (agentUpdateTimer) window.clearInterval(agentUpdateTimer)
    window.removeEventListener('resize', clampToViewport)
    if (typeof document !== 'undefined') document.body.classList.remove('resizing')
  })

  function toggleCtx() {
    ctxOpen = !ctxOpen
    if (ctxOpen) {
      modelOpen = false
      thinkingOpen = false
      modeOpen = false
      kindOpen = false
      const rect = ctxButtonRef?.getBoundingClientRect()
      if (rect) ctxMenuUp = window.innerHeight - rect.bottom < 320
      void refreshCtxStats()
      void refreshQuotas()
    }
  }

  // 2-8/U4：provider 额度 + 重置时间（打开面板时拉一次，不自动轮询——probe 有网络开销）
  type QuotaRow = { provider: string; ok?: boolean; message?: string; value?: unknown } & { nextResetAt: string | null; msUntilReset: number | null; cycleElapsedPercent: number | null }
  let quotas: QuotaRow[] = []
  let quotasBusy = false
  let quotasQueriedAt = 0

  async function refreshQuotas() {
    if (!sidecarReady || quotasBusy) return
    quotasBusy = true
    try {
      const response = await requestRaw('provider_quotas', {})
      if (response.ok && activeSessionId) {
        const result = response.result as { quotas?: Array<{ provider: string; ok?: boolean; message?: string; value?: unknown }>; queriedAt?: number } | null
        const cycles = loadPrefs().quotaCycles ?? {}
        quotas = (result?.quotas ?? []).map((quota) => withResetEstimate({ ...quota, cycle: cycles[quota.provider] ?? 'monthly' }))
        quotasQueriedAt = result?.queriedAt ?? Date.now()
      }
    } finally {
      quotasBusy = false
    }
  }

  function formatCountdown(ms: number | null): string {
    return formatResetCountdown(ms)
  }

  // U4 状态栏面板：get_state 的完整快照（ctxOpen 面板里展示）
  let sessionState: StateSnapshot | null = null
  $: stateSummaryView = sessionState ? stateSummary(sessionState) : null

  async function refreshCtxStats() {
    if (!sidecarReady || !activeSessionId) return
    const id = activeSessionId
    try {
      // 1-8：改用 get_state 单一快照（含 session_stats 的全部字段 + U4 需要的额外状态）。
      // peekState 语义：只读，不重置任何会话生命周期。
      const response = await requestRaw('get_state', { sessionId: id })
      if (!response.ok || activeSessionId !== id) {
        if (activeSessionId === id) ctxStats = { ...EMPTY_CTX }
        return
      }
      const snapshot = response.result as StateSnapshot | null
      if (!snapshot) { ctxStats = { ...EMPTY_CTX }; return }
      // 既有上下文环继续用本地口径字段（get_state 已透传 currentContext/window/costUsd/cacheHitRate）
      ctxStats = {
        currentContext: Number(snapshot.currentContext) || 0,
        window: Number(snapshot.window) || 0,
        totals: (snapshot.stats?.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }) as CtxStats['totals'],
        costUsd: Number(snapshot.stats?.cost ?? snapshot.costUsd) || 0,
        cacheHitRate: Number(snapshot.cacheHitRate) || 0,
      }
      // U4 状态栏面板的完整快照
      sessionState = snapshot
    } catch {
      if (activeSessionId === id) {
        ctxStats = { ...EMPTY_CTX }
        sessionState = null
      }
    }
  }

  function ctxProgress() {
    if (!ctxStats?.window) return 0
    return Math.max(0, Math.min(100, Math.round((ctxStats.currentContext / ctxStats.window) * 100)))
  }

  function ctxDash() {
    const length = (CTX_CIRC * ctxProgress()) / 100
    return `${length.toFixed(2)} ${CTX_CIRC.toFixed(2)}`
  }

  function fmtWan(value: number) {
    if (!Number.isFinite(value) || value < 10000) return String(value)
    return `${(value / 10000).toFixed(0)}万`
  }

  function toggleModel() {
    modelOpen = !modelOpen
    if (modelOpen) {
      thinkingOpen = false
      modeOpen = false
      ctxOpen = false
      kindOpen = false
      modelQuery = ''
      const rect = modelButtonRef?.getBoundingClientRect()
      if (rect) modelMenuUp = window.innerHeight - rect.bottom < 360
      window.setTimeout(() => modelSearchInput?.focus(), 0)
    }
  }

  async function setModel(value: string) {
    if (!value || !sidecarReady) return
    const id = ensureActiveId()
    remember(id, { model: value })
    if (!sessions.some((item) => item.id === id && item.file)) return
    const [provider, modelId] = value.split(MODEL_SEPARATOR)
    const result = await request('set_model', { sessionId: id, provider, modelId }) as { provider: string; id: string; thinkingLevel?: string } | null
    if (result) remember(id, { model: `${result.provider}${MODEL_SEPARATOR}${result.id}`, thinking: result.thinkingLevel ?? thinkingChoice(sessions, id) })
    else remember(id, { model: undefined })
  }

  function pickModel(model: ModelInfo) {
    modelOpen = false
    modelQuery = ''
    void setModel(modelKey(model))
  }

  async function setThinking(level: string) {
    if (!level || !sidecarReady) return
    const id = ensureActiveId()
    remember(id, { thinking: level })
    if (!sessions.some((item) => item.id === id && item.file)) return
    const result = await request('set_thinking', { sessionId: id, level }) as { level?: string } | null
    // setThinkingLevel 会按模型能力 clamp，以 sidecar 回传的实际档位为准
    remember(id, { thinking: result?.level })
  }

  // 拖动中只更新本地 draft，松手（change）才提交，避免频繁请求 sidecar
  function onThinkingInput(event: Event) {
    const level = THINKING_LEVELS[Number((event.currentTarget as HTMLInputElement).value)]
    if (level) thinkingDraft = level
  }

  function onThinkingChange(event: Event) {
    const level = THINKING_LEVELS[Number((event.currentTarget as HTMLInputElement).value)]
    thinkingDraft = ''
    if (level) void setThinking(level)
  }

  function toggleThinkingHelp() {
    thinkingHelp = !thinkingHelp
  }

  // 统一的请求发送：挂 pending、按类型设超时、失败/超时都清理并 settle。
  // 修复点：旧实现没有超时——sidecar 若挂住或悄悄死掉，pending 会永久泄漏且
  // 调用方的 await 永不 settle（界面一直转圈，无任何提示）。
  function sendRequest(type: string, payload: object): Promise<SidecarResponse> {
    const id = ++requestSequence
    const timeoutMs = requestTimeoutMs(type)
    return new Promise<SidecarResponse>((resolve) => {
      let timer: number | undefined
      const settle = (response: SidecarResponse) => {
        if (!pending.has(id)) return
        pending.delete(id)
        if (timer !== undefined) window.clearTimeout(timer)
        resolve(response)
      }
      pending.set(id, settle)
      if (Number.isFinite(timeoutMs)) {
        timer = window.setTimeout(() => {
          settle({ type: 'response', id, ok: false, result: null, error: timeoutMessage(type, timeoutMs) })
        }, timeoutMs)
      }
      // outstanding 计数由 Rust 在 agent_request 成功路径 +1（lib.rs:348）；
      // 前端只在收到响应时 -1。此前前端也 +1，造成每次请求净漏 +1，
      // 应用空闲 6 分钟后必然被误判僵死并反复重启（审查高-1）。
      void invoke('agent_request', { request: { id, type, payload } }).catch((error) => {
        settle({ type: 'response', id, ok: false, result: null, error: String(error) })
      })
    })
  }

  function request(type: string, payload = {}) {
    return sendRequest(type, payload).then((response) => response.result)
  }

  function requestRaw(type: string, payload = {}) {
    return sendRequest(type, payload)
  }

  // sidecar 重启后，旧请求的响应永远不会到达；必须清空 pending 并明确告知用户，
  // 否则界面会停在"运行中"且后续交互静默失效。
  // `keepId` 是 Rust 侧重启后已经重新发起的那个请求——它仍然有效，不能一起丢掉。
  function onSidecarRestarted(reason: string, keepId?: number) {
    const { aborted, kept } = partitionPendingOnRestart([...pending.keys()], keepId)
    const survivors = new Map<number, (value: SidecarResponse) => void>()
    for (const id of kept) {
      const settle = pending.get(id)
      if (settle) survivors.set(id, settle)
    }
    for (const id of aborted) {
      pending.get(id)?.({ type: 'response', id, ok: false, result: null, error: `Pi Agent 已重启，该请求被中止（${reason}）` })
    }
    // settle 内部会 delete，故在循环之后重建 Map。
    pending.clear()
    for (const [id, settle] of survivors) pending.set(id, settle)
    for (const id of Object.keys(runState)) {
      const slot = runState[id]
      if (!slot?.running) continue
      clearRunWatchdog(id)
      patchSlot(id, {
        running: false,
        phase: 'idle',
        tool: '',
        processOpen: false,
        confirm: undefined,
        error: 'Pi Agent 侧车已重启，本次运行被中止。会话文件仍在，可继续对话。'
      })
      markSession(id, 'done')
    }
    sidecarReady = true
    void refreshCtxStats()
    // sidecar 重启后其内存态 sessions 为空，而前端仍持有会话 id → 文件路径的映射。
    // 若不重新绑定，下次 prompt 会让 sidecar 按同一 id 新建一个会话文件，
    // **静默丢掉原会话历史**（用户看不到任何错误，只是"接着聊"变成了新会话）。
    // 故这里主动把已打开过的会话重新 open 回去。
    void rebindSessionsAfterRestart()
    if (aborted.length) console.warn(`[pi-my] sidecar 重启，已中止 ${aborted.length} 个未完成请求`)
  }

  async function rebindSessionsAfterRestart() {
    const candidates = sessions.filter((item) => item.file && !item.parentId)
    const dead = new Set<string>()
    for (const session of candidates) {
      // 把前端记住的模式传给 sidecar，并以回传值校正（重启后 sidecar 内存态已清空，
      // 若不传，plan 会话会被静默重开成默认模式而获得写权限）。
      const response = await requestRaw('open_session', { sessionId: session.id, file: session.file, mode: sessionMode(sessions, session.id) })
      if (!response.ok) {
        // 会话文件已不可读 → 下次发送前必须重建，否则会写进新文件。
        // 只标记 historyLoaded（file 字段在 RunSlot 上不存在，真正清理在下面的 sessions.map）。
        dead.add(session.id)
        patchSlot(session.id, { historyLoaded: false })
        continue
      }
      const result = response.result as { history?: Array<{ id?: string; role: 'user' | 'assistant'; text: string; timestamp?: number; userIndex?: number; entryId?: string }>; mode?: string } | null
      if (result?.mode) remember(session.id, { mode: result.mode })
      // 已加载过历史且当前没在运行，就不覆盖界面上的时间线
      const slot = slotFor(session.id)
      if (!slot.historyLoaded && !slot.running) applySessionHistory(session.id, result?.history ?? [])
    }
    if (dead.size) {
      sessions = sessions.map((item) => (dead.has(item.id) ? { ...item, file: undefined, historyLoaded: false } : item))
      if (activeSessionId && dead.has(activeSessionId)) {
        patchSlot(activeSessionId, { error: '原会话文件已不可读，下一条消息将开始一个新会话。' })
      }
    }
  }

  // 注意：清理函数必须由**同步**回调返回。写成 `onMount(async () => { ...; return unlisten })`
  // 时返回值是 Promise，Svelte 只在 `typeof cleanup === 'function'` 时才注册清理
  // （svelte/src/index-client.js），于是 unlisten 永远不会被调用、监听器泄漏。
  // 这里用同步外壳持有 unlisten，异步初始化放进内部 IIFE。
  let appUnlisten: (() => void) | undefined
  let appDisposed = false

  onMount(() => {
    loadImageGenConfig()
    refreshPrefs()
    try { dismissedAgentUpdate = localStorage.getItem('pdn.dismissed-agent-update') ?? '' } catch { dismissedAgentUpdate = '' }
    projects = loadProjects()
    window.addEventListener('resize', clampToViewport)
    clampToViewport()

    void (async () => {
      const unlisten = await listen<AgentEnvelope>('agent-message', ({ payload }) => {
      if (payload.type === 'response' && payload.id) {
        pending.get(payload.id)?.(payload)
        pending.delete(payload.id)
        // 0-8 僵死探活：每收到一个响应就告诉 Rust"少了一个在途请求"
        if (sidecarReady) void invoke('agent_outstanding', { delta: -1 }).catch(() => {})
      }
      if (payload.type === 'sidecar-restarted') {
        onSidecarRestarted(String(payload.reason ?? '未知原因'), typeof payload.keepId === 'number' ? payload.keepId : undefined)
        if (loadPrefs().notifyConfirm) desktopNotify('Pi-My', 'Pi Agent 已自动重启')
      }
      if (payload.type === 'sidecar-failed') {
        sidecarReady = false
        for (const [id, settle] of pending) {
          settle({ type: 'response', id, ok: false, result: null, error: String(payload.message ?? 'Pi Agent 不可用') })
        }
        pending.clear()
        window.alert(String(payload.message ?? 'Pi Agent 侧车已停止运行，请重启应用。'))
      }
      if (payload.type === 'confirm_request') {
        patchSlot(payload.sessionId || activeSessionId, { phase: 'waiting', confirm: { confirmId: String(payload.confirmId ?? ''), toolName: String(payload.toolName ?? ''), summary: String(payload.summary ?? '') } })
        if (loadPrefs().notifyConfirm) desktopNotify('Pi-My', '需要确认工具调用')
      }
      // 扩展 UI 请求（0-4）：select / input / editor / confirm。
      // 必须响应，否则扩展的 await 会永久挂住（整个 agent 卡住）。
      if (payload.type === 'ui_dialog_request') {
        extDialog = {
          dialogId: String(payload.dialogId ?? ''),
          kind: String(payload.kind ?? 'input') as ExtDialog['kind'],
          title: String(payload.title ?? ''),
          message: payload.message ? String(payload.message) : undefined,
          options: Array.isArray(payload.options) ? payload.options.map((item: unknown) => String(item)) : undefined,
          placeholder: payload.placeholder ? String(payload.placeholder) : undefined,
          prefill: payload.prefill ? String(payload.prefill) : undefined,
        }
        extDialogValue = payload.prefill ? String(payload.prefill) : ''
        if (loadPrefs().notifyConfirm) desktopNotify('Pi-My', '扩展需要你的输入')
      }
      // 扩展发起的通知：带来源归因，便于用户知道是哪个扩展在说话
      if (payload.type === 'ext_notify') {
        const source = payload.source ? `（${payload.source}）` : ''
        const text = `${payload.message ?? ''}${source}`
        extToasts = [...extToasts, { id: `t${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, text, type: String(payload.notifyType ?? 'info') }].slice(-3)
        window.setTimeout(() => { extToasts = extToasts.slice(1) }, 6000)
      }
      // 2-7：对话框超时提示（回落语义 sidecar 已按 kind 处理，这里让用户知道发生过）
      if (payload.type === 'dialog_expired' && payload.fallback === 'default') {
        const kindLabel = payload.kind === 'confirm' ? '确认框' : payload.kind === 'select' ? '选择框' : '对话框'
        const text = `扩展${kindLabel}超时未回答，已按默认值继续`
        extToasts = [...extToasts, { id: `t${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, text, type: 'warning' }].slice(-3)
        window.setTimeout(() => { extToasts = extToasts.slice(1) }, 6000)
      }
      // 扩展要求把文本放进输入框（pasteToEditor / setEditorText）
      if (payload.type === 'ext_editor_text') {
        inputText = String(payload.text ?? '')
        composerInput?.focus()
      }
      if (payload.type === 'login_event') {
        const ev = payload.event
        const provider = String(payload.provider ?? loginState?.provider ?? '')
        if (ev.type === 'device_code') {
          loginState = { provider, status: '等待授权…', userCode: String(ev.userCode ?? ''), verificationUri: String(ev.verificationUri ?? ''), value: '' }
          if (ev.verificationUri) openLoginUrl(String(ev.verificationUri))
        } else if (ev.type === 'auth_url') {
          loginState = { provider, status: String(ev.instructions || '请在浏览器完成授权'), value: '' }
          openLoginUrl(String(ev.url ?? ''))
        } else if (ev.type === 'progress' || ev.type === 'info') {
          loginState = { provider, status: String(ev.message ?? ''), userCode: loginState?.userCode, verificationUri: loginState?.verificationUri, value: loginState?.value ?? '' }
        }
      }
      if (payload.type === 'login_prompt') {
        const prompt = payload.prompt
        if (!prompt) return
        loginState = {
          provider: String(payload.provider ?? loginState?.provider ?? ''),
          status: '需要输入',
          userCode: loginState?.userCode,
          verificationUri: loginState?.verificationUri,
          prompt: { promptId: String(payload.promptId), type: String(prompt.type), message: String(prompt.message), placeholder: prompt.placeholder ? String(prompt.placeholder) : undefined, options: Array.isArray(prompt.options) ? prompt.options : undefined },
          value: ''
        }
      }
      if (payload.type === 'event') {
        const event = payload.event
        if (!event) return
        const id = payload.sessionId || activeSessionId
        touchRunWatchdog(id)
        if (event.type === 'message_update') {
          const assistantEvent = event.assistantMessageEvent
          const eventType = String(assistantEvent?.type || '')
          const thinkingDelta = assistantEvent?.delta ?? assistantEvent?.thinking ?? event.thinking
          const textDelta = assistantEvent?.delta ?? assistantEvent?.text ?? event.delta
          if (eventType === 'thinking_start') markThinking(id)
          else if (eventType === 'thinking_delta' && thinkingDelta) appendThink(id, String(thinkingDelta))
          else if (eventType === 'thinking_end') patchSlot(id, { phase: 'thinking' })
          else if (eventType === 'text_start') patchSlot(id, { phase: 'writing' })
          else if (eventType === 'text_delta' && textDelta) appendReply(id, String(textDelta))
          else if (eventType === 'text_end') patchSlot(id, { phase: 'writing' })
          else if (eventType === 'toolcall_start' || eventType === 'toolcall_delta' || eventType === 'toolcall_end') patchSlot(id, { phase: 'working' })
          else if (!eventType) {
            // 兼容旧版 sidecar 事件；新版按 assistantMessageEvent.type 分流，避免思考内容混进正文。
            if (event.thinking) appendThink(id, String(event.thinking))
            if (event.delta) appendReply(id, String(event.delta))
          }
        }
        if (event.type === 'turn_start') markThinking(id)
        // 1-5 UI 插件：role=custom 的插件消息（message_start/end 成对出现，取 end 落定版）
        if (event.type === 'message_start' && (event.message as { role?: string })?.role === 'custom') patchSlot(id, { phase: 'working' })
        if (event.type === 'message_end' && (event.message as { role?: string })?.role === 'custom') {
          const normalized = normalizePluginMessage(event.message as unknown as Record<string, unknown>)
          if (normalized) {
            const slot = slotFor(id)
            patchSlot(id, { pluginMessages: [...(slot.pluginMessages ?? []), { ...normalized, entryId: String((event.message as { id?: string })?.id ?? '') }] })
          }
        }
        if (event.type === 'tool_execution_start') startToolStep(id, String(event.toolName || '工具'), String(event.toolCallId || ''), event.args)
        if (event.type === 'tool_execution_update' && event.partialResult) {
          const current = slotFor(id)
          const callId = String(event.toolCallId || '')
          patchSlot(id, {
            phase: 'working',
            process: current.process.map((step) => step.id === callId || (!callId && step.kind === 'tool' && !step.done) ? { ...step, body: brief(event.partialResult) } : step)
          })
        }
        if (event.type === 'tool_execution_end') {
          endToolStep(id, String(event.toolName || '工具'), String(event.toolCallId || ''), event.result, Boolean(event.isError))
          // show_image 工具（1-3）：details.images 是发图数据源（模型不可见，仅供 UI）
          const details = (event.result as { details?: { images?: Array<{ data: string; mimeType: string }>; paths?: string[] } } | null | undefined)?.details
          if (details?.images?.length) {
            const images = details.images.map((img, index) => ({
              id: `img-${event.toolCallId}-${index}`,
              src: `data:${img.mimeType || 'image/png'};base64,${img.data}`,
              name: details.paths?.[index] ?? '',
            }))
            const slot = slotFor(id)
            patchSlot(id, { images: [...(slot.images ?? []), ...images] })
          }
        }
        if (event.type === 'agent_start') { markThinking(id); patchSlot(id, { running: true, error: '' }); markSession(id, 'active') }
        // 自动重试状态行（1-7）：SDK 在流中断等场景会自动重试，此前用户只看到"卡住"。
        if (event.type === 'auto_retry_start') {
          patchSlot(id, {
            running: true,
            phase: 'thinking',
            retry: { attempt: Number(event.attempt ?? 0), reason: String(event.errorMessage ?? event.reason ?? '网络波动') },
          })
        }
        if (event.type === 'auto_retry_end') patchSlot(id, { retry: undefined })
        // 1-2 上下文蒸发：SDK 自动/手动压缩事件（此前透传但被忽略，用户只见"卡住"）
        if (event.type === 'compaction_start') patchSlot(id, { compacting: true, phase: 'thinking' })
        if (event.type === 'compaction_end') patchSlot(id, { compacting: false })
        if (event.type === 'agent_end') {
          // Pi SDK 在自动重试/压缩前也会发 agent_end，这时不能提前显示结束。
          if (event.willRetry) patchSlot(id, { running: true, phase: 'thinking', processOpen: true })
          else finishRun(id)
        }
        if (event.type === 'agent_settled') finishRun(id)
        if (event.type === 'turn_end' && slotFor(id).running && !slotFor(id).reply.trim()) patchSlot(id, { phase: 'thinking' })
        if (event.type === 'error') finishRun(id, String(event.message || 'Agent 请求失败'))
      }
    })
    try {
      const startup = loadPrefs()
      const startupCwd = startup.restoreWorkspace && startup.lastWorkspace ? startup.lastWorkspace : '.'
      await request('init', { cwd: startupCwd })
      if (startupCwd !== '.') {
        workspacePath = startupCwd
        addProjectPath(startupCwd)
      }
      sidecarReady = true
      void refreshPetStatus()
      void checkAgentUpdate()
      agentUpdateTimer = window.setInterval(() => void checkAgentUpdate(true), 6 * 60 * 60 * 1000)
      models = (await request('list_models') as ModelInfo[]) ?? []
      await loadFiles()
      await refreshGit()
      const loaded = await request('list_sessions', { cwd: startupCwd }) as Array<{ id: string; title: string; file: string; cwd?: string; parentSessionPath?: string; createdAt?: number; modifiedAt: number; archived?: boolean }>
      if (loaded?.length) {
        sessions = loaded.map((item) => ({
          id: item.id,
          title: item.title,
          file: item.file,
          cwd: item.cwd,
          parentFile: item.parentSessionPath,
          createdAt: item.createdAt,
          modifiedAt: item.modifiedAt,
          archived: item.archived,
          time: new Date(item.modifiedAt).toLocaleDateString()
        }))
        const firstOpen = sessions.find((item) => !item.archived && !item.parentId)
        if (firstOpen) await selectSession(firstOpen)
      }
      void refreshCtxStats()

    } catch {
      // Browser preview mode remains useful without the native sidecar.
    }
      // 组件已在监听注册期间卸载 → 立刻退订，避免泄漏
      if (appDisposed) unlisten()
      else appUnlisten = unlisten
    })()

    return () => {
      // 只负责退订事件监听；其余（定时器、resize、拖拽）由 onDestroy 统一处理，
      // 避免两处重复清理造成的顺序耦合。
      appDisposed = true
      appUnlisten?.()
      appUnlisten = undefined
    }
  })

  async function loadFiles(cwd = workspacePath) {
    if (!sidecarReady) return
    const target = cwd
    filesLoading = true
    if (workspacePath === target) files = []
    try {
      const list = await request('list_files', { cwd: target }) as Array<{ path: string; kind: 'file' | 'directory' }>
      if (workspacePath === target) files = list
    } finally {
      if (workspacePath === target) filesLoading = false
    }
  }

  async function chooseWorkspace() {
    const selected = await open({ directory: true, multiple: false, title: '选择 Pi Agent 项目' })
    if (typeof selected !== 'string') return
    await activateProject(selected)
  }

  async function refreshGit(cwd = workspacePath) {
    if (!sidecarReady) return
    const target = cwd
    const changes = await request('git_status', { cwd: target }) as GitChange[]
    if (workspacePath === target) gitChanges = changes
  }

  async function loadDiff(file: string) {
    if (!sidecarReady) return
    diffContent = await request('git_diff', { cwd: workspacePath, path: file }) as string
    panel = '变更'
  }

  function isStaged(code: string) {
    return code[0] !== ' ' && code[0] !== '?'
  }

  async function runGit(type: string, payload: Record<string, unknown>) {
    gitError = ''
    const res = await requestRaw(type, payload)
    if (!res.ok) {
      gitError = res.error || '操作失败'
      return false
    }
    commitMessage = ''
    staged = {}
    await refreshGit()
    return true
  }

  async function stageFiles() {
    const paths = gitChanges.filter((change) => (staged[change.path] ?? false) && !isStaged(change.code)).map((change) => change.path)
    if (!paths.length) return
    const ok = await confirm(`确认暂存勾选的 ${paths.length} 个文件？`, { title: '暂存更改', kind: 'warning' })
    if (!ok) return
    await runGit('git_add', { cwd: workspacePath, paths })
  }

  async function commitChanges() {
    const message = commitMessage.trim() || loadPrefs().gitTemplate.trim()
    if (!message) return
    const stagedCount = gitChanges.filter((change) => isStaged(change.code)).length
    const ok = await confirm(`确认提交「${message}」？将提交当前全部已暂存的 ${stagedCount} 个文件。`, { title: '提交更改', kind: 'warning' })
    if (!ok) return
    await runGit('git_commit', { cwd: workspacePath, message })
  }

  async function pushChanges() {
    const ok = await confirm('确认将本地提交推送到远程仓库？', { title: '推送', kind: 'warning' })
    if (!ok) return
    await runGit('git_push', { cwd: workspacePath })
  }

  async function saveFile() {
    if (!selectedFile || !sidecarReady) return
    await request('write_file', { cwd: workspacePath, path: selectedFile, content: fileContent })
    editingFile = false
    await refreshGit()
  }
  async function previewFile(file: string) {
    selectedFile = file
    editingFile = false
    if (sidecarReady) {
      // request() 对失败返回 undefined（ok:false 不 reject），所以判 result 而不是 catch
      const response = await requestRaw('read_file', { cwd: workspacePath, path: file })
      const result = response.ok ? response.result as { content: string } | null : null
      if (result?.content !== undefined) {
        fileContent = result.content
        largeFile = null
        panel = '文档'
        return
      }
      // 2-12：超过 512KB 的文件 → 虚拟化分块预览（此前直接报错打不开）
      const message = String(response.error || '')
      if (message.includes('512 KB') || message.includes('超过')) {
        await previewLargeFile(file)
        return
      }
      fileContent = ''
      selectedFile = ''
      patchSlot(ensureActiveId(), { error: `读取文件失败: ${message || '未知错误'}` })
    }
  }

  /** 2-12：大文件分块读取（虚拟化预览路径）。 */
  async function readFileChunk(offset: number, limit: number): Promise<{ totalLines: number; lines: string[]; offset: number }> {
    const response = await requestRaw('read_file_chunk', { cwd: workspacePath, path: selectedFile, offset, limit })
    if (!response.ok) throw new Error(response.error || '读取失败')
    return response.result as { totalLines: number; lines: string[]; offset: number }
  }

  /** 大文件入口：read_file 会拒绝 >512KB，捕获后切虚拟化预览。 */
  async function previewLargeFile(file: string) {
    selectedFile = file
    editingFile = false
    fileContent = ''
    largeFile = { path: file }
    panel = '文档'
  }
  async function selectSession(session: Session) {
    if (session.parentId) {
      const run = slotFor(session.parentId).subRuns.find((item) => item.id === session.id)
      viewingSub = run ?? { id: session.id, agent: session.title, task: session.title, status: session.state === 'active' ? 'running' : 'done', reply: slotFor(session.id).reply }
      return
    }
    branchOpen = false
    activeSessionId = session.id
    activeSession = session.title
    todos = loadTodos(session.id)
    if (sidecarReady && session.file) {
      // 传当前会话记录的模式，并以 sidecar 回传的实际模式为准校正 UI。
      // 修复：旧实现不传也不回读 mode，导致"UI 显示计划模式、sidecar 实际是 ask"的失同步。
      const opened = await requestRaw('open_session', { sessionId: session.id, file: session.file, mode: sessionMode(sessions, session.id) })
      if (opened.ok) {
        const result = opened.result as { history?: Array<{ id?: string; role: 'user' | 'assistant'; text: string; timestamp?: number; userIndex?: number; entryId?: string }>; mode?: string }
        applySessionHistory(session.id, result?.history)
        if (result?.mode) remember(session.id, { mode: result.mode })
      } else {
        // 修复：读取失败时明确提示，不再用空历史覆盖成空白页。
        patchSlot(session.id, { error: opened.error || '读取历史会话失败', historyLoaded: false })
      }
    }
    void refreshCtxStats()
  }

  function openDir(path: string) {
    if (sidecarReady && path) void request('open_dir', { path })
  }

  function openLoginUrl(url: string) {
    if (!url) return
    if (sidecarReady) void request('open_url', { url })
    else window.open(url, '_blank', 'noopener,noreferrer')
  }

  function submitLoginPrompt() {
    if (!loginState?.prompt) return
    const { promptId } = loginState.prompt
    void request('login_prompt_response', { promptId, value: loginState.value })
    loginState = { ...loginState, prompt: undefined, value: '', status: '等待授权…' }
  }

  function cancelLogin() {
    if (loginState?.prompt) void request('login_prompt_response', { promptId: loginState.prompt.promptId, cancelled: true })
    loginState = null
  }

  async function refreshPetStatus() {
    if (!sidecarReady) return
    try { petStatus = await request('eco_pet_status', {}) as { base: string; pets: Array<{ id: string; model: string | null }> } } catch { petStatus = { base: '', pets: [] } }
  }

  function currentPetUrl() {
    if (!uiPrefs.petModel) return ''
    const pet = petById(uiPrefs.petModel)
    if (!pet) return ''
    const local = petStatus.pets.find((item) => item.id === pet.id)
    if (pet.type === 'sprite') {
      if (local && petStatus.base) return `${petStatus.base}/${pet.id}/${local.sprite || 'sprite.webp'}`
      return pet.spriteUrl || pet.preview
    }
    if (local?.model && petStatus.base) return `${petStatus.base}/${local.model}`
    return petModelUrl(pet)
  }

  async function addAttachments() {
    if (!sidecarReady) return
    attachError = ''
    const selected = await open({ multiple: true, title: '添加附件' })
    if (!selected) return
    const paths = Array.isArray(selected) ? selected : [selected]
    for (const path of paths) {
      const res = await requestRaw('read_attachment', { cwd: workspacePath, path })
      if (!res.ok) {
        attachError = res.error || '附件读取失败'
        continue
      }
      attachments = [...attachments, res.result as { kind: 'image' | 'text'; name: string; mimeType?: string; data?: string; content?: string }]
    }
  }

  async function handleClipboardPaste(event: ClipboardEvent) {
    const clipboard = event.clipboardData
    if (!clipboard) return
    const itemFiles = Array.from(clipboard.items || [])
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file))
    const files = itemFiles.length ? itemFiles : Array.from(clipboard.files || [])
    const images = files.filter((file) => file.type.startsWith('image/'))
    if (!images.length) return
    event.preventDefault()
    attachError = ''
    for (const file of images) {
      if (file.size > 20 * 1024 * 1024) {
        attachError = `${file.name || '剪贴板图片'} 超过 20 MB，未添加`
        continue
      }
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result || ''))
          reader.onerror = () => reject(reader.error || new Error('读取剪贴板图片失败'))
          reader.readAsDataURL(file)
        })
        const data = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : ''
        if (!data) throw new Error('剪贴板图片为空')
        attachments = [...attachments, {
          kind: 'image',
          name: file.name || `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
          mimeType: file.type || 'image/png',
          data,
        }]
      } catch (error) {
        attachError = error instanceof Error ? error.message : '读取剪贴板图片失败'
      }
    }
  }

  function removeAttachment(index: number) {
    attachments = attachments.filter((_, itemIndex) => itemIndex !== index)
  }

  function loadImageGenConfig() {
    try { imageGenConfig = { ...imageGenConfig, ...JSON.parse(localStorage.getItem('pdn.imagegen') ?? '{}') } } catch { /* 使用空配置 */ }
  }

  function saveImageGenConfig(next: ImageGenConfig) {
    imageGenConfig = next
    localStorage.setItem('pdn.imagegen', JSON.stringify(next))
  }

  async function generateImage() {
    const prompt = inputText.trim()
    if (!prompt || imageGenBusy) return
    imageGenError = ''
    imageGenBusy = true
    try {
      const result = await request('generate_image', { ...imageGenConfig, prompt }) as { data?: string; mimeType?: string; url?: string }
      const src = result.data ? `data:${result.mimeType || 'image/png'};base64,${result.data}` : result.url
      if (!src) throw new Error('生图服务未返回图片')
      imageGenResult = { src, prompt }
      inputText = ''
    } catch (error) { imageGenError = error instanceof Error ? error.message : String(error) }
    finally { imageGenBusy = false }
  }


  function answerConfirm(ok: boolean) {
    const id = activeSessionId
    const confirm = runState[id]?.confirm
    if (!confirm) return
    patchSlot(id, { confirm: undefined })
    if (sidecarReady) void request('confirm_response', { confirmId: confirm.confirmId, ok })
  }

  /** 回答扩展的 UI 请求。
   *  confirm 用 `confirmed` 布尔；其余用 `value`/`cancelled`。
   *  修复：旧实现 confirm 的"允许"发的是 value='true'，而 sidecar 判
   *  `payload.confirmed === true`，恒为 false —— 扩展的 confirm 永远拿不到"允许"。 */
  function answerExtDialog(
    value: string | undefined,
    cancelled = false,
    options: { confirmed?: boolean } = {},
  ) {
    const dialog = extDialog
    if (!dialog) return
    extDialog = null
    extDialogValue = ''
    if (!sidecarReady) return
    void request('ui_dialog_response', {
      dialogId: dialog.dialogId,
      cancelled,
      value,
      confirmed: options.confirmed ?? (dialog.kind === 'confirm' && !cancelled && value === 'true'),
    })
  }

  async function refreshProviders() {
    if (!sidecarReady) return
    providers = await request('list_providers', {}) as typeof providers
    models = (await request('list_models') as ModelInfo[]) ?? models
  }

  async function refreshUsage() {
    if (!sidecarReady) return
    try { usageStats = await request('usage_stats', { cwd: workspacePath }) as UsageStats } catch { usageStats = null }
  }

  async function openSettings(tab?: 'about') {
    settingsInitialTab = tab
    showSettings = true
    if (sidecarReady) {
      try {
        settingsInfo = await request('info') as SettingsInfo
        if (settingsInfo?.providers) providers = settingsInfo.providers
        await refreshUsage()
      } catch {
        settingsInfo = null
      }
    }
  }

  // 首次发送时用文本前 20 字自动命名「新会话」；返回新标题用于持久化。
  function maybeAutoTitle(id: string, text: string) {
    if (!loadPrefs().autoName) return null
    const session = sessions.find((item) => item.id === id)
    if (!session || (session.title && session.title !== '新会话')) return null
    const title = text.length > 20 ? `${text.slice(0, 20)}…` : text
    sessions = sessions.map((item) => (item.id === id ? { ...item, title } : item))
    if (activeSessionId === id) activeSession = title
    return title
  }

  function submit(behavior: 'steer' | 'followUp' = 'steer') {
    const text = inputText.trim()
    if (!text) return
    const scout = text.match(/^\/scout(?:\s+|$)(.*)$/i)
    if (scout) {
      inputText = ''
      mention = null
      if (scout[1].trim()) void spawnSubagent('scout', scout[1])
      else { splitOpen = true; agentDefs = loadAgents(); splitRows = [{ agent: 'scout', task: '' }] }
      return
    }
    const agentCmd = text.match(/^\/agent\s+(\S+)\s+(.+)$/i)
    if (agentCmd) {
      inputText = ''
      mention = null
      void spawnSubagent(agentCmd[1], agentCmd[2])
      return
    }
    const todoCmd = text.match(/^\/todo(?:\s+|$)(.*)$/i)
    if (todoCmd) {
      inputText = ''
      mention = null
      if (todoCmd[1].trim()) {
        persistTodos([...loadTodos(ensureActiveId()), newTodo(todoCmd[1])])
        panel = '待办'
        showRight = true
      } else { panel = '待办'; showRight = true }
      return
    }
    if (text === '/split') {
      inputText = ''
      mention = null
      splitOpen = true
      agentDefs = loadAgents()
      return
    }
    const slash = findSlashCommand(text)
    if (slash) {
      inputText = ''
      mention = null
      // 2-5：取命令词后面的参数（如 /export md 的 "md"）
      const args = text.replace(/^\s*\/\S+/, '').trim()
      runSlashCommand(slash, args)
      return
    }
    const id = ensureActiveId()
    const slot = slotFor(id)
    inputText = ''
    mention = null
    if (slot.running && behavior === 'followUp') {
      // 2-4：队列项带稳定 id（CAS 重排/移除的键）
      patchSlot(id, { queue: [...slot.queue, { id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, text }], queueRevision: slot.queueRevision + 1 })
      return
    }
    if (slot.running && behavior === 'steer') {
      const at = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      const userIndex = slot.sent.length
      patchSlot(id, {
        sent: [...slot.sent, { text, at }],
        steer: [...slot.steer, text],
        timeline: [...slot.timeline, { id: `user-${Date.now()}`, role: 'user', text, at, timestamp: Date.now(), userIndex }]
      })
      if (sidecarReady) void request('prompt', { sessionId: id, text, cwd: workspacePath, behavior: 'steer' })
      return
    }
    dispatchTurn(id, text, behavior)
  }

  function dispatchTurn(id: string, text: string, behavior: 'steer' | 'followUp') {
    const slot = slotFor(id)
    const newTitle = maybeAutoTitle(id, text)
    const at = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const timestamp = Date.now()
    const userIndex = slot.sent.length
    const activeTurnId = `turn-${timestamp}`
    patchSlot(id, {
      sent: [...slot.sent, { text, at }],
      timeline: [...slot.timeline, { id: `user-${activeTurnId}`, role: 'user', text, at, timestamp, userIndex }],
      reply: '',
      thinking: '',
      tool: '',
      error: '',
      running: true,
      // 修改：发送后先等待模型思考；只有真正进入工具执行时才显示 Working。
      phase: 'thinking',
      historyLoaded: true,
      activeTurnId,
      process: [{ id: 'waiting-think', kind: 'think', title: '思考', body: '正在等待模型返回思考内容…', done: false }],
      processOpen: true
    })
    touchRunWatchdog(id)
    if (sidecarReady) {
      const pendingFiles = attachments
      attachments = []
      attachError = ''
      void (async () => {
        const rec = sessions.find((item) => item.id === id)
        if (!rec?.file) {
          const defaults = loadPrefs()
          const rawThinking = rec?.thinking ?? defaults.thinking
          const payload: Record<string, unknown> = { sessionId: id, cwd: workspacePath, mode: rec?.mode ?? defaults.mode }
          if (rawThinking && THINKING_LEVELS.includes(rawThinking)) payload.thinking = rawThinking
          const created = await request('create_session', payload) as { id: string; file?: string } | null
          if (created?.file) remember(id, { file: created.file })
          const model = sessions.find((item) => item.id === id)?.model
          if (model) {
            const [provider, modelId] = model.split(MODEL_SEPARATOR)
            await request('set_model', { sessionId: id, provider, modelId })
          }
        }
        const extra = [] as typeof pendingFiles
        for (const name of [...text.matchAll(/(?:^|\s)@([^\s]+)/g)].map((item) => item[1])) {
          const hit = files.find((file) => file.kind === 'file' && (file.path === name || fileName(file.path) === name))
          if (!hit || extra.concat(pendingFiles).some((file) => file.name === fileName(hit.path))) continue
          const res = await requestRaw('read_attachment', { cwd: workspacePath, path: hit.path })
          if (res.ok) extra.push(res.result as typeof pendingFiles[number])
        }
        const outgoing = [...pendingFiles, ...extra]
        const bridged = [] as typeof pendingFiles
        for (const file of outgoing) {
          if (file.kind !== 'image' || !file.data) { bridged.push(file); continue }
          try {
            const vision = await request('vision_describe', { data: file.data, mimeType: file.mimeType }) as { skipped?: boolean; description?: string }
            if (vision?.skipped || !vision?.description) bridged.push(file)
            else bridged.push({ kind: 'text', name: `${file.name}.vision.txt`, content: `[视觉桥] ${file.name}\n${vision.description}` })
          } catch {
            bridged.push(file)
          }
        }
        await request('prompt', { sessionId: id, text, cwd: workspacePath, behavior, attachments: bridged })
      })()
        .then(() => { if (newTitle) void request('rename_session', { sessionId: id, name: newTitle }) })
        .catch((error) => {
          finishRun(id, error instanceof Error ? error.message : '发送请求失败，请检查 sidecar 是否仍在运行。')
        })
    } else {
      window.setTimeout(() => patchSlot(id, { running: false, phase: 'idle' }), 1400)
    }
  }

  function drainQueue(id: string) {
    const slot = slotFor(id)
    if (slot.running || !slot.queue.length) return
    const [, ...rest] = slot.queue
    patchSlot(id, { queue: rest, queueRevision: slot.queueRevision + 1 })
    dispatchTurn(id, slot.queue[0].text, 'steer')
  }

  // 2-4 队列 CAS：上移/下移/移除都基于读到的 revision 做乐观并发；
  // stale（期间被 drain/其他操作改过）时拒绝本次操作，避免丢更新或"复活"已出队的项。
  function moveQueue(index: number, dir: -1 | 1) {
    const slot = slotFor(activeSessionId)
    const result = casReorder(slot.queue, slot.queueRevision, slot.queueRevision, index, dir, slot.queue.map((item) => item.id))
    if (!result.ok) return
    patchSlot(activeSessionId, { queue: result.value, queueRevision: result.revision })
  }

  function removeQueue(id: string) {
    const slot = slotFor(activeSessionId)
    const result = casRemove(slot.queue, slot.queueRevision, slot.queueRevision, id)
    if (!result.ok) return
    patchSlot(activeSessionId, { queue: result.value, queueRevision: result.revision })
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      try {
        const helper = document.createElement('textarea')
        helper.value = text
        helper.style.position = 'fixed'
        helper.style.opacity = '0'
        document.body.appendChild(helper)
        helper.select()
        const copied = document.execCommand('copy')
        helper.remove()
        return copied
      } catch {
        return false
      }
    }
  }

  async function checkAgentUpdate(force = false) {
    if (!sidecarReady || agentUpdateBusy) return
    agentUpdateBusy = true
    try {
      const response = await requestRaw('check_agent_update', { force })
      if (response.ok) agentUpdate = response.result as AgentUpdateInfo
    } catch {
      // 网络不可用时保持安静，不打断正常使用。
    } finally {
      agentUpdateBusy = false
    }
  }

  async function updatePiSdk() {
    if (!sidecarReady || agentUpdateBusy) return
    agentUpdateBusy = true
    try {
      const response = await requestRaw('update_pi_sdk')
      if (response.ok) agentUpdate = response.result as AgentUpdateInfo
      else if (agentUpdate) agentUpdate = { ...agentUpdate, message: response.error || 'Pi SDK 更新失败' }
    } catch {
      if (agentUpdate) agentUpdate = { ...agentUpdate, message: 'Pi SDK 更新失败，请检查网络连接后重试' }
    } finally {
      agentUpdateBusy = false
    }
  }

  function dismissAgentUpdate() {
    if (!agentUpdate?.latest) return
    dismissedAgentUpdate = agentUpdate.latest
    try { localStorage.setItem('pdn.dismissed-agent-update', dismissedAgentUpdate) } catch { /* ignore */ }
  }

  function openAgentUpdate() {
    if (!agentUpdate?.url) return
    void request('open_url', { url: agentUpdate.url })
  }

  function openAgentRepo() {
    void request('open_url', { url: agentUpdate?.repoUrl || 'https://github.com/earendil-works/pi' })
  }

  async function copyReply(messageId: string, reply: string) {
    if (!reply) return
    if (await copyText(reply)) {
      copiedReplyId = messageId
      window.setTimeout(() => {
        if (copiedReplyId === messageId) copiedReplyId = ''
      }, 1400)
    }
  }

  /** 2-3 worktree 分叉：在独立 git worktree 里开分支会话（风险改动与主工作区隔离）。 */
  async function forkWorktree(userMessageIndex = -1) {
    if (forkBusy || !sidecarReady) return
    const parentTitle = sessions.find((item) => item.id === activeSessionId)?.title || '当前会话'
    forkBusy = true
    try {
      const response = await requestRaw('create_worktree_fork', {
        sourceSessionId: activeSessionId,
        userMessageIndex,
        label: parentTitle,
      })
      if (!response.ok) throw new Error(response.error || '创建 worktree 分叉失败')
      const created = response.result as { id: string; file?: string; cwd: string; branch: string }
      const now = Date.now()
      sessions = [{
        id: created.id,
        title: `🌳 worktree · ${parentTitle}`,
        time: '刚刚',
        file: created.file,
        cwd: created.cwd,
        branch: created.branch,
        branchParentId: activeSessionId,
        createdAt: now,
        modifiedAt: now,
      }, ...sessions]
      remember(created.id, { file: created.file, cwd: created.cwd, branch: created.branch, readOnly: false })
      activeSessionId = created.id
      activeSession = `🌳 worktree · ${parentTitle}`
      patchSlot(created.id, { error: '' })
    } catch (error) {
      patchSlot(ensureActiveId(), { error: error instanceof Error ? error.message : String(error) })
    } finally {
      forkBusy = false
    }
  }

  async function forkAtUserIndex(userMessageIndex: number) {
    if (forkBusy || !sidecarReady) return
    const slot = slotFor(activeSessionId)
    if (userMessageIndex < 0) return
    forkBusy = true
    try {
      const forkId = `session-${Date.now()}`
      const response = await requestRaw('fork_session', {
        sourceSessionId: activeSessionId,
        sessionId: forkId,
        userMessageIndex,
        position: 'before'
      })
      if (!response.ok) throw new Error(response.error || '创建分支失败')
      const created = response.result as { id: string; file?: string; parentFile?: string; cwd?: string; selectedText?: string; history?: Array<{ id?: string; role: 'user' | 'assistant'; text: string; timestamp?: number; userIndex?: number; entryId?: string }> }
      const parentId = activeSessionId
      const parentTitle = sessions.find((item) => item.id === parentId)?.title || '当前会话'
      const previousMessages = slot.sent.slice(0, userMessageIndex).map((item) => ({ ...item }))
      const now = Date.now()
      sessions = [{
        id: created.id,
        title: `分支 · ${parentTitle}`,
        time: '刚刚',
        file: created.file,
        parentFile: created.parentFile,
        branchParentId: parentId,
        forkedFrom: parentId,
        createdAt: now,
        modifiedAt: now
      }, ...sessions]
      activeSessionId = created.id
      activeSession = `分支 · ${parentTitle}`
      branchOpen = false
      patchSlot(created.id, { sent: previousMessages })
      applySessionHistory(created.id, created.history)
      inputText = created.selectedText || ''
      window.setTimeout(() => composerInput?.focus(), 0)
    } catch (error) {
      patchSlot(activeSessionId, { error: error instanceof Error ? error.message : String(error) })
    } finally {
      forkBusy = false
    }
  }

  function stop() {
    const id = activeSessionId
    if (!sidecarReady) { clearRunWatchdog(id); patchSlot(id, { running: false, phase: 'idle' }); return }
      void request('abort', { sessionId: id }).finally(() => {
        clearRunWatchdog(id)
        patchSlot(id, { running: false, phase: 'idle', tool: '', processOpen: false, confirm: undefined })
      })
  }

  function quickPrompt(text: string) {
    inputText = text
    composerInput?.focus()
  }

  async function newSession() {
    if (!sidecarReady) {
      const draftId = `draft-${Date.now()}`
      activeSession = '新会话'
      activeSessionId = draftId
      sessions = [{ id: draftId, title: '新会话', time: '刚刚' }, ...sessions]
      leftTab = 'Chats'
      return
    }
    const id = `session-${Date.now()}`
    const defaults = loadPrefs()
    const thinking = THINKING_LEVELS.includes(defaults.thinking) ? defaults.thinking : undefined
    const payload: Record<string, unknown> = { sessionId: id, cwd: workspacePath, mode: defaults.mode }
    if (thinking) payload.thinking = thinking
    const created = await request('create_session', payload) as { id: string; file?: string }
    activeSessionId = created.id
    activeSession = '新会话'
    const now = Date.now()
    sessions = [{ id: created.id, title: '新会话', time: '刚刚', thinking, mode: defaults.mode, file: created.file, createdAt: now, modifiedAt: now }, ...sessions]
    leftTab = 'Chats'
  }

  let mention: { kind: 'file' | 'cmd'; query: string; index: number } | null = null
  $: mentionItems = mentionList(mention, files)
  function mentionList(current: typeof mention, list: typeof files) {
    if (!current) return []
    if (current.kind === 'cmd') return filterSlashCommands(current.query)
    return list.filter((item) => item.kind === 'file' && item.path.toLowerCase().includes(current.query.toLowerCase())).slice(0, 8)
  }

  // 斜杠命令的统一分派。每个 kind 都必须有分支——tests/slash-commands.test.mjs
  // 会断言注册表的 kind 集合与本函数的覆盖集合一致，杜绝"列了但没实现"。
  function runSlashCommand(command: { kind: string; id: string }, args = '') {
    switch (command.kind) {
      case 'new-session': void newSession(); return
      case 'open-settings': case 'login': void openSettings(); return
      case 'choose-workspace': void chooseWorkspace(); return
      case 'split-subagents': splitOpen = true; agentDefs = loadAgents(); return
      case 'todo-panel': panel = '待办'; showRight = true; return
      case 'set-mode-plan': void setMode('plan'); return
      case 'compact': void compactSession(); return
      case 'export-session': {
        // 2-5：/export md 走 Markdown，/export json 走既有 JSON 导出，默认 HTML
        const arg = String(args.trim().toLowerCase())
        if (arg === 'json') {
          const session = sessions.find((item) => item.id === ensureActiveId())
          if (session) void exportSession(session)
          return
        }
        void exportActiveSession(arg === 'md' ? 'md' : 'html')
        return
      }
      default:
        // 未知 kind 不能静默做别的事（旧实现就是掉进"选择工作区"兜底）。
        console.warn(`[pi-my] 未处理的斜杠命令类型: ${command.kind}`)
    }
  }

  /** 压缩当前会话上下文（此前是假命令）。 */
  async function compactSession() {
    if (!sidecarReady) return
    const id = ensureActiveId()
    if (!sessions.some((item) => item.id === id && item.file)) {
      patchSlot(id, { error: '当前会话还没有可压缩的上下文。' })
      return
    }
    const slot = slotFor(id)
    if (slot.running) {
      patchSlot(id, { error: '正在运行中，请先停止再压缩上下文。' })
      return
    }
    const response = await requestRaw('compact_session', { sessionId: id })
    if (!response.ok) {
      patchSlot(id, { error: response.error || '压缩上下文失败' })
      return
    }
    const result = response.result as { summary?: string } | null
    patchSlot(id, { error: '', historyLoaded: false })
    await selectSession(sessions.find((item) => item.id === id) as Session)
    if (result?.summary) console.info('[pi-my] 上下文压缩完成', result.summary)
  }

  /** 导出当前会话（HTML / Markdown / JSON，此前是假命令）。 */
  async function exportActiveSession(format: 'html' | 'md' = 'html') {
    if (!sidecarReady) return
    const id = ensureActiveId()
    const session = sessions.find((item) => item.id === id)
    if (!session?.file) {
      patchSlot(id, { error: '当前会话还没有可导出的文件。' })
      return
    }
    const isMd = format === 'md'
    const response = await requestRaw(isMd ? 'export_session_md' : 'export_session_html', { sessionId: id, file: session.file })
    if (!response.ok) {
      patchSlot(id, { error: response.error || '导出会话失败' })
      return
    }
    const result = response.result as { html?: string; markdown?: string; name?: string } | null
    const content = isMd ? result?.markdown : result?.html
    if (!content) {
      patchSlot(id, { error: '导出未返回内容' })
      return
    }
    const blob = new Blob([content], { type: isMd ? 'text/markdown' : 'text/html' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = result?.name || `${session.title || session.id}.${isMd ? 'md' : 'html'}`
    link.click()
    URL.revokeObjectURL(link.href)
  }

  function refreshMention() {
    const queryText = slashTriggerQuery(inputText)
    const at = inputText.match(/(^|\s)@([^\s]*)$/)
    if (queryText !== null) mention = { kind: 'cmd', query: queryText, index: 0 }
    else if (at) {
      mention = { kind: 'file', query: at[2], index: 0 }
      if (!files.length) void loadFiles()
    } else mention = null
  }

  function applyMention(index = mention?.index ?? 0) {
    if (!mention || !mentionItems[index]) return
    const item = mentionItems[index]
    if (mention.kind === 'cmd') {
      // 走同一个分派表，避免"补全菜单里能选、但选了没反应/做别的事"。
      const command = SLASH_COMMANDS.find((entry) => entry.id === (item as { id: string }).id)
      inputText = ''
      mention = null
      if (!command) return
      // scout 需要参数，预填而不是直接执行
      if (command.id === 'scout') { inputText = '/scout '; return }
      // 2-5：/export 带格式参数，预填让用户选择 md/json/html
      if (command.id === 'export') { inputText = '/export '; return }
      runSlashCommand(command)
      return
    }
    const path = (item as { path: string }).path
    inputText = inputText.replace(/@[^\s]*$/, `@${path} `)
    mention = null
  }

  function handleKeydown(event: KeyboardEvent) {
    if (mention && mentionItems.length) {
      if (event.key === 'ArrowDown') { event.preventDefault(); mention = { ...mention, index: (mention.index + 1) % mentionItems.length }; return }
      if (event.key === 'ArrowUp') { event.preventDefault(); mention = { ...mention, index: (mention.index - 1 + mentionItems.length) % mentionItems.length }; return }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey)) { event.preventDefault(); applyMention(); return }
      if (event.key === 'Escape') { event.preventDefault(); mention = null; return }
    }
    if (event.key !== 'Enter' || event.shiftKey) return
    const prefs = loadPrefs()
    const mod = event.ctrlKey || event.metaKey
    const shouldSend = prefs.sendShortcut === 'ctrl-enter' ? mod : !mod
    if (!shouldSend) return
    event.preventDefault()
    if (imageGenMode) { void generateImage(); return }
    const running = Boolean(runState[activeSessionId]?.running)
    submit(event.altKey ? 'followUp' : running ? prefs.busySend : 'steer')
  }

  function handleGlobalKey(event: KeyboardEvent) {
    if (showSettings) return
    const mod = event.ctrlKey || event.metaKey
    if (!mod) return
    const key = event.key.toLowerCase()
    if (key === ',') { event.preventDefault(); void openSettings(); return }
    if (key === 'n') { event.preventDefault(); void newSession(); return }
    if (key === 'b' && event.shiftKey) { event.preventDefault(); showRight = !showRight; return }
    if (key === 'b') { event.preventDefault(); showLeft = !showLeft }
  }
</script>

<svelte:head>
  <title>Pi-My</title>
</svelte:head>
<svelte:window on:keydown={handleGlobalKey} />

  <div class="desktop">
  <div class="window" class:left-on={showLeft} class:right-on={showRight} class:compact={uiPrefs.density === 'compact'} style={`--left-panel:${showLeft ? 220 : 0}px;--right-panel:${showRight ? rightWidth : 0}px`}>
    <div class="title-left" data-tauri-drag-region><div class="brand"><img class="brand-logo" src={logoUrl} alt="Pi-My" /><span>Pi-My</span></div></div>
    <div class="title-center" data-tauri-drag-region>
      <div class="top-tabs" data-tauri-drag-region>
        {#each openTabs as session (session.id)}
          <div class="top-tab" class:on={session.id === activeSessionId} class:live={session.state === 'active' || slotFor(session.id).running} class:branch={Boolean(session.parentFile)}>
            <button class="top-tab-main" type="button" title={tabTitle(session)} on:click={() => void selectSession(session)}>{#if session.parentFile}<Icon name="fork" size={10} />{/if}<span>{tabTitle(session)}</span></button>
            <button class="top-tab-close" type="button" aria-label={`关闭 ${tabTitle(session)}`} on:click={() => void closeTab(session)}><Icon name="x" size={11} strokeWidth={1.8} /></button>
          </div>
        {/each}
        <button class="top-session-plus" aria-label="新建会话" on:click={() => void newSession()}><Icon name="plus" size={14} /></button>
      </div>
      <div class="title-actions">
        <span class="conn-chip" class:connected={sidecarReady}><i></i>{sidecarReady ? '已连接' : ''}</span>
        <div class="more-dropdown" use:clickOutsideMore>
          <button class="top-more" aria-label="更多选项" aria-expanded={moreOpen} on:click={toggleMore}><Icon name="more" size={15} /></button>
          {#if moreOpen}
            <div class="more-menu">
              <button on:click={() => { moreOpen = false; void openSettings() }}>设置</button>
              <button on:click={() => { moreOpen = false; void chooseWorkspace() }}>选择工作区</button>
              <button on:click={() => { moreOpen = false; void newSession() }}>新建会话</button>
            </div>
          {/if}
        </div>
      </div>
    </div>
    <div class="title-right" data-tauri-drag-region>
      <div class="win-controls">
        <button class="win-btn" aria-label="最小化" title="最小化" on:click={() => void appWindow.minimize()}><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><line x1="1" y1="5" x2="9" y2="5" stroke="currentColor" stroke-width="1"/></svg></button>
        <button class="win-btn" aria-label={maximized ? '还原' : '最大化'} title={maximized ? '还原' : '最大化'} on:click={toggleMaximize}>{#if maximized}<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><rect x="1.5" y="3" width="5" height="5" stroke="currentColor" stroke-width="1"/><path d="M3.5 3V1.5h5v5H7" stroke="currentColor" stroke-width="1"/></svg>{:else}<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><rect x="1.5" y="1.5" width="7" height="7" stroke="currentColor" stroke-width="1"/></svg>{/if}</button>
        <button class="win-btn close" aria-label="关闭" title="关闭" on:click={() => void appWindow.close()}><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><line x1="1.5" y1="1.5" x2="8.5" y2="8.5" stroke="currentColor" stroke-width="1"/><line x1="8.5" y1="1.5" x2="1.5" y2="8.5" stroke="currentColor" stroke-width="1"/></svg></button>
      </div>
    </div>
    <button class="panel-toggle left" aria-label={showLeft ? '收起左侧栏' : '展开左侧栏'} on:click={() => (showLeft = !showLeft)}><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.8"/><line x1={showLeft ? '5.5' : '10.5'} y1="3" x2={showLeft ? '5.5' : '10.5'} y2="13"/></svg></button>
    <button class="panel-toggle right" aria-label={showRight ? '收起右侧栏' : '展开右侧栏'} on:click={() => (showRight = !showRight)}><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.8"/><line x1={showRight ? '10.5' : '5.5'} y1="3" x2={showRight ? '10.5' : '5.5'} y2="13"/></svg></button>
      <aside class="sidebar" class:collapsed={!showLeft}>
        <div class="sidebar-actions">
          <button class="sidebar-action" on:click={() => void newSession()}><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><line x1="8" y1="5" x2="8" y2="11"/><line x1="5" y1="8" x2="11" y2="8"/></svg>新建会话</button>
        </div>

        <label class="search"><Icon name="search" size={13} /><input placeholder="搜索会话" bind:value={query} /></label>
        <div class="sidebar-tabs">
          <button class:active={leftTab === 'Activity'} on:click={() => (leftTab = 'Activity')}><Icon name="activity" size={13} /> <span>活动</span></button>
          <button class:active={leftTab === 'Chats'} on:click={() => (leftTab = 'Chats')}><Icon name="chat" size={13} /> <span>聊天</span></button>
          <button class:active={leftTab === 'Projects'} on:click={() => { leftTab = 'Projects'; void loadFiles() }}><Icon name="folder" size={13} /> <span>项目</span></button>
        </div>

        {#if leftTab === 'Projects'}
          <div class="sidebar-section-heading"><span>项目</span><span><button aria-label="选择工作区" on:click={() => void chooseWorkspace()}><Icon name="plus" size={11} strokeWidth={1.9} /></button></span></div>
          <div class="project-list">
            {#each projects as project (project.path)}
              <div class="project-row" class:current={workspacePath === project.path}>
                <button class="project-select" title={project.path} on:click={() => void activateProject(project.path)}>
                  <span class="project-folder"><Icon name="folder" size={12} /></span>
                  <span class="project-name">{project.name}</span>
                  {#if projectBusy === project.path}<span class="project-loading">切换中</span>{/if}
                </button>
                <button class="project-remove" aria-label={`移除项目 ${project.name}`} title="从列表移除" on:click={() => void removeProject(project.path)}><Icon name="x" size={10} /></button>
              </div>
            {:else}
              <div class="file-empty">选择项目目录后显示内容</div>
            {/each}
          </div>
        {:else}
          <div class="session-heading"><span>{leftTab === 'Activity' ? '活动' : '聊天'}</span><span class="session-count">{listedSessions.length}</span></div>
          <div class="sessions">
            {#each sessionRows as row (row.session.id)}
              <button class:current={activeSessionId === row.session.id} class:branch={row.branch} class="session" style={`--session-depth:${row.depth}`} on:click={() => void selectSession(row.session)} on:contextmenu={(event) => openSessionMenu(event, row.session)}>
                <span class:live={row.session.state === 'active'} class:complete={row.session.state === 'done'} class="status-dot" title={statusDotTitle(row.session)}></span>
                {#if row.branch}<span class="branch-mark" title="分支会话"><Icon name="fork" size={11} /></span>{/if}
                <span class="session-copy"><strong>{row.session.title}</strong><small>{row.session.time}</small></span>
              </button>
            {:else}
              <div class="file-empty">{leftTab === 'Activity' ? '没有运行中的会话' : '没有匹配的会话'}</div>
            {/each}
          </div>
        {/if}

        <div class="sidebar-footer">
          {#if agentUpdate?.updateAvailable && dismissedAgentUpdate !== agentUpdate.latest}
            <div class="agent-update-chip" title={`官方 Pi SDK ${agentUpdate.latest} 已发布`}>
              <button type="button" on:click={() => void openSettings('about')}>Pi SDK {agentUpdate.latest}</button>
              <button class="agent-update-dismiss" type="button" aria-label="不再提醒这个版本" on:click|stopPropagation={dismissAgentUpdate}>×</button>
            </div>
          {/if}
          <button class="icon-button" aria-label="打开设置" on:click={() => void openSettings()}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" aria-hidden="true"><path d="M6.7 1.8h2.6l.4 1.7a4.9 4.9 0 0 1 1.2.7l1.7-.7 1.3 2.2-1.3 1.2a5 5 0 0 1 0 1.4l1.3 1.2-1.3 2.2-1.7-.7a4.9 4.9 0 0 1-1.2.7l-.4 1.7H6.7l-.4-1.7a4.9 4.9 0 0 1-1.2-.7l-1.7.7-1.3-2.2 1.3-1.2a5 5 0 0 1 0-1.4L2.1 5.7l1.3-2.2 1.7.7a4.9 4.9 0 0 1 1.2-.7l.4-1.7Z"/><circle cx="8" cy="8" r="2.1"/></svg>
          </button>
          <span class="version">v{version}</span>
        </div>
      </aside>

      {#if sessionMenu}
        <div class="session-menu-backdrop" role="presentation" on:click={() => (sessionMenu = null)}>
          <div class="session-menu" style={`left:${sessionMenu.x}px; top:${sessionMenu.y}px`} role="menu" tabindex="-1" on:click|stopPropagation on:keydown|stopPropagation>
            <button on:click={() => togglePin(sessionMenu!.session)}>{sessionMenu.session.pinned ? '取消置顶' : '置顶'}</button>
            <button on:click={() => void renameSession(sessionMenu!.session)}>重命名</button>
            <button on:click={() => void archiveSession(sessionMenu!.session)}>归档</button>
            <button class="danger" on:click={() => void deleteSession(sessionMenu!.session)}>删除会话</button>
            <div class="session-menu-divider"></div>
            <button on:click={() => { sessionMenu = null; void chooseWorkspace() }}>设置工作区</button>
            <button on:click={() => chooseSessionModel(sessionMenu!.session)}>设置模型</button>
            <button class="has-arrow" on:click={() => exportSession(sessionMenu!.session)}>导出 <span>›</span></button>
            <div class="session-menu-divider"></div>
            <button on:click={() => copySessionValue(`${window.location.origin}${window.location.pathname}#session=${sessionMenu!.session.id}`)}>复制会话链接</button>
            <button on:click={() => copySessionValue(sessionMenu!.session.id)}>复制会话 ID</button>
          </div>
        </div>
      {/if}

      <main class="chat">
        <div class="chat-header" class:empty={activeSessionIdle}>
          <div class="chat-title"><h1>{activeSession}</h1><p><span class="online-dot" class:offline={!sidecarReady}></span> Pi Agent · {workspaceBase()}</p></div>
          {#if activeBranchSiblings.length > 1 || (sessions.find((item) => item.id === activeSessionId)?.parentFile)}
            <div class="branch-dropdown" use:clickOutsideBranch>
              <button class="branch-button" type="button" aria-haspopup="menu" aria-expanded={branchOpen} title="切换分支" on:click={() => (branchOpen = !branchOpen)}>
                <Icon name="fork" size={13} />
                <span>{activeBranchSiblings.length > 1 ? `分支 ${activeBranchIndex + 1}/${activeBranchSiblings.length}` : '分支'}</span>
                <Icon name={branchOpen ? 'chevron-down' : 'chevron-right'} size={10} />
              </button>
              {#if branchOpen}
                <div class="branch-menu" role="menu">
                  <!-- 2-6 分支导航器：树形视图（缩进表层级），而非扁平兄弟列表 -->
                  {#each branchTreeRows as row (row.session.id)}
                    <button
                      class:selected={row.session.id === activeSessionId}
                      type="button"
                      role="menuitem"
                      style={`padding-left:${8 + row.depth * 16}px`}
                      on:click={() => { branchOpen = false; if (row.session.id !== activeSessionId) void selectSession(row.session) }}
                    >
                      <span class="branch-index">{row.branch ? '└' : '●'}</span>
                      <span class="branch-item-copy"><strong>{row.session.title}</strong><small>{row.session.time}</small></span>
                    </button>
                  {/each}
                  <!-- 2-3 worktree 分叉：物理隔离的风险实验分支 -->
                  <button type="button" role="menuitem" class="worktree-fork" disabled={forkBusy || !sidecarReady} title="创建独立 git worktree 并在新目录中分叉会话" on:click={() => { branchOpen = false; void forkWorktree() }}>
                    <span class="branch-index">🌳</span>
                    <span class="branch-item-copy"><strong>{forkBusy ? '创建中…' : 'worktree 分叉'}</strong><small>独立目录 · 与主工作区隔离</small></span>
                  </button>
                </div>
              {/if}
            </div>
          {/if}
        </div>

        <div class="messages" class:centered={activeSessionIdle}>
          {#if imageGenError}<div class="imagegen-error">{imageGenError}</div>{/if}
          {#if imageGenResult}<div class="image-result"><img src={imageGenResult.src} alt={imageGenResult.prompt} /><small>{imageGenResult.prompt}</small></div>{/if}
          {#if activeSessionIdle}
            <div class="empty-state">
              <div class="empty-mark"><img src={logoUrl} alt="Pi-My" /></div>
              <button class="start-project" type="button" on:click={() => void chooseWorkspace()}><Icon name="home" size={13} /><span>{workspaceBase()}</span><Icon name="chevron-down" size={11} /></button>
              <div class="quick-chips" class:show={uiPrefs.showQuickChips}>
                <button on:click={() => quickPrompt('请分析当前项目的目录结构，梳理主要模块、入口文件和各部分职责，并给出简要说明。')}>分析当前项目结构</button>
                <button on:click={() => quickPrompt('请检查当前工作区的 Git 变更，总结改动内容、涉及的文件以及可能的风险点。')}>检查工作区变更</button>
                <button on:click={() => quickPrompt('请阅读并总结当前项目 README 的内容，提炼出项目定位、安装方式和核心用法。')}>总结 README</button>
              </div>
            </div>
          {:else}
            {#if todos.length}
              <button class="todo-chip" on:click={() => { panel = '待办'; showRight = true }}><span>待办 {todos.filter((item) => item.status === 'completed').length}/{todos.length}</span></button>
            {/if}
            {#each runState[activeSessionId]?.timeline ?? [] as message (message.id)}
              {#if message.role === 'user'}
                <div class="message user-message">
                  <div class="user-bubble">{message.text}</div>
                  <div class="user-meta"><time>{message.at}</time><button class="recall" type="button" on:click={() => void copyText(message.text)}>复制</button><button class="recall" type="button" on:click={() => recallMessage(message.userIndex)}>撤回重发</button></div>
                </div>
              {:else}
                <div class="message assistant-message">
                  <div class="message-meta"><span class="assistant-avatar">π</span><strong>Pi Agent</strong><span>回复</span></div>
                  <MarkdownView text={message.text} copyable={false} streamKey={`msg:${message.id}`} />
                  <div class="assistant-actions">
                    <button class:copied={copiedReplyId === message.id} class="assistant-action" type="button" title={copiedReplyId === message.id ? '已复制' : '复制回复'} aria-label={copiedReplyId === message.id ? '已复制' : '复制回复'} on:click={() => void copyReply(message.id, message.text)}>
                      <Icon name={copiedReplyId === message.id ? 'check' : 'copy'} size={14} />
                    </button>
                    <button class="assistant-action" type="button" title="从此回复创建分支" aria-label="从此回复创建分支" disabled={forkBusy || !sidecarReady} on:click={() => void forkAtUserIndex(message.userIndex)}>
                      <Icon name="fork" size={14} />
                    </button>
                    <time class="assistant-time" datetime={new Date(message.timestamp).toISOString()}><Icon name="clock" size={12} />{message.at}</time>
                  </div>
                </div>
              {/if}
            {/each}
            {#if liveLabel(slotFor(activeSessionId))}
              <div class="message assistant-status">
                <div class="live-status" data-phase={slotFor(activeSessionId).phase}>
                  {#if uiPrefs.thinkingOrb === 'liquid'}
                    <ThinkingOrb size={56} />
                  {:else}
                    <Atom size={56} />
                  {/if}
                  <!-- 2-11：live 标签走 i18n（liveLabel 返回 Thinking 等 key 尾段） -->
                  <strong>{liveLabelKey(slotFor(activeSessionId))}</strong>
                  {#if slotFor(activeSessionId).tool && slotFor(activeSessionId).phase === 'working'}<span>{slotFor(activeSessionId).tool}</span>{/if}
                  {#if runState[activeSessionId]?.retry}
                    <!-- 自动重试状态行（1-7）：让"卡住"变成可解释的状态 -->
                    <span class="retry-status">自动重试（第 {runState[activeSessionId].retry.attempt || 1} 次）· {runState[activeSessionId].retry.reason}</span>
                  {/if}
                  {#if runState[activeSessionId]?.compacting}
                    <!-- 1-2 上下文蒸发：压缩状态行（自动压缩触发时不再像卡住） -->
                    <span class="retry-status compact-status">正在压缩上下文（上下文蒸发）· 完成后继续当前任务</span>
                  {/if}
                </div>
              </div>
            {/if}
            {#if (runState[activeSessionId]?.pluginMessages ?? []).filter((m) => m.slot === 'timeline').length}
              <!-- 1-5 UI 插件：timeline 槽位的插件卡片 -->
              {#each (runState[activeSessionId].pluginMessages ?? []).filter((m) => m.slot === 'timeline') as plugin (plugin.timestamp + plugin.customType)}
                <div class="message plugin-message">
                  <PluginCard message={plugin} />
                </div>
              {/each}
            {/if}
            {#if slotFor(activeSessionId).error}
              <div class="message assistant-status">
                <div class="agent-error" role="alert">
                  <strong>请求失败</strong>
                  <p>{slotFor(activeSessionId).error}</p>
                </div>
              </div>
            {/if}
            {#if visibleProcess(slotFor(activeSessionId)).length}
              <div class="process-card" class:open={runState[activeSessionId]?.processOpen}>
                <button class="process-head" type="button" aria-expanded={runState[activeSessionId]?.processOpen} on:click={() => patchSlot(activeSessionId, { processOpen: !slotFor(activeSessionId).processOpen })}>
                  <span class="process-head-main">
                    <i class:live={runState[activeSessionId]?.running}></i>
                    <span>{processSummary(slotFor(activeSessionId))}</span>
                  </span>
                  <span class="process-head-action"><Icon name={runState[activeSessionId]?.processOpen ? 'chevron-down' : 'chevron-right'} size={12} />{runState[activeSessionId]?.processOpen ? '收起' : '展开'}</span>
                </button>
                {#if runState[activeSessionId]?.processOpen}
                  <div class="process-body">
                    {#each visibleProcess(slotFor(activeSessionId)) as step (step.id)}
                      <div class="process-step" class:run={!step.done} class:tool={step.kind === 'tool'}>
                        <span class="process-step-mark"><i class:live={!step.done}></i>{#if step.done}<Icon name="check" size={11} />{/if}</span>
                        <span class="process-step-copy">
                          <strong>{step.kind === 'think' ? '思考' : step.title}</strong>
                          {#if step.body}<span class="process-preview" title={step.body}>{step.body}</span>{/if}
                        </span>
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            {/if}
            {#if runState[activeSessionId]?.running && runState[activeSessionId]?.reply}
              <div class="message assistant-message">
                <MarkdownView text={runState[activeSessionId]?.reply ?? ''} copyable={false} streamKey={`live:${activeSessionId}`} />
              </div>
            {/if}
            {#if runState[activeSessionId]?.confirm}
              <div class="confirm-card">
                <div class="confirm-head"><span class="confirm-tool">{runState[activeSessionId]?.confirm?.toolName}</span><span class="confirm-summary">{runState[activeSessionId]?.confirm?.summary}</span></div>
                <div class="confirm-actions"><button class="confirm-allow" on:click={() => answerConfirm(true)}>允许</button><button on:click={() => answerConfirm(false)}>拒绝</button></div>
              </div>
            {/if}
            {#if (runState[activeSessionId]?.images ?? []).length}
              <!-- show_image 工具（1-3）：图片来自 details.images，不进模型上下文 -->
              <div class="show-images">
                {#each runState[activeSessionId].images as image (image.id)}
                  <button class="show-image" type="button" title={image.name} on:click={() => window.open(image.src, '_blank', 'noopener')}>
                    <img src={image.src} alt={image.name} loading="lazy" />
                  </button>
                {/each}
              </div>
            {/if}
          {/if}
        </div>

        <div class="composer-wrap">
          {#if (runState[activeSessionId]?.steer ?? []).length}
            <div class="steer-bar">
              {#each runState[activeSessionId].steer as item, index (index)}
                <div class="steer-row"><span>{index === 0 ? '插话' : `#${index + 1}`}</span><em>{item}</em></div>
              {/each}
            </div>
          {/if}
          {#if (runState[activeSessionId]?.queue ?? []).length}
            <div class="queue-panel">
              <div class="queue-head"><strong>排队 {(runState[activeSessionId]?.queue ?? []).length} 条</strong><span>当前回合结束后按顺序发送 · 可上移/下移/移除</span></div>
              {#each runState[activeSessionId].queue as item, index (item.id)}
                <div class="queue-row">
                  <pre>{item.text}</pre>
                  <div class="queue-actions">
                    <button type="button" disabled={index === 0} on:click={() => moveQueue(index, -1)}>上移</button>
                    <button type="button" disabled={index === runState[activeSessionId].queue.length - 1} on:click={() => moveQueue(index, 1)}>下移</button>
                    <button type="button" on:click={() => removeQueue(item.id)}>移除</button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
          {#if currentMode === 'plan'}<div class="plan-hint">计划模式：Agent 只能读和搜索，不会修改文件</div>{/if}
          <div class="composer">
            {#if attachError}<div class="git-error attach-error">{attachError}</div>{/if}
            {#if attachments.length}<div class="attach-chips">{#each attachments as attachment, index (index)}<span class="attach-chip" class:image={attachment.kind === 'image'}>{#if attachment.kind === 'image'}<i></i>{/if}<span class="attach-name">{attachment.name}</span><button aria-label="移除附件" on:click={() => removeAttachment(index)}>×</button></span>{/each}</div>{/if}
            {#if mention && mentionItems.length}<div class="mention-menu">{#each mentionItems as item, i}<button class:on={i === mention.index} on:mousedown|preventDefault={() => applyMention(i)}>{mention.kind === 'cmd' ? `/${(item as { id: string }).id}  ${(item as { label: string }).label}${(item as { desc?: string }).desc ? `  ${(item as { desc?: string }).desc}` : ''}` : (item as { path: string }).path}</button>{/each}</div>{/if}
            <textarea bind:this={composerInput} bind:value={inputText} on:input={refreshMention} on:paste={handleClipboardPaste} on:keydown={handleKeydown} placeholder={imageGenMode ? '描述要生成的图片…' : '输入消息，@ 引用文件，/ 运行命令'} rows="2"></textarea>
            <div class="composer-toolbar"><div class="composer-controls"><div class="kind-dropdown" use:clickOutsideKind><button class="kind-button" bind:this={kindButtonRef} aria-haspopup="true" aria-expanded={kindOpen} aria-label="输入模式" on:click={toggleKind}><img src={logoUrl} alt="" /><span>{imageGenMode ? '生图' : 'Pi'}</span><svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true"><path d="M1.5 2.5 4 5l2.5-2.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>{#if kindOpen}<div class="kind-menu"><button class:selected={!imageGenMode} on:click={() => setAgentKind(false)}><img src={logoUrl} alt="" /><span>Pi</span></button><button class:selected={imageGenMode} on:click={() => setAgentKind(true)}><span>生图</span></button></div>{/if}</div><button class="attach-button" disabled={!sidecarReady} aria-label="添加附件" on:click={() => void addAttachments()}><Icon name="paperclip" size={13} /></button><div class="mode-dropdown" use:clickOutsideMode><button class="mode-button" class:plan={currentMode === 'plan'} bind:this={modeButtonRef} aria-haspopup="true" aria-expanded={modeOpen} aria-label="权限模式" on:click={toggleMode}><svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.8 13.5 3.6v4.1c0 3.2-2.2 5.6-5.5 6.6-3.3-1-5.5-3.4-5.5-6.6V3.6L8 1.8Z"/></svg><span>{MODE_LABELS[currentMode] ?? currentMode}</span></button>{#if modeOpen}<div class="mode-menu" class:up={modeMenuUp}>{#each MODE_OPTIONS as option (option.value)}<button class="mode-option" class:selected={option.value === currentMode} on:click={() => void setMode(option.value)}><span class="mode-dot"></span><span class="mode-copy"><strong>{option.label}</strong><small>{option.desc}</small></span></button>{/each}</div>{/if}</div></div><div class="composer-model"><div class="model-dropdown" use:clickOutside><button class="model-button" bind:this={modelButtonRef} disabled={!models.length} aria-haspopup="listbox" aria-expanded={modelOpen} aria-label="模型" on:click={toggleModel}><span>{currentModelLabel}</span><svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true"><path d="M1.5 2.5 4 5l2.5-2.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>{#if modelOpen}<div class="model-menu" class:up={modelMenuUp}><div class="model-search"><Icon name="search" size={12} /><input bind:this={modelSearchInput} bind:value={modelQuery} placeholder="搜索模型…" aria-label="搜索模型" /></div><div class="model-list">{#each modelDropdownGroups as group (group.provider)}<button class="model-group-title" type="button" aria-expanded={!providerCollapsed(group.provider)} on:click={() => toggleModelProvider(group.provider)}><span>{group.provider}{#if group.items[0]?.source === "extension"}<span class="ext-badge" title="由本机 Pi 扩展动态注册">扩展</span>{/if}</span><span class="model-group-count">{group.items.length}</span><Icon name={providerCollapsed(group.provider) ? 'chevron-right' : 'chevron-down'} size={10} /></button>{#if !providerCollapsed(group.provider)}<div class="model-group-items">{#each group.items as model (modelKey(model))}<button class="model-option" class:selected={modelKey(model) === currentModelKey} on:click={() => pickModel(model)}><span class="model-dot"></span><span class="model-name">{model.name}</span></button>{/each}</div>{/if}{:else}<div class="model-empty">没有匹配的模型</div>{/each}</div></div>{/if}</div><div class="thinking-dropdown" use:clickOutsideThinking><button class="thinking-button" bind:this={thinkingButtonRef} disabled={!sidecarReady} aria-haspopup="true" aria-expanded={thinkingOpen} aria-label="思考深度" on:click={toggleThinking}><span class="thinking-label">思考：</span><span class="thinking-value">{thinkingLabel}</span><svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true"><path d="M1.5 2.5 4 5l2.5-2.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>{#if thinkingOpen}<div class="thinking-menu"><div class="thinking-head"><strong>思考深度</strong><span>{thinkingLabel}</span><button class="thinking-help-button" class:on={thinkingHelp} aria-label="档位说明" aria-expanded={thinkingHelp} on:click={toggleThinkingHelp}>?</button></div><div class="thinking-ends"><span>更快</span><span>更聪明</span></div><div class="thinking-slider" style={`--p:${thinkingPercent}`}><div class="thinking-track"></div><div class="thinking-fill"></div><input class="thinking-range" type="range" min="0" max={THINKING_LEVELS.length - 1} step="1" value={thinkingIndex} disabled={!sidecarReady} aria-label="思考档位" on:input={onThinkingInput} on:change={onThinkingChange} /></div>{#if thinkingHelp}<ul class="thinking-help">{#each THINKING_LEVELS as level (level)}<li class:on={level === thinkingLevel}><b>{THINKING_LABELS[level]}</b><span>{THINKING_HELP[level]}</span></li>{/each}</ul>{/if}</div>{/if}</div></div><div class="composer-right"><div class="ctx-dropdown" use:clickOutsideCtx><button class="ctx-button" class:empty={!activeSessionId || !ctxStats?.window} bind:this={ctxButtonRef} disabled={!sidecarReady} aria-label="上下文用量" aria-haspopup="true" aria-expanded={ctxOpen} on:click={toggleCtx}><svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" stroke-width="2"/>{#if ctxStats?.window}<circle cx="9" cy="9" r="7" fill="none" stroke="#333" stroke-width="2" stroke-linecap="round" stroke-dasharray={ctxDash()} transform="rotate(-90 9 9)"/>{/if}</svg></button>{#if ctxOpen}<div class="ctx-menu" class:up={ctxMenuUp}>{#if !activeSessionId}<div class="ctx-empty"><strong>本会话尚未开始</strong><small>发送第一条消息后显示用量</small></div>{:else if !ctxStats?.window}<div class="ctx-empty"><strong>暂无用量数据</strong><small>发送消息后显示上下文占用</small></div>{:else}<div class="ctx-head"><strong>上下文容量（估算）</strong><span>{ctxProgress()}%</span></div><div class="ctx-row"><span>当前上下文</span><span>{fmtWan(ctxStats.currentContext)}</span></div><div class="ctx-row"><span>可用容量</span><span>{fmtWan(Math.max(0, ctxStats.window - ctxStats.currentContext))}</span></div><div class="ctx-row"><span>上下文窗口</span><span>{fmtWan(ctxStats.window)}</span></div><div class="ctx-bar"><i style="width:{ctxProgress()}%"></i></div><div class="ctx-divider"></div><div class="ctx-sub">本会话累计</div><div class="ctx-row"><span>总 Token</span><span>{fmtWan(ctxStats.totals.total)}</span></div><div class="ctx-row"><span>输入</span><span>{fmtWan(ctxStats.totals.input)}</span></div><div class="ctx-row"><span>输出</span><span>{fmtWan(ctxStats.totals.output)}</span></div><div class="ctx-row"><span>缓存读取</span><span>{fmtWan(ctxStats.totals.cacheRead)}</span></div><div class="ctx-row"><span>缓存写入</span><span>{fmtWan(ctxStats.totals.cacheWrite)}</span></div><div class="ctx-divider"></div><div class="ctx-row"><span>本地费率估算</span><span>${ctxStats.costUsd.toFixed(2)}</span></div><div class="ctx-row"><span>平均缓存命中率</span><span>{(ctxStats.cacheHitRate * 100).toFixed(1)}%</span></div><div class="ctx-note">按本地模型费率估算，未提供费率则为 0</div>{#if stateSummaryView}<div class="ctx-divider"></div><div class="ctx-sub">运行状态（1-8 get_state）</div><div class="ctx-row"><span>权限模式</span><span>{stateSummaryView.mode}</span></div>{#if stateSummaryView.model}<div class="ctx-row"><span>模型</span><span>{stateSummaryView.model}</span></div>{/if}{#if stateSummaryView.thinking}<div class="ctx-row"><span>思考档位</span><span>{stateSummaryView.thinking}</span></div>{/if}<div class="ctx-row"><span>消息数</span><span>{Number(sessionState?.stats?.totalMessages ?? 0)}</span></div><div class="ctx-row"><span>排队消息</span><span>{stateSummaryView.queued}</span></div>{/if}{#if quotas.length}<div class="ctx-divider"></div><div class="ctx-sub">Provider 额度（2-8）{quotasBusy ? " · 查询中" : ""}</div>{#each quotas as q (q.provider)}<div class="ctx-row"><span>{q.provider}</span><span>{q.message || "—"}{#if q.nextResetAt} · {formatCountdown(q.msUntilReset)}{/if}</span></div>{/each}<div class="ctx-note">重置时间为按周期估算（设置页可为每个 provider 配置）；接口提供真实重置时间时优先展示</div>{/if}<div class="ctx-note">按本地模型费率估算，未提供费率则为 0</div>{/if}</div>{/if}</div><!-- END-CTX --><button class:imagegen-busy={imageGenBusy} class:stop={runState[activeSessionId]?.running} class="send" aria-label={imageGenMode ? '生成图片' : runState[activeSessionId]?.running ? '停止当前任务' : '发送消息'} title={imageGenMode ? '生成图片' : runState[activeSessionId]?.running ? '停止当前任务' : '发送消息'} on:click={imageGenMode ? generateImage : runState[activeSessionId]?.running ? stop : () => submit('steer')}>{#if imageGenBusy}<span class="send-dot"></span>{:else if runState[activeSessionId]?.running}<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="1.5" y="1.5" width="7" height="7" rx="1" fill="currentColor"/></svg>{:else}<Icon name="send" size={14} strokeWidth={1.9} />{/if}</button></div></div>
          </div>
        </div>
      </main>

      <aside class="workspace" class:collapsed={!showRight}>
        <div class="workspace-rail" aria-label="工作区工具">
          <button class:active={panel === '文档'} aria-label="文件" on:click={() => (panel = '文档')}><Icon name="file" size={14} /></button>
          <button class:active={panel === '变更'} aria-label="变更" on:click={() => (panel = '变更')}><Icon name="git" size={14} /></button>
          <button class:active={panel === '终端'} aria-label="终端" on:click={() => (panel = '终端')}><Icon name="terminal" size={14} /></button>
          <button class:active={panel === '运行'} aria-label="运行" on:click={() => (panel = '运行')}><Icon name="play" size={14} /></button>
          <button class:active={panel === '待办'} aria-label="待办" on:click={() => (panel = '待办')}><Icon name="todo" size={14} /></button>
        </div>
        <div class="workspace-content">
        {#if panel === '文档'}
          <div class="resource-head"><span>{workspaceBase()}</span><button aria-label="刷新文件" disabled={filesLoading || projectBusy !== ''} on:click={() => void loadFiles()}><Icon name="refresh" size={13} /></button></div>
          <div class="resource-tree">
            {#snippet treeRows(prefix: string, depth: number)}
              {#each treeChildren(prefix) as file}
                <button class:file-directory={file.kind === 'directory'} class:file-selected={selectedFile === file.path} class:open={openDirs[file.path]} style={`padding-left:${6 + depth * 12}px`} on:click={() => file.kind === 'file' ? void previewFile(file.path) : toggleDir(file.path)}>
                  <span class="resource-chevron">{#if file.kind === 'directory'}<Icon name={openDirs[file.path] ? 'chevron-down' : 'chevron-right'} size={10} strokeWidth={1.9} />{/if}</span><span class="resource-icon">{#if file.kind === 'file'}<Icon name="file" size={11} strokeWidth={1.6} />{/if}</span><span>{fileName(file.path)}</span>
                </button>
                {#if file.kind === 'directory' && openDirs[file.path]}
                  {@render treeRows(file.path, depth + 1)}
                {/if}
              {:else}
                {#if depth === 0}<div class="resource-empty">{filesLoading || projectBusy ? '正在加载项目文件…' : '选择工作区后显示文件'}</div>{/if}
              {/each}
            {/snippet}
            {@render treeRows('', 0)}
          </div>
          {#if selectedFile}
            <div class="resource-preview-head"><span class="doc-name">{selectedFile}</span><span class="doc-stats">{largeFile ? '大文件 · 虚拟化预览' : documentStats()}</span>{#if !largeFile}{#if !editingFile}<button on:click={() => (editingFile = true)}>编辑</button>{:else}<button on:click={() => void saveFile()}>保存</button><button on:click={() => (editingFile = false)}>取消</button>{/if}{/if}</div>
            {#if largeFile}
              <!-- 2-12：大文件虚拟化预览（只读；编辑仍限 512KB 内文件） -->
              <VirtualFile path={largeFile.path} readFileChunk={readFileChunk} height={480} />
            {:else}
              <article class="resource-preview">{#if editingFile}<textarea class="file-editor" bind:value={fileContent}></textarea>{:else}<pre class="file-preview">{fileContent}</pre>{/if}</article>
            {/if}
          {/if}
        {:else if panel === '变更'}
          <div class="git-panel">
            <div class="panel-content">
              <div class="panel-title"><div><strong>工作区变更</strong><small>{gitChanges.length} 个文件已修改</small></div><button class="primary-small" on:click={() => void refreshGit()}>刷新</button></div>
              <div class="git-changes">
                {#each gitChanges as change}
                  <div class="change-item" role="button" tabindex="0" on:click={() => void loadDiff(change.path)} on:keydown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void loadDiff(change.path) } }}>
                    <input class="change-check" type="checkbox" checked={staged[change.path] ?? false} on:click={(event) => event.stopPropagation()} on:change={() => (staged = { ...staged, [change.path]: !(staged[change.path] ?? false) })} />
                    <span class="file-dot" class:modified={change.code.includes('M')} class:added={change.code.includes('A') || change.code.includes('?')}>{change.code.includes('A') || change.code.includes('?') ? 'A' : 'M'}</span>
                    <div class="change-meta"><strong>{change.path}</strong><small>{change.code}</small></div>
                  </div>
                {:else}
                  <div class="diff-placeholder">当前工作区没有未提交变更</div>
                {/each}
                {#if diffContent}<pre class="diff-content">{diffContent}</pre>{/if}
              </div>
            </div>
            <div class="git-actions">
              {#if gitError}<div class="git-error">{gitError}</div>{/if}
              <input class="commit-input" bind:value={commitMessage} placeholder={uiPrefs.gitTemplate || '提交信息…'} />
              <div class="git-actions-row">
                <button disabled={!sidecarReady} on:click={() => void stageFiles()}>暂存</button>
                <button disabled={!sidecarReady} on:click={() => void commitChanges()}>提交</button>
                <button disabled={!sidecarReady} on:click={() => void pushChanges()}>推送</button>
              </div>
            </div>
          </div>
        {:else if panel === '终端'}
          <!-- 终端组件常驻在下方（见 {:else} 之后），此处仅留位。 -->
        {:else if panel === '待办'}
          <div class="todo-panel">
            <div class="resource-head"><span>任务清单</span><button type="button" on:click={() => { splitOpen = true; agentDefs = loadAgents() }}>拆分</button></div>
            <div class="todo-add"><input bind:value={todoDraft} placeholder={todoParentId ? '子任务…' : '添加任务，Enter'} on:keydown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addTodo(todoParentId || undefined) } }} /><button type="button" aria-label="添加任务" on:click={() => addTodo(todoParentId || undefined)}><Icon name="plus" size={12} strokeWidth={1.9} /></button></div>
            {#if todoParentId}<div class="todo-hint">正在给「{todos.find((item) => item.id === todoParentId)?.content ?? ''}」添加子任务 <button type="button" on:click={() => (todoParentId = '')}>取消</button></div>{/if}
            <div class="todo-list">
              {#each todoView.roots as item (item.id)}
                <div class="todo-item" class:done={item.status === 'completed'} class:doing={item.status === 'in_progress'}>
                  <button class="todo-check" type="button" on:click={() => setTodoStatus(item.id, cycleTodoStatus(item.status))}>{item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '◐' : '○'}</button>
                  <span>{item.content}</span>
                  <button type="button" class="todo-mini" on:click={() => (todoParentId = item.id)}>子项</button>
                  <button type="button" class="todo-mini" on:click={() => removeTodo(item.id)}>×</button>
                </div>
                {#each todoView.children(item.id) as child (child.id)}
                  <div class="todo-item child" class:done={child.status === 'completed'} class:doing={child.status === 'in_progress'}>
                    <button class="todo-check" type="button" on:click={() => setTodoStatus(child.id, cycleTodoStatus(child.status))}>{child.status === 'completed' ? '✓' : child.status === 'in_progress' ? '◐' : '○'}</button>
                    <span>{child.content}</span>
                    <button type="button" class="todo-mini" on:click={() => removeTodo(child.id)}>×</button>
                  </div>
                {/each}
              {:else}
                <div class="resource-empty">还没有任务。用右侧添加，或发送 /todo 某件事。</div>
              {/each}
            </div>
          </div>
        {:else}
          <div class="panel-content">
            <div class="panel-title"><div><strong>子代理</strong><small>{(runState[activeSessionId]?.subRuns ?? []).length} 个任务</small></div><button class="primary-small" on:click={() => { splitOpen = true; agentDefs = loadAgents() }}>并行拆分</button></div>
            {#if (runState[activeSessionId]?.subRuns ?? []).length}
              {#each runState[activeSessionId].subRuns as run (run.id)}
                <button class="sub-row block" type="button" on:click={() => (viewingSub = { ...run, reply: slotFor(run.id).reply || run.reply })}>
                  <i class:run={run.status === 'running'} class:bad={run.status === 'error'}></i>
                  <strong>{run.agent}</strong>
                  <span class="sub-task">{run.task}</span>
                  <em>{run.status === 'running' ? '运行中' : run.status === 'error' ? '失败' : '完成'}</em>
                </button>
              {/each}
            {:else}
              <div class="empty-panel"><span>◌</span><strong>暂无子代理</strong><small>/scout 任务 或点「并行拆分」</small></div>
            {/if}
          </div>
        {/if}
          <!-- 终端常驻挂载（不随面板切换销毁重建）。
               旧写法把它放在 {:else if} 分支里，每切一次面板就销毁并重建 Terminal：
               pty_spawn 一个新 shell（丢掉当前工作目录与正在跑的命令），
               并可能泄漏一个尚未注册完成的 'pty-output' 监听。
               必须留在 .workspace-content **内部**：放到外面会成为 .workspace 的
               第 3 个 grid item，撑出隐式第三列，终端宽度由内容驱动而非 1fr。 -->
          <div class="panel-content terminal-keepalive" class:hidden={panel !== '终端'}>
            <Terminal visible={panel === '终端'} />
          </div>
        </div>
      </aside>
      {#if showRight}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div class="drag-handle" class:dragging={dragging === 'right'} role="separator" aria-label="调整右侧栏宽度" on:mousedown={(event) => startDrag(event, 'right')} on:dblclick={() => resetDrag('right')}></div>
      {/if}
  </div>
  {#if splitOpen}
    <div class="overlay" role="presentation" on:click={(event) => { if (event.target === event.currentTarget) splitOpen = false }}>
      <div class="split-card" role="dialog" aria-label="并行拆分子代理">
        <header><strong>并行拆分</strong><button type="button" on:click={() => (splitOpen = false)}>×</button></header>
        <p>内置 scout 只读侦察；也可选自定义 agent。最多一次发多条。</p>
        {#each splitRows as row, index (index)}
          <div class="split-row">
            <select bind:value={row.agent}>{#each agentDefs as def (def.name)}<option value={def.name}>{def.name}</option>{/each}</select>
            <input bind:value={row.task} placeholder="独立任务…" />
            <button type="button" on:click={() => (splitRows = splitRows.filter((_, i) => i !== index))}>×</button>
          </div>
        {/each}
        <div class="split-actions">
          <button type="button" on:click={() => (splitRows = [...splitRows, { agent: 'scout', task: '' }])}>＋ 任务</button>
          <button class="primary" type="button" on:click={runSplit}>开始</button>
        </div>
      </div>
    </div>
  {/if}
  {#if viewingSub}
    <div class="overlay" role="presentation" on:click={(event) => { if (event.target === event.currentTarget) viewingSub = null }}>
      <div class="sub-view" role="dialog" aria-label="子会话">
        <header>
          <div><strong>{viewingSub.agent}</strong><small>{viewingSub.task}</small></div>
          <span class="chip">{viewingSub.status === 'running' ? '运行中' : viewingSub.status === 'error' ? '失败' : '完成'}</span>
          <button type="button" on:click={() => (viewingSub = null)}>关闭</button>
        </header>
        <div class="sub-body">
          {#each slotFor(viewingSub.id).sent as message}<div class="message user-message"><div class="user-bubble">{message.text}</div></div>{/each}
          {#if slotFor(viewingSub.id).reply || viewingSub.reply}<div class="message assistant-message"><div class="message-meta"><strong>{viewingSub.agent}</strong><span>只读</span></div><MarkdownView text={slotFor(viewingSub.id).reply || viewingSub.reply} copyable={false} /></div>{/if}
          {#if visibleProcess(slotFor(viewingSub.id)).length}
            <div class="process-card open">
              <div class="process-head"><span class="process-head-main"><span>{processSummary(slotFor(viewingSub.id))}</span></span></div>
              <div class="process-body">
                {#each visibleProcess(slotFor(viewingSub.id)) as step (step.id)}
                  <div class="process-step" class:run={!step.done} class:tool={step.kind === 'tool'}><span class="process-step-mark"><i class:live={!step.done}></i>{#if step.done}<Icon name="check" size={11} />{/if}</span><span class="process-step-copy"><strong>{step.kind === 'think' ? '思考' : step.title}</strong>{#if step.body}<span class="process-preview" title={step.body}>{step.body}</span>{/if}</span></div>
                {/each}
              </div>
            </div>
          {/if}
          {#if slotFor(viewingSub.id).running}
            <div class="live-status">
              {#if uiPrefs.thinkingOrb === 'liquid'}
                <ThinkingOrb size={56} />
              {:else}
                <Atom size={56} />
              {/if}
              <strong>{liveLabelKey(slotFor(viewingSub.id)) || tt('live.working')}</strong>
            </div>
          {/if}
        </div>
        <footer>只读检视，请在父会话继续对话。</footer>
      </div>
    </div>
  {/if}
  {#if extToasts.length}
    <div class="ext-toasts" role="status" aria-live="polite">
      {#each extToasts as toast (toast.id)}
        <div class="ext-toast" class:warning={toast.type === 'warning'} class:error={toast.type === 'error'}>{toast.text}</div>
      {/each}
    </div>
  {/if}
  {#if extDialog}
    <div class="overlay" role="presentation">
      <div class="ext-dialog" role="dialog" aria-label={extDialog.title}>
        <header><strong>{extDialog.title}</strong>{#if extDialog.kind !== 'confirm'}<button type="button" aria-label="取消" on:click={() => answerExtDialog(undefined, true)}>×</button>{/if}</header>
        <div class="ext-dialog-body">
          {#if extDialog.message}<p class="ext-dialog-message">{extDialog.message}</p>{/if}
          {#if extDialog.kind === 'select'}
            <div class="ext-options">
              {#each extDialog.options ?? [] as option}
                <button type="button" on:click={() => answerExtDialog(option)}>{option}</button>
              {/each}
            </div>
          {:else if extDialog.kind === 'editor'}
            <textarea class="ext-editor" bind:value={extDialogValue} rows="8"></textarea>
            <div class="ext-dialog-actions">
              <button class="primary" type="button" on:click={() => answerExtDialog(extDialogValue)}>提交</button>
              <button type="button" on:click={() => answerExtDialog(undefined, true)}>取消</button>
            </div>
          {:else if extDialog.kind === 'confirm'}
            <div class="ext-dialog-actions">
              <button class="primary" type="button" on:click={() => answerExtDialog('true', false, { confirmed: true })}>允许</button>
              <button type="button" on:click={() => answerExtDialog(undefined, true, { confirmed: false })}>拒绝</button>
            </div>
          {:else}
            <input
              class="ext-input"
              bind:value={extDialogValue}
              placeholder={extDialog.placeholder ?? ''}
              on:keydown={(event) => { if (event.key === 'Enter') { event.preventDefault(); answerExtDialog(extDialogValue) } }}
            />
            <div class="ext-dialog-actions">
              <button class="primary" type="button" on:click={() => answerExtDialog(extDialogValue)}>提交</button>
              <button type="button" on:click={() => answerExtDialog(undefined, true)}>取消</button>
            </div>
          {/if}
        </div>
      </div>
    </div>
  {/if}
  {#if loginState}
    <div class="overlay" role="presentation">
      <div class="login-card" role="dialog" aria-label="登录">
        <header><strong>{loginState.provider ? `登录 ${loginState.provider}` : '登录'}</strong><button type="button" on:click={cancelLogin}>×</button></header>
        <div class="login-body">
          {#if loginState.userCode}
            <p class="desc">已尝试自动打开浏览器。若未弹出，请点击下方按钮，并在网页输入代码完成授权。</p>
            <div class="device-code"><code>{loginState.userCode}</code><button type="button" on:click={() => void copyText(loginState.userCode ?? '')}>复制</button></div>
            {#if loginState.verificationUri}<button class="primary" type="button" on:click={() => openLoginUrl(loginState.verificationUri ?? '')}>打开浏览器</button>{/if}
          {/if}
          {#if loginState.prompt}
            <p class="desc">{loginState.prompt.message}</p>
            <input bind:value={loginState.value} placeholder={loginState.prompt.placeholder ?? ''} on:keydown={(event) => { if (event.key === 'Enter') submitLoginPrompt() }} />
            <div class="login-actions"><button class="primary" type="button" on:click={submitLoginPrompt}>提交</button><button type="button" on:click={cancelLogin}>取消</button></div>
          {:else}
            <p class="login-status">{loginState.status || '等待授权…'}</p>
          {/if}
        </div>
      </div>
    </div>
  {/if}
  {#if uiPrefs.petEnabled}
    {#key currentPetUrl()}
      {#if petById(uiPrefs.petModel)?.type === 'sprite'}
        <LazyPet kind="sprite" enabled url={currentPetUrl()} />
      {:else if uiPrefs.petModel}
        <LazyPet kind="live2d" enabled url={currentPetUrl()} />
      {:else}
        <LazyPet kind="atom" enabled />
      {/if}
    {/key}
  {/if}
  <Settings open={showSettings} connected={sidecarReady} info={settingsInfo} usageStats={usageStats} imageGenConfig={imageGenConfig} onSaveImageGenConfig={saveImageGenConfig} onclose={() => { showSettings = false; settingsInitialTab = undefined; refreshPrefs() }} openDir={openDir} workspacePath={workspacePath} onChooseWorkspace={chooseWorkspace} onOpenRepo={() => void request('open_url', { url: 'https://github.com/TANGZZee/pi-my' })} providers={providers} onRefreshProviders={refreshProviders} onRefreshUsage={refreshUsage} onPrefsChange={refreshPrefs} onRestoreArchived={(session) => unarchiveSession(session)} onDeleteArchived={(session) => deleteSession(session, true)} agentUpdate={agentUpdate} agentUpdateBusy={agentUpdateBusy} onCheckAgentUpdate={() => void checkAgentUpdate(true)} onUpdateAgent={() => void updatePiSdk()} onOpenAgentUpdate={openAgentUpdate} onOpenAgentRepo={openAgentRepo} initialTab={settingsInitialTab} rpc={request} />
</div>
