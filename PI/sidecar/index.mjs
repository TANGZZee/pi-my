#!/usr/bin/env node
import readline from 'node:readline'
import os from 'node:os'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, unlink, writeFile, open } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { BASE_TOOLS, DEFAULT_MODE, isAgentMode, toolsForModeSwitch } from './policy.ts'
import { createApprovalExtension } from './approval-extension.ts'
import { createRetryExtension } from './retry-no-body.ts'
import { summarizeEvent, setWarnHandler } from './event-slim.mjs'
import { createUiContext } from './ui-context.ts'
import { makeShowImageTool } from './tools/show-image.ts'
import { atomicWriteJson } from './atomic-write.mjs'
import { closeMemoryDb, listMemories, rememberMemory, searchMemories, supersedeMemory, deleteMemory } from './memory.mjs'
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
const projectTrustFile = path.join(agentDir, 'pi-my-project-trust.json')
/** 2-10 MCP：全局配置（业界约定路径，SDK/adapter 消费同一份） */
const globalMcpFile = path.join(agentDir, 'mcp.json')
/** 2-14 项目信任缓存：cwd → boolean（本进程内复用，避免每个会话重复弹窗） */
const projectTrustCache = new Map()
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
// 工具集常量统一来自 ./policy.ts（BASE_TOOLS = 核心集 ∪ 只读集）
const pendingConfirms = new Map()
let confirmSeq = 0
// 1-6：按会话索引的待决权限确认（供局域网遥控页枚举"待确认的权限请求"）。
// confirm_response / abort 清理时同步删除。
const pendingConfirmsBySession = new Map()
const confirmBridge = {
  requestConfirm: ({ sessionId, toolName, summary }) => new Promise((resolve) => {
    const confirmId = `c${++confirmSeq}`
    pendingConfirms.set(confirmId, resolve)
    pendingConfirmsBySession.set(String(sessionId || ''), { dialogId: confirmId, toolName: String(toolName || '工具'), summary: String(summary || '') })
    send({ type: 'confirm_request', sessionId, confirmId, toolName, summary })
  }),
}

// 通用对话框桥（0-4）：扩展的 select/input/editor 也走同一套 request → response。
// confirm 由权限门控单独使用（它带 kind/危险段等语义），其余三种用这里。
//
// ⚠️ 超时必须有（审查发现的 P0-4）：sidecar 主循环是串行的，tool_call 钩子里
// await 一个永不 resolve 的对话框 Promise，会让 handle() 不返回 → **后续所有
// NDJSON 请求全部排队死锁**（与 OAuth 死锁同机理）。前端崩溃/关窗时连
// ui_dialog_response 都不会来，所以必须在 sidecar 侧自救。
// 超时后 resolve(undefined)（契约的"用户取消"）并广播 dialog_expired，
// 让前端知道扩展已按取消处理。
// 2-7 增强：超时/取消时各 kind 回落到"正确的默认值"而非一律 undefined ——
//   confirm → false（保守，不做危险操作）
//   select → 第一个选项（超时按默认项继续，扩展不至于拿到 undefined 崩溃）
//   input/editor → undefined（没有可推断的安全默认值）
// 该语义移植自 pi-agent-desktop 的 Extension UI Bridge（issue #41）。
const DIALOG_TIMEOUT_MS = 600_000
const pendingDialogs = new Map()
let dialogSeq = 0
/** 各 kind 的超时默认值；undefined = 没有安全默认，如实取消
 *  （用对象查找而非 switch-case：rpc-policy 的交叉校验用 case 标签扫描请求类型） */
const SELECT_DEFAULT = Symbol('select-first-option')
const DIALOG_TIMEOUT_DEFAULTS = {
  confirm: false,
  select: SELECT_DEFAULT,
}
function dialogTimeoutDefault(kind, payload) {
  const fallback = DIALOG_TIMEOUT_DEFAULTS[kind]
  if (fallback === SELECT_DEFAULT) {
    const options = Array.isArray(payload?.options) ? payload.options : []
    return options.length ? options[0] : undefined
  }
  return fallback
}
function requestDialog(kind, payload) {
  return new Promise((resolve) => {
    const dialogId = `d${++dialogSeq}`
    const timer = setTimeout(() => {
      if (!pendingDialogs.has(dialogId)) return
      pendingDialogs.delete(dialogId)
      const fallback = dialogTimeoutDefault(kind, payload)
      send({ type: 'dialog_expired', dialogId, kind, fallback: fallback === undefined ? 'cancel' : 'default' })
      resolve(fallback)
    }, DIALOG_TIMEOUT_MS)
    pendingDialogs.set(dialogId, { resolve, kind, timer })
    send({ type: 'ui_dialog_request', dialogId, kind, ...payload })
  })
}

/** 统一清理所有待决对话框（abort / close_session / 会话重建时调用）。 */
function drainPendingDialogs(reason) {
  for (const [, pending] of pendingDialogs) {
    clearTimeout(pending.timer)
    pending.resolve(undefined)
  }
  if (pendingDialogs.size) {
    log(`已取消 ${pendingDialogs.size} 个待决扩展对话框（${reason}）`)
    send({ type: 'dialog_expired', count: pendingDialogs.size, reason })
    pendingDialogs.clear()
  }
}

// 扩展 notify → 前端通知（带来源归因）
function notifyFromExtension(message, type, source) {
  send({ type: 'ext_notify', message, notifyType: type, source })
}

