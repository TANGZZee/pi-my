// T3 接线承重测试 —— codemode/tool_search 激活链 + 虚拟模型 runtime 接线
//
// 两层防线：
// 1. 行为层：extensions-wiring.mjs 是可实例化的小模块，直接真调（能力探测/降级/逐会话新工厂）；
// 2. 形状层：index.mjs / rpc-policy.ts / Settings.svelte 的关键接线用「剥注释 + 屏蔽字面量 +
//    代码区命中」断言 —— 对抗性审查的教训：子串匹配会被注释/字符串诱饵骗过。
//
// 锁定的历史事故（变异审查结论，详见 T3-1 注释）：
// - createAgentSession 的 `tools: BASE_TOOLS` 会永久裁剪注册表（mcp__*/codemode/tool_search
//   根本不可见）→ 全文代码区必须零命中；
// - 初始激活若发生在 entry 挂上 session 之前，allToolNames 返回 [] → 回落 BASE_TOOLS
//   → 四个会话创建函数（createSession/openSession/forkSession/createWorktreeFork）逐个锁时序。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments, squash, maskStrings, shapeWithLiteralMask, indexOfCode, functionBodyOf } from './helpers/source-assert.mjs'
import { detectCodemodeExtensions, codemodeExtensionFactories } from '../sidecar/extensions-wiring.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const readRepo = (rel) => readFileSync(path.join(root, rel), 'utf8')

const sidecarRaw = readRepo('sidecar/index.mjs')
const wiringRaw = readRepo('sidecar/extensions-wiring.mjs')
const policyRaw = readRepo('src/rpc-policy.ts')
const settingsRaw = readRepo('src/Settings.svelte')

// 代码区视图（命中起点必须在真实代码里，字符串诱饵不算）
const sideView = shapeWithLiteralMask(stripComments(sidecarRaw))
const policyView = shapeWithLiteralMask(stripComments(policyRaw))
const settingsView = shapeWithLiteralMask(stripComments(settingsRaw))
// 无注释函数体（去空白、保留字面量）——时序/接线断言用
const sidecarStripped = stripComments(sidecarRaw)
const bodyOf = (name) => functionBodyOf(sidecarStripped, name)

/** 代码区包含断言（indexOfCode：命中起点必须来自真实代码）。 */
function codeIncludes(view, needle, label) {
  assert.ok(indexOfCode(view.shape, view.literal, needle) >= 0, label ?? `代码区必须包含: ${needle}`)
}
/** 函数体内按顺序包含（锚点必须依次出现，防止接线搬出函数体外）。 */
function orderedIncludes(haystack, needles, label) {
  let from = 0
  for (const needle of needles) {
    const at = haystack.indexOf(needle, from)
    assert.ok(at >= 0, `${label}: 期望按顺序出现 ${needle}（在 ${from} 之后）`)
    from = at + needle.length
  }
}

// ── T3-1 行为层：扩展工厂 ────────────────────────────────────────────────

test('detectCodemodeExtensions：缺失导出→null，存在→透传工厂引用（旧版 SDK 降级依据）', () => {
  const missing = detectCodemodeExtensions({})
  assert.deepEqual(missing, { codemode: null, toolSearch: null })
  const codemode = () => 'cm'
  const toolSearch = () => 'ts'
  const full = detectCodemodeExtensions({ createCodemodeExtension: codemode, createToolSearchExtension: toolSearch })
  assert.equal(full.codemode, codemode)
  assert.equal(full.toolSearch, toolSearch)
  // 缺一个只降级那一个
  const half = detectCodemodeExtensions({ createCodemodeExtension: codemode })
  assert.equal(half.codemode, codemode)
  assert.equal(half.toolSearch, null)
  assert.deepEqual(detectCodemodeExtensions(undefined), { codemode: null, toolSearch: null })
})

test('codemodeExtensionFactories：包装为逐会话新工厂，调用透传到 SDK 工厂', () => {
  let codemodeCalls = 0
  let toolSearchCalls = 0
  const moduleRef = { createCodemodeExtension: () => ++codemodeCalls, createToolSearchExtension: () => ++toolSearchCalls }
  const factories = codemodeExtensionFactories({ module: moduleRef })
  assert.equal(factories.length, 2)
  // M4 缺口修补：必须是包装后的新闭包，不得裸推 SDK 工厂引用（裸引用会把调用点上下文漏进 SDK 工厂）
  assert.notEqual(factories[0], moduleRef.createCodemodeExtension, 'codemode 必须包装新闭包而非透传引用')
  assert.notEqual(factories[1], moduleRef.createToolSearchExtension, 'toolSearch 必须包装新闭包而非透传引用')
  const first = factories.map((make) => make())
  assert.deepEqual(first, [1, 1])
  // 每次会话创建现调一次（extensionRunner reload 后是新对象，工厂必须无状态）
  const again = factories.map((make) => make())
  assert.deepEqual(again, [2, 2])
})

