// 会话级权限确认放行单测（m04746 审计缺陷 D）
//
// 缺陷 D：closeSession / deleteSession / openSession 重建分支直接调
// `entry.session.abort()`（SDK 方法），绕过了 `abort` 请求处理函数里的确认清理，
// 导致扩展 await 的权限确认 Promise 永久悬挂 + 局域网遥控页残留"待确认"项。
import test from 'node:test'
import assert from 'node:assert/strict'
import { releaseAllConfirms, releaseSessionConfirm, forgetConfirm, lastConfirmOfSession } from '../sidecar/session-confirms.mjs'

/** 造一对相互关联的 map（模拟 sidecar 的真实结构）。 */
function makeStore() {
  const pendingConfirms = new Map()
  const pendingConfirmsBySession = new Map()
  const answered = []
  return {
    pendingConfirms,
    pendingConfirmsBySession,
    answered,
    /** 模拟 confirmBridge.requestConfirm（键/数组的归一化方式必须与 sidecar 一致） */
    request(sessionId, dialogId, toolName = 'bash') {
      pendingConfirms.set(dialogId, (ok) => answered.push({ dialogId, ok }))
      const sid = String(sessionId || '')
      const list = pendingConfirmsBySession.get(sid) || []
      list.push({ dialogId, toolName, summary: 'rm -rf' })
      pendingConfirmsBySession.set(sid, list)
    },
  }
}

test('D：放行指定会话的待决确认（resolve(false) 且两个 map 都清干净）', () => {
  const store = makeStore()
  store.request('s1', 'c1')
  const result = releaseSessionConfirm(store.pendingConfirms, store.pendingConfirmsBySession, 's1')
  assert.deepEqual(result, { released: ['c1'], resolved: 1 })
  assert.deepEqual(store.answered, [{ dialogId: 'c1', ok: false }], '必须 resolve(false)（保守：不做危险操作）')
  assert.equal(store.pendingConfirms.size, 0, 'resolve 表必须清空，否则泄漏')
  assert.equal(store.pendingConfirmsBySession.size, 0, '索引必须清空，否则局域网页残留待确认')
})

test('D：只影响目标会话，别的会话的待决确认原样保留', () => {
  const store = makeStore()
  store.request('s1', 'c1')
  store.request('s2', 'c2')
  releaseSessionConfirm(store.pendingConfirms, store.pendingConfirmsBySession, 's1')
  assert.deepEqual(store.answered, [{ dialogId: 'c1', ok: false }])
  assert.equal(store.pendingConfirms.has('c2'), true, 's2 的确认不得被误放行')
  assert.equal(store.pendingConfirmsBySession.has('s2'), true)
})

test('D：会话没有待决确认时是无操作（幂等，不抛错）', () => {
  const store = makeStore()
  store.request('s1', 'c1')
  const first = releaseSessionConfirm(store.pendingConfirms, store.pendingConfirmsBySession, 's1')
  const second = releaseSessionConfirm(store.pendingConfirms, store.pendingConfirmsBySession, 's1')
  assert.equal(first.resolved, 1)
  assert.deepEqual(second, { released: [], resolved: 0 }, '第二次必须是空操作')
  assert.equal(store.answered.length, 1, '不得重复 resolve')
})

test('D：未知会话 id 不抛错', () => {
  const store = makeStore()
  assert.deepEqual(releaseSessionConfirm(store.pendingConfirms, store.pendingConfirmsBySession, 'nope'), { released: [], resolved: 0 })
})

test('D：sessionId 为 undefined/null 时归一成空串且不抛错', () => {
  const store = makeStore()
  assert.doesNotThrow(() => releaseSessionConfirm(store.pendingConfirms, store.pendingConfirmsBySession, undefined))
  assert.doesNotThrow(() => releaseSessionConfirm(store.pendingConfirms, store.pendingConfirmsBySession, null))
  // 索引里有 '' 键时应能命中（confirmBridge 用 String(sessionId || '') 存）
  store.request(undefined, 'c9')
  const result = releaseSessionConfirm(store.pendingConfirms, store.pendingConfirmsBySession, undefined)
  assert.deepEqual(result.released, ['c9'])
})