// ---------------------------------------------------------------------------
// 2-14 Project Trust：加载项目级扩展/Skill 前先确认信任该目录。
//
// 为什么必须有：`<workspace>/.pi/extensions` 里的 JS 会在本进程内执行——
// 克隆一个恶意仓库再用 Pi-My 打开 = 任意代码执行。SDK 提供了
// `loader.reload({ resolveProjectTrust })` 钩子正是为此设计。
//
// 语义：
//   - 全局扩展（~/.pi/agent/extensions）不需要信任——用户自己装的
//   - 项目级（<cwd>/.pi/extensions 与 skills）首次遇到 → 对话框询问
//   - 用户选择"始终信任" → 记入 ~/.pi/agent/pi-my-project-trust.json，下次不再问
//   - 拒绝 → 本次不加载项目级资源（全局的照常），不写记忆
//   - 对话框超时/通道异常 → 按拒绝处理（fail-safe）
// ---------------------------------------------------------------------------
function readProjectTrustStore() {
  try {
    const parsed = JSON.parse(readFileSync(projectTrustFile, 'utf8'))
    return parsed && typeof parsed === 'object' && typeof parsed.trusted === 'object' ? parsed : { trusted: {} }
  } catch {
    return { trusted: {} }
  }
}

async function writeProjectTrustStore(store) {
  await mkdir(path.dirname(projectTrustFile), { recursive: true })
  await atomicWriteJson(projectTrustFile, { trusted: store.trusted ?? {} })
}

/** 项目目录的信任键（跨盘/大小写规一，Windows 路径语义） */
function projectTrustKey(cwd) {
  return path.resolve(cwd).replaceAll('\\', '/').toLowerCase()
}

/**
 * 询问用户是否信任项目目录。返回 'always' | 'once' | 'never'。
 * fail-safe：超时/异常一律 'never'。
 */
async function askProjectTrust(cwd, extensionCount) {
  try {
    const choice = await requestDialog('confirm', {
      title: '是否信任此项目的扩展？',
      message: `${cwd}\n\n该项目自带 ${extensionCount} 个本地扩展/Skill，将在本进程内执行。` +
        '只在你信任这个项目的来源时允许。恶意项目可借此执行任意代码。',
      // confirm 桥只返回 true/false；用 label 表达"记住"语义的分离对话框会破坏现有协议，
      // 因此这里固定两步：先问一次性的允许，不允许直接拒绝。
    })
    return choice === true ? 'once' : 'never'
  } catch {
    return 'never'
  }
}

/**
 * 供 ResourceLoader.reload 使用的项目信任回调（2-14）。
 * 返回 true 才会加载 <cwd>/.pi 下的扩展与 Skill。
 *
 * 测试逃生口：PI_TRUST_ALL=1 时全部信任（仅测试套件使用；
 * 生产前端绝不设置此环境变量）。
 */
async function resolveProjectTrust({ extensionsResult } = {}) {
  if (process.env.PI_TRUST_ALL === '1') return true
  const count = Array.isArray(extensionsResult?.extensions) ? extensionsResult.extensions.length : 0
  // 没有项目级扩展时无须打扰用户
  if (count === 0) return true
  const key = projectTrustKey(workspace)
  if (projectTrustCache.has(key)) return projectTrustCache.get(key)

  const store = readProjectTrustStore()
  const remembered = store.trusted[key]
  if (typeof remembered === 'boolean') {
    projectTrustCache.set(key, remembered)
    if (!remembered) log(`项目 ${workspace} 已被标记为不受信任，跳过其 ${count} 个扩展`)
    return remembered
  }

  const choice = await askProjectTrust(workspace, count)
  if (choice === 'never') {
    log(`用户拒绝信任项目 ${workspace}，本次不加载其扩展`)
    projectTrustCache.set(key, false)
    return false
  }
  // 'once'：本次会话允许（进程内缓存），不写持久记忆 —— 用户可随时删除信任文件彻底重置。
  // 写持久记忆走显式的 trust_project RPC（前端设置页/会话菜单提供）。
  projectTrustCache.set(key, true)
  return true
}

/** 记住"始终信任"（显式 RPC，写持久存储）。 */
async function trustProject(cwd, trusted) {
  const key = projectTrustKey(cwd || workspace)
  const store = readProjectTrustStore()
  if (trusted) store.trusted[key] = true
  else delete store.trusted[key]
  await writeProjectTrustStore(store)
  projectTrustCache.set(key, Boolean(trusted))
  return { key, trusted: Boolean(trusted) }
}

