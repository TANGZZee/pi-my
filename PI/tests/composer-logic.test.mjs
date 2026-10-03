// 0-5 拆分批次 C：Composer 输入区抽取行为单测 + 接线承重断言
//
// 抽取防线（同批次 A/B 模式）：
// 1) 行为单测——composer-logic.ts 纯函数（ctxProgress/ctxDash/fmtWan/mentionList）直接跑，
//    防"纯逻辑抽取后语义漂移"；
// 2) 接线真实性——App.svelte 必须真的挂载 Composer 并 bind 关键状态（inputText/attachments/
//    attachError/imageGen 双向），App 侧 submit/dispatchTurn 消费的输入文本与附件必须经
//    bind 双向流动；形状断言用 shapeWithLiteralMask + indexOfCode（只认真实代码区命中，
//    注释/诱饵字符串无效）；
// 3) 本地重复定义消失——App.svelte 不得残留搬进组件的函数体（refreshCtxStats/addAttachments/
//    handleKeydown/applyMention 等）；纯逻辑常量必须从 composer-logic.ts 导入而非组件重定义；
// 4) 归属守卫——submit/stop/runSlashCommand 必须是回调 props（驱动逻辑留 App），数据通道
//    必须走 request/requestRaw，不得引入旁路。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { CTX_CIRC, EMPTY_CTX, ctxProgress, ctxDash, fmtWan, mentionList } from '../src/composer-logic.ts'
import { SLASH_COMMANDS } from '../src/slash-commands.ts'
import { squash, stripComments, shapeWithLiteralMask, indexOfCode, functionBodyOf } from './helpers/source-assert.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const readSrc = (p) => readFileSync(join(root, p), 'utf8')
const appRaw = readSrc('src/App.svelte')
const composerRaw = readSrc('src/Composer.svelte')
const logicRaw = readSrc('src/composer-logic.ts')
const appCode = squash(stripComments(appRaw))
const composerCode = squash(stripComments(composerRaw))

// ---------- 行为单测：composer-logic.ts 纯函数 ----------

const EMPTY_STATS = { currentContext: 0, window: 0, totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, costUsd: 0, cacheHitRate: 0 }

test('ctxProgress：占用比映射 + clamp 0-100 + 无窗口数据为 0', () => {
  assert.equal(ctxProgress(null), 0)
  assert.equal(ctxProgress(undefined), 0, 'undefined 必须回落 0')
  assert.equal(ctxProgress(EMPTY_STATS), 0, 'window=0 必须回落 0（除零防线）')
  assert.equal(ctxProgress({ ...EMPTY_STATS, currentContext: 5000, window: 10000 }), 50)
  assert.equal(ctxProgress({ ...EMPTY_STATS, currentContext: 5000, window: 4000 }), 100, '超出窗口必须 clamp 到 100')
  assert.equal(ctxProgress({ ...EMPTY_STATS, currentContext: 0, window: 10000 }), 0)
})

test('ctxDash：环形 dasharray 周长映射（硬编码期望值防恒真，M22）', () => {
  // 期望值手算写死（r=7：2π·7≈43.9823 → '43.98'），不用实现同款公式重算
  assert.equal(ctxDash({ ...EMPTY_STATS, currentContext: 5000, window: 10000 }), '21.99 43.98', '50% 弧长必须 ≈21.99')
  assert.equal(ctxDash(EMPTY_STATS), '0.00 43.98', '空态零弧')
  assert.equal(ctxDash(null), '0.00 43.98', 'null 快照必须安全回落空弧')
  assert.equal(ctxDash({ ...EMPTY_STATS, currentContext: 9000, window: 10000 }), '39.58 43.98', '90% 弧长必须 ≈39.58（43.9823·0.9=39.5841）')
})

test('EMPTY_CTX：全零形状且独立于 stats 引用', () => {
  assert.equal(EMPTY_CTX.currentContext, 0)
  assert.equal(EMPTY_CTX.window, 0)
  assert.equal(EMPTY_CTX.costUsd, 0)
  assert.equal(EMPTY_CTX.cacheHitRate, 0)
  assert.equal(EMPTY_CTX.totals.total, 0)
})

test('fmtWan：不足一万原样、以上取整为「N万」、非有限数原样', () => {
  assert.equal(fmtWan(0), '0')
  assert.equal(fmtWan(9999), '9999')
  assert.equal(fmtWan(10000), '1万')
  assert.equal(fmtWan(152000), '15万')
  assert.equal(fmtWan(Number.NaN), 'NaN', '非有限数原样返回')
})

