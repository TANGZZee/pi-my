<script lang="ts">
  import { onMount } from 'svelte'
  import { version } from '../package.json'
  import { loadPrefs, patchPrefs, type Prefs, type Density, type SendShortcut, type BusySend, type ModePref, type ThemePref } from './prefs'
  import { loadAgents, removeAgent, upsertAgent, type AgentDef } from './agents'
  import { SKINS, type SkinId } from './skins'
  import { PETS, petPreviewUrl, type PetModel } from './pets'
  import ConfigPane from './ConfigPane.svelte'

  type ProviderInfo = { provider: string; modelCount: number; configured: boolean }
  type UsageStats = { sessions: number; turns: number; activeDays: number; totals: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }; costUsd: number; costKnown: boolean; byModel: Array<{ model: string; tokens: number; turns: number }>; byProject?: Array<{ project: string; tokens: number; turns: number }>; byDay?: Record<string, number> }
  type ImageGenConfig = { baseUrl: string; apiKey: string; model: string; size: string }
  type SettingsInfo = { node: string; sdk: string; agentDir: string; sessionDir: string; authProviders: string[]; providers?: ProviderInfo[] }
  type ArchivedSession = { id: string; title: string; file?: string; cwd?: string; modifiedAt?: number; archived?: boolean }
  type Tab = 'general' | 'appearance' | 'notify' | 'keys' | 'proxy' | 'agents' | 'imagegen' | 'git' | 'skills' | 'extensions' | 'store' | 'vision' | 'usage' | 'archived' | 'storage' | 'lan' | 'pet' | 'logs' | 'about'
  type AgentUpdateInfo = { current: string; latest: string; installedVersion?: string; updateAvailable: boolean; url: string; repoUrl?: string; source?: string; sourceLabel?: string; updated?: boolean; restartRequired?: boolean; message?: string; checkedAt?: number }

  export let open = false
  export let connected = false
  export let info: SettingsInfo | null = null
  export let onclose: () => void = () => {}
  export let openDir: (path: string) => void = () => {}
  export let workspacePath: string | undefined = undefined
  export let onChooseWorkspace: (() => void) | undefined = undefined
  export let onOpenRepo: (() => void) | undefined = undefined
  export let providers: ProviderInfo[] | undefined = undefined
  export let usageStats: UsageStats | null = null
  export let imageGenConfig: ImageGenConfig = { baseUrl: '', apiKey: '', model: '', size: '1024x1024' }
  export let onSaveImageGenConfig: (config: ImageGenConfig) => void = () => {}
  export let onRefreshProviders: (() => void) | undefined = undefined
  export let onRefreshUsage: (() => void) | undefined = undefined
  export let onPrefsChange: () => void = () => {}
  export let onRestoreArchived: ((session: ArchivedSession) => Promise<void> | void) | undefined = undefined
  export let onDeleteArchived: ((session: ArchivedSession) => Promise<void> | void) | undefined = undefined
  export let agentUpdate: AgentUpdateInfo | null = null
  export let agentUpdateBusy = false
  export let onCheckAgentUpdate: (() => void) | undefined = undefined
  export let onUpdateAgent: (() => void) | undefined = undefined
  export let onOpenAgentUpdate: (() => void) | undefined = undefined
  export let onOpenAgentRepo: (() => void) | undefined = undefined
  export let initialTab: Tab | undefined = undefined
  export let rpc: ((type: string, payload?: Record<string, unknown>) => Promise<unknown>) | undefined = undefined

  const NAV: Array<{ group: string; items: Array<[Tab, string]> }> = [
    { group: '基础', items: [['general', '通用'], ['appearance', '外观'], ['notify', '通知'], ['keys', '快捷键'], ['proxy', '代理']] },
    { group: '能力', items: [['agents', '子代理'], ['imagegen', '生图'], ['git', 'Git']] },
    { group: '生态', items: [['skills', '技能'], ['extensions', '扩展'], ['store', '商店'], ['vision', '视觉桥'], ['pet', '桌宠'], ['lan', '局域网']] },
    { group: '维护', items: [['usage', '用量'], ['archived', '已归档的聊天'], ['storage', '存储'], ['logs', '日志'], ['about', '关于']] }
  ]

  const SHELLS: Array<[string, string, string]> = [
    ['cmd', 'cmd', 'Windows 命令提示符'],
    ['powershell', 'powershell', 'Windows PowerShell'],
    ['pwsh', 'pwsh', 'PowerShell Core']
  ]
  const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  const THINKING_LABELS: Record<string, string> = { off: '关', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最大' }
  const MODES: Array<[ModePref, string, string]> = [
    ['plan', '计划', '只读探索，不改文件'],
    ['ask', '默认', '写与命令逐次确认'],
    ['full', '完全访问', '不拦截']
  ]
  const SHORTCUTS: Array<[string, string]> = [
    ['打开设置', 'Ctrl + ,'],
    ['新建会话', 'Ctrl + N'],
    ['收起 / 展开左侧栏', 'Ctrl + B'],
    ['收起 / 展开右侧栏', 'Ctrl + Shift + B'],
    ['发送消息', 'Enter 或 Ctrl + Enter'],
    ['排队发送', 'Alt + Enter'],
    ['换行', 'Shift + Enter']
  ]
  let pane: 'settings' | 'config' = 'settings'
  let tab: Tab = 'general'
  let prefs: Prefs = loadPrefs()
  let notifyError = ''
  let agentList: AgentDef[] = loadAgents()
  let agentDraft: AgentDef = { name: '', description: '', systemPrompt: '', mode: 'plan' }
  let proxyDraft = { desktop: { mode: 'off', url: '' }, agent: { mode: 'off', url: '' } }
  let configDirty = false
  const configSaveHandler = { current: async () => {} }
  let eco: { skills: Array<Record<string, unknown>>; extensions: Array<Record<string, unknown>>; locations?: Record<string, string> } = { skills: [], extensions: [] }
  let storeTab: 'prompts' | 'skills' | 'extensions' | 'xue' = 'prompts'
  let storeSort: 'recommended' | 'popular' | 'name' | 'updated' = 'recommended'
  let storeQuery = ''
  let storeItems: Array<Record<string, unknown>> = []
  let storeBusy = ''
  let extensionBusy: Record<string, boolean> = {}
  let extensionNotice: Record<string, string> = {}
  let xue = { categories: [] as string[], items: [] as Array<Record<string, unknown>>, total: 0, page: 1, note: '' }
  let xueCategory = ''
  let vision = { enabled: false, provider: '', model: '', baseUrl: '', apiKey: '', promptTemplate: '' }
  let ecoNotice = ''
  let petNotice = ''
  let lanStatus: { enabled?: boolean; port?: number | null; urls?: string[]; clients?: number } | null = null
  let lanBusy = false
  let logLines: string[] = []
  let oauthNotice = ''
  let archivedSessions: ArchivedSession[] = []
  let archivedQuery = ''
  let archivedBusy = false
  let archivedNotice = ''

  onMount(() => {
    prefs = loadPrefs()
    try {
      if (localStorage.getItem('pdn.settings-pane') === 'config') pane = 'config'
      const last = localStorage.getItem('pdn.settings-tab') as Tab | null
      if (last && NAV.some((section) => section.items.some(([id]) => id === last))) tab = last
    } catch { /* ignore */ }
  })

  function setPane(next: 'settings' | 'config') {
    pane = next
    try { localStorage.setItem('pdn.settings-pane', next) } catch { /* ignore */ }
  }

  function setTab(next: Tab) {
    tab = next
    try { localStorage.setItem('pdn.settings-tab', next) } catch { /* ignore */ }
  }

  $: void providers
  $: if (open) prefs = loadPrefs()
  $: if (open && tab === 'proxy') void loadProxy()
  $: if (open && (tab === 'skills' || tab === 'extensions')) void loadEco()
  $: if (open && tab === 'vision') void loadVision()
  $: if (open && tab === 'lan') void loadLan()
  $: if (open && tab === 'logs') void loadLogs()
  $: if (open && tab === 'archived') void loadArchivedSessions()
  $: if (open && tab === 'store') void refreshStore()
  // 修改：从侧栏更新提醒进入设置时，直接定位到“关于”页。
  $: if (open && initialTab && tab !== initialTab) setTab(initialTab)
  $: sortedStoreItems = sortStoreItems(storeItems)
  $: sortedXueItems = sortStoreItems(xue.items as Array<Record<string, unknown>>)
  $: archivedGroups = groupArchivedSessions(archivedSessions.filter((item) => {
    const query = archivedQuery.trim().toLowerCase()
    return !query || item.title.toLowerCase().includes(query) || String(item.cwd || '').toLowerCase().includes(query)
  }))

  function commit(partial: Partial<Prefs>) {
    prefs = patchPrefs(partial)
    onPrefsChange()
  }

  function formatTokens(value: number) {
    if (!value) return '0'
    if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`
    if (value >= 1000) return `${(value / 1000).toFixed(1)}K`
    return String(Math.round(value))
  }

  function formatCount(value: unknown) {
    const n = Number(value || 0)
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
    return String(n)
  }

  function storeMetric(item: Record<string, unknown>) {
    if (storeTab === 'prompts') return Number(item.votes || item.views || 0)
    if (storeTab === 'skills') return Number(item.installs || item.downloads || 0)
    if (storeTab === 'extensions') return Number(item.downloads || item.score || 0)
    return 0
  }

  function storeUpdated(item: Record<string, unknown>) {
    const value = item.updatedAt || item.updated_at || item.publishedAt || item.published_at || item.date || item.version
    const time = Date.parse(String(value || ''))
    return Number.isFinite(time) ? time : 0
  }

  function sortStoreItems(items: Array<Record<string, unknown>>) {
    if (storeSort === 'recommended') return items
    const next = [...items]
    if (storeSort === 'popular') next.sort((a, b) => storeMetric(b) - storeMetric(a))
    else if (storeSort === 'name') next.sort((a, b) => String(a.title || a.name || '').localeCompare(String(b.title || b.name || ''), 'zh-CN'))
    else next.sort((a, b) => storeUpdated(b) - storeUpdated(a))
    return next
  }

  function setStoreTab(next: typeof storeTab) {
    storeTab = next
    storeSort = 'recommended'
    void refreshStore()
  }

  function updateImageGen(key: keyof ImageGenConfig, value: string) {
    onSaveImageGenConfig({ ...imageGenConfig, [key]: value })
  }

  function workspaceBase() {
    if (!workspacePath || workspacePath === '.') return '未选择'
    return workspacePath.split(/[\\/]/).pop() || workspacePath
  }

  async function loadProxy() {
    if (!rpc || !connected) return
    try { proxyDraft = await rpc('proxy_get', {}) as typeof proxyDraft } catch { /* keep draft */ }
  }

  async function saveProxy() {
    if (!rpc) return
    proxyDraft = await rpc('proxy_set', proxyDraft) as typeof proxyDraft
  }

  async function loadEco() {
    if (!rpc || !connected) return
    try { eco = await rpc('eco_list', { cwd: workspacePath }) as typeof eco } catch { eco = { skills: [], extensions: [] } }
  }

  async function toggleItem(item: Record<string, unknown>, enable: boolean) {
    ecoNotice = ''
    if (item.id === 'builtin:imagegen-skill') {
      try { ecoNotice = `已安装 ${(await rpc?.('eco_install_imagegen', {}) as { name: string }).name}`; await loadEco() } catch (error) { ecoNotice = error instanceof Error ? error.message : '失败' }
      return
    }
    if (String(item.path || '') === 'builtin') { ecoNotice = '空响应重试已随 sidecar 内置加载'; return }
    try { await rpc?.('eco_toggle', { path: item.path, enable }); await loadEco() } catch (error) { ecoNotice = error instanceof Error ? error.message : '失败' }
  }

  async function refreshStore() {
    if (!rpc) return
    if (storeTab === 'xue') { await loadXue(); return }
    await runStoreSearch(true)
  }

  async function runStoreSearch(top = false) {
    if (!rpc) return
    storeBusy = top ? '加载推荐…' : '搜索中…'
    try {
      const query = top ? '' : storeQuery
      if (storeTab === 'prompts') {
        const result = await rpc('eco_search_prompts', { query }) as { items: Array<Record<string, unknown>> }
        storeItems = result.items || []
      } else if (storeTab === 'skills') {
        const result = await rpc('eco_search_skills', { query }) as { items: Array<Record<string, unknown>> }
        storeItems = result.items || []
      } else if (storeTab === 'extensions') {
        const result = await rpc('eco_search_extensions', { query }) as { items: Array<Record<string, unknown>> }
        storeItems = result.items || []
      }
      storeBusy = ''
    } catch (error) {
      storeBusy = error instanceof Error ? error.message : '加载失败'
      storeItems = []
    }
  }

  async function loadXue(page = 1) {
    if (!rpc) return
    try {
      xue = await rpc('eco_xue', { query: storeQuery, category: xueCategory, page }) as typeof xue
    } catch (error) {
      xue = { categories: [], items: [], total: 0, page, note: error instanceof Error ? error.message : '加载失败' }
    }
  }

  async function importStoreItem(item: Record<string, unknown>, kind: 'prompt' | 'skill') {
    ecoNotice = ''
    try {
      const result = kind === 'prompt'
        ? await rpc?.('eco_install_prompt', { item }) as { name: string }
        : await rpc?.('eco_install_skill', { item, cwd: workspacePath, scope: 'global' }) as { name: string }
      ecoNotice = `已导入 ${result?.name}`
      await loadEco()
    } catch (error) {
      ecoNotice = error instanceof Error ? error.message : '导入失败'
    }
  }

  async function installPackage(item: Record<string, unknown>) {
    ecoNotice = ''
    storeBusy = `安装 ${String(item.name)} …`
    try {
      const result = await rpc?.('eco_install_package', { name: item.name }) as { ok: boolean; name: string; message: string }
      if (result?.ok) {
        ecoNotice = `已安装 ${result.name}，新会话生效。`
        await loadEco()
        void rpc?.('eco_refresh', {})
      } else {
        ecoNotice = `安装失败：${result?.message || '未知错误'}`
      }
    } catch (error) {
      ecoNotice = error instanceof Error ? error.message : '安装失败'
    } finally {
      storeBusy = ''
    }
  }

  async function uninstallPackage(item: Record<string, unknown>) {
    const key = extensionKey(item)
    ecoNotice = ''
    extensionBusy = { ...extensionBusy, [key]: true }
    extensionNotice = { ...extensionNotice, [key]: '正在卸载…' }
    try {
      const result = await rpc?.('eco_uninstall_package', { name: item.name }) as { ok: boolean; name: string; message: string }
      if (result?.ok) {
        ecoNotice = ''
        extensionNotice = { ...extensionNotice, [key]: `已卸载 ${result.name}，正在刷新列表…` }
        eco = { ...eco, extensions: eco.extensions.filter((row) => extensionKey(row) !== key) }
      } else {
        extensionNotice = { ...extensionNotice, [key]: `卸载失败：${result?.message || '未知错误'}` }
      }
      await loadEco()
      void rpc?.('eco_refresh', {})
    } catch (error) {
      const message = error instanceof Error ? error.message : '移除失败'
      extensionNotice = { ...extensionNotice, [key]: `卸载失败：${message}` }
      ecoNotice = message
    } finally {
      extensionBusy = { ...extensionBusy, [key]: false }
      window.setTimeout(() => {
        if (extensionNotice[key]?.startsWith('已卸载')) extensionNotice = { ...extensionNotice, [key]: '已卸载' }
      }, 2500)
    }
  }

  function extensionKey(item: Record<string, unknown>) {
    return String(item.id || item.name || item.path || '')
  }

  async function downloadPet(pet: PetModel) {
    petNotice = '下载中…'
    try {
      const result = await rpc?.('eco_download_pet', { pet }) as { id?: string; count?: number; dir?: string }
      petNotice = `已下载 ${pet.name}（${result?.count ?? 0} 个文件）到本地缓存，重启后离线可用。`
      onPrefsChange()
    } catch (error) {
      petNotice = error instanceof Error ? error.message : '下载失败'
    }
  }

  async function loadVision() {
    if (!rpc || !connected) return
    try { vision = await rpc('vision_get', {}) as typeof vision } catch { /* keep */ }
  }

  async function loadLan() {
    if (!rpc || !connected) return
    try { lanStatus = await rpc('lan_status', {}) as typeof lanStatus } catch { lanStatus = { enabled: false, urls: [] } }
  }

  async function setLan(enabled: boolean) {
    if (!rpc) return
    lanBusy = true
    try { lanStatus = await rpc('lan_set', { enabled, port: 18787 }) as typeof lanStatus } catch { /* keep */ }
    lanBusy = false
  }

  async function loadLogs() {
    if (!rpc || !connected) return
    try { logLines = ((await rpc('log_tail', { limit: 200 }) as { lines?: string[] }).lines) || [] } catch { logLines = [] }
  }

  function projectName(pathValue?: string) {
    if (!pathValue) return '未知项目'
    return pathValue.split(/[\\/]/).filter(Boolean).pop() || pathValue
  }

  function groupArchivedSessions(items: ArchivedSession[]) {
    const groups: Array<{ project: string; path: string; items: ArchivedSession[] }> = []
    for (const item of items) {
      const projectPath = item.cwd || ''
      let group = groups.find((row) => row.path === projectPath)
      if (!group) {
        group = { project: projectName(projectPath), path: projectPath, items: [] }
        groups.push(group)
      }
      group.items.push(item)
    }
    return groups
  }

  function formatArchiveTime(timestamp?: number) {
    if (!timestamp) return ''
    return new Date(timestamp).toLocaleString([], { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  async function loadArchivedSessions() {
    if (!rpc || !connected || archivedBusy) return
    archivedBusy = true
    archivedNotice = ''
    try {
      const all = await rpc('list_all_sessions', {}) as ArchivedSession[]
      archivedSessions = all.filter((item) => item.archived)
    } catch (error) {
      archivedNotice = error instanceof Error ? error.message : '读取归档聊天失败'
      archivedSessions = []
    } finally {
      archivedBusy = false
    }
  }

  async function restoreArchivedSession(session: ArchivedSession) {
    archivedNotice = ''
    try {
      if (onRestoreArchived) await onRestoreArchived(session)
      else await rpc?.('set_session_archived', { sessionId: session.id, archived: false })
      archivedSessions = archivedSessions.filter((item) => item.id !== session.id)
    } catch (error) {
      archivedNotice = error instanceof Error ? error.message : '取消归档失败'
    }
  }

  async function deleteArchivedSession(session: ArchivedSession) {
    if (!window.confirm(`确定永久删除会话「${session.title}」吗？删除后无法恢复。`)) return
    await deleteArchivedRow(session)
  }

  async function deleteArchivedRow(session: ArchivedSession) {
    archivedNotice = ''
    try {
      if (onDeleteArchived) await onDeleteArchived(session)
      else {
        const response = await rpc?.('delete_session', { sessionId: session.id, file: session.file }) as { ok?: boolean } | undefined
        if (response && response.ok === false) throw new Error('删除会话失败')
      }
      archivedSessions = archivedSessions.filter((item) => item.id !== session.id)
    } catch (error) {
      archivedNotice = error instanceof Error ? error.message : '删除会话失败'
    }
  }

  async function deleteAllArchived() {
    if (!archivedSessions.length || !window.confirm(`确定永久删除全部 ${archivedSessions.length} 个归档会话吗？删除后无法恢复。`)) return
    archivedNotice = ''
    for (const session of [...archivedSessions]) await deleteArchivedRow(session)
  }

  async function oauthLogin(provider: string) {
    oauthNotice = '正在打开登录…'
    try {
      const result = await rpc?.('oauth_login', { provider }) as { ok?: boolean; message?: string }
      oauthNotice = result?.ok ? (result.message || '已登录') : `${result?.message || '登录失败'}`
    } catch (error) {
      oauthNotice = error instanceof Error ? error.message : '失败'
    }
  }

  async function saveVision() {
    ecoNotice = ''
    try {
      vision = await rpc?.('vision_set', vision) as typeof vision
      ecoNotice = '视觉桥已保存'
    } catch (error) {
      ecoNotice = error instanceof Error ? error.message : '保存失败'
    }
  }

  function heatDays() {
    const map = usageStats?.byDay ?? {}
    const days: Array<{ date: string; value: number }> = []
    const today = new Date()
    for (let i = 83; i >= 0; i--) {
      const date = new Date(today)
      date.setDate(today.getDate() - i)
      const key = date.toISOString().slice(0, 10)
      days.push({ date: key, value: map[key] ?? 0 })
    }
    return days
  }

  function heatTone(value: number) {
    if (!value) return '#efefef'
    if (value < 2000) return '#d6d6d6'
    if (value < 20000) return '#9a9a9a'
    if (value < 80000) return '#555'
    return '#171717'
  }

  async function enableNotify(kind: 'notifyDone' | 'notifyConfirm', checked: boolean) {
    notifyError = ''
    if (checked && 'Notification' in window && Notification.permission !== 'granted') {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        notifyError = '浏览器未授予通知权限'
        return
      }
    }
    commit({ [kind]: checked })
  }
</script>

<svelte:window on:keydown={(event) => { if (open && event.key === 'Escape') onclose() }} />

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="overlay" role="presentation" on:click={(event) => { if (event.target === event.currentTarget) onclose() }}>
    <div class="card" role="dialog" aria-modal="true" aria-label="设置">
      <header class="head">
        <h2>设置</h2>
        <div class="panes" role="tablist" aria-label="设置分区">
          <button class:on={pane === 'settings'} on:click={() => setPane('settings')}>系统设置</button>
          <button class:on={pane === 'config'} on:click={() => setPane('config')}>模型管理</button>
        </div>
        <div class="head-actions">
          <button class="close" aria-label="关闭" on:click={onclose}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>
          </button>
        </div>
      </header>

      <div class="main">
        <div class="pane-host" class:off={pane !== 'settings'}>
        <nav class="nav" aria-label="设置分类">
          {#each NAV as section, index (section.group)}
            {#if index > 0}<div class="nav-divider"></div>{/if}
            {#each section.items as [value, label] (value)}
              <button class="nav-item" class:active={tab === value} on:click={() => setTab(value)}>{label}</button>
            {/each}
          {/each}
        </nav>

        <div class="content">
          {#if tab === 'general'}
            <section class="group">
              <h3>运行时</h3>
              <div class="row">
                <span class="k">Sidecar</span>
                <span class="chip" class:on={connected}><i></i>{connected ? '已连接' : '未连接'}</span>
              </div>
              <div class="row">
                <span class="k">当前工作区</span>
                <span class="path" title={workspacePath ?? ''}>{workspaceBase()}</span>
                {#if onChooseWorkspace}<button on:click={onChooseWorkspace}>更换</button>{/if}
              </div>
              <label class="check-row">
                <input type="checkbox" checked={prefs.restoreWorkspace} on:change={(event) => commit({ restoreWorkspace: (event.currentTarget as HTMLInputElement).checked })} />
                <span>启动时恢复上次工作区</span>
              </label>
            </section>

            <section class="group">
              <h3>对话</h3>
              <div class="choice-block">
                <span class="choice-label">新会话默认权限</span>
                <div class="choice-row">
                  {#each MODES as [value, label] (value)}
                    <button class="choice" class:on={prefs.mode === value} on:click={() => commit({ mode: value })}>{label}</button>
                  {/each}
                </div>
                <p class="desc">{MODES.find((item) => item[0] === prefs.mode)?.[2]}</p>
              </div>
              <label class="think-row">
                <span>默认思考档位</span>
                <input type="range" min="0" max="6" step="1" value={THINKING_LEVELS.indexOf(prefs.thinking)} on:input={(event) => commit({ thinking: THINKING_LEVELS[Number((event.currentTarget as HTMLInputElement).value)] })} />
                <span class="think-value">{THINKING_LABELS[prefs.thinking] ?? prefs.thinking}</span>
              </label>
              <div class="choice-block">
                <span class="choice-label">发送快捷键</span>
                <div class="choice-row">
                  <button class="choice" class:on={prefs.sendShortcut === 'enter'} on:click={() => commit({ sendShortcut: 'enter' as SendShortcut })}>Enter 发送</button>
                  <button class="choice" class:on={prefs.sendShortcut === 'ctrl-enter'} on:click={() => commit({ sendShortcut: 'ctrl-enter' as SendShortcut })}>Ctrl+Enter 发送</button>
                </div>
                <p class="desc">{prefs.sendShortcut === 'enter' ? 'Shift+Enter 换行。' : 'Enter 换行，Ctrl+Enter 发送。'}</p>
              </div>
              <div class="choice-block">
                <span class="choice-label">运行中再发送</span>
                <div class="choice-row">
                  <button class="choice" class:on={prefs.busySend === 'steer'} on:click={() => commit({ busySend: 'steer' as BusySend })}>插话</button>
                  <button class="choice" class:on={prefs.busySend === 'followUp'} on:click={() => commit({ busySend: 'followUp' as BusySend })}>排队</button>
                </div>
                <p class="desc">{prefs.busySend === 'steer' ? '打断当前回合，立刻跟进。' : '排到当前任务后面。Alt+Enter 仍可强制排队。'}</p>
              </div>
              <label class="check-row">
                <input type="checkbox" checked={prefs.autoName} on:change={(event) => commit({ autoName: (event.currentTarget as HTMLInputElement).checked })} />
                <span>自动命名会话</span>
              </label>
              <p class="desc">首次发送时用内容前 20 字作为标题。</p>
              <label class="check-row">
                <input type="checkbox" checked={prefs.showThinking} on:change={(event) => commit({ showThinking: (event.currentTarget as HTMLInputElement).checked })} />
                <span>显示模型思考内容</span>
              </label>
              <p class="desc">关闭后仍会正常推理，只隐藏思考过程。</p>
            </section>

            <section class="group">
              <h3>终端</h3>
              <div class="radio-list">
                {#each SHELLS as [value, label, desc] (value)}
                  <label class="radio-row">
                    <input type="radio" name="shell" value={value} checked={prefs.shell === value} on:change={() => commit({ shell: value })} />
                    <span class="radio-copy"><strong>{label}</strong><small>{desc}</small></span>
                  </label>
                {/each}
              </div>
            </section>
          {:else if tab === 'appearance'}
            <section class="group">
              <h3>皮肤</h3>
              <div class="skin-grid">
                {#each SKINS as skin (skin.id)}
                  <button class="skin-card" class:on={prefs.skin === skin.id} on:click={() => commit({ skin: skin.id as SkinId })}>
                    <span class="skin-swatch" style={`background:${skin.preview.bg}`}>
                      <i style={`background:${skin.preview.sidebar}`}></i>
                      <i style={`background:${skin.preview.panel}`}></i>
                      <i style={`background:${skin.preview.accent}`}></i>
                    </span>
                    <strong>{skin.label}</strong>
                    <small>{skin.desc}</small>
                  </button>
                {/each}
              </div>
              <p class="desc">整套换色，不止深浅。根节点换一套 CSS 设计令牌，布局不变。</p>
            </section>
            <section class="group">
              <h3>明暗</h3>
              <div class="choice-row">
                <button class="choice" class:on={prefs.theme === 'light'} on:click={() => commit({ theme: 'light' as ThemePref })}>浅色</button>
                <button class="choice" class:on={prefs.theme === 'dark'} on:click={() => commit({ theme: 'dark' as ThemePref })}>深色</button>
                <button class="choice" class:on={prefs.theme === 'system'} on:click={() => commit({ theme: 'system' as ThemePref })}>跟随系统</button>
              </div>
              <p class="desc">深色会覆盖表面/文字/边框令牌，保留所选皮肤的主色。</p>
            </section>
            <section class="group">
              <h3>密度</h3>
              <div class="choice-row">
                <button class="choice" class:on={prefs.density === 'comfortable'} on:click={() => commit({ density: 'comfortable' as Density })}>舒适</button>
                <button class="choice" class:on={prefs.density === 'compact'} on:click={() => commit({ density: 'compact' as Density })}>紧凑</button>
              </div>
              <p class="desc">紧凑模式缩小输入框和会话行间距。</p>
            </section>
            <section class="group">
              <h3>空状态</h3>
              <label class="check-row">
                <input type="checkbox" checked={prefs.showQuickChips} on:change={(event) => commit({ showQuickChips: (event.currentTarget as HTMLInputElement).checked })} />
                <span>显示快捷提问</span>
              </label>
              <p class="desc">在空白会话显示「分析项目 / 检查变更 / 总结 README」。</p>
            </section>
          {:else if tab === 'notify'}
            <section class="group">
              <h3>桌面通知</h3>
              <label class="check-row">
                <input type="checkbox" checked={prefs.notifyDone} on:change={(event) => void enableNotify('notifyDone', (event.currentTarget as HTMLInputElement).checked)} />
                <span>任务完成时通知</span>
              </label>
              <label class="check-row">
                <input type="checkbox" checked={prefs.notifyConfirm} on:change={(event) => void enableNotify('notifyConfirm', (event.currentTarget as HTMLInputElement).checked)} />
                <span>需要确认工具时通知</span>
              </label>
              {#if notifyError}<p class="desc warn">{notifyError}</p>{/if}
              <p class="desc">首次开启时会向系统申请通知权限。</p>
            </section>
          {:else if tab === 'keys'}
            <section class="group">
              <h3>快捷键</h3>
              <div class="keys">
                {#each SHORTCUTS as [action, combo] (action)}
                  <div class="key-row"><span>{action}</span><kbd>{combo}</kbd></div>
                {/each}
              </div>
              <p class="desc">发送快捷键可在「通用」里切换。</p>
            </section>
          {:else if tab === 'proxy'}
            <section class="group">
              <h3>桌面端代理</h3>
              <p class="desc">用于连接测试和用量查询。Node fetch 不一定走系统代理，保存后 sidecar 会写入环境变量。</p>
              <div class="choice-row">
                <button class="choice" class:on={proxyDraft.desktop.mode !== 'on'} on:click={() => (proxyDraft = { ...proxyDraft, desktop: { ...proxyDraft.desktop, mode: 'off' } })}>关闭</button>
                <button class="choice" class:on={proxyDraft.desktop.mode === 'on'} on:click={() => (proxyDraft = { ...proxyDraft, desktop: { ...proxyDraft.desktop, mode: 'on' } })}>开启</button>
              </div>
              <label class="field-row" style="margin-top:10px"><span>地址</span><input bind:value={proxyDraft.desktop.url} placeholder="http://127.0.0.1:7890" /></label>
            </section>
            <section class="group">
              <h3>Agent 子进程代理</h3>
              <p class="desc">写入 HTTP_PROXY / HTTPS_PROXY，对之后新建的会话生效。</p>
              <div class="choice-row">
                <button class="choice" class:on={proxyDraft.agent.mode !== 'on'} on:click={() => (proxyDraft = { ...proxyDraft, agent: { ...proxyDraft.agent, mode: 'off' } })}>关闭</button>
                <button class="choice" class:on={proxyDraft.agent.mode === 'on'} on:click={() => (proxyDraft = { ...proxyDraft, agent: { ...proxyDraft.agent, mode: 'on' } })}>开启</button>
              </div>
              <label class="field-row" style="margin-top:10px"><span>地址</span><input bind:value={proxyDraft.agent.url} placeholder="http://127.0.0.1:7890" /></label>
              <div class="choice-row" style="margin-top:12px"><button class="choice on" on:click={() => void saveProxy()}>保存代理</button></div>
            </section>
          {:else if tab === 'agents'}
            <section class="group">
              <h3>内置</h3>
              {#each agentList.filter((item) => item.builtin) as def (def.name)}
                <div class="agent-card">
                  <strong>{def.name}</strong>
                  <p>{def.description}</p>
                  <small>模式 {def.mode === 'plan' ? '只读' : def.mode}</small>
                </div>
              {/each}
            </section>
            <section class="group">
              <h3>自定义</h3>
              {#each agentList.filter((item) => !item.builtin) as def (def.name)}
                <div class="agent-card">
                  <strong>{def.name}</strong>
                  <p>{def.description || def.systemPrompt.slice(0, 80)}</p>
                  <button class="ghost" on:click={() => { agentList = removeAgent(def.name); onPrefsChange() }}>删除</button>
                </div>
              {:else}
                <p class="muted">还没有自定义 agent。保存后可用 /agent 名称 任务 调用。</p>
              {/each}
              <label class="field-row"><span>名称</span><input bind:value={agentDraft.name} placeholder="reviewer" /></label>
              <label class="field-row"><span>说明</span><input bind:value={agentDraft.description} placeholder="代码审查" /></label>
              <label class="field-row stack"><span>系统提示</span><textarea rows="4" bind:value={agentDraft.systemPrompt} placeholder="You are ..."></textarea></label>
              <div class="choice-row" style="margin-top:10px">
                <button class="choice" class:on={agentDraft.mode === 'plan'} on:click={() => (agentDraft = { ...agentDraft, mode: 'plan' })}>只读</button>
                <button class="choice" class:on={agentDraft.mode === 'ask'} on:click={() => (agentDraft = { ...agentDraft, mode: 'ask' })}>默认</button>
                <button class="choice" class:on={agentDraft.mode === 'full'} on:click={() => (agentDraft = { ...agentDraft, mode: 'full' })}>完全</button>
              </div>
              <div class="choice-row" style="margin-top:12px">
                <button class="choice on" on:click={() => { if (!agentDraft.name.trim() || !agentDraft.systemPrompt.trim()) return; agentList = upsertAgent(agentDraft); agentDraft = { name: '', description: '', systemPrompt: '', mode: 'plan' }; onPrefsChange() }}>保存 agent</button>
              </div>
            </section>
          {:else if tab === 'imagegen'}
            <section class="group">
              <h3>生图配置</h3>
              <p class="desc">仅支持 OpenAI 兼容的图片生成接口。密钥保存在本机。</p>
              <label class="field-row"><span>接口地址</span><input value={imageGenConfig.baseUrl} on:input={(event) => updateImageGen('baseUrl', (event.currentTarget as HTMLInputElement).value)} placeholder="https://api.example.com/v1" /></label>
              <label class="field-row"><span>API Key</span><input type="password" value={imageGenConfig.apiKey} on:input={(event) => updateImageGen('apiKey', (event.currentTarget as HTMLInputElement).value)} placeholder="sk-…" /></label>
              <label class="field-row"><span>模型名称</span><input value={imageGenConfig.model} on:input={(event) => updateImageGen('model', (event.currentTarget as HTMLInputElement).value)} placeholder="dall-e-3" /></label>
              <label class="field-row"><span>图片尺寸</span><select value={imageGenConfig.size} on:change={(event) => updateImageGen('size', (event.currentTarget as HTMLSelectElement).value)}><option value="1024x1024">1024 × 1024</option><option value="1536x1024">1536 × 1024</option><option value="1024x1536">1024 × 1536</option></select></label>
            </section>
          {:else if tab === 'git'}
            <section class="group">
              <h3>提交</h3>
              <label class="field-row stack"><span>默认提交说明</span><input value={prefs.gitTemplate} on:input={(event) => commit({ gitTemplate: (event.currentTarget as HTMLInputElement).value })} placeholder="留空则每次手动填写" /></label>
              <p class="desc">右侧 Git 面板提交时，若输入框为空则使用这段说明。</p>
            </section>
          {:else if tab === 'usage'}
            <section class="group usage-group">
              <div class="section-head"><div><h3>用量统计</h3><p class="desc">按当前工作区的 Pi 会话统计。</p></div><button class="ghost" on:click={() => onRefreshUsage?.()}>刷新</button></div>
              <div class="usage-cards">
                <div class="usage-card"><small>总 Token</small><strong>{formatTokens(usageStats?.totals.total ?? 0)}</strong><span>输入 {formatTokens(usageStats?.totals.input ?? 0)}</span></div>
                <div class="usage-card"><small>会话数</small><strong>{usageStats?.sessions ?? 0}</strong><span>活跃 {usageStats?.activeDays ?? 0} 天</span></div>
                <div class="usage-card"><small>对话轮次</small><strong>{usageStats?.turns ?? 0}</strong><span>当前工作区</span></div>
                <div class="usage-card"><small>费用估算</small><strong>{usageStats?.costKnown ? `$${(usageStats.costUsd ?? 0).toFixed(2)}` : '—'}</strong><span>{usageStats?.costKnown ? '按模型费率' : '暂无费率数据'}</span></div>
              </div>
            </section>
            <section class="group">
              <h3>活跃热力图</h3>
              <div class="heat">{#each heatDays() as day (day.date)}<i title={`${day.date} · ${formatTokens(day.value)}`} style={`background:${heatTone(day.value)}`}></i>{/each}</div>
              <p class="desc">近 12 周，颜色越深当天 token 越多。</p>
            </section>
            <section class="group">
              <h3>模型用量</h3>
              {#if usageStats?.byModel?.length}
                <div class="usage-table"><div class="usage-table-head"><span>模型</span><span>Token</span><span>轮次</span></div>{#each usageStats.byModel as item (item.model)}<div class="usage-table-row"><span title={item.model}>{item.model}</span><span>{formatTokens(item.tokens)}</span><span>{item.turns}</span></div>{/each}</div>
              {:else}
                <p class="muted">暂无用量记录</p>
              {/if}
            </section>
            <section class="group">
              <h3>项目用量</h3>
              {#if usageStats?.byProject?.length}
                <div class="usage-table"><div class="usage-table-head"><span>项目</span><span>Token</span><span>轮次</span></div>{#each usageStats.byProject as item (item.project)}<div class="usage-table-row"><span title={item.project}>{item.project}</span><span>{formatTokens(item.tokens)}</span><span>{item.turns}</span></div>{/each}</div>
              {:else}
                <p class="muted">暂无项目维度数据</p>
              {/if}
            </section>
          {:else if tab === 'skills'}
            <section class="group">
              <h3>Skills</h3>
              <p class="desc">全局 ~/.pi/agent/skills 与项目 .pi/skills。禁用会把文件改名为 .disabled。</p>
              {#if ecoNotice}<p class="desc">{ecoNotice}</p>{/if}
              {#each eco.skills as item (item.id)}
                <div class="p-head" style="padding:8px 0">
                  <span class="p-name">{String(item.name)}</span>
                  <span class="badge" class:on={Boolean(item.enabled)}>{item.sourceLabel} · {item.enabled ? '启用' : '停用'}</span>
                  <button class="ghost" on:click={() => void toggleItem(item, !item.enabled)}>{item.enabled ? '禁用' : '启用'}</button>
                </div>
              {:else}
                <p class="muted">还没有 Skill。可从商店导入。</p>
              {/each}
            </section>
          {:else if tab === 'extensions'}
            <section class="group">
              <h3>扩展</h3>
              <p class="desc">内置空响应重试已随 sidecar 加载。图片生成技能可一键安装为 Skill。</p>
              {#if ecoNotice}<p class="desc">{ecoNotice}</p>{/if}
              {#each eco.extensions as item (item.id)}
                <div class="p-card">
                  <div class="p-head">
                    <span class="p-name">{String(item.name)}</span>
                    <span class="badge" class:on={Boolean(item.enabled || item.builtin)}>{item.sourceLabel}</span>
                    {#if item.id === 'builtin:imagegen-skill'}
                      <button class="ghost" on:click={() => void toggleItem(item, true)}>安装模板</button>
                    {:else if item.path === 'builtin'}
                      <span class="provider-count">已内置</span>
                    {:else if item.source === 'npm'}
                      <span class="provider-count">已安装</span>
                      <button class="ghost" disabled={extensionBusy[extensionKey(item)]} on:click={() => void uninstallPackage(item)}>{extensionBusy[extensionKey(item)] ? '卸载中…' : '卸载'}</button>
                      {#if extensionNotice[extensionKey(item)]}<span class="inline-notice" class:error={extensionNotice[extensionKey(item)].startsWith('卸载失败')}>{extensionNotice[extensionKey(item)]}</span>{/if}
                    {:else}
                      <button class="ghost" on:click={() => void toggleItem(item, !item.enabled)}>{item.enabled ? '禁用' : '启用'}</button>
                    {/if}
                  </div>
                  {#if item.description}<p class="desc">{String(item.description)}</p>{/if}
                </div>
              {/each}
            </section>
          {:else if tab === 'store'}
            <section class="group">
              <div class="choice-row">
                <button class="choice" class:on={storeTab === 'prompts'} on:click={() => setStoreTab('prompts')}>prompts.chat</button>
                <button class="choice" class:on={storeTab === 'skills'} on:click={() => setStoreTab('skills')}>skills.sh</button>
                <button class="choice" class:on={storeTab === 'extensions'} on:click={() => setStoreTab('extensions')}>pi 官方插件</button>
                <button class="choice" class:on={storeTab === 'xue'} on:click={() => setStoreTab('xue')}>中文精选</button>
              </div>
              <p class="desc">默认显示各源热门内容，按投票 / 下载排序。pi 官方插件来自 pi.dev/packages（npm 的 pi-package 标签）。</p>
              <div class="todo-add store-search-row" style="padding:12px 0 0">
                <input bind:value={storeQuery} placeholder={storeTab === 'xue' ? '搜索中文提示词' : '搜索…'} on:keydown={(event) => { if (event.key === 'Enter') { event.preventDefault(); storeTab === 'xue' ? void loadXue(1) : void runStoreSearch() } }} />
                <select bind:value={storeSort} aria-label="商店排序">
                  <option value="recommended">推荐顺序</option>
                  <option value="popular">下载 / 票数</option>
                  <option value="name">名称 A-Z</option>
                  <option value="updated">更新时间</option>
                </select>
                <button class="ghost" on:click={() => storeTab === 'xue' ? void loadXue(1) : void runStoreSearch()}>搜索</button>
              </div>
              {#if storeBusy}<p class="desc">{storeBusy}</p>{/if}
              {#if ecoNotice}<p class="desc">{ecoNotice}</p>{/if}
            </section>
            {#if storeTab === 'xue'}
              <section class="group">
                <div class="choice-row">
                  <button class="choice" class:on={!xueCategory} on:click={() => { xueCategory = ''; void loadXue(1) }}>全部</button>
                  {#each xue.categories as cat}<button class="choice" class:on={xueCategory === cat} on:click={() => { xueCategory = cat; void loadXue(1) }}>{cat}</button>{/each}
                </div>
                <p class="desc">{xue.note}</p>
                {#each sortedXueItems as item (item.id)}
                  <div class="p-card">
                    <strong>{String(item.title)}</strong>
                    <p class="desc">{String(item.content)}</p>
                    <button class="ghost" on:click={() => void importStoreItem({ title: item.title, description: item.category, content: item.content }, 'prompt')}>导入模板</button>
                  </div>
                {/each}
              </section>
            {:else}
              <section class="group">
                {#each sortedStoreItems as item, index (item.id || item.slug || item.name || index)}
                  <div class="p-card">
                  <div class="p-head">
                      <span class="p-name">{String(item.title || item.name)}</span>
                      {#if storeTab === 'prompts' && item.featured}<span class="badge on">精选</span>{/if}
                      {#if storeTab === 'prompts' && item.votes}<span class="badge">{formatCount(item.votes)} 票</span>{/if}
                      {#if storeTab === 'skills' && item.installs}<span class="badge">{formatCount(item.installs)} 下载</span>{/if}
                      {#if storeTab === 'extensions'}<span class="badge">{String(item.version || '')}</span><span class="badge">{formatCount(item.downloads)} 下载/周</span>{/if}
                    </div>
                    <p class="desc">{String(item.description || item.source || item.url || '')}</p>
                    {#if storeTab === 'prompts'}
                      <button class="ghost" on:click={() => void importStoreItem(item, 'prompt')}>导入提示词</button>
                      <button class="ghost" on:click={() => void importStoreItem(item, 'skill')}>装为 Skill</button>
                    {:else if storeTab === 'skills'}
                      <button class="ghost" on:click={() => void importStoreItem({ title: item.name, description: item.source, content: `来源 skills.sh / ${item.slug}` }, 'skill')}>安装占位 Skill</button>
                    {:else if storeTab === 'extensions'}
                      <button class="ghost" on:click={() => void installPackage(item)}>安装</button>
                      {#if item.url}<a class="desc" href={String(item.url)} target="_blank" rel="noreferrer">打开 npm</a>{/if}
                    {/if}
                  </div>
                {:else}
                  <p class="muted">暂无结果。输入关键词搜索，或检查网络后重试。</p>
                {/each}
              </section>
            {/if}
          {:else if tab === 'vision'}
            <section class="group">
              <h3>视觉桥</h3>
              <p class="desc">不支持看图的模型：附件图片先转成文字描述再进入会话。</p>
              <label class="check-row"><input type="checkbox" checked={vision.enabled} on:change={(event) => (vision = { ...vision, enabled: (event.currentTarget as HTMLInputElement).checked })} /><span>启用视觉桥</span></label>
              <label class="field-row"><span>接口</span><input bind:value={vision.baseUrl} placeholder="https://api.openai.com/v1" /></label>
              <label class="field-row"><span>模型</span><input bind:value={vision.model} placeholder="gpt-4o-mini" /></label>
              <label class="field-row"><span>API Key</span><input type="password" bind:value={vision.apiKey} placeholder="sk-…" /></label>
              <label class="field-row stack"><span>提示词</span><textarea rows="4" bind:value={vision.promptTemplate}></textarea></label>
              {#if ecoNotice}<p class="desc">{ecoNotice}</p>{/if}
              <div class="choice-row" style="margin-top:12px"><button class="choice on" on:click={() => void saveVision()}>保存</button></div>
            </section>
          {:else if tab === 'pet'}
            <section class="group">
              <h3>桌宠</h3>
              <label class="check-row">
                <input type="checkbox" checked={prefs.petEnabled} on:change={(event) => commit({ petEnabled: (event.currentTarget as HTMLInputElement).checked })} />
                <span>在窗口右下角显示桌宠</span>
              </label>
            </section>
            <section class="group">
              <h3>选择桌宠</h3>
              <div class="choice-row" style="margin-bottom:12px">
                <button class="choice" class:on={!prefs.petModel} on:click={() => commit({ petModel: '' })}>默认（像素猫）</button>
              </div>
              <div class="pet-grid">
                {#each PETS as pet (pet.id)}
                  <div class="pet-card" class:on={prefs.petModel === pet.id} role="button" tabindex="0" on:click={() => commit({ petModel: pet.id })} on:keydown={(event) => { if (event.key === 'Enter') commit({ petModel: pet.id }) }}>
                    <span class="pet-thumb"><img src={petPreviewUrl(pet)} alt={pet.name} loading="lazy" /></span>
                    <span class="pet-name">{pet.name}<em class="pet-type">{pet.type === 'sprite' ? '精灵' : 'Live2D'}</em></span>
                    <small>{pet.description}</small>
                    <span class="pet-actions">
                      <button class="ghost" on:click={() => void downloadPet(pet)}>下载缓存</button>
                    </span>
                  </div>
                {/each}
              </div>
              {#if petNotice}<p class="desc">{petNotice}</p>{/if}
              <p class="desc">首次使用会从网络加载，点「下载缓存」后离线可用。</p>
            </section>
          {:else if tab === 'lan'}
            <section class="group">
              <h3>局域网观察</h3>
              <p class="desc">开启后手机和电脑同一 Wi-Fi 可只读看会话进度。带随机 token，不要发到公网。</p>
              <label class="check-row">
                <input type="checkbox" checked={Boolean(lanStatus?.enabled)} disabled={lanBusy || !connected} on:change={(event) => void setLan((event.currentTarget as HTMLInputElement).checked)} />
                <span>启用观察服务</span>
              </label>
              {#if lanStatus?.enabled}
                <p class="desc">端口 {lanStatus.port ?? '—'} · 连接 {lanStatus.clients ?? 0}</p>
                {#each lanStatus.urls || [] as url}
                  <div class="row"><span class="path">{url}</span><button on:click={() => void navigator.clipboard.writeText(url)}>复制</button></div>
                {/each}
                {#if lanStatus.urls?.[0]}
                  <img alt="二维码" style="width:160px;height:160px;margin-top:8px;background:#fff;padding:6px;border-radius:8px" src={`https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(lanStatus.urls[0])}`} />
                {/if}
              {/if}
            </section>
          {:else if tab === 'archived'}
            <section class="group archived-group">
              <div class="section-head">
                <div>
                  <h3>已归档的聊天</h3>
                  <p class="desc">归档只负责收起会话，不会删除内容。</p>
                </div>
                <button class="danger-ghost" disabled={!archivedSessions.length || archivedBusy} on:click={() => void deleteAllArchived()}>全部删除</button>
              </div>
              <input class="archive-search" bind:value={archivedQuery} placeholder="搜索已归档聊天" aria-label="搜索已归档聊天" />
              {#if archivedNotice}<p class="inline-notice error">{archivedNotice}</p>{/if}
              {#if archivedBusy}
                <p class="desc">正在读取归档聊天…</p>
              {:else}
                <div class="archive-list">
                  {#each archivedGroups as group (group.path || group.project)}
                    <div class="archive-project">
                      <div class="archive-project-head">
                        <strong>{group.project}</strong>
                        <span>{group.items.length} 个聊天</span>
                      </div>
                      {#each group.items as session (session.id)}
                        <div class="archive-row">
                          <div class="archive-copy">
                            <strong>{session.title}</strong>
                            <small>{formatArchiveTime(session.modifiedAt)}{session.cwd ? ` · ${session.cwd}` : ''}</small>
                          </div>
                          <button class="ghost" on:click={() => void restoreArchivedSession(session)}>取消归档</button>
                          <button class="archive-delete" on:click={() => void deleteArchivedSession(session)}>删除</button>
                        </div>
                      {/each}
                    </div>
                  {:else}
                    <div class="archive-empty">还没有归档的聊天</div>
                  {/each}
                </div>
              {/if}
            </section>
          {:else if tab === 'logs'}
            <section class="group">
              <div class="section-head"><h3>Sidecar 日志</h3><button class="ghost" on:click={() => void loadLogs()}>刷新</button></div>
              <pre class="log-box">{logLines.join('\n') || '暂无日志'}</pre>
            </section>
          {:else if tab === 'storage'}
            <section class="group">
              <h3>本地目录</h3>
              <div class="row">
                <span class="k">Agent 目录</span>
                <span class="path" title={info?.agentDir}>{info?.agentDir ?? '—'}</span>
                <button disabled={!connected || !info?.agentDir} on:click={() => info && openDir(info.agentDir)}>打开</button>
              </div>
              <div class="row">
                <span class="k">会话目录</span>
                <span class="path" title={info?.sessionDir}>{info?.sessionDir ?? '—'}</span>
                <button disabled={!connected || !info?.sessionDir} on:click={() => info && openDir(info.sessionDir)}>打开</button>
              </div>
              <div class="row">
                <span class="k">Skills</span>
                <span class="path">{info?.agentDir ? `${info.agentDir}\\skills` : '—'}</span>
                <button disabled={!connected || !info?.agentDir} on:click={() => info && openDir(`${info.agentDir}\\skills`)}>打开</button>
              </div>
              <p class="desc">Skills 放在 Agent 目录的 skills 文件夹，下次会话会加载。</p>
            </section>
          {:else if tab === 'about'}
            <section class="group">
              <h3>关于</h3>
              <div class="row"><span class="k">版本</span><span class="v">v{version}</span></div>
              <div class="row"><span class="k">技术栈</span><span class="v">Tauri 2 · Svelte 5 · 官方 Pi SDK</span></div>
              <div class="row"><span class="k">Node</span><span class="v">{info?.node ?? '—'}</span></div>
              <div class="row"><span class="k">运行中的 SDK</span><span class="v">{info?.sdk ?? '—'}</span></div>
              <div class="row">
                <span class="k">官方 Pi SDK</span>
                <span class="v">当前 {agentUpdate?.current ?? info?.sdk ?? '—'}{#if agentUpdate?.sourceLabel}<small class="source-note"> · {agentUpdate.sourceLabel}</small>{/if}</span>
              </div>
              <div class="row">
                <span class="k">最新版本</span>
                <span class:latest-update={agentUpdate?.updateAvailable} class="v">
                  {agentUpdate?.latest ?? '—'}
                  {#if agentUpdate?.updated}
                    <span class="badge on">已安装，重启生效</span>
                  {:else if agentUpdate?.updateAvailable}
                    <span class="badge on">有新版本</span>
                  {:else if agentUpdate}
                    <span class="badge">已是最新</span>
                  {/if}
                </span>
                <button disabled={agentUpdateBusy || !connected || !onCheckAgentUpdate} on:click={() => onCheckAgentUpdate?.()}>
                  {agentUpdateBusy ? '检查中…' : '检查更新'}
                </button>
              </div>
              {#if agentUpdate?.updateAvailable && onUpdateAgent}
                <div class="row">
                  <span class="k">更新 Pi SDK</span>
                  <button disabled={agentUpdateBusy || !connected} on:click={onUpdateAgent}>{agentUpdateBusy ? '安装中…' : '直接更新'}</button>
                  {#if onOpenAgentUpdate}<button on:click={onOpenAgentUpdate}>打开 npm</button>{/if}
                </div>
              {/if}
              {#if agentUpdate?.message}<p class="desc">{agentUpdate.message}</p>{/if}
              <div class="row">
                <span class="k">仓库</span>
                <span class="v">github.com/TANGZZee/pi-my</span>
                {#if onOpenRepo}<button on:click={onOpenRepo}>打开</button>{/if}
              </div>
              <div class="row">
                <span class="k">Pi 官方仓库</span>
                <span class="v">github.com/earendil-works/pi</span>
                {#if onOpenAgentRepo}<button on:click={onOpenAgentRepo}>打开</button>{/if}
              </div>
            </section>
          {/if}
        </div>
        </div>
        <div class="pane-host" class:off={pane !== 'config'}>
          <ConfigPane open={open} connected={connected} rpc={rpc} bind:dirty={configDirty} saveHandler={configSaveHandler} onRefreshProviders={onRefreshProviders} />
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; padding: 24px; background: rgb(23 23 23 / .28); }
  .card { display: flex; flex-direction: column; width: min(1200px, 88vw); height: min(780px, 86vh); overflow: hidden; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 22px 60px rgb(0 0 0 / 18%); }
  .head { flex: none; display: flex; align-items: center; gap: 16px; height: 56px; padding: 0 16px; border-bottom: 1px solid var(--border-2); }
  .head h2 { margin: 0; color: var(--text); font-size: 15px; font-weight: 650; }
  .panes { display: flex; gap: 2px; padding: 3px; border-radius: 8px; background: var(--hover); }
  .panes button { height: 30px; padding: 0 12px; border-radius: 6px; background: transparent; color: var(--text-3); font-size: 13px; }
  .panes button.on { background: var(--raised); color: var(--text); font-weight: 650; box-shadow: 0 1px 2px rgb(0 0 0 / 8%); }
  .head-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
  .close { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 6px; background: transparent; color: var(--muted); }
  .close:hover { background: var(--hover); color: var(--text); }
  .main { flex: 1; display: flex; min-height: 0; background: var(--surface); }
  .pane-host { display: flex; flex: 1; min-width: 0; min-height: 0; }
  .pane-host.off { display: none; }
  .nav { flex: none; width: 196px; padding: 10px; overflow: auto; border-right: 1px solid var(--hover); background: var(--surface); }
  .nav-divider { height: 1px; margin: 8px 8px; background: var(--hover); }
  .nav-item { display: flex; align-items: center; width: 100%; min-height: 32px; padding: 0 10px; border-radius: 6px; background: transparent; color: var(--text-3); font-size: 13px; text-align: left; }
  .nav-item:hover { background: var(--surface-3); color: var(--text-2); }
  .nav-item.active { background: var(--hover); color: var(--text); font-weight: 650; }
  .content { flex: 1; min-width: 0; overflow: auto; padding: 18px 24px 32px; }
  .group { padding: 0 0 18px; border-bottom: 1px solid var(--hover); }
  .group + .group { margin-top: 18px; }
  .group:last-child { padding-bottom: 0; border-bottom: 0; }
  .group h3 { margin: 0 0 12px; color: var(--muted); font-size: 10px; font-weight: 700; letter-spacing: .08em; }
  .archived-group { max-width: 820px; }
  .archive-search { width: 100%; height: 34px; margin: 4px 0 12px; padding: 0 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--raised); color: var(--text-2); font-size: 12px; }
  .archive-project { margin-top: 12px; overflow: hidden; border: 1px solid var(--border-2); border-radius: 8px; background: var(--raised); }
  .archive-project-head { display: flex; align-items: center; justify-content: space-between; padding: 9px 12px; border-bottom: 1px solid var(--border-2); background: var(--surface-3); }
  .archive-project-head strong { color: var(--text-2); font-size: 12px; }
  .archive-project-head span { color: var(--muted); font-size: 10px; }
  .archive-row { display: flex; align-items: center; gap: 8px; min-height: 54px; padding: 8px 10px 8px 12px; border-top: 1px solid var(--hover); }
  .archive-project-head + .archive-row { border-top: 0; }
  .archive-copy { min-width: 0; flex: 1; }
  .archive-copy strong, .archive-copy small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .archive-copy strong { color: var(--text); font-size: 12px; font-weight: 600; }
  .archive-copy small { margin-top: 3px; color: var(--muted); font-size: 10px; }
  .archive-delete { flex: none; padding: 5px 10px; border-radius: 4px; background: #fbf1ef; color: #a03a32; font-size: 11px; }
  .archive-delete:hover { background: #f6e3df; }
  .danger-ghost { flex: none; margin-left: auto; padding: 5px 10px; border-radius: 4px; background: #fbf1ef; color: #a03a32; font-size: 11px; }
  .danger-ghost:hover:not(:disabled) { background: #f6e3df; }
  .danger-ghost:disabled { opacity: .45; }
  .archive-empty { padding: 36px 0; color: var(--muted); font-size: 12px; text-align: center; }
  .row { display: flex; align-items: center; gap: 10px; min-height: 28px; color: var(--text-2); font-size: 12px; }
  .row + .row { margin-top: 6px; }
  .k { flex: none; width: 92px; color: var(--muted); font-size: 11px; }
  .v, .path { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .path { color: var(--text-3); font: 11px/1.4 ui-monospace, "Cascadia Mono", monospace; }
  .row button, .ghost { flex: none; padding: 5px 10px; border-radius: 4px; background: var(--hover); color: var(--text-2); font-size: 11px; }
  .row button:hover:not(:disabled), .ghost:hover { background: var(--active); }
  .row button:disabled { opacity: .45; }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; border: 1px solid var(--active); border-radius: 999px; background: var(--raised); color: var(--text-3); font-size: 11px; }
  .chip i { width: 6px; height: 6px; border-radius: 50%; background: var(--muted-2); }
  .chip.on i { background: var(--accent); }
  .muted { margin: 0; color: var(--muted-2); font-size: 11px; }
  .check-row { display: flex; align-items: center; gap: 8px; margin-top: 12px; color: var(--text-2); font-size: 12px; }
  .check-row input { accent-color: var(--accent); }
  .desc { margin: 7px 0 0; color: var(--muted-2); font-size: 11px; line-height: 1.5; }
  .desc.warn { color: var(--text-3); }
  .radio-list { display: flex; flex-direction: column; gap: 2px; }
  .radio-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
  .radio-row input { accent-color: var(--accent); }
  .radio-copy { display: flex; flex-direction: column; }
  .radio-copy strong { color: var(--text-2); font-size: 12px; font-weight: 550; }
  .radio-copy small { color: var(--muted); font-size: 10px; }
  .think-row { display: flex; align-items: center; gap: 10px; margin-top: 12px; color: var(--text-2); font-size: 12px; }
  .think-row input[type="range"] { flex: 1; height: 16px; margin: 0; appearance: none; background: transparent; }
  .think-row input[type="range"]::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; background: var(--border-2); }
  .think-row input[type="range"]::-webkit-slider-thumb { width: 14px; height: 14px; margin-top: -5px; appearance: none; border: 1px solid var(--border-3); border-radius: 50%; background: var(--raised); }
  .think-value { flex: none; min-width: 28px; color: var(--text-3); font-size: 11px; text-align: right; }
  .choice-block { margin-top: 14px; }
  .choice-label { display: block; margin-bottom: 7px; color: var(--text-2); font-size: 12px; }
  .choice-row { display: flex; flex-wrap: wrap; gap: 6px; }
  .choice { min-width: 88px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 4px; background: var(--raised); color: var(--text-3); font-size: 11px; }
  .choice.on { border-color: var(--accent); color: var(--text); font-weight: 650; background: var(--surface-3); }
  .skin-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
  .skin-card { display: flex; flex-direction: column; align-items: stretch; gap: 4px; padding: 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--raised); text-align: left; }
  .skin-card.on { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .skin-card strong { color: var(--text); font-size: 12px; }
  .skin-card small { color: var(--muted); font-size: 10px; }
  .skin-swatch { display: grid; grid-template-columns: 30% 1fr 18%; grid-template-rows: repeat(2, 16px); gap: 2px; padding: 4px; border: 1px solid var(--border); border-radius: 5px; }
  .skin-swatch i { display: block; border-radius: 2px; }
  .skin-swatch i:nth-child(1) { grid-row: 1 / 3; }
  .skin-swatch i:nth-child(3) { grid-row: 1 / 3; }
  .pet-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
  .pet-card { display: flex; flex-direction: column; align-items: stretch; gap: 4px; padding: 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--raised); text-align: left; }
  .pet-card.on { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .pet-thumb { display: grid; place-items: center; height: 120px; overflow: hidden; border-radius: 6px; background: var(--surface-2); }
  .pet-thumb img { display: block; max-width: 100%; max-height: 100%; object-fit: contain; }
  .pet-name { color: var(--text); font-size: 12px; font-weight: 600; }
  .pet-type { margin-left: 6px; padding: 1px 5px; border: 1px solid var(--border); border-radius: 999px; color: var(--muted); font-size: 9px; font-style: normal; font-weight: 400; vertical-align: 1px; }
  .pet-card small { color: var(--muted); font-size: 10px; }
  .pet-actions { display: flex; margin-top: 2px; }
  .pet-actions .ghost { padding: 4px 8px; font-size: 10px; }
  .keys { display: grid; gap: 2px; }
  .key-row { display: flex; align-items: center; justify-content: space-between; min-height: 32px; padding: 0 2px; border-bottom: 1px solid var(--surface-3); color: var(--text-2); font-size: 12px; }
  kbd { padding: 3px 7px; border: 1px solid var(--border-2); border-radius: 4px; background: var(--surface-3); color: var(--text-2); font: 11px ui-monospace, "Cascadia Mono", monospace; }
  .section-head { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
  .field-row { display: grid; grid-template-columns: 72px minmax(0, 1fr); align-items: center; gap: 9px; margin-top: 9px; color: var(--text-3); font-size: 11px; }
  .field-row.stack { grid-template-columns: 1fr; }
  .field-row input, .field-row select, .field-row textarea { min-width: 0; width: 100%; padding: 7px 8px; border: 1px solid var(--border); border-radius: 4px; outline: 0; background: var(--raised); color: var(--text-2); font-size: 12px; }
  .agent-card { padding: 10px 0; border-bottom: 1px solid var(--surface-3); }
  .agent-card strong { display: block; color: var(--text); font-size: 13px; }
  .agent-card p { margin: 4px 0; color: var(--text-3); font-size: 11px; }
  .agent-card small { color: var(--muted); font-size: 10px; }
  .agent-card .ghost { margin-top: 6px; }
  .heat { display: grid; grid-template-rows: repeat(7, 10px); grid-auto-flow: column; gap: 3px; }
  .heat i { width: 10px; height: 10px; border-radius: 2px; }
  .p-card { padding: 10px 0; border-bottom: 1px solid var(--surface-3); }
  .p-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .p-name { background: transparent; color: var(--text); font-size: 13px; font-weight: 650; }
  .field-row input:focus, .field-row select:focus { border-color: var(--muted); }
  .usage-cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-top: 12px; }
  .usage-card { min-width: 0; padding: 10px; border: 1px solid var(--border-2); border-radius: 6px; background: var(--surface-3); }
  .usage-card small, .usage-card span { display: block; color: var(--muted); font-size: 10px; }
  .usage-card strong { display: block; margin: 5px 0 4px; color: var(--text-2); font-size: 16px; font-weight: 650; }
  .usage-table { overflow: hidden; border: 1px solid var(--border-2); border-radius: 6px; }
  .usage-table-head, .usage-table-row { display: grid; grid-template-columns: minmax(0, 1fr) 74px 48px; gap: 8px; align-items: center; padding: 7px 9px; font-size: 11px; }
  .usage-table-head { background: var(--surface-3); color: var(--muted); font-size: 10px; }
  .usage-table-row { border-top: 1px solid var(--hover); color: var(--text-2); }
  .usage-table-row span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .usage-table-row span:not(:first-child), .usage-table-head span:not(:first-child) { font-variant-numeric: tabular-nums; text-align: right; }
  .badge { flex: none; display: inline-flex; align-items: center; gap: 5px; padding: 2px 7px; border: 1px solid var(--active); border-radius: 999px; background: var(--raised); color: var(--muted); font-size: 10px; }
  .badge.on { color: var(--text-2); }
  .inline-notice { color: var(--muted); font-size: 11px; }
  .inline-notice.error { color: #a03a32; }
  .source-note { color: var(--muted-2); font-size: 10px; }
  .store-search-row select { min-width: 132px; height: 30px; padding: 0 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--raised); color: var(--text-2); font-size: 12px; }
  .log-box { min-height: 360px; padding: 10px; overflow: auto; border: 1px solid var(--border); border-radius: 6px; background: var(--raised); color: var(--text-2); font: 11px/1.45 ui-monospace, "Cascadia Mono", monospace; white-space: pre-wrap; }
  @media (max-width: 620px) { .usage-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
