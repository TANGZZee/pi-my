/**
 * F4（终态兜底仲裁器）与 F2（插话看门狗）的**接线锁**。
 *
 * 为什么需要单独一个文件：第三轮对抗性审查（探针目录 pimy-review-jp87tdgk，12 条变异
 * 4 KILLED / 8 SURVIVED）实测，App.svelte 侧的四处接线变异在 provider-error-wiring +
 * session-wiring 的 61 条断言全绿的情况下**全部存活**：
 *   A2b  删掉 clearProviderError 里的 settleArbiter.cancel(id)          → 61/61 全绿
 *   A5b  删掉 steer 分支的 touchRunWatchdog(id)                          → 61/61 全绿
 *   A6b  删掉 onFire 里的 `if (!slotFor(id).running) return` 守卫        → 61/61 全绿
 *   A11  把事件入口的 settleArbiter.cancel(id) 挪到事件分派之后          → 61/61 全绿
 * 即：兜底仲裁器与插话看门狗在组件里"接了线但零锁定"，删掉任何一处都无人发现 ——
 * 这正是"修复看起来在、其实早就没了"的经典形态。本文件用与既有接线测试同一套
 * 形状 / 字面量来源闸门，把这几处以及 F1 的早退分支一起钉死。
 *
 * 变异复验（PI/.tmp-settle-mut.mjs，沙箱 %TEMP%\pimy-settle-mut，绝不改真实源码）：
 * 11 条接线变异 A1/A2b/A3/A4/A5b/A6b/A7/A8/A9/A11/N-clean → 11/11 KILLED，未变异对照组全绿。
 *
 * 过程中发现并修掉了 helper 的签名缺陷（否则本文件自己也是纸糊的）：
 * source-assert.mjs 的 indexOfCode 原签名是 `(shape, literal, needle)`，**没有 start 形参**，
 * 于是调用方多传的第 4 个实参被 JS 静默丢弃 —— "从事件入口往后找"退化成"全文件找"，
 * 命中的是 clearProviderError 里的 cancel（App.svelte:552）而不是事件入口的（:1862），
 * cancelAt < firstStashAt 恒真 ⇒ A3/A11 存活。同一缺陷当时也存在于
 * provider-error-wiring.test.mjs 的看门狗断言。现已改为 `start = 0` 可选形参。
 *
 * 单跑：node --test tests/run-settle-wiring.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import {
  functionBodyCodeOf,
  indexOfCode,
  shapeWithLiteralMask,
  squash,
  stripComments,
} from './helpers/source-assert.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const rawSource = readFileSync(path.join(here, '..', 'src', 'App.svelte'), 'utf8')
const appSource = stripComments(rawSource)
const { shape: appShape, literal: appLiteral } = shapeWithLiteralMask(rawSource)
// 函数体的**代码视图**（字符串/模板字面量内容被抹成等长空白）。凡是"必须存在某次调用"
// 这类断言都得用它：用 squash 版时，函数体里插一行 `const __decoy = 'settleArbiter.cancel(id)'`
// 就能把删掉真实调用的变异救活（第二轮审计已在 dispatchTurn 上实测过同形绕过）。
const functionCode = (name) => functionBodyCodeOf(appSource, name)
// 内容视图：注释已剥、字符串/模板内容**保留**、去空白。
// 为什么需要第二个视图：shapeWithLiteralMask 把模板字面量整段（含 `${…}` 插值）
// 都标成"来自字面量"，于是"onFire 里到底插值了什么"这类**内容**断言在 appShape 上
// 永远看不到 —— 第四轮审查的 M13（把 onFire 的文案换成纯 SETTLE_FALLBACK_TEXT、
// 丢掉真实 provider 原因）正是靠这一盲区存活的。块定界仍用形状视图。
const appContent = squash(appSource)

/**
 * 取 `callee(` 的实参文本（含外层括号），在内容视图上做、并真正配平圆括号。
 * 比"找第一个 { 再配平"更精确：调用点之前插入任何同名诱饵都不会带偏。
 */
function callArgsOf(text, callee) {
  const at = text.indexOf(`${callee}(`)
  assert.notEqual(at, -1, `找不到 ${callee}( 调用`)
  const open = at + callee.length
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return text.slice(open, i + 1)
    }
  }
  throw new Error(`${callee}( 的圆括号未配平`)
}

