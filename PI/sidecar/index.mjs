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
import { releaseAllConfirms, releaseSessionConfirm, forgetConfirm, lastConfirmOfSession } from './session-confirms.mjs'
import { teardownSession, cancelSessionInteractions } from './session-teardown.mjs'
import * as petServer from './pet-server.mjs'
// T3-1: codemode + tool_search 扩展接线（能力探测，旧版 SDK 优雅降级）
import { codemodeExtensionFactories } from './extensions-wiring.mjs'
// T3-2: 虚拟模型（有序故障转移链）：纯路由 + 配置持久化（agentDir 下 JSON，atomicWriteJson 防 Windows 并发写损坏）
import { VIRTUAL_PREFIX, normalizeVirtualModelConfig, resolveVirtualChain, routeChain } from './virtual-models.mjs'

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

// ── T2⑥ MCP 原生化：SDK 能力面探测 ─────────────────────────────────────
// createMcpExtension 在 SDK 0.99.x 顶层导出（dist/index.d.ts:32）；config 工具函数
// （loadMcpConfig / updateMcpServerConfig 等）只存在于 dist/extensions/mcp/config.js
// 子路径，不在顶层导出面 —— 深导入并用能力探测降级（用户可更换 pi-sdk 版本，
// 旧版 SDK 没有这些导出时必须退回手写读取，而不是崩溃）。
// 注意：路径相对于 SDK 入口 dist/，与 loadPiSdk 的动态入口对齐（支持用户自选 SDK）。
const sdkDistDir = path.dirname(loadedSdk.entry)
const mcpExtension = typeof loadedSdk.module.createMcpExtension === 'function' ? loadedSdk.module.createMcpExtension : null
let mcpConfigApi = null
try {
  mcpConfigApi = await import(pathToFileURL(path.join(sdkDistDir, 'extensions', 'mcp', 'config.js')).href)
} catch {
  // 旧版 SDK：无该子路径 → mcpConfigApi 保持 null，mcp_list 走手写读取分支
}

// ask 模式确认桥：扩展 await → UI 回答
// 工具集常量统一来自 ./policy.ts（BASE_TOOLS = 核心集 ∪ 只读集）
const pendingConfirms = new Map()
let confirmSeq = 0
// 1-6：按会话索引的待决权限确认（供局域网遥控页枚举"待确认的权限请求"）。
// 值是**数组**：同一会话理论上可能有多条（审查缺陷 9 —— 早期单值索引会让第二条
// 覆盖第一条的索引，第一条就再也 release 不掉了）。当前 SDK 串行确认使其不可达，
// 但数组形式零代价地消除了这个隐患。confirm_response / abort / close 时同步清理。
const pendingConfirmsBySession = new Map()
const confirmBridge = {
  requestConfirm: ({ sessionId, toolName, summary }) => new Promise((resolve) => {
    const confirmId = `c${++confirmSeq}`
    const sid = String(sessionId || '')
    pendingConfirms.set(confirmId, resolve)
    const list = pendingConfirmsBySession.get(sid) || []
    list.push({ dialogId: confirmId, toolName: String(toolName || '工具'), summary: String(summary || '') })
    pendingConfirmsBySession.set(sid, list)
    send({ type: 'confirm_request', sessionId, confirmId, toolName, summary })
  }),
}

