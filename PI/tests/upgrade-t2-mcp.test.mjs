/**
 * T2⑥ MCP 原生化 承重测试：
 * - sidecar：createMcpExtension 注册进 sessionExtensions；mcp_list 走 SDK loadMcpConfig
 *   （projectTrusted 透传 + errors 透传 + oauth 透出），保留旧版降级分支（语义锁定）；
 *   mcp_patch 白名单（enabled boolean / exposure ∈ codemode|deferred|direct|hidden）、
 *   空补丁与缺 SDK 能力都 throw；mcp_oauth_patch 整组替换 oauth（T2⑧ MCP OAuth 跟进：
 *   SDK McpServerConfigPatch 只收 enabled/exposure，oauth 必须旁路直接编辑配置文件，
 *   与 mcp_save/mcp_patch 共用写锁，字段白名单 + 端口/凭据配对校验 + 全 null = 清除）。
 * - rpc-policy：mcp_patch / mcp_oauth_patch 超时登记（同档）。
 * - Settings.svelte：MCP 页接线 —— 错误卡 / 不可信项目提示 / 启停按钮 / 暴露级别 choice-row /
 *   patchMcpServer → rpc('mcp_patch') → loadMcpServers 刷新；旧版响应兼容合并。
 * 视图 A = squash(stripComments(raw))（含字面量）；计数用 countCodeHits（防字面量诱饵）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { TIMEOUT_BY_TYPE, requestTimeoutMs } from '../src/rpc-policy.ts'
import { squash, stripComments, maskStrings, shapeWithLiteralMask, indexOfCode, functionBodyOf } from './helpers/source-assert.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function viewA(relative) {
  return squash(stripComments(readFileSync(join(root, relative), 'utf8')))
}

/** 防诱饵计数：只统计「真实代码区」的命中（字符串/注释里的同形文本不计入）。 */
function countCodeHits(rawSource, needle) {
  const { shape, literal } = shapeWithLiteralMask(stripComments(rawSource))
  let count = 0
  let pos = 0
  for (;;) {
    const idx = indexOfCode(shape, literal, needle, pos)
    if (idx < 0) break
    count += 1
    pos = idx + 1
  }
  return count
}

const sidecarA = viewA('sidecar/index.mjs')
const sidecarRaw = readFileSync(join(root, 'sidecar/index.mjs'), 'utf8')
const sectionOf = (startNeedle, endNeedle) => {
  const start = sidecarA.indexOf(startNeedle)
  const end = endNeedle ? sidecarA.indexOf(endNeedle, start + 1) : -1
  return sidecarA.slice(start, end > start ? end : start + 2400)
}

// ---------- sidecar：SDK 扩展注册与能力探测 ----------

test('createMcpExtension 能力探测：无 SDK 能力时保持 null（降级路径），有则存工厂', () => {
  // 能力检测必须 typeof 判断（SDK 升级移除导出时静默降级，而不是 crash）
  assert.ok(sidecarA.includes("typeofloadedSdk.module.createMcpExtension==='function'"), 'createMcpExtension 缺少 typeof 能力检测')
  assert.ok(sidecarA.includes('mcpConfigApi'), '缺少 mcpConfigApi 深导入容器')
  // 深导入路径必须是 SDK dist 内的 extensions/mcp/config.js（该 API 不在顶层导出）
  assert.ok(sidecarA.includes("'extensions','mcp','config.js'"), 'mcp config 深导入路径错误')
})

test('sessionExtensions 注册 mcpExtension()，且工厂无参调用（跨 reload 重挂安全）', () => {
  const body = sectionOf('functionsessionExtensions(', 'functionresolveProjectTrust(')
  assert.ok(body.length > 0, 'sessionExtensions 函数体定位失败')
  assert.ok(body.includes('...(mcpExtension?[mcpExtension()]:[])'), 'MCP 扩展工厂未注册进 sessionExtensions')
  // 三处会话创建共用 sessionExtensions —— 锁定调用数 ≥ 3，防止绕过直连工厂列表
  assert.ok(countCodeHits(sidecarRaw, 'sessionExtensions(entry') >= 3, 'createSession/openSession/forkSession 应共用 sessionExtensions')
})