test('mentionList：cmd 走斜杠命令过滤、file 走路径子串匹配 + 上限 8、null 空列', () => {
  assert.deepEqual(mentionList(null, []), [])
  assert.deepEqual(mentionList(null, [{ path: 'a.ts', kind: 'file' }]), [])
  const all = mentionList({ kind: 'cmd', query: '', index: 0 }, [])
  assert.deepEqual(all, [...SLASH_COMMANDS], 'cmd 空查询必须返回全部注册命令')
  const hits = mentionList({ kind: 'cmd', query: 'comp', index: 0 }, [])
  assert.ok(hits.some((item) => item.id === 'compact'), 'cmd 查询必须过滤到 compact')
  const files = Array.from({ length: 12 }, (_, i) => ({ path: `src/mod-${i}.ts`, kind: 'file' }))
  const fileHits = mentionList({ kind: 'file', query: 'MOD', index: 0 }, files)
  assert.equal(fileHits.length, 8, 'file 候选必须截断到 8 条')
  assert.ok(fileHits.every((item) => item.path.toLowerCase().includes('mod')), 'file 匹配必须大小写不敏感子串')
  const dirs = [{ path: 'src', kind: 'directory' }, { path: 'src/x.ts', kind: 'file' }]
  assert.deepEqual(mentionList({ kind: 'file', query: 'x', index: 0 }, dirs), [dirs[1]], '非 file kind 不入选')
})

test('composer-logic 归属：纯逻辑常量只定义在 composer-logic.ts，组件导入而非重定义', () => {
  assert.ok(logicRaw.includes('export const CTX_CIRC'), 'composer-logic.ts 缺 CTX_CIRC 导出')
  assert.ok(logicRaw.includes('EMPTY_CTX'), 'composer-logic.ts 缺 EMPTY_CTX')
  assert.ok(logicRaw.includes('2 * Math.PI * 7'), 'composer-logic.ts 的 CTX_CIRC 公式被改动（r=7 锚，M4）')
  // M4：组件不得内联任何 π 公式（任何 subtly 错的重定义都拦住，不只挡现值复制）
  assert.equal(composerCode.includes('Math.PI'), false, 'Composer 不得内联任何 Math.PI 公式，必须 import 自 composer-logic（M4）')
  assert.ok(composerCode.includes("from'./composer-logic'"), 'Composer 必须从 composer-logic 导入')
  // M27：组件 ctxProgress/ctxDash 必须是薄委托（本地无百分比/环形数学），影子实现删 clamp/公式都拦住
  const compProgress = functionBodyOf(composerRaw, 'ctxProgress')
  assert.ok(compProgress.includes('logicCtxProgress(ctxStats)'), 'Composer ctxProgress 必须委托 composer-logic（M27）')
  assert.equal(compProgress.includes('ctxStats.currentContext'), false, 'Composer ctxProgress 不得本地做除法（M27）')
  const compDash = functionBodyOf(composerRaw, 'ctxDash')
  assert.ok(compDash.includes('logicCtxDash(ctxStats)'), 'Composer ctxDash 必须委托 composer-logic（M27）')
  assert.equal(compDash.includes('toFixed'), false, 'Composer ctxDash 不得本地格式化（M27）')
})

// ---------- 接线承重断言：App 挂载 + 双向 bind + 数据通道 + 负断言 ----------

test('App 挂载 Composer：bind 双向六项 + 驱动回调与数据通道 props 注入', () => {
  // 挂载行必须真实存在（indexOfCode 只认真实代码区命中，注释/字符串诱饵无效）
  const { shape: appShape, literal: appLiteral } = shapeWithLiteralMask(appRaw)
  const mount = indexOfCode(appShape, appLiteral, '<Composerbind:this={composerRef}')
  assert.ok(mount >= 0, 'App 必须挂载 Composer 且 bind:this 暴露 ref')
  // 双向 bind：App 侧所有权状态（inputText/attachments）与组件态展示（attachError/imageGen 双输出）
  for (const key of ['bind:inputText', 'bind:attachments', 'bind:attachError', 'bind:imageGenError', 'bind:imageGenResult']) {
    assert.ok(appCode.includes(key), `App 挂载行缺 ${key}（双向 bind 断裂）`)
  }
  // 驱动回调 props：submit/stop/runSlashCommand 必须由 App 注入（逻辑归属 App）
  for (const key of ['submit={submit}', 'stop={stop}', 'runSlashCommand={runSlashCommand}']) {
    assert.ok(appCode.includes(key), `App 挂载行缺 ${key}（驱动回调未注入）`)
  }
  // 数据通道 props：RPC 全走 request/requestRaw
  for (const key of ['request={request}', 'requestRaw={requestRaw}']) {
    assert.ok(appCode.includes(key), `App 挂载行缺 ${key}（数据通道未注入）`)
  }
  // 会话/模型上下文 props
  for (const key of ['models={models}', 'sessions={sessions}', 'activeSessionId={activeSessionId}', 'sidecarReady={sidecarReady}', 'remember={remember}', 'ensureActiveId={ensureActiveId}']) {
    assert.ok(appCode.includes(key), `App 挂载行缺 ${key}（上下文 props 未注入）`)
  }
  // 模板收敛：composer 模板壳与输入 textarea 只在组件里
  assert.equal(appCode.indexOf('<divclass="composer">'), -1, 'App 不得残留 composer 模板壳')
  assert.ok(composerCode.includes('<divclass="composer">'), 'Composer 缺模板壳')
  assert.ok(composerCode.includes('bind:value={inputText}'), 'Composer 缺 textarea 双向绑定')
  assert.ok(composerCode.includes('on:input={refreshMention}'), 'Composer textarea 缺 mention 触发')
  assert.ok(composerCode.includes('on:keydown={handleKeydown}'), 'Composer textarea 缺快捷键处理')
  assert.ok(composerCode.includes('on:paste={handleClipboardPaste}'), 'Composer textarea 缺粘贴附件处理')
})

