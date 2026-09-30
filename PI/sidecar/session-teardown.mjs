// 会话 teardown 的顺序承重逻辑（纯逻辑，无 IO，可行为单测）
//
// 为什么必须抽出来（审查 D1 + T1）：
//   SDK 的 `session.abort()` 末尾是 `await this.waitForIdle()`
//   （pi-coding-agent/dist/core/agent-session.js:1222-1234），而 waitForIdle 只在
//   `_emitAgentSettled()` 的 finally 里被 resolve（同文件 :347-356）。
//   `_emitAgentSettled()` 只在 agent 运行结束时执行；若此刻有一个 `beforeToolCall`
//   正 await 用户的权限确认，`_isAgentRunActive` 始终为 true ⇒ **abort() 永不返回**。
//   abort 信号救不了它：agent-loop 只在 `await config.beforeToolCall(...)` 返回
//   **之后**才检查 `signal?.aborted`（pi-agent-core/dist/agent-loop.js:412-419），
//   而扩展那行是无 signal 的 `await options.confirm(...)`
//   （sidecar/permissions/extension.ts:138）。
//   ⇒ 放行待决确认**必须发生在 abort() 之前**：写在前面的放行正好解开那个 await，
//     abort() 才得以完成；写在后面则**永远执行不到**（恰好就是要治的场景）。
//   没有待决确认时放行是 no-op，所以"先放行"在任何情况下都不会更差。
//
// 抽成独立函数的价值：旧测试用"源码文本存在性正则"断言，把 release 移到 abort()
// 之后（即恢复成死锁的写法）仍然 20 pass / 0 fail —— 对顺序完全盲（审查 T1/M5）。
// 现在顺序是**行为**可测的：给一个"release 之后才 resolve"的 abort 桩，
// 顺序写反会直接超时失败。

/**
 * 关闭 / 删除 / 重建会话的统一 teardown。
 *
 * 顺序承重：① 放行待决权限确认 → ② 取消待决扩展对话框 → ③ abort()
 *          → ④ 退订 → ⑤ 从会话表移除。
 *
 * @param {object} options
 * @param {string} options.id 会话 id
 * @param {(id: string) => void} [options.releaseConfirms] 放行该会话的待决权限确认
 * @param {(reason: string, id?: string) => void} [options.drainDialogs] 取消该会话的待决对话框
 * @param {() => Promise<unknown>} [options.abort] SDK `session.abort()`
 * @param {() => void} [options.unsubscribe] 退订事件流
 * @param {(id: string) => void} [options.forget] 从会话表移除
 * @param {string} [options.reason] 记日志用的原因
 * @returns {Promise<void>}
 */
export async function teardownSession({ id, releaseConfirms, drainDialogs, abort, unsubscribe, forget, reason }) {
  // ① 承重顺序：必须在 abort() 之前（见文件头注释）。
  //    没有待决确认时这是 no-op，所以提前不会更差。
  releaseConfirms?.(id)
  // ② 同理：扩展对话框残留的 await 也会让主循环卡死。
  drainDialogs?.(reason || `清理会话 ${id}`, id)
  // ③ 到这里待决的 await 已经解开，abort() 才能等到 waitForIdle。
  try {
    await abort?.()
  } catch {
    // abort 失败不应阻断其余清理
  }
  try {
    unsubscribe?.()
  } catch {
    // 同上
  }
  forget?.(id)
}

/**
 * 用户中止（abort 请求 / 局域网 stop）的取消语义。
 *
 * 与 teardownSession 的区别：不销毁会话，只解开"卡住的等待"再中止运行。
 * 同样承重：放行必须在 abort() 之前（理由见文件头）。
 * 注意必须**收窄到本会话**：早期实现用 releaseAllConfirms 会把别的会话正在等待的
 * 权限确认一起取消（审查缺陷 #5，已被测试证明）。
 *
 * @param {object} options
 * @param {string} options.sessionId
 * @param {(id: string) => void} [options.releaseConfirms]
 * @param {(reason: string, id?: string) => void} [options.drainDialogs]
 * @param {() => Promise<unknown>} [options.abort]
 * @param {string} [options.reason]
 * @returns {Promise<void>}
 */
export async function cancelSessionInteractions({ sessionId, releaseConfirms, drainDialogs, abort, reason }) {
  // ① 只放行本会话的确认（不要用 releaseAllConfirms —— 会波及其它会话）
  releaseConfirms?.(sessionId)
  // ② 只取消本会话的扩展对话框
  drainDialogs?.(reason || '用户中止', sessionId)
  // ③ 现在 abort() 才可能 settle
  try {
    await abort?.()
  } catch {
    // 中止失败不应抛出到 RPC 层（前端只关心"已请求中止"）
  }
}