// ---------- sidecar：mcp_list SDK 校验路径 ----------

test('mcp_list：SDK 路径走 loadMcpConfig 且 projectTrusted 透传 + errors 透传', () => {
  assert.equal(countCodeHits(sidecarRaw, "type==='mcp_list'"), 1, 'mcp_list 分支缺失或被诱饵污染')
  const section = sectionOf("type==='mcp_list'", "type==='mcp_save'")
  assert.ok(section.includes('loadMcpConfig({agentDir,cwd:workspace,projectTrusted:trusted})'), 'SDK 路径必须调 loadMcpConfig 并透传 projectTrusted')
  assert.ok(section.includes('resolveProjectTrust({})'), 'projectTrusted 必须来自 resolveProjectTrust')
  assert.ok(section.includes('errors:Array.isArray(loaded?.errors)'), 'SDK 校验 errors 必须透传 UI')
  assert.ok(section.includes("exposure:String(s?.config?.exposure||'codemode')"), 'exposure 默认 codemode')
  assert.ok(section.includes('s?.config?.enabled!==false'), 'enabled 语义：缺省即启用')
  // T2⑧：oauth 必须透出 UI（SDK McpServerConfigPatch 写不了 oauth，编辑走 mcp_oauth_patch）
  // M19 修补：字面量保留视图可被字符串诱饵顶替 —— 用防诱饵计数锁真实代码区的完整三元式。
  assert.equal(countCodeHits(sidecarRaw, "oauth:s?.config?.oauth&&typeofs.config.oauth==='object'?s.config.oauth:null"), 1, 'SDK 路径必须透出 oauth 字段（真实代码区恰好一处）')
})

test('mcp_list：保留旧版降级分支（语义锁定）——mcpConfigApi 为 null 时手写读取', () => {
  const section = sectionOf("type==='mcp_list'", "type==='mcp_save'")
  assert.ok(section.includes('JSON.parse(readFileSync(file,\'utf8\'))'), '降级分支手写读取缺失（语义锁定）')
  assert.ok(section.includes('global:awaitread(globalMcpFile)'), '降级响应必须保留 global/project 兼容字段')
  // M20 修补：needle 必须含判别值与 null 尾（截断前缀时 'object' 换成 'string' 测试仍绿）
  assert.equal(countCodeHits(sidecarRaw, "oauth:server?.oauth&&typeofserver.oauth==='object'?server.oauth:null"), 1, '降级路径同样必须透出 oauth 字段（完整三元式）')
})

// ---------- sidecar：mcp_patch 白名单与守卫 ----------

test('mcp_patch：exposure 白名单 + 空 patch/缺名/缺 SDK 能力全部 throw', () => {
  assert.equal(countCodeHits(sidecarRaw, "type==='mcp_patch'"), 1, 'mcp_patch 分支缺失或被诱饵污染')
  const section = sectionOf("type==='mcp_patch'", "type==='mcp_test'")
  assert.ok(section.includes("['codemode','deferred','direct','hidden'].includes(exposure)"), 'exposure 白名单缺失')
  assert.ok(section.includes('!name)throw'), '缺服务器名必须 throw')
  assert.ok(section.includes('thrownewError(\'补丁为空：需要enabled或exposure\')'), '空补丁必须 throw')
  assert.ok(section.includes('缺updateMcpServerConfig'), '缺 SDK 能力必须报错（静默失败会让编辑假成功）')
  assert.ok(section.includes('updateMcpServerConfig(file,name,patch)'), '必须走 SDK updateMcpServerConfig 写回')
  // 非法 exposure 也 throw：白名单 else 分支
  assert.ok(section.includes('非法暴露级别'), '非法 exposure 必须报错')
})

