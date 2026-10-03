import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { providerCards } from '../sidecar/config.mjs'
import { indexOfCode, shapeWithLiteralMask, stripComments } from './helpers/source-assert.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const readSrc = (rel) => readFileSync(path.join(root, rel), 'utf8')
const readSidecar = () => readFileSync(path.join(root, 'sidecar', 'index.mjs'), 'utf8')

// 形状视图：shape = 剥注释+去空白（保留字面量内容），literal = 逐字符是否来自字符串。
// indexOfCode(shape, literal, needle) 只认"命中起点在真实代码里"的位置。
const sideView = shapeWithLiteralMask(stripComments(readSidecar()))
const srcView = shapeWithLiteralMask(stripComments(readSrc('src/ConfigPane.svelte')))

/** 定位 needle（必须在代码区）并返回 shape 窗口切片；找不到时用明确的错误消息失败。 */
function windowAt(view, needle, span, label) {
  const at = indexOfCode(view.shape, view.literal, needle)
  assert.ok(at >= 0, `${label}：定位失败（代码区找不到 ${needle}）`)
  return view.shape.slice(at, at + span)
}

// ---------- T1⑤ 行为：providerCards 的 OAuth 感知 ----------

const CATALOG = [{ provider: 'openai', models: [{ id: 'gpt-5.1', name: 'GPT-5.1', contextWindow: 400000, maxTokens: 128000 }] }]

test('providerCards：OAuth 凭据（type 显式标注）视为已配置，keyHint=OAuth，不影响 api_key 行为', () => {
  const providers = { openai: { baseUrl: 'https://api.openai.com/v1', api: 'openai-responses' } }
  const auth = {
    openai: { type: 'oauth', refresh: 'r-abc', access: 'a-xyz', expires: 123 },
    deepseek: { type: 'api_key', key: 'sk-1234567890abcdef' },
    groq: { key: 'gsk_1234567890abcdef' }
  }
  const cards = providerCards(providers, auth, CATALOG)
  const openai = cards.find((card) => card.provider === 'openai')
  assert.ok(openai, 'openai 卡片必须存在')
  assert.equal(openai.oauth, true, 'type:"oauth" → oauth 标记为 true')
  assert.equal(openai.configured, true, 'OAuth 凭据无 key 也必须视为已配置（T1⑤ Bug 修复点）')
  assert.equal(openai.keyHint, 'OAuth', 'OAuth 凭据 keyHint 显示 OAuth 而非空串')

  const deepseek = cards.find((card) => card.provider === 'deepseek')
  assert.equal(deepseek.oauth, false, 'api_key 行 oauth 标记为 false')
  assert.equal(deepseek.configured, true)
  assert.equal(deepseek.keyHint, 'sk-1…cdef', 'api_key keyHint 保持既有掩码格式')

  const groq = cards.find((card) => card.provider === 'groq')
  assert.equal(groq.configured, true, '无 type 但有 key 的旧式凭据仍按 key 判定')
  assert.equal(groq.oauth, false)
  assert.equal(groq.keyHint, 'gsk_…cdef')
})

test('providerCards：无 type 但带 refresh 字段的凭据也按 OAuth 判定（SDK 原生 auth.json 形态）', () => {
  const cards = providerCards({}, { openai: { refresh: 'r-abc', access: 'a-xyz', expires: 123 } }, [])
  const openai = cards.find((card) => card.provider === 'openai')
  assert.ok(openai, '仅 auth.json 有凭据也必须出卡片')
  assert.equal(openai.oauth, true, 'refresh 字段 → OAuth 判定')
  assert.equal(openai.configured, true)
  assert.equal(openai.keyHint, 'OAuth')
})

test('providerCards：空凭据与 models.json apiKey 共存时按 key 优先，oauth 标记仍来自凭据形态', () => {
  const cards = providerCards(
    { openai: { apiKey: 'sk-oai-key-0001' } },
    { openai: { type: 'oauth', refresh: 'r', access: 'a', expires: 1 } },
    []
  )
  const openai = cards.find((card) => card.provider === 'openai')
  assert.equal(openai.keyHint, 'sk-o…0001', 'models.json 有 apiKey 时掩码按 key')
  assert.equal(openai.configured, true)
  assert.equal(openai.oauth, true, '凭据形态标记不丢')
})

