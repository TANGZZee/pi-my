// 会话级权限确认索引（纯逻辑，无 IO，可单测）
//
// 背景（审计确证的缺陷 D）：sidecar 里有两条"取消待决确认"的路径 ——
//   ① `abort` 请求处理函数：遍历 pendingConfirms 逐个 resolve(false) 并清空索引；
//   ② `closeSession` / `deleteSession` / `openSession` 的重建分支：
//      它们**直接调 entry.session.abort()**（SDK 方法），绕过了 ① 的处理函数。
// 后果：扩展在工具调用里 await 的那个 Promise 永远不会 resolve —— 工具调用悬挂；
// 且 pendingConfirmsBySession 里的陈旧项会一直出现在局域网遥控页的"待确认"列表里。
//
// 这里把"按会话放行"的逻辑抽成纯函数，让测试能对真实实现做行为断言
// （只用正则匹配源码文本的接线测试已被两轮审查证明是假防线）。

/**
 * 放行某个会话挂着的待决权限确认。
 *
 * 只动这一个会话的条目。索引值是**数组**（审查缺陷 9）：早期实现是
 * sessionId → 单条 {dialogId}，同一会话的第二个确认会覆盖第一个的索引项，
 * 导致第一个确认再也无法被 release（悬挂）。当前 SDK 串行 await
 * prepareToolCall → beforeToolCall → requestConfirm，所以第二个确认实际到不了
 * 这一步；但把索引做成数组可以彻底消除这个隐患，代价为零。
 *
 * @param {Map<string, (ok: boolean) => void>} pendingConfirms
 * @param {Map<string, Array<{dialogId?: string}>>} pendingConfirmsBySession
 * @param {string} sessionId
 * @returns {{ released: string[], resolved: number }}
 *   `released` = 被撤销的 confirmId 列表；`resolved` = 真的调到 resolve 的条数。
 */
export function releaseSessionConfirm(pendingConfirms, pendingConfirmsBySession, sessionId) {
  const sid = String(sessionId ?? '')
  const list = pendingConfirmsBySession.get(sid)
  if (!list || !list.length) return { released: [], resolved: 0 }
  pendingConfirmsBySession.delete(sid)
  const released = []
  let resolved = 0
  for (const meta of list) {
    const dialogId = meta?.dialogId
    if (!dialogId) continue
    released.push(dialogId)
    const resolve = pendingConfirms.get(dialogId)
    // 索引项与 resolve 表不同步是可能的（例如 confirm_response 先回答了请求，
    // 但索引清理由另一条路径负责）。此时只清索引，不假装 resolve 过。
    if (typeof resolve !== 'function') continue
    pendingConfirms.delete(dialogId)
    try {
      resolve(false)
      resolved += 1
    } catch {
      // resolve 是 SDK/扩展提供的回调，抛错不得影响 closeSession 的其余清理。
    }
  }
  return { released, resolved }
}

/**
 * 从会话索引里摘掉某一个 confirmId（`confirm_response` 正常回答后调用）。
 * @returns {boolean} 是否摘掉了至少一条
 */
export function forgetConfirm(pendingConfirmsBySession, confirmId) {
  let removed = false
  for (const [sid, list] of pendingConfirmsBySession) {
    if (!Array.isArray(list)) continue
    const next = list.filter((meta) => meta?.dialogId !== confirmId)
    if (next.length === list.length) continue
    removed = true
    if (next.length) pendingConfirmsBySession.set(sid, next)
    else pendingConfirmsBySession.delete(sid)
  }
  return removed
}

/**
 * 该会话当前待决的最后一条确认（局域网遥控页快照用）。
 * @returns {{dialogId?: string, toolName?: string, summary?: string} | null}
 */
export function lastConfirmOfSession(pendingConfirmsBySession, sessionId) {
  const list = pendingConfirmsBySession.get(String(sessionId ?? ''))
  if (!Array.isArray(list) || !list.length) return null
  return list[list.length - 1]
}

/**
 * 清空**所有**待决确认（`abort` 请求的语义：用户中止，本次会话里所有确认作废）。
 * @returns {number} 被 resolve(false) 的条目数
 */
export function releaseAllConfirms(pendingConfirms, pendingConfirmsBySession) {
  let count = 0
  for (const [confirmId, resolve] of pendingConfirms) {
    pendingConfirms.delete(confirmId)
    try {
      resolve(false)
      count += 1
    } catch {
      // 见上：单个回调抛错不得中断清理
    }
  }
  pendingConfirmsBySession.clear()
  return count
}
