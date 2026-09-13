#!/usr/bin/env node
import readline from 'node:readline'
import os from 'node:os'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { DEFAULT_MODE, effectiveToolsForMode, isAgentMode } from './policy.ts'
import { createApprovalExtension } from './approval-extension.ts'
import { createRetryExtension } from './retry-no-body.ts'
import * as piConfig from './config.mjs'
import * as eco from './ecosystem.mjs'
import * as lan from './lan.mjs'
import * as petServer from './pet-server.mjs'

const sessions = new Map()
let runtime
let workspace = process.cwd()
const agentDir = path.join(os.homedir(), '.pi', 'agent')
const archivedSessionsFile = path.join(agentDir, 'pi-my-archived-sessions.json')
const agentUpdateCacheFile = path.join(agentDir, 'pi-my-agent-update.json')
const piSdkRoot = path.join(agentDir, 'pi-sdk')
const piSdkSelectionFile = path.join(piSdkRoot, 'current.json')
const execFileAsync = promisify(execFile)
const piAgentPackage = '@earendil-works/pi-coding-agent'
const piAgentRepoUrl = 'https://github.com/earendil-works/pi'
const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 修改：安装包里的 SDK 只作为兜底；用户更新的官方 SDK 放在用户目录，避免写入 Program Files。
const bundledSdkEntry = path.join(runtimeRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'index.js')

async function loadPiSdk() {
  let entry = bundledSdkEntry
  let source = 'bundled'
  let selectedVersion = ''
  try {
    const selected = JSON.parse(await readFile(piSdkSelectionFile, 'utf8'))
    const selectedDir = path.resolve(String(selected?.dir || ''))
    const versionsRoot = path.resolve(path.join(piSdkRoot, 'versions'))
    const relative = path.relative(versionsRoot, selectedDir)
    const selectedEntry = path.join(selectedDir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'index.js')
    if (/^\d+(?:\.\d+){2}(?:[-+][0-9A-Za-z.-]+)?$/.test(String(selected?.version || '')) && relative && !relative.startsWith('..') && !path.isAbsolute(relative) && existsSync(selectedEntry)) {
      entry = selectedEntry
      source = 'user'
      selectedVersion = String(selected.version)
    }
  } catch {
    // 没有用户覆盖版本时使用安装包内置 SDK。
  }
  const module = await import(pathToFileURL(entry).href)
  return { module, source, selectedVersion, entry }
}

const loadedSdk = await loadPiSdk()
let { createAgentSession, DefaultPackageManager, ModelRuntime, SessionManager, SettingsManager, DefaultResourceLoader } = loadedSdk.module
let sdkVersion = String(loadedSdk.module.VERSION || loadedSdk.selectedVersion || 'unknown')
let sdkSource = loadedSdk.source

// ask 模式确认桥：扩展 await → UI 回答
const DEFAULT_TOOLS = ['read', 'bash', 'edit', 'write']
const pendingConfirms = new Map()
let confirmSeq = 0
const confirmBridge = {
  requestConfirm: ({ sessionId, toolName, summary }) => new Promise((resolve) => {
    const confirmId = `c${++confirmSeq}`
    pendingConfirms.set(confirmId, resolve)
    send({ type: 'confirm_request', sessionId, confirmId, toolName, summary })
  }),
}

// OAuth 登录桥：把 SDK 的 AuthInteraction 事件/提问转发给 UI（每次登录请求独立，附带 provider）
const pendingLoginPrompts = new Map()
let loginPromptSeq = 0
function createLoginInteraction(provider) {
  return {
    notify: (event) => send({ type: 'login_event', provider, event }),
    prompt: (prompt) => new Promise((resolve, reject) => {
      const promptId = `lp${++loginPromptSeq}`
      pendingLoginPrompts.set(promptId, { resolve, reject })
      send({ type: 'login_prompt', provider, promptId, prompt })
    }),
  }
}

function packageManager() {
  const settingsManager = SettingsManager.create(workspace, agentDir)
  return new DefaultPackageManager({ cwd: workspace, agentDir, settingsManager })
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}
const logLines = []
function log(...args) {
  const line = `${new Date().toISOString()} ${args.map((item) => item instanceof Error ? (item.stack || item.message) : String(item)).join(' ')}`
  logLines.push(line)
  if (logLines.length > 400) logLines.splice(0, logLines.length - 400)
  process.stderr.write(`[pi-sidecar] ${line}\n`)
}
function reply(id, result, error) {
  send({ type: 'response', id, ok: !error, result, error: error ? String(error?.message ?? error) : undefined })
}
function summarizeEvent(event) {
  if (!event || typeof event !== 'object') return event
  const copy = { ...event }
  if (copy.type === 'message_update' && copy.assistantMessageEvent) {
    const inner = copy.assistantMessageEvent
    return { ...copy, delta: inner.delta, text: inner.text, thinking: inner.thinking, assistantMessageEvent: { type: inner.type, delta: inner.delta, text: inner.text, thinking: inner.thinking } }
  }
  if (copy.type === 'tool_execution_start' || copy.type === 'tool_execution_update' || copy.type === 'tool_execution_end') {
    return { type: copy.type, toolCallId: copy.toolCallId, toolName: copy.toolName, args: copy.args, partialResult: copy.partialResult, result: copy.result, isError: copy.isError }
  }
  return copy
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('')
}