test('providerCards：凭据形态边界——refresh 空串且无 type 不判 OAuth；非对象/空对象 cred 不误判', () => {
  // refresh 为空串：既无 type 也无有效 refresh，必须判为未配置（否则空壳凭据蒙混成 OAuth 已配置）
  const emptyRefresh = providerCards({}, { openai: { refresh: '', access: 'a', expires: 1 } }, [])
  const emptyCard = emptyRefresh.find((card) => card.provider === 'openai')
  assert.ok(emptyCard, '仅 auth 有凭据也出卡片')
  assert.equal(emptyCard.oauth, false, 'refresh 空串不能按 OAuth 判定')
  assert.equal(emptyCard.configured, false, '无 type 无有效 refresh 不得视为已配置')
  assert.equal(emptyCard.keyHint, '', '无 key 无 OAuth 时 keyHint 为空串')
  // cred 为字符串（脏数据）：不得崩、不得判 OAuth
  const stringCred = providerCards({}, { openai: 'garbage' }, [])
  const stringCard = stringCred.find((card) => card.provider === 'openai')
  assert.ok(stringCard, 'cred 为字符串也出卡片')
  assert.equal(stringCard.oauth, false, '字符串 cred 不判 OAuth')
  assert.equal(stringCard.configured, false, '字符串 cred 不视为已配置')
  // cred 为空对象：同样不判 OAuth
  const emptyObj = providerCards({}, { openai: {} }, [])
  assert.equal(emptyObj.find((card) => card.provider === 'openai')?.oauth, false, '空对象 cred 不判 OAuth')
  // cred 为 null：不崩、不判 OAuth
  const nullCred = providerCards({}, { openai: null }, [])
  assert.equal(nullCred.find((card) => card.provider === 'openai')?.oauth, false, 'null cred 不判 OAuth')
  // auth 整体为 null/undefined：不得崩（config.mjs 契约容忍无 auth.json）
  const noAuth = providerCards({ openai: { baseUrl: 'https://x', apiKey: 'sk-1234567890abcdef' } }, null, [])
  const noAuthCard = noAuth.find((card) => card.provider === 'openai')
  assert.equal(noAuthCard.oauth, false, 'auth 为 null 时不判 OAuth')
  assert.equal(noAuthCard.configured, true, 'auth 为 null 时仍按 models.json apiKey 判配置态')
  assert.equal(noAuthCard.keyHint, 'sk-1…cdef', 'auth 为 null 时掩码不受影响')
  const noAuthEmpty = providerCards({}, undefined, [])
  assert.equal(noAuthEmpty.find((card) => card.provider === 'openai'), undefined, '无 auth 无 providers 时无卡片且不崩')
})

// ---------- sidecar：auth_status / auth_logout RPC 形状 ----------

test('sidecar：auth_status 遍历 getProviders，回传状态+订阅+登录方式', () => {
  const tail = windowAt(sideView, "if(type==='auth_status'){", 800, 'auth_status RPC')
  for (const needle of [
    'awaitensureRuntime()',
    'runtime.getProviders().map((provider)=>{',
    'constoauth=provider.auth?.oauth||null',
    'reply(id,{providers})'
  ]) assert.ok(tail.includes(needle), `auth_status 缺少 ${needle}`)
})

test('sidecar：auth_status 单提供商状态查询失败不炸全局（per-provider try/catch 兜底 configured:false）', () => {
  const tail = windowAt(sideView, "if(type==='auth_status'){", 800, 'auth_status RPC')
  assert.ok(
    tail.includes('letstatus={configured:false}try{status=runtime.getProviderAuthStatus(provider.id)||{configured:false}}catch(error){log(error)}'),
    'per-provider try/catch 必须兜底 {configured:false} 并 log'
  )
  assert.ok(tail.includes('subscription:Boolean(runtime.isUsingSubscription?.(provider.id))'), '订阅态必须查询')
  assert.ok(tail.includes("oauthName:oauth?.name||''") && tail.includes("loginLabel:oauth?.loginLabel||''"), 'OAuth 元数据必须透传')
})

