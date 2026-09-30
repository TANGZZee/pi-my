// 会话 teardown 顺序的行为单测（审查 D1 + T1）
//
// 这是本仓库第一处**真正能测出顺序**的测试。背景：
//   `session-wiring.test.mjs` 用"去注释 + 压空白后的源码文本存在性正则"断言
//   release 调用存在，变异 M5（把 release 移到 abort() **之后** —— 即恢复成
//   会造成永久死锁的写法）仍然 20 pass / 0 fail。它对顺序完全盲。
//
//   D1 的机理（源码级，已在 sidecar/session-teardown.mjs 文件头完整记录）：
//   SDK `abort()` 末尾 `await this.waitForIdle()`，而 waitForIdle 只在
//   `_emitAgentSettled()` 的 finally（agent-session.js:347-356）里 resolve。
//   若有一个 `beforeToolCall` 正 await 权限确认，`_isAgentRunActive` 恒 true
//   ⇒ abort() 永不 settle。所以放行必须在 abort() **之前**。
//
// 测试手法：给一个"只有确认被放行后才 resolve"的 abort 桩（忠实地模拟 SDK），
// 若实现把放行写在 abort() 之后，这个 await 会永远挂住 → 断言直接失败/超时。
import test from 'node:test'
import assert from 'node:assert/strict'
import { teardownSession, cancelSessionInteractions } from '../sidecar/session-teardown.mjs'

/**
 * 造一个忠实模拟 SDK 的假会话：
 *   - 有一个"正在等待权限确认"的 beforeToolCall（= 未放行时 runActive 恒 true）
 *   - abort() 只有在该确认被放行之后才可能 settle（waitForIdle 语义）
 * 返回的记录器让测试能断言**调用顺序**与是否真的完成了 abort。
 *
 * `abortTimeoutMs` 是**刻意的设计**（审查者 review-correctness 的报告）：
 * 最初 abort() 用 `while (runActive) await Promise.race([..., setImmediate])` 死转，
 * 忠实于"永不返回"，但代价是顺序回归时 `node --test` **整文件挂死**
 * （实测该文件 133085ms 后以文件级 ✖ 收场，CI 白卡两分多钟），而不是立刻报红。
 * 现在改为**有界等待**：超时即抛出带原因的错误 ⇒ 顺序写反会得到一条明确的失败
 * 断言（"abort() 超时：权限确认未被放行"），而不是一次静默挂起。
 * 传 `abortTimeoutMs: 0` 表示"永不 settle"，仅用于反向对照实验。
 */
function makeFakeSdkSession({ abortTimeoutMs = 1000 } = {}) {
  let confirmResolve
  let runActive = true
  const confirmPending = new Promise((resolve) => { confirmResolve = resolve })
  const calls = []
  return {
    calls,
    get runActive() { return runActive },
    get confirmSettled() { return !runActive },
    /** 模拟扩展里 `await options.confirm(...)`：没被放行就不返回 */
    waitForConfirm() {
      return confirmPending.then(() => { runActive = false })
    },
    /** 模拟 sidecar 的 releaseSessionConfirms：解开那个 await */
    release() {
      calls.push('release')
      if (runActive) queueMicrotask(() => confirmResolve(false))
    },
    drainDialogs(reason) { calls.push(`drain:${reason}`) },
    async abort() {
      calls.push('abort')
      // waitForIdle 语义：runActive 仍为 true 时不返回（唯一 resolve 点是
      // _emitAgentSettled 的 finally）。有界等待，避免回归时静默挂死整个测试进程。
      if (!runActive) { calls.push('abort-settled'); return }
      const outcome = await Promise.race([
        confirmPending.then(() => 'released'),
        abortTimeoutMs > 0
          ? new Promise((resolve) => setTimeout(() => resolve('timeout'), abortTimeoutMs))
          : new Promise(() => {}),
      ])
      if (outcome === 'timeout') {
        throw new Error('abort() 超时：权限确认未被放行 —— 放行写在 abort() 之后了（D1 顺序回归）')
      }
      calls.push('abort-settled')
    },
    unsubscribe() { calls.push('unsubscribe') },
  }
}

test('D1：teardownSession 必须在 abort() **之前**放行确认，否则 abort 永久挂住', async () => {
  const sdk = makeFakeSdkSession()
  // 让"扩展正在等确认"这件事真实发生
  const pendingTurn = sdk.waitForConfirm()
  const forgets = []

  // 若实现把 release 写在 abort 之后，这个 await 永远不返回 → 测试超时失败。
  await teardownSession({
    id: 's1',
    reason: '关闭会话 s1',
    releaseConfirms: () => sdk.release(),
    drainDialogs: (reason) => sdk.drainDialogs(reason),
    abort: () => sdk.abort(),
    unsubscribe: () => sdk.unsubscribe(),
    forget: (id) => forgets.push(id),
  })

  assert.deepEqual(sdk.calls, ['release', 'drain:关闭会话 s1', 'abort', 'abort-settled', 'unsubscribe'],
    '顺序必须是 放行 → 取消对话框 → abort → 退订')
  assert.deepEqual(forgets, ['s1'], '最后必须把会话从表里移除')
  assert.equal(sdk.confirmSettled, true, '放行必须真的解开扩展的 await')
  await pendingTurn // 挂起的工具调用必须能正常收尾，不能泄漏
})