/**
 * 从 `openAt`（必须指向一个非字面量 `{`）起做花括号配平，返回 [start, end) 区间。
 *
 * 为什么不复用固定字符窗口：D3/D4 的教训是固定窗口要么因一行新语句假失败，要么因
 * 余量太大而形同虚设。这里改成真正的配平 —— 分支内部随便增删语句都不影响定界，
 * 而把语句挪出分支则会立刻暴露。
 *
 * 模板字面量的 `${…}` 里的花括号同样被 shapeWithLiteralMask 标成字面量来源，
 * 因此 `literal[i]` 为真的字符一律跳过，不会被插值表达式里的括号带偏。
 */
function braceBlockAt(shape, literal, openAt) {
  assert.equal(shape[openAt], '{', `偏移 ${openAt} 处不是 {`)
  let depth = 0
  for (let i = openAt; i < shape.length; i += 1) {
    if (literal[i]) continue
    const ch = shape[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return [openAt, i + 1]
    }
  }
  throw new Error(`从偏移 ${openAt} 起花括号未配平`)
}

/** 定位 needle（必须命中真实代码）后，取紧随其后的 `{` 所在花括号块。 */
function blockAfter(needle) {
  const at = indexOfCode(appShape, appLiteral, needle)
  assert.notEqual(at, -1, `源码里找不到真实代码形状：${needle}`)
  const openAt = appShape.indexOf('{', at)
  assert.notEqual(openAt, -1, `${needle} 之后没有花括号块`)
  const [start, end] = braceBlockAt(appShape, appLiteral, openAt)
  return appShape.slice(start, end)
}

/** 取形状视图上 `openAt`（指向 `(`）起配平的一对圆括号之间的文本（不含外层括号）。 */
function argListAt(openAt) {
  assert.equal(appShape[openAt], '(', `偏移 ${openAt} 处不是 (`)
  let depth = 0
  for (let i = openAt; i < appShape.length; i += 1) {
    if (appLiteral[i]) continue
    const ch = appShape[i]
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return appShape.slice(openAt + 1, i)
    }
  }
  throw new Error(`从偏移 ${openAt} 起圆括号未配平`)
}

/** 去掉最外层成对的圆括号（可重复），并去空白。 */
function unwrapParens(text) {
  let out = text.trim()
  for (;;) {
    if (!out.startsWith('(') || !out.endsWith(')')) return out
    let depth = 0
    let balanced = true
    for (let i = 0; i < out.length; i += 1) {
      if (out[i] === '(') depth += 1
      else if (out[i] === ')') {
        depth -= 1
        if (depth === 0 && i !== out.length - 1) {
          balanced = false
          break
        }
      }
    }
    if (!balanced) return out
    out = out.slice(1, -1).trim()
  }
}

/**
 * 把闸门第二个实参归一化成"去掉冗余括号与成对 `!!`"的形态，再比对字面文本。
 *
 * 这个函数**只接受下面这几种语义等价的写法**，其余一律判为不通过：
 *   接受：`runEpoch.isAborted(id)` / `(runEpoch.isAborted(id))` / `!!runEpoch.isAborted(id)`
 *         / `!!((runEpoch.isAborted(id)))`（`!!` 对布尔值是恒等）
 *   拒绝：`true` / `false`（常量，闸门被关掉）、`(!runEpoch.isAborted(id), true)`
 *         （逗号运算符取右值，闸门被关掉）、`(!runEpoch.isAborted(id) || true)`
 *         （短路，闸门被关掉）、`'runEpoch.isAborted(id)'`（字符串诱饵：引号使比对不相等）
 *
 * ⚠️ 这仍是**语法**判定，只是把"哪些写法算等价"写死并配自检（见下一个 test）。
 * 真正的语义防线是 run-slot.test.mjs 里 shouldSurfaceProviderError 的真值表。
 */
function normalizeGateArg(text) {
  let out = unwrapParens(text)
  for (;;) {
    const next = unwrapParens(out.replace(/^!!/, ''))
    if (next === out) return out
    out = next
  }
}

/**
 * 取 `callee(` 调用里位于最外层逗号之后的实参文本（形状视图切片，含字面量原文）。
 * `openAt` 必须是 `(` 本身在形状视图里的偏移。
 */
