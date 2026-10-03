/**
 * 终态兜底仲裁器（F4，真实报障驱动的独立防线）。
 *
 * 背景：模型返回不可重试错误时，SDK 只产出一条 `stopReason:'error'` + `errorMessage`
 * 的 assistant 终态消息，然后照常发 `agent_end` / `agent_settled`（SDK 0.99.1：
 * `pi-agent-core/dist/agent-loop.js:142` 先把这条消息 push 进 `newMessages`、
 * `:143` 才判定 error、`:152` 发 `agent_end{messages}`；`agent_settled` 由
 * `pi-coding-agent/dist/core/agent-session.js:1344` 在 `_runAgentPrompt` 的 finally 里
 * 调 `_emitAgentSettled()`，其定义在 `:662-672`）。
 * 前端**只有**在这两个终态事件到达时才会收尾（`finishRun`）。一旦这条投递链上任何
 * 一环丢了终态事件（Rust sidecar stdout 读线程异常退出、webview 事件丢失、未来某个
 * 扩展钩子悬挂……），槽位就永远停在 `running:true` + `phase:'thinking'`，
 * 用户看到的就是永久 Thinking、且**不报任何错**。
 *
 * 这条防线**不依赖任何终态事件**：只要观察到"带错误的 assistant 消息"
 * （`message_end` / `turn_end` 都带），就启动一个短计时器；期间该会话只要再收到
 * **任何**事件就取消计时器（说明事件链还活着，终态事件只是还在路上）。计时器真的
 * 走到头，就说明终态事件确实丢了，此时按已暂存的 provider 错误文本收尾。
 *
 * 为什么是 8 秒（定量核对 SDK 0.99.1）：
 * - SDK 决定重试时**先**发 `auto_retry_start`、**再**去睡退避延迟，这是两个分离的语句：
 *   `agent-session.js:2961 this._emit({ type: "auto_retry_start", … delayMs … })`
 *   → `:2973 await sleep(delayMs, this._retryAbortController.signal)`。
 *   事件在 sleep 之前就已发出，所以正常重试路径下它毫秒级到达并撤销计时器，不会误报；
 * - 首跳退避是 `baseDelayMs`（`pi-ai/dist/utils/retry.js`：
 *   `retryDelayMs = policy.baseDelayMs * 2 ** (attempt - 1)`，上限 `DEFAULT_MAX_AGENT_RETRY_DELAY_MS = 60_000`）。
 *   用户 `settings.json` 没有 `retry` 键 ⇒ 取默认 `baseDelayMs = 2000`，第 1 次重试只等 2 s，
 *   第 2/3 次为 4 s / 8 s；即便把上限 60 s 考虑进来，**事件也始终在 sleep 之前发出**，
 *   所以"退避比 8 s 长"这件事永远无法导致误报 —— 撤销发生在等待开始之前，而不是之后；
 * - 同理自动压缩：`agent-session.js:2410 this._emit({ type: "compaction_start", reason })`
 *   在长达数十秒的摘要生成（`:2448 _runDefaultCompaction`）之前就发出，前端事件入口里
 *   那句 `settleArbiter.cancel(id)`（在事件分派**之前**）会立刻解除兜底；
 *   注意：源码行号会随并发改动漂移，引形状不引行号。
 * - 同时它远短于全局 180 秒看门狗：用户不必等 3 分钟才看到真正的失败原因，
 *   更不会永远看不到。
 * 结论：8 s 的安全性**不依赖任何"退避时间有多长"的假设**，只依赖"重试/压缩事件先于等待发出"
 * 这一条 SDK 契约；该契约已在 0.99.1 上逐行核对（含 emit 与 sleep 的行号）。
 *
 * 纯逻辑 + 注入时钟，便于用假计时器单测（Svelte 组件里只留薄接线）。
 */
export const SETTLE_GRACE_MS = 8_000

/** 计时器走到头、但暂存里已经没有任何错误文本时的兜底文案（最后的保险，正常不应出现）。 */
export const SETTLE_FALLBACK_TEXT =
  '模型请求已经结束，但终态事件没有到达界面（事件链可能中断），已按失败收尾。请检查网络/额度后重试。'

export interface SettleArbiterHooks {
  /** 计时器到期且期间没有任何事件时调用；`raw` 是当初触发挂起的那条错误文本。 */
  onFire: (id: string, raw: string) => void
  /** 可选注入，便于单测；默认用 window 上的定时器。 */
  schedule?: (callback: () => void, ms: number) => number
  unschedule?: (handle: number) => void
}

export interface SettleArbiter {
  /**
   * 记下"这个会话看到了错误、但还没等到终态"；宽限 `graceMs` 内该会话若再无任何事件，
   * 就判定终态事件丢失并开火。`raw` 为空（正常结束）时不挂计时器。
   */
  arm: (id: string, raw: string, graceMs?: number) => void
  /** 收到该会话的任何事件 / 收尾 / 中止 / 关会话时调用。 */
  cancel: (id: string) => void
  cancelAll: () => void
  pending: (id: string) => boolean
  size: () => number
}

interface PendingSettle {
  handle: number
  raw: string
  token: number
}

export function createSettleArbiter(hooks: SettleArbiterHooks): SettleArbiter {
  const schedule =
    hooks.schedule ?? ((callback: () => void, ms: number) => window.setTimeout(callback, ms))
  const unschedule = hooks.unschedule ?? ((handle: number) => window.clearTimeout(handle))
  const entries = new Map<string, PendingSettle>()
  let token = 0

  function cancel(id: string) {
    const entry = entries.get(id)
    if (!entry) return
    entries.delete(id)
    unschedule(entry.handle)
  }

  function arm(id: string, raw: string, graceMs: number = SETTLE_GRACE_MS) {
    const text = String(raw ?? '').trim()
    if (!text) return // 没看到错误就不该挂计时器：正常但很慢的模型绝不能误报
    cancel(id) // 重新计时；较新的错误文本才是要展示的那条
    token += 1
    const mine = token
    const handle = schedule(() => {
      const entry = entries.get(id)
      // token 守卫：旧计时器即使漏掉了 unschedule，也不允许顶掉新一次的挂起。
      if (!entry || entry.token !== mine) return
      entries.delete(id) // 先摘除再回调：回调里再调 cancel/finishRun 不会重入
      hooks.onFire(id, entry.raw)
    }, graceMs)
    entries.set(id, { handle, raw: text, token: mine })
  }

  return {
    arm,
    cancel,
    cancelAll() {
      for (const id of [...entries.keys()]) cancel(id)
    },
    pending: (id: string) => entries.has(id),
    size: () => entries.size,
  }
}
