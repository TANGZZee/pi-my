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
  import { t as tt } from './i18n.ts'
  import PluginHost from './PluginHost.svelte'
  import { normalizePluginMessage, type PluginMessage } from './ui-plugins'
  // 批次③信任门控：前端缓存 sidecar 下发的项目信任态（iframe 沙箱渲染器用）
  import { isProjectTrusted, setProjectTrusted, subscribeProjectTrust } from './ui-registry'

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
  import { findSlashCommand } from './slash-commands'
  import type { AgentEnvelope } from './protocol'
  import { activeBranchSiblingsOf, buildSessionRows, sessionRootId as sessionRootIdOf } from './session-tree'
  import { appendThinkToSteps, assistantErrorFrom, brief, closeOpenSteps, describeProviderError, endToolStep as endToolStepIn, ensureThinkingStep, formatReplyTime, historyToTimeline, isCancellationText, type HistoryEntry, type TimelineHistoryEntry, type TimelineMessage, type SubRun, lastAssistantReply, liveLabel, mergeHistoryIntoTimeline, pluginReplayPayload, processSummary as processSummaryOf, removeProviderError, sentFromTimeline, settleStepsForFinish, shouldSurfaceProviderError, splitPluginHistory, stashProviderError, takeProviderError, toolResultBrief } from './run-slot'

  import { casRemove, casReorder } from './queue-cas'
  import { collectSubRunUpdates, createEpochGuard, createRunEpoch, createTurnIdFactory, isTurnAlive, isTurnCurrent, planDrain } from './session-run'
  import { cycleTodoStatus, loadTodos, newTodo, saveTodos, todoTree, type TodoItem } from './todos'
  import { createSettleArbiter, SETTLE_FALLBACK_TEXT } from './run-settle'
  // 0-5 批次 A：模型/思考与文件树纯逻辑抽到独立模块（可单测），组件只留接线
  import { MODEL_SEPARATOR, THINKING_LEVELS, sessionMode } from './app-models'
  import { fileName, projectName, workspaceBase } from './app-files'
  // 0-5 批次 B：面板组件（变更/待办/子代理三块从 App.svelte 抽出）。
  // 注意：拆分/检视 overlay 与文档面板虽也抽出，但挂载点不同——overlay 是全局模态
  // （/split、/scout 空参、待办拆分、子会话点击都可能发生在任意面板下），文档面板
  // 在 panel==='文档' 分支内挂载。
  import GitPanel from './GitPanel.svelte'
  import TodoPanel from './TodoPanel.svelte'
  import SubRunsPanel from './SubRunsPanel.svelte'
  import SplitDialog from './SplitDialog.svelte'
  import SubRunOverlay from './SubRunOverlay.svelte'
  import FilePanel from './FilePanel.svelte'
  import Composer from './Composer.svelte'

  type PanelTab = '文档' | '变更' | '终端' | '运行' | '待办'
  type Session = { id: string; title: string; time: string; file?: string; cwd?: string; branch?: string; parentFile?: string; state?: 'active' | 'done'; model?: string; thinking?: string; mode?: string; pinned?: boolean; archived?: boolean; parentId?: string; branchParentId?: string; forkedFrom?: string; createdAt?: number; modifiedAt?: number; readOnly?: boolean }
  type ModelInfo = { provider: string; id: string; name: string; reasoning: boolean; source?: 'config' | 'extension' }
  type GitChange = { code: string; path: string }
  type SidecarResponse = { type: 'response'; id: number; ok: boolean; result: unknown; error?: string }
  type SentMessage = { text: string; at: string }
  // TimelineMessage/SubRun 现在从 run-slot.ts 导入（1-5 批次② / 0-5 批次 B），不再本地重复声明
  type Phase = 'idle' | 'thinking' | 'working' | 'writing' | 'waiting'
  type ProcessStep = { id: string; kind: 'think' | 'tool'; title: string; body: string; done: boolean }
  type QueuedMessage = { id: string; text: string }
  type RunSlot = { reply: string; thinking: string; tool: string; phase: Phase; running: boolean; error?: string; queue: QueuedMessage[]; queueRevision: number; steer: string[]; sent: SentMessage[]; timeline: TimelineMessage[]; subRuns: SubRun[]; process: ProcessStep[]; processOpen: boolean; replyAt?: number; historyLoaded?: boolean; activeTurnId?: string; confirm?: { confirmId: string; toolName: string; summary: string }; images?: Array<{ id: string; src: string; name: string }>; retry?: { attempt: number; reason: string }; compacting?: boolean; pluginMessages?: PluginMessage[]; pluginTitle?: string }
  type SettingsInfo = { node: string; sdk: string; agentDir: string; sessionDir: string; authProviders: string[]; providers?: Array<{ provider: string; modelCount: number; configured: boolean }> }
  type UsageStats = { sessions: number; turns: number; activeDays: number; totals: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }; costUsd: number; costKnown: boolean; byModel: Array<{ model: string; tokens: number; turns: number }>; byProject?: Array<{ project: string; tokens: number; turns: number }>; byDay?: Record<string, number> }
  type ImageGenConfig = { baseUrl: string; apiKey: string; model: string; size: string }
  type AgentUpdateInfo = { current: string; latest: string; installedVersion?: string; updateAvailable: boolean; url: string; repoUrl?: string; source?: string; sourceLabel?: string; updated?: boolean; restartRequired?: boolean; message?: string; checkedAt?: number }
  type WorkspaceProject = { path: string; name: string; addedAt: number }

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
  // D-F（外部审计 P2）：原先 extDialog 是**全局单值**，新请求直接整体覆盖旧请求，
  // 于是两个扩展（或两个会话）同时请求时，先到的那个 dialogId 永远收不到回答，
  // 只能等 sidecar 的 600s 超时后按默认值回落。改为队列：模板仍消费单个 extDialog。
  let extDialogs: ExtDialog[] = []
  $: extDialog = extDialogs[0] ?? null
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
  // git 面板状态已移入 GitPanel.svelte（0-5 批次 B-1），经 bind: 双向绑定
  let gitChanges: GitChange[] = []
  let diffContent = ''
  let gitError = ''
  let inputText = ''
  let query = ''
  let runState: Record<string, RunSlot> = {}
  let runWatchdogs: Record<string, number> = {}
  // provider 终态错误暂存（会话级）：SDK 在模型报错时**不发 type:'error' 事件**，
  // 而是产出一条 stopReason:'error' 的 assistant 终态消息，再照常发 agent_end。
  // 若不在此处接住，错误文本会被整条丢弃 —— 用户看到的就是"没有任何反馈"。
  let providerErrors: Record<string, string> = {}
  // 已关闭 / 已删除的会话 id（外部审计缺陷 3）：closeTab 删掉 runState[id] 之后，
  // 在途事件（agent_start/message_update/…）仍会到达。patchSlot 对未知 id 会以
  // emptySlot 兜底**重新长出槽位**，agent_start 分支还会无条件写 running:true 并
  // touchRunWatchdog 重新武装 180s 看门狗 —— 而此时会话已不在 sessions 里：没有
  // 标签、没有停止按钮，用户完全无法中止，180 秒后错误文本落进一个不可见的槽。
  // 修法：把这类 id 记下来，patchSlot 直接拒绝写入；重新打开同一个 id 时移除。
  const closedIds = new Set<string>()

  /**
   * F4 终态兜底仲裁器（语义在 run-settle.ts 的纯模块里，可单测）。
   *
   * 为什么必须有它：agent_end / agent_settled 是前端把 running 打回 false 的**唯一**途径，
   * 而它们是 sidecar → Rust stdout 读取线程 → Tauri emit → webview 这条链上的普通事件。
   * 在这条链的任何一环丢失（读取线程异常退出、某行 JSON 无法解析、emit 失败、webview
   * 丢帧），running 就永远停在 true：界面显示永久 Thinking、没有错误条、没有任何反馈 ——
   * 正是用户报障（0.3.3 报障：用不可用模型发消息后一直显示 Thinking）的形态。
   * 「扩展钩子在 agent_end 里悬挂」这一假设已被全机穷举否掉（6 个注册点全 bounded/inert），
   * 因此不能靠"终态事件一定会到"来兜底，必须有一条不依赖它自己的防线。
   *
   * 时机取舍：只有**已经看到 provider 错误**（assistant 终态消息带 stopReason:'error'）
   * 才武装计时器，8 秒内没等到任何新事件就按失败收尾。理由：
   *   1. 正常重试路径上 SDK 先发 auto_retry_start 再睡退避延迟（agent-session.js:2961
   *      先 emit、:2973 后 sleep；两行都在 0.99.1 的 _prepareRetry 里），事件毫秒级到达 ⇒ 计时器被撤销，绝不误报；
   *   2. 8 秒远短于 180 秒看门狗，用户不必等三分钟才知道失败了；
   *   3. 正常但慢的模型不会武装（没看到错误就不挂表），也不会误报。
   */
  const settleArbiter = createSettleArbiter({
    onFire: (id, raw) => {
      // 已经收尾的槽位绝不复活：计时器回调可能与真正的终态事件在同一轮事件循环里排队，
      // 撤销调用已经来不及了，靠 running 判定谁先到。（finishRun 自身也有早退判据，
      // 且 F1 之后早退分支会把 errorMessage 写回槽位，不会把这条提示吞掉。）
      if (!slotFor(id).running) return
      finishRun(id, `${describeProviderError(raw)}\n${SETTLE_FALLBACK_TEXT}`)
    }
  })

  // 因"会话正在运行"而被跳过的磁盘历史（缺陷 10）：先存这里，finishRun 时合并。
  let pendingHistory: Record<string, HistoryEntry[]> = {}
  let sidecarReady = false
  // 批次③信任门控：registry 里的前端信任缓存 → 响应式镜像（三个 PluginHost 宿主用）。
  let pluginTrusted = isProjectTrusted()
  onMount(() => subscribeProjectTrust(() => { pluginTrusted = isProjectTrusted() }))
  let models: ModelInfo[] = []
  let composerRef: Composer
  let settingsInfo: SettingsInfo | null = null
  let usageStats: UsageStats | null = null
  let providers: Array<{ provider: string; modelCount: number; configured: boolean }> = []
  let agentUpdate: AgentUpdateInfo | null = null
  let dismissedAgentUpdate = ''
  let agentUpdateBusy = false
  let agentUpdateTimer: number | undefined

  function refreshPrefs() {
    uiPrefs = loadPrefs()
    applyPrefsChrome()
    composerRef?.reloadPrefs()
    void refreshPetStatus()
  }
  function desktopNotify(title: string, body: string) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return
    try { new Notification(title, { body }) } catch { /* ignore */ }
  }
  let moreOpen = false
  let uiPrefs = loadPrefs()
  // 0-5 批次 B-2：todos 移入 TodoPanel.svelte 后经 bind: 双向同步——
  // App 保留权威副本（todo-chip 计数、/todo 斜杠命令直写 localStorage 后要刷新面板）。
  let todos: TodoItem[] = []
  let todoDraft = ''
  let todoParentId = ''
  let todoPanelRef: TodoPanel
  let gitPanelRef: GitPanel
  let agentDefs: AgentDef[] = loadAgents()
  // 0-5 批次 B-4：拆分/检视 overlay 抽到 SplitDialog/SubRunOverlay，状态回到 App 自持
  // （经 bind: 双向同步；runSplit/finishSubRun 同步、/split 命令仍在父组件）。
  let splitOpen = false
  let splitRows: Array<{ agent: string; task: string }> = [{ agent: 'scout', task: '' }]
  let viewingSub: SubRun | null = null
  let attachments: Array<{ kind: 'image' | 'text'; name: string; mimeType?: string; data?: string; content?: string }> = []
  let imageGenError = ''
  let imageGenResult: { src: string; prompt: string } | null = null
  let imageGenConfig: ImageGenConfig = { baseUrl: '', apiKey: '', model: '', size: '1024x1024' }
  let copiedReplyId = ''
  let forkBusy = false
  let ctxEditBusyId = ''
  let ctxEdits: Array<{ entryId: string; targetId: string; removed: boolean; text: string; timestamp: number }> = []
  let ctxPanelOpen = false
  let branchOpen = false
  let attachError = ''
  let rightWidth = 280
  let sessionMenu: { session: Session; x: number; y: number } | null = null
  let dragging: 'left' | 'right' | null = null
  let dragStartX = 0
  let dragStartWidth = 0
  // 常量（MODEL_SEPARATOR/THINKING_*/DEFAULT_THINKING/MODE_*）已抽到 app-models.ts（0-5 批次 A）
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
  // 0-5 批次 B-5：文件树/预览移入 FilePanel.svelte；filteredFiles 留在这里
  // （侧栏搜索框 query 与 @ 补全共享）。openDirs 是面板本地展开态，随组件走。
  // 修复：此前空白页判断藏在函数里，异步载入历史后不会自动刷新。
  $: activeSessionIdle = (() => {
    const slot = runState[activeSessionId]
    return !slot?.timeline.length && !slot?.reply && !slot?.running && !slot?.queue.length && !slot?.process.length
  })()
  $: currentMode = sessionMode(sessions, activeSessionId)
  $: if (typeof document !== 'undefined') document.body.classList.toggle('resizing', dragging !== null)
  // D-B（外部审计 P1）：权限确认原先只渲染 active 槽（模板 `runState[activeSessionId].confirm`），
  // 也只由 active 槽回答（answerConfirm 取 activeSessionId）。后台会话的确认因此**完全不可见**，
  // 用户切走期间那个工具调用一直挂着，直到 sidecar 的 600s 超时按 confirm→false 保守拒绝。
  // 存储本来就是按会话的（confirm_request 用 payload.sessionId），缺的只是渲染与回答。
  $: pendingConfirms = Object.keys(runState)
    .filter((id) => runState[id]?.confirm && id !== activeSessionId)
    .map((id) => ({
      id,
      title: sessions.find((item) => item.id === id)?.title || id,
      confirm: runState[id].confirm!,
    }))

  let processSeq = 0
  // 单调递增的回合号：用 `turn-${Date.now()}` 做 id 时，同一毫秒内的两次派发会撞出
  // 重复 key（timeline 以 message.id 为 key，Svelte 会报重复键并复用错误节点）。
  // 实现见 src/session-run.ts（纯函数，有单测）。
  const nextTurnId = createTurnIdFactory()

  // 会话 id 同理：`session-${Date.now()}` 在同一毫秒内新建两次会撞出同一个 id，
  // 后者会被 sessions 的 map 分支当成"已存在"而静默覆盖（或让两个会话共用槽位）。
  const nextSessionId = createTurnIdFactory('session')

  // 会话切换代数：每次"换到别的会话/关掉会话"都自增，用于判定一个 await 之后
  // 是否已经被更新的一次切换取代（关闭→重开同一个 id 时仅靠 id 比对抓不住）。
  // 实现见 src/session-run.ts（纯函数，有单测）。
  const sessionEpoch = createEpochGuard()

  // 运行世代：Stop / 关标签会 abort 当前回合，但 SDK 的 `agent_end`/`agent_settled`
  // 仍然会迟到（它们是在 abort 请求飞行期间发出的），且事件里**不带回合身份**。
  // 若这时用户已经发了下一条消息，迟到事件会把新回合当成已结束 —— running 归零、
  // 半截回复被提交成终态，此后 text_delta 写进 reply 但 finishRun 早退，
  // 这部分内容永远进不了 timeline（外部审计缺陷 1）。实现见 src/session-run.ts。
  const runEpoch = createRunEpoch()

  // 队列 drain 定时器：缺陷 2 —— finishRun 里的 40ms `setTimeout(() => drainQueue(id))`
  // 会在 Stop 之后仍然触发，把 follow-up 悄悄派发成新回合，而上一轮的尾部文本
  // 还在往同一个 reply 缓冲区追加，于是一条完整回答被劈成两个气泡。
  // Stop / 关标签 / 删除会话时必须一并 clearTimeout。
  let drainTimers: Record<string, number> = {}

  function clearDrainTimer(id: string) {
    const handle = drainTimers[id]
    if (handle === undefined) return
    window.clearTimeout(handle)
    const next = { ...drainTimers }
    delete next[id]
    drainTimers = next
  }

  function scheduleDrain(id: string) {
    clearDrainTimer(id)
    drainTimers = { ...drainTimers, [id]: window.setTimeout(() => { clearDrainTimer(id); drainQueue(id) }, 40) }
  }

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

  function applySessionHistory(id: string, history: HistoryEntry[] = []) {
    const current = slotFor(id)
    // 1-5 批次②（对抗审查缺口 #1/#8 根治）：分流抽成纯函数 splitPluginHistory ——
    // 谓词方向由 tests/run-slot.test.mjs 行为测试锁定（chatHistory 谓词反转变异
    // 曾在形状断言下存活，普通聊天历史被清空而测试全绿）。
    // 插件条目经 pluginReplayPayload 透传 display（缺口 #1：display:{} 变异曾致
    // 重放卡片丢 slot/component/title/fields），再规范化成 PluginMessage 进插件槽。
    const { plugin: pluginHistory, chat: chatHistory } = splitPluginHistory(history)
    if (pluginHistory.length) {
      const replayed: PluginMessage[] = []
      for (const item of pluginHistory) {
        const payload = pluginReplayPayload(item as TimelineHistoryEntry)
        const normalized = normalizePluginMessage({
          customType: payload.customType,
          content: payload.content,
          display: payload.display,
        })
        if (normalized) {
          normalized.entryId = payload.entryId
          if (payload.timestamp) normalized.timestamp = payload.timestamp
          replayed.push(normalized)
        }
      }
      if (replayed.length) patchSlot(id, { pluginMessages: replayed })
    }
    const nextCurrent = slotFor(id)
    if (nextCurrent.running) {
      // 缺陷 10（外部审计 P2）：这里原先是**直接 return 丢掉**。运行中打开一个
      // 有历史的会话时（或重启重绑时该会话正在跑），磁盘历史就此永久消失 —— 此后
      // 没有任何重试点，finishRun 不回头补加载，用户看到的时间线只有当前这一轮。
      // 改为记下来，在 finishRun 收尾时合并到时间线**前面**（当前轮的条目保留）。
      if (chatHistory.length) pendingHistory = { ...pendingHistory, [id]: chatHistory }
      return
    }
    if (current.historyLoaded) {
      // 界面已经有时间线（例如 dispatchTurn 在 prompt 尚未 ack 时就置了
      // historyLoaded，随后重启重绑又读到同一份磁盘历史）。此时**合并**而不是
      // 覆盖：既补回被跳过的历史，又不会抹掉正在显示的内容。
      const merged = mergeHistoryIntoTimeline(chatHistory, current.timeline)
      patchSlot(id, { timeline: merged, sent: sentFromTimeline(merged) })
      return
    }
    const timeline = historyToTimeline(chatHistory)
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

  /**
   * 把暂存的迟到历史补进时间线（缺陷 10）。
   * 由 finishRun 调用：此刻 running 已归零、本轮回复已落进 timeline，合并是安全的
   * （当前轮条目按 id 去重保留，不会被历史覆盖）。
   */
  function flushPendingHistory(id: string) {
    const parked = pendingHistory[id]
    if (!parked) return
    // 先确认这次合并真的落得下去，再删停泊项。原先"先 delete 再 patchSlot"在 patchSlot
    // 被 closedIds 拒绝（会话在 finishRun 与 flush 之间被关掉）时会**静默丢失**整段
    // 磁盘历史，且没有任何重试点（外部审计缺陷 13）。
    if (closedIds.has(id)) {
      const pruned = { ...pendingHistory }
      delete pruned[id]
      pendingHistory = pruned
      return
    }
    const merged = mergeHistoryIntoTimeline(parked, slotFor(id).timeline)
    patchSlot(id, { timeline: merged, sent: sentFromTimeline(merged), historyLoaded: true })
    const next = { ...pendingHistory }
    delete next[id]
    pendingHistory = next
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
        // 若期间已记下 provider 错误，超时文案优先显示真正的失败原因，
        // 否则用户只会看到"没有返回结果"，仍然不知道是 404 / 401 还是网络问题。
        const pending = consumeProviderError(id)
        finishRun(
          id,
          pending ||
            '模型超过 3 分钟没有返回任何结果。请检查当前模型的网络连接、额度或中转服务是否正常。'
        )
      }, 180000)
    }
  }

  /**
   * provider 错误暂存的三个壳（语义在 run-slot.ts 的纯函数里，可单测）。
   *
   * 为什么只是壳：对抗性审查的 M11/M12 变异实证 —— 把这三个函数体整个清成 `return`，
   * 全套测试照样 61/61 通过（wiring 测试只匹配源码文本，验不了语义）。暂存是本次修复的
   * 语义核心，写坏就等于让 provider 报错重新"没有反馈"，故把逻辑搬进纯函数并直接单测。
   */
  function setProviderError(id: string, raw: string) {
    providerErrors = stashProviderError(providerErrors, id, raw)
    // F4（终态兜底）：看到 provider 错误就武装兜底计时器。raw 为空串（正常结束 / 主动清理）
    // 时 arm 内部直接返回，所以正常但很慢的模型绝不会被误收尾。
    // 放在这个唯一漏斗里而不是散在分支上：任何一条新的错误来源都自动获得兜底。
    settleArbiter.arm(id, raw)
  }

  function clearProviderError(id: string) {
    // F4：清暂存的同时撤销兜底计时器 —— 所有收尾路径（finishRun / stop / teardownRun /
    // abortRunningRuns / type:'error' 分支）都会走到这里，撤销点因此天然完整。
    settleArbiter.cancel(id)
    providerErrors = removeProviderError(providerErrors, id)
  }

  /**
   * 取走暂存的 provider 错误并转成给用户看的中文归因。
   * 没有暂存时返回空串 —— 正常结束（stop / aborted / 无错误）绝不能报错。
   */
  function consumeProviderError(id: string): string {
    const taken = takeProviderError(providerErrors, id)
    providerErrors = taken.stash
    return taken.message
  }

  /**
   * 把当前所有"运行中"的槽改为失败终态并给出原因。
   * 用于 sidecar 崩溃/被放弃重启这类**永远等不到 agent_settled** 的场景：
   * 此前只清 pending 请求，running 槽与看门狗都留着，用户看到的就是永久 Thinking。
   */
  function abortRunningRuns(message: string) {
    for (const id of Object.keys(runState)) {
      if (!runState[id]?.running) continue
      clearRunWatchdog(id)
      clearProviderError(id)
      const slot = slotFor(id)
      patchSlot(id, {
        running: false,
        phase: 'idle',
        tool: '',
        processOpen: false,
        confirm: undefined,
        retry: undefined,
        compacting: false,
        error: message,
        // 侧车崩溃等不到任何终态事件：等待思考占位同样要收束成明确结束语。
        process: settleStepsForFinish(slot.process),
        // 必须清掉 activeTurnId：finishRun 的早退条件是
        // `!running && !activeTurnId`，留着它会让之后任何一次 `finishRun(id, '')`
        // 走进写入分支，用空串把这条"侧车已停止"的提示抹掉。
        activeTurnId: undefined
      })
      markSession(id, 'done')
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
  // 注意：对**已关闭/已删除**的会话必须拒绝写入，否则在途事件会把僵尸槽位复活
  // （见 closedIds 的注释）。这里的判断放在最前面，保证任何路径都拦得住。
  function patchSlot(id: string, patch: Partial<RunSlot>) {
    if (closedIds.has(id)) return
    runState = { ...runState, [id]: { ...emptySlot(), ...runState[id], ...patch } }
  }

  /** 会话关掉/删掉时统一登记，之后一切针对它的异步写入都会被 patchSlot 丢弃。 */
  function markSlotClosed(id: string) {
    closedIds.add(id)
    // 缺陷 13：运行中打开一个会话时，磁盘历史会停泊在 pendingHistory 里等 finishRun
    // 补合。若这个 id 先被关掉/删掉，停泊项既不会被清（patchSlot 此后一律拒绝写入）
    // 也不会被重试 —— 等同一个 id 被重新创建（remember() 会把 id 放回侧栏）后，
    // finishRun 一 flush 就把**上一个生命周期**的历史并进新会话，时间线错乱。
    if (pendingHistory[id]) {
      const pruned = { ...pendingHistory }
      delete pruned[id]
      pendingHistory = pruned
    }
    teardownRun(id)
    if (runState[id]) {
      const next = { ...runState }
      delete next[id]
      runState = next
    }
  }

  /** 会话（重新）建立时解除封禁 —— 关闭→重开同一个 id 必须还能用。 */
  function markSlotOpen(id: string) {
    closedIds.delete(id)
  }

  // expectedTurnId 是"发起这次收尾的人所认为的回合"。终态事件（agent_end /
  // agent_settled / auto_retry_end）都不带回合身份，所以调用方必须在派发时把
  // 当时的 activeTurnId 钉住传进来 —— 否则点 Stop 后立刻再发一条时，旧回合的
  // 终态事件会把新回合当成已结束（外部审计缺陷 1：running 归零、半截回复被
  // 提交成终态，之后 text_delta 再也进不了 timeline，因为本函数会早退）。
  // 判据本身是纯函数 isTurnCurrent（src/session-run.ts，有单测）。
  function finishRun(id: string, errorMessage = '', expectedTurnId?: string) {
    const current = slotFor(id)
    // 守卫必须在清理动作之前：否则陈旧事件会把新回合的看门狗与暂存错误一起清掉。
    if (!isTurnCurrent(current.activeTurnId, expectedTurnId)) return
    clearRunWatchdog(id)
    if (!current.running && !current.activeTurnId) {
      // 早退分支（外部对抗性审查 F1）：槽位已经收过一次尾，但这次调用**带着错误文本**。
      // 调用方是在拿到终态事件时先 consumeProviderError 把暂存取走再传进来的，若这里
      // 直接 return，那段文本就凭空消失了 —— 用户看到的就是"永久 Thinking 且不报错"。
      // 真实可达路径：上一轮被 Stop 之后迟到的 agent_settled 以空错误先收尾一次
      //（running/activeTurnId 双双归零），紧接着本轮真正的失败终态带着 402/404 到达；
      // 或 F4 兜底仲裁器与迟到的 agent_end 竞争，谁后到谁就在早退分支上。
      // 因此：早退也要把错误写进槽位（只写 error，不动 timeline/process —— 那些已经
      // 由第一次收尾定稿了），并且照常清掉暂存，避免污染下一个回合。
      clearProviderError(id)
      // 但"用户自己按了停止"这一轮例外：此时弹"请求失败"是把取消说成故障。
      // stop()/closeTab/deleteSession/archiveSession 都已在 runEpoch 上打了 markAborted，
      // isAborted 判的正是"当前世代就是被中止的那一代、且之后没有新派发"（新一轮 dispatch
      // 会让它变假），它与上游文案无关，比 isCancellationText 的正则可靠。
      // ⚠️ 不能用 isSuperseded：那不是"被用户中止"，新一轮一 dispatch 就为真，会把
      // 新一轮自己的真实失败静默吞掉 —— 那正是本文件 F1 要修的"永久 Thinking 且不报错"。
      if (shouldSurfaceProviderError(errorMessage, runEpoch.isAborted(id))) patchSlot(id, { error: errorMessage })
      return
    }
    // 运行已收尾，暂存的 provider 错误必须一并清掉，否则下一次正常结束的会话
    // 可能被上一次残留的错误文本污染（误报"请求失败"）。
    clearProviderError(id)
    // 终态收束：把没等到内容的"等待思考"占位改成明确结束语 —— 失败终态下思考内容
    // 永远不会来，只 closeOpenSteps 会留着一个"正在等待模型返回思考内容…"的已完成
    // 步骤，看起来像还在思考（用户实测 402 后思考框不消失）。
    const process = settleStepsForFinish(current.process)
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
    // 缺陷 10：运行期间被跳过的磁盘历史在此补进时间线**前面**（当前轮条目按 id
    // 去重保留），否则那段历史永久丢失。必须在 patchSlot 之后调用：要基于刚写好
    // 的时间线做合并。
    flushPendingHistory(id)
    finishSubRun(id, errorMessage ? 'error' : 'done')
    void composerRef?.refreshCtx()
    if (!errorMessage && loadPrefs().notifyDone && !sessions.find((item) => item.id === id)?.parentId) desktopNotify('Pi-My', '任务已完成')
    if (!errorMessage) scheduleDrain(id)
  }

  $: if (activeSessionId) todos = loadTodos(activeSessionId)
  $: todoView = todoTree(todos)

  function persistTodos(next: TodoItem[]) {
    todos = next
    saveTodos(activeSessionId, next)
  }

  // setTodoStatus/removeTodo/addTodo 已随面板抽到 TodoPanel.svelte（bind:todos 直接赋值同步）；
  // App 侧只保留 persistTodos：/todo 斜杠命令与 todo-chip 计数仍需要它。


  function finishSubRun(id: string, status: SubRun['status']) {
    const reply = slotFor(id).reply
    // 两段式（先收集父槽 id，再逐个重新读取最新槽）：patchSlot 是整体替换，
    // 若在遍历时用 `Object.entries(runState)` 拿到的旧 `slot.subRuns` 做 map，
    // 同一轮里对同一父槽的第二次匹配会拿旧值覆盖第一次的结果（丢更新）。
    // 判定逻辑抽到 src/session-run.ts，由单测固定。
    for (const update of collectSubRunUpdates(runState, id, status, reply)) {
      patchSlot(update.parentId, { subRuns: update.subRuns })
    }
    if (viewingSub?.id === id) viewingSub = { ...viewingSub, status, reply }
  }

  async function recallMessage(index: number) {
    // 缺陷 12（外部审计 P2）：必须把发起时的会话 id 钉死。`stop()` 是一个真正的
    // await（它要等 abort 在 sidecar 里结算完），而 activeSessionId 是模块级的 ——
    // 等待期间用户完全可以切到另一个会话。原先 await 之后重读 activeSessionId，
    // 于是"在 A 点撤回、等待中切到 B"会把 **B** 的时间线按 B 自己的 userIndex 截断、
    // 把 B 的已发送列表砍掉，而 A 分毫未动：用户看到的是另一个会话的消息凭空消失。
    const idAtEntry = activeSessionId
    const slot = slotFor(idAtEntry)
    const message = slot.sent[index]
    if (!message) return
    if (slot.running) await stop()
    // 等待期间换了目标就整个放弃：文本不再填进输入框，也不写任何槽。
    if (activeSessionId !== idAtEntry) return
    // stop() 之后重新取一次：等待期间槽可能已被收尾（running 归零、reply 清空），
    // 但取的仍是**同一个 id** 的槽。
    const current = slotFor(idAtEntry)
    inputText = message.text
    composerRef?.clearMention()
    const cutIndex = current.timeline.findIndex((item) => item.role === 'user' && item.userIndex === index)
    const timeline = cutIndex >= 0 ? current.timeline.slice(0, cutIndex) : current.timeline
    const previousReply = [...timeline].reverse().find((item) => item.role === 'assistant')
    patchSlot(idAtEntry, {
      sent: current.sent.slice(0, index),
      timeline,
      reply: previousReply?.text || '',
      replyAt: previousReply?.timestamp,
      thinking: '',
      tool: '',
      queue: [],
      queueRevision: 0,
      process: [],
      processOpen: false,
      activeTurnId: undefined,
      phase: 'idle'
    })
    window.setTimeout(() => composerRef?.focusInput(), 0)
  }

  // T2⑦ 上下文编辑（SDK ContextEditEntry 原生化）：对单条模型可见条目追加分支局部编辑。
  // replacement=null = 从模型上下文剔除该条目（UI 只开放这一种，替换文本留待后续按需开放）。
  // 承重语义：entryId 必须来自 list_context 的真实条目（磁盘上的 append-only 操作，不可逆）。
  async function removeContextEntry(entryId: string) {
    const idAtEntry = activeSessionId
    if (!idAtEntry || !sidecarReady || ctxEditBusyId) return
    if (slotFor(idAtEntry).running) return
    if (!window.confirm('确定从模型上下文中剔除这条消息？此操作写入会话文件且不可撤销（时间线显示不受影响）。')) return
    ctxEditBusyId = entryId
    try {
      await requestOk('apply_context_edit', { sessionId: idAtEntry, targetId: entryId, replacement: null })
      await refreshCtxEdits(idAtEntry)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error))
    } finally {
      ctxEditBusyId = ''
    }
  }

  // 拉取当前会话的模型可见条目 + 已生效编辑清单（list_context）。
  async function refreshCtxEdits(sessionId: string = activeSessionId) {
    if (!sidecarReady || !sessionId) return
    // 会话守卫（与 Composer.refreshCtx 同款）：list_context 在途期间用户可能切走会话，
    // 晚到的响应绝不能把旧会话的编辑清单写进新会话视图。
    const idAtEntry = activeSessionId
    try {
      const result = await requestOk('list_context', { sessionId }) as { edits?: typeof ctxEdits }
      if (activeSessionId !== idAtEntry) return
      ctxEdits = result?.edits ?? []
    } catch {
      // 失败静默清空 —— 但仅限仍停留在发起时的会话：切走后新会话自己的
      // refreshCtxEdits 接管清单，旧请求的失败不得抹掉它。
      if (activeSessionId === idAtEntry) ctxEdits = []
    }
  }

  function editedEntryIds(): Set<string> {
    return new Set(ctxEdits.map((item) => item.targetId))
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
      // requestOk：create_session 失败（sidecar 拒绝/超时）必须抛进下面的 catch，
      // 让 finishSubRun(childId,'error') 真正发生 —— 旧 request() 吞成 null 后
      // `created.file` 会先抛一个无文案的 TypeError，用户看到的是莫名的子代理失败。
      const created = await requestOk('create_session', { sessionId: childId, cwd: workspacePath, mode: def.mode, thinking: def.thinking ?? 'low' }) as { id: string; file?: string }
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
      // S-1 发送侧（外部审计确证缺陷 1）核查结论：**子代理不需要 turnId**。
      // 每次 spawnSubagent 都新造一个 childId（见上方 `sub-${Date.now()}-…`），一个槽
      // 只跑一轮、也只可能有一轮；晚到的 `type:'error'` 回显的 undefined 与
      // `isTurnCurrent(childId 的 activeTurnId, undefined)` 恒放行恰好同义，不存在
      // "旧轮错误收尾新回合"的场景。这里的 request 已被 await 且在 try/catch 内，
      // 也无需补 .catch。
      await request('prompt', { sessionId: childId, text: wrapTask(def, task), cwd: workspacePath, behavior: 'steer', mode: def.mode })
    } catch (error) {
      // 创建会话的失败原因（requestOk 抛出的 sidecar 文案）先写进子代理自己的槽，
      // finishSubRun 会把 slotFor(childId).reply 汇总进父槽的 subRuns ——
      // 否则用户只知道"失败了"，不知道为什么。
      patchSlot(childId, { reply: error instanceof Error ? error.message : '子代理启动失败' })
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
    // D-D（外部审计 P2）：已关闭/已删除的会话不得复活成"新会话"幽灵标签。
    // 触发路径：set_model / set_thinking 的 await 之后才 remember（:1382/:1383/:1399），
    // 若 await 期间用户关掉了这个标签，patchSlot 会因 closedIds 拒绝写槽位，但
    // remember 只动 sessions 数组 —— 于是一个没有会话文件、点开即空的标签凭空出现。
    // 合法路径都先 markSlotOpen（它会从 closedIds 里删掉该 id）再 remember：
    // :1498→:1507（重启重绑）、:1944→:1961（selectSession）、:2249→:2285（dispatchTurn）。
    // 子代理 id（:717/:724）与 fork 出来的新 id（:2480）从不进入 closedIds，不受影响。
    if (closedIds.has(id)) return
    const now = Date.now()
    if (!sessions.some((item) => item.id === id)) sessions = [{ id, title: '新会话', time: '刚刚', createdAt: now, modifiedAt: now, ...patch }, ...sessions]
    else sessions = sessions.map((item) => (item.id === id ? { ...item, ...patch, modifiedAt: now } : item))
  }

  function ensureActiveId() {
    if (!activeSessionId) {
      activeSessionId = nextSessionId()
      activeSession = '新会话'
    }
    return activeSessionId
  }

  // modelKey/modelGroups/modelChoice/thinkingChoice/sessionMode 已抽到 app-models.ts（0-5 批次 A）

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

  // projectName 已抽到 app-files.ts（0-5 批次 A）

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
    return workspacePath === '.' ? '选择工作区' : workspaceBase(workspacePath)
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
    // 缺陷 7 的对称化（外部审计 P2）：归档后会话从侧栏消失，此时若它还在运行，180s
    // 看门狗与 40ms drain 定时器都会带着句柄残留，且用户已无法从列表点进它。
    // 与 deleteSession 同样处理：先 abort（并记下世代），再统一 teardown。
    if (activeSessionId === session.id) sessionEpoch.bump()
    if (slotFor(session.id).running) {
      runEpoch.markAborted(session.id)
      if (sidecarReady) await request('abort', { sessionId: session.id }).catch(() => {})
      teardownRun(session.id)
      patchSlot(session.id, { running: false, phase: 'idle', activeTurnId: undefined, steer: [] })
    }
    // 注意**不** markSlotClosed：归档是可撤销的，取消归档后同一 id 还要能用；
    // 只有 closeTab / deleteSession 才真正封禁。
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

  /**
   * 运行相关的统一清理（外部审计缺陷 7：closeTab 有、deleteSession 没有）。
   *
   * deleteSession 原先只删 `runState[id]` + 清 provider 暂存，缺三样：
   *   ① clearRunWatchdog —— 180s 定时器句柄与条目永久残留；
   *   ② clearDrainTimer —— 40ms 队列 drain 定时器可能正好在删除后触发；
   *   ③ 运行世代 forget —— 泄漏且可能污染后续同 id 复用；
   * 且 `activeTurnId` 未清会留下"槽位已删但回合仍在跑"的不一致。
   * 关标签、删除、归档、abort 全部走这里，保证四者对称。
   */
  function teardownRun(id: string) {
    clearRunWatchdog(id)
    clearDrainTimer(id)
    clearProviderError(id)
    runEpoch.forget(id)
    runEpoch.clearSuperseded(id)
  }

  async function deleteSession(session: { id: string; title?: string; file?: string }, skipConfirm = false) {
    sessionMenu = null
    if (!skipConfirm) {
      const ok = await confirm(`确定永久删除会话「${session.title}」吗？删除后无法恢复。`, { title: '删除会话', kind: 'warning' })
      if (!ok) return
    }
    if (activeSessionId === session.id) sessionEpoch.bump()
    // D-C（外部审计 P2）：deleteSession 原先只 abort、不记中止世代 —— 与 closeTab/
    // archiveSession 不对称。窗口： abort 会让 SDK 随后发出 agent_end + agent_settled，
    // 而 markSlotClosed 要到下面的 await 之后才执行；这段时间里槽位既没进 closedIds、
    // 又从未 markAborted、running 仍为真 ⇒ 迟到的终态事件会被当成正常收尾完整提交：
    // running 归零、会话被标记 'done'、还会弹"任务已完成"通知。
    // 这里按 closeTab 的形状补齐：先记世代（挡住迟到终态），再把槽位收回并清掉
    // activeTurnId，使 :586 的 `!running && !activeTurnId` 早退生效。
    const wasRunning = slotFor(session.id).running
    if (wasRunning) {
      runEpoch.markAborted(session.id)
      patchSlot(session.id, { running: false, phase: 'idle', activeTurnId: undefined, steer: [] })
    }
    if (wasRunning && sidecarReady) await request('abort', { sessionId: session.id }).catch(() => {})
    const response = await requestRaw('delete_session', { sessionId: session.id, file: session.file })
    if (!response.ok) {
      window.alert(response.error || '删除会话失败')
      return
    }
    // 先登记为已关闭，再删槽位 —— 中间到达的在途事件不会再复活它（缺陷 3）。
    markSlotClosed(session.id)
    const rest = sessions.filter((item) => item.id !== session.id)
    sessions = rest
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
    // 关闭当前会话即作废：正在飞行中的 open_session 响应可能把已关闭的会话
    // 复活回 runState（它只在最后一步查 activeSessionId，而那时可能还没变）。
    // 但**不能无条件 bump** —— 关一个后台标签会连带作废当前会话正在加载的历史：
    // selectSession 在 await 期间 activeSessionId 已指向新会话，epoch 被顶掉后
    // 新会话的历史就不再落库（切过去一片空白），重启后的重绑循环也会被整体中止。
    const closingActive = activeSessionId === session.id
    if (closingActive) sessionEpoch.bump()
    if (slotFor(session.id).running) {
      // 记下被中止的世代：旧回合的终态事件随后会迟到（缺陷 1），不能被当成
      // 当前回合的收尾。这里与 stop() 的语义一致。
      runEpoch.markAborted(session.id)
      if (sidecarReady) await request('abort', { sessionId: session.id }).catch(() => {})
    }
    if (sidecarReady) await request('close_session', { sessionId: session.id }).catch(() => {})
    // 先封禁再删槽位：await 期间到达的事件不得复活这个已关闭的会话（缺陷 3）。
    markSlotClosed(session.id)
    const rest = sessions.filter((item) => item.id !== session.id)
    sessions = rest
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
    void selectSession(session).then(() => { composerRef?.openModelMenu() })
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

  function toggleMore() {
    moreOpen = !moreOpen
    // 0-5 批次 C：composer 五菜单随组件走，经 ref 关闭。
    if (moreOpen) composerRef?.closeMenus()
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

  async function setMode(mode: string) {
    // 0-5 批次 C：菜单态随 Composer 组件走；这里只保留分派桥（runSlashCommand /set-mode-plan 用）。
    if (!mode) return
    const id = ensureActiveId()
    remember(id, { mode })
    if (!sidecarReady || !sessions.some((item) => item.id === id && item.file)) return
    await request('set_mode', { sessionId: id, mode })
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
    // F4（终态兜底）：组件销毁时必须撤销所有兜底计时器。撤销路径原先只挂在
    // clearProviderError 上（关标签/收尾/中止都会走到），但组件销毁时这些都不必然发生 ——
    // 遗留的 window.setTimeout 回调会在已销毁的组件上跑 finishRun，往 runState 里写回
    // 一个永远不会被渲染的槽位，并可能触发一次 desktopNotify。
    settleArbiter.cancelAll()
    window.removeEventListener('resize', clampToViewport)
    if (typeof document !== 'undefined') document.body.classList.remove('resizing')
  })

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

  // 与 request() 的唯一差别：ok:false 不再被吞成 null，而是把 sidecar 的错误文案抛出。
  // 背景（「永久 Thinking」根因）：request() 把失败折叠成 null 且永不 reject，
  // dispatchTurn 前奏（create_session/set_model/prompt）外层的 .catch 因此不可达 ——
  // sidecar 报「会话不存在或已关闭」时槽位卡死在 running/Thinking，只能等看门狗兜底。
  // 凡是"失败必须让用户看见"的调用链都改用本函数，让 catch 拿到真实文案交给 finishRun。
  async function requestOk(type: string, payload = {}) {
    const response = await sendRequest(type, payload)
    if (!response.ok) throw new Error(response.error || `请求「${type}」失败`)
    return response.result
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
    abortRunningRuns('Pi Agent 侧车已重启，本次运行被中止。会话文件仍在，可继续对话。')
    sidecarReady = true
    void composerRef?.refreshCtx()
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
      // 重连期间用户可能已经关掉/删掉这个会话：它已不在 sessions 里，写回去会凭空
      // 造出一个没人持有的槽。**只能跳过这一个，绝不能因切换而 break** —— 切换标签
      // 同样会推进代数，而重连的职责恰恰是把**所有**会话重新绑回 sidecar；中途放弃
      // 会让剩下那些会话的 file 与 sidecar 内存态脱钩，下次发送静默新建文件、丢掉历史
      // （正是本函数存在要防的那件事）。
      if (!sessions.some((item) => item.id === session.id)) continue
      // 这个 id 仍在会话列表里（用户可见的标签/行）→ 必须解除 closedIds 封禁，
      // 否则下面所有 patchSlot 写入都会被静默丢弃，会话重绑等于没做。
      // 位置放在成员资格检查**之后**：真正已被关闭/删除的 id 不该在这里复活。
      markSlotOpen(session.id)
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
        const message = String(payload.message ?? 'Pi Agent 侧车已停止运行，请重启应用。')
        for (const [id, settle] of pending) {
          settle({ type: 'response', id, ok: false, result: null, error: message })
        }
        pending.clear()
        // sidecar 已被放弃自动重启 → 之后**永远不会有** agent_settled。
        // 此前只 fail 了 pending 请求，running 槽与看门狗都留着：若看门狗恰好
        // 已被 auto_retry_*/compaction_* 心跳续期，界面就会永久停在 Thinking。
        abortRunningRuns(message)
        window.alert(message)
      }
      if (payload.type === 'confirm_request') {
        const confirmSessionId = payload.sessionId || activeSessionId
        patchSlot(confirmSessionId, { phase: 'waiting', confirm: { confirmId: String(payload.confirmId ?? ''), toolName: String(payload.toolName ?? ''), summary: String(payload.summary ?? '') } })
        // D-B：通知里带上会话名 —— 后台会话的确认不会渲染在主区域（另有 pendingConfirms
        // 浮动面板兜底），通知是用户切走期间唯一的线索。
        if (loadPrefs().notifyConfirm) {
          const title = sessions.find((item) => item.id === confirmSessionId)?.title
          desktopNotify('Pi-My', title ? `「${title}」需要确认工具调用` : '需要确认工具调用')
        }
      }
      // 扩展 UI 请求（0-4）：select / input / editor / confirm。
      // 必须响应，否则扩展的 await 会永久挂住（整个 agent 卡住）。
      if (payload.type === 'ui_dialog_request') {
        // D-F：入队而不是整体覆盖。只有队首（用户即将看到的那个）才用 prefill
        // 初始化输入框 —— 后面排队的对话框等成为队首时再由 answerExtDialog 重置。
        const dialog: ExtDialog = {
          dialogId: String(payload.dialogId ?? ''),
          kind: String(payload.kind ?? 'input') as ExtDialog['kind'],
          title: String(payload.title ?? ''),
          message: payload.message ? String(payload.message) : undefined,
          options: Array.isArray(payload.options) ? payload.options.map((item: unknown) => String(item)) : undefined,
          placeholder: payload.placeholder ? String(payload.placeholder) : undefined,
          prefill: payload.prefill ? String(payload.prefill) : undefined,
        }
        const wasEmpty = extDialogs.length === 0
        extDialogs = [...extDialogs, dialog]
        if (wasEmpty) extDialogValue = dialog.prefill ?? ''
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
      // D-F：无论是否回落成默认值，都要把该对话框从队列里摘掉 —— 否则一个已经
      // 超时作废的对话框会永远卡在队首，把后面所有排队的请求全部挡住。
      if (payload.type === 'dialog_expired') {
        const expiredId = String(payload.dialogId ?? '')
        if (expiredId) {
          const nextQueue = extDialogs.filter((item) => item.dialogId !== expiredId)
          if (nextQueue.length !== extDialogs.length) {
            extDialogs = nextQueue
            extDialogValue = nextQueue[0]?.prefill ?? ''
          }
        }
        if (payload.fallback === 'default') {
          const kindLabel = payload.kind === 'confirm' ? '确认框' : payload.kind === 'select' ? '选择框' : '对话框'
          const text = `扩展${kindLabel}超时未回答，已按默认值继续`
          extToasts = [...extToasts, { id: `t${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, text, type: 'warning' }].slice(-3)
          window.setTimeout(() => { extToasts = extToasts.slice(1) }, 6000)
        }
      }
      // 扩展要求把文本放进输入框（pasteToEditor / setEditorText）
      if (payload.type === 'ext_editor_text') {
        inputText = String(payload.text ?? '')
        composerRef?.focusInput()
      }
      // 1-5 批次②：扩展运行错误（bindExtensions onError 通道）——之前扩展崩了用户毫无感知。
      // 用现有 extToasts 展示，danger 色；不中断会话（ext_error 是非致命事件）。
      if (payload.type === 'ext_error') {
        const extName = String(payload.extensionPath ?? '').split(/[\\/]/).pop() || '未知扩展'
        const text = `扩展出错（${extName}）：${String(payload.error ?? '未知错误')}`
        extToasts = [...extToasts, { id: `t${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, text, type: 'error' }].slice(-3)
        window.setTimeout(() => { extToasts = extToasts.slice(1) }, 8000)
      }
      // 1-5 批次②：扩展 setStatus 桥接 —— 转成一条 slot:'status' 的插件消息进状态槽。
      // 同一 key 覆盖旧值；text 为空 = 清除该键。会话隔离：只更新发起会话自己的状态。
      if (payload.type === 'plugin_status') {
        const sessionId = String(payload.sessionId ?? activeSessionId)
        const statusKey = String(payload.key ?? '')
        if (statusKey) {
          const slot = runState[sessionId]
          const base = slot?.pluginMessages ?? []
          const kept = base.filter((m) => !(m.slot === 'status' && m.title === statusKey))
          if (String(payload.text ?? '') !== '') {
            const normalized = normalizePluginMessage({
              customType: 'ui.plugin',
              display: { slot: 'status', component: 'text', title: statusKey, body: String(payload.text ?? ''), tone: 'accent' },
            })
            if (normalized) {
              normalized.entryId = `status-${sessionId}-${statusKey}`
              normalized.timestamp = Date.now()
              patchSlot(sessionId, { pluginMessages: [...kept, normalized] })
            }
          } else {
            patchSlot(sessionId, { pluginMessages: kept })
          }
        }
      }
      // 1-5 批次②：扩展 setTitle 桥接 —— 暂存到会话槽位，标题栏/标签展示用。
      if (payload.type === 'plugin_title') {
        const sessionId = String(payload.sessionId ?? activeSessionId)
        const title = String(payload.title ?? '').slice(0, 200)
        if (title) patchSlot(sessionId, { pluginTitle: title })
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
        if (!id) {
          // Rust 读线程的会话无关诊断（"输出流结束"/"sidecar 已退出"）在从未见过任何
          // sessionId 时会落到这里。没有会话就没有槽位可写，但不能**静默**吞掉——
          // 这正是用户报障时"界面毫无反应"的那类信息。
          //
          // 刻意**不**在这里写 `event.type === 'error'` 形式的筛选：那与归约器分支同形，
          // 会让 source-assert 的 eventConditionTypesOf / eventBlockOf("error") 把这个
          // 入口兜底当成"第一处带花括号的 error 主分支"，从而在错误的块上求值（诱饵分支
          // 防线正是为此存在）。到达这里的只有读线程诊断本身——sidecar 正常事件都带
          // sessionId——所以按类型筛选既无必要，也会牺牲可观测性。
          console.warn('[pi-my] sidecar 诊断（无会话可归属）：', String(event.message ?? event.type ?? ''))
          return
        }
        // 已关闭/已删除的会话不再接受任何事件（缺陷 3 的入口防线）。patchSlot 本身
        // 也会拒绝，但事件涟漪还会调 touchRunWatchdog / markSession / startToolStep，
        // 那些不走 patchSlot，必须在入口就拦掉，否则会重新武装一个无人能停的看门狗。
        if (closedIds.has(id)) return
        // 场景：回合 A 流式中点 Stop，紧接着又发了回合 B。A 的终态事件是在 abort
        // 请求飞行期间发出的，会**迟到**；而 SDK 的事件不带回合身份。若放行，它们
        // 会把新回合 B 当成已结束（缺陷 1：running 归零、半截回复被提交成终态，
        // 之后 B 的 text_delta 再也进不了 timeline，因为 finishRun 会早退）。
        // 判据：abort 之后是否又派发过新一轮 —— sidecar 的 serialChain 保证 abort
        // 请求在下一轮 prompt 之前完成，所以此刻到达的非 agent_start 事件必属旧轮。
        // 标记只在**新一轮真正开始**（agent_start）时解除，不能在这里消费：
        // 一次失败会连发 agent_end + agent_settled 两条终态事件，提前消费会让第二条
        // 被误当成当前轮的收尾，缺陷照旧。
        // D-A（外部审计 P1）：preflight 阶段（模型校验/鉴权/自动压缩/扩展钩子）点"停止"
        // 是**无效**的 —— SDK 的 `agent.abort()` 只对已建立的 activeRun 生效
        //（pi-agent-core/dist/agent.js:218-220 `this.activeRun?.abortController.abort()`），
        // 而那时 activeRun 还不存在；这一轮随后照常进入 loop，并无条件发 `agent_start`
        //（agent-loop.js:50 是 runAgentLoop 的第一条 emit，之前没有任何 signal 检查）。旧代码在下面 agent_start 分支
        // 里无条件 `patchSlot({running:true})`，把用户刚按下的停止原样撤销；而
        // activeTurnId 已被 stop() 清空 ⇒ 此后所有回合判据恒真，用户只能等 180s
        // 看门狗超时，还被归因成"模型超过 3 分钟没有返回"。
        // 判据必须在下面 `clearSuperseded` **之前**取：它会把 abortedAt 删掉。
        const startedButAborted = event.type === 'agent_start' && runEpoch.isAborted(id)
        // D-A 残留（Lead 复现）：这里**只在本轮不是"被停掉的那一轮"时才解标记**。
        // 原先无条件 `if (event.type === 'agent_start') clearSuperseded(id)` 让下面早退
        // 分支注释里"标记要留着拦住这一轮随后迟到的 agent_end/agent_settled"变成空话：
        // 早退后 running 仍为假、activeTurnId 仍为空，用户随即再发一条 ⇒ dispatch 推进到
        // 新一代、running 重新为真；此时旧轮迟到的 agent_end 因为标记已被删而不算
        // superseded，被放行 → isTurnCurrent(新回合, undefined) 恒真且 running 为真 ⇒
        // 旧轮终态把新回合完整收尾打死（探针实测：`旧轮终态提交收尾，新轮被打死`）。
        // 保留标记则 dispatch 后 `current > aborted` 成立 ⇒ 旧轮终态被正常丢弃；
        // 而**新一轮自己的 agent_start** 到达时 startedButAborted 为假，依旧会解标记，
        // 新轮事件照常流动（这条清除不能省：isSuperseded 判的正是 current > aborted，
        // 不解标记会把新轮自己的全部事件当成旧轮丢掉）。
        if (event.type === 'agent_start' && !startedButAborted) runEpoch.clearSuperseded(id)
        else if (runEpoch.isSuperseded(id)) {
          // 例外：sidecar 的 type:'error'（PI/sidecar/index.mjs:1744，prompt 的 .catch）
          // 绝不能在此静默丢弃。标记被武装 = 新一轮还没发出 agent_start，而新一轮**在
          // agent_start 之前**失败时（无模型 / 鉴权失败 / 压缩进行中 / 扩展在
          // emitBeforeAgentStart 里抛错）恰恰只会发出这一条 error —— 丢掉它，前端就
          // 永远等不到解标记的消息：running 卡在 true，180s 看门狗给出错误归因，且此后
          // submit 会走 steer 分支、再也不经 dispatchTurn，于是 agent_start 永不到来，
          // 会话彻底卡死（外部审计缺陷 4）。
          // 放行它的代价可控：标记仍武装 ⇒ 新一轮尚未开始，迟到的旧轮终态事件（agent_end
          // / agent_settled）依旧被拦住，不会把新轮误判为结束。
          if (event.type !== 'error') return
        }
        // 自动重试的心跳不算"有进展"：否则 auto_retry_start/end 会不断续期看门狗，
        // 一个反复失败又反复重试的模型可以让界面永远停在 Thinking。
        //
        // 「退避 sleep 期间兜底与看门狗同时失效」这台账已核过（第六轮审查提出）：
        // 跳过 touchRunWatchdog **不等于**撤销看门狗 —— touch 是先清后设，跳过只是不续期，
        // 此前 agent_end（willRetry 分支）刚设下的那把 180 s 计时器仍然活着，且那时
        // running 仍为真，到点必然收尾。同时事件入口的 settleArbiter.cancel 只取消 8 s 兜底，
        // 而下一个 message_end/turn_end 一旦再带错误就立刻重新武装。故缺口上界是
        // min(退避时长, 上一次真实事件起算的 180 s)：默认 maxRetries=3 ⇒ 退避 2/4/8 s，
        // 远小于看门狗。真要让退避超过 180 s，需要用户把 maxRetries 调到 6 次以上
        // （retryDelayMs 的 60 s 上限），那已属显式配置而非默认路径，不另设防线。
        if (event.type !== 'auto_retry_start' && event.type !== 'auto_retry_end') touchRunWatchdog(id)
        // F4（终态兜底）：任何一条真实事件都说明事件链还活着，撤销兜底计时器。
        // 放在这里而非事件分派之后是刻意的：紧随其后的 message_end/turn_end 若带 provider
        // 错误，setProviderError 会立刻重新武装；若不带（正常结束）则保持撤销状态。
        // 这样 auto_retry_start（SDK 先发事件再睡退避）与 compaction_start（压缩期间的长静默）
        // 都会自动解除兜底，不会误判成"终态事件丢了"。
        settleArbiter.cancel(id)
        // provider 失败时 SDK 不发 type:'error'，只给一条 stopReason:'error' 的 assistant
        // 终态消息。这里先暂存，等**真正的终态**（agent_end 且不重试 / agent_settled）再报。
        // 正常结束时 assistantErrorFrom 返回空串，会顺手清掉上一次的暂存，避免误报。
        if (event.type === 'message_end' && (event.message as { role?: string })?.role === 'assistant') {
          setProviderError(id, assistantErrorFrom(event.message))
        }
        if (event.type === 'turn_end') setProviderError(id, assistantErrorFrom(event.message))
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
          endToolStep(id, String(event.toolName || '工具'), String(event.toolCallId || ''), toolResultBrief(event.result, String(event.toolName || '')), Boolean(event.isError))
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
        if (event.type === 'agent_start') {
          // D-A：这一轮在 preflight 阶段就被用户停过（上面的 startedButAborted）。
          // 停止必须作数：此刻 agent_start 已到达，说明 `agent.activeRun` 已经建立
          //（agent.js:341-350 在 `:355 await executor(signal)` 之前就赋了 activeRun），**补发一次 abort
          // 是有效的** —— 这正好补上 preflight 期那次空操作。然后不 markThinking、
          // 不把 running 打回 true、不 markSession。
          // D2（外部对抗性审查确证回归）：这里**不能** clearRunWatchdog 把它拆掉。
          // :1741 刚为这个事件重新武装了 180s 看门狗；若补发的 abort 因 IPC 失败或
          // sidecar 悬挂而丢失，stop() 的 `.then` 永不落地，而唯一还能自救的兜底就是
          // 这个看门狗。touchRunWatchdog 在 running 已为假时是空转（回调首行
          // `if (!slotFor(id).running) return`），running 仍为真时则会给出真正的超时
          // 反馈 —— 两种情况都不会误报，因此比直接拆掉严格更安全。
          // 也不在此 clearSuperseded：标记要留着拦住这一轮随后迟到的终态事件（它们会走
          // finishRun，但那时 running 已为假、activeTurnId 已为空，:601 会早退，因此
          // 不会误报"任务已完成"）。下一次 dispatch 会推进世代，标记自然失效。
          if (startedButAborted) {
            if (sidecarReady) {
              void request('abort', { sessionId: id }).catch((error) => {
                // 补发中止失败必须可观测：这是"停止没停干净"的唯一线索。
                console.warn('[pi-my] 补发中止失败：', error)
              })
            }
            touchRunWatchdog(id)
            return
          }
          markThinking(id)
          patchSlot(id, { running: true, error: '' })
          markSession(id, 'active')
        }
        // 自动重试状态行（1-7）：SDK 在流中断等场景会自动重试，此前用户只看到"卡住"。
        if (event.type === 'auto_retry_start') {
          patchSlot(id, {
            running: true,
            phase: 'thinking',
            retry: { attempt: Number(event.attempt ?? 0), reason: String(event.errorMessage ?? event.reason ?? '网络波动') },
          })
        }
        if (event.type === 'auto_retry_end') {
          patchSlot(id, { retry: undefined })
          // 重试彻底失败（`success:false`）时 SDK 给出 `finalError`，这是最权威的
          // 失败原因，比从消息里翻更可靠；同时它标志着该次运行即将收尾。
          // 但用户主动 Stop 会打断退避 sleep，SDK 随即发
          // `auto_retry_end{success:false, finalError:"Retry cancelled"}`
          //（agent-session.js:2942 `finalError: "Retry cancelled"`，定义在 :2933-2944，唯一触发点在
          //  :2977 的 _prepareRetry catch —— 用户点 Stop 打断退避 sleep 时触发）—— 那是"用户自己按了停止"，不是 provider 故障，
          // 记下来就会在收尾时弹出莫名其妙的"请求失败"。故此处必须过滤掉。
          if (event.success === false) {
            const finalError = String(event.finalError ?? '')
            // 双重闸门：① 文案过滤（SDK 0.99.1 的 _finishCancelledRetry 在
            // agent-session.js:2933-2944 硬编码 finalError: "Retry cancelled"，所以现在必然命中），
            // ② 回合被用户中止过（stop() / closeTab / deleteSession / archiveSession 里的
            // runEpoch.markAborted）。只靠 ① 是一条"依赖上游文案字面量"的隐性契约：上游哪天改措辞，
            // 取消就会被当成 provider 故障，经 arm 武装兜底，8 秒后在已经 idle 的槽位上炸出一条
            // 假"请求失败"。② 与措辞无关，永远成立。
            // 注意不要把 ② 换成 isSuperseded：后者判的是"已派发更新的世代"，新一轮刚 dispatch
            // 就会为真 —— 那会连带把**新一轮自己的真实失败**也吞掉。isAborted 只认"当前世代就是
            // 被中止的那一代、且之后再没派发"，所以新一轮的真实错误照常显示。
            if (!isCancellationText(finalError) && shouldSurfaceProviderError(finalError, runEpoch.isAborted(id))) setProviderError(id, finalError)
          }
        }
        // 1-2 上下文蒸发：SDK 自动/手动压缩事件（此前透传但被忽略，用户只见"卡住"）
        if (event.type === 'compaction_start') patchSlot(id, { compacting: true, phase: 'thinking' })
        if (event.type === 'compaction_end') patchSlot(id, { compacting: false })
        if (event.type === 'agent_end') {
          // agent_end.messages 是权威终态数据（event-slim 只瘦化 role==='toolResult' 的项，
          // assistant 的 stopReason/errorMessage 原样保留）。在这里再取一次，避免只依赖
          // turn_end 的事件顺序。
          setProviderError(id, assistantErrorFrom(event.messages))
          // Pi SDK 在自动重试/压缩前也会发 agent_end，这时不能提前显示结束。
          // willRetry 为真时**必须保留**暂存的错误文本：下一轮若仍然失败，它就是
          // 最终原因；若下一轮成功，agent_end(willRetry:false) 会携带正常消息并清空它。
          if (event.willRetry) patchSlot(id, { running: true, phase: 'thinking', processOpen: true })
          else finishRun(id, consumeProviderError(id))
        }
        // agent_settled 是 SDK 保证到达的**唯一终态信号**（0.99.1 的
        // `_emitAgentSettled()` 在 agent-session.js:662-672，由 `_runAgentPrompt` 的
        // finally 于 :1344 调用；agent_end 则可能因 willRetry 被跳过）。
        // 它一定会发，因此是兜底：即使前面 agent_end 因 willRetry 被跳过、或压缩
        // 触发了一次 continue，这里也能把 running 收回并显示真正的失败原因。
        if (event.type === 'agent_settled') finishRun(id, consumeProviderError(id))
        if (event.type === 'turn_end' && slotFor(id).running && !slotFor(id).reply.trim()) patchSlot(id, { phase: 'thinking' })
        if (event.type === 'error') {
          clearProviderError(id)
          // S-1：sidecar 的这条 error 是在 prompt 的 .catch 里发的，**整轮不被 await**，
          // 可以晚到（PI/sidecar/index.mjs 的 prompt 处理器）。若期间已派发了新回合，
          // 不传回合身份就会把上一轮的错误写到新回合上（红条闪现）。sidecar 已把请求
          // 里的 turnId 回显到事件上，这里原样当作 expectedTurnId 用 —— 旧 sidecar 不带
          // 该字段时为 undefined，退回原先"一律放行"的语义。
          finishRun(id, String(event.message || 'Agent 请求失败'), (event as { turnId?: string }).turnId)
        }
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
      // 批次③：拉取一次项目信任态（含扩展声明的沙箱渲染器数量），失败不阻塞启动。
      // 信任真值在 sidecar（resolveProjectTrust），这里只缓存给渲染门控用。
      try {
        const trust = await request('list_ui_renderers', {}) as { trusted?: boolean } | null
        setProjectTrusted(trust?.trusted !== false)
      } catch { setProjectTrusted(true) }
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
      void composerRef?.refreshCtx()

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

  // git 面板逻辑已抽到 GitPanel.svelte（0-5 批次 B-1）：gitChanges/diffContent/staged/
  // commitMessage/gitError 状态与 git_status/git_diff/git_add/git_commit/git_push 操作
  // 全部在组件内自持，经 bind: 双向同步；这里只保留父组件侧的驱动入口。
  async function refreshGit(cwd = workspacePath) {
    await gitPanelRef?.refresh(cwd)
  }

  // 0-5 批次 B-5：文档面板逻辑（saveFile/previewFile/readFileChunk/previewLargeFile/
  // documentStats/文件树）已抽到 FilePanel.svelte（状态经 bind: 双向同步，保存成功
  // 经 onSaved 回调驱动 refreshGit，读取失败经 onReadError 写当前会话槽位）。
  async function selectSession(session: Session) {
    if (session.parentId) {
      const run = slotFor(session.parentId).subRuns.find((item) => item.id === session.id)
      viewingSub = run ?? { id: session.id, agent: session.title, task: session.title, status: session.state === 'active' ? 'running' : 'done', reply: slotFor(session.id).reply }
      return
    }
    branchOpen = false
    // T2⑦ 重置必须前置到一切提前 return 之前（子会话分流/open_session 失败/epoch 作废）：
    // 否则上一个会话的编辑清单会残留到新视图，直到晚到的 refreshCtxEdits 才被覆盖。
    ctxEdits = []
    ctxPanelOpen = false
    // 用户显式打开一个会话 = 该 id 重新活跃，必须解除 closedIds 封禁。
    // 缺口背景：markSlotOpen 原先只在 dispatchTurn 里调用，而关闭标签/删除会话后
    // 同一 id 完全可能重新出现在侧栏（remember() 是那 13 个调用点唯一的入口，
    // 例如关闭期间某个在飞的 open_session 回读 mode 走了 `remember(session.id, ...)`，
    // 或 setMode/setModel 抢先落库）。此时点开会话：patchSlot 因为 closedIds 命中而
    // 静默丢弃一切写入 —— 包括 applySessionHistory 的历史和"读取历史会话失败"的错误，
    // 界面永远空白，且只有用户真的在这个会话里再发一条消息（走 dispatchTurn）才解禁。
    markSlotOpen(session.id)
    // 每次切换会话都推进代数：open_session 是慢请求，期间用户可能又切走、
    // 甚至关掉再重开同一个 id。仅比对 id 无法区分"同一 id 的新一代"，
    // 晚到的历史/错误就会落到新状态上（陈旧响应覆盖）。
    const epoch = sessionEpoch.bump()
    activeSessionId = session.id
    activeSession = session.title
    todos = loadTodos(session.id)
    todoDraft = ''
    todoParentId = ''
    if (sidecarReady && session.file) {
      // 传当前会话记录的模式，并以 sidecar 回传的实际模式为准校正 UI。
      // 修复：旧实现不传也不回读 mode，导致"UI 显示计划模式、sidecar 实际是 ask"的失同步。
      const opened = await requestRaw('open_session', { sessionId: session.id, file: session.file, mode: sessionMode(sessions, session.id) })
      // 期间已切走 / 又切了一次 / 会话已被关闭 → 这次响应作废，绝不写回状态。
      if (!sessionEpoch.check(epoch) || activeSessionId !== session.id) return
      if (opened.ok) {
        const result = opened.result as { history?: Array<{ id?: string; role: 'user' | 'assistant'; text: string; timestamp?: number; userIndex?: number; entryId?: string }>; mode?: string }
        applySessionHistory(session.id, result?.history)
        if (result?.mode) remember(session.id, { mode: result.mode })
      } else {
        // 修复：读取失败时明确提示，不再用空历史覆盖成空白页。
        patchSlot(session.id, { error: opened.error || '读取历史会话失败', historyLoaded: false })
      }
    }
    void composerRef?.refreshCtx()
    void refreshCtxEdits(session.id)
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

  function loadImageGenConfig() {
    try { imageGenConfig = { ...imageGenConfig, ...JSON.parse(localStorage.getItem('pdn.imagegen') ?? '{}') } } catch { /* 使用空配置 */ }
  }

  function saveImageGenConfig(next: ImageGenConfig) {
    imageGenConfig = next
    localStorage.setItem('pdn.imagegen', JSON.stringify(next))
  }


  function answerConfirm(ok: boolean, sessionId = activeSessionId) {
    const id = sessionId
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
    // D-F：出队（而不是把全局单值置空），并让下一个排队者的 prefill 接管输入框。
    const rest = extDialogs.filter((item) => item.dialogId !== dialog.dialogId)
    extDialogs = rest
    extDialogValue = rest[0]?.prefill ?? ''
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
      composerRef?.clearMention()
      if (scout[1].trim()) void spawnSubagent('scout', scout[1])
      else { splitOpen = true; agentDefs = loadAgents(); splitRows = [{ agent: 'scout', task: '' }] }
      return
    }
    const agentCmd = text.match(/^\/agent\s+(\S+)\s+(.+)$/i)
    if (agentCmd) {
      inputText = ''
      composerRef?.clearMention()
      void spawnSubagent(agentCmd[1], agentCmd[2])
      return
    }
    const todoCmd = text.match(/^\/todo(?:\s+|$)(.*)$/i)
    if (todoCmd) {
      inputText = ''
      composerRef?.clearMention()
      if (todoCmd[1].trim()) {
        persistTodos([...loadTodos(ensureActiveId()), newTodo(todoCmd[1])])
        panel = '待办'
        showRight = true
      } else { panel = '待办'; showRight = true }
      return
    }
    if (text === '/split') {
      inputText = ''
      composerRef?.clearMention()
      splitOpen = true
      agentDefs = loadAgents()
      return
    }
    const slash = findSlashCommand(text)
    if (slash) {
      inputText = ''
      composerRef?.clearMention()
      // 2-5：取命令词后面的参数（如 /export md 的 "md"）
      const args = text.replace(/^\s*\/\S+/, '').trim()
      runSlashCommand(slash, args)
      return
    }
    const id = ensureActiveId()
    const slot = slotFor(id)
    inputText = ''
    composerRef?.clearMention()
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
        // 与 dispatchTurn 同理：同一毫秒内连发两条插话会撞出重复 key（timeline 以 message.id 为 key）。
        timeline: [...slot.timeline, { id: `user-${nextTurnId()}`, role: 'user', text, at, timestamp: Date.now(), userIndex }]
      })
      // F2（外部对抗性审查）：插话是**新一轮模型调用**，但这条分支既不走 dispatchTurn
      //（那里才会武装看门狗）也不碰 running，于是整条插话路径上没有任何超时兜底 ——
      // 若这次 prompt 的终态事件丢失，界面会带着 running:true 无限停在 Thinking。
      // 这里补一次 touchRunWatchdog，与其它事件一样以 180s 为界。
      touchRunWatchdog(id)
      // S-1 发送侧（外部审计确证缺陷 1）：插话同样是 prompt，同样会在 sidecar 里产生
      // `type:'error'`。不带上 turnId 时 sidecar 回显的就是 undefined，而
      // `isTurnCurrent(X, undefined)` 恒放行 —— 一旦这条 error 晚到（prompt 处理器整轮
      // 不被 await，而 sidecar 的串行链保证不了它与下一轮 dispatch 的先后），它会把
      // **新回合**整个收尾：running 归零、activeTurnId 清空、半截回复被提交成终态。
      // 插话注入的正是当前这一轮，所以回合号直接取 activeTurnId。
      // 顺带补 .catch：原先 `void request(...)` 在 RPC 层失败时会变成未处理的 rejection。
      if (sidecarReady) {
        void request('prompt', { sessionId: id, text, cwd: workspacePath, behavior: 'steer', turnId: slotFor(id).activeTurnId }).catch(() => {})
      }
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
    const activeTurnId = nextTurnId()
    // 新一轮开始：清掉上一轮的 provider 错误暂存，否则它会污染本次运行的结果。
    clearProviderError(id)
    // 推进运行世代（缺陷 1）：从这一刻起，任何"abort 之后才到达的旧轮终态事件"
    // 都能被 event 入口识别并丢弃。
    //
    // ⚠️ 这里**绝不能**顺手 clearSuperseded(id)。曾经的写法是 dispatch + clear 一起做，
    // 理由是"新一轮已经开始，上一轮的标记该解除了"——但派发只是发出了 prompt，旧轮的
    // 终态事件正是在 abort 飞行期间、新一轮 agent_start 之前到达的：提前清掉标记，
    // event 入口的 isSuperseded 在这个唯一该起作用的窗口里恒为 false，旧 agent_end /
    // agent_settled 被当成新回合的收尾（running 归零、activeTurnId 清空、半截回复提交成
    // 终态），之后新回合的 text_delta 因 finishRun 早退再也进不了 timeline —— 正是缺陷 1
    // 的原症状。标记必须活到新一轮真正开始（agent_start），由事件入口解除。
    runEpoch.dispatch(id)
    // 派发即代表这个 id 重新活跃（关闭→重开同一 id 的场景），解除封禁。
    markSlotOpen(id)
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
      // 缺陷 4（外部审计 P1）：这段前奏有多个 await（create_session / read_attachment /
      // vision_describe），期间用户完全可能把标签关掉或删掉会话。原先全程没有存活校验，
      // 于是最后仍然会发出 prompt —— 而 sidecar 的 prompt 处理器当时还会**静默重建会话**
      // 并真跑模型，前端这边却已无标签无槽无看门狗：一个无法查看、无法停止的僵尸运行。
      // sidecar 侧已改为"会话不存在就报错"，这里再补上前端的存活校验作为第一道防线。
      const stillMine = () => isTurnAlive(closedIds.has(id), slotFor(id).activeTurnId, activeTurnId)
      void (async () => {
        const rec = sessions.find((item) => item.id === id)
        if (!rec?.file) {
          const defaults = loadPrefs()
          const rawThinking = rec?.thinking ?? defaults.thinking
          const payload: Record<string, unknown> = { sessionId: id, cwd: workspacePath, mode: rec?.mode ?? defaults.mode }
          if (rawThinking && THINKING_LEVELS.includes(rawThinking)) payload.thinking = rawThinking
          const created = await requestOk('create_session', payload) as { id: string; file?: string }
          if (!stillMine()) return
          if (created?.file) remember(id, { file: created.file })
          const model = sessions.find((item) => item.id === id)?.model
          if (model) {
            const [provider, modelId] = model.split(MODEL_SEPARATOR)
            await requestOk('set_model', { sessionId: id, provider, modelId })
            if (!stillMine()) return
          }
        }
        const extra = [] as typeof pendingFiles
        for (const name of [...text.matchAll(/(?:^|\s)@([^\s]+)/g)].map((item) => item[1])) {
          const hit = files.find((file) => file.kind === 'file' && (file.path === name || fileName(file.path) === name))
          if (!hit || extra.concat(pendingFiles).some((file) => file.name === fileName(hit.path))) continue
          const res = await requestRaw('read_attachment', { cwd: workspacePath, path: hit.path })
          if (!stillMine()) return
          if (res.ok) extra.push(res.result as typeof pendingFiles[number])
        }
        const outgoing = [...pendingFiles, ...extra]
        const bridged = [] as typeof pendingFiles
        for (const file of outgoing) {
          if (file.kind !== 'image' || !file.data) { bridged.push(file); continue }
          try {
            const vision = await request('vision_describe', { data: file.data, mimeType: file.mimeType }) as { skipped?: boolean; description?: string }
            if (!stillMine()) return
            if (vision?.skipped || !vision?.description) bridged.push(file)
            else bridged.push({ kind: 'text', name: `${file.name}.vision.txt`, content: `[视觉桥] ${file.name}\n${vision.description}` })
          } catch {
            bridged.push(file)
          }
        }
        if (!stillMine()) return
        // S-1：把回合身份随 prompt 一起发给 sidecar，它会在 prompt 失败时把 turnId 回显到
        // type:'error' 事件上（sidecar 的 prompt 处理器整轮不被 await，这条 error 可以
        // 晚到）。事件入口据此传给 finishRun 当 expectedTurnId，避免把上一轮的错误
        // 写到新回合上。旧 sidecar 不带该字段 ⇒ 事件上没有 turnId ⇒ 退回旧语义。
        // requestOk：prompt 被 sidecar 拒绝（会话不存在/已关闭、模式不可用等）时
        // 必须抛错，让下面的 .catch 把文案交给 finishRun —— 旧 request() 把 ok:false
        // 吞成 null，这里 await 永远"成功"，槽位卡在 Thinking 直到看门狗兜底（根因）。
        await requestOk('prompt', { sessionId: id, text, cwd: workspacePath, behavior, attachments: bridged, turnId: activeTurnId })
      })()
        .then(() => { if (newTitle) void request('rename_session', { sessionId: id, name: newTitle }) })
        .catch((error) => {
          // 精确回合守卫（审查者 S1）：这条 prompt 的失败只属于**本次派发**。
          // 若 await 期间用户已 Stop 并发了新一条，把错误写到新回合上会误报。
          // 与 finishRun 的世代守卫不同，这里手上的回合身份是明确的，直接比。
          if (!isTurnCurrent(slotFor(id).activeTurnId, activeTurnId)) return
          finishRun(id, error instanceof Error ? error.message : '发送请求失败，请检查 sidecar 是否仍在运行。', activeTurnId)
        })
    } else {
      // sidecar 未就绪：这一轮不会有任何事件回来，必须立刻收掉看门狗定时器 ——
      // 否则它会在 180 秒后把「模型超过 3 分钟没有返回任何结果」的错误盖到界面上。
      clearRunWatchdog(id)
      // 延迟收起运行态（让用户看得见"已发送"），但要确认这一轮没有被更晚的派发取代：
      // 期间用户可能又发了一条，此时无条件置 idle 会把新回合的运行态抹掉。
      window.setTimeout(() => {
        clearRunWatchdog(id)
        if (slotFor(id).activeTurnId !== activeTurnId) return
        // 不仅要收运行态，还要给出可见原因：这一轮根本没有发出去（sidecar 未就绪），
        // 静默回到 idle 会让用户以为消息已送达、对方"读了不回"。
        patchSlot(id, { running: false, phase: 'idle', activeTurnId: undefined, error: 'Pi Agent 尚未就绪，这条消息没有发出。请等待连接恢复后重试。' })
      }, 1400)
    }
  }

  function drainQueue(id: string) {
    const slot = slotFor(id)
    if (slot.running || !slot.queue.length) return
    // CAS 出队：finishRun 里的 40ms 定时器与用户手动 removeQueue/moveQueue 在**时间上**
    // 会交错，纯"读→写"会让已移除的项复活、或同一项被派发两次。
    // ⚠️ 诚实标注（外部审计缺陷 8）：目前读与写之间没有 await，所以 expected 恒等于
    // revision、拒绝分支不可达。它现在的价值是"把意图写成可单测的代码"+"将来 drain
    // 一旦引入 await 立刻生效"，而不是当前就存在的保护 —— 旧注释宣称的"有并发保护"
    // 与事实不符，已改掉。逻辑在 src/session-run.ts 的 planDrain（纯函数，有单测）。
    const expected = slot.queueRevision
    const plan = planDrain(slot.queue, slot.queueRevision, expected)
    if (!plan) return
    patchSlot(id, { queue: plan.queue, queueRevision: plan.revision })
    dispatchTurn(id, plan.text, 'steer')
  }

  // 2-4 队列 CAS：上移/下移/移除都基于读到的 revision 做乐观并发。
  // ⚠️ 与 drainQueue 同理（缺陷 8）：这些函数目前是同步读→算→写，expected 必然等于
  // revision，所以 stale 分支当前**不可达**；这里是留好的并发保护接口，不是既有保护。
  // reorder/remove 额外校验 id 全集，那一层是**当前就生效**的（防止用旧集合复活已移除项）。
  function moveQueue(index: number, dir: -1 | 1) {
    const slot = slotFor(activeSessionId)
    const expected = slot.queueRevision
    const result = casReorder(slot.queue, slot.queueRevision, expected, index, dir, slot.queue.map((item) => item.id))
    if (!result.ok) return
    patchSlot(activeSessionId, { queue: result.value, queueRevision: result.revision })
  }

  function removeQueue(id: string) {
    const slot = slotFor(activeSessionId)
    const expected = slot.queueRevision
    const result = casRemove(slot.queue, slot.queueRevision, expected, id)
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
    // 同 forkAtUserIndex：worktree 分叉也要落盘 + 重扫目录，先把来源会话钉死，
    // 否则失败提示会落到用户分叉期间切到的那个会话上。
    const parentId = activeSessionId
    const parentTitle = sessions.find((item) => item.id === parentId)?.title || '当前会话'
    // 缺陷 6（外部审计 P1）：分叉是慢请求，期间用户完全可能切到别的会话。原先这里
    // 无条件 `activeSessionId = created.id`，会把用户已经切过去的会话**夺走**。
    // 钉住派发时的 epoch，回来时只有"用户没换过会话"才接管。
    const epoch = sessionEpoch.current()
    forkBusy = true
    try {
      const response = await requestRaw('create_worktree_fork', {
        sourceSessionId: parentId,
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
        branchParentId: parentId,
        createdAt: now,
        modifiedAt: now,
      }, ...sessions]
      remember(created.id, { file: created.file, cwd: created.cwd, branch: created.branch, readOnly: false })
      // 分叉本身已经成功（会话已建好、已入列表），只是"是否切换到它"要尊重用户
      // 在这段时间里的操作。没换会话才自动切过去。
      if (activeSessionId === parentId && sessionEpoch.check(epoch)) {
        activeSessionId = created.id
        activeSession = `🌳 worktree · ${parentTitle}`
        patchSlot(created.id, { error: '' })
      }
    } catch (error) {
      patchSlot(parentId, { error: error instanceof Error ? error.message : String(error) })
    } finally {
      forkBusy = false
    }
  }

  async function forkAtUserIndex(userMessageIndex: number) {
    if (forkBusy || !sidecarReady) return
    const slot = slotFor(activeSessionId)
    if (userMessageIndex < 0) return
    // 分叉是慢请求（要落盘 + 重扫目录），期间用户完全可能切到别的会话。
    // 先把来源会话钉死在这里：失败提示必须回到发起分叉的那个会话，
    // 否则 catch 里现读 activeSessionId 会把错误糊到无关会话上。
    const parentId = activeSessionId
    // 缺陷 6（外部审计 P1）：同 forkWorktree —— 分叉回来后不得夺走用户已切到的会话。
    const epoch = sessionEpoch.current()
    forkBusy = true
    try {
      const forkId = nextSessionId()
      const response = await requestRaw('fork_session', {
        sourceSessionId: parentId,
        sessionId: forkId,
        userMessageIndex,
        position: 'before'
      })
      if (!response.ok) throw new Error(response.error || '创建分支失败')
      const created = response.result as { id: string; file?: string; parentFile?: string; cwd?: string; selectedText?: string; history?: Array<{ id?: string; role: 'user' | 'assistant'; text: string; timestamp?: number; userIndex?: number; entryId?: string }> }
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
      // 分支会话已经建好了（无论用户看的是哪个会话，它都在列表里）；只有"用户这段
      // 时间没换过会话"才把它推上前台并注入它的历史。否则只入列表，不动视图 ——
      // 否则会把用户的输入框内容、branchOpen 状态、焦点一次性抢走。
      if (activeSessionId === parentId && sessionEpoch.check(epoch)) {
        activeSessionId = created.id
        activeSession = `分支 · ${parentTitle}`
        branchOpen = false
        patchSlot(created.id, { sent: previousMessages })
        applySessionHistory(created.id, created.history)
        inputText = created.selectedText || ''
        window.setTimeout(() => composerRef?.focusInput(), 0)
      }
    } catch (error) {
      // 写回发起分叉的那个会话，不是"此刻用户可能已经切到的"会话。
      patchSlot(parentId, { error: error instanceof Error ? error.message : String(error) })
    } finally {
      forkBusy = false
    }
  }

  // 返回 Promise 是为了缺陷 12：撤回重发必须在 abort **真正完成之后**才能剪辑时间线，
  // 否则被中止的那一轮迟到的 text_delta 会继续追加进"重发后"的时间线。
  function stop(): Promise<void> {
    const id = activeSessionId
    // 用户主动中止：必须丢掉暂存的 provider 错误，否则 abort 之后收尾时
    // 会把"上一次失败的 provider 错误"当成这次的结果报给用户（误报）。
    clearProviderError(id)
    // 缺陷 11（外部审计 P2）：原先 stop() 只把 running/phase 打回，activeTurnId
    // 与 steer[] 都留着 —— 于是"停止后立刻再答确认框/再插话"时旧回合身份还在，
    // 下一次 dispatchTurn 生成的新回合无法与它区分；队列里的插话也一直显示为
    // 待发送。这里一并清干净。
    // 缺陷 2：40ms 的 drain 定时器必须一起撤销 —— 否则刚 Stop 就又静默把队列里的
    // follow-up 派发出去，而上一轮尾部还在往 reply 缓冲区追加，一条完整回答被拆成
    // 两个气泡。
    clearDrainTimer(id)
    // 标记"本轮已被中止"：从这一刻起到达的终态事件属于被打断的那一轮，若期间又
    // 派发过新一轮（runEpoch.dispatch），事件入口会靠它把旧轮终态丢掉（缺陷 1）。
    // 前面加 running 守卫与 closeTab/deleteSession/archiveSession 三处对齐：对已经
    // 收尾的槽位按 Stop（重复点击、按钮与事件竞态）会给**当代**凭空打上中止标记，
    // 此后到下一轮 dispatch 之前，这一代任何经 shouldSurfaceProviderError 的真实
    // provider 错误都会被静默吞掉 —— 那正是本次修复要根除的"没有反馈"。
    if (slotFor(id).running) runEpoch.markAborted(id)
    // D1（外部对抗性审查确证回归）：停止必须**立刻**反映到界面上。此前这里只记世代
    // 标记、不动 running，于是 abort 回执落地前（SDK 的 abort() 要 `await
    // waitForIdle()`，见 agent-session.js:1841-1858 的 abort()/waitForIdle()，回执必然很晚）用户在同一个会话
    // 再回车，submit() 会命中 :2487 的 steer 分支：它只发 prompt、**不调用
    // dispatchTurn**，因此世代不推进（仍停在被中止的世代）。等 SDK 因
    // `hasQueuedMessages()` 为真而 `continue()` 去服务那条插话时
    //（agent-loop.js:68 是 runAgentLoopContinue 的第一条 emit），事件入口的 `startedButAborted` 判为真
    // ⇒ 走 :1957 早退，把**用户刚发的那一轮**补发 abort 杀掉：消息丢了、没有回复。
    // 乐观清空 running/activeTurnId 后，下一次提交会走 dispatchTurn 推进世代，
    // 被停掉的旧轮终态由 isSuperseded 拦下，新轮的 agent_start 正常流动。
    patchSlot(id, { running: false, phase: 'idle', activeTurnId: undefined, steer: [] })
    if (!sidecarReady) {
      clearRunWatchdog(id)
      return Promise.resolve()
    }
    // S-4（外部审计疑点）：`.then` 里原先零守卫 —— 若 abort 回执飞行期间用户又派发了
    // 新一轮（runEpoch.dispatch 推进世代、槽位写入新的 activeTurnId），旧 stop 的收尾会
    // 把新回合打回 idle 并拆掉它的看门狗。这里在发请求前钉住世代与回合身份，回执到达
    // 时若已被取代就什么都不做（新回合自己管自己的收尾）。
    // 注意快照取在上面那次乐观清空**之后**：此刻 activeTurnId 已被清成 undefined，
    // 于是"期间有人派发过新一轮"就表现为 turnId 被写成新值，守卫照样命中。
    const generation = runEpoch.generationOf(id)
    const turnId = slotFor(id).activeTurnId
    return request('abort', { sessionId: id }).catch(() => undefined).then(() => {
      if (runEpoch.generationOf(id) !== generation) return
      if (slotFor(id).activeTurnId !== turnId) return
      clearRunWatchdog(id)
      // 退避 sleep 期间点 Stop 时，SDK 的 `auto_retry_end{finalError:"Retry cancelled"}`
      // 是在 abort 请求**飞行途中**才到达的，入口那次 clear 拦不住它 —— 所以收尾这里
      // 再清一遍，并显式把 error 写空：patchSlot 是浅合并，漏掉这个字段会保留旧值，
      // 让"请求失败"红条留在界面上。
      clearProviderError(id)
      patchSlot(id, { running: false, phase: 'idle', tool: '', processOpen: false, confirm: undefined, error: '', activeTurnId: undefined, steer: [], process: settleStepsForFinish(slotFor(id).process) })
    })
  }

  function quickPrompt(text: string) {
    inputText = text
    composerRef?.focusInput()
  }

  async function newSession() {
    if (!sidecarReady) {
      const draftId = nextSessionId()
      activeSession = '新会话'
      activeSessionId = draftId
      sessions = [{ id: draftId, title: '新会话', time: '刚刚' }, ...sessions]
      leftTab = 'Chats'
      return
    }
    const id = nextSessionId()
    const defaults = loadPrefs()
    const thinking = THINKING_LEVELS.includes(defaults.thinking) ? defaults.thinking : undefined
    const payload: Record<string, unknown> = { sessionId: id, cwd: workspacePath, mode: defaults.mode }
    if (thinking) payload.thinking = thinking
    // 缺陷 B1（外部审计）：`create_session` 是慢请求（要落盘 + 让 SDK 建会话）。期间
    // 用户完全可能点开别的会话或再点一次「新建」—— 原先这里无条件把 activeSessionId
    // 抢过来，会把用户刚切到的会话顶掉，且新会话列表里凭空多一个空壳。钉住 epoch，
    // 回来时确认用户还停在我们发起时的那个会话上。
    const epoch = sessionEpoch.current()
    const startedFrom = activeSessionId
    let created: { id: string; file?: string }
    try {
      // requestOk：create_session 被拒（会话目录不可写/sidecar 异常/超时）必须让
      // 用户看见 —— 旧 request() 吞成 null 后 `created.id` 抛 TypeError，
      // 变成一个无人处理的 rejection，界面上什么都不发生。
      created = await requestOk('create_session', payload) as { id: string; file?: string }
    } catch (error) {
      patchSlot(activeSessionId, { error: error instanceof Error ? error.message : '新建会话失败' })
      return
    }
    const now = Date.now()
    if (!sessionEpoch.check(epoch) || activeSessionId !== startedFrom) {
      // 用户已经走开了：会话仍然建好并入列表（否则它会在磁盘上但没有标签），
      // 只是不抢焦点。这也是"再点一次新建"的正常结果。
      sessions = [{ id: created.id, title: '新会话', time: '刚刚', thinking, mode: defaults.mode, file: created.file, createdAt: now, modifiedAt: now }, ...sessions]
      return
    }
    activeSessionId = created.id
    activeSession = '新会话'
    sessions = [{ id: created.id, title: '新会话', time: '刚刚', thinking, mode: defaults.mode, file: created.file, createdAt: now, modifiedAt: now }, ...sessions]
    leftTab = 'Chats'
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
    // 压缩期间用户可能已经切走：这条请求是慢操作（要写入新文件），
    // 绝不能因为它的返回把界面强行拉回旧会话 —— 只有仍停在原会话时才刷新。
    if (activeSessionId !== id) return
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
          <div class="chat-title"><h1>{runState[activeSessionId]?.pluginTitle || activeSession}</h1><p><span class="online-dot" class:offline={!sidecarReady}></span> Pi Agent · {workspaceBase(workspacePath)}</p></div>
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

        <div class="messages" class:centered={activeSessionIdle} data-diagerr={String(slotFor(activeSessionId).error ?? '<nil>').slice(0, 50)} data-diagact={activeSessionId.slice(0, 8)} data-diagmap={Object.entries(runState).map(([k, v]) => `${k.slice(0, 8)}:${v.error ? 'E' + v.error.length : '-'}:${v.running ? 'R' : '-'}`).join(',')} data-diagtl={String((runState[activeSessionId]?.timeline ?? []).length)} data-diaglast={String((runState[activeSessionId]?.timeline ?? []).slice(-1)[0]?.text ?? '-').slice(0, 20)} data-diagidle={String(activeSessionIdle)}>
          {#if imageGenError}<div class="imagegen-error">{imageGenError}</div>{/if}
          {#if imageGenResult}<div class="image-result"><img src={imageGenResult.src} alt={imageGenResult.prompt} /><small>{imageGenResult.prompt}</small></div>{/if}
          {#if activeSessionIdle}
            <div class="empty-state">
              <div class="empty-mark"><img src={logoUrl} alt="Pi-My" /></div>
              <button class="start-project" type="button" on:click={() => void chooseWorkspace()}><Icon name="home" size={13} /><span>{workspaceBase(workspacePath)}</span><Icon name="chevron-down" size={11} /></button>
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
                  <div class="user-meta"><time>{message.at}</time><button class="recall" type="button" on:click={() => void copyText(message.text)}>复制</button><button class="recall" type="button" on:click={() => recallMessage(message.userIndex)}>撤回重发</button>{#if message.entryId}<button class="recall ctx-remove" type="button" disabled={!!ctxEditBusyId || slotFor(activeSessionId).running} title={editedEntryIds().has(message.entryId) ? '该条目已有上下文编辑（再剔一次以最新编辑为准）' : '从模型上下文中剔除这条消息'} on:click={() => void removeContextEntry(message.entryId!)}>{ctxEditBusyId === message.entryId ? '处理中…' : editedEntryIds().has(message.entryId) ? '已剔除' : '剔除上下文'}</button>{/if}</div>
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
                    {#if message.entryId}
                      <button class="assistant-action" class:ctx-edited={editedEntryIds().has(message.entryId)} type="button" title={editedEntryIds().has(message.entryId) ? '该条目已被剔除出模型上下文' : '从模型上下文中剔除这条回复'} aria-label={editedEntryIds().has(message.entryId) ? '该条目已被剔除出模型上下文' : '从模型上下文中剔除这条回复'} disabled={!!ctxEditBusyId || slotFor(activeSessionId).running} on:click={() => void removeContextEntry(message.entryId!)}>
                        <Icon name={editedEntryIds().has(message.entryId) ? 'x' : 'minus'} size={14} />
                      </button>
                    {/if}
                    <time class="assistant-time" datetime={new Date(message.timestamp).toISOString()}><Icon name="clock" size={12} />{message.at}</time>
                  </div>
                </div>
              {/if}
            {/each}
            {#if ctxPanelOpen || ctxEdits.length}
              <div class="ctx-edits-panel">
                <button class="ctx-edits-toggle" type="button" on:click={() => (ctxPanelOpen = !ctxPanelOpen)}>上下文编辑 {ctxEdits.length} 条 {ctxPanelOpen ? '▾' : '▸'}</button>
                {#if ctxPanelOpen}
                  {#each ctxEdits as edit (`${edit.timestamp}:${edit.entryId}`)}
                    <div class="ctx-edit-row">
                      <span class="ctx-edit-kind">{edit.removed ? '剔除' : '替换'}</span>
                      <code>{edit.targetId}</code>
                      {#if !edit.removed}<span class="ctx-edit-text">{edit.text.slice(0, 80)}{edit.text.length > 80 ? '…' : ''}</span>{/if}
                    </div>
                  {/each}
                {/if}
              </div>
            {/if}
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
            <!-- 1-5 UI 插件：timeline 槽位（注册表按 slot 分发） -->
            <PluginHost slot="timeline" hostId="timeline" messages={runState[activeSessionId]?.pluginMessages ?? []} itemClass="message plugin-message" trusted={pluginTrusted} />
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

        <!-- D-B（外部审计 P1）：其它会话挂起的权限确认。原先只有 active 槽会渲染
             （模板 `runState[activeSessionId].confirm`），也只由 active 槽回答
             （answerConfirm 取 activeSessionId），后台会话的确认因此**完全不可见**，
             用户切走期间那个工具调用一直挂着，直到 sidecar 的 600s 超时按
             confirm→false 保守拒绝（工具静默失败）。
             ⚠️ 必须放在 `{#if activeSessionIdle}` 的**外面**（会话列表容器之上）：
             active 槽为空白页时整段消息区都不渲染，放进去会让"刚切到一个空会话、
             后台恰好有确认"这个最常见的场景重新变回不可见。 -->
        {#if pendingConfirms.length}
          <div class="remote-confirm-bar" role="region" aria-label="后台会话的权限确认">
            {#each pendingConfirms as item (item.id)}
              <div class="confirm-card confirm-card-remote">
                <div class="confirm-head">
                  <span class="confirm-session">{item.title}</span>
                  <span class="confirm-tool">{item.confirm.toolName}</span>
                  <span class="confirm-summary">{item.confirm.summary}</span>
                </div>
                <div class="confirm-actions"><button class="confirm-allow" on:click={() => answerConfirm(true, item.id)}>允许</button><button on:click={() => answerConfirm(false, item.id)}>拒绝</button></div>
              </div>
            {/each}
          </div>
        {/if}

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
          <!-- 1-5 UI 插件：status 槽位（composer 上方的胶囊状态条） -->
          <PluginHost
            slot="status"
            hostId="composer"
            variant="inline"
            limit={3}
            containerClass="plugin-status-bar"
            messages={runState[activeSessionId]?.pluginMessages ?? []}
            trusted={pluginTrusted}
          />
          <Composer bind:this={composerRef} bind:inputText bind:attachments bind:attachError bind:imageGenError bind:imageGenResult imageGenConfig={imageGenConfig} models={models} sessions={sessions} activeSessionId={activeSessionId} runState={runState} sidecarReady={sidecarReady} workspacePath={workspacePath} files={files} request={request} requestRaw={requestRaw} remember={remember} ensureActiveId={ensureActiveId} loadPrefs={loadPrefs} loadFiles={loadFiles} submit={submit} stop={stop} runSlashCommand={runSlashCommand} />
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
          <!-- 0-5 批次 B-5：文档面板整块抽到 FilePanel.svelte（状态 bind 同步 + 薄桥回调） -->
          <FilePanel
            bind:filesLoading
            bind:selectedFile
            bind:fileContent
            bind:largeFile
            bind:editingFile
            {filteredFiles}
            {projectBusy}
            {sidecarReady}
            {workspacePath}
            request={(type, payload) => request(type, payload)}
            requestRaw={(type, payload) => requestRaw(type, payload)}
            onSaved={() => void refreshGit()}
            onRefresh={() => void loadFiles()}
            onReadError={(message) => patchSlot(ensureActiveId(), { error: `读取文件失败: ${message}` })}
          />
        {:else if panel === '变更'}
          <!-- 0-5 批次 B-1：git 面板整块抽到 GitPanel.svelte（状态自持 + bind 同步） -->
          <GitPanel
            bind:this={gitPanelRef}
            bind:gitChanges
            bind:diffContent
            bind:gitError
            {sidecarReady}
            {workspacePath}
            request={(type, payload) => request(type, payload)}
            requestRaw={(type, payload) => requestRaw(type, payload)}
            gitTemplate={uiPrefs.gitTemplate}
          />
        {:else if panel === '终端'}
          <!-- 终端组件常驻在下方（见 {:else} 之后），此处仅留位。 -->
        {:else if panel === '待办'}
          <!-- 0-5 批次 B-2：待办面板模板抽到 TodoPanel.svelte（状态经 bind: 双向同步，权威源仍在 App） -->
          <TodoPanel
            bind:this={todoPanelRef}
            bind:todos
            bind:todoDraft
            bind:todoParentId
            on:split={() => { splitOpen = true; agentDefs = loadAgents() }}
          />
        {:else}
          <!-- 0-5 批次 B-3：子代理列表抽到 SubRunsPanel.svelte（纯展示；onView/onOpenSplit 回父组件开 overlay） -->
          <SubRunsPanel
            subRuns={runState[activeSessionId]?.subRuns ?? []}
            onView={(run) => (viewingSub = { ...run, reply: slotFor(run.id).reply || run.reply })}
            onOpenSplit={() => { splitOpen = true; agentDefs = loadAgents() }}
          />
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
  <!-- 0-5 批次 B-4：拆分/检视 overlay 抽到 SplitDialog/SubRunOverlay（全局模态挂根级，状态 bind 回 App） -->
  <SplitDialog bind:open={splitOpen} bind:rows={splitRows} {agentDefs} onRun={runSplit} />
  <SubRunOverlay
    bind:run={viewingSub}
    runProp={viewingSub ? slotFor(viewingSub.id) : null}
    showThinking={uiPrefs.showThinking !== false}
    orb={uiPrefs.thinkingOrb}
  />
  <!-- 1-5 UI 插件：float 槽位（右下角可堆叠的非阻塞浮层，与 ext-toasts 错开） -->
  <PluginHost
    slot="float"
    hostId="float"
    limit={2}
    containerClass="plugin-float-stack"
    messages={runState[activeSessionId]?.pluginMessages ?? []}
    trusted={pluginTrusted}
  />
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
  <Settings open={showSettings} connected={sidecarReady} info={settingsInfo} usageStats={usageStats} imageGenConfig={imageGenConfig} onSaveImageGenConfig={saveImageGenConfig} onclose={() => { showSettings = false; settingsInitialTab = undefined; refreshPrefs() }} openDir={openDir} workspacePath={workspacePath} onChooseWorkspace={chooseWorkspace} onOpenRepo={() => void request('open_url', { url: 'https://github.com/TANGZZee/pi-my' })} providers={providers} onRefreshProviders={refreshProviders} onRefreshUsage={refreshUsage} onPrefsChange={refreshPrefs} onRestoreArchived={(session) => unarchiveSession(session)} onDeleteArchived={(session) => deleteSession(session, true)} agentUpdate={agentUpdate} agentUpdateBusy={agentUpdateBusy} onCheckAgentUpdate={() => void checkAgentUpdate(true)} onUpdateAgent={() => void updatePiSdk()} onOpenAgentUpdate={openAgentUpdate} onOpenAgentRepo={openAgentRepo} initialTab={settingsInitialTab} rpc={request} activeSessionId={activeSessionId} pluginMessages={runState[activeSessionId]?.pluginMessages ?? []} />
</div>