function lastArgOf(openAt) {
  const args = argListAt(openAt)
  let depth = 0
  let splitAt = -1
  for (let i = 0; i < args.length; i += 1) {
    const ch = args[i]
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1
    else if (ch === ',' && depth === 0) splitAt = i
  }
  return splitAt < 0 ? '' : args.slice(splitAt + 1)
}

/**
 * 断言「这一段里真的调用了错误展示闸门 `shouldSurfaceProviderError(…)` 且第二个实参
 * 由真实的中止标记推出」。
 *
 * 为什么不再用"正则匹配块内文本"（第五/六/九轮审查实测，原实现两个方向都错）：
 *   - 漏：块内插一行 `const __d = '!runEpoch.isAborted(id)'` 这类**字面量诱饵**就能让
 *     正则命中，闸门实际已被删或短路 —— W1–W8 共 8 条写法 26/26 全绿；
 *   - 误杀：`isAborted(id) === false`、`!(isAborted(id) === true)` 这类**语义完全正确**
 *     的等价改写被 `(?![^()]*\|\|)` 这个纯语法特征判死 —— E1/E2/X2 实测 KILLED。
 *   根因是"用语法特征判语义"走不通。于是分工改为：
 *   - 语义（真值表）在 tests/run-slot.test.mjs 直接单测纯函数 shouldSurfaceProviderError；
 *   - 这里只验接线：闸门调用**真实存在**于该分支内，且第二个实参不是常量/逗号取值。
 *   定位全部通过 indexOfCode + 逐字符字面量来源掩码完成，与形状视图同一坐标系，
 *   因此既能被真配平的块定界约束（挪出分支会立刻暴露），又不会被字面量诱饵骗过。
 */
function assertGateCall(start, end, where) {
  const CALLEE = 'shouldSurfaceProviderError'
  const gateAt = indexOfCode(appShape, appLiteral, `${CALLEE}(`, start)
  assert.ok(
    gateAt !== -1 && gateAt < end,
    `${where} 不再经过 shouldSurfaceProviderError 闸门（D1 修复被回退）：上游取消文案一变，` +
      '用户主动 Stop 的那一轮就会在 8 秒后经兜底仲裁器弹出假"请求失败"',
  )
  const rawArg = lastArgOf(gateAt + CALLEE.length)
  const abortedArg = normalizeGateArg(rawArg)
  assert.equal(
    abortedArg,
    'runEpoch.isAborted(id)',
    `${where} 调用闸门时第二个实参不是真实的中止标记，而是「${abortedArg}」：` +
      '写成常量（true/false）或用逗号运算符取值，等于把"用户主动 Stop 不该报错"这道闸门关掉；' +
      '注意命中必须落在真实代码里，字符串/注释里的同形文本不算数',
  )
}

/** 用真配平定界取 needle（必须命中真实代码形状）后的花括号块，返回 [start, end)。 */
function blockRangeAfter(needle) {
  const at = indexOfCode(appShape, appLiteral, needle)
  assert.notEqual(at, -1, `源码里找不到真实代码形状：${needle}`)
  const openAt = appShape.indexOf('{', at)
  assert.notEqual(openAt, -1, `${needle} 之后没有花括号块`)
  return braceBlockAt(appShape, appLiteral, openAt)
}

test('接线自检：braceBlockAt 必须真的做配平（否则本文件退化成固定窗口断言）', () => {
  const flat = [false, false, false, false, false]
  assert.deepEqual(braceBlockAt('{a}', flat, 0), [0, 3])
  assert.deepEqual(braceBlockAt('{a{b}c}', flat, 0), [0, 7])
  assert.throws(() => braceBlockAt('{a{b}', flat, 0), /未配平/, '括号不配平时必须抛错而不是返回半截')
  // 字面量里的花括号不算：`{ "}" }` 应当在第 3 位收尾，而不是被字符串里的 } 提前结束
  const withLit = [false, true, true, true, false]
  assert.deepEqual(braceBlockAt('{"}"}', withLit, 0), [0, 5])
})