test('D：索引项与 resolve 表不同步时只清索引，不假装 resolve 过', () => {
  const store = makeStore()
  store.request('s1', 'c1')
  // 模拟 confirm_response 已经回答了请求（resolve 被消费）但索引还没清
  store.pendingConfirms.delete('c1')
  const result = releaseSessionConfirm(store.pendingConfirms, store.pendingConfirmsBySession, 's1')
  assert.deepEqual(result, { released: ['c1'], resolved: 0 })
  assert.equal(store.pendingConfirmsBySession.size, 0, '索引仍必须清掉（否则局域网页一直显示待确认）')
})

test('D：索引项缺 dialogId 时不崩且仍清索引', () => {
  const store = makeStore()
  store.pendingConfirmsBySession.set('s1', [{}])
  const result = releaseSessionConfirm(store.pendingConfirms, store.pendingConfirmsBySession, 's1')
  assert.deepEqual(result, { released: [], resolved: 0 })
  assert.equal(store.pendingConfirmsBySession.size, 0)
})

test('D：resolve 回调抛错不得中断清理（closeSession 后续步骤必须继续）', () => {
  const pendingConfirms = new Map()
  const pendingConfirmsBySession = new Map()
  // 注：这是一个"不该发生但必须容忍"的模型 —— SDK/扩展提供的回调抛错
  pendingConfirms.set('c1', () => { throw new Error('扩展内部崩了') })
  pendingConfirmsBySession.set('s1', [{ dialogId: 'c1' }])
  let result
  assert.doesNotThrow(() => { result = releaseSessionConfirm(pendingConfirms, pendingConfirmsBySession, 's1') })
  assert.deepEqual(result.released, ['c1'])
  assert.equal(result.resolved, 0, '抛错时如实报告未成功 resolve')
  assert.equal(pendingConfirms.size, 0, 'resolve 表仍必须清空（否则泄漏一个死引用）')
  assert.equal(pendingConfirmsBySession.size, 0)
})

// ── 缺陷 9：同一会话的多条确认 ──────────────────────────────────────────
// 背景：早期索引是 sessionId → 单条 {dialogId}，同一会话的第二个确认会**覆盖**
// 第一个的索引项，第一个就再也 release 不掉了（悬挂 + 局域网页残留）。
// 当前 SDK 串行 await prepareToolCall→beforeToolCall→requestConfirm（只有 execute
// 并行），所以第二个确认实际到不了这一步 —— 但索引改数组后隐患彻底消失，代价为零。

test('#9：同一会话的两条待决确认都必须被放行（旧单值索引会漏掉第一条）', () => {
  const store = makeStore()
  store.request('s1', 'c1', 'bash')
  store.request('s1', 'c2', 'edit')
  const result = releaseSessionConfirm(store.pendingConfirms, store.pendingConfirmsBySession, 's1')
  assert.deepEqual(result.released, ['c1', 'c2'], '两条都必须放行 —— 旧实现只会有 c2')
  assert.equal(result.resolved, 2)
  assert.deepEqual(store.answered, [
    { dialogId: 'c1', ok: false },
    { dialogId: 'c2', ok: false },
  ])
  assert.equal(store.pendingConfirms.size, 0, '不得留下悬挂的 resolve')
  assert.equal(store.pendingConfirmsBySession.size, 0)
})

test('#9：同一会话三条确认，中间一条已被回答，其余仍被放行', () => {
  const store = makeStore()
  store.request('s1', 'c1')
  store.request('s1', 'c2')
  store.request('s1', 'c3')
  // 中间的 c2 被用户正常回答了
  store.pendingConfirms.delete('c2')
  assert.equal(forgetConfirm(store.pendingConfirmsBySession, 'c2'), true)
  const result = releaseSessionConfirm(store.pendingConfirms, store.pendingConfirmsBySession, 's1')
  assert.deepEqual(result.released, ['c1', 'c3'], '只剩下未被回答的两条')
  assert.equal(store.pendingConfirmsBySession.size, 0)
})