function sessionHistory(session) {
  const history = []
  let userIndex = -1
  for (const entry of session.sessionManager.buildContextEntries()) {
    if (entry.type !== 'message') continue
    const message = entry.message
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue
    const text = contentText(message.content).trim()
    if (!text) continue
    const timestamp = Date.parse(entry.timestamp) || (typeof message.timestamp === 'number' ? message.timestamp : Date.now())
    if (message.role === 'user') {
      userIndex += 1
      history.push({ id: entry.id, role: 'user', text, timestamp, userIndex })
    } else {
      history.push({ id: entry.id, role: 'assistant', text, timestamp, userIndex: Math.max(0, userIndex) })
    }
  }
  return history
}

async function ensureRuntime(refresh = false) {
  if (refresh) runtime = undefined
  if (!runtime) runtime = await ModelRuntime.create({ agentDir, refreshOnCreate: refresh })
  return runtime
}

async function createSession(id, cwd = workspace, thinking, mode = DEFAULT_MODE) {
  const modelRuntime = await ensureRuntime()
  const entryMode = isAgentMode(mode) ? mode : DEFAULT_MODE
  const entry = { mode: entryMode }
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    extensionFactories: [
      createApprovalExtension({ getMode: () => entry.mode, sessionId: id, requestConfirm: confirmBridge.requestConfirm }),
      createRetryExtension()
    ],
  })
  await loader.reload()
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    sessionManager: SessionManager.create(cwd, path.join(agentDir, 'sessions')),
    resourceLoader: loader,
    tools: effectiveToolsForMode(entryMode, DEFAULT_TOOLS),
  })
  if (thinking) session.setThinkingLevel(thinking)
  const unsubscribe = session.subscribe((event) => {
    const summarized = summarizeEvent(event)
    lan.note(id, summarized)
    send({ type: 'event', sessionId: id, event: summarized })
  })
  Object.assign(entry, { session, unsubscribe, cwd })
  sessions.set(id, entry)
  return { id, sessionId: session.sessionId, cwd, file: session.sessionManager.getSessionFile(), mode: entry.mode }
}

async function openSession(id, file) {
  const existing = sessions.get(id)
  if (existing && existing.file && file && path.resolve(existing.file) === path.resolve(file)) {
    return {
      id,
      sessionId: existing.session.sessionId,
      cwd: existing.cwd,
      file: existing.file,
      history: sessionHistory(existing.session),
    }
  }
  if (existing) {
    try { await existing.session?.abort() } catch { /* ignore */ }
    try { existing.unsubscribe?.() } catch { /* ignore */ }
    sessions.delete(id)
  }
  const modelRuntime = await ensureRuntime()
  const sessionManager = SessionManager.open(file)
  const { session } = await createAgentSession({ cwd: sessionManager.getCwd() || workspace, agentDir, modelRuntime, sessionManager })
  const unsubscribe = session.subscribe((event) => {
    const summarized = summarizeEvent(event)
    lan.note(id, summarized)
    send({ type: 'event', sessionId: id, event: summarized })
  })
  sessions.set(id, { session, unsubscribe, cwd: sessionManager.getCwd() || workspace, file })
  return {
    id,
    sessionId: session.sessionId,
    cwd: sessionManager.getCwd() || workspace,
    file,
    history: sessionHistory(session),
  }
}

function versionParts(value) {
  return String(value || '').replace(/^v/, '').split('-')[0].split('.').map((part) => Number(part) || 0)
}

function isNewerVersion(latest, current) {
  const left = versionParts(latest)
  const right = versionParts(current)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] || 0) - (right[index] || 0)
    if (difference !== 0) return difference > 0
  }
  return false
}