test('接线自检：闸门实参归一化必须"接受等价改写、拒绝闸门失效形态"', () => {
  // 背景：第五/六/九轮审查实测，原「正则匹配块内文本」的写法对下面两组一视同仁，
  // 结果是**漏**（恒真形态放行）与**误杀**（等价改写判死）同时发生。
  // 归一化只需认准"第二个实参确由 runEpoch.isAborted(id) 推出"，其余交给
  // run-slot.test.mjs 的真值表。下面是这两组的最小对照，改动本文件时必须同步维护。
  for (const accepted of [
    'runEpoch.isAborted(id)',
    ' runEpoch.isAborted(id) ',
    '(runEpoch.isAborted(id))',
    '((runEpoch.isAborted(id)))',
    '!!runEpoch.isAborted(id)',
    '!!(runEpoch.isAborted(id))',
  ]) {
    assert.equal(normalizeGateArg(accepted), 'runEpoch.isAborted(id)', `应当接受等价写法：${accepted}`)
  }
  for (const rejected of [
    'true',
    'false',
    "'runEpoch.isAborted(id)'",
    '(!runEpoch.isAborted(id), true)',
    '(!runEpoch.isAborted(id) ? true : true)',
    '(void !runEpoch.isAborted(id), true)',
    '(String(!runEpoch.isAborted(id)), true)',
    'false || !runEpoch.isAborted(id)',
  ]) {
    assert.notEqual(normalizeGateArg(rejected), 'runEpoch.isAborted(id)', `必须拒绝闸门失效写法：${rejected}`)
  }
})

test('接线：setProviderError 必须武装兜底计时器（F4 的唯一漏斗）', () => {
  const body = functionCode('setProviderError')
  assert.match(
    body,
    /settleArbiter\.arm\(id,raw\)/,
    'setProviderError 不再武装兜底计时器：终态事件一旦丢失，界面就会重新变回永久 Thinking 且不报错',
  )
})

test('接线：clearProviderError 必须撤销兜底计时器（A2b 存活变异）', () => {
  // 所有收尾路径（finishRun / stop / teardownRun / abortRunningRuns / type:'error'）都经此函数，
  // 撤销点挂在这里才能天然完整；删掉它，一次已收尾的运行之后计时器仍会开火。
  const body = functionCode('clearProviderError')
  assert.match(
    body,
    /settleArbiter\.cancel\(id\)/,
    'clearProviderError 不再撤销兜底计时器（A2b）：收尾后计时器仍会开火，把已结束的会话再"报错"一次',
  )
})