test('App 薄桥：composerRef API 调用点全部在位', () => {
  for (const call of ['composerRef?.reloadPrefs()', 'composerRef?.refreshCtx()', 'composerRef?.clearMention()', 'composerRef?.focusInput()', 'composerRef?.openModelMenu()', 'composerRef?.closeMenus()']) {
    assert.ok(appCode.includes(call), `App 缺薄桥调用 ${call}`)
  }
  // ref API 必须真在组件里导出
  for (const api of ['exportfunctionfocusInput()', 'exportfunctionopenModelMenu()', 'exportfunctioncloseMenus()', 'exportfunctionclearMention()', 'exportfunctionrefreshCtx()', 'exportfunctionreloadPrefs()']) {
    assert.ok(composerCode.includes(api), `Composer 缺导出 API ${api}`)
  }
})

test('setMode 桥：App 保留无菜单态副作用的最小桥，组件版含菜单态', () => {
  const bridge = functionBodyOf(appRaw, 'setMode')
  assert.ok(bridge.includes('if(!mode)return'), 'setMode 桥缺空 mode 早退')
  assert.ok(bridge.includes('ensureActiveId()'), 'setMode 桥缺 ensureActiveId')
  assert.ok(bridge.includes('remember(id,{mode})'), 'setMode 桥缺 remember')
  assert.ok(bridge.includes('!sidecarReady||!sessions.some((item)=>item.id===id&&item.file)'), 'setMode 桥缺会话文件早退守卫')
  assert.ok(bridge.includes("awaitrequest('set_mode',{sessionId:id,mode})"), 'setMode 桥缺 set_mode RPC')
  assert.equal(bridge.includes('modeOpen=false'), false, 'App 桥不得残留菜单态（modeOpen 归组件）')
  const local = functionBodyOf(composerRaw, 'setMode')
  assert.ok(local.includes('modeOpen=false'), 'Composer setMode 必须先收菜单')
})

test('组件数据通道：五类 RPC 全走 request/requestRaw，无旁路 sendRequest', () => {
  assert.ok(composerCode.includes("request('set_mode',"), 'Composer 缺 set_mode 通道')
  assert.ok(composerCode.includes("request('set_model',"), 'Composer 缺 set_model 通道')
  assert.ok(composerCode.includes("request('set_thinking',"), 'Composer 缺 set_thinking 通道')
  assert.ok(composerCode.includes("request('generate_image',"), 'Composer 缺 generate_image 通道')
  assert.ok(composerCode.includes("requestRaw('provider_quotas'"), 'Composer 缺 provider_quotas 通道')
  assert.ok(composerCode.includes("requestRaw('get_state'"), 'Composer 缺 get_state 通道')
  assert.ok(composerCode.includes("requestRaw('read_attachment'"), 'Composer 缺 read_attachment 通道')
  assert.equal(composerCode.includes('sendRequest'), false, 'Composer 不得私接 sendRequest（数据通道必须经 props）')
  assert.ok(composerCode.includes('if(!response.ok||activeSessionId!==id)'), 'get_state 快照缺会话守卫（异步竞态丢弃）')
  // App 侧保证只发一次 sendRequest：request/requestRaw 是唯一桥
  const requestFn = functionBodyOf(appRaw, 'request')
  assert.ok(requestFn.includes('sendRequest(type,payload)'), 'App request 必须包 sendRequest')
})