test('mcp_patch 超时登记：rpc-policy ↔ sidecar 分支一致', () => {
  assert.equal(countCodeHits(sidecarRaw, "type==='mcp_patch'"), 1)
  assert.ok(TIMEOUT_BY_TYPE.mcp_patch > 0, 'TIMEOUT_BY_TYPE 缺少 mcp_patch')
  assert.equal(requestTimeoutMs('mcp_patch'), TIMEOUT_BY_TYPE.mcp_patch)
  // T2⑧：mcp_oauth_patch 与 mcp_patch 同档（同为本地 JSON 读-改-写）
  assert.equal(TIMEOUT_BY_TYPE.mcp_oauth_patch, TIMEOUT_BY_TYPE.mcp_patch, 'mcp_oauth_patch 必须与 mcp_patch 同档')
  // M25 修补：本地 JSON/冒烟档绝对上限（mcp_* 都是本地文件操作或进程冒烟，不得配成网络档超时）
  for (const type of ['mcp_list', 'mcp_save', 'mcp_patch', 'mcp_oauth_patch', 'mcp_test']) {
    assert.ok(TIMEOUT_BY_TYPE[type] <= 60_000, `${type} 属本地 JSON/冒烟档，超时不得高于 60s`)
  }
})

// ---------- 对抗审查修补：写入互斥 + mcp_save 白名单 + UI 门闩 ----------

test('对抗审查A：mcp_save/mcp_patch 写入互斥 —— withMcpWriteLock 每文件串行化', () => {
  assert.ok(sidecarA.includes('constmcpWriteLocks=newMap()'), '缺少每文件写锁容器')
  assert.ok(sidecarA.includes('asyncfunctionwithMcpWriteLock(file,fn)'), '缺少 withMcpWriteLock 锁函数')
  // M11 修补：锁的本体形态 —— 串行化必须链在前一任务的 caught promise 上（异常不断链）；
  // 入图与清理守卫必须比较同一对象（tail），否则守卫恒 false、条目永不清理（死代码锁）。
  const lockBody = functionBodyOf(stripComments(sidecarRaw), 'withMcpWriteLock')
  assert.ok(lockBody.includes('prev.catch(()=>{}).then(fn)'), '锁串行化必须链在前一任务的 caught promise 上（否则 prev 失败毒化整条链）')
  assert.ok(lockBody.includes('consttail=run.finally('), '锁必须经 finally 链生成 tail 再入图')
  assert.ok(lockBody.includes('mcpWriteLocks.set(file,tail)'), '入图必须存 tail（后续排队者链接的对象）')
  assert.ok(lockBody.includes('mcpWriteLocks.get(file)===tail'), '清理守卫必须与入图对象同一（比较 run 恒 false = 条目泄漏）')
  // 两个写入分支都必须进锁：整表覆盖（mcp_save）与单键编辑（mcp_patch）都是读-改-写
  const saveSection = sectionOf("type==='mcp_save'", "type==='mcp_patch'")
  assert.ok(saveSection.includes('awaitwithMcpWriteLock(file,async()=>{'), 'mcp_save 必须进写锁')
  const patchSection = sectionOf("type==='mcp_patch'", "type==='mcp_test'")
  assert.ok(patchSection.includes('awaitwithMcpWriteLock(file,()=>mcpConfigApi.updateMcpServerConfig(file,name,patch))'), 'mcp_patch 必须进写锁')
})

test('对抗审查B：mcp_save 写入侧 exposure 白名单（UI 绕过时的最后防线）', () => {
  const saveSection = sectionOf("type==='mcp_save'", "type==='mcp_patch'")
  assert.ok(saveSection.includes("if(exposure!==undefined&&!['codemode','deferred','direct','hidden'].includes(exposure))"), 'mcp_save 缺少写入侧 exposure 白名单')
  assert.ok(saveSection.includes('非法暴露级别'), '非法 exposure 必须报错')
})

// ---------- T2⑧ MCP OAuth 跟进：mcp_oauth_patch 整组替换 ----------