test('接线：onFire 必须有 running 守卫，绝不复活已收尾的槽位（A6b 存活变异）', () => {
  // 计时器回调可能与真正的终态事件在同一轮事件循环里排队，撤销调用已经来不及了，
  // 只能靠 running 判定谁先到。删掉守卫 ⇒ 正常结束的会话会被兜底文案二次收尾。
  //
  // 断言写成"取反形态"而不是一整串精确形状：`if (!slotFor(id).running) return` 与
  // `if (slotFor(id).running === false) return` 语义完全等价，后者若被当成变异杀死，
  // 就成了"合法重构被断言判死"的假故障（EQ1 等价对照变异专门守这一条）。
  const block = blockAfter('onFire:(id,raw)=>{')
  const guards = [
    /if\(!slotFor\(id\)\.running\)return/,
    /if\(slotFor\(id\)\.running===false\)return/,
  ]
  assert.ok(
    guards.some((pattern) => pattern.test(block)),
    'onFire 丢掉了 running 守卫（A6b）：兜底计时器会覆盖掉真正的终态结果',
  )
  assert.match(block, /finishRun\(id,/, 'onFire 不再收尾，兜底仲裁器形同虚设')
})

test('接线：事件入口的兜底撤销必须早于事件分派（A11 存活变异）', () => {
  // 关键在位置：放在分派**之前**，才能保证 auto_retry_start（SDK 先发事件再睡退避）
  // 与 compaction_start（压缩期间的长静默）都会自动解除兜底，不被误判成"终态事件丢了"。
  // 挪到分派之后 ⇒ 那些事件已经重新武装过计时器，正常重试会被误报成失败。
  const start = appShape.indexOf('constid=payload.sessionId||activeSessionId')
  assert.ok(start > 0, '找不到事件归约入口')
  const cancelAt = indexOfCode(appShape, appLiteral, 'settleArbiter.cancel(id)', start)
  assert.notEqual(cancelAt, -1, '事件入口没有撤销兜底计时器：任何一条事件都无法解除兜底')
  const firstStashAt = indexOfCode(appShape, appLiteral, 'setProviderError(id,assistantErrorFrom(event.message))', start)
  assert.notEqual(firstStashAt, -1, '找不到 message_end/turn_end 的暂存点作为位置基准')
  assert.ok(
    cancelAt < firstStashAt,
    '事件入口的 settleArbiter.cancel(id) 被挪到了事件分派之后（A11）：' +
      'auto_retry_start / compaction_start 会被当成"终态事件丢失"而误报失败',
  )
})

test('接线：组件销毁必须撤销全部兜底计时器（防止向已销毁组件写槽位）', () => {
  const block = blockAfter('onDestroy(()=>{')
  assert.match(
    block,
    /settleArbiter\.cancelAll\(\)/,
    'onDestroy 未撤销兜底计时器：回调会在已销毁的组件上跑 finishRun，' +
      '往 runState 写回一个永不渲染的槽位，还可能触发一次 desktopNotify',
  )
})

test('接线：插话（steer）分支必须武装看门狗（A5b 存活变异）', () => {
  // 插话是新一轮模型调用，但这条分支既不走 dispatchTurn（唯一另一个武装点）也不碰 running，
  // 于是整条插话路径上原先没有任何超时兜底 —— 终态事件丢失就永远停在 Thinking。
  const block = blockAfter("if(slot.running&&behavior==='steer'){")
  assert.match(
    block,
    /touchRunWatchdog\(id\)/,
    'steer 分支不再武装看门狗（A5b）：插话期间终态事件丢失会永久停在 Thinking，且 180s 后也无人兜底',
  )
  assert.match(
    block,
    /request\('prompt',/,
    'steer 分支不再真正发出插话请求（本断言用于确认取到的是插话分支本身，而非同名诱饵）',
  )
})

test('接线：finishRun 的早退分支必须把错误写回槽位（F1 修复不得回退）', () => {
  // 调用方是在拿到终态事件时先 consumeProviderError 把暂存取走再传进来的；若早退分支
  // 直接 return，那段文本就凭空消失 —— 用户看到的就是"永久 Thinking 且不报错"。
  //
  // 这里取「早退分支块」再分别断言三件事，而不是匹配一整串精确形状：D3/D4 的教训是
  // 精确形状会把合法改动（加一行日志、调整顺序）变成假失败，进而逼人删断言。
  const block = blockAfter('if(!current.running&&!current.activeTurnId){')
  assert.match(
    block,
    /patchSlot\(id,\{error:errorMessage\}\)/,
    'finishRun 早退分支不再把错误写回槽位（A4）：迟到的失败终态会被静默吞掉，用户只看到永久 Thinking',
  )
  assert.match(
    block,
    /clearProviderError\(id\)/,
    'finishRun 早退分支不再清暂存（A7）：这段错误会污染下一个回合',
  )
  assert.match(block, /return/, 'finishRun 早退分支必须仍然提前返回，否则会重跑整段收尾逻辑')
})

test('接线：onFire 必须同时带上真实原因与兜底文案（M13 存活变异）', () => {
  // 只用形状视图会漏掉这一条：模板字面量整段（含 `${…}`）都被抹成"来自字面量"，
  // 于是换成纯 SETTLE_FALLBACK_TEXT（丢掉 402/404 这些真正的原因）也能全绿 ——
  // 用户就只看到"事件链可能中断"而不知道到底为什么失败，等于把根因又藏回去了。
  const args = callArgsOf(appContent, 'createSettleArbiter')
  assert.ok(
    args.includes('${describeProviderError(raw)}'),
    'onFire 丢掉了 provider 真实原因（只剩兜底文案）：用户看不到 402/404 这类根因',
  )
  assert.ok(args.includes('${SETTLE_FALLBACK_TEXT}'), 'onFire 丢掉了兜底文案')
})

test('接线：用户主动 Stop 的那一轮绝不能经兜底仲裁器报错（D1 修复不得回退）', () => {
  // 第四轮审查 D1：auto_retry_end 的过滤原先只认 /^retry\s+cancel?led\.?$/i，
  // 而 SDK 0.99.1 恰好发 "Retry cancelled" ⇒ 现在不爆，属于**依赖上游文案字面量**的
  // 隐性契约。上游一改措辞，取消就会被当成 provider 故障：setProviderError → arm 武装
  // 兜底 → 槽位已 idle，唯一还能把它写出来的是 F1 的早退分支 → 8 秒后凭空弹"请求失败"。
  // 修法是叠加一道与文案无关的闸门：runEpoch.isAborted(id)（stop() 里 markAborted 打的）。
  const body = functionCode('setProviderError')
  assert.match(body, /settleArbiter\.arm\(id,raw\)/, '前置条件变了：setProviderError 不再武装仲裁器')

  // ① auto_retry_end 的暂存点必须同时检查 isAborted。
  // 用真配平定界而不是固定字符窗口：固定窗口要么因分支里多一行而假失败，要么余量太大
  // 把后面 `startedButAborted` / compaction 分支里的同形文本一并圈进来，从而在闸门被
  // 删掉时仍然"找得到"它 —— 那就又变成纸糊断言了（D3/D4 的教训）。
  const [retryStart, retryEnd] = blockRangeAfter("if(event.type==='auto_retry_end'){")
  assertGateCall(retryStart, retryEnd, 'auto_retry_end')
  assert.match(
    appShape.slice(retryStart, retryEnd),
    /isCancellationText\(finalError\)/,
    'auto_retry_end 丢掉了文案过滤这道闸门（两道必须同时在场）',
  )

  // ② F1 的早退写回也必须检查 isAborted，否则 D1 仍能从这条路漏出来。
  const [earlyStart, earlyEnd] = blockRangeAfter('if(!current.running&&!current.activeTurnId){')
  assertGateCall(earlyStart, earlyEnd, 'finishRun 早退分支')
})

test('接线：无会话归属的 sidecar 诊断不得被静默丢弃（D2 修复不得回退）', () => {
  // 第六轮审查 D2：Rust 读线程在"从未见过任何 sessionId"（刚启动就崩、用户清空全部会话）
  // 时发出的 `输出流结束` / `sidecar 已退出` 两条 error，原先在 `if (!id) return` 处被整条
  // 丢掉 —— 界面毫无反应，正是用户报障时最需要的信息。修法是至少落到 console.warn。
  const [start, end] = blockRangeAfter('if(!id){')
  // 必须用 indexOfCode（形状 + 字面量来源掩码）而不是对块文本 assert.match：
  // 块文本里字符串/模板字面量的内容原样保留，删掉真实调用、插一行
  // `const __decoy = 'console.warn('` 就能骗过文本匹配（DEC3 同形绕过）。
  const inBlock = (needle) => {
    const at = indexOfCode(appShape, appLiteral, needle, start)
    return at !== -1 && at < end
  }
  assert.ok(
    inBlock('console.warn('),
    '无会话归属的 sidecar 诊断被静默吞掉（D2 回退）：至少要在控制台留下痕迹（字符串里的同形文本不算数）',
  )
  assert.ok(inBlock('return'), '兜底分支必须提前返回，否则会继续用空 id 写槽位')
  // 反向断言（这条是实测事故的回归锁）：兜底分支里**不得**出现 `event.type === '…'`
  // 形式的筛选。它与归约器分支同形，会被 source-assert 的 eventConditionTypesOf 记进
  // 分支契约表、并让 eventBlockOf('error') 取到这个入口兜底块 —— 于是
  // session-wiring 的契约表与 provider-error-wiring 的 `type:"error" 必须先清暂存再收尾`
  // 两条断言都在**错误的块**上求值（实测：改这一处即让 npm run verify 红两条）。
  // 到达这里的只有读线程诊断本身，按类型筛选既无必要也牺牲可观测性。
  const homoglyphAt = indexOfCode(appShape, appLiteral, "event.type==='", start)
  assert.ok(
    homoglyphAt === -1 || homoglyphAt >= end,
    '无会话归属的兜底分支又用了 `event.type === …` 同形筛选：它会劫持归约器的分支契约表与 ' +
      'eventBlockOf("error")，让别的断言在错误的块上求值。这里直接打日志即可，不要按类型筛。',
  )
})

test('接线：兜底文案与仲裁器必须从 run-settle 纯模块导入（语义不得内联回组件）', () => {
  assert.match(
    appSource,
    /import\s*\{\s*createSettleArbiter\s*,\s*SETTLE_FALLBACK_TEXT\s*\}\s*from\s*'\.\/run-settle'/,
    '不再从 ./run-settle 导入仲裁器：兜底语义回到组件里就重新变成零覆盖（同 M11/M12 的教训）',
  )
  assert.match(
    appSource,
    /createSettleArbiter\(\{/,
    '导入的 createSettleArbiter 未被真正调用：接线断开的兜底等于没有兜底',
  )
})