// 会话被关闭/删除/重建时，必须把该会话挂着的权限确认一起放行。
// 此前只有 abort 请求会清 pendingConfirms，而 closeSession/deleteSession 是直接
// 调 `entry.session.abort()`、绕过了那个处理函数 —— 结果：① `pendingConfirms` 里
// 永远留着一个不会有人回答的 resolve（扩展的工具调用永久悬挂）；
// ② `pendingConfirmsBySession` 的陈旧项会一直出现在局域网遥控页的"待确认"列表里。
function releaseSessionConfirms(sessionId) {
  const { released, resolved } = releaseSessionConfirm(pendingConfirms, pendingConfirmsBySession, sessionId)
  if (released.length) log(`会话 ${sessionId} 关闭，已放行待决权限确认 ${released.length}（resolved=${resolved}）`)
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
function requestDialog(kind, payload, sessionId = '') {
  return new Promise((resolve) => {
    const dialogId = `d${++dialogSeq}`
    const timer = setTimeout(() => {
      if (!pendingDialogs.has(dialogId)) return
      pendingDialogs.delete(dialogId)
      const fallback = dialogTimeoutDefault(kind, payload)
      send({ type: 'dialog_expired', dialogId, kind, sessionId, fallback: fallback === undefined ? 'cancel' : 'default' })
      resolve(fallback)
    }, DIALOG_TIMEOUT_MS)
    // 记下归属会话：abort/close/delete 只能取消**本会话**的对话框，
    // 否则中止一个会话会连别的会话正在等待的扩展对话框一起取消（审查 D1/#5）。
    pendingDialogs.set(dialogId, { resolve, kind, timer, sessionId: String(sessionId || '') })
    send({ type: 'ui_dialog_request', dialogId, kind, sessionId, ...payload })
  })
}

/**
 * 统一清理待决对话框（abort / close_session / 会话重建时调用）。
 * 传入 sessionId 时只清理该会话的（abort 必须收窄，否则会波及其它会话）；
 * 不传则全清（进程级 teardown）。
 */
function drainPendingDialogs(reason, sessionId) {
  const scope = sessionId === undefined ? undefined : String(sessionId || '')
  let count = 0
  for (const [dialogId, pending] of pendingDialogs) {
    if (scope !== undefined && pending.sessionId !== scope) continue
    clearTimeout(pending.timer)
    pending.resolve(undefined)
    pendingDialogs.delete(dialogId)
    count += 1
  }
  if (count) {
    log(`已取消 ${count} 个待决扩展对话框（${reason}）`)
    send({ type: 'dialog_expired', count, reason, sessionId: scope })
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

// ── 1-5 批次③：扩展声明式 iframe 渲染器（manifest：pi-ui.json） ──────────
// 信任模型（用户拍板）：扩展 UI 代码跑在 sandbox iframe（无同源特权），
// sidecar 只负责「把声明交给前端」，从不注入 token/会话数据。
// manifest 形状：{ renderers: [{ id?, customType, slot, kind:'iframe', target }] }
//   - customType 必须且只能声明一个（前端注册表按 customType 匹配）
//   - slot 仅允许 timeline/float/settings/status（保留槽之外直接拒）
//   - target 走前端注册表同款白名单（sandbox: 标识或 https:// URL）
const UI_MANIFEST_NAME = 'pi-ui.json'
const UI_MANIFEST_SLOTS = new Set(['timeline', 'float', 'settings', 'status'])
const UI_MANIFEST_MAX = 16

function normalizeUiManifest(raw) {
  if (!raw || typeof raw !== 'object') return []
  const list = Array.isArray(raw.renderers) ? raw.renderers : []
  const out = []
  for (const item of list.slice(0, UI_MANIFEST_MAX)) {
    if (!item || typeof item !== 'object') continue
    // 与前端 Settings.syncRendererRegistrations 同款归一化（trim+lower）：
    // 前端注册时会把 customType lower —— 声明若保留 'My.Chart'，消息经
    // normalizePluginMessage 是 'my.chart'，注册表 findByCustomType 大小写敏感
    // 不命中 → 渲染器静默回落内置 card（审查 BUG-3，fail-closed 但功能失效）。
    const customType = typeof item.customType === 'string' ? item.customType.trim().toLowerCase() : ''
    const slot = typeof item.slot === 'string' ? item.slot.trim() : ''
    const kind = typeof item.kind === 'string' ? item.kind.trim() : ''
    const target = typeof item.target === 'string' ? item.target.trim() : ''
    const title = typeof item.title === 'string' ? item.title.trim().slice(0, 120) : ''
    // customType 保留前缀（ui.*）由前端注册表二次拒绝 —— 这里也不放行明显的
    if (!customType || customType.toLowerCase().startsWith('ui.')) continue
    if (!UI_MANIFEST_SLOTS.has(slot)) continue
    if (kind !== 'iframe') continue
    // 与前端 ui-registry 同款白名单（双保险：sidecar 拒一次，前端注册时再拒一次）
    const sandboxId = target.startsWith('sandbox:') ? target.slice(8) : ''
    const isSandboxPage = sandboxId !== '' && /^[a-z0-9._-]+$/.test(sandboxId)
    const isHttps = /^https:\/\/[a-z0-9.-]+(:\d+)?(\/|$)/.test(target)
    if (!isSandboxPage && !isHttps) continue
    out.push({ customType, slot, kind, target, title })
  }
  return out
}

/** 收集已加载扩展目录里的 pi-ui.json 渲染器声明。 */
async function collectUiRendererManifests(extensionPaths) {
  const renderers = []
  for (const extPath of extensionPaths) {
    if (typeof extPath !== 'string' || !extPath) continue
    // 扩展 path 可能是目录或入口文件 —— 两种都归到目录找 pi-ui.json
    const dir = path.extname(extPath) ? path.dirname(extPath) : extPath
    const manifestPath = path.join(dir, UI_MANIFEST_NAME)
    try {
      const raw = JSON.parse(await readFile(manifestPath, 'utf8'))
      for (const entry of normalizeUiManifest(raw)) {
        renderers.push({ ...entry, source: dir })
      }
    } catch {
      // 无 manifest / 坏 JSON：静默跳过（不是错误 —— 大多数扩展没有 UI 声明）
    }
  }
  return renderers
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
    // 1-5 批次②：插件消息（custom_message 条目）也要进历史 —— 之前被丢弃，
    // 重开会话后时间线里所有插件卡片凭空消失（历史重放缺陷）。
    // 时间线渲染由前端 ui-plugins 的 normalizePluginMessage 把关，这里只透传。
    if (entry.type === 'custom_message') {
      const display = entry.display && typeof entry.display === 'object' ? entry.display : {}
      history.push({
        id: entry.id,
        role: 'plugin',
        customType: typeof entry.customType === 'string' ? entry.customType : '',
        text: typeof entry.content === 'string' ? entry.content : '',
        timestamp: Date.parse(entry.timestamp) || (typeof entry.timestamp === 'number' ? entry.timestamp : Date.now()),
        display,
      })
      continue
    }
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

/** T2⑦：汇总当前叶路径上生效的 context_edit 条目（后写覆盖先写，与 SDK buildSessionProjection 同序遍历）。
 *  供 list_context 返回 edits 清单，UI 据此展示「该条目已被编辑/剔除」。 */
function collectContextEdits(sessionManager) {
  const edits = []
  for (const item of sessionManager.buildContextEntries()) {
    if (item.type !== 'context_edit') continue
    const replacement = item.replacement ?? null
    const content = replacement && typeof replacement === 'object' ? replacement.content : undefined
    edits.push({
      entryId: item.id,
      targetId: typeof item.targetId === 'string' ? item.targetId : '',
      removed: replacement === null,
      text: typeof content === 'string' ? content : '',
      timestamp: Date.parse(item.timestamp) || (typeof item.timestamp === 'number' ? item.timestamp : Date.now()),
    })
  }
  return edits
}

// ── T3-2 虚拟模型（有序故障转移链）────────────────────────────────────────
// 产品语义：用户把若干已配置模型排成一条链；user 请求走链首，retry（模型失败/
// 压缩后 overflow）自动滑到下一个，continuation 保持；已到链尾则停在链尾。
// 路由决策在 ./virtual-models.mjs（纯函数，可单测）；这里负责与 SDK 的接线：
// 注册（registerVirtualModel 后目录立即合并虚拟模型，活更新同一 runtime 实例）。
const virtualModelsFile = path.join(agentDir, 'pi-my-virtual-models.json')
let virtualModelsConfig = { enabled: false, chain: [] }
// 启动即装载（此行在 loadVirtualModelsConfig 函数声明之后，函数声明有提升，
// 且 virtualModelsFile 已初始化——放顶部会踩 const TDZ）。
virtualModelsConfig = loadVirtualModelsConfig()

/** 读配置文件（缺文件/坏 JSON → 默认关闭，不抛错——坏配置不应阻止启动）。 */
function loadVirtualModelsConfig() {
  try {
    const raw = JSON.parse(readFileSync(virtualModelsFile, 'utf8'))
    const parsed = normalizeVirtualModelConfig(raw)
    if (parsed.ok) return parsed.config
  } catch {
    // 首次使用无文件 / 用户手改坏 JSON：回落默认（禁用、空链）
  }
  return { enabled: false, chain: [] }
}

/**
 * 把当前配置注册进 runtime（幂等）：先注销旧虚拟模型再注册新链。
 * 挂靠 provider = 链首模型 provider —— 继承其凭据可用性（避免 keyless provider
 * 被判不可用）；id 加 VIRTUAL_PREFIX 防撞物理 id（registerVirtualModel 撞 id 抛错）。
 * 链项已在 set RPC 时经 resolveVirtualChain 目录校验，这里只做防御性过滤。
 */
async function applyVirtualModels(rt, config) {
  const chain = Array.isArray(config?.chain) ? config.chain : []
  if (rt && typeof rt.unregisterVirtualModel === 'function' && Array.isArray(rt.__piMyVirtualIds)) {
    for (const { provider: p, id: mid } of rt.__piMyVirtualIds) {
      try { rt.unregisterVirtualModel(p, mid) } catch (error) { log('注销旧虚拟模型失败', error) }
    }
    rt.__piMyVirtualIds = []
  }
  if (!config?.enabled || !chain.length || !rt || typeof rt.registerVirtualModel !== 'function') return
  const registered = []
  for (const entry of chain) {
    // 目录防御性校验（set RPC 已校验过；配置文件手改/目录刷新后模型消失时跳过该项）
    const physical = rt.getPhysicalModel?.(entry.provider, entry.modelId)
    if (!physical) {
      log(`虚拟模型链项跳过（目录未命中）: ${entry.provider}/${entry.modelId}`)
      continue
    }
    try {
      rt.registerVirtualModel({
        provider: entry.provider,
        id: `${VIRTUAL_PREFIX}${entry.modelId}`,
        name: `故障转移 ${entry.modelId}`,
        thinkingLevels: typeof entry.thinkingLevel === 'string' && entry.thinkingLevel ? [entry.thinkingLevel] : undefined,
        contextWindow: physical.contextWindow,
        maxTokens: physical.maxTokens,
        route: (request) => {
          const decision = routeChain(virtualModelsConfig, request)
          // 决策给的是链上物理引用；SDK resolveModel 会按 provider/id 解析物理模型
          // 并钳制 thinkingLevel。state 经 VirtualModelStateData 随分支持久化。
          return decision
        },
      })
      registered.push({ provider: entry.provider, id: `${VIRTUAL_PREFIX}${entry.modelId}` })
    } catch (error) {
      log(`注册虚拟模型失败 ${entry.provider}/${VIRTUAL_PREFIX}${entry.modelId}`, error)
    }
  }
  rt.__piMyVirtualIds = registered
}

async function ensureRuntime(refresh = false) {
  if (refresh) runtime = undefined
  if (!runtime) {
    runtime = await ModelRuntime.create({ agentDir, refreshOnCreate: refresh })
    // T3-2：目录就绪后立即挂虚拟模型（注册即活更新目录；能力探测——旧版 SDK 无
    // registerVirtualModel 时静默跳过，get/set RPC 仍可读写配置）。
    await applyVirtualModels(runtime, virtualModelsConfig)
  }
  return runtime
}

/** 统一的扩展 UI 上下文（四处会话创建共用，避免某个路径漏接）。
 *  按会话现建：对话框要能归因到发起它的会话，abort/close 才能只清本会话的。
 *  不做全局缓存 —— 缓存按 sessionId 会随会话数无界增长，而这里一次会话只调一次。 */
function uiContext(sessionId = '') {
  const key = String(sessionId || '')
  return createUiContext({
    dialogs: {
      confirm: (title, message) => requestDialog('confirm', { title, message }, key),
      select: (title, options) => requestDialog('select', { title, options }, key),
      input: (title, placeholder) => requestDialog('input', { title, placeholder }, key),
      editor: (title, prefill) => requestDialog('editor', { title, prefill }, key),
    },
    notify: notifyFromExtension,
    setEditorText: (text, source) => send({ type: 'ext_editor_text', text, source }),
    // 1-5 批次②：状态行/标题桥接 —— ui-context.ts 已有 setStatus/setTitle，
    // 之前缺的只是 deps 回调。转发给前端的 status 槽（plugin_status）与标题栏（plugin_title）。
    // 注意命名：外层 `key` = 会话 id（dialogs 归因用）；onStatus 的第一参 `statusKey`
    // = 扩展声明的状态键（同一 key 覆盖旧值），二者语义不同，不能混用。
    onStatus: (statusKey, text) => send({ type: 'plugin_status', sessionId: key, key: statusKey, text }),
    onTitle: (title) => send({ type: 'plugin_title', sessionId: key, title }),
    log: logUnsupportedUi,
  })
}

/** 统一的扩展 UI 绑定（1-5 批次②核心）：每个会话创建后**恰好调用一次**。
 *
 * 为什么不用 createAgentSession 的 uiContext 选项：实测 SDK 0.85.x 会**静默忽略**
 * 该选项（dist/core/agent-session.js 不读它），唯一生效的官方通道是
 * rpc-mode 模板用的 `await session.bindExtensions({ uiContext, mode })`。
 *
 * 为什么不能调两次：bindExtensions 每次都会发射 session_start（实测 1×bind →
 * sessionStarts=1，2×bind → 2），扩展的 session_start 处理器会被重复执行；
 * reload() 内部会自动重新应用绑定（_buildRuntime），**绝不能在 reload 后再补绑**。
 *
 * mode:'print' 与官方 rpc-mode 模板一致——只影响 TUI 渲染分支，桌面端无感。
 */
async function bindUiContext(session, sessionId) {
  await session.bindExtensions({
    uiContext: uiContext(sessionId),
    mode: 'print',
    // 1-5 批次②：扩展错误对用户不可见是既有缺陷 —— sidecar 从不订阅 runner 错误，
    // 扩展崩了用户毫无感知。这里借 bindExtensions 的官方 onError 通道把错误
    // 推给前端（ext_error）。错误对象形状（SDK runner.js emitError）：
    // { extensionPath, event, error, stack? }。
    // reload 后 _applyExtensionBindings 会用存储的监听器自动重挂，无需补绑。
    onError: (err) => send({
      type: 'ext_error',
      extensionPath: typeof err?.extensionPath === 'string' ? err.extensionPath : '',
      event: typeof err?.event === 'string' ? err.event : '',
      error: typeof err?.error === 'string' ? err.error : String(err?.error ?? ''),
    }),
  })
  // 1-5 批次②：阻止插件消息污染 LLM 上下文。
  // SDK 默认的 convertToLlm（dist/core/messages.js:89）把 role:'custom' 一律转成
  // user 消息塞进 prompt —— 插件卡片（UI 展示数据）会被模型当成用户发言。
  // 这里重写会话级转换器：customType 以 'ui.' 开头的插件消息直接跳过，
  // 其余消息回落 SDK 默认实现。session.agent 跨 reload() 存活，重写一次即可。
  const agent = session.agent
  if (agent && typeof agent.convertToLlm !== 'function') return
  const defaultConvertToLlm = agent.convertToLlm.bind(agent)
  agent.convertToLlm = (messages) => defaultConvertToLlm(
    (Array.isArray(messages) ? messages : []).filter(
      (m) => !(m?.role === 'custom' && typeof m?.customType === 'string' && m.customType.startsWith('ui.')),
    ),
  )
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
    // T2⑥ MCP 原生化：SDK 内置 MCP 扩展连接 mcp.json 里的服务器，把工具注册为
    // `mcp__<server>__<tool>`。默认读 agent 目录 mcp.json + 受信项目 .pi/mcp.json，
    // 默认 stdio + streamable HTTP 传输 —— 与 sidecar 手写 mcp_list 同源同路径。
    // 每次会话创建都现取工厂（extensionRunner 在 reload() 后是新对象，见 :2011 纪律；
    // 工厂本身无状态，跨 reload 重挂安全）。
    ...(mcpExtension ? [mcpExtension()] : []),
    // T3-1：codemode（模型可写 JS 脚本批量编排其他工具，嵌套调用走 ctx.executeTool
    // → 审批/权限链与直调一致）+ tool_search（deferred 工具的按需检索）。
    // 注册时 inactive（defaultActive:false），点亮由初始激活/ set_mode 的全量基准完成。
    // 旧版 SDK 无导出 → 空数组，优雅降级。
    ...codemodeExtensionFactories({ module: loadedSdk.module }),
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
  // 关键（P0-2 + T3-1）：创建时**不传 `tools`** —— SDK 的 allowedToolNames 会把注册表
  // **永久裁剪**到传入集合（agent-session.js :2746-2828 实证），旧实现传 BASE_TOOLS 时
  // mcp__*、codemode、tool_search 根本进不了注册表。不裁剪后：
  // - 内置 8 工具全注册（相对旧集的 direct 增量只有 powershell，CONFIRM_TOOLS 已覆盖其 ask 确认）；
  // - codemode/tool_search 以 model-only 曝光入表（defaultActive:false，不自动激活）；
  // - MCP 服务器工具（mcp__*）随扩展注册进表；
  // - customTools 不受影响（裁剪只作用于 allowedToolNames 集合，show_image 不在其中也不被裁）。
  // 模式约束仍由创建后的 setActiveToolsByName + 每次 set_mode 重算施加：
  // plan 白名单（PLAN∪CUSTOM）天然排除新工具；ask/full 全量点亮（危险工具由确认桥逐次拦截）。
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    sessionManager: SessionManager.create(cwd, path.join(agentDir, 'sessions')),
    resourceLoader: loader,
    customTools: [makeShowImageTool()],
  })
  // 1-5 批次②：bindExtensions 是 uiContext 唯一生效通道（createAgentSession
  // 会静默忽略 uiContext 选项），且每会话只能绑定一次（详见 bindUiContext 注释）。
  await bindUiContext(session, id)
  const unsubscribe = session.subscribe((event) => {
    const summarized = summarizeEvent(event)
    lan.note(id, summarized)
    send({ type: 'event', sessionId: id, event: summarized })
  })
  Object.assign(entry, { session, unsubscribe, cwd })
  sessions.set(id, entry)
  // T3-1 时序承重：初始激活必须在 entry 挂上 session 之后 —— allToolNames 基准读
  // entry.session.getAllTools()（全量注册表）；空壳 entry 返回 [] → toolsForModeSwitch
  // 回落 BASE_TOOLS，codemode/tool_search/mcp__* 在首次 set_mode 前永远不被点亮。
  session.setActiveToolsByName(toolsForModeSwitch(entryMode, allToolNames(entry)))
  if (thinking) session.setThinkingLevel(thinking)
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
    // 顺序承重（放行先于 abort）见 ./session-teardown.mjs（审查 D1）：
    // 旧实例若正卡在权限确认上，abort() 会永远等不到 waitForIdle。
    await teardownSession({
      id,
      reason: `重建会话 ${id}`,
      releaseConfirms: releaseSessionConfirms,
      drainDialogs: drainPendingDialogs,
      abort: () => existing.session?.abort(),
      unsubscribe: () => existing.unsubscribe?.(),
      forget: (sid) => sessions.delete(sid),
    })
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
    // T3-1：不传 tools（注册表不裁剪，codemode/tool_search/mcp__* 才能进表）；见 createSession 处详注。
    customTools: [makeShowImageTool()],
  })
  await bindUiContext(session, id)
  const unsubscribe = session.subscribe((event) => {
    const summarized = summarizeEvent(event)
    lan.note(id, summarized)
    send({ type: 'event', sessionId: id, event: summarized })
  })
  Object.assign(entry, { session, unsubscribe, cwd, file })
  sessions.set(id, entry)
  // T3-1 时序承重：同 createSession —— 激活基准 allToolNames(entry) 读 entry.session，
  // 必须在挂载之后（空壳 entry → 回落 BASE_TOOLS，新工具点不亮）。
  session.setActiveToolsByName(toolsForModeSwitch(mode, allToolNames(entry)))
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
  // 顺序承重逻辑（放行必须在 abort() 之前）抽在 ./session-teardown.mjs，
  // 那里有完整的 SDK 源码级论证 + 行为化单测（审查 D1 + T1：文本正则测不出顺序）。
  await teardownSession({
    id,
    reason: `关闭会话 ${id}`,
    releaseConfirms: releaseSessionConfirms,
    drainDialogs: drainPendingDialogs,
    abort: () => entry.session?.abort(),
    unsubscribe: () => entry.unsubscribe?.(),
    forget: (sid) => sessions.delete(sid),
  })
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
    // 顺序承重（放行先于 abort）见 ./session-teardown.mjs（审查 D1）。
    await teardownSession({
      id,
      reason: `删除会话 ${id}`,
      releaseConfirms: releaseSessionConfirms,
      drainDialogs: drainPendingDialogs,
      abort: () => entry.session?.abort(),
      unsubscribe: () => entry.unsubscribe?.(),
      forget: (sid) => sessions.delete(sid),
    })
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
    // 与 createSession 一致：不裁剪注册表（T3-1），plan 只读限制在创建后施加，
    // 否则分叉出来的会话会继承"只能往小里切"的缺陷。
    customTools: [makeShowImageTool()],
  })
  await bindUiContext(session, id)
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
  // T3-1：初始激活必须在 entry 挂上 session 之后（allToolNames 基准要读
  // entry.session.getAllTools() 全量注册表；空壳时 toolsForModeSwitch 会回落 BASE_TOOLS，
  // fork 出的会话就永远点不亮 codemode/tool_search/mcp__*）。
  session.setActiveToolsByName(toolsForModeSwitch(mode, allToolNames(entry)))
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
      // T3-2：虚拟模型是路由壳，不是可直接选中的模型——不进配置目录
      // （UI 的模型下拉/链编辑都从这份列表取选项）。
      if (typeof model.id === 'string' && model.id.startsWith(VIRTUAL_PREFIX)) return false
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
      // T3-1：不裁剪注册表（与 createSession/openSession/fork 一致）
      customTools: [makeShowImageTool()],
    })
    await bindUiContext(session, forkId)
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
    // T3-1：初始激活必须在 sessions.set 之后 —— allToolNames 从 sessions 存的 entry
    // 读全量注册表（entry 无 knownTools 字段时自动初始化，安全）；放在 set 之前会拿到
    // 空基准回落 BASE_TOOLS，fork 会话永远点不亮 codemode/tool_search/mcp__*。
    session.setActiveToolsByName(toolsForModeSwitch(mode, allToolNames(sessions.get(forkId))))
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