test('组件函数落位：抽走的家族在 Composer、App 零残留', () => {
  const moved = ['refreshCtxStats', 'refreshQuotas', 'toggleModel', 'setModel', 'pickModel', 'setThinking', 'toggleCtx', 'toggleThinking', 'toggleMode', 'toggleKind', 'addAttachments', 'handleClipboardPaste', 'removeAttachment', 'generateImage', 'refreshMention', 'applyMention', 'handleKeydown']
  for (const name of moved) {
    assert.ok(functionBodyOf(composerRaw, name).length > 0, `Composer 缺抽走函数 ${name}`)
  }
  const ghosts = ['refreshCtxStats', 'refreshQuotas', 'applyMention', 'handleKeydown', 'addAttachments', 'handleClipboardPaste', 'generateImage', 'mentionList', 'ctxProgress', 'ctxDash', 'fmtWan', 'CTX_CIRC', 'EMPTY_CTX', 'hiddenProviders', 'collapsedModelProviders', 'modelQuery', 'ctxStats', 'thinkingDraft', 'imageGenMode', 'imageGenBusy', 'composerInput', 'modelSearchInput', 'providerCollapsed', 'toggleModelProvider']
  for (const name of ghosts) {
    assert.equal(appCode.includes(name), false, `App 残留搬走标识符 ${name}`)
  }
  // App 只保留 runSlashCommand 需要的 findSlashCommand（slash-commands 导入收缩）
  assert.ok(appCode.includes("import{findSlashCommand}from'./slash-commands'"), 'App 应收缩为仅导入 findSlashCommand')
  assert.equal(appCode.includes('filterSlashCommands'), false, 'App 不得导入 filterSlashCommands')
  assert.equal(appCode.includes('slashTriggerQuery'), false, 'App 不得导入 slashTriggerQuery')
  assert.equal(appCode.includes('SLASH_COMMANDS'), false, 'App 不得导入 SLASH_COMMANDS')
})

test('回调归属：submit/stop/runSlashCommand 是 props 而非组件内重定义', () => {
  for (const prop of ['exportletsubmit', 'exportletstop', 'exportletrunSlashCommand']) {
    assert.ok(composerCode.includes(prop), `Composer 缺回调 prop ${prop.replace('exportlet', '')}`)
  }
  assert.equal(composerCode.includes('functionsubmit('), false, 'Composer 不得重定义 submit')
  // App 侧 submit 仍完整存在且消费 bind 来的 inputText/attachments
  const submitBody = functionBodyOf(appRaw, 'submit')
  assert.ok(submitBody.includes('composerRef?.clearMention()'), 'App submit 分支缺 clearMention 薄桥')
  assert.ok(submitBody.includes('findSlashCommand('), 'App submit 缺斜杠命令分发')
  const dispatchBody = functionBodyOf(appRaw, 'dispatchTurn')
  assert.ok(dispatchBody.includes('constpendingFiles=attachments'), 'dispatchTurn 必须先取走 bind 的 attachments')
  assert.ok(dispatchBody.includes('attachments=[]'), 'dispatchTurn 必须清空附件队列')
})

test('审查修补：ref API 函数体非空壳 + 组件侧守卫 + 魔法数字锚（对抗审查 27 变异后）', () => {
  // M21：clearMention 必须真复位 mention
  const clearBody = functionBodyOf(composerRaw, 'clearMention')
  assert.ok(clearBody.includes('mention=null'), 'clearMention 必须复位 mention（M21）')
  // M18：reloadPrefs 必须真刷新两处偏好
  const reloadBody = functionBodyOf(composerRaw, 'reloadPrefs')
  assert.ok(reloadBody.includes('loadHiddenProviders()'), 'reloadPrefs 必须刷新 hiddenProviders（M18）')
  assert.ok(reloadBody.includes('loadCollapsedModelProviders()'), 'reloadPrefs 必须刷新 collapsedModelProviders（M18）')
  // M6b：Composer 侧 setMode 必须保留会话文件守卫（App 桥之外的第二端）
  const compSetMode = functionBodyOf(composerRaw, 'setMode')
  assert.ok(compSetMode.includes('modeOpen=false'), 'Composer setMode 必须先收菜单')
  assert.ok(compSetMode.includes('!sidecarReady||!sessions.some((item)=>item.id===id&&item.file)'), 'Composer setMode 缺会话文件守卫（M6b）')
  // M20：mention 预填必须只替换尾部 @token
  assert.ok(composerCode.includes('replace(/@[^\\s]*$/,'), 'mention 预填必须只替换尾部 @token（M20）')
  // M16/M17：魔法数字阈值锚
  assert.ok(composerCode.includes('20*1024*1024'), '粘贴阈值 20MB 锚（M16）')
  assert.ok(composerCode.includes('window.innerHeight-rect.bottom<320'), 'ctxMenuUp 阈值 320 锚（M17）')
  // M19：挂载行必须传真实 workspacePath，不得传字面量
  assert.ok(appCode.includes('workspacePath={workspacePath}'), 'App 必须传真实 workspacePath（M19）')
  assert.equal(appCode.includes("workspacePath={'.')}"), false, 'App 不得传 workspacePath 字面量（M19）')
})