function npmCommand() {
  const bundledNpm = path.join(runtimeRoot, process.platform === 'win32' ? 'npm.cmd' : 'npm')
  if (existsSync(bundledNpm)) return bundledNpm
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function sdkEntryFor(versionDir) {
  return path.join(versionDir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'index.js')
}

async function installPiSdkVersion(version) {
  const safeVersion = String(version || '').trim()
  if (!/^\d+(?:\.\d+){2}(?:[-+][0-9A-Za-z.-]+)?$/.test(safeVersion)) throw new Error('官方 Pi SDK 版本号格式不正确')
  const versionDir = path.join(piSdkRoot, 'versions', safeVersion)
  const entry = sdkEntryFor(versionDir)
  await mkdir(versionDir, { recursive: true })
  if (!existsSync(entry)) {
    await execFileAsync(npmCommand(), [
      'install',
      '--prefix', versionDir,
      '--omit=dev',
      '--ignore-scripts',
      `${piAgentPackage}@${safeVersion}`,
      '--registry=https://registry.npmjs.org',
    ], {
      cwd: agentDir,
      shell: true,
      windowsHide: true,
      timeout: 180000,
      maxBuffer: 8 * 1024 * 1024,
    })
  }
  if (!existsSync(entry)) throw new Error('Pi SDK 安装完成，但没有找到可加载的 dist/index.js')
  await writeFile(piSdkSelectionFile, `${JSON.stringify({ version: safeVersion, dir: versionDir, updatedAt: Date.now() }, null, 2)}\n`, 'utf8')
  return { version: safeVersion, dir: versionDir, entry }
}

async function checkAgentUpdate(force = false) {
  try {
    const cached = JSON.parse(await readFile(agentUpdateCacheFile, 'utf8'))
    if (!force && cached?.current === sdkVersion && cached?.source === sdkSource && cached?.checkedAt && Date.now() - Number(cached.checkedAt) < 6 * 60 * 60 * 1000) return cached
  } catch {
    // No cache yet: check the registry below.
  }
  const response = await fetch(`https://registry.npmjs.org/${piAgentPackage}/latest`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) throw new Error(`检查 Pi Agent 更新失败：HTTP ${response.status}`)
  const latest = String((await response.json())?.version || '')
  if (!latest) throw new Error('更新服务没有返回版本号')
  const result = {
    current: sdkVersion,
    latest,
    updateAvailable: isNewerVersion(latest, sdkVersion),
    url: `https://www.npmjs.com/package/${piAgentPackage}/v/${latest}`,
    repoUrl: piAgentRepoUrl,
    source: sdkSource,
    sourceLabel: sdkSource === 'user' ? '用户目录中的官方 SDK' : '安装包内置 SDK',
    checkedAt: Date.now(),
  }
  await writeFile(agentUpdateCacheFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  return result
}

async function updatePiSdk() {
  const check = await checkAgentUpdate(true)
  if (!check.updateAvailable) return { ...check, updated: false, restartRequired: false, message: '当前已经是最新的 Pi SDK' }
  const installed = await installPiSdkVersion(check.latest)
  // 新模块会在下次 sidecar 启动时加载；当前会话不能被半途替换，避免旧对象和新对象混用。
  return {
    ...check,
    current: check.current,
    latest: installed.version,
    updateAvailable: false,
    installedVersion: installed.version,
    source: 'user',
    sourceLabel: '用户目录中的官方 SDK',
    updated: true,
    restartRequired: true,
    message: `Pi SDK ${installed.version} 已安装，重启 Pi-My 后生效`,
  }
}

async function closeSession(id) {
  const entry = sessions.get(id)
  if (!entry) return { closed: false }
  try { await entry.session?.abort() } catch { /* ignore */ }
  try { entry.unsubscribe?.() } catch { /* ignore */ }
  sessions.delete(id)
  return { closed: true }
}

async function readArchivedSessions() {
  try {
    const parsed = JSON.parse(await readFile(archivedSessionsFile, 'utf8'))
    return new Set(Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

async function writeArchivedSessions(ids) {
  await writeFile(archivedSessionsFile, `${JSON.stringify([...ids].sort(), null, 2)}\n`, 'utf8')
}

async function setSessionArchived(id, archived) {
  if (!id) throw new Error('缺少会话 ID')
  const ids = await readArchivedSessions()
  if (archived) ids.add(String(id))
  else ids.delete(String(id))
  await writeArchivedSessions(ids)
  return { sessionId: String(id), archived: Boolean(archived) }
}

async function deleteSession(id, file) {
  const entry = sessions.get(id)
  const rawTarget = String(entry?.file || file || '')
  if (!rawTarget) throw new Error('会话文件不存在')
  const target = path.resolve(rawTarget)
  const sessionRoot = path.resolve(agentDir, 'sessions')
  const relative = path.relative(sessionRoot, target)
  if (!target || relative.startsWith('..') || path.isAbsolute(relative) || !target.toLowerCase().endsWith('.jsonl')) {
    throw new Error('会话文件路径无效，已拒绝删除')
  }
  if (entry) {
    try { await entry.session?.abort() } catch { /* ignore */ }
    try { entry.unsubscribe?.() } catch { /* ignore */ }
    sessions.delete(id)
  }
  try {
    await unlink(target)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const archived = await readArchivedSessions()
  if (archived.delete(String(id))) await writeArchivedSessions(archived)
  return { deleted: true, sessionId: String(id), file: target }
}

async function forkSession(sourceId, id, userMessageIndex, position = 'before') {
  const source = sessions.get(sourceId)
  if (!source?.file) throw new Error('当前会话还没有可用的分支文件')
  const sourceManager = SessionManager.open(source.file)
  const forkPoints = source.session.getUserMessagesForForking()
  const point = forkPoints[userMessageIndex]
  if (!point) throw new Error('找不到要分叉的用户消息')

  const selectedEntry = sourceManager.getEntry(point.entryId)
  if (!selectedEntry) throw new Error('分支位置已失效，请刷新会话后重试')
  const targetLeafId = position === 'at' ? selectedEntry.id : selectedEntry.parentId
  let targetManager
  if (targetLeafId) {
    targetManager = sourceManager
    targetManager.createBranchedSession(targetLeafId)
  } else {
    targetManager = SessionManager.create(sourceManager.getCwd(), sourceManager.getSessionDir())
    targetManager.newSession({ parentSession: source.file })
  }

  const cwd = targetManager.getCwd() || source.cwd || workspace
  const mode = source.mode || DEFAULT_MODE
  const entry = { mode }
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    extensionFactories: [
      createApprovalExtension({ getMode: () => entry.mode, sessionId: id, requestConfirm: confirmBridge.requestConfirm }),
      createRetryExtension()
    ],
  })
  await loader.reload()
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: await ensureRuntime(),
    sessionManager: targetManager,
    resourceLoader: loader,
    tools: effectiveToolsForMode(mode, DEFAULT_TOOLS),
  })
  const unsubscribe = session.subscribe((event) => {
    const summarized = summarizeEvent(event)
    lan.note(id, summarized)
    send({ type: 'event', sessionId: id, event: summarized })
  })
  const file = targetManager.getSessionFile()
  sessions.set(id, { session, unsubscribe, cwd, file, mode })
  return {
    id,
    sessionId: session.sessionId,
    cwd,
    file,
    parentFile: source.file,
    history: sessionHistory(session),
    selectedText: position === 'before' ? point.text : '',
  }
}

async function listSessions(cwd = workspace) {
  const infos = await SessionManager.list(cwd, path.join(agentDir, 'sessions'))
  const archived = await readArchivedSessions()
  return infos.map((info) => ({
    id: info.id,
    title: info.name || '未命名会话',
    cwd: info.cwd || cwd,
    file: info.path,
    parentSessionPath: info.parentSessionPath,
    createdAt: info.created.getTime(),
    modifiedAt: info.modified.getTime(),
    archived: archived.has(info.id),
  }))
}

async function listAllSessions() {
  const infos = await SessionManager.listAll(path.join(agentDir, 'sessions'))
  const archived = await readArchivedSessions()
  return infos.map((info) => ({
    id: info.id,
    title: info.name || '未命名会话',
    cwd: info.cwd || '',
    file: info.path,
    parentSessionPath: info.parentSessionPath,
    createdAt: info.created.getTime(),
    modifiedAt: info.modified.getTime(),
    archived: archived.has(info.id),
  }))
}
async function listFiles(cwd = workspace) {
  const root = path.resolve(cwd)
  const output = []
  async function visit(dir, depth) {
    if (depth > 6 || output.length >= 400) return
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || ['node_modules', 'dist', 'target'].includes(entry.name)) continue
      const absolute = path.join(dir, entry.name)
      const relative = path.relative(root, absolute).replaceAll('\\', '/')
      if (entry.isDirectory()) { output.push({ path: relative, kind: 'directory' }); await visit(absolute, depth + 1) }
      else output.push({ path: relative, kind: 'file' })
    }
  }
  await visit(root, 0)
  return output
}

