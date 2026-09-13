<script lang="ts">
  import { onMount } from 'svelte'

  type Rpc = ((type: string, payload?: Record<string, unknown>) => Promise<unknown>) | undefined
  type ConfigNav = 'manager' | 'raw'
  type RawKind = 'models' | 'auth' | 'settings'
  type Thinking = '' | 'xhigh' | 'max'
  type ModelDraft = {
    id: string
    name: string
    reasoning: boolean
    contextWindow: number
    maxTokens: number
    thinking: Thinking
    image: boolean
    hidden?: boolean
    extra: Record<string, unknown>
  }
  type ProviderDraft = {
    name: string
    baseUrl: string
    api: string
    apiKey: string
    userAgent: string
    balanceUrl: string
    supportsDeveloperRole: boolean
    supportsReasoningEffort: boolean
    models: ModelDraft[]
    builtin?: boolean
    disabled?: boolean
    extra: Record<string, unknown>
  }
  type AuthRow = { name: string; type: string; key: string; extra: Record<string, unknown> }
  type FetchedModel = { id: string; name?: string; reasoning?: boolean; imageInput?: boolean; contextWindow?: number; maxTokens?: number }
  type TestState = { busy?: boolean; ok?: boolean; message?: string; value?: number }

  export let open = false
  export let connected = false
  export let rpc: Rpc = undefined
  export let dirty = false
  export let saveHandler: { current: () => Promise<void> } = { current: async () => {} }
  export let onRefreshProviders: (() => void) | undefined = undefined

  const NAV: Array<[ConfigNav, string]> = [
    ['manager', '模型管理'],
    ['raw', '源文件']
  ]
  const APIS = [
    'openai-completions',
    'anthropic-messages',
    'openai-responses',
    'openai-codex-responses',
    'google-generative-ai',
    'mistral-conversations'
  ]
  const AUTH_PRESETS = ['anthropic', 'openai', 'google', 'deepseek', 'openrouter', 'groq', 'mistral', 'xai', 'together', 'moonshot', 'minimax', 'zai']
  const HIDDEN_KEY = 'pdn.hidden-providers'
  const KNOWN_PROVIDER = new Set(['baseUrl', 'api', 'apiKey', 'headers', 'compat', 'models', 'balanceUrl', 'disabled'])
  const KNOWN_MODEL = new Set(['id', 'name', 'reasoning', 'contextWindow', 'maxTokens', 'thinkingLevelMap', 'input', 'cost', 'hidden'])

  let nav: ConfigNav = 'manager'
  let providers: ProviderDraft[] = []
  let authRows: AuthRow[] = []
  let catalogByProvider: Record<string, FetchedModel[]> = {}
  let modelsSnap = '[]'
  let authSnap = '[]'
  let configRaw = ''
  let configPath = ''
  let rawSnap = ''
  let rawKind: RawKind = 'models'
  let configError = ''
  let notice = ''
  let saving = false
  let hydrated = false
  let expanded = ''
  let selectedProvider = ''
  let detailTab: 'connection' | 'models' = 'connection'
  let addingProvider = false
  let addingAuth = false
  let addDraft: ProviderDraft = emptyProvider()
  let addAuthName = ''
  let managerQuery = ''
  let revealKey: Record<string, boolean> = {}
  let tests: Record<string, TestState> = {}
  let probes: Record<string, TestState> = {}
  let balances: Record<string, TestState> = {}
  let testModel: Record<string, string> = {}
  let fetching: Record<string, boolean> = {}
  let fetched: Record<string, FetchedModel[]> = {}
  let fetchQuery: Record<string, string> = {}
  let fetchError: Record<string, string> = {}
  let fillBusy: Record<string, boolean> = {}
  let fillError: Record<string, string> = {}
  let oauthHint = ''

  $: modelsDirty = JSON.stringify(providers) !== modelsSnap
  $: authDirty = JSON.stringify(authRows) !== authSnap
  $: rawDirty = configRaw !== rawSnap
  $: managerDirty = modelsDirty || authDirty
  $: dirty = nav === 'manager' ? managerDirty : rawDirty
  $: managerProviders = [
    ...providers,
    ...authRows
      .filter((row) => !providers.some((item) => item.name === row.name))
      .map((row) => ({ ...emptyProvider(), name: row.name, builtin: true }))
  ]
  $: managerFilter = managerQuery.trim().toLowerCase()
  $: visibleManagerProviders = managerFilter
    ? managerProviders.filter((item) =>
        item.name.toLowerCase().includes(managerFilter) ||
        item.baseUrl.toLowerCase().includes(managerFilter) ||
        item.models.some((model) => model.id.toLowerCase().includes(managerFilter) || model.name.toLowerCase().includes(managerFilter))
      )
    : managerProviders
  $: if (!selectedProvider && managerProviders.length) selectedProvider = managerProviders[0].name
  $: selectedManagerItem = managerProviders.find((item) => item.name === selectedProvider) ?? managerProviders[0] ?? null
  $: saveHandler.current = saveCurrent
  $: if (open && connected && !hydrated) {
    hydrated = true
    void hydrate()
  }
  $: if (!open) hydrated = false

  onMount(() => {
    try {
      const last = localStorage.getItem('pdn.config-nav') as ConfigNav | null
      if (last && NAV.some(([id]) => id === last)) nav = last
    } catch { /* ignore */ }
  })

  function emptyProvider(): ProviderDraft {
    return {
      name: '',
      baseUrl: '',
      api: 'openai-completions',
      apiKey: '',
      userAgent: '',
      balanceUrl: '',
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      models: [],
      extra: {}
    }
  }

  function emptyModel(): ModelDraft {
    return { id: '', name: '', reasoning: false, contextWindow: 0, maxTokens: 0, thinking: '', image: false, extra: {} }
  }

  function readJson<T>(raw: string | null, fallback: T): T {
    try { return JSON.parse(raw || '') as T } catch { return fallback }
  }

  function readLegacyHidden() {
    return readJson<string[]>(localStorage.getItem(HIDDEN_KEY), []).filter((item) => typeof item === 'string')
  }

  function parseModel(raw: unknown): ModelDraft {
    const rec = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const extra: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(rec)) if (!KNOWN_MODEL.has(key)) extra[key] = value
    const map = rec.thinkingLevelMap && typeof rec.thinkingLevelMap === 'object' ? rec.thinkingLevelMap as Record<string, unknown> : {}
    const input = Array.isArray(rec.input) ? rec.input.map(String) : []
    const thinking = map.xhigh === 'max' || map.xhigh === 'xhigh' ? map.xhigh : ''
    return {
      id: String(rec.id || rec.name || ''),
      name: String(rec.name || rec.id || ''),
      reasoning: Boolean(rec.reasoning),
      contextWindow: Number(rec.contextWindow) || 0,
      maxTokens: Number(rec.maxTokens) || 0,
      thinking,
      image: input.includes('image'),
      hidden: rec.hidden === true,
      extra
    }
  }

  function serializeModel(model: ModelDraft) {
    const out: Record<string, unknown> = { ...model.extra, id: model.id.trim(), name: (model.name || model.id).trim() }
    if (model.reasoning) out.reasoning = true
    else delete out.reasoning
    if (model.contextWindow) out.contextWindow = model.contextWindow
    else delete out.contextWindow
    if (model.maxTokens) out.maxTokens = model.maxTokens
    else delete out.maxTokens
    if (model.thinking) out.thinkingLevelMap = { xhigh: model.thinking }
    else delete out.thinkingLevelMap
    out.input = model.image ? ['text', 'image'] : ['text']
    if (model.hidden) out.hidden = true
    else delete out.hidden
    return out
  }

  function parseProviders(parsed: unknown): ProviderDraft[] {
    const bag = parsed && typeof parsed === 'object' ? (parsed as { providers?: Record<string, unknown> }).providers : undefined
    if (!bag || typeof bag !== 'object') return []
    return Object.entries(bag).map(([name, raw]) => {
      const rec = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
      const extra: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(rec)) if (!KNOWN_PROVIDER.has(key)) extra[key] = value
      const headers = rec.headers && typeof rec.headers === 'object' ? rec.headers as Record<string, unknown> : {}
      const compat = rec.compat && typeof rec.compat === 'object' ? rec.compat as Record<string, unknown> : {}
      const models = Array.isArray(rec.models) ? rec.models.map((model) => parseModel(model)) : []
      return {
        name,
        baseUrl: String(rec.baseUrl || ''),
        api: String(rec.api || 'openai-completions'),
        apiKey: String(rec.apiKey || ''),
        userAgent: String(headers['User-Agent'] || headers['user-agent'] || ''),
        balanceUrl: String(rec.balanceUrl || ''),
        supportsDeveloperRole: Boolean(compat.supportsDeveloperRole),
        supportsReasoningEffort: Boolean(compat.supportsReasoningEffort),
        models,
        builtin: !rec.baseUrl && !rec.api,
        disabled: rec.disabled === true,
        extra
      }
    })
  }

  function serializeProviders() {
    const bag: Record<string, unknown> = {}
    for (const item of providers) {
      const headers = item.userAgent.trim() ? { 'User-Agent': item.userAgent.trim() } : undefined
      const models = item.models.filter((model) => model.id.trim()).map((model) => serializeModel(model))
      const disabled = item.disabled ? { disabled: true } : {}
      bag[item.name] = item.builtin
        ? { ...item.extra, ...disabled, models }
        : {
            ...item.extra,
            baseUrl: item.baseUrl.trim(),
            api: item.api.trim() || 'openai-completions',
            ...(item.apiKey.trim() ? { apiKey: item.apiKey.trim() } : {}),
            ...(headers ? { headers } : {}),
            ...(item.balanceUrl.trim() ? { balanceUrl: item.balanceUrl.trim() } : {}),
            compat: {
              supportsDeveloperRole: item.supportsDeveloperRole,
              supportsReasoningEffort: item.supportsReasoningEffort
            },
            ...disabled,
            models
          }
    }
    return { providers: bag }
  }

  function parseAuth(parsed: unknown): AuthRow[] {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    return Object.entries(parsed as Record<string, unknown>).map(([name, raw]) => {
      const rec = raw && typeof raw === 'object' ? raw as Record<string, unknown> : { key: raw }
      const extra: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(rec)) if (key !== 'type' && key !== 'key') extra[key] = value
      return { name, type: String(rec.type || 'api_key'), key: String(rec.key || ''), extra }
    })
  }

  function serializeAuth() {
    const bag: Record<string, unknown> = {}
    for (const row of authRows) {
      if (!row.name.trim()) continue
      bag[row.name.trim()] = { ...row.extra, type: row.type || 'api_key', key: row.key }
    }
    return bag
  }

  async function hydrate() {
    if (!rpc || !connected) return
    configError = ''
    notice = ''
    try {
      const models = await rpc('config_read', { file: 'models' }) as { parsed: unknown }
      providers = parseProviders(models.parsed)
    } catch (error) {
      providers = []
      configError = error instanceof Error ? error.message : '读取 models.json 失败'
    }
    try {
      const auth = await rpc('config_read', { file: 'auth' }) as { parsed: unknown }
      authRows = parseAuth(auth.parsed)
    } catch {
      authRows = []
    }
    try {
      const cards = await rpc('config_cards', {}) as Array<{ provider: string; models?: FetchedModel[] }>
      catalogByProvider = Object.fromEntries(cards.map((card) => [card.provider, card.models || []]))
    } catch {
      catalogByProvider = {}
    }
    const legacy = readLegacyHidden()
    if (legacy.length) {
      for (const name of legacy) {
        const existing = providers.find((item) => item.name === name)
        if (existing) existing.disabled = true
        else providers = [...providers, { ...emptyProvider(), name, builtin: true, disabled: true }]
      }
      localStorage.removeItem(HIDDEN_KEY)
    }
    modelsSnap = JSON.stringify(providers)
    authSnap = JSON.stringify(authRows)
    if (nav === 'raw') await loadRaw(rawKind)
  }

  async function loadRaw(kind: RawKind) {
    if (!rpc || !connected) return
    rawKind = kind
    try {
      const result = await rpc('config_read', { file: kind }) as { raw: string; path: string }
      configRaw = result.raw
      configPath = result.path
      rawSnap = result.raw
    } catch (error) {
      configError = error instanceof Error ? error.message : '读取失败'
    }
  }

  async function writeFile(file: RawKind, raw: string) {
    if (!rpc) return
    JSON.parse(raw)
    await rpc('config_write', { file, raw })
  }

  async function saveCurrent() {
    saving = true
    configError = ''
    notice = ''
    try {
      if (nav === 'manager') {
        if (modelsDirty) {
          await writeFile('models', `${JSON.stringify(serializeProviders(), null, 2)}\n`)
          modelsSnap = JSON.stringify(providers)
        }
        if (authDirty) {
          await writeFile('auth', `${JSON.stringify(serializeAuth(), null, 2)}\n`)
          authSnap = JSON.stringify(authRows)
        }
        onRefreshProviders?.()
        notice = '模型管理已保存并重载'
      } else {
        await writeFile(rawKind, configRaw)
        rawSnap = configRaw
        if (rawKind === 'models') providers = parseProviders(JSON.parse(configRaw))
        if (rawKind === 'auth') authRows = parseAuth(JSON.parse(configRaw))
        onRefreshProviders?.()
        notice = `${rawKind}.json 已保存并重载`
      }
    } catch (error) {
      configError = error instanceof Error ? error.message : '保存失败'
    }
    saving = false
  }

  function setNav(next: ConfigNav) {
    nav = next
    try { localStorage.setItem('pdn.config-nav', next) } catch { /* ignore */ }
    if (next === 'raw') void loadRaw(rawKind)
  }

  function providerByName(name: string) {
    return providers.find((item) => item.name === name)
  }

  function ensureProvider(name: string) {
    const existing = providerByName(name)
    if (existing) return existing
    const next = { ...emptyProvider(), name, builtin: true }
    providers = [...providers, next]
    return next
  }

  function patchProvider(name: string, partial: Partial<ProviderDraft>) {
    ensureProvider(name)
    providers = providers.map((item) => item.name === name ? { ...item, ...partial } : item)
  }

  function patchModel(name: string, index: number, partial: Partial<ModelDraft>) {
    providers = providers.map((item) => {
      if (item.name !== name) return item
      return { ...item, models: item.models.map((model, i) => i === index ? { ...model, ...partial } : model) }
    })
  }

  function confirmAdd() {
    const name = addDraft.name.trim()
    if (!name || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name) || providers.some((item) => item.name === name)) {
      configError = '请输入唯一的合法供应商名称（字母开头）'
      return
    }
    providers = [...providers, { ...addDraft, name, builtin: false }]
    expanded = name
    selectedProvider = name
    addingProvider = false
    addDraft = emptyProvider()
    configError = ''
  }

  function addAuth() {
    const name = addAuthName.trim()
    if (!name || authRows.some((row) => row.name === name)) {
      configError = '请输入唯一的认证名称'
      return
    }
    authRows = [...authRows, { name, type: 'api_key', key: '', extra: {} }]
    expanded = name
    selectedProvider = name
    addingAuth = false
    addAuthName = ''
    configError = ''
  }

  function duplicateProvider(name: string) {
    const source = providerByName(name)
    if (!source || source.builtin) return
    let next = `${name}-copy`
    let i = 2
    while (providers.some((item) => item.name === next)) next = `${name}-copy${i++}`
    providers = [...providers, { ...JSON.parse(JSON.stringify(source)), name: next, builtin: false }]
    expanded = next
  }

  function deleteProvider(name: string) {
    if (!confirm(`删除 ${name} 的供应商配置和认证？`)) return
    providers = providers.filter((item) => item.name !== name)
    authRows = authRows.filter((row) => row.name !== name)
    if (expanded === name) expanded = ''
    if (selectedProvider === name) selectedProvider = ''
  }

  function providerEnabled(item: ProviderDraft) {
    return item.disabled !== true
  }

  function toggleProviderVisible(item: ProviderDraft) {
    patchProvider(item.name, { disabled: providerEnabled(item) })
  }

  function authRowFor(name: string) {
    return authRows.find((row) => row.name === name)
  }

  function apiKeyFor(name: string) {
    return authRowFor(name)?.key ?? providerByName(name)?.apiKey ?? ''
  }

  function patchApiKey(name: string, value: string) {
    if (authRows.some((row) => row.name === name)) {
      authRows = authRows.map((row) => row.name === name ? { ...row, key: value } : row)
    } else {
      patchProvider(name, { apiKey: value })
    }
  }

  function modelVisible(model: ModelDraft) {
    return model.hidden !== true
  }

  function visibleModelCount(item: ProviderDraft) {
    return item.models.filter((model) => modelVisible(model)).length
  }

  function modelChecked(item: ProviderDraft, source: FetchedModel) {
    return item.models.some((model) => model.id === source.id && modelVisible(model))
  }

  function modelFromFetched(model: FetchedModel, hidden = false): ModelDraft {
    return {
      ...emptyModel(),
      id: model.id,
      name: model.name || model.id,
      reasoning: Boolean(model.reasoning),
      image: Boolean(model.imageInput),
      contextWindow: model.contextWindow || 0,
      maxTokens: model.maxTokens || 0,
      hidden
    }
  }

  function availableModels(item: ProviderDraft) {
    const query = (fetchQuery[item.name] || '').trim().toLowerCase()
    const list = fetched[item.name] || catalogByProvider[item.name] || []
    if (!query) return list
    return list.filter((model) => model.id.toLowerCase().includes(query) || (model.name || '').toLowerCase().includes(query))
  }

  function toggleModelVisible(item: ProviderDraft, source: FetchedModel) {
    const current = ensureProvider(item.name)
    const index = current.models.findIndex((model) => model.id === source.id)
    if (index >= 0) patchModel(item.name, index, { hidden: modelVisible(current.models[index]) })
    else patchProvider(item.name, { models: [...current.models, modelFromFetched(source)] })
  }

  function setAvailableModelsVisible(item: ProviderDraft, visible: boolean) {
    const list = availableModels(item)
    if (!list.length) return
    const current = ensureProvider(item.name)
    const ids = new Set(list.map((model) => model.id))
    if (visible) {
      const existing = new Map(current.models.map((model) => [model.id, model]))
      const next = list.map((source) => {
        const model = existing.get(source.id)
        return model ? { ...model, hidden: false } : modelFromFetched(source)
      })
      const retained = current.models.filter((model) => !ids.has(model.id))
      patchProvider(item.name, { models: [...retained, ...next] })
    } else {
      patchProvider(item.name, { models: current.models.map((model) => ids.has(model.id) ? { ...model, hidden: true } : model) })
    }
  }

  function addModel(name: string) {
    const item = ensureProvider(name)
    patchProvider(name, { models: [...item.models, emptyModel()] })
  }

  function deleteModel(name: string, index: number) {
    const item = ensureProvider(name)
    patchProvider(name, { models: item.models.filter((_, i) => i !== index) })
  }

  function pasteModelIds(name: string, index: number, text: string) {
    if (!/[\n,]/.test(text)) return false
    const ids = text.split(/[,\n]/).map((item) => item.trim()).filter(Boolean)
    const item = ensureProvider(name)
    const next = [...item.models]
    const current = next[index]
    if (!current || !ids.length) return false
    next.splice(index, current.id.trim() ? 1 : 0, ...ids.map((id) => ({ ...emptyModel(), id })))
    patchProvider(name, { models: next })
    return true
  }

  async function fillHints(item: ProviderDraft) {
    const ids = item.models.map((model) => model.id.trim()).filter(Boolean)
    if (!ids.length) return
    fillBusy = { ...fillBusy, [item.name]: true }
    fillError = { ...fillError, [item.name]: '' }
    try {
      const result = await rpc?.('lookup_model_hints', { ids }) as { models?: FetchedModel[] }
      const hints = result?.models || []
      if (!hints.length) {
        fillError = { ...fillError, [item.name]: 'models.dev 没有匹配到这些模型 ID' }
      } else {
        const byId = new Map(hints.map((hint) => [hint.id.trim(), hint]))
        patchProvider(item.name, {
          models: item.models.map((model) => {
            const hint = byId.get(model.id.trim())
            return hint ? {
              ...model,
              reasoning: hint.reasoning === true,
              image: hint.imageInput === true,
              contextWindow: hint.contextWindow || model.contextWindow,
              maxTokens: hint.maxTokens || model.maxTokens
            } : model
          })
        })
      }
    } catch (error) {
      fillError = { ...fillError, [item.name]: error instanceof Error ? error.message : '补全失败' }
    }
    fillBusy = { ...fillBusy, [item.name]: false }
  }

  async function fetchModels(item: ProviderDraft) {
    fetching = { ...fetching, [item.name]: true }
    fetchError = { ...fetchError, [item.name]: '' }
    try {
      const result = await rpc?.('fetch_models', { baseUrl: item.baseUrl, apiKey: apiKeyFor(item.name) }) as { ok: boolean; message: string; models?: FetchedModel[] }
      if (!result?.ok) throw new Error(result?.message || '拉取失败')
      fetched = { ...fetched, [item.name]: result.models || [] }
    } catch (error) {
      fetchError = { ...fetchError, [item.name]: error instanceof Error ? error.message : '拉取失败' }
    }
    fetching = { ...fetching, [item.name]: false }
  }

  async function testCard(item: ProviderDraft) {
    tests = { ...tests, [item.name]: { busy: true } }
    try {
      const result = await rpc?.('test_provider', {
        provider: item.name,
        baseUrl: item.baseUrl,
        apiKey: apiKeyFor(item.name),
        model: testModel[item.name] || item.models.find((model) => modelVisible(model))?.id || ''
      }) as { ok: boolean; message: string; latency?: number }
      tests = { ...tests, [item.name]: { busy: false, ok: result?.ok, message: result?.ok ? `${result.message}${result.latency ? ` · ${result.latency}ms` : ''}` : (result?.message || '失败') } }
    } catch (error) {
      tests = { ...tests, [item.name]: { busy: false, ok: false, message: error instanceof Error ? error.message : '失败' } }
    }
  }

  async function probeCard(name: string) {
    probes = { ...probes, [name]: { busy: true } }
    try {
      const result = await rpc?.('usage_probe', { provider: name }) as { ok: boolean; message: string }
      probes = { ...probes, [name]: { busy: false, ok: result?.ok, message: result?.message || '' } }
    } catch (error) {
      probes = { ...probes, [name]: { busy: false, ok: false, message: error instanceof Error ? error.message : '失败' } }
    }
  }

  async function queryBalance(item: ProviderDraft) {
    balances = { ...balances, [item.name]: { busy: true } }
    try {
      const result = await rpc?.('fetch_balance', { provider: item.name, baseUrl: item.baseUrl, apiKey: apiKeyFor(item.name), balanceUrl: item.balanceUrl }) as { ok?: boolean; balance?: number; message?: string }
      balances = { ...balances, [item.name]: { busy: false, ok: Boolean(result?.ok), value: result?.balance, message: result?.message || (result?.ok ? '' : '查询失败') } }
    } catch (error) {
      balances = { ...balances, [item.name]: { busy: false, ok: false, message: error instanceof Error ? error.message : '查询失败' } }
    }
  }

  async function loginOAuth(provider: string) {
    oauthHint = '正在打开登录…'
    try {
      const result = await rpc?.('oauth_login', { provider }) as { ok?: boolean; message?: string }
      oauthHint = result?.ok ? (result.message || '已登录') : `${result?.message || '登录失败'}`
      if (result?.ok && !authRows.some((row) => row.name === provider)) {
        authRows = [...authRows, { name: provider, type: 'oauth', key: '', extra: {} }]
      }
    } catch (error) {
      oauthHint = error instanceof Error ? error.message : '失败'
    }
  }

  async function copyText(value: string) {
    try { await navigator.clipboard.writeText(value) } catch { /* ignore */ }
  }