test('mcp_oauth_patch：缺名/非法字段/坏端口/凭据配对全部 throw（写入前校验链）', () => {
  assert.equal(countCodeHits(sidecarRaw, "type==='mcp_oauth_patch'"), 1, 'mcp_oauth_patch 分支缺失或被诱饵污染')
  const section = sectionOf("type==='mcp_oauth_patch'", "type==='get_project_trust'")
  assert.ok(section.includes('!name)throw'), '缺服务器名必须 throw')
  // 字段白名单：七个 SDK McpOAuthConfig 字段之外一律拒绝
  assert.ok(section.includes("['clientId','clientSecret','callbackPort','callbackUrl','scope','clientName','authServerMetadataUrl']"), 'oauth 字段白名单缺失')
  assert.ok(section.includes('非法oauth字段'), '非法 oauth 字段必须报错')
  // 端口：1-65535 整数
  assert.ok(section.includes('!Number.isInteger(port)||port<=0||port>65535'), 'callbackPort 校验缺失')
  // 凭据配对：静态客户端注册必须 clientId/clientSecret 成对
  assert.ok(section.includes('静态客户端注册需要同时提供clientSecret'), 'clientId 无 clientSecret 必须报错')
  // M10 修补：配对条件形状锁定（undefined 判别 —— 换成 !oauth.clientId 空串也会被拒）
  assert.ok(section.includes('if(oauth.clientId!==undefined&&oauth.clientSecret===undefined){'), '凭据配对条件形状缺失（clientId/clientSecret 必须按 undefined 判别成对）')
  // 未找到目标服务器必须 throw（静默成功会造成「假保存」）
  assert.ok(section.includes('未找到MCP服务器'), '未找到服务器必须 throw')
  // M13 修补：name 必须 trim（纯空白名不得绕过 ！name 守卫）；M8+M9：oauthIn 归一三态 +
  // 校验块必须在 if(oauth) 门内（清除路径 oauth===null 不跑字段校验，无门会 TypeError）。
  assert.ok(section.includes("String(payload.name||'').trim()"), '服务器名必须 trim 空-安全取值')
  assert.ok(section.includes('!Array.isArray(oauthIn)'), 'oauthIn 数组必须归一（否则 Object.entries 会把数组下标当字段名）')
  assert.ok(section.includes('?Object.fromEntries('), '合法 oauthIn 必须经白名单过滤归一（Object.fromEntries）')
  assert.ok(section.includes(':null'), '非法 oauthIn 必须归一为 null（清除语义）')
  assert.ok(section.includes('if(oauth){'), '字段校验必须包在 if(oauth) 门内（清除路径不校验）')
  // M12 修补：先校验后写 —— 校验块（if(oauth){）必须出现在写锁之前（否则锁内才 throw，白占锁）
  const gateAt = section.indexOf('if(oauth){')
  const lockAt = section.indexOf('awaitwithMcpWriteLock(file,async()=>{')
  assert.ok(gateAt >= 0 && lockAt >= 0 && gateAt < lockAt, '校验块必须先于写锁（先校验后写，失败不进锁）')
})

test('mcp_oauth_patch：写锁内读-改-写，整组替换语义 + 全 null 清除 + 回包', () => {
  const section = sectionOf("type==='mcp_oauth_patch'", "type==='get_project_trust'")
  // 与 mcp_save/mcp_patch 共用每文件写锁
  assert.ok(section.includes('awaitwithMcpWriteLock(file,async()=>{'), 'mcp_oauth_patch 必须进写锁（读-改-写竞态）')
  // M12 修补：写锁调用必须无条件 —— 不得包进 if(oauth){ 门内（否则清除路径 oauth===null 跳锁，
  // 并发清除与写入可竞态）。校验门必须先闭合、锁在门外：门闭括号与锁调用直接相邻。
  assert.ok(section.includes('}awaitwithMcpWriteLock(file,async()=>{'), '写锁必须在校验门闭合之后无条件调用（清除路径不得跳锁）')
  // 配置文件读-改-写：损坏/缺失视为空表（不 crash 整条 RPC）
  assert.ok(section.includes('JSON.parse(readFileSync(file,\'utf8\'))'), '必须读取现有配置文件')
  assert.ok(section.includes('existing.mcpServers'), '必须挂在 mcpServers 表下')
  // 整组替换：oauth===null → delete server.oauth（清除语义）；否则整组赋值
  assert.ok(section.includes('if(oauth===null)deleteserver.oauth'), 'null 必须整组清除 oauth')
  assert.ok(section.includes('elseserver.oauth=oauth'), '非 null 必须整组替换 oauth 组')
  // 原子写回 + 回包
  assert.ok(section.includes('awaitatomicWriteJson(file,existing)'), '必须原子写回')
  assert.ok(section.includes('patched:true,scope,name,file,oauth'), '回包形状缺失')
  // 非对象 oauthIn（数组/字符串）→ 视为 null（清除），保持「传什么存什么」整组语义
  assert.ok(section.includes('!Array.isArray(oauthIn)'), '非对象 oauthIn 必须归一为 null（清除）')
})