async function readAuthProviders() {
  try {
    const raw = await readFile(path.join(agentDir, 'auth.json'), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : []
  } catch {
    return []
  }
}

// 只把用户明确添加过的 provider 当作已配置；SDK 内置目录不能直接暴露给模型选择器。
async function readConfiguredProviders() {
  const { providers, auth } = await piConfig.loadModelsAuth(agentDir)
  return new Set([...Object.keys(providers || {}), ...Object.keys(auth || {})])
}

// 按 provider 分组统计模型数量，标注是否已配置；按 modelCount 降序。
async function providerSummary() {
  const configured = await readConfiguredProviders()
  const counts = new Map()
  for (const model of (await ensureRuntime()).getModels()) {
    const provider = model?.provider || 'unknown'
    counts.set(provider, (counts.get(provider) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([provider, modelCount]) => ({ provider, modelCount, configured: configured.has(provider) }))
    .sort((a, b) => b.modelCount - a.modelCount || a.provider.localeCompare(b.provider))
}

async function configuredModels() {
  const [{ providers }, runtime] = await Promise.all([piConfig.loadModelsAuth(agentDir), ensureRuntime()])
  const configured = new Set([...Object.keys(providers || {}), ...await readAuthProviders()])
  return runtime.getModels()
    .filter((model) => {
      const config = providers?.[model.provider]
      if (!configured.has(model.provider) || config?.disabled === true) return false
      const configuredModels = Array.isArray(config?.models) ? config.models : []
      return !configuredModels.some((item) => (item.id || item.name) === model.id && item.hidden === true)
    })
    .map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    }))
}

function assertEcoTogglePath(rawPath) {
  const target = path.resolve(String(rawPath || ''))
  const roots = [
    path.join(agentDir, 'skills'),
    path.join(agentDir, 'extensions'),
    path.join(workspace, '.pi', 'skills'),
    path.join(workspace, '.pi', 'extensions')
  ].map((item) => path.resolve(item))
  const allowed = roots.some((root) => {
    const relative = path.relative(root, target)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  })
  if (!allowed) throw new Error('只能切换技能或扩展目录内的文件')
  return target
}

function openDirectory(target) {
  const dir = path.resolve(target)
  try {
    if (process.platform === 'win32') {
      execFile('explorer.exe', [dir]).on('error', () => {})
    } else {
      execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [dir]).on('error', () => {})
    }
  } catch {
    // 打开目录失败时静默
  }
}

// 仓库地址作为默认值；外部链接只允许 http(s)，避免 shell / 文件协议注入。
const REPO_URL = 'https://github.com/TANGZZee/pi-my'

function openUrl(rawUrl) {
  const parsed = new URL(String(rawUrl || REPO_URL))
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('仅允许打开 http(s) 链接')
  const url = parsed.toString()
  try {
    if (process.platform === 'win32') {
      execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url]).on('error', () => {})
    } else {
      execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]).on('error', () => {})
    }
  } catch {
    // 打开失败时静默
  }
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

// 会话上下文与用量统计；任何字段缺失都兜底为 0，不抛错。
function sessionStats(entry) {
  const messages = Array.isArray(entry.session.messages) ? entry.session.messages : []
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  let currentContext = 0
  for (const message of messages) {
    if (!message || message.role !== 'assistant' || !message.usage) continue
    const usage = message.usage
    totals.input += num(usage.input)
    totals.output += num(usage.output)
    totals.cacheRead += num(usage.cacheRead)
    totals.cacheWrite += num(usage.cacheWrite)
    totals.total += num(usage.totalTokens)
    // 口径：最近一条 assistant 消息的 usage，input + output + cacheRead 之和。
    currentContext = num(usage.input) + num(usage.output) + num(usage.cacheRead)
  }
  const model = entry.session.model
  const cost = model?.cost ?? {}
  const costUsd =
    (totals.input * num(cost.input) +
      totals.output * num(cost.output) +
      totals.cacheRead * num(cost.cacheRead) +
      totals.cacheWrite * num(cost.cacheWrite)) /
    1e6
  const denominator = totals.input + totals.cacheRead
  const cacheHitRate = denominator > 0 ? totals.cacheRead / denominator : 0
  return {
    currentContext,
    window: num(model?.contextWindow),
    totals,
    costUsd,
    cacheHitRate,
  }
}