</script>

<div class="wrap">
  <nav class="nav" aria-label="配置分类">
    <p class="nav-label">模型管理</p>
    {#each NAV as [id, label] (id)}
      <button class="nav-item" class:active={nav === id} on:click={() => setNav(id)}>
        {label}
        {#if (id === 'manager' && managerDirty) || (id === 'raw' && rawDirty)}<i class="dot"></i>{/if}
      </button>
    {/each}
  </nav>

  <div class="content">
    {#if nav === 'manager'}
      <div class="toolbar">
        <span class="count">{managerProviders.filter(providerEnabled).length}/{managerProviders.length} 启用 · {managerProviders.reduce((sum, item) => sum + visibleModelCount(item), 0)} 个可见模型</span>
        <div class="toolbar-actions">
          <button class="ghost" disabled={saving} on:click={() => (addingProvider = !addingProvider)}>{addingProvider ? '取消供应商' : '+ 供应商'}</button>
          <button class="ghost" disabled={saving} on:click={() => (addingAuth = !addingAuth)}>{addingAuth ? '取消认证' : '+ 认证'}</button>
          <button class="save" disabled={saving || !managerDirty} on:click={() => void saveCurrent()}>{saving ? '保存中' : '保存'}</button>
        </div>
      </div>

      {#if notice}<p class="banner ok">{notice}</p>{/if}
      {#if configError}<p class="banner warn">{configError}</p>{/if}

      {#if addingProvider}
        <section class="card add-card">
          <h3>新供应商</h3>
          <div class="add-grid">
            <label class="field"><span>名称</span><input bind:value={addDraft.name} placeholder="my-gateway" /></label>
            <label class="field"><span>Base URL</span><input bind:value={addDraft.baseUrl} placeholder="https://api.example.com/v1" /></label>
            <label class="field"><span>API 类型</span><select bind:value={addDraft.api}>{#each APIS as api}<option value={api}>{api}</option>{/each}</select></label>
            <label class="field"><span>API Key</span><input type="password" bind:value={addDraft.apiKey} placeholder="sk-…" /></label>
          </div>
          <div class="row-actions"><button class="ghost" on:click={() => (addingProvider = false)}>取消</button><button class="save" on:click={confirmAdd}>添加</button></div>
        </section>
      {/if}

      {#if addingAuth}
        <section class="card add-card">
          <h3>添加认证</h3>
          <div class="toolbar">
            <select bind:value={addAuthName}><option value="">选择预设…</option>{#each AUTH_PRESETS as name}<option value={name}>{name}</option>{/each}</select>
            <input bind:value={addAuthName} placeholder="或输入 provider 名称" />
            <button class="save" on:click={addAuth}>添加</button>
          </div>
        </section>
      {/if}

      <div class="manager-shell">
        <aside class="provider-panel">
          <div class="provider-search"><input bind:value={managerQuery} placeholder="搜索 Provider…" aria-label="搜索 Provider" /></div>
          <div class="provider-list">
            {#each visibleManagerProviders as item (item.name)}
              <div class="provider-row" class:selected={selectedManagerItem?.name === item.name}>
                <button class="provider-row-main" on:click={() => { selectedProvider = item.name; detailTab = 'connection' }}>
                  <span class="provider-avatar">{item.name.slice(0, 1).toUpperCase()}</span>
                  <span class="provider-copy"><strong>{item.name}</strong><small>{visibleModelCount(item)} 可见 · {item.models.length} 已配置</small></span>
                </button>
                <button class="switch" type="button" role="switch" aria-checked={providerEnabled(item)} title={providerEnabled(item) ? '关闭 Provider' : '启用 Provider'} on:click={(event) => { event.stopPropagation(); toggleProviderVisible(item) }}>
                  <span></span>
                </button>
              </div>
            {:else}
              <p class="muted">没有匹配的 Provider。</p>
            {/each}
          </div>
        </aside>

        <section class="provider-detail">
          {#if selectedManagerItem}
            {@const item = selectedManagerItem}
            <header class="detail-head">
              <div>
                <div class="detail-title"><h3>{item.name}</h3>{#if item.builtin}<span class="badge">SDK 内置</span>{/if}<span class="badge" class:ok={providerEnabled(item)}>{providerEnabled(item) ? '已启用' : '已关闭'}</span></div>
                <p>{item.baseUrl || '保留 SDK 官方连接设置'}</p>
              </div>
              <div class="detail-actions">
                {#if !item.builtin}<button class="ghost" on:click={() => duplicateProvider(item.name)}>复制</button>{/if}
                <button class="ghost danger" on:click={() => deleteProvider(item.name)}>删除</button>
              </div>
            </header>

            <div class="detail-tabs">
              <button class:active={detailTab === 'connection'} on:click={() => (detailTab = 'connection')}>连接与认证</button>
              <button class:active={detailTab === 'models'} on:click={() => (detailTab = 'models')}>模型 <span>{visibleModelCount(item)}/{item.models.length}</span></button>
            </div>

            {#if detailTab === 'connection'}
              <div class="detail-body connection-grid">
                {#if item.builtin && !item.baseUrl}
                  <div class="builtin-note full">这是 SDK 内置 Provider。保留官方连接设置，这里只管理认证、开关和模型可见性。</div>
                {:else}
                  <label class="field"><span>Base URL</span><input value={item.baseUrl} on:input={(event) => patchProvider(item.name, { baseUrl: (event.currentTarget as HTMLInputElement).value })} placeholder="https://api.example.com/v1" /></label>
                  <label class="field"><span>API 类型</span><select value={item.api} on:change={(event) => patchProvider(item.name, { api: (event.currentTarget as HTMLSelectElement).value })}>{#each APIS as api}<option value={api}>{api}</option>{/each}{#if item.api && !APIS.includes(item.api)}<option value={item.api}>{item.api}</option>{/if}</select></label>
                  <label class="field"><span>User-Agent</span><input value={item.userAgent} on:input={(event) => patchProvider(item.name, { userAgent: (event.currentTarget as HTMLInputElement).value })} placeholder="留空使用运行时默认" /></label>
                  <label class="field"><span>余额 URL</span><div class="secret"><input value={item.balanceUrl} on:input={(event) => patchProvider(item.name, { balanceUrl: (event.currentTarget as HTMLInputElement).value })} placeholder="https://api.example.com/v1/usage" /><button class="save" disabled={balances[item.name]?.busy} on:click={() => void queryBalance(item)}>{balances[item.name]?.busy ? '查询中' : '查余额'}</button></div></label>
                  <div class="checks full">
                    <label><input type="checkbox" checked={item.supportsDeveloperRole} on:change={(event) => patchProvider(item.name, { supportsDeveloperRole: (event.currentTarget as HTMLInputElement).checked })} /><span>关闭 developer 角色</span></label>
                    <label><input type="checkbox" checked={item.supportsReasoningEffort} on:change={(event) => patchProvider(item.name, { supportsReasoningEffort: (event.currentTarget as HTMLInputElement).checked })} /><span>关闭 reasoning_effort</span></label>
                  </div>
                {/if}
                <label class="field full"><span>{authRowFor(item.name)?.type === 'oauth' ? 'OAuth 凭据' : 'API Key'}</span><div class="secret"><input type={revealKey[item.name] ? 'text' : 'password'} value={apiKeyFor(item.name)} on:input={(event) => patchApiKey(item.name, (event.currentTarget as HTMLInputElement).value)} placeholder="sk-…" /><button class="ghost" on:click={() => (revealKey = { ...revealKey, [item.name]: !revealKey[item.name] })}>{revealKey[item.name] ? '隐藏' : '显示'}</button><button class="ghost" on:click={() => void copyText(apiKeyFor(item.name))}>复制</button></div></label>
                {#if item.baseUrl}<label class="field full"><span>测试模型</span><div class="secret"><input value={testModel[item.name] ?? item.models.find((model) => modelVisible(model))?.id ?? ''} on:input={(event) => (testModel = { ...testModel, [item.name]: (event.currentTarget as HTMLInputElement).value })} placeholder="模型 ID" /><button class="save" disabled={tests[item.name]?.busy} on:click={() => void testCard(item)}>{tests[item.name]?.busy ? '测试中' : '测试连接'}</button><button class="ghost" disabled={probes[item.name]?.busy} on:click={() => void probeCard(item.name)}>{probes[item.name]?.busy ? '查询中' : '用量'}</button></div></label>{/if}
                {#if tests[item.name]?.message}<p class="hint full" class:warn={tests[item.name]?.ok === false}>{tests[item.name].message}</p>{/if}
                {#if probes[item.name]?.message}<p class="hint full">{probes[item.name].message}</p>{/if}
                {#if balances[item.name]?.message}<p class="hint full" class:warn={balances[item.name]?.ok === false}>{balances[item.name].message}</p>{/if}
              </div>
            {:else}
              <div class="detail-body">
                <div class="models-head">
                  <div><strong>Provider 模型目录</strong><small>勾选后才进入模型选择器</small></div>
                  <div class="toolbar-actions">
                    <button class="ghost" disabled={fetching[item.name] || !/^https?:\/\//i.test(item.baseUrl.trim())} on:click={() => void fetchModels(item)}>{fetching[item.name] ? '拉取中…' : '拉取模型'}</button>
                    <button class="ghost" disabled={fillBusy[item.name] || !item.models.some((model) => model.id.trim())} on:click={() => void fillHints(item)}>{fillBusy[item.name] ? '补全中…' : '补全信息'}</button>
                    <button class="ghost" on:click={() => setAvailableModelsVisible(item, true)}>全部显示</button>
                    <button class="ghost" on:click={() => setAvailableModelsVisible(item, false)}>全部隐藏</button>
                  </div>
                </div>
                {#if fetchError[item.name]}<p class="hint warn">{fetchError[item.name]}</p>{/if}
                {#if fillError[item.name]}<p class="hint warn">{fillError[item.name]}</p>{/if}
                {#if availableModels(item).length}
                  <div class="fetch-box">
                    <input class="search" placeholder="搜索模型 ID 或名称" value={fetchQuery[item.name] || ''} on:input={(event) => (fetchQuery = { ...fetchQuery, [item.name]: (event.currentTarget as HTMLInputElement).value })} />
                    <div class="fetch-list">
                      {#each availableModels(item) as model (model.id)}
                        <label class:visible={modelChecked(item, model)}><input type="checkbox" checked={modelChecked(item, model)} on:change={() => toggleModelVisible(item, model)} /><span>{model.id}</span>{#if model.name && model.name !== model.id}<small>{model.name}</small>{/if}</label>
                      {/each}
                    </div>
                  </div>
                {:else}
                  <p class="hint">没有目录模型。自定义 Provider 可填 Base URL 和 Key 后拉取，或手动添加。</p>
                {/if}
                <div class="models-head"><div><strong>已配置模型</strong><small>隐藏不会删除配置</small></div><button class="ghost" on:click={() => addModel(item.name)}>+ 手动添加</button></div>
                <div class="table-wrap">
                  <table>
                    <thead><tr><th>显示</th><th>ID</th><th>名称</th><th>上下文</th><th>最大 Token</th><th>推理</th><th>xhigh</th><th>图片</th><th></th></tr></thead>
                    <tbody>
                      {#each item.models as model, index (`${item.name}-${index}`)}
                        <tr class:hidden-row={!modelVisible(model)}>
                          <td class="center"><input type="checkbox" checked={modelVisible(model)} on:change={(event) => patchModel(item.name, index, { hidden: !(event.currentTarget as HTMLInputElement).checked })} /></td>
                          <td><input value={model.id} on:input={(event) => patchModel(item.name, index, { id: (event.currentTarget as HTMLInputElement).value })} on:paste={(event) => { const text = event.clipboardData?.getData('text') || ''; if (pasteModelIds(item.name, index, text)) event.preventDefault() }} /></td>
                          <td><input value={model.name} on:input={(event) => patchModel(item.name, index, { name: (event.currentTarget as HTMLInputElement).value })} /></td>
                          <td><input type="number" value={model.contextWindow || ''} on:input={(event) => patchModel(item.name, index, { contextWindow: Number((event.currentTarget as HTMLInputElement).value) || 0 })} /></td>
                          <td><input type="number" value={model.maxTokens || ''} on:input={(event) => patchModel(item.name, index, { maxTokens: Number((event.currentTarget as HTMLInputElement).value) || 0 })} /></td>
                          <td class="center"><input type="checkbox" checked={model.reasoning} on:change={(event) => patchModel(item.name, index, { reasoning: (event.currentTarget as HTMLInputElement).checked })} /></td>
                          <td><select value={model.thinking} on:change={(event) => patchModel(item.name, index, { thinking: (event.currentTarget as HTMLSelectElement).value as Thinking })}><option value="">关闭</option><option value="xhigh">xhigh</option><option value="max">max</option></select></td>
                          <td class="center"><input type="checkbox" checked={model.image} on:change={(event) => patchModel(item.name, index, { image: (event.currentTarget as HTMLInputElement).checked })} /></td>
                          <td class="center"><button class="icon danger" aria-label="删除模型" on:click={() => deleteModel(item.name, index)}>×</button></td>
                        </tr>
                      {:else}
                        <tr><td colspan="9" class="empty">还没有已配置模型。</td></tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              </div>
            {/if}
          {:else}
            <div class="detail-empty">左侧选择一个 Provider，或先添加供应商 / 认证。</div>
          {/if}
        </section>
      </div>
    {:else}
      <div class="toolbar">
        <div class="choice-row">
          <button class="choice" class:on={rawKind === 'models'} on:click={() => void loadRaw('models')}>models.json</button>
          <button class="choice" class:on={rawKind === 'auth'} on:click={() => void loadRaw('auth')}>auth.json</button>
          <button class="choice" class:on={rawKind === 'settings'} on:click={() => void loadRaw('settings')}>settings.json</button>
        </div>
        <button class="save" disabled={saving || !rawDirty} on:click={() => void saveCurrent()}>{saving ? '保存中' : '保存'}</button>
      </div>
      <p class="hint">{configPath || '源文件'} · 这里直接编辑磁盘 JSON，保存后重载。</p>
      <textarea class="json-editor" bind:value={configRaw} spellcheck="false"></textarea>
    {/if}
  </div>
</div>

<style>
  .wrap { display: flex; flex: 1; width: 100%; min-width: 0; min-height: 0; }
  .nav { flex: none; width: 168px; padding: 12px 10px; overflow: auto; border-right: 1px solid var(--hover); background: var(--surface); }
  .nav-label { margin: 0 8px 8px; color: var(--muted); font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  .nav-item { display: flex; align-items: center; justify-content: space-between; width: 100%; min-height: 34px; padding: 0 10px; border-radius: 6px; background: transparent; color: var(--text-3); font-size: 13px; text-align: left; }
  .nav-item:hover { background: var(--surface-3); color: var(--text-2); }
  .nav-item.active { background: var(--hover); color: var(--text); font-weight: 650; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: #c9a227; }
  .content { flex: 1; min-width: 0; overflow: auto; padding: 16px 22px 28px; }
  .toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .toolbar-actions, .row-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; }
  .count { color: var(--muted); font-size: 12px; white-space: nowrap; }
  .hint { margin: 0 0 12px; color: var(--muted); font-size: 12px; line-height: 1.5; }
  .hint.warn, .banner.warn { color: #8a3b00; }
  .banner { margin: 0 0 10px; padding: 9px 11px; border-radius: 6px; background: var(--surface-3); font-size: 12px; }
  .banner.ok { color: var(--text); }
  .ghost, .choice { min-height: 30px; padding: 0 10px; border: 1px solid var(--border); border-radius: 5px; background: var(--raised); color: var(--text-2); font-size: 12px; }
  .ghost:hover, .choice:hover { background: var(--surface-3); color: var(--text); }
  .ghost.danger { color: #a03a32; }
  .ghost.danger:hover { background: #f6eaea; }
  .choice.on { border-color: var(--text); color: var(--text); font-weight: 650; }
  .save { height: 30px; padding: 0 12px; border-radius: 5px; background: var(--accent); color: var(--accent-fg); font-size: 12px; font-weight: 600; }
  .save:disabled, .ghost:disabled { opacity: .45; }
  .choice-row { display: flex; gap: 6px; }
  .card { margin-bottom: 10px; overflow: hidden; border: 1px solid var(--border-2); border-radius: 8px; background: var(--raised); }
  .add-card { padding: 12px 14px 14px; }
  .add-card h3 { margin: 0 0 10px; color: var(--text); font-size: 13px; }
  .switch { position: relative; display: inline-flex; width: 34px; height: 20px; flex: none; }
  .switch { padding: 0; border: 0; background: transparent; }
  .switch span { position: absolute; inset: 0; border-radius: 999px; background: var(--border-3); transition: background .16s ease; }
  .switch span::after { content: ""; position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgb(0 0 0 / 20%); transition: transform .16s ease; }
  .switch[aria-checked="true"] span { background: var(--accent); }
  .switch[aria-checked="true"] span::after { transform: translateX(14px); }
  .icon { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 5px; background: transparent; color: var(--muted); font-size: 13px; }
  .icon:hover { background: var(--surface-3); color: var(--text); }
  .icon.danger:hover { color: #a03a32; background: #f6eaea; }
  .field { display: grid; grid-template-columns: 92px minmax(0, 1fr); align-items: center; gap: 10px; color: var(--text-3); font-size: 12px; }
  .field input, .field select, .toolbar input, .toolbar select { min-width: 0; width: 100%; height: 32px; padding: 0 8px; border: 1px solid var(--border); border-radius: 5px; background: var(--raised); color: var(--text); font-size: 12px; }
  .secret { display: flex; gap: 6px; min-width: 0; }
  .secret input { flex: 1; }
  .checks { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .checks label { display: flex; align-items: center; gap: 8px; min-height: 32px; padding: 0 9px; border: 1px solid var(--border-2); border-radius: 6px; color: var(--text-2); font-size: 12px; }
  .checks input { width: 16px; height: 16px; margin: 0; accent-color: var(--accent); }
  .builtin-note { margin: 0; padding: 10px 11px; border-radius: 6px; background: var(--surface-3); color: var(--text-2); font-size: 12px; line-height: 1.5; }
  .models-head { display: flex; align-items: center; gap: 10px; margin: 12px 0 8px; }
  .models-head strong { color: var(--text); font-size: 12px; }
  .fetch-box { margin-bottom: 14px; padding: 10px; border: 1px solid var(--border-2); border-radius: 7px; background: var(--raised); }
  .fetch-box .search { width: 100%; height: 32px; margin-bottom: 8px; padding: 0 9px; border: 1px solid var(--border); border-radius: 5px; background: var(--surface); color: var(--text); font-size: 12px; }
  .fetch-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 4px 8px; max-height: 220px; overflow: auto; }
  .fetch-list label { display: flex; align-items: center; gap: 7px; min-width: 0; min-height: 30px; padding: 0 7px; border-radius: 5px; color: var(--muted); font-size: 11px; }
  .fetch-list label.visible { background: var(--surface-3); color: var(--text); }
  .fetch-list input { width: 15px; height: 15px; margin: 0; accent-color: var(--accent); }
  .fetch-list span, .fetch-list small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fetch-list small { margin-left: auto; color: var(--muted); }
  .table-wrap { overflow: auto; border: 1px solid var(--border-2); border-radius: 7px; background: var(--raised); }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 6px; border-bottom: 1px solid var(--surface-3); text-align: left; }
  th { color: var(--muted); font-size: 10px; font-weight: 650; background: var(--surface-3); }
  td input, td select { width: 100%; height: 30px; padding: 0 6px; border: 1px solid var(--border-2); border-radius: 4px; background: var(--raised); color: var(--text); font-size: 11px; }
  td.center { text-align: center; }
  td.center input { width: 15px; height: 15px; accent-color: var(--accent); }
  tr.hidden-row { opacity: .55; }
  .empty { padding: 14px; color: var(--muted); font-size: 12px; text-align: center; }
  .manager-shell { display: grid; grid-template-columns: 238px minmax(0, 1fr); min-height: 560px; overflow: hidden; border: 1px solid var(--border-2); border-radius: 10px; background: var(--raised); }
  .provider-panel { min-width: 0; border-right: 1px solid var(--border-2); background: var(--surface); }
  .provider-search { padding: 10px; border-bottom: 1px solid var(--border-2); }
  .provider-search input { width: 100%; height: 34px; padding: 0 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--raised); color: var(--text); font-size: 12px; }
  .provider-list { max-height: 640px; overflow: auto; padding: 6px; }
  .provider-row { display: flex; align-items: center; gap: 7px; min-height: 52px; padding: 5px 6px; border-radius: 7px; }
  .provider-row:hover { background: var(--surface-3); }
  .provider-row.selected { background: var(--active); }
  .provider-row-main { display: flex; align-items: center; gap: 9px; min-width: 0; flex: 1; background: transparent; text-align: left; }
  .provider-avatar { display: grid; place-items: center; flex: none; width: 28px; height: 28px; border-radius: 7px; background: var(--accent); color: var(--accent-fg); font-size: 12px; font-weight: 700; }
  .provider-copy { min-width: 0; display: grid; gap: 2px; }
  .provider-copy strong, .provider-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .provider-copy strong { color: var(--text); font-size: 12px; }
  .provider-copy small { color: var(--muted); font-size: 10px; }
  .provider-detail { min-width: 0; background: var(--raised); }
  .detail-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 16px 18px 12px; border-bottom: 1px solid var(--border-2); }
  .detail-title { display: flex; align-items: center; gap: 8px; }
  .detail-title h3 { margin: 0; color: var(--text); font-size: 18px; }
  .detail-head p { margin: 5px 0 0; color: var(--muted); font-size: 11px; }
  .detail-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
  .detail-tabs { display: flex; gap: 4px; padding: 8px 14px 0; border-bottom: 1px solid var(--border-2); }
  .detail-tabs button { min-height: 34px; padding: 0 12px; border-radius: 6px 6px 0 0; background: transparent; color: var(--muted); font-size: 12px; }
  .detail-tabs button.active { background: var(--surface-3); color: var(--text); font-weight: 650; }
  .detail-tabs span { color: var(--muted); font-size: 10px; }
  .detail-body { padding: 16px 18px 22px; }
  .connection-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
  .connection-grid .full { grid-column: 1 / -1; }
  .detail-empty { display: grid; place-items: center; min-height: 480px; color: var(--muted); font-size: 12px; }
  .badge { padding: 2px 7px; border: 1px solid var(--border-2); border-radius: 999px; color: var(--muted); font-size: 10px; }
  .badge.ok { color: #3f7650; border-color: #bdd3c2; background: #f0f7f1; }
  .add-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }
  .models-head > div:first-child { min-width: 0; }
  .models-head small { display: block; margin-top: 2px; color: var(--muted); font-size: 10px; }
  .json-editor { width: 100%; min-height: 460px; padding: 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--raised); color: var(--text-2); font: 12px/1.5 ui-monospace, "Cascadia Mono", monospace; }
  .muted { color: var(--muted); font-size: 12px; }
  @media (max-width: 760px) {
    .toolbar { align-items: stretch; flex-direction: column; }
    .field { grid-template-columns: 1fr; }
    .checks { grid-template-columns: 1fr; }
    .manager-shell { grid-template-columns: 1fr; }
    .provider-panel { border-right: 0; border-bottom: 1px solid var(--border-2); }
    .connection-grid, .add-grid { grid-template-columns: 1fr; }
  }
</style>