test('sidecar：auth_logout 校验 provider 非空；成功回包后刷新目录；失败回 ok:false 不炸主循环', () => {
  const tail = windowAt(sideView, "if(type==='auth_logout'){", 600, 'auth_logout RPC')
  for (const needle of [
    "constprovider=String(payload.provider||'').trim()",
    "if(!provider)thrownewError('缺少provider')",
    'await(awaitensureRuntime()).logout(provider)',
    'awaitensureRuntime(true)'
  ]) assert.ok(tail.includes(needle), `auth_logout 缺少 ${needle}`)
  // 顺序锁定：成功回包 → 刷新；catch → ok:false 回包
  assert.ok(
    tail.includes('reply(id,{ok:true,provider,message:`已登出${provider}`})awaitensureRuntime(true)}catch(error){reply(id,{ok:false,provider,message:error.message||\'登出失败\'})}'),
    '成功回包→ensureRuntime(true)→catch 回 ok:false 的顺序必须保持（oauth_login 同款语义）'
  )
})

test('sidecar：auth_status/auth_logout 不加入 NON_BLOCKING_REQUESTS（登出走串行链，快速返回）', () => {
  const at = indexOfCode(sideView.shape, sideView.literal, 'constNON_BLOCKING_REQUESTS=newSet([')
  assert.ok(at >= 0, 'NON_BLOCKING_REQUESTS 声明必须存在')
  const end = sideView.shape.indexOf('])', at) + 2
  const decl = sideView.shape.slice(at, end)
  for (const needle of ['oauth_login', 'ui_dialog_response', 'mcp_test', 'confirm_response'])
    assert.ok(decl.includes(needle), `既有豁免 ${needle} 不得漂移`)
  assert.ok(!decl.includes('auth_logout'), 'auth_logout 必须留在串行链')
  assert.ok(!decl.includes('auth_status'), 'auth_status 是只读快查，也留在串行链')
})

test('回归：oauth_login RPC 的登录主链路保持原样（login + 成功后刷新目录）', () => {
  const tail = windowAt(sideView, "if(type==='oauth_login'){", 500, 'oauth_login RPC')
  for (const needle of [
    "constprovider=String(payload.provider||'').trim()",
    "if(!provider)thrownewError('缺少provider')",
    "constcredential=await(awaitensureRuntime()).login(provider,'oauth',createLoginInteraction(provider))",
    'reply(id,{ok:true,provider,message:`已登录${provider}`})',
    'awaitensureRuntime(true)',
    "reply(id,{ok:false,provider,message:error.message||'登录失败'})"
  ]) assert.ok(tail.includes(needle), `oauth_login 缺少 ${needle}`)
})

// ---------- ConfigPane 接线 ----------

test('ConfigPane：登录成功后不再插空 auth 行（防 serializeAuth 用空 key 覆盖 auth.json 的 OAuth 凭据）', () => {
  const tail = windowAt(srcView, 'asyncfunctionloginOAuth(provider:string){', 500, 'loginOAuth')
  assert.ok(tail.includes("awaitrpc?.('oauth_login',{provider})"), 'oauth_login RPC 调用必须保留')
  assert.ok(tail.includes('if(result?.ok)awaitloadAuthStatus()'), '成功后必须刷新真实状态')
  assert.ok(!tail.includes('authRows=[...authRows,'), 'loginOAuth 内禁止再直接插入 authRows 行')
  assert.ok(!tail.includes("type:'oauth'"), 'loginOAuth 内禁止构造 type:"oauth" 空行')
})

test('ConfigPane：登出走 auth_logout 并刷新状态', () => {
  const tail = windowAt(srcView, 'asyncfunctionlogoutOAuth(provider:string){', 450, 'logoutOAuth')
  assert.ok(tail.includes("awaitrpc?.('auth_logout',{provider})"), 'auth_logout RPC 调用必须存在')
  assert.ok(tail.includes('if(result?.ok)awaitloadAuthStatus()'), '登出成功后必须刷新')
})

test('ConfigPane：loadAuthStatus 拉 auth_status 并按 provider id 建索引；hydrate 时加载', () => {
  const tail = windowAt(srcView, 'asyncfunctionloadAuthStatus(){', 400, 'loadAuthStatus')
  assert.ok(tail.includes("awaitrpc?.('auth_status',{})"), 'auth_status RPC 调用必须存在')
  assert.ok(tail.includes('for(constinfoofresult?.providers||[])bag[info.id]=info'), '必须按 info.id 建索引')
  assert.ok(tail.includes('oauthInfo=bag'), '结果必须落到 oauthInfo')
  assert.ok(tail.includes('oauthInfo=bag}catch{oauthInfo={}}'), 'RPC 失败兜底必须重置 oauthInfo={}（虚拟行安全消失，不得悬挂旧状态）')
  const hydrate = windowAt(srcView, 'asyncfunctionhydrate(){', 1100, 'hydrate')
  assert.ok(hydrate.includes('awaitloadAuthStatus()'), 'hydrate 内必须调用 loadAuthStatus')
})