test('#9：forgetConfirm 只摘掉指定 confirmId，其余保留', () => {
  const store = makeStore()
  store.request('s1', 'c1')
  store.request('s1', 'c2')
  store.request('s2', 'c3')
  assert.equal(forgetConfirm(store.pendingConfirmsBySession, 'c1'), true)
  assert.deepEqual(store.pendingConfirmsBySession.get('s1'), [{ dialogId: 'c2', toolName: 'bash', summary: 'rm -rf' }])
  assert.equal(store.pendingConfirmsBySession.has('s2'), true, '别的会话不受影响')
  assert.equal(forgetConfirm(store.pendingConfirmsBySession, 'nope'), false, '没摘到时如实返回 false')
})

test('#9：forgetConfirm 摘掉会话的最后一条时删掉整个键', () => {
  const store = makeStore()
  store.request('s1', 'c1')
  forgetConfirm(store.pendingConfirmsBySession, 'c1')
  assert.equal(store.pendingConfirmsBySession.has('s1'), false, '空数组不得留下（局域网页会显示空待确认）')
})

test('#9：lastConfirmOfSession 返回最后一条，无确认时返回 null', () => {
  const store = makeStore()
  assert.equal(lastConfirmOfSession(store.pendingConfirmsBySession, 's1'), null)
  store.request('s1', 'c1', 'bash')
  store.request('s1', 'c2', 'edit')
  const last = lastConfirmOfSession(store.pendingConfirmsBySession, 's1')
  assert.equal(last.dialogId, 'c2')
  assert.equal(last.toolName, 'edit')
  assert.equal(lastConfirmOfSession(store.pendingConfirmsBySession, undefined), null)
})

test('#9：forgetConfirm 容忍非数组的陈旧索引值（升级期残留）', () => {
  const store = makeStore()
  // 模拟旧版实现留下的单条对象
  store.pendingConfirmsBySession.set('s1', { dialogId: 'c1' })
  assert.doesNotThrow(() => forgetConfirm(store.pendingConfirmsBySession, 'c1'))
})

// ── abort 请求的语义：清空所有（进程级 teardown） ────────────────────────

test('D：releaseAllConfirms 清空全部会话的待决确认并返回计数', () => {
  const store = makeStore()
  store.request('s1', 'c1')
  store.request('s2', 'c2')
  store.request('s3', 'c3')
  const count = releaseAllConfirms(store.pendingConfirms, store.pendingConfirmsBySession)
  assert.equal(count, 3)
  assert.deepEqual(store.answered, [
    { dialogId: 'c1', ok: false },
    { dialogId: 'c2', ok: false },
    { dialogId: 'c3', ok: false },
  ])
  assert.equal(store.pendingConfirms.size, 0)
  assert.equal(store.pendingConfirmsBySession.size, 0)
})

test('D：releaseAllConfirms 空表返回 0', () => {
  assert.equal(releaseAllConfirms(new Map(), new Map()), 0)
})

test('D：releaseAllConfirms 里单个回调抛错不影响其余条目', () => {
  const pendingConfirms = new Map()
  const pendingConfirmsBySession = new Map()
  const answered = []
  pendingConfirms.set('c1', () => { throw new Error('boom') })
  pendingConfirms.set('c2', () => answered.push('c2'))
  pendingConfirmsBySession.set('s1', [{ dialogId: 'c1' }])
  pendingConfirmsBySession.set('s2', [{ dialogId: 'c2' }])
  let count
  assert.doesNotThrow(() => { count = releaseAllConfirms(pendingConfirms, pendingConfirmsBySession) })
  assert.equal(count, 1, '只有没抛错的那条计入')
  assert.deepEqual(answered, ['c2'], 'c2 必须仍被放行')
  assert.equal(pendingConfirms.size, 0)
  assert.equal(pendingConfirmsBySession.size, 0)
})