/** T2⑥（对抗审查 A）：MCP 配置文件写入互斥锁 —— mcp_save（整表覆盖）与 mcp_patch
 *  （单键编辑）都是读-改-写，并发时会互相吞掉改动（丢失更新）。按文件路径串行化：
 *  同一文件的写操作排队执行，不同文件（global/project）互不阻塞。进程内锁即可 ——
 *  sidecar 是唯一写入方（UI 不直写配置文件）。 */
const mcpWriteLocks = new Map()
async function withMcpWriteLock(file, fn) {
  const prev = mcpWriteLocks.get(file) || Promise.resolve()
  const run = prev.catch(() => {}).then(fn)
  mcpWriteLocks.set(
    file,
    run.finally(() => {
      if (mcpWriteLocks.get(file) === run) mcpWriteLocks.delete(file)
    }),
  )
  return run
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
    if (type === 'get_virtual_models') {
      // T3-2：读虚拟模型链配置（enabled + 链项 + 逐项目录命中状态，供 UI 渲染告警）
      const catalog = await configuredModels()
      const resolved = resolveVirtualChain(virtualModelsConfig.chain, catalog)
      reply(id, {
        supported: typeof (await ensureRuntime()).registerVirtualModel === 'function',
        config: virtualModelsConfig,
        issues: resolved.ok ? resolved.issues : (resolved.issues ?? [{ index: -1, error: resolved.error }]),
      })
      return
    }
    if (type === 'set_virtual_models') {
      // T3-2：写配置 = 校验 → 目录解析（链项必须命中已配置物理模型）→ 持久化 →
      // 注册进 runtime（注销旧集，幂等）。非法输入显式报错，不静默回落。
      const parsed = normalizeVirtualModelConfig(payload)
      if (!parsed.ok) throw new Error(`虚拟模型配置非法: ${parsed.error}`)
      const catalog = await configuredModels()
      const resolved = resolveVirtualChain(parsed.config.chain, catalog)
      if (!resolved.ok) {
        const detail = (resolved.issues ?? []).map((issue) => `#${issue.index + 1} ${issue.provider}/${issue.modelId}: ${issue.error}`).join('；')
        throw new Error(detail || resolved.error)
      }
      virtualModelsConfig = parsed.config
      await atomicWriteJson(virtualModelsFile, virtualModelsConfig)
      await applyVirtualModels(await ensureRuntime(), virtualModelsConfig)
      const fresh = resolveVirtualChain(virtualModelsConfig.chain, await configuredModels())
      reply(id, {
        config: virtualModelsConfig,
        issues: fresh.ok ? fresh.issues : (fresh.issues ?? []),
      })
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
    if (type === 'generate_images') {
      // T2⑧ 复合内容别名层：接受 pi-ai ImagesInputContent（TextContent|ImageContent 数组）。
      // 仅当整个输入都可用文本表达（string 或纯 TextContent）时转发旧实现；否则按
      // 「兼容层不做图像输入」如实报错，不静默丢内容（图像条件生成需走 SDK 原生路径）。
      const rawInput = Array.isArray(payload?.input) ? payload.input : [{ type: 'text', text: String(payload?.prompt ?? '') }]
      const textParts = rawInput.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text)
      if (textParts.length !== rawInput.length) {
        throw new Error('generate_images 暂不支持图像输入内容（兼容层仅转发文本），请直接使用 SDK generateImages 原生路径')
      }
      reply(id, await generateImage({ ...payload, prompt: textParts.join('\n') }))
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
    if (type === 'get_cache_warming') {
      // T1-① prompt cache warming（SDK 0.99.x CacheWarmer 自动接入，这里暴露会话级开关与状态）
      const entry = sessions.get(payload.sessionId)
      if (!entry?.session) throw new Error(`会话不存在: ${payload.sessionId}`)
      const status = entry.session.cacheWarmingStatus
      // P2-5：把当前模式一起回给前端（settingsManager.getCacheWarmingMode()），UI 按钮加 active 态
      let mode = ''
      try { mode = typeof entry.session.settingsManager?.getCacheWarmingMode === 'function' ? String(entry.session.settingsManager.getCacheWarmingMode()) : '' } catch { mode = '' }
      reply(id, {
        mode,
        status: status?.state ?? 'inactive',
        reason: typeof status?.reason === 'string' ? status.reason : '',
        nextWarmAt: Number.isFinite(status?.nextWarmAt) ? status.nextWarmAt : null,
        warmCost: Number.isFinite(status?.decision?.warmCost) ? status.decision.warmCost : null,
        missCost: Number.isFinite(status?.decision?.missCost) ? status.decision.missCost : null,
        action: status?.decision?.action ?? '',
        expectedSavings: Number.isFinite(status?.decision?.expectedSavings) ? status.decision.expectedSavings : null,
      })
      return
    }
    if (type === 'set_cache_warming') {
      // mode ∈ off|streaming|idle（CACHE_WARMING_MODES）。审查 P2-1：非法值必须报错而非
      // 静默回落——回落会把用户此前的 off 覆盖成 streaming 还回显"成功"，掩盖调用方 bug。
      const entry = sessions.get(payload.sessionId)
      if (!entry?.session) throw new Error(`会话不存在: ${payload.sessionId}`)
      const MODES = ['off', 'streaming', 'idle']
      if (!MODES.includes(payload.mode)) throw new Error('mode 必须是 off|streaming|idle')
      const mode = payload.mode
      entry.session.setCacheWarmingMode(mode)
      reply(id, { mode })
      return
    }
    if (type === 'get_compaction_budget') {
      // T1-② per-model compaction budgets：读全局 settings 的 compaction.modelOverrides
      const entry = sessions.get(payload.sessionId)
      if (!entry?.session) throw new Error(`会话不存在: ${payload.sessionId}`)
      const overrides = entry.session.settingsManager?.globalSettings?.compaction?.modelOverrides
      reply(id, { overrides: overrides && typeof overrides === 'object' ? overrides : {} })
      return
    }
    if (type === 'set_compaction_budget') {
      // modelKey 形如 "provider/modelId"；reserveTokens/keepRecentTokens 正整数，非法键删除该条覆盖
      const entry = sessions.get(payload.sessionId)
      if (!entry?.session) throw new Error(`会话不存在: ${payload.sessionId}`)
      const modelKey = typeof payload.modelKey === 'string' ? payload.modelKey.trim() : ''
      if (!modelKey || modelKey.length > 200) throw new Error('modelKey 必须是 1-200 字符的 "provider/modelId"')
      const manager = entry.session.settingsManager
      if (!manager?.globalSettings) throw new Error('settingsManager 不可用')
      if (!manager.globalSettings.compaction || typeof manager.globalSettings.compaction !== 'object') {
        manager.globalSettings.compaction = {}
      }
      const compaction = manager.globalSettings.compaction
      if (!compaction.modelOverrides || typeof compaction.modelOverrides !== 'object') compaction.modelOverrides = {}
      // 审查 P2-3：上界钳制（SDK 压缩预算语义，1e21 之类会架空预算）；P2-2：字段在
      // payload 中显式出现但不是有限正数时必须报错，而不是静默略去导致"以为在写实际在删"。
      const TOKEN_MAX = 2_000_000
      const parseToken = (field) => {
        if (!(field in payload)) return { present: false, value: undefined }
        const raw = payload[field]
        if (!Number.isFinite(raw) || raw <= 0) return { present: true, error: `${field} 必须是正数` }
        return { present: true, value: Math.min(Math.floor(raw), TOKEN_MAX) }
      }
      const reserve = parseToken('reserveTokens')
      const keep = parseToken('keepRecentTokens')
      if (reserve.error) throw new Error(reserve.error)
      if (keep.error) throw new Error(keep.error)
      const override = {
        ...(reserve.value !== undefined ? { reserveTokens: reserve.value } : {}),
        ...(keep.value !== undefined ? { keepRecentTokens: keep.value } : {}),
      }
      if (override.reserveTokens === undefined && override.keepRecentTokens === undefined) {
        delete compaction.modelOverrides[modelKey]
      } else {
        compaction.modelOverrides[modelKey] = override
      }
      // P2-4：markModified/save 在 SDK 0.99.2 的 d.ts 里是 private（运行时存在但无契约保证）。
      // 加能力检测：SDK 未来升级若移除，这里显式报错而非静默丢改动。
      if (typeof manager.markModified !== 'function' || typeof manager.save !== 'function') {
        throw new Error('settingsManager 缺少 markModified/save（SDK 版本不兼容，压缩预算无法持久化）')
      }
      manager.markModified('compaction', 'modelOverrides')
      manager.save()
      reply(id, { modelKey, override: compaction.modelOverrides[modelKey] ?? null })
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
      // T2⑥ MCP 原生化：SDK loadMcpConfig 走 validateMcpServerConfig 校验 +
      // 命名空间冲突检测，错误串（配置非法/JSON 损坏）透传给 UI 展示。
      // projectTrusted 复用 2-14 项目信任：不可信项目的 .pi/mcp.json 不读
      // （SDK 加载器同语义 —— 项目文件在受信后才被读取）。
      if (mcpConfigApi && typeof mcpConfigApi.loadMcpConfig === 'function') {
        let trusted = true
        try { trusted = await resolveProjectTrust({}) } catch { trusted = false }
        const loaded = mcpConfigApi.loadMcpConfig({ agentDir, cwd: workspace, projectTrusted: trusted })
        reply(id, {
          globalPath: globalMcpFile,
          projectPath: path.join(workspace, '.pi', 'mcp.json'),
          projectTrusted: trusted,
          errors: Array.isArray(loaded?.errors) ? loaded.errors.map(String) : [],
          servers: (Array.isArray(loaded?.servers) ? loaded.servers : []).map((s) => ({
            name: String(s?.name ?? ''),
            scope: s?.scope === 'global' || s?.scope === 'project' ? s.scope : 'global',
            source: String(s?.source ?? ''),
            enabled: s?.config?.enabled !== false,
            exposure: String(s?.config?.exposure || 'codemode'),
            transport: s?.config?.command ? 'stdio' : s?.config?.url ? 'http' : 'unknown',
            command: String(s?.config?.command || s?.config?.url || ''),
            args: Array.isArray(s?.config?.args) ? s.config.args : [],
          })),
        })
        return
      }
      // 旧版 SDK 降级：手写读取（原 2-10 行为，语义锁定）
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
            enabled: server?.disabled !== true && server?.enabled !== false,
            exposure: String(server?.exposure || 'codemode'),
            source: file,
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
      // T2⑥：保存指定 scope 的 mcpServers（整表覆盖，UI 负责合并语义）。
      // SDK 可用时走 addMcpServerConfig 逐条写入 —— 它会做 validateMcpServerConfig
      // 之外的形状保留（保留文件内其它内容与缩进），非法条目由 UI 先行过滤。
      // 写入侧白名单（对抗审查 B）：mcp_save 是 UI 之外的最后一个写入口，非法 exposure
      // 在这里拒绝，防止绕过 UI 校验的值经 mcp_list 原样透传。
      const scope = payload.scope === 'project' ? 'project' : 'global'
      const file = scope === 'global' ? globalMcpFile : path.join(workspace, '.pi', 'mcp.json')
      const servers = payload.mcpServers
      if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('mcpServers 必须是对象')
      for (const server of Object.values(servers)) {
        const exposure = server?.exposure
        if (exposure !== undefined && !['codemode', 'deferred', 'direct', 'hidden'].includes(exposure)) {
          throw new Error(`非法暴露级别：${exposure}（允许 codemode/deferred/direct/hidden）`)
        }
      }
      // 写入互斥（对抗审查 A）：与 mcp_patch 共用每文件写锁，串行化读-改-写，防丢失更新
      await withMcpWriteLock(file, async () => {
        const existing = (() => {
          try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return {} }
        })()
        existing.mcpServers = servers
        await mkdir(path.dirname(file), { recursive: true })
        await atomicWriteJson(file, existing)
      })
      reply(id, { saved: true, scope, path: file, count: Object.keys(servers).length })
      return
    }
    if (type === 'mcp_patch') {
      // T2⑥：单个服务器的 enabled/exposure 编辑 —— SDK updateMcpServerConfig 保留
      // 文件其余内容与缩进；enabled:true / exposure:'codemode'（默认值）会删除键，
      // 保持配置文件最小化（与 /mcp 管理器同语义）。
      if (!mcpConfigApi || typeof mcpConfigApi.updateMcpServerConfig !== 'function') {
        throw new Error('当前 SDK 版本不支持 MCP 配置编辑（缺 updateMcpServerConfig）')
      }
      const scope = payload.scope === 'project' ? 'project' : 'global'
      const name = String(payload.name || '').trim()
      if (!name) throw new Error('缺少服务器名称')
      const file = scope === 'global' ? globalMcpFile : path.join(workspace, '.pi', 'mcp.json')
      const patch = {}
      if (payload.enabled !== undefined) patch.enabled = payload.enabled === true
      if (payload.exposure !== undefined) {
        const exposure = String(payload.exposure)
        if (!['codemode', 'deferred', 'direct', 'hidden'].includes(exposure)) {
          throw new Error(`非法暴露级别：${exposure}（允许 codemode/deferred/direct/hidden）`)
        }
        patch.exposure = exposure
      }
      if (Object.keys(patch).length === 0) throw new Error('补丁为空：需要 enabled 或 exposure')
      // 写入互斥（对抗审查 A）：与 mcp_save 共用每文件写锁 —— updateMcpServerConfig
      // 内部也是读-改-写，两个并发 patch（或 patch 撞上 save 整表覆盖）会互相吞掉改动。
      await withMcpWriteLock(file, () => mcpConfigApi.updateMcpServerConfig(file, name, patch))
      reply(id, { patched: true, scope, name, file, patch })
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
    if (type === 'list_context') {
      // T2⑦ 上下文编辑（SDK ContextEditEntry 原生化）第一半：列出模型可见条目。
      // 口径与 sessionHistory 一致走 buildContextEntries()（compaction 感知、沿当前叶路径）。
      const entry = sessions.get(payload.sessionId)
      if (!entry?.session) throw new Error(`会话不存在: ${payload.sessionId}`)
      const items = []
      for (const item of entry.session.sessionManager.buildContextEntries()) {
        if (item.type === 'message') {
          const message = item.message
          if (!message || (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'toolResult')) continue
          items.push({ entryId: item.id, kind: 'message', role: message.role, text: contentText(message.content) })
        } else if (item.type === 'custom_message') {
          items.push({
            entryId: item.id,
            kind: 'custom_message',
            role: 'plugin',
            text: typeof item.content === 'string' ? item.content : '',
            customType: typeof item.customType === 'string' ? item.customType : '',
          })
        }
      }
      const edits = collectContextEdits(entry.session.sessionManager)
      reply(id, { items, edits })
      return
    }
    if (type === 'apply_context_edit') {
      // T2⑦ 第二半：追加分支局部编辑条目。replacement 为 null = 从模型上下文剔除目标；
      // { content } = 仅替换内容（形状与 SDK ContextEditEntry["replacement"] 严格一致，不加工）。
      const entry = sessions.get(payload.sessionId)
      if (!entry?.session) throw new Error(`会话不存在: ${payload.sessionId}`)
      if (entry.running) throw new Error('会话正在运行，无法编辑上下文')
      const targetId = String(payload.targetId || '')
      if (!targetId || !entry.session.sessionManager.getEntry(targetId)) throw new Error(`目标条目不存在: ${targetId || '(空)'}`)
      const replacement = payload.replacement === null ? null : { content: payload.replacement?.content }
      if (replacement !== null && typeof replacement.content !== 'string' && !Array.isArray(replacement.content)) {
        throw new Error('replacement.content 必须是字符串或 TextContent/ImageContent 数组')
      }
      const editId = entry.session.sessionManager.appendContextEdit(targetId, replacement)
      // 注：不回传 tokens —— SDK SessionProjection（session-manager.d.ts）没有 tokens 字段，
      // 曾写的 `projection?.tokens ?? 0` 恒为 0（假功能），宁可不给也不谎报。
      reply(id, { editId, targetId, replacement })
      return
    }
    if (type === 'set_model') {
      const entry = sessions.get(payload.sessionId)
      if (!entry) throw new Error(`会话不存在: ${payload.sessionId}`)
      // T3-2：虚拟模型是路由壳（模型目录里存在但不出现在 configuredModels），
      // 显式拒绝直接选中——故障转移链由设置开关控制，而不是会话级 set_model。
      if (typeof payload.modelId === 'string' && payload.modelId.startsWith(VIRTUAL_PREFIX)) {
        throw new Error('虚拟模型是故障转移路由壳，不能直接选中；请在设置中启用/编辑故障转移链')
      }
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
      const entry = sessions.get(payload.sessionId)
      // 缺陷 4（外部审计 P1）：这里原先会**静默重建会话**（`if (!entry) await createSession(...)`）。
      // 前端 closeTab/deleteSession 会先发 close_session/delete_session，若此时前端有个
      // 异步前奏（create_session / read_attachment / vision_describe）还在飞行，它随后发出的
      // prompt 就会命中这里，把一个已关闭的会话重新造出来并真跑模型 —— 而前端此时早已
      // 删掉标签与运行槽，用户看不到、也停不掉这个运行（无人可管的僵尸运行）。
      // 正确语义：prompt 不负责创建会话，找不到就明确报错，让前端的 .catch 给出反馈。
      // 会话的创建只走显式的 create_session（新建会话）与 open_session（打开已有）。
      if (!entry) throw new Error('会话不存在或已关闭，请重新打开该会话后再发送。')
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
        .catch((error) => send({ type: 'event', sessionId: payload.sessionId, event: { type: 'error', message: error.message, turnId: payload.turnId } }))
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
      // 1-6：同步清理会话级索引（数组形式，见 pendingConfirmsBySession 的声明）
      forgetConfirm(pendingConfirmsBySession, payload.confirmId)
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
      // 让用户/维护者看到"哪些扩展 UI 能力在桌面端未实现" +
      // 当前会话实际加载了哪些扩展（1-5 批次②）。
      // 注意：extensionRunner 在 reload() 后是**新对象**，必须每次从 entry 现取。
      const entry = sessions.get(payload.sessionId)
      let extensions
      try {
        const runner = entry?.session?.extensionRunner
        extensions = Array.isArray(runner?.extensions)
          ? runner.extensions.map((ext) => ({
              path: typeof ext?.path === 'string' ? ext.path : '',
              source: ext?.sourceInfo?.source ?? '',
            }))
          : []
      } catch {
        extensions = []
      }
      reply(id, {
        unsupported: [...unsupportedUiCalls.entries()].map(([message, count]) => ({ message, count })),
        extensions,
      })
      return
    }
    if (type === 'reload_extensions') {
      // 1-5 批次②：运行时重载扩展（免发版加新 UI 形态）。
      // session.reload() 在 SDK 内部走 _buildRuntime：重建 extensionRunner 并
      // 自动重新应用 uiContext/onError 绑定（_applyExtensionBindings），所以
      // **这里绝不能再调 bindUiContext** —— 那会二次发射 session_start。
      // 重建后 runner 标识变化，因此诊断信息每次都从 entry 现取、绝不缓存。
      const entry = sessions.get(payload.sessionId)
      if (!entry?.session) {
        reply(id, { error: `会话 ${payload.sessionId ?? ''} 不存在或未就绪` })
        return
      }
      try {
        await entry.session.reload()
        reply(id, { reloaded: true })
      } catch (error) {
        reply(id, { reloaded: false, error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    if (type === 'list_ui_renderers') {
      // 1-5 批次③：扫描已加载扩展目录的 pi-ui.json 声明，交给前端注册表登记。
      // 信任语义：项目信任（resolveProjectTrust）决定这些渲染器能否渲染非
      // timeline 槽 —— 前端拿到 trusted 字段后做显式拒绝（绝不静默丢弃）。
      const entry = sessions.get(payload.sessionId)
      let extensionPaths = []
      try {
        const runner = entry?.session?.extensionRunner
        extensionPaths = Array.isArray(runner?.extensions)
          ? runner.extensions.map((ext) => (typeof ext?.path === 'string' ? ext.path : '')).filter(Boolean)
          : []
      } catch {
        extensionPaths = []
      }
      const renderers = await collectUiRendererManifests(extensionPaths)
      let trusted = true
      try {
        // 信任分类：项目扩展（非 agentDir 下）触发信任检查，全局扩展不问。
        // SDK 返回的扩展路径是原生反斜杠；agentDir 归一化成同款再比较 ——
        // 分隔符不一致会让全局扩展永远匹配不上前缀而被误判为项目扩展（审查 BUG-2）。
        const agentPrefix = agentDir.replaceAll('\\', '/').toLowerCase()
        const norm = (p) => p.replaceAll('\\', '/').toLowerCase()
        const projectExts = extensionPaths.filter((p) => !norm(p).startsWith(agentPrefix))
        trusted = resolveProjectTrust({ extensionsResult: { extensions: projectExts.map((p) => ({ path: p })) } })
      } catch {
        trusted = false
      }
      reply(id, { renderers, trusted })
      return
    }
    if (type === 'read_ui_renderer_asset') {
      // 1-5 批次③：把扩展目录内的静态资源（如 sandbox 页 HTML）读给前端。
      // 路径安全：解析后必须落在声明来源目录内（防 ../ 逃逸读取任意文件），
      // 且只允许文本资产（html/css/js/json/svg/txt/md）。
      const dir = typeof payload.source === 'string' ? payload.source : ''
      const rel = typeof payload.path === 'string' ? payload.path : ''
      const allowedExt = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.svg', '.txt', '.md'])
      if (!dir || !rel) {
        reply(id, { error: '缺少 source 或 path' })
        return
      }
      const baseDir = path.resolve(dir)
      const full = path.resolve(baseDir, rel)
      if (full !== baseDir && !full.startsWith(baseDir + path.sep)) {
        reply(id, { error: '资源路径越界（必须位于扩展目录内）' })
        return
      }
      if (!allowedExt.has(path.extname(full).toLowerCase())) {
        reply(id, { error: '不允许的资源类型（仅文本资产）' })
        return
      }
      try {
        const content = await readFile(full, 'utf8')
        reply(id, { content, path: rel })
      } catch (error) {
        reply(id, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    if (type === 'read_attachment') {
      reply(id, await readAttachment(payload.cwd || workspace, payload.path))
      return
    }
    if (type === 'abort') {
      const entry = sessions.get(payload.sessionId)
      // 顺序承重逻辑（放行必须在 abort() 之前，且必须收窄到本会话）抽在
      // ./session-teardown.mjs —— 那里有 SDK 源码级论证与行为化单测（审查 D1/T1）。
      // 早期实现用 releaseAllConfirms 会连别的会话正在等待的确认一起取消（缺陷 #5）。
      await cancelSessionInteractions({
        sessionId: payload.sessionId,
        reason: '用户中止',
        releaseConfirms: releaseSessionConfirms,
        drainDialogs: drainPendingDialogs,
        abort: () => entry?.session.abort(),
      })
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
            confirm: lastConfirmOfSession(pendingConfirmsBySession, sid),
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
            // 与 handle 的 abort 分支同构（放行先于 abort，见 ./session-teardown.mjs）。
            await cancelSessionInteractions({
              sessionId,
              reason: '局域网中止',
              releaseConfirms: releaseSessionConfirms,
              drainDialogs: drainPendingDialogs,
              abort: () => entry.session.abort(),
            })
            return { ok: true }
          },
          confirm: async ({ dialogId, confirmed }) => {
            // 权限确认（confirm_request）与扩展对话框（ui_dialog_request）都可远程回答
            const confirmResolve = pendingConfirms.get(String(dialogId || ''))
            if (confirmResolve) {
              pendingConfirms.delete(String(dialogId))
              forgetConfirm(pendingConfirmsBySession, String(dialogId))
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
    if (type === 'auth_status') {
      const runtime = await ensureRuntime()
      const providers = runtime.getProviders().map((provider) => {
        const oauth = provider.auth?.oauth || null
        let status = { configured: false }
        try {
          status = runtime.getProviderAuthStatus(provider.id) || { configured: false }
        } catch (error) {
          log(error)
        }
        return {
          id: provider.id,
          configured: Boolean(status.configured),
          source: status.source || '',
          label: status.label || '',
          subscription: Boolean(runtime.isUsingSubscription?.(provider.id)),
          oauthName: oauth?.name || '',
          loginLabel: oauth?.loginLabel || ''
        }
      })
      reply(id, { providers })
      return
    }
    if (type === 'auth_logout') {
      const provider = String(payload.provider || '').trim()
      if (!provider) throw new Error('缺少 provider')
      try {
        await (await ensureRuntime()).logout(provider)
        reply(id, { ok: true, provider, message: `已登出 ${provider}` })
        await ensureRuntime(true)
      } catch (error) {
        reply(id, { ok: false, provider, message: error.message || '登出失败' })
      }
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
// confirm_response 必须非阻塞（审查 D1）：权限确认的等待者是 sidecar 里正在跑的
// 一次工具调用；如果它排在串行链上，而链上恰好有一个卡在确认上的请求（abort 永远
// 等不到 waitForIdle），用户的回答就会排在卡死的请求后面 —— 实测完全死锁。
// 它只做几次同步的 Map 操作 + 调用一个已保存的 resolve，不进 handle 的 await 路径。
const NON_BLOCKING_REQUESTS = new Set(['oauth_login', 'ui_dialog_response', 'mcp_test', 'confirm_response'])
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
  // 进程级 teardown：把所有会话挂着的确认/对话框一并放行，避免扩展侧留下永不
  // resolve 的 await（审查要求核对所有清理路径：process exit / sessions 清空 / SDK reload）。
  for (const sid of [...sessions.keys()]) releaseSessionConfirms(sid)
  releaseAllConfirms(pendingConfirms, pendingConfirmsBySession)
  drainPendingDialogs('sidecar 退出')
  log('stdin 已关闭，sidecar 退出')
  process.exit(0)
})