test('mcp_oauth_patch 超时登记：rpc-policy ↔ sidecar 分支一致', () => {
  assert.equal(countCodeHits(sidecarRaw, "type==='mcp_oauth_patch'"), 1)
  assert.ok(TIMEOUT_BY_TYPE.mcp_oauth_patch > 0, 'TIMEOUT_BY_TYPE 缺少 mcp_oauth_patch')
  assert.equal(requestTimeoutMs('mcp_oauth_patch'), TIMEOUT_BY_TYPE.mcp_oauth_patch)
})

test('对抗审查A/D：patchMcpServer 有 mcpBusy 门闩，启停按钮 busy 时禁用', () => {
  // 门闩：重入直接 return（与 loadMcpServers 同款），finally 释放后再刷新列表
  assert.ok(settingsA.includes('if(!rpc||mcpBusy)return'), 'patchMcpServer 缺少 mcpBusy 门闩')
  // 启停按钮：busy 禁用（防连续快速点击并发 mcp_patch）
  assert.ok(settingsA.includes('disabled={mcpBusy}'), '启停按钮缺 busy 禁用')
  // mcpErrors keyed each 用复合键（i+':'+err），重复错误文案不再键冲突
  assert.ok(settingsA.includes('(i+\':\'+err)'), 'mcpErrors 键仍用 err 字符串本身（重复文案键冲突）')
})

// ---------- Settings.svelte：MCP 页接线 ----------

const settingsA = viewA('src/Settings.svelte')

test('Settings MCP 页：启停按钮 + 暴露级别 choice-row + patchMcpServer 调用链', () => {
  assert.ok(settingsA.includes('functionpatchMcpServer(server:McpServer,patch:{enabled?:boolean;exposure?:string})'), '缺少 patchMcpServer')
  assert.ok(settingsA.includes("rpc('mcp_patch',{scope:server.scope,name:server.name,...patch})"), 'patchMcpServer 必须调 mcp_patch RPC')
  assert.ok(settingsA.includes('{enabled:!server.enabled}'), '启停按钮必须取反当前 enabled')
  assert.ok(settingsA.includes('voidpatchMcpServer(server,{exposure})'), '暴露级别按钮必须触发 exposure patch')
  // 编辑后必须刷新列表（否则 UI 显示陈旧状态）
  assert.ok(settingsA.includes('awaitloadMcpServers()'), 'patch 后必须 loadMcpServers() 刷新')
})

test('Settings MCP 页：暴露级别四档与 SDK McpExposure 一致，codemode 默认', () => {
  for (const exposure of ['codemode', 'deferred', 'direct', 'hidden']) {
    assert.ok(settingsA.includes(`'${exposure}'`), `MCP_EXPOSURES 缺少 ${exposure}`)
  }
  assert.ok(settingsA.includes("class:on={server.exposure===exposure}"), '暴露级别按钮 active 态绑定缺失')
})

test('Settings MCP 页：SDK 校验错误卡 + 不可信项目提示 + 旧版响应兼容', () => {
  assert.ok(settingsA.includes('Array.isArray(result?.servers)'), '新路径判定：servers 数组存在才走 SDK 结果')
  assert.ok(settingsA.includes('mcpErrors'), '缺少 SDK 校验错误展示状态')
  assert.ok(settingsA.includes('mcpProjectTrusted'), '缺少不可信项目提示状态')
  assert.ok(settingsA.includes('mcpNotice'), 'RPC 失败必须落 mcpNotice（旧实现静默吞错）')
  // 旧版 sidecar 响应（global/project 数组）兼容合并
  assert.ok(settingsA.includes('result?.global??[]'), '旧版响应兼容合并缺失')
})

test('Settings MCP 页：新字段类型与 keyed each 稳定键', () => {
  assert.ok(settingsA.includes('enabled:boolean;exposure:string'), 'McpServer 类型缺 enabled/exposure')
  assert.ok(settingsA.includes('(server.scope+\':\'+server.name)'), 'keyed each 稳定键缺失（scope+name）')
})