test('ConfigPane：connection 标签 OAuth 已配置态渲染登出按钮 + 登录入口 + 订阅徽标；未配置态保留 API Key 输入', () => {
  const branch = windowAt(
    srcView,
    "{#ifauthRowFor(item.name)?.type==='oauth'||item.oauthRow?.configured||oauthInfo[item.name]?.configured}",
    1400,
    'OAuth 专用分支'
  )
  assert.ok(branch.includes('voidlogoutOAuth(item.name)'), '登出按钮必须接 logoutOAuth')
  assert.ok(branch.includes('voidloginOAuth(item.name)'), '登录按钮必须接 loginOAuth')
  assert.ok(branch.includes("?.configured?'重新登录'"), '已配置时登录按钮文案=重新登录')
  assert.ok(branch.includes("||'OAuth登录'"), '未配置时回退到 loginLabel/OAuth 登录文案')
  assert.ok(branch.includes('patchApiKey(item.name,'), '未配置 OAuth 时必须保留 API Key 输入')
  const badge = indexOfCode(srcView.shape, srcView.literal, 'oauthRow?.subscription||oauthInfo[item.name]?.subscription')
  assert.ok(badge >= 0, '订阅徽标必须消费 oauthRow/oauthInfo 的 subscription')
})

test('ConfigPane：OAuth 目录展示行只来自 oauthInfo 派生，不进 providers 序列化', () => {
  const tail = windowAt(srcView, '$:managerProviders=[', 800, 'managerProviders')
  assert.ok(tail.includes('...Object.values(oauthInfo)'), 'OAuth 目录行必须从 oauthInfo 派生')
  assert.ok(tail.includes('!providers.some((item)=>item.name===info.id)'), '去重：providers 已有则不派生')
  assert.ok(tail.includes('!authRows.some((row)=>row.name===info.id)'), '去重：authRows 已有则不派生')
  assert.ok(tail.includes('name:info.id,builtin:true,oauthRow:info'), '派生行必须带 oauthRow 标记')
  const ser = windowAt(srcView, 'functionserializeAuth(){', 300, 'serializeAuth')
  assert.ok(!ser.includes('oauthRow'), 'serializeAuth 不得消费 oauthRow（虚拟行不落盘）')
})

test('ConfigPane：虚拟行不提供删除按钮；列表副标题区分 OAuth 行', () => {
  assert.ok(
    indexOfCode(srcView.shape, srcView.literal, '{#if!item.oauthRow}<buttonclass="ghostdanger"on:click={()=>deleteProvider(item.name)}>删除</button>{/if}') >= 0,
    '删除按钮必须包在 {#if !item.oauthRow} 里（虚拟行不可删）'
  )
  assert.ok(
    indexOfCode(srcView.shape, srcView.literal, '{#ifitem.oauthRow}<small>OAuth登录') >= 0,
    '列表副标题必须区分 OAuth 行'
  )
})

test('ConfigPane：AUTH_PRESETS 覆盖 openai-codex（新增预设）', () => {
  const at = indexOfCode(srcView.shape, srcView.literal, 'constAUTH_PRESETS=[')
  assert.ok(at >= 0, 'AUTH_PRESETS 声明必须存在')
  const decl = srcView.shape.slice(at, srcView.shape.indexOf(']', at) + 1)
  for (const preset of ["'anthropic'", "'openai'", "'openai-codex'", "'xai'"])
    assert.ok(decl.includes(preset), `AUTH_PRESETS 缺少 ${preset}`)
})

// ---------- 回归守卫：既有行为不被顺手改变 ----------

test('回归：ConfigPane maskKey 语义未漂移（短 key 掩码格式）', () => {
  const cards = providerCards({}, { kimi: { key: 'abc' } }, [])
  assert.equal(cards[0].configured, true)
  assert.equal(cards[0].keyHint, '••••', '短 key 既有掩码格式不变')
})