async function usageStats(cwd = workspace) {
  const records = await listSessions(cwd)
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  const byModel = new Map()
  const byDay = new Map()
  const byProject = new Map()
  const activeDays = new Set()
  let turns = 0
  let costUsd = 0
  let costKnown = false

  for (const record of records) {
    let lines
    try { lines = (await readFile(record.file, 'utf8')).split(/\r?\n/) } catch { continue }
    let sessionHadUsage = false
    for (const line of lines) {
      if (!line.trim()) continue
      let row
      try { row = JSON.parse(line) } catch { continue }
      const message = row?.message
      const usage = message?.role === 'assistant' ? message.usage : null
      if (!usage) continue
      sessionHadUsage = true
      turns += 1
      const day = row.timestamp ? new Date(row.timestamp).toISOString().slice(0, 10) : ''
      if (day) {
        activeDays.add(day)
        byDay.set(day, (byDay.get(day) ?? 0) + num(usage.totalTokens))
      }
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) totals[key] += num(usage[key])
      totals.total += num(usage.totalTokens)
      const project = path.basename(record.cwd || cwd || '.')
      const projectItem = byProject.get(project) || { project, tokens: 0, turns: 0 }
      projectItem.tokens += num(usage.totalTokens)
      projectItem.turns += 1
      byProject.set(project, projectItem)
      const model = message.model || row.model || '未知模型'
      const item = byModel.get(model) || { model, tokens: 0, turns: 0 }
      item.tokens += num(usage.totalTokens)
      item.turns += 1
      byModel.set(model, item)
      if (usage.cost && typeof usage.cost === 'object') {
        const amount = num(usage.cost.total ?? usage.cost.totalCost)
        if (amount) { costUsd += amount; costKnown = true }
      }
    }
    if (sessionHadUsage) activeDays.add(new Date(record.modifiedAt).toISOString().slice(0, 10))
  }

  return {
    sessions: records.length,
    turns,
    activeDays: activeDays.size,
    totals,
    costUsd,
    costKnown,
    byModel: [...byModel.values()].sort((a, b) => b.tokens - a.tokens),
    byProject: [...byProject.values()].sort((a, b) => b.tokens - a.tokens),
    byDay: Object.fromEntries([...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
  }
}

async function generateImage(payload) {
  const baseUrl = String(payload.baseUrl || '').trim().replace(/\/+$/, '')
  const apiKey = String(payload.apiKey || '').trim()
  const model = String(payload.model || '').trim()
  const prompt = String(payload.prompt || '').trim()
  if (!/^https?:\/\//i.test(baseUrl) || !apiKey || !model || !prompt || prompt.length > 4000) throw new Error('生图配置或提示词无效')
  const response = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, prompt, n: 1, size: payload.size || '1024x1024', response_format: 'b64_json' }),
    signal: AbortSignal.timeout(180000),
  })
  if (!response.ok) throw new Error(`生图请求失败：HTTP ${response.status}`)
  const result = await response.json()
  const item = result?.data?.[0] || result?.images?.[0]
  if (item?.b64_json) return { data: item.b64_json, mimeType: 'image/png' }
  if (item?.url) return { url: item.url, mimeType: 'image/png' }
  throw new Error('生图服务未返回图片')
}

async function readWorkspaceFile(cwd, file) {  const root = path.resolve(cwd)
  const absolute = path.resolve(root, file)
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error('禁止读取工作区外的文件')
  const info = await stat(absolute)
  if (!info.isFile() || info.size > 512 * 1024) throw new Error('文件不存在或超过 512 KB')
  return { path: path.relative(root, absolute).replaceAll('\\', '/'), content: await readFile(absolute, 'utf8') }
}
async function writeWorkspaceFile(cwd, file, content) {
  const root = path.resolve(cwd)
  const absolute = path.resolve(root, file)
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error('禁止写入工作区外的文件')
  if (Buffer.byteLength(content, 'utf8') > 512 * 1024) throw new Error('文件超过 512 KB')
  await writeFile(absolute, content, 'utf8')
  return { path: file }
}

// 仅暴露非破坏性 Git 写操作；reset / checkout / clean / stash 等一律不提供。
async function git(cwd, args, { throwOnFailure = false } = {}) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: path.resolve(cwd), maxBuffer: 2 * 1024 * 1024, windowsHide: true })
    return stdout
  } catch (error) {
    if (error.code === 128 && !throwOnFailure) return ''
    throw error
  }
}

async function gitStatus(cwd = workspace) {
  const output = await git(cwd, ['status', '--porcelain=v1'])
  return output.split(/\r?\n/).filter(Boolean).map((line) => ({ code: line.slice(0, 2), path: line.slice(3) }))
}

async function gitDiff(cwd, file) {
  return git(cwd, ['diff', '--no-ext-diff', '--', file])
}
async function readAttachment(cwd, file) {
  const root = path.resolve(cwd)
  const absolute = path.resolve(root, file)
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error('禁止读取工作区外的文件')
  const info = await stat(absolute)
  if (!info.isFile()) throw new Error('不是文件')
  const ext = path.extname(absolute).toLowerCase()
  const imageMimes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
  if (imageMimes[ext]) {
    if (info.size > 8 * 1024 * 1024) throw new Error('图片超过 8 MB')
    return { kind: 'image', name: path.basename(absolute), mimeType: imageMimes[ext], data: (await readFile(absolute)).toString('base64') }
  }
  if (info.size > 512 * 1024) throw new Error('文本文件超过 512 KB')
  return { kind: 'text', name: path.basename(absolute), content: await readFile(absolute, 'utf8') }
}