test('D1：放行晚于 abort() 的写法会真的卡住放行（反向对照，证明测试不是空转）', async () => {
  // 反向对照必须让 abort() **真的永不 settle**（abortTimeoutMs: 0），
  // 否则测的是"超时后抛错"而不是"卡死"这件事本身。
  const sdk = makeFakeSdkSession({ abortTimeoutMs: 0 })
  const pendingTurn = sdk.waitForConfirm()
  // 复刻 D1 的错误顺序
  const wrongOrder = (async () => {
    await sdk.abort()          // ← 此时 runActive 仍为 true，永不返回
    sdk.release()              // ← 永远执行不到
  })()

  const raced = await Promise.race([
    wrongOrder.then(() => 'completed'),
    new Promise((resolve) => setTimeout(() => resolve('deadlocked'), 120)),
  ])
  assert.equal(raced, 'deadlocked', '错误顺序必须可复现地卡住 —— 否则本测试证明不了任何事')
  assert.deepEqual(sdk.calls, ['abort'], '错误顺序下 release 与后续步骤都到不了')
  // 收尾：放行让挂起的 promise 结束，避免测试进程挂着句柄
  sdk.release()
  await pendingTurn
})

test('D1：顺序写反时 abort() 必须是**有界**失败，而不是挂死整个测试进程', async () => {
  // 这是审查者 review-correctness 报的问题：早期桩里 abort() 死转，
  // 顺序回归会让 node --test 挂 133 秒才以文件级 ✖ 收场。
  // 现在改为有界等待 + 明确报错，回归会得到一条干净的失败。
  const sdk = makeFakeSdkSession({ abortTimeoutMs: 60 })
  const pendingTurn = sdk.waitForConfirm()
  const started = Date.now()
  const outcome = await Promise.race([
    sdk.abort().then(() => ({ kind: 'settled' }), (error) => ({ kind: 'threw', error })),
    new Promise((resolve) => setTimeout(() => resolve({ kind: 'hung' }), 2000)),
  ])
  const elapsed = Date.now() - started
  assert.equal(outcome.kind, 'threw', '顺序写反时 abort() 必须有界地抛错，而不是挂死测试进程')
  assert.match(outcome.error.message, /超时/, '错误信息必须点明"权限确认未被放行"这种可诊断的原因')
  assert.ok(elapsed < 1500, `必须在超时后很快结束，实测 ${elapsed}ms（旧的死转写法会挂到框架级超时）`)
  // 收尾
  sdk.release()
  await pendingTurn
})

test('D1：cancelSessionInteractions 同样先放行再 abort，且只动本会话', async () => {
  const sdkA = makeFakeSdkSession()
  const sdkB = makeFakeSdkSession()
  const turnA = sdkA.waitForConfirm()
  const turnB = sdkB.waitForConfirm()

  await cancelSessionInteractions({
    sessionId: 'sA',
    reason: '用户中止',
    releaseConfirms: (sid) => { assert.equal(sid, 'sA', '必须只传本会话 id'); sdkA.release() },
    drainDialogs: (reason, sid) => { assert.equal(sid, 'sA'); sdkA.drainDialogs(reason) },
    abort: () => sdkA.abort(),
  })

  assert.deepEqual(sdkA.calls, ['release', 'drain:用户中止', 'abort', 'abort-settled'])
  assert.deepEqual(sdkB.calls, [], 'sB 的确认/对话框一丝都不能被碰（缺陷 #5）')
  assert.equal(sdkB.confirmSettled, false, 'sB 仍在等它的确认')

  // 收尾
  sdkB.release()
  await Promise.all([turnA, turnB])
})

test('D1：abort 抛错不得阻断后续清理', async () => {
  const forgets = []
  await assert.doesNotReject(() => teardownSession({
    id: 's1',
    reason: '关闭会话 s1',
    releaseConfirms: () => {},
    drainDialogs: () => {},
    abort: async () => { throw new Error('SDK abort 内部崩了') },
    unsubscribe: () => {},
    forget: (id) => forgets.push(id),
  }))
  assert.deepEqual(forgets, ['s1'], 'abort 抛错后仍必须把会话从表里移除，否则泄漏')
})

test('D1：unsubscribe 抛错不得阻断会话移除', async () => {
  const forgets = []
  await assert.doesNotReject(() => teardownSession({
    id: 's1',
    releaseConfirms: () => {},
    drainDialogs: () => {},
    abort: async () => {},
    unsubscribe: () => { throw new Error('退订崩了') },
    forget: (id) => forgets.push(id),
  }))
  assert.deepEqual(forgets, ['s1'])
})

test('D1：所有可选回调缺省时不抛错（防空引用）', async () => {
  await assert.doesNotReject(() => teardownSession({ id: 's1' }))
  await assert.doesNotReject(() => cancelSessionInteractions({ sessionId: 's1' }))
})