test('codemodeExtensionFactories：旧版 SDK / 空模块 → 空数组（sessionExtensions spread 安全降级）', () => {
  assert.deepEqual(codemodeExtensionFactories({ module: {} }), [])
  assert.deepEqual(codemodeExtensionFactories({ module: undefined }), [])
  assert.deepEqual(codemodeExtensionFactories(), [])
})

// ── T3-1 形状层：注册表不裁剪 + 激活时序（4 个创建函数逐一锁） ────────────

test('T3-1：index.mjs 代码区零命中 tools: BASE_TOOLS（注册表裁剪是 mcp/codemode 不可见的根因）', () => {
  // 剥注释后屏蔽字面量再数：注释里提及（如本文件/注释文档）不算，代码里复活才算
  for (const [name, raw] of [['sidecar/index.mjs', sidecarRaw], ['sidecar/extensions-wiring.mjs', wiringRaw]]) {
    const shape = squash(maskStrings(stripComments(raw)))
    assert.ok(!shape.includes('tools:BASE_TOOLS'), `${name} 代码区不得再传 tools: BASE_TOOLS（allowedToolNames 永久裁剪注册表）`)
  }
})

test('T3-1：sessionExtensions 在 MCP 逐字段之后追加 codemode/tool_search 工厂', () => {
  orderedIncludes(bodyOf('sessionExtensions'), [
    '...(mcpExtension?[mcpExtension()]:[])',
    '...codemodeExtensionFactories({module:loadedSdk.module})',
  ], 'sessionExtensions 工厂顺序')
})

test('T3-1 时序：createSession —— entry 挂载（assign+sessions.set）先于初始激活，激活基准 allToolNames', () => {
  orderedIncludes(bodyOf('createSession'), [
    'Object.assign(entry,{session',
    'sessions.set(id,entry)',
    '.setActiveToolsByName(toolsForModeSwitch(',
  ], 'createSession 激活时序')
  assert.ok(bodyOf('createSession').includes('allToolNames(entry)'), '激活基准必须是 allToolNames(entry)（全量注册表）')
})

test('T3-1 时序：openSession —— 同 createSession（重开路径也要点亮新工具）', () => {
  orderedIncludes(bodyOf('openSession'), [
    'Object.assign(entry,{session',
    'sessions.set(id,entry)',
    '.setActiveToolsByName(toolsForModeSwitch(',
  ], 'openSession 激活时序')
  assert.ok(bodyOf('openSession').includes('allToolNames(entry)'), 'openSession 激活基准必须是 allToolNames(entry)')
})

test('T3-1 时序：forkSession —— fork 出的分支同样全量点亮', () => {
  orderedIncludes(bodyOf('forkSession'), [
    'Object.assign(entry,{session',
    'sessions.set(id,entry)',
    '.setActiveToolsByName(toolsForModeSwitch(',
  ], 'forkSession 激活时序')
  assert.ok(bodyOf('forkSession').includes('allToolNames(entry)'), 'forkSession 激活基准必须是 allToolNames(entry)')
})

test('T3-1 时序：createWorktreeFork —— worktree fork 用 sessions.get(forkId) 作基准', () => {
  orderedIncludes(bodyOf('createWorktreeFork'), [
    'sessions.set(forkId,{',
    '.setActiveToolsByName(toolsForModeSwitch(',
  ], 'createWorktreeFork 激活时序')
  assert.ok(
    bodyOf('createWorktreeFork').includes('allToolNames(sessions.get(forkId))'),
    'worktree fork 的基准必须是 allToolNames(sessions.get(forkId))（fork entry 已入表）'
  )
})

// ── T3-2 形状层：模块接线 + RPC + 目录过滤 + 守卫 ─────────────────────────

test('T3-2：index.mjs 导入 virtual-models 纯函数（路由决策不在接线层内联）', () => {
  codeIncludes(sideView, "import{VIRTUAL_PREFIX,normalizeVirtualModelConfig,resolveVirtualChain,routeChain}from'./virtual-models.mjs'")
})

test('T3-2：applyVirtualModels —— 先注销旧集再注册，id 加 VIRTUAL_PREFIX，route 回调走 routeChain', () => {
  const body = bodyOf('applyVirtualModels')
  orderedIncludes(body, [
    'rt.unregisterVirtualModel(',
    'rt.getPhysicalModel?.(',
    // I1 缺口修补：前缀模板必须出现在 registerVirtualModel 的参数块内（单点 includes 会被
    // registered.push 簿记行的同款模板串满足）；同时锁 registered.push 在注册之后（簿记位置）
    'rt.registerVirtualModel({provider:entry.provider,id:`${VIRTUAL_PREFIX}${entry.modelId}`',
    'routeChain(virtualModelsConfig,request)',
    'registered.push(',
  ], 'applyVirtualModels 接线顺序')
  assert.ok(body.indexOf('registered.push(') > body.indexOf('rt.registerVirtualModel('), '簿记必须在注册之后（注销依赖 __piMyVirtualIds 簿记一致）')
  assert.ok(body.includes('${VIRTUAL_PREFIX}${entry.modelId}'), '虚拟 id 必须加 VIRTUAL_PREFIX 前缀（撞物理 id 会抛错）')
})