// 扩展 UI 请求的记录（未实现的方法会走这里，使"插件静默失效"可诊断）
const unsupportedUiCalls = new Map()
function logUnsupportedUi(message, detail) {
  const key = String(message)
  unsupportedUiCalls.set(key, (unsupportedUiCalls.get(key) ?? 0) + 1)
  log(message, detail ?? '')
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

/**
 * 会话可用的全部工具名（模式切换的基准）。
 *
 * 实测：SDK 的 getAllTools() 只反映 createAgentSession 时传入的 tools（已被裁剪），
 * 所以基准必须由本模块自己累积——**只增不减**，这样 setActiveToolsByName 永远
 * 不会因为"基准变小"而丢工具（P0-2 的根因就是基准丢失）。
 *
 * 累积结果存在会话 entry 上（entry.knownTools），不挂在 SDK 对象上，
 * 避免污染第三方库的实例。
 */
function rememberTools(entry, names) {
  if (!entry || !Array.isArray(entry.knownTools)) {
    if (entry) entry.knownTools = []
  }
  if (!entry || !Array.isArray(names)) return entry?.knownTools ?? []
  for (const name of names) {
    if (typeof name === 'string' && name && !entry.knownTools.includes(name)) entry.knownTools.push(name)
  }
  return entry.knownTools
}

/** 读取会话当前可见的工具名，累积进 entry.knownTools，并返回全部已知工具。 */
function allToolNames(entry) {
  const session = entry?.session
  if (!session) return Array.isArray(entry?.knownTools) ? entry.knownTools : []
  try {
    const all = session.getAllTools?.()
    if (Array.isArray(all)) rememberTools(entry, all.map((tool) => (typeof tool === 'string' ? tool : tool?.name)))
  } catch (error) {
    log('getAllTools 不可用', error)
  }
  try {
    rememberTools(entry, session.getActiveToolNames?.())
  } catch (error) {
    log('getActiveToolNames 不可用', error)
  }
  return Array.isArray(entry.knownTools) ? entry.knownTools : []
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
// 事件瘦身实现见 ./event-slim.mjs（纯函数，可单测）；告警接到本模块的 log。
setWarnHandler((...args) => log(...args))

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

/** 统一的扩展 UI 上下文（三处会话创建共用，避免某个路径漏接）。 */
let cachedUiContext
function uiContext() {
  if (!cachedUiContext) {
    cachedUiContext = createUiContext({
      dialogs: {
        confirm: (title, message) => requestDialog('confirm', { title, message }),
        select: (title, options) => requestDialog('select', { title, options }),
        input: (title, placeholder) => requestDialog('input', { title, placeholder }),
        editor: (title, prefill) => requestDialog('editor', { title, prefill }),
      },
      notify: notifyFromExtension,
      setEditorText: (text, source) => send({ type: 'ext_editor_text', text, source }),
      log: logUnsupportedUi,
    })
  }
  return cachedUiContext
}

/** 统一构造扩展工厂列表（三处会话创建都用它，避免参数漂移）。 */
function sessionExtensions(entry, sessionId, cwd) {
  return [
    createApprovalExtension({
      getMode: () => entry.mode,
      sessionId,
      requestConfirm: confirmBridge.requestConfirm,
      agentDir,
      // 项目根（路径边界判定基准）。
      // 修复（审查 P1-5）：cwd === '.' 时不能用 undefined —— 那会完全跳过越界判定，
      // 首启未选工作区时界外写零弹窗。改用进程工作目录的绝对路径兜底，
      // 保证路径边界检查始终有一个真实根。
      getProjectRoot: () => path.resolve(cwd && cwd !== '.' ? cwd : workspace),
      getAllowedPatterns: () => entry.allowedPatterns ?? [],
      rememberAllowed: (pattern) => {
        if (!Array.isArray(entry.allowedPatterns)) entry.allowedPatterns = []
        if (pattern && !entry.allowedPatterns.includes(pattern)) entry.allowedPatterns.push(pattern)
      },
      warn: (...args) => log(...args),
    }),
    createRetryExtension(),
  ]
}

async function createSession(id, cwd = workspace, thinking, mode = DEFAULT_MODE) {
  const modelRuntime = await ensureRuntime()
  const entryMode = isAgentMode(mode) ? mode : DEFAULT_MODE
  const entry = { mode: entryMode }
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    extensionFactories: sessionExtensions(entry, id, cwd),
  })
  await loader.reload({ resolveProjectTrust })
  // 关键（P0-2 真正修好的地方）：创建时注册**并集**（核心集 ∪ 只读集），
  // 不按初始模式裁剪注册表。
  //
  // 实测：SDK 的注册表在 createAgentSession 时就被 `tools` 参数永久裁剪，
  // getAllTools() 之后只反映裁剪结果。若按初始模式分别传（plan 传 PLAN_TOOLS），
  // 那么在 plan 中创建的会话切到 ask/full 时基准里根本没有 bash —— 用户永远
  // 拿不回来；反之在 ask 中创建则切到 plan 时没有 grep/find/ls。传并集即可双向恢复。
  // plan 的只读约束由创建后的 setActiveToolsByName 施加，以及每次 set_mode 重算。
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    sessionManager: SessionManager.create(cwd, path.join(agentDir, 'sessions')),
    resourceLoader: loader,
    uiContext: uiContext(),
    tools: BASE_TOOLS,
    customTools: [makeShowImageTool()],
  })
  // 初始模式立即生效（plan 收紧为只读子集）
  session.setActiveToolsByName(toolsForModeSwitch(entryMode, BASE_TOOLS))
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

