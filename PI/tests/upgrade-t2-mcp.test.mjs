/**
 * T2⑥ MCP 原生化 承重测试：
 * - sidecar：createMcpExtension 注册进 sessionExtensions；mcp_list 走 SDK loadMcpConfig
 *   （projectTrusted 透传 + errors 透传），保留旧版降级分支（语义锁定）；mcp_patch 白名单
 *   （enabled boolean / exposure ∈ codemode|deferred|direct|hidden）、空补丁与缺 SDK 能力都 throw。
 * - rpc-policy：mcp_patch 超时登记。
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
import { squash, stripComments, maskStrings, shapeWithLiteralMask, indexOfCode } from './helpers/source-assert.mjs'

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
})

test('mcp_list：保留旧版降级分支（语义锁定）——mcpConfigApi 为 null 时手写读取', () => {
  const section = sectionOf("type==='mcp_list'", "type==='mcp_save'")
  assert.ok(section.includes('JSON.parse(readFileSync(file,\'utf8\'))'), '降级分支手写读取缺失（语义锁定）')
  assert.ok(section.includes('global:awaitread(globalMcpFile)'), '降级响应必须保留 global/project 兼容字段')
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
})

// ---------- 对抗审查修补：写入互斥 + mcp_save 白名单 + UI 门闩 ----------

test('对抗审查A：mcp_save/mcp_patch 写入互斥 —— withMcpWriteLock 每文件串行化', () => {
  assert.ok(sidecarA.includes('constmcpWriteLocks=newMap()'), '缺少每文件写锁容器')
  assert.ok(sidecarA.includes('asyncfunctionwithMcpWriteLock(file,fn)'), '缺少 withMcpWriteLock 锁函数')
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

// ---------- 字面量诱饵防线自检 ----------

test('防诱饵自检：字面量里的 mcp_patch 不计入代码命中', () => {
  const { shape, literal } = shapeWithLiteralMask(stripComments("const x = \"type==='mcp_patch'\""))
  assert.equal(indexOfCode(shape, literal, "type==='mcp_patch'"), -1)
})
