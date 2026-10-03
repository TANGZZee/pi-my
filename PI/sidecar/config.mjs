import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { atomicWriteText } from './atomic-write.mjs'
import {
  defaultBalanceUrl,
  flattenModelsDev,
  matchModelsDev,
  normalizeBalanceUrl,
  parseFetchedModels,
  parseProviderBalance
} from './provider-models.mjs'

const FILES = {
  models: 'models.json',
  auth: 'auth.json',
  settings: 'settings.json',
  probes: 'usage-probes.json',
  proxy: 'desktop-proxy.json'
}

const TEMPLATES = {
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    url: 'https://openrouter.ai/api/v1/key',
    method: 'GET',
    parse: 'data.limit_remaining'
  },
  moonshot: {
    id: 'moonshot',
    label: 'Moonshot / Kimi',
    url: 'https://api.moonshot.cn/v1/users/me/balance',
    method: 'GET',
    parse: 'data.available_balance'
  },
  openai: {
    id: 'openai',
    label: 'OpenAI 兼容网关',
    url: '{baseUrl}/models',
    method: 'GET',
    parse: ''
  }
}

export function configPaths(agentDir) {
  return {
    dir: agentDir,
    models: path.join(agentDir, FILES.models),
    auth: path.join(agentDir, FILES.auth),
    settings: path.join(agentDir, FILES.settings),
    probes: path.join(agentDir, FILES.probes),
    proxy: path.join(agentDir, FILES.proxy)
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true })
  const text = `${JSON.stringify(data, null, 2)}\n`
  // 2-13（审查 P2-4）：probes/proxy/catalog 缓存同样被并发读写，统一走原子写。
  // 一处改动覆盖 writeJson 的全部调用点（desktop-proxy.json / usage-probes.json / models-dev 缓存）。
  await atomicWriteText(file, text)
  return text
}

function pick(obj, dotted) {
  if (!dotted) return obj
  return dotted.split('.').reduce((cur, key) => (cur && typeof cur === 'object' ? cur[key] : undefined), obj)
}

function maskKey(value) {
  const text = String(value || '')
  if (text.length < 8) return text ? '••••' : ''
  return `${text.slice(0, 4)}…${text.slice(-4)}`
}

export async function readConfigFile(agentDir, kind) {
  const name = FILES[kind]
  if (!name) throw new Error('未知配置文件')
  const file = path.join(agentDir, name)
  let raw = ''
  try { raw = await readFile(file, 'utf8') } catch { raw = kind === 'models' ? '{\n  "providers": {}\n}\n' : '{}\n' }
  let parsed
  try { parsed = JSON.parse(raw) } catch { parsed = null }
  return { kind, path: file, raw, parsed, valid: parsed !== null }
}

export async function writeConfigFile(agentDir, kind, raw) {
  const name = FILES[kind]
  if (!name) throw new Error('未知配置文件')
  const text = String(raw ?? '')
  JSON.parse(text)
  const file = path.join(agentDir, name)
  await mkdir(agentDir, { recursive: true })
  // 2-13：配置文件走原子写（临时文件 + rename + Windows EPERM 重试）。
  // models.json / auth.json 被 SDK 与 UI 并发读写，直接 writeFile 有截断风险。
  await atomicWriteText(file, text.endsWith('\n') ? text : `${text}\n`)
  return { kind, path: file, saved: true }
}

export async function loadModelsAuth(agentDir) {
  const models = await readJson(path.join(agentDir, FILES.models), { providers: {} })
  const auth = await readJson(path.join(agentDir, FILES.auth), {})
  const providers = models?.providers && typeof models.providers === 'object' ? models.providers : {}
  return { models, auth, providers }
}

export function providerCards(providers, auth, catalog) {
  const names = new Set([...Object.keys(providers), ...Object.keys(auth || {}), ...catalog.map((item) => item.provider)])
  return [...names].sort().map((name) => {
    const config = providers[name] || {}
    const models = Array.isArray(config.models) ? config.models : catalog.filter((item) => item.provider === name)
    const cred = auth?.[name]
    // OAuth 凭据（refresh/access 结构或显式 type:'oauth'）不含 key 字段——不能以 key 判定配置态
    const oauth = Boolean(cred && (cred.type === 'oauth' || (typeof cred === 'object' && typeof cred.refresh === 'string' && cred.refresh)))
    const key = config.apiKey || cred?.key || ''
    return {
      provider: name,
      baseUrl: config.baseUrl || '',
      api: config.api || '',
      oauth,
      configured: Boolean(key) || oauth,
      keyHint: key ? maskKey(key) : oauth ? 'OAuth' : '',
      modelCount: models.length,
      models: models.map((model) => ({
        id: model.id || model.name,
        name: model.name || model.id,
        reasoning: Boolean(model.reasoning),
        contextWindow: Number(model.contextWindow) || 0,
        maxTokens: Number(model.maxTokens) || 0
      }))
    }
  })
}