async function handle(request) {
  const { id, type, payload = {} } = request
  try {
    if (type === 'init') {
      workspace = payload.cwd || workspace
      piConfig.applyAgentProxy(await piConfig.readProxy(agentDir))
      await ensureRuntime()
      petServer.startPetServer(agentDir)
      reply(id, { ready: true, cwd: workspace, agentDir })
      return
    }
    if (type === 'info') {
      reply(id, {
        node: process.version,
        sdk: sdkVersion,
        agentDir,
        sessionDir: path.join(agentDir, 'sessions'),
        authProviders: await readAuthProviders(),
        providers: await providerSummary(),
      })
      return
    }
    if (type === 'list_providers') {
      reply(id, await providerSummary())
      return
    }
    if (type === 'open_dir') {
      const target = String(payload.path ?? '')
      if (!target) throw new Error('路径为空')
      openDirectory(target)
      reply(id, { ok: true })
      return
    }
    if (type === 'open_url') {
      openUrl(String(payload.url || REPO_URL))
      reply(id, { ok: true })
      return
    }
    if (type === 'list_models') {
      const models = await configuredModels()
      reply(id, models)
      return
    }
    if (type === 'check_agent_update') {
      reply(id, await checkAgentUpdate(Boolean(payload.force)))
      return
    }
    if (type === 'update_pi_sdk') {
      reply(id, await updatePiSdk())
      return
    }
    if (type === 'set_workspace') {
      workspace = path.resolve(payload.cwd || workspace)
      reply(id, { cwd: workspace, files: await listFiles(workspace) })
      return
    }
    if (type === 'list_files') {
      reply(id, await listFiles(payload.cwd || workspace))
      return
    }
    if (type === 'read_file') {
      reply(id, await readWorkspaceFile(payload.cwd || workspace, payload.path))
      return
    }
    if (type === 'write_file') {
      reply(id, await writeWorkspaceFile(payload.cwd || workspace, payload.path, payload.content || ''))
      return
    }
    if (type === 'git_status') {
      reply(id, await gitStatus(payload.cwd || workspace))
      return
    }
    if (type === 'git_diff') {
      reply(id, await gitDiff(payload.cwd || workspace, payload.path))
      return
    }
    if (type === 'git_add') {
      const paths = Array.isArray(payload.paths) ? payload.paths.filter((item) => typeof item === 'string') : []
      if (!paths.length) throw new Error('未指定要暂存的文件')
      await git(payload.cwd || workspace, ['add', '--', ...paths], { throwOnFailure: true })
      reply(id, { added: paths })
      return
    }
    if (type === 'git_commit') {
      const message = String(payload.message ?? '').trim()
      if (!message) throw new Error('提交信息不能为空')
      try {
        await git(payload.cwd || workspace, ['commit', '-m', message], { throwOnFailure: true })
        reply(id, { committed: true })
      } catch (error) {
        const extra = [error?.stdout, error?.stderr].filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()).join('\n')
        throw new Error(extra || (error?.message ?? 'git commit 失败'))
      }
      return
    }
    if (type === 'git_push') {
      try {
        await git(payload.cwd || workspace, ['push'], { throwOnFailure: true })
        reply(id, { pushed: true })
      } catch (error) {
        const extra = [error?.stderr, error?.stdout].filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()).join('\n')
        throw new Error(extra || (error?.message ?? 'git push 失败'))
      }
      return
    }
    if (type === 'create_session') {
      const pid = payload.sessionId || `session-${Date.now()}`
      if (sessions.has(pid)) {
        const existing = sessions.get(pid)
        reply(id, { id: pid, sessionId: existing.session.sessionId, cwd: existing.cwd, file: existing.file })
        return
      }
      reply(id, await createSession(pid, payload.cwd || workspace, payload.thinking, payload.mode))
      return
    }
    if (type === 'session_stats') {
      const entry = sessions.get(payload.sessionId)
      if (!entry) throw new Error(`会话不存在: ${payload.sessionId}`)
      reply(id, sessionStats(entry))
      return
    }
    if (type === 'list_sessions') {
      reply(id, await listSessions(payload.cwd || workspace))
      return
    }
    if (type === 'list_all_sessions') {
      reply(id, await listAllSessions())
      return
    }
    if (type === 'usage_stats') {
      reply(id, await usageStats(payload.cwd || workspace))
      return
    }
    if (type === 'generate_image') {
      reply(id, await generateImage(payload))
      return
    }
    if (type === 'open_session') {
      reply(id, await openSession(payload.sessionId || payload.file, payload.file))
      return
    }
    if (type === 'close_session') {
      reply(id, await closeSession(payload.sessionId))
      return
    }
    if (type === 'set_session_archived') {
      reply(id, await setSessionArchived(payload.sessionId, Boolean(payload.archived)))
      return
    }
    if (type === 'delete_session') {
      reply(id, await deleteSession(payload.sessionId, payload.file))
      return
    }
    if (type === 'fork_session') {
      const forkId = payload.sessionId || `session-${Date.now()}`
      reply(id, await forkSession(payload.sourceSessionId, forkId, Number(payload.userMessageIndex), payload.position))
      return
    }
    if (type === 'rename_session') {
      const entry = sessions.get(payload.sessionId)
      if (!entry) throw new Error(`会话不存在: ${payload.sessionId}`)
      const name = String(payload.name ?? '').trim()
      if (!name) throw new Error('会话名称不能为空')
      entry.session.sessionManager.appendSessionInfo(name)
      reply(id, { sessionId: payload.sessionId, name })
      return
    }
    if (type === 'export_session') {
      const entry = sessions.get(payload.sessionId)
      const file = entry?.file || String(payload.file || '')
      if (!file) throw new Error('会话文件不存在')
      reply(id, { name: path.basename(file), content: await readFile(file, 'utf8') })
      return
    }
    if (type === 'set_model') {
      const entry = sessions.get(payload.sessionId)
      if (!entry) throw new Error(`会话不存在: ${payload.sessionId}`)
      const model = (await ensureRuntime()).getModels().find((item) => item.provider === payload.provider && item.id === payload.modelId)
      if (!model) throw new Error(`模型不存在: ${payload.provider}/${payload.modelId}`)
      await entry.session.setModel(model)
      reply(id, { provider: model.provider, id: model.id, name: model.name, thinkingLevel: entry.session.thinkingLevel })
      return
    }
    if (type === 'set_thinking') {
      const entry = sessions.get(payload.sessionId)
      if (!entry) throw new Error(`会话不存在: ${payload.sessionId}`)
      if (!payload.level) throw new Error('缺少思考档位')
      entry.session.setThinkingLevel(payload.level)
      reply(id, { level: entry.session.thinkingLevel })
      return
    }
    if (type === 'prompt') {
      let entry = sessions.get(payload.sessionId)
      if (!entry) {
        await createSession(payload.sessionId, payload.cwd || workspace, payload.thinking, payload.mode)
        entry = sessions.get(payload.sessionId)
      }
      if (!entry) throw new Error('无法创建 Agent 会话')
      // Do not await the whole turn: the UI must remain available for steering and abort.
      const attachments = Array.isArray(payload.attachments) ? payload.attachments : []
      const images = attachments.filter((a) => a.kind === 'image').map((a) => ({ type: 'image', data: a.data, mimeType: a.mimeType }))
      const textFiles = attachments.filter((a) => a.kind === 'text')
      const text = textFiles.length ? `${payload.text}\n\n${textFiles.map((a) => `--- 附件：${a.name} ---\n${a.content}`).join('\n\n')}` : payload.text
      const options = { streamingBehavior: payload.behavior || 'followUp' }
      if (images.length) options.images = images
      void entry.session.prompt(text, options).catch((error) => send({ type: 'event', sessionId: payload.sessionId, event: { type: 'error', message: error.message } }))
      reply(id, { accepted: true })
      return
    }
    if (type === 'set_mode') {
      const entry = sessions.get(payload.sessionId)
      if (!isAgentMode(payload.mode)) throw new Error(`未知模式：${payload.mode}`)
      if (entry) {
        entry.mode = payload.mode
        entry.session.setActiveToolsByName(effectiveToolsForMode(payload.mode, DEFAULT_TOOLS))
      }
      reply(id, { mode: payload.mode })
      return
    }
    if (type === 'confirm_response') {
      const resolve = pendingConfirms.get(payload.confirmId)
      pendingConfirms.delete(payload.confirmId)
      resolve?.(!!payload.ok)
      reply(id, { delivered: !!resolve })
      return
    }
    if (type === 'read_attachment') {
      reply(id, await readAttachment(payload.cwd || workspace, payload.path))
      return
    }
    if (type === 'abort') {
      const entry = sessions.get(payload.sessionId)
      await entry?.session.abort()
      for (const [confirmId, resolve] of pendingConfirms) {
        pendingConfirms.delete(confirmId)
        resolve(false)
      }
      reply(id, { aborted: true })
      return
    }
    if (type === 'config_read') {
      reply(id, await piConfig.readConfigFile(agentDir, payload.file))
      return
    }
    if (type === 'config_write') {
      reply(id, await piConfig.writeConfigFile(agentDir, payload.file, payload.raw))
      await ensureRuntime(true)
      return
    }
    if (type === 'config_cards') {
      const { providers, auth } = await piConfig.loadModelsAuth(agentDir)
      const catalog = (await ensureRuntime()).getModels().map((model) => ({
        provider: model.provider, id: model.id, name: model.name, reasoning: model.reasoning,
        contextWindow: model.contextWindow, maxTokens: model.maxTokens
      }))
      reply(id, piConfig.providerCards(providers, auth, catalog))
      return
    }
    if (type === 'refresh_models') {
      const models = await configuredModels()
      reply(id, { models, providers: await providerSummary() })
      return
    }
    if (type === 'test_provider') {
      const proxy = await piConfig.readProxy(agentDir)
      const url = proxy.desktop?.mode === 'on' ? proxy.desktop.url : ''
      reply(id, await piConfig.testProvider(agentDir, payload.provider, url, payload))
      return
    }
    if (type === 'fetch_models') {
      const proxy = await piConfig.readProxy(agentDir)
      const url = proxy.desktop?.mode === 'on' ? proxy.desktop.url : ''
      reply(id, await piConfig.fetchProviderModels(payload.baseUrl, payload.apiKey, url))
      return
    }
    if (type === 'fetch_balance') {
      const proxy = await piConfig.readProxy(agentDir)
      const url = proxy.desktop?.mode === 'on' ? proxy.desktop.url : ''
      reply(id, await piConfig.fetchProviderBalance(agentDir, payload, url))
      return
    }
    if (type === 'lookup_model_hints') {
      const proxy = await piConfig.readProxy(agentDir)
      const url = proxy.desktop?.mode === 'on' ? proxy.desktop.url : ''
      reply(id, await piConfig.lookupModelHints(agentDir, payload.ids || [], url))
      return
    }
    if (type === 'proxy_get') {
      reply(id, await piConfig.readProxy(agentDir))
      return
    }
    if (type === 'proxy_set') {
      reply(id, await piConfig.writeProxy(agentDir, payload))
      return
    }
    if (type === 'usage_probes_get') {
      reply(id, await piConfig.readProbes(agentDir))
      return
    }
    if (type === 'usage_probes_save') {
      reply(id, await piConfig.saveProbes(agentDir, payload.providers))
      return
    }
    if (type === 'usage_probe') {
      const proxy = await piConfig.readProxy(agentDir)
      const url = proxy.desktop?.mode === 'on' ? proxy.desktop.url : ''
      reply(id, await piConfig.runProbe(agentDir, payload.provider, url))
      return
    }
    if (type === 'eco_list') {
      reply(id, await eco.listEco(agentDir, payload.cwd || workspace))
      return
    }
    if (type === 'eco_toggle') {
      const target = assertEcoTogglePath(payload.path)
      reply(id, await eco.toggleEco(target, payload.enable))
      return
    }
    if (type === 'eco_search_prompts') {
      reply(id, await eco.searchPrompts(payload.query))
      return
    }
    if (type === 'eco_search_skills') {
      reply(id, await eco.searchSkillsHub(payload.query))
      return
    }
    if (type === 'eco_search_extensions') {
      reply(id, await eco.searchExtensions(payload.query))
      return
    }
    if (type === 'eco_download_pet') {
      reply(id, await eco.downloadPet(agentDir, payload.pet))
      return
    }
    if (type === 'eco_pet_status') {
      reply(id, await eco.listPets(agentDir, petServer.petServerBase()))
      return
    }
    if (type === 'eco_xue') {
      reply(id, eco.searchXue(payload.query, payload.category, payload.page))
      return
    }
    if (type === 'eco_install_prompt') {
      reply(id, await eco.installPrompt(agentDir, payload.item))
      return
    }
    if (type === 'eco_install_skill') {
      reply(id, await eco.installSkill(agentDir, payload.cwd || workspace, payload.item, payload.scope))
      return
    }
    if (type === 'eco_install_imagegen') {
      reply(id, await eco.installImageGenSkill(agentDir))
      return
    }
    if (type === 'eco_install_package') {
      const name = String(payload.name || '').trim()
      if (!name) throw new Error('包名不能为空')
      try {
        await packageManager().installAndPersist(`npm:${name}`)
        reply(id, { ok: true, name, message: '已安装' })
      } catch (error) {
        reply(id, { ok: false, name, message: error.message || '安装失败' })
      }
      return
    }
    if (type === 'eco_refresh') {
      await ensureRuntime(true)
      reply(id, { refreshed: true })
      return
    }
    if (type === 'eco_uninstall_package') {
      const name = String(payload.name || '').trim()
      if (!name) throw new Error('包名不能为空')
      try {
        await packageManager().removeAndPersist(`npm:${name}`)
        reply(id, { ok: true, name, message: '已移除' })
      } catch (error) {
        reply(id, { ok: false, name, message: error.message || '移除失败' })
      }
      return
    }
    if (type === 'vision_get') {
      reply(id, await eco.readVision(agentDir))
      return
    }
    if (type === 'vision_set') {
      reply(id, await eco.writeVision(agentDir, payload))
      return
    }
    if (type === 'vision_describe') {
      reply(id, await eco.describeImage(agentDir, payload))
      return
    }
    if (type === 'lan_status') {
      reply(id, lan.status())
      return
    }
    if (type === 'lan_set') {
      lan.setSnapshot(() => ({
        workspace,
        sessions: [...sessions.keys()].map((sid) => ({ id: sid, title: sid }))
      }))
      reply(id, payload.enabled ? lan.start(Number(payload.port) || 18787) : lan.stop())
      return
    }
    if (type === 'log_tail') {
      reply(id, { lines: logLines.slice(-(Number(payload.limit) || 200)) })
      return
    }
    if (type === 'oauth_login') {
      const provider = String(payload.provider || '').trim()
      if (!provider) throw new Error('缺少 provider')
      try {
        const credential = await (await ensureRuntime()).login(provider, 'oauth', createLoginInteraction(provider))
        reply(id, { ok: true, provider, message: `已登录 ${provider}` })
        await ensureRuntime(true)
      } catch (error) {
        reply(id, { ok: false, provider, message: error.message || '登录失败' })
      }
      return
    }
    if (type === 'login_prompt_response') {
      const pending = pendingLoginPrompts.get(payload.promptId)
      pendingLoginPrompts.delete(payload.promptId)
      if (!pending) { reply(id, { delivered: false }); return }
      if (payload.cancelled) pending.reject(new Error('用户取消登录'))
      else pending.resolve(String(payload.value ?? ''))
      reply(id, { delivered: true })
      return
    }
    throw new Error(`未知 sidecar 请求: ${type}`)
  } catch (error) {
    log(error)
    reply(id, null, error)
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of rl) {
  if (!line.trim()) continue
  try { await handle(JSON.parse(line)) } catch (error) { log(error) }
}
