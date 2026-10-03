<script lang="ts">
  // 0-5 批次 C：从 App.svelte 抽出的输入区（textarea + 五下拉菜单 + mention 补全 + 附件 + 生图）。
  // inputText/attachments/attachError/imageGenError/imageGenResult 经 bind: 双向同步留在父组件
  // （submit/dispatchTurn 直写 inputText 与 attachments；消息区直读 imageGenError/imageGenResult；
  // Settings 直读 imageGenConfig——父组件仍是权威副本）。imageGenMode/imageGenBusy 是组件本地态
  // （父组件零引用）。模型/思考/权限/ctx 四组菜单与生图执行在组件内自持；提交/停止/斜杠命令
  // 经 props（submit/stop/runSlashCommand）回父组件。
  import { onMount } from 'svelte'
  import Icon from './Icon.svelte'
  import { open } from '@tauri-apps/plugin-dialog'
  import logoUrl from './assets/pi-my-logo.png'
  import { MODEL_SEPARATOR, THINKING_LEVELS, THINKING_LABELS, THINKING_HELP, MODE_LABELS, MODE_OPTIONS, modelKey, modelGroups, modelChoice, thinkingChoice, sessionMode, type AppModelInfo, type SessionLike } from './app-models'
  import { SLASH_COMMANDS, slashTriggerQuery } from './slash-commands'
  import { stateSummary, type StateSnapshot } from './session-state'
  import { withResetEstimate, formatResetCountdown } from './quota-reset'
  import { EMPTY_CTX, ctxDash as logicCtxDash, ctxProgress as logicCtxProgress, fmtWan, mentionList, type CtxStats } from './composer-logic'

  export let inputText = ''
  export let models: AppModelInfo[] = []
  export let sessions: SessionLike[] = []
  export let activeSessionId = ''
  export let runState: Record<string, { running?: boolean }> = {}
  export let sidecarReady = false
  export let workspacePath = '.'
  export let files: Array<{ path: string; kind: 'file' | 'directory' }> = []
  export let attachments: Array<{ kind: 'image' | 'text'; name: string; mimeType?: string; data?: string; content?: string }> = []
  export let attachError = ''
  export let imageGenError = ''
  export let imageGenResult: { src: string; prompt: string } | null = null
  export let imageGenConfig: { baseUrl: string; apiKey: string; model: string; size: string } = { baseUrl: '', apiKey: '', model: '', size: '1024x1024' }

  /** 请求通道：request(type, payload)（ok:false 时 result 为 null）；requestRaw 返回 {ok,result,error} */
  export let request: (type: string, payload?: Record<string, unknown>) => Promise<unknown> = async () => null
  export let requestRaw: (type: string, payload?: Record<string, unknown>) => Promise<{ ok: boolean; result: unknown; error?: string }> = async () => ({ ok: false, result: null })
  /** 会话记忆（App.remember：无记录时建占位会话） */
  export let remember: (id: string, patch: Record<string, unknown>) => void = () => {}
  /** 取当前会话 id（无则占位新建——App 持有 activeSessionId 权威） */
  export let ensureActiveId: () => string = () => ''
  export let loadPrefs: () => { sendShortcut?: 'enter' | 'ctrl-enter'; busySend?: 'steer' | 'followUp'; quotaCycles?: Record<string, 'daily' | 'weekly' | 'monthly' | 'none'> } = () => ({})
  /** 文件列表刷新（loadFiles 留在父组件：files 还被 FilePanel 共享） */
  export let loadFiles: () => Promise<void> = async () => {}
  /** 提交/停止/斜杠命令分派都留在父组件（submit 管 scout/todo/split 前缀与 dispatchTurn） */
  export let submit: (behavior?: 'steer' | 'followUp') => void = () => {}
  export let stop: () => Promise<void> = async () => {}
  export let runSlashCommand: (command: { kind: string; id: string }, args?: string) => void = () => {}

  let composerInput: HTMLTextAreaElement
  let modelOpen = false
  let modelMenuUp = false
  let modelQuery = ''
  let hiddenProviders: string[] = []
  let collapsedModelProviders: Record<string, boolean> = {}
  let modelSearchInput: HTMLInputElement
  let modelButtonRef: HTMLButtonElement
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
  let imageGenMode = false
  let imageGenBusy = false
  let mention: { kind: 'file' | 'cmd'; query: string; index: number } | null = null
  // 2-8/U4：provider 额度 + get_state 快照（打开 ctx 面板时拉一次，不自动轮询）
  type QuotaRow = { provider: string; ok?: boolean; message?: string; value?: unknown } & { nextResetAt: string | null; msUntilReset: number | null; cycleElapsedPercent: number | null }
  let quotas: QuotaRow[] = []
  let quotasBusy = false
  let quotasQueriedAt = 0
  let sessionState: StateSnapshot | null = null

  onMount(() => {
    loadHiddenProviders()
    loadCollapsedModelProviders()
  })

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

  $: currentModelKey = modelChoice(models, sessions, activeSessionId)
  $: currentModel = models.find((item) => modelKey(item) === currentModelKey)
  $: currentModelLabel = currentModel ? currentModel.name : '选择模型'
  $: modelFilter = modelQuery.trim().toLowerCase()
  $: modelMatches = (modelFilter ? models.filter((item) => item.name.toLowerCase().includes(modelFilter) || item.provider.toLowerCase().includes(modelFilter)) : models).filter((item) => !hiddenProviders.includes(item.provider))
  // 让模型分组订阅折叠状态，点击后菜单会立即重绘。
  $: modelDropdownGroups = modelGroups(modelMatches).map((group) => ({
    ...group,
    collapsed: !modelQuery.trim() && Boolean(collapsedModelProviders[group.provider])
  }))
  $: currentThinking = thinkingChoice(sessions, activeSessionId)
  $: currentMode = sessionMode(sessions, activeSessionId)
  $: thinkingLevel = thinkingDraft || currentThinking
  $: thinkingIndex = Math.max(0, THINKING_LEVELS.indexOf(thinkingLevel))
  $: thinkingLabel = THINKING_LABELS[thinkingLevel] ?? thinkingLevel
  $: thinkingPercent = THINKING_LEVELS.length > 1 ? thinkingIndex / (THINKING_LEVELS.length - 1) : 0
  $: mentionItems = mentionList(mention, files)
  $: stateSummaryView = sessionState ? stateSummary(sessionState) : null

  // ---- 对外 API（App 经 bind:this 调用）----
  export function focusInput() {
    composerInput?.focus()
  }
  export function openModelMenu() {
    modelOpen = true
  }
  export function closeMenus() {
    kindOpen = false
    modeOpen = false
    modelOpen = false
    thinkingOpen = false
    ctxOpen = false
  }
  export function clearMention() {
    mention = null
  }
  export function refreshCtx() {
    void refreshCtxStats()
  }
  export function reloadPrefs() {
    loadHiddenProviders()
    loadCollapsedModelProviders()
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

  function toggleKind() {
    kindOpen = !kindOpen
    if (kindOpen) {
      modeOpen = false
      modelOpen = false
      thinkingOpen = false
      ctxOpen = false
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

  export async function setMode(mode: string) {
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
    // 0-5 批次 C 审查修补（M27）：数学唯一归属 composer-logic，本地薄委托读 ctxStats 本地态。
    return logicCtxProgress(ctxStats)
  }

  function ctxDash() {
    // 0-5 批次 C 审查修补（M27）：环形公式唯一归属 composer-logic。
    return logicCtxDash(ctxStats)
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

  function pickModel(model: AppModelInfo) {
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
</script>

<div class="composer">
  {#if attachError}<div class="git-error attach-error">{attachError}</div>{/if}
  {#if attachments.length}<div class="attach-chips">{#each attachments as attachment, index (index)}<span class="attach-chip" class:image={attachment.kind === 'image'}>{#if attachment.kind === 'image'}<i></i>{/if}<span class="attach-name">{attachment.name}</span><button aria-label="移除附件" on:click={() => removeAttachment(index)}>×</button></span>{/each}</div>{/if}
  {#if mention && mentionItems.length}<div class="mention-menu">{#each mentionItems as item, i}<button class:on={i === mention.index} on:mousedown|preventDefault={() => applyMention(i)}>{mention.kind === 'cmd' ? `/${(item as { id: string }).id}  ${(item as { label: string }).label}${(item as { desc?: string }).desc ? `  ${(item as { desc?: string }).desc}` : ''}` : (item as { path: string }).path}</button>{/each}</div>{/if}
  <textarea bind:this={composerInput} bind:value={inputText} on:input={refreshMention} on:paste={handleClipboardPaste} on:keydown={handleKeydown} placeholder={imageGenMode ? '描述要生成的图片…' : '输入消息，@ 引用文件，/ 运行命令'} rows="2"></textarea>
  <div class="composer-toolbar"><div class="composer-controls"><div class="kind-dropdown" use:clickOutsideKind><button class="kind-button" bind:this={kindButtonRef} aria-haspopup="true" aria-expanded={kindOpen} aria-label="输入模式" on:click={toggleKind}><img src={logoUrl} alt="" /><span>{imageGenMode ? '生图' : 'Pi'}</span><svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true"><path d="M1.5 2.5 4 5l2.5-2.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>{#if kindOpen}<div class="kind-menu"><button class:selected={!imageGenMode} on:click={() => setAgentKind(false)}><img src={logoUrl} alt="" /><span>Pi</span></button><button class:selected={imageGenMode} on:click={() => setAgentKind(true)}><span>生图</span></button></div>{/if}</div><button class="attach-button" disabled={!sidecarReady} aria-label="添加附件" on:click={() => void addAttachments()}><Icon name="paperclip" size={13} /></button><div class="mode-dropdown" use:clickOutsideMode><button class="mode-button" class:plan={currentMode === 'plan'} bind:this={modeButtonRef} aria-haspopup="true" aria-expanded={modeOpen} aria-label="权限模式" on:click={toggleMode}><svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.8 13.5 3.6v4.1c0 3.2-2.2 5.6-5.5 6.6-3.3-1-5.5-3.4-5.5-6.6V3.6L8 1.8Z"/></svg><span>{MODE_LABELS[currentMode] ?? currentMode}</span></button>{#if modeOpen}<div class="mode-menu" class:up={modeMenuUp}>{#each MODE_OPTIONS as option (option.value)}<button class="mode-option" class:selected={option.value === currentMode} on:click={() => void setMode(option.value)}><span class="mode-dot"></span><span class="mode-copy"><strong>{option.label}</strong><small>{option.desc}</small></span></button>{/each}</div>{/if}</div></div><div class="composer-model"><div class="model-dropdown" use:clickOutside><button class="model-button" bind:this={modelButtonRef} disabled={!models.length} aria-haspopup="listbox" aria-expanded={modelOpen} aria-label="模型" on:click={toggleModel}><span>{currentModelLabel}</span><svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true"><path d="M1.5 2.5 4 5l2.5-2.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>{#if modelOpen}<div class="model-menu" class:up={modelMenuUp}><div class="model-search"><Icon name="search" size={12} /><input bind:this={modelSearchInput} bind:value={modelQuery} placeholder="搜索模型…" aria-label="搜索模型" /></div><div class="model-list">{#each modelDropdownGroups as group (group.provider)}<button class="model-group-title" type="button" aria-expanded={!providerCollapsed(group.provider)} on:click={() => toggleModelProvider(group.provider)}><span>{group.provider}{#if group.items[0]?.source === "extension"}<span class="ext-badge" title="由本机 Pi 扩展动态注册">扩展</span>{/if}</span><span class="model-group-count">{group.items.length}</span><Icon name={providerCollapsed(group.provider) ? 'chevron-right' : 'chevron-down'} size={10} /></button>{#if !providerCollapsed(group.provider)}<div class="model-group-items">{#each group.items as model (modelKey(model))}<button class="model-option" class:selected={modelKey(model) === currentModelKey} on:click={() => pickModel(model)}><span class="model-dot"></span><span class="model-name">{model.name}</span></button>{/each}</div>{/if}{:else}<div class="model-empty">没有匹配的模型</div>{/each}</div></div>{/if}</div><div class="thinking-dropdown" use:clickOutsideThinking><button class="thinking-button" bind:this={thinkingButtonRef} disabled={!sidecarReady} aria-haspopup="true" aria-expanded={thinkingOpen} aria-label="思考深度" on:click={toggleThinking}><span class="thinking-label">思考：</span><span class="thinking-value">{thinkingLabel}</span><svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true"><path d="M1.5 2.5 4 5l2.5-2.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>{#if thinkingOpen}<div class="thinking-menu"><div class="thinking-head"><strong>思考深度</strong><span>{thinkingLabel}</span><button class="thinking-help-button" class:on={thinkingHelp} aria-label="档位说明" aria-expanded={thinkingHelp} on:click={toggleThinkingHelp}>?</button></div><div class="thinking-ends"><span>更快</span><span>更聪明</span></div><div class="thinking-slider" style={`--p:${thinkingPercent}`}><div class="thinking-track"></div><div class="thinking-fill"></div><input class="thinking-range" type="range" min="0" max={THINKING_LEVELS.length - 1} step="1" value={thinkingIndex} disabled={!sidecarReady} aria-label="思考档位" on:input={onThinkingInput} on:change={onThinkingChange} /></div>{#if thinkingHelp}<ul class="thinking-help">{#each THINKING_LEVELS as level (level)}<li class:on={level === thinkingLevel}><b>{THINKING_LABELS[level]}</b><span>{THINKING_HELP[level]}</span></li>{/each}</ul>{/if}</div>{/if}</div></div><div class="composer-right"><div class="ctx-dropdown" use:clickOutsideCtx><button class="ctx-button" class:empty={!activeSessionId || !ctxStats?.window} bind:this={ctxButtonRef} disabled={!sidecarReady} aria-label="上下文用量" aria-haspopup="true" aria-expanded={ctxOpen} on:click={toggleCtx}><svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" stroke-width="2"/>{#if ctxStats?.window}<circle cx="9" cy="9" r="7" fill="none" stroke="#333" stroke-width="2" stroke-linecap="round" stroke-dasharray={ctxDash()} transform="rotate(-90 9 9)"/>{/if}</svg></button>{#if ctxOpen}<div class="ctx-menu" class:up={ctxMenuUp}>{#if !activeSessionId}<div class="ctx-empty"><strong>本会话尚未开始</strong><small>发送第一条消息后显示用量</small></div>{:else if !ctxStats?.window}<div class="ctx-empty"><strong>暂无用量数据</strong><small>发送消息后显示上下文占用</small></div>{:else}<div class="ctx-head"><strong>上下文容量（估算）</strong><span>{ctxProgress()}%</span></div><div class="ctx-row"><span>当前上下文</span><span>{fmtWan(ctxStats.currentContext)}</span></div><div class="ctx-row"><span>可用容量</span><span>{fmtWan(Math.max(0, ctxStats.window - ctxStats.currentContext))}</span></div><div class="ctx-row"><span>上下文窗口</span><span>{fmtWan(ctxStats.window)}</span></div><div class="ctx-bar"><i style="width:{ctxProgress()}%"></i></div><div class="ctx-divider"></div><div class="ctx-sub">本会话累计</div><div class="ctx-row"><span>总 Token</span><span>{fmtWan(ctxStats.totals.total)}</span></div><div class="ctx-row"><span>输入</span><span>{fmtWan(ctxStats.totals.input)}</span></div><div class="ctx-row"><span>输出</span><span>{fmtWan(ctxStats.totals.output)}</span></div><div class="ctx-row"><span>缓存读取</span><span>{fmtWan(ctxStats.totals.cacheRead)}</span></div><div class="ctx-row"><span>缓存写入</span><span>{fmtWan(ctxStats.totals.cacheWrite)}</span></div><div class="ctx-divider"></div><div class="ctx-row"><span>本地费率估算</span><span>${ctxStats.costUsd.toFixed(2)}</span></div><div class="ctx-row"><span>平均缓存命中率</span><span>{(ctxStats.cacheHitRate * 100).toFixed(1)}%</span></div><div class="ctx-note">按本地模型费率估算，未提供费率则为 0</div>{#if stateSummaryView}<div class="ctx-divider"></div><div class="ctx-sub">运行状态（1-8 get_state）</div><div class="ctx-row"><span>权限模式</span><span>{stateSummaryView.mode}</span></div>{#if stateSummaryView.model}<div class="ctx-row"><span>模型</span><span>{stateSummaryView.model}</span></div>{/if}{#if stateSummaryView.thinking}<div class="ctx-row"><span>思考档位</span><span>{stateSummaryView.thinking}</span></div>{/if}<div class="ctx-row"><span>消息数</span><span>{Number(sessionState?.stats?.totalMessages ?? 0)}</span></div><div class="ctx-row"><span>排队消息</span><span>{stateSummaryView.queued}</span></div>{/if}{#if quotas.length}<div class="ctx-divider"></div><div class="ctx-sub">Provider 额度（2-8）{quotasBusy ? " · 查询中" : ""}</div>{#each quotas as q (q.provider)}<div class="ctx-row"><span>{q.provider}</span><span>{q.message || "—"}{#if q.nextResetAt} · {formatCountdown(q.msUntilReset)}{/if}</span></div>{/each}<div class="ctx-note">重置时间为按周期估算（设置页可为每个 provider 配置）；接口提供真实重置时间时优先展示</div>{/if}<div class="ctx-note">按本地模型费率估算，未提供费率则为 0</div>{/if}</div>{/if}</div><!-- END-CTX --><button class:imagegen-busy={imageGenBusy} class:stop={runState[activeSessionId]?.running} class="send" aria-label={imageGenMode ? '生成图片' : runState[activeSessionId]?.running ? '停止当前任务' : '发送消息'} title={imageGenMode ? '生成图片' : runState[activeSessionId]?.running ? '停止当前任务' : '发送消息'} on:click={imageGenMode ? generateImage : runState[activeSessionId]?.running ? stop : () => submit('steer')}>{#if imageGenBusy}<span class="send-dot"></span>{:else if runState[activeSessionId]?.running}<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="1.5" y="1.5" width="7" height="7" rx="1" fill="currentColor"/></svg>{:else}<Icon name="send" size={14} strokeWidth={1.9} />{/if}</button></div></div>
</div>