export async function testProvider(agentDir, provider, proxyUrl, overrides = {}) {
  const { providers, auth } = await loadModelsAuth(agentDir)
  const config = { ...(providers[provider] || {}), ...overrides }
  const key = String(config.apiKey || auth?.[provider]?.key || '').trim()
  const baseUrl = String(config.baseUrl || '').trim().replace(/\/+$/, '')
  if (!baseUrl) return { ok: false, message: '未配置 baseUrl' }
  if (!key) return { ok: false, message: '未配置 API Key' }
  const url = `${baseUrl}/models`
  const started = Date.now()
  try {
    return await withTempProxy(proxyUrl, async () => {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(20000)
      })
      const latency = Date.now() - started
      const text = await response.text()
      if (!response.ok) return { ok: false, message: `HTTP ${response.status}`, latency, detail: text.slice(0, 240) }
      let json
      try { json = JSON.parse(text) } catch { return { ok: false, message: '响应不是 JSON', latency } }
      const list = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : Array.isArray(json) ? json : []
      if (!list.length) return { ok: false, message: '响应里没有模型列表，未判定为成功', latency }
      return { ok: true, message: `已连接 · ${list.length} 个模型`, latency }
    })
  } catch (error) {
    return { ok: false, message: error.message || '连接失败', latency: Date.now() - started }
  }
}

export async function readProxy(agentDir) {
  return readJson(path.join(agentDir, FILES.proxy), { desktop: { mode: 'off', url: '' }, agent: { mode: 'off', url: '' } })
}

export async function writeProxy(agentDir, data) {
  const next = {
    desktop: { mode: data?.desktop?.mode === 'on' ? 'on' : 'off', url: String(data?.desktop?.url || '').trim() },
    agent: { mode: data?.agent?.mode === 'on' ? 'on' : 'off', url: String(data?.agent?.url || '').trim() }
  }
  await writeJson(path.join(agentDir, FILES.proxy), next)
  applyAgentProxy(next)
  return next
}

const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']
const INITIAL_PROXY_ENV = new Map(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]))

function setProxyEnv(url) {
  for (const key of PROXY_ENV_KEYS) {
    if (url) process.env[key] = url
    else delete process.env[key]
  }
}

function restoreProxyEnv(values) {
  for (const key of PROXY_ENV_KEYS) {
    const value = values.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

export function applyAgentProxy(proxy) {
  if (proxy?.agent?.mode === 'on' && proxy.agent.url) setProxyEnv(proxy.agent.url)
  else restoreProxyEnv(INITIAL_PROXY_ENV)
}

async function withTempProxy(url, operation) {
  if (!url) return operation()
  const previous = new Map(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]))
  setProxyEnv(url)
  try {
    return await operation()
  } finally {
    restoreProxyEnv(previous)
  }
}

export async function readProbes(agentDir) {
  const file = await readJson(path.join(agentDir, FILES.probes), { providers: {} })
  return { templates: Object.values(TEMPLATES), providers: file.providers || {} }
}

export async function saveProbes(agentDir, providers) {
  const current = await readJson(path.join(agentDir, FILES.probes), { providers: {} })
  current.providers = providers && typeof providers === 'object' ? providers : {}
  await writeJson(path.join(agentDir, FILES.probes), current)
  return { saved: true }
}

export async function runProbe(agentDir, provider, proxyUrl) {
  const { providers, auth } = await loadModelsAuth(agentDir)
  const stored = (await readProbes(agentDir)).providers[provider] || {}
  const config = providers[provider] || {}
  const template = TEMPLATES[stored.template] || TEMPLATES.openai
  const key = String(config.apiKey || auth?.[provider]?.key || stored.apiKey || '').trim()
  const baseUrl = String(config.baseUrl || '').replace(/\/+$/, '')
  const url = String(stored.url || template.url).replace('{baseUrl}', baseUrl)
  if (!url.startsWith('http')) return { ok: false, message: '用量地址无效' }
  try {
    return await withTempProxy(proxyUrl, async () => {
      const response = await fetch(url, {
        method: stored.method || template.method || 'GET',
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000)
      })
      const text = await response.text()
      if (!response.ok) return { ok: false, message: `HTTP ${response.status}`, detail: text.slice(0, 240) }
      let json
      try { json = JSON.parse(text) } catch { return { ok: false, message: '用量接口不是 JSON' } }
      const pathKey = stored.parse || template.parse
      const value = pathKey ? pick(json, pathKey) : json
      return { ok: true, message: value == null ? '已返回，但未解析到额度字段' : String(value), value, raw: json }
    })
  } catch (error) {
    return { ok: false, message: error.message || '用量查询失败' }
  }
}