test('T3-2：ensureRuntime 创建 runtime 后立即挂虚拟模型（注册即活更新目录）', () => {
  assert.ok(bodyOf('ensureRuntime').includes('applyVirtualModels(runtime,virtualModelsConfig)'))
})

test('T3-2：configuredModels 过滤虚拟 id（路由壳不进配置目录/UI 模型下拉）', () => {
  assert.ok(bodyOf('configuredModels').includes('startsWith(VIRTUAL_PREFIX)'))
})

test('T3-2 RPC：get_virtual_models 分支（supported 探测 + 配置 + 逐项 issues）', () => {
  const body = bodyOf('handle')
  orderedIncludes(body, [
    "type==='get_virtual_models'",
    'resolveVirtualChain(virtualModelsConfig.chain,catalog)',
    'supported:typeof(awaitensureRuntime()).registerVirtualModel',
  ], 'get_virtual_models 分支')
})

test('T3-2 RPC：set_virtual_models 分支（校验→目录解析→持久化→注册，非法输入显式报错）', () => {
  const body = bodyOf('handle')
  orderedIncludes(body, [
    "type==='set_virtual_models'",
    'normalizeVirtualModelConfig(payload)',
    // I7 缺口修补：锁死「校验→拒绝→赋值→落盘→注册」顺序——只断言校验被调用时，
    // 拒绝块可被 neuter（!resolved.ok throw 删掉）而非法链直接落盘
    'resolveVirtualChain(parsed.config.chain,catalog)',
    'if(!resolved.ok){',
    'thrownewError(detail||resolved.error)',
    'virtualModelsConfig=parsed.config',
    'atomicWriteJson(virtualModelsFile',
    'applyVirtualModels(awaitensureRuntime()',
  ], 'set_virtual_models 分支')
})

test('T3-2 守卫：虚拟模型 id 不能被 set_model 直接选中', () => {
  const body = bodyOf('handle')
  assert.ok(body.includes('payload.modelId.startsWith(VIRTUAL_PREFIX)'), 'set_model 必须拦截 VIRTUAL_PREFIX 前缀')
  assert.ok(body.includes('虚拟模型是故障转移路由壳'), '拦截报错必须说明原因（虚拟模型是路由壳）')
})

test('T3-2 前端策略：get/set_virtual_models 必须登记超时（漏登记会挂 rpc-policy 覆盖测试）', () => {
  codeIncludes(policyView, 'get_virtual_models:10_000')
  codeIncludes(policyView, 'set_virtual_models:10_000')
})

// ── T3-2 UI：Settings 故障转移页接线 ─────────────────────────────────────

test('Settings 故障转移页：读/写 RPC 与打开页签时加载', () => {
  // 脚本区锚点走代码区命中；模板锚点（含 Svelte 语法）走无注释视图包含
  codeIncludes(settingsView, "rpc('get_virtual_models'", 'Settings 必须调用 get_virtual_models')
  codeIncludes(settingsView, "rpc('set_virtual_models'", 'Settings 必须调用 set_virtual_models')
  const flat = squash(stripComments(settingsRaw))
  assert.ok(flat.includes("$:if(open&&tab==='failover')voidloadFailover()"), '打开 failover 页签时必须触发 loadFailover')
  assert.ok(flat.includes("['failover','故障转移']"), 'NAV 能力组必须有故障转移入口')
  assert.ok(flat.includes("{:elseiftab==='failover'}"), '必须有 failover 页签模板分支')
})

test('Settings 故障转移页：链编辑函数存在且语义锚点齐全', () => {
  const load = functionBodyOf(stripComments(settingsRaw), 'loadFailover')
  assert.ok(load.includes('get_virtual_models'), 'loadFailover 必须走 get_virtual_models')
  const save = functionBodyOf(stripComments(settingsRaw), 'saveFailover')
  assert.ok(save.includes('set_virtual_models'), 'saveFailover 必须走 set_virtual_models')
  assert.ok(save.includes('链不能为空'), '空链必须在保存前拒绝（启用开关才是停用通道）')
  const add = functionBodyOf(stripComments(settingsRaw), 'addFailoverLink')
  // S2b 缺口修补：仅 includes 字面量抓不住「守卫死代码化」（字面量保留、if(false) 化）——
  // 锁 some 条件紧邻 notice 赋值（守卫活性：条件成立必须短路到 notice）
  assert.ok(
    add.includes("failoverChain.some((item)=>item.provider===provider&&item.modelId===modelId)){failoverNotice='该模型已在链中。'return}"),
    '重复拒绝守卫必须活性：some 条件成立立即赋 notice 并 return（不得死代码化）'
  )
  const move = functionBodyOf(stripComments(settingsRaw), 'moveFailoverLink')
  assert.ok(move.includes('failoverChain.length'), '移动必须做边界校验')
  const remove = functionBodyOf(stripComments(settingsRaw), 'removeFailoverLink')
  assert.ok(remove.includes('filter'), '删除必须产出新数组（Svelte 5 响应式依赖重赋值）')
})