async function openSession(id, file, requestedMode) {
  const existing = sessions.get(id)
  if (existing && existing.file && file && path.resolve(existing.file) === path.resolve(file)) {
    // 同一文件已打开：沿用调用方请求的模式（不再无声保留旧模式）
    const nextMode = isAgentMode(requestedMode) ? requestedMode : (isAgentMode(existing.mode) ? existing.mode : DEFAULT_MODE)
    existing.mode = nextMode
    existing.session.setActiveToolsByName(toolsForModeSwitch(nextMode, allToolNames(existing)))
    return {
      id,
      sessionId: existing.session.sessionId,
      cwd: existing.cwd,
      file: existing.file,
      mode: existing.mode,
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
  const cwd = sessionManager.getCwd() || workspace
  // 修复：旧实现没传 resourceLoader / extensionFactories，导致**重开的会话丢失审批扩展**
  // ——ask 模式下的高危工具确认会静默失效（用户以为还在确认，实际全放行）。
  // 这里与 createSession 保持一致：加载资源 + 挂审批/重试扩展 + 注册并集工具。
  // 模式由调用方传入并回传：旧实现硬编码 DEFAULT_MODE，导致用户处于 plan 时
  // 打开过的会话被重开后静默获得写权限（UI 还显示"计划模式"）。
  const mode = isAgentMode(requestedMode) ? requestedMode : DEFAULT_MODE
  const entry = { mode }
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    extensionFactories: sessionExtensions(entry, id, cwd),
  })
  await loader.reload({ resolveProjectTrust })
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    sessionManager,
    resourceLoader: loader,
    uiContext: uiContext(),
    tools: BASE_TOOLS,
    customTools: [makeShowImageTool()],
  })
  session.setActiveToolsByName(toolsForModeSwitch(mode, BASE_TOOLS))
  const unsubscribe = session.subscribe((event) => {
    const summarized = summarizeEvent(event)
    lan.note(id, summarized)
    send({ type: 'event', sessionId: id, event: summarized })
  })
  Object.assign(entry, { session, unsubscribe, cwd, file })
  sessions.set(id, entry)
  return {
    id,
    sessionId: session.sessionId,
    cwd,
    file,
    // 回传实际生效的模式，前端据此校正 UI（避免"显示 plan、实际 ask"的失同步）
    mode: entry.mode,
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
  // 该会话挂着的扩展对话框一并取消，避免残留的 await 把主循环卡死
  drainPendingDialogs(`关闭会话 ${id}`)
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
  // 2-13：原子写（归档列表被 UI 与 sidecar 并发读写）
  await atomicWriteJson(archivedSessionsFile, [...ids].sort())
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
    extensionFactories: sessionExtensions(entry, id, cwd),
  })
  await loader.reload({ resolveProjectTrust })
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: await ensureRuntime(),
    sessionManager: targetManager,
    resourceLoader: loader,
    uiContext: uiContext(),
    // 与 createSession 一致：注册并集，plan 的只读限制在创建后施加，
    // 否则分叉出来的会话会继承"只能往小里切"的缺陷。
    tools: BASE_TOOLS,
    customTools: [makeShowImageTool()],
  })
  session.setActiveToolsByName(toolsForModeSwitch(mode, BASE_TOOLS))
  const unsubscribe = session.subscribe((event) => {
    const summarized = summarizeEvent(event)
    lan.note(id, summarized)
    send({ type: 'event', sessionId: id, event: summarized })
  })
  const file = targetManager.getSessionFile()
  // 安全相关（必须与 createSession/openSession 一致）：审批扩展在 loader 里通过闭包
  // 捕获的是上面那个 `entry`。如果把 `sessions` 存成**另一个**字面量对象，
  // `set_mode` 改的就是存储对象，而扩展读的仍是旧 entry —— 模式永远停在 fork 时的值。
  // 后果：从 full/plan fork 出的分支切到 ask 后，bash/edit/write **不弹确认直接执行**。
  Object.assign(entry, { session, unsubscribe, cwd, file })
  sessions.set(id, entry)
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
  // U3：扩展在运行时注册的 provider（SDK getRegisteredProviderIds）同样放行——
  // 它们不在 models.json/auth.json 里，但确实是本机 Pi 扩展动态注册的可用来源。
  // 审查口径：这类模型标记 source: 'extension'，前端可展示来源。
  const extensionProviders = new Set(runtime.getRegisteredProviderIds?.() ?? [])
  return runtime.getModels()
    .filter((model) => {
      const config = providers?.[model.provider]
      const fromExtension = extensionProviders.has(model.provider)
      if (!configured.has(model.provider) && !fromExtension) return false
      if (!fromExtension && config?.disabled === true) return false
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
      source: extensionProviders.has(model.provider) ? 'extension' : 'config',
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

// ---------------------------------------------------------------------------
// 2-3 Git worktree 分叉
//
// 场景：让 agent 做一版有风险的重构 —— 直接在主工作区跑会弄脏未提交的改动。
// worktree 分叉 = `git worktree add` 一个独立目录 + 分支会话在那里工作。
// 实验成功再 merge，失败整个目录一删即净。
// ---------------------------------------------------------------------------
const WORKTREE_ROOT = path.join(agentDir, 'worktrees')

function gitIn(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || error.message || 'git 失败').split('\n')[0].slice(0, 200)))
        return
      }
      resolve(String(stdout))
    })
  })
}

/** 规范化分支名（git ref 规则：空格/特殊字符 → 连字符） */
function safeBranchName(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'fork'
}

/**
 * 创建 worktree 分叉会话。
 * @returns {id, file, cwd, branch, worktreePath} —— cwd 是新 worktree，
 * 前端把它作为该会话的工作区（后续 prompt/工具都在这里执行）。
 */