test('Settings MCP 页：T2⑧ OAuth 表单 —— http 型服务器展示 + 草稿不覆盖未保存编辑 + 整组保存', () => {
  // 类型：oauth 透出字段
  assert.ok(settingsA.includes('oauth?:Record<string,unknown>|null'), 'McpServer 类型缺 oauth 字段')
  // 仅 http 型服务器展示 OAuth 表单（stdio 无 OAuth 概念）
  assert.ok(settingsA.includes("{#ifserver.transport==='http'}"), 'OAuth 表单必须只在 http 型服务器展示')
  // 草稿合并：已有草稿直接返回（不覆盖未保存的编辑），否则从 server.oauth 回读
  assert.ok(settingsA.includes('functionmcpOauthDraftOf(server:McpServer):McpOauthDraft'), '缺少 mcpOauthDraftOf')
  // M21 修补：无界 slice → functionBodyOf（bounded + 防重复声明）
  const draftFn = functionBodyOf(stripComments(readFileSync(join(root, 'src/Settings.svelte'), 'utf8')), 'mcpOauthDraftOf')
  assert.ok(draftFn.includes('if(existing)returnexisting'), '草稿合并必须先返回已有草稿（不覆盖未保存编辑）')
  // M17 修补：回读判别形状（server.oauth && typeof === 'object'）锁定在草稿函数体里
  assert.ok(draftFn.includes("server.oauth&&typeofserver.oauth==='object'"), '草稿回读必须判别 oauth 为对象（null/标量直接落入空草稿）')
  // 保存链：配对校验 + 端口校验 + 空组=清除 + rpc 调用 + 刷新
  const saveOAuthShape = settingsA.slice(settingsA.indexOf('asyncfunctionsaveMcpOAuth'), settingsA.indexOf('asyncfunctiontestMcpServer'))
  assert.ok(settingsA.includes('asyncfunctionsaveMcpOAuth(server:McpServer)'), '缺少 saveMcpOAuth')
  // M14/M15 修补：条件形状锁定（不只锁错误消息 —— 消息可被诱饵，条件才是真实防线）
  assert.ok(saveOAuthShape.includes('if(clientId&&!clientSecret)throw'), 'clientId 无 clientSecret 前端必须拦截（条件形状）')
  assert.ok(saveOAuthShape.includes('!Number.isInteger(port)||port<=0||port>65535'), 'callbackPort 前端校验缺失（条件形状）')
  // M16 修补：下发字段数组锁定（四字段 for-of 收集；漏字段=静默丢弃用户输入）
  assert.ok(saveOAuthShape.includes("for(constfieldof['callbackUrl','scope','clientName','authServerMetadataUrl']asconst)"), '四字段收集循环缺失（callbackUrl 等会被静默丢弃）')
  assert.ok(settingsA.includes('静态客户端注册需要同时提供clientSecret'), 'clientId 无 clientSecret 报错文案缺失')
  assert.ok(settingsA.includes('callbackPort必须是1-65535的整数'), 'callbackPort 前端校验缺失')
  assert.ok(settingsA.includes("rpc('mcp_oauth_patch',{scope:server.scope,name:server.name,oauth:Object.keys(oauth).length?oauth:null})"), 'saveMcpOAuth 必须调 mcp_oauth_patch（空组下发 null=清除）')
  // busy 门闩（keyed）+ 保存后刷新
  assert.ok(saveOAuthShape.includes('if(mcpOauthBusy[key])return'), 'saveMcpOAuth 缺少 busy 门闩')
  // M18 修补：disabled 必须断言完整 keyed 形态（裸 mcpOauthBusy[key] 会被门闩行恒真满足）
  assert.ok(settingsA.includes('disabled={mcpOauthBusy[server.scope+\':\'+server.name]}'), '保存按钮 disabled 必须用 scope+name 复合键（裸键恒真断言无效）')
  assert.ok(settingsA.includes('保存中…'), '保存按钮缺 busy 文案')
})

// ---------- 字面量诱饵防线自检 ----------

test('防诱饵自检：字面量里的 mcp_patch 不计入代码命中', () => {
  const { shape, literal } = shapeWithLiteralMask(stripComments("const x = \"type==='mcp_patch'\""))
  assert.equal(indexOfCode(shape, literal, "type==='mcp_patch'"), -1)
})