export async function fetchProviderModels(baseUrl, apiKey, proxyUrl) {
  const root = String(baseUrl || '').trim()
  if (!/^https?:\/\//i.test(root)) return { ok: false, message: 'baseUrl 必须以 http(s):// 开头', models: [] }
  const key = String(apiKey || '').trim()
  const started = Date.now()
  try {
    return await withTempProxy(proxyUrl, async () => {
      const url = new URL(root)
      url.pathname = `${url.pathname.replace(/\/$/, '')}/models`
      url.search = ''
      url.hash = ''
      const headers = { Accept: 'application/json' }
      if (key) headers.Authorization = `Bearer ${key}`
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) })
      const text = await response.text()
      const latency = Date.now() - started
      if (!response.ok) return { ok: false, message: `拉取模型失败：HTTP ${response.status}`, latency, detail: text.slice(0, 240), models: [] }
      if (text.length > 1_000_000) return { ok: false, message: '模型列表响应过大', latency, models: [] }
      let json
      try { json = JSON.parse(text) } catch { return { ok: false, message: '模型列表不是有效 JSON', latency, models: [] } }
      const models = parseFetchedModels(json)
      return { ok: true, message: `获取到 ${models.length} 个模型`, latency, models }
    })
  } catch (error) {
    return { ok: false, message: error.message || '拉取模型失败', models: [], latency: Date.now() - started }
  }
}

export async function fetchProviderBalance(agentDir, payload, proxyUrl) {
  const { providers, auth } = await loadModelsAuth(agentDir)
  const name = String(payload?.provider || '').trim()
  const config = { ...(providers[name] || {}), ...payload }
  const key = String(config.apiKey || auth?.[name]?.key || '').trim()
  const baseUrl = String(config.baseUrl || '').trim()
  let url = ''
  try { url = normalizeBalanceUrl(config.balanceUrl || '') || '' } catch (error) {
    return { supported: false, ok: false, message: error.message }
  }
  if (url.includes('/api/v1/auth/me')) url = defaultBalanceUrl(baseUrl) ?? url
  if (!url) url = defaultBalanceUrl(baseUrl) ?? ''
  if (!url) return { supported: false, ok: false, message: '未配置余额查询 URL，中转站需要填如 https://ai.apiclub.top/v1/usage' }
  try {
    return await withTempProxy(proxyUrl, async () => {
      const headers = { Accept: 'application/json' }
      if (key) headers.Authorization = `Bearer ${key}`
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) })
      const text = await response.text()
      if (!response.ok) return { supported: true, ok: false, message: `查询余额失败：HTTP ${response.status}` }
      if (text.length > 1_000_000) return { supported: true, ok: false, message: '余额响应过大' }
      let json
      try { json = JSON.parse(text) } catch { return { supported: true, ok: false, message: '余额响应不是有效 JSON' } }
      const balance = parseProviderBalance(json)
      if (balance == null) return { supported: true, ok: false, message: '余额响应没有 balance / quota' }
      return { supported: true, ok: true, balance, message: `$${Number(balance).toFixed(2)}` }
    })
  } catch (error) {
    return { supported: true, ok: false, message: error.message || '查询余额失败' }
  }
}

export async function lookupModelHints(agentDir, modelIds, proxyUrl) {
  const ids = [...new Set((modelIds || []).map((id) => String(id || '').trim()).filter(Boolean))].slice(0, 200)
  if (!ids.length) return { models: [] }
  const cacheFile = path.join(agentDir, 'models-dev-cache.json')
  let payload
  try {
    const cached = JSON.parse(await readFile(cacheFile, 'utf8'))
    const age = typeof cached.fetchedAt === 'number' ? Date.now() - cached.fetchedAt : Number.POSITIVE_INFINITY
    if (age < 12 * 60 * 60 * 1000 && cached.catalog) payload = cached.catalog
  } catch { payload = undefined }
  if (!payload) {
    payload = await withTempProxy(proxyUrl, async () => {
      const response = await fetch('https://models.dev/api.json', {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(30000)
      })
      if (!response.ok) throw new Error(`models.dev 拉取失败：HTTP ${response.status}`)
      return JSON.parse(await response.text())
    })
    await writeJson(cacheFile, { fetchedAt: Date.now(), catalog: payload })
  }
  const catalog = flattenModelsDev(payload)
  return {
    models: ids.map((id) => matchModelsDev(id, catalog)).filter(Boolean)
  }
}

export { TEMPLATES }