async function createWorktreeFork(payload) {
  const sourceId = String(payload.sourceSessionId || '')
  const source = sessions.get(sourceId)
  if (!source) throw new Error('当前会话不存在')
  const hasHistory = Boolean(source.file && existsSync(source.file))
  const sourceCwd = source.cwd || workspace

  // 只在 git 仓库里可用
  let isRepo = false
  try {
    await gitIn(sourceCwd, ['rev-parse', '--is-inside-work-tree'])
    isRepo = true
  } catch {
    isRepo = false
  }
  if (!isRepo) throw new Error('当前工作区不是 git 仓库，无法创建 worktree 分叉')

  const forkId = String(payload.sessionId || `session-${Date.now()}`)
  const label = safeBranchName(payload.label || path.basename(sourceCwd))
  const branch = `pi-my/${label}-${Date.now().toString(36).slice(-4)}`
  const worktreePath = path.join(WORKTREE_ROOT, safeBranchName(`${path.basename(sourceCwd)}-${branch.split('/').pop()}`))
  if (existsSync(worktreePath)) throw new Error('同名 worktree 已存在，请稍后重试或先清理')

  // 建分支（以当前 HEAD 为基点）+ worktree
  await gitIn(sourceCwd, ['worktree', 'add', '-b', branch, worktreePath])
  try {
    let targetManager
    if (hasHistory) {
      // 有历史：用 SDK 的 forkFrom 把源会话历史带进**以 worktree 为 cwd** 的会话
      // （SessionManager 没有 setCwd —— forkFrom 是官方的换 cwd 分叉入口）
      const sourceManager = SessionManager.open(source.file)
      const forkPoints = source.session.getUserMessagesForForking()
      const index = Number(payload.userMessageIndex ?? -1)
      const hasForkPoint = index >= 0 && forkPoints[index]
      if (hasForkPoint) {
        const selectedEntry = sourceManager.getEntry(forkPoints[index].entryId)
        if (!selectedEntry) throw new Error('分支位置已失效，请刷新会话后重试')
      }
      targetManager = SessionManager.forkFrom(source.file, worktreePath, path.join(agentDir, 'sessions'), { parentSession: source.file })
      // 截断到指定位置（与普通分叉的 branched-session 语义一致）
      if (hasForkPoint) {
        const selectedEntry = sourceManager.getEntry(forkPoints[index].entryId)
        const targetLeafId = payload.position === 'at' ? selectedEntry.id : selectedEntry.parentId
        if (targetLeafId) targetManager.createBranchedSession(targetLeafId)
      }
    } else {
      // 源会话还没有历史（未发过消息）：直接在 worktree 里开新会话
      targetManager = SessionManager.create(worktreePath, path.join(agentDir, 'sessions'))
      targetManager.newSession({ parentSession: source.file ?? undefined })
    }

    const mode = source.mode || DEFAULT_MODE
    const entry = { mode }
    const loader = new DefaultResourceLoader({
      cwd: worktreePath,
      agentDir,
      extensionFactories: sessionExtensions(entry, forkId, worktreePath),
    })
    await loader.reload({ resolveProjectTrust })
    const { session } = await createAgentSession({
      cwd: worktreePath,
      agentDir,
      modelRuntime: await ensureRuntime(),
      sessionManager: targetManager,
      resourceLoader: loader,
      uiContext: uiContext(),
      tools: BASE_TOOLS,
      customTools: [makeShowImageTool()],
    })
    session.setActiveToolsByName(toolsForModeSwitch(mode, BASE_TOOLS))
    session.subscribe((event) => {
      const summarized = summarizeEvent(event)
      lan.note(forkId, summarized)
      send({ type: 'event', sessionId: forkId, event: summarized })
    })
    const newEntry = { mode, cwd: worktreePath }
    const file = targetManager.getSessionFile()
    sessions.set(forkId, {
      session,
      file,
      mode: newEntry.mode,
      cwd: worktreePath,
      branch,
      worktreePath,
      running: false,
    })
    return { id: forkId, file, cwd: worktreePath, branch, worktreePath, mode }
  } catch (error) {
    // 会话创建失败 → 回滚 worktree（不留垃圾目录）
    await gitIn(sourceCwd, ['worktree', 'remove', '--force', worktreePath]).catch(() => {})
    await gitIn(sourceCwd, ['branch', '-D', branch]).catch(() => {})
    throw error
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

// ---------------------------------------------------------------------------
// 2-12 文件查看器虚拟化：分块读取协议。
//
// 为什么：此前的 512KB 硬上限让大文件（构建产物、lockfile、日志）直接打不开，
// 而一次性传 512KB 文本过 IPC 再整段渲染也会卡 UI。看大文件其实只需要
// **可视窗口附近**的几十行。
//
// 协议：read_file_chunk(cwd, path, offset=0, limit=2000) →
//   { totalLines, lines: string[], offset }  行号从 0 计，含 offset 起 limit 行
// 前端按滚动位置换算 offset 拉取对应窗口；编辑保存仍走 write_file（全量）。
// ---------------------------------------------------------------------------
async function readWorkspaceFileChunk(cwd, rawPath, offset = 0, limit = 2000) {
  // 与 readAttachment 相同的工作区边界守卫
  const root = path.resolve(cwd)
  const absolute = path.resolve(root, rawPath)
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error('禁止读取工作区外的文件')
  const info = await stat(absolute).catch(() => { throw new Error(`文件不存在: ${rawPath}`) })
  if (!info.isFile()) throw new Error(`不是文件: ${rawPath}`)
  if (info.size > 64 * 1024 * 1024) throw new Error('文件超过 64 MB，请用外部编辑器打开')
  const handle = await open(absolute, 'r')
  try {
    // 流式逐行读，只保留请求的窗口 —— 全文件不进内存
    const rlLines = readline.createInterface({ input: handle.createReadStream(), crlfDelay: Infinity })
    const lines = []
    let index = 0
    let truncatedBytes = 0
    const safeOffset = Math.max(0, Math.floor(offset))
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 5000)
    let totalLines = 0
    for await (const line of rlLines) {
      if (index >= safeOffset && index < safeOffset + safeLimit) {
        // 单行超过 4000 字符截断（minified 文件），标记省略
        if (line.length > 4000) {
          lines.push(`${line.slice(0, 4000)}… [行截断，+${line.length - 4000} 字符]`)
          truncatedBytes += line.length - 4000
        } else {
          lines.push(line)
        }
      }
      index++
    }
    totalLines = index
    return { totalLines, offset: safeOffset, lines, truncatedBytes: truncatedBytes > 0 }
  } finally {
    await handle.close().catch(() => {})
  }
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
    if (type === 'read_file_chunk') {
      // 2-12：分块读取（虚拟化预览），单行超长截断
      reply(id, await readWorkspaceFileChunk(payload.cwd || workspace, payload.path, Number(payload.offset) || 0, Number(payload.limit) || 2000))
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
    if (type === 'get_state') {
      // 1-8：单一状态快照（peekState 语义 —— 只读，不重置任何计时器/生命周期）。
      // 供 U4 状态栏面板与轮询使用；与 session_stats 的区别是聚合了模式/工具/队列/运行态。
      const entry = sessions.get(payload.sessionId)
      if (!entry) throw new Error(`会话不存在: ${payload.sessionId}`)
      const stats = sessionStats(entry)
      const session = entry.session
      const sdkStats = session.getSessionStats?.()
      const contextUsage = session.getContextUsage?.()
      reply(id, {
        sessionId: payload.sessionId,
        mode: entry.mode,
        running: Boolean(entry.running),
        // 会话文件（分支导航/重开用）
        file: entry.file,
        // 模型与思考档位
        model: session.model ? { provider: session.model.provider, id: session.model.id, name: session.model.name } : null,
        thinkingLevel: session.thinkingLevel ?? null,
        // 队列（steer / follow-up）
        steering: [...(session.getSteeringMessages?.() ?? [])],
        followUp: [...(session.getFollowUpMessages?.() ?? [])],
        // 上下文用量（SDK 官方口径，含 tokens 与 cost）
        stats: {
          userMessages: sdkStats?.userMessages ?? 0,
          assistantMessages: sdkStats?.assistantMessages ?? 0,
          toolCalls: sdkStats?.toolCalls ?? 0,
          totalMessages: sdkStats?.totalMessages ?? 0,
          tokens: sdkStats?.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: sdkStats?.cost ?? 0,
          contextUsage: contextUsage ?? undefined,
        },
        // 兼容旧字段：前端 refreshCtxStats 已依赖这个形状
        ...stats,
        // 工具集（U5/U3 会用）
        tools: session.getActiveToolNames?.() ?? [],
      })
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
    if (type === 'trust_project') {
      // 2-14：显式设置项目信任（设置页/会话菜单调用）
      reply(id, await trustProject(payload.cwd, payload.trusted === true))
      return
    }
    if (type === 'provider_quotas') {
      // 2-8/U4：并发拉取各已配置 provider 的额度（runProbe 模板/自定义），限时返回。
      // 单个 provider 失败不影响其他（allSettled）。
      const { providers, auth } = await piConfig.loadModelsAuth(agentDir)
      const names = Object.keys(providers || {}).filter((name) => {
        const config = providers[name] || {}
        return (config.apiKey || auth?.[name]?.key) && config.disabled !== true
      }).slice(0, 12)
      const proxyUrl = await piConfig.readProxy(agentDir).then((p) => p?.url || '').catch(() => '')
      const results = await Promise.all(names.map(async (provider) => {
        try {
          const probe = await piConfig.runProbe(agentDir, provider, proxyUrl)
          return { provider, ok: probe.ok, message: probe.message, value: probe.value }
        } catch (error) {
          return { provider, ok: false, message: error.message || '查询失败' }
        }
      }))
      reply(id, { quotas: results, queriedAt: Date.now() })
      return
    }
    if (type === 'memory_search') {
      // 2-2 长期记忆：搜索当前项目的活跃记忆
      reply(id, { memories: searchMemories(agentDir, payload.cwd || workspace, payload.query, Number(payload.limit) || 20) })
      return
    }
    if (type === 'get_auto_compaction') {
      const entry = sessions.get(payload.sessionId)
      if (!entry) throw new Error(`会话不存在: ${payload.sessionId}`)
      reply(id, { enabled: entry.session.autoCompactionEnabled })
      return
    }
    if (type === 'set_auto_compaction') {
      // 1-2 上下文蒸发：会话级开关（SDK 默认已开，这里给用户关闭的自由）
      const entry = sessions.get(payload.sessionId)
      if (!entry) throw new Error(`会话不存在: ${payload.sessionId}`)
      entry.session.setAutoCompactionEnabled(payload.enabled === true)
      reply(id, { enabled: entry.session.autoCompactionEnabled })
      return
    }
    if (type === 'memory_remember') {
      const content = String(payload.content ?? '').trim()
      if (!content) throw new Error('记忆内容不能为空')
      if (content.length > 8000) throw new Error('单条记忆超过 8000 字符')
      const created = rememberMemory(agentDir, payload.cwd || workspace, content, Array.isArray(payload.tags) ? payload.tags : [])
      reply(id, created)
      return
    }
    if (type === 'memory_list') {
      reply(id, { memories: listMemories(agentDir, payload.cwd || workspace, Number(payload.limit) || 100) })
      return
    }
    if (type === 'memory_supersede') {
      // 取代：旧记忆打标记（可追溯），写入新记忆
      reply(id, supersedeMemory(agentDir, payload.cwd || workspace, Number(payload.oldId), String(payload.content ?? ''), Array.isArray(payload.tags) ? payload.tags : []))
      return
    }
    if (type === 'memory_delete') {
      reply(id, deleteMemory(agentDir, payload.cwd || workspace, Number(payload.id)))
      return
    }
    if (type === 'mcp_list') {
      // 2-10 MCP 服务器管理：读取全局（~/.pi/agent/mcp.json）与项目级（<cwd>/.pi/mcp.json）
      const read = async (file) => {
        try {
          const parsed = JSON.parse(readFileSync(file, 'utf8'))
          const servers = parsed?.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : {}
          return Object.entries(servers).map(([name, server]) => ({
            name: String(name),
            scope: file === globalMcpFile ? 'global' : 'project',
            command: String(server?.command || server?.url || server?.baseUrl || ''),
            transport: server?.command ? 'stdio' : server?.url ? 'http' : 'unknown',
            args: Array.isArray(server?.args) ? server.args : [],
            disabled: server?.disabled === true,
          }))
        } catch {
          return []
        }
      }
      const projectMcpFile = path.join(workspace, '.pi', 'mcp.json')
      reply(id, {
        global: await read(globalMcpFile),
        project: await read(projectMcpFile),
        globalPath: globalMcpFile,
        projectPath: projectMcpFile,
      })
      return
    }
    if (type === 'mcp_save') {
      // 2-10：保存指定 scope 的 mcpServers（整表覆盖，UI 负责合并语义）
      const scope = payload.scope === 'project' ? 'project' : 'global'
      const file = scope === 'global' ? globalMcpFile : path.join(workspace, '.pi', 'mcp.json')
      const servers = payload.mcpServers
      if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('mcpServers 必须是对象')
      const existing = (() => {
        try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return {} }
      })()
      existing.mcpServers = servers
      await mkdir(path.dirname(file), { recursive: true })
      await atomicWriteJson(file, existing)
      reply(id, { saved: true, scope, path: file, count: Object.keys(servers).length })
      return
    }
    if (type === 'mcp_test') {      // 2-10：连接测试 —— stdio 型：起进程，等它输出任意内容或 3 秒退出码判断
      const server = payload.server || {}
      const command = String(server.command || '').trim()
      if (!command) { reply(id, { ok: false, message: '缺少 command' }); return }
      const started = Date.now()
      try {
        // 只做"进程能否启动"的冒烟测试：不实现完整 MCP 握手（协议由 adapter 负责）
        const args = Array.isArray(server.args) ? server.args.map(String) : []
        const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
        let output = ''
        const timer = setTimeout(() => {
          child.kill()
          // 3 秒未退出且未崩溃 → 视为可启动（MCP 服务器常驻是正常状态）
          reply(id, { ok: true, message: `进程可启动（${Date.now() - started}ms 内无退出）`, latency: Date.now() - started })
        }, 3000)
        child.stdout.on('data', (chunk) => { output += chunk.toString() })
        child.on('exit', (code) => {
          clearTimeout(timer)
          if (code === 0) reply(id, { ok: true, message: '进程正常退出（可能是一次性工具）', latency: Date.now() - started })
          else reply(id, { ok: false, message: `进程退出码 ${code}。${output.slice(0, 160)}`, latency: Date.now() - started })
        })
        child.on('error', (error) => {
          clearTimeout(timer)
          reply(id, { ok: false, message: `无法启动: ${error.message.slice(0, 140)}` })
        })
      } catch (error) {
        reply(id, { ok: false, message: error.message || '启动失败' })
      }
      return
    }
    if (type === 'get_project_trust') {
      const key = projectTrustKey(payload.cwd || workspace)
      const store = readProjectTrustStore()
      reply(id, { key, remembered: store.trusted[key] ?? null, session: projectTrustCache.get(key) ?? null })
      return
    }
    if (type === 'open_session') {
      reply(id, await openSession(payload.sessionId || payload.file, payload.file, payload.mode))
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
    if (type === 'create_worktree_fork') {
      // 2-3 worktree 分叉：从当前会话的工作区创建独立 git worktree，
      // 分支会话在该 worktree 里跑 —— 大改动与主工作区物理隔离，互不踩文件。
      reply(id, await createWorktreeFork(payload))
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
    if (type === 'export_session_html') {
      const entry = sessions.get(payload.sessionId)
      if (!entry?.session) throw new Error(`会话不存在: ${payload.sessionId}`)
      // SDK 的 exportToHtml 直接挂在 AgentSession 上，无需深路径 import。
      const html = await entry.session.exportToHtml()
      const title = String(payload.name || path.basename(entry.file || 'session')).replace(/\.jsonl$/i, '')
      reply(id, { name: `${title}.html`, html: String(html) })
      return
    }
    if (type === 'export_session_md') {
      // 2-5 Markdown 导出：SDK 没有 exportToMd，从会话消息直接序列化。
      // 口径与 HTML 导出一致：user/assistant 对话轮次；工具调用折叠成摘要行。
      const entry = sessions.get(payload.sessionId)
      if (!entry?.session) throw new Error(`会话不存在: ${payload.sessionId}`)
      const messages = Array.isArray(entry.session.messages) ? entry.session.messages : []
      const title = String(payload.name || path.basename(entry.file || 'session')).replace(/\.jsonl$/i, '')
      const lines = [`# ${title}`, '']
      let tools = 0
      for (const message of messages) {
        if (!message || typeof message !== 'object') continue
        const role = message.role
        const text = typeof message.content === 'string'
          ? message.content
          : Array.isArray(message.content)
            ? message.content
                .map((part) => (typeof part === 'string' ? part : part?.text || ''))
                .filter(Boolean)
                .join('\n\n')
            : ''
        if (role === 'user' && text.trim()) {
          lines.push(`## 🧑 用户`, '', text.trim(), '')
        } else if (role === 'assistant' && text.trim()) {
          lines.push(`## 🤖 助手`, '', text.trim(), '')
        } else if (role === 'toolResult' || role === 'toolCall') {
          tools++
        }
      }
      lines.push('---', `共 ${messages.filter((m) => m?.role === 'user').length} 条用户消息 · ${tools} 次工具调用`)
      reply(id, { name: `${title}.md`, markdown: lines.join('\n') })
      return
    }
    if (type === 'compact_session') {
      const entry = sessions.get(payload.sessionId)
      if (!entry?.session) throw new Error(`会话不存在: ${payload.sessionId}`)
      if (entry.running) throw new Error('会话正在运行，无法压缩上下文')
      const result = await entry.session.compact(payload.customInstructions)
      reply(id, {
        summary: result?.summary ?? '',
        tokensBefore: result?.tokensBefore ?? 0,
        tokensAfter: result?.tokensAfter ?? 0,
      })
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
      // 维护 entry.running（审查 P1-3：此前是死检查，全文件没有赋值）。
      // 有了它，compact/export 才能真正拒绝"正在运行中的会话"。
      entry.running = true
      void entry.session
        .prompt(text, options)
        .catch((error) => send({ type: 'event', sessionId: payload.sessionId, event: { type: 'error', message: error.message } }))
        .finally(() => { entry.running = false })
      reply(id, { accepted: true })
      return
    }
    if (type === 'set_mode') {
      const entry = sessions.get(payload.sessionId)
      if (!isAgentMode(payload.mode)) throw new Error(`未知模式：${payload.mode}`)
      // P0-2 修复：切换必须基于会话的**全部**可用工具，
      // 而不是硬编码的 4 个——否则从 plan 切回 ask/full 会把 grep/find/ls
      // 永久丢失，直到会话重建。
      if (entry) {
        entry.mode = payload.mode
        entry.session.setActiveToolsByName(toolsForModeSwitch(payload.mode, allToolNames(entry)))
      } else {
        // 会话不存在时不再伪造成功，否则前端以为切换生效了。
        reply(id, null, new Error(`会话不存在: ${payload.sessionId}`))
        return
      }
      reply(id, { mode: payload.mode, tools: entry.session.getActiveToolNames() })
      return
    }
    if (type === 'confirm_response') {
      const resolve = pendingConfirms.get(payload.confirmId)
      pendingConfirms.delete(payload.confirmId)
      // 1-6：同步清理会话级索引
      pendingConfirmsBySession.forEach((meta, sid) => {
        if (meta.dialogId === payload.confirmId) pendingConfirmsBySession.delete(sid)
      })
      resolve?.(!!payload.ok)
      reply(id, { delivered: !!resolve })
      return
    }
    if (type === 'ui_dialog_response') {
      // 扩展 select/input/editor/confirm 的回答。
      // 取消语义要诚实：cancelled 时 resolve(undefined)，
      // 不要伪造成"第一项"或空串当作用户输入。
      const pending = pendingDialogs.get(payload.dialogId)
      pendingDialogs.delete(payload.dialogId)
      if (!pending) { reply(id, { delivered: false }); return }
      // 取消 sidecar 侧超时定时器，防止正常回答后再触发一次"取消"
      clearTimeout(pending.timer)
      if (pending.kind === 'confirm') {
        pending.resolve(payload.confirmed === true)
      } else if (payload.cancelled === true || payload.confirmed === false) {
        pending.resolve(undefined)
      } else if (payload.value !== undefined && payload.value !== null) {
        pending.resolve(String(payload.value))
      } else {
        pending.resolve(undefined)
      }
      reply(id, { delivered: true })
      return
    }
    if (type === 'ext_ui_diagnostics') {
      // 让用户/维护者看到"哪些扩展 UI 能力在桌面端未实现"
      reply(id, {
        unsupported: [...unsupportedUiCalls.entries()].map(([message, count]) => ({ message, count })),
      })
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
      // 1-6：abort 清理会话级确认索引
      pendingConfirmsBySession.clear()
      // 扩展对话框也必须一并取消（审查 P0-4）：否则 abort 之后扩展仍在等一个
      // 永远不会来的回答，sidecar 会继续卡住。
      drainPendingDialogs('用户中止')
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
      // 1-6：快照含每个会话的运行态与**待决权限确认**（pendingConfirmsBySession），
      // 可写模式下远程页可回答它们——语义与主界面的"允许/拒绝"完全一致，
      // 只是把按下按钮的位置换成了手机。
      lan.setSnapshot(() => ({
        workspace,
        sessions: [...sessions.entries()].map(([sid, entry]) => {
          const liveInfo = lan.peek(sid) || {}
          return {
            id: sid,
            title: sid,
            running: Boolean(entry.running),
            confirm: pendingConfirmsBySession.get(sid) || null,
            tool: liveInfo.tool || '',
            tail: liveInfo.tail || '',
          }
        }),
      }))
      const writable = payload.writable === true
      lan.setActions(
        {
          prompt: async ({ sessionId, text }) => {
            const entry = sessions.get(String(sessionId || ''))
            if (!entry) return { ok: false, error: '会话不存在' }
            const content = String(text ?? '').trim()
            if (!content || content.length > 8000) return { ok: false, error: '消息为空或超过 8000 字符' }
            if (entry.running) return { ok: false, error: '会话正在运行，请使用插话' }
            entry.running = true
            void entry.session
              .prompt(content, { streamingBehavior: 'followUp' })
              .catch(() => {})
              .finally(() => { entry.running = false })
            return { ok: true }
          },
          steer: async ({ sessionId, text }) => {
            const entry = sessions.get(String(sessionId || ''))
            if (!entry) return { ok: false, error: '会话不存在' }
            const content = String(text ?? '').trim()
            if (!content || content.length > 8000) return { ok: false, error: '消息为空或超过 8000 字符' }
            if (!entry.running) return { ok: false, error: '会话空闲，请直接发送消息' }
            await entry.session.steer(content)
            return { ok: true }
          },
          stop: async ({ sessionId }) => {
            const entry = sessions.get(String(sessionId || ''))
            if (!entry) return { ok: false, error: '会话不存在' }
            await entry.session.abort()
            return { ok: true }
          },
          confirm: async ({ dialogId, confirmed }) => {
            // 权限确认（confirm_request）与扩展对话框（ui_dialog_request）都可远程回答
            const confirmResolve = pendingConfirms.get(String(dialogId || ''))
            if (confirmResolve) {
              pendingConfirms.delete(String(dialogId))
              pendingConfirmsBySession.forEach((meta, sid) => {
                if (meta.dialogId === String(dialogId)) pendingConfirmsBySession.delete(sid)
              })
              confirmResolve(confirmed === true)
              return { ok: true }
            }
            const pending = pendingDialogs.get(String(dialogId || ''))
            if (pending) {
              clearTimeout(pending.timer)
              pendingDialogs.delete(String(dialogId))
              pending.resolve(confirmed === true)
              send({ type: 'dialog_expired', dialogId: String(dialogId), kind: pending.kind, fallback: 'cancel' })
              return { ok: true }
            }
            return { ok: false, error: '确认框不存在或已超时' }
          },
        },
        writable,
      )
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

// 主循环默认**串行**处理请求（前端逐条 await，顺序即语义）。
// 但有必须例外：oauth_login 与 ui_dialog_response 都会在"某条请求 await 用户"期间
// 从前端到达。此前的 `for await (const line of rl)` 在 handle() await 期间**根本
// 不读下一行**——所以就算把这两类摘出串行分支，它们的行也只是躺在管道里，
// 永远排不上队（审查 E2E 实测复现：回答已写入 stdin，create_session 仍挂到超时）。
//
// 修复：改为 rl.on('line') 事件驱动（Node 的 readline 会在后台持续读行并逐条
// 回调），串行语义由 handle() 的 pending 队列保证；非阻塞类型 fire-and-forget。
// 这样回答行总能在等待期间被读取并 resolve。
const NON_BLOCKING_REQUESTS = new Set(['oauth_login', 'ui_dialog_response', 'mcp_test'])
/** 串行执行链：保证同一时刻只有一个 handle 在跑（顺序语义不变） */
let serialChain = Promise.resolve()

rl.on('line', (line) => {
  if (!line.trim()) return
  let request
  try {
    request = JSON.parse(line)
  } catch (error) {
    log(error)
    return
  }
  const run = async () => {
    try {
      await handle(request)
    } catch (error) {
      log(error)
    }
  }
  if (NON_BLOCKING_REQUESTS.has(request?.type)) {
    void run()
    return
  }
  // 串行：接在前一个请求之后执行，保持"顺序即语义"
  serialChain = serialChain.then(run, run)
})
rl.on('close', () => {
  log('stdin 已关闭，sidecar 退出')
  process.exit(0)
})
