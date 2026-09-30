// 运行期会话状态机的纯逻辑（可单测）
//
// 这里收纳三类此前散落在 App.svelte 里、无法被单测覆盖的状态迁移：
//   1. 单调递增的 turn id（缺陷 G）
//   2. 队列出队的 CAS 迁移（缺陷 C）
//   3. 子会话结束状态回填到父槽（缺陷 H）
//
// ⚠️ 不要再把逻辑写回组件里用正则断言"源码文本"验证 —— 两轮对抗性审查已证明
// 那只匹配字符序列、不匹配行为（见 PI/tests/provider-error-wiring.test.mjs 的注释）。

// 显式 .ts 扩展名：本文件被 PI/tests 下的 node --test 直接加载，
// node 不做扩展名补全（与 markdown-incremental.ts → './markdown.ts' 同例）。
import { casReplace, type CasResult } from './queue-cas.ts'

/** 出队计划：CAS 通过时给出"新的队列 + 新的 revision + 该派发的文本"。 */
export interface DrainPlan<T> {
  /** 新队列（已去掉队首） */
  queue: T[]
  /** 递增后的 revision */
  revision: number
  /** 本轮要派发的队首文本 */
  text: string
}

/**
 * 计划一次队列出队（缺陷 C）。
 *
 * 旧实现是 `const [, ...rest] = slot.queue; patchSlot({queue: rest, queueRevision: revision + 1})`
 * —— 纯"读→写"，没有 revision 校验。
 *
 * ⚠️ **诚实标注**：调用点 `drainQueue` 是同步的（读 → 算 → 写之间没有 await），
 * 所以 `expected` 恒等于 `revision`，CAS 分支在**当前调用点永不拒绝**；
 * 我未能构造出它的线上复现（`slot.running` 检查 + `dispatchTurn` 同步置 running
 * 已经挡住了重复派发）。这里保留 CAS 是为了：① 把意图写成代码；② 若将来 drain
 * 路径引入 await（例如等待 sidecar 回执），陈旧 revision 会被立刻拦下；
 * ③ 把逻辑抽出来变成可单测的纯函数。
 *
 * @param queue 当前队列（只读）
 * @param revision 当前 revision
 * @param expected 调用方"据以决策"的 revision，默认与 revision 相同
 * @returns 通过时返回 DrainPlan；revision 过期时返回 null（调用方应静默放弃）
 */
export function planDrain<T extends { text: string }>(
  queue: readonly T[],
  revision: number,
  expected: number = revision,
): DrainPlan<T> | null {
  if (!queue.length) return null
  const result: CasResult<T> = casReplace(queue as T[], revision, expected, (items) => items.slice(1))
  if (!result.ok) return null
  return { queue: result.value, revision: result.revision, text: queue[0].text }
}

/** 子会话运行记录的最小形状（父槽只关心这几个字段）。 */
export interface SubRunLike {
  id: string
  status: string
  reply?: string
  [key: string]: unknown
}

/** 父槽的最小形状。 */
export interface ParentSlotLike<T extends SubRunLike> {
  subRuns?: T[]
  [key: string]: unknown
}

/**
 * 把子会话的终态回填到**所有**持有它的父槽（缺陷 H）。
 *
 * 旧实现边遍历 `Object.entries(runState)` 边用**遍历开始时捕获的 `slot.subRuns`**
 * 做 `map` —— 如果同一个父槽被匹配两次（不会凭空发生，但 patchSlot 是整体替换，
 * 遍历顺序与快照时机在并发 patch 下并不可靠），后一次会用过期数组覆盖前一次的结果。
 * 这里改成两段式：先收集所有命中的父槽 id，再逐个重新读取当前值后写回。
 *
 * @param runState 当前 runState（只读，不修改入参）
 * @param runId 结束的子会话 id
 * @param status 新状态
 * @param reply 子会话最终回复
 * @returns 需要 patch 的 `{parentId, subRuns}` 列表；无命中时为空数组
 */
export function collectSubRunUpdates<T extends SubRunLike>(
  runState: Record<string, ParentSlotLike<T> | undefined>,
  runId: string,
  status: string,
  reply: string,
): Array<{ parentId: string; subRuns: T[] }> {
  const parentIds = Object.keys(runState).filter((parentId) =>
    runState[parentId]?.subRuns?.some((run) => run?.id === runId),
  )
  const updates: Array<{ parentId: string; subRuns: T[] }> = []
  for (const parentId of parentIds) {
    const current = runState[parentId]?.subRuns
    // 两段之间可能被别的 patch 改过（例如父槽已被关闭/删除）→ 用当前值复检
    if (!current?.some((run) => run?.id === runId)) continue
    updates.push({
      parentId,
      subRuns: current.map((run) => (run.id === runId ? { ...run, status, reply } : run)),
    })
  }
  return updates
}

/**
 * 单调递增的 turn id 生成器（缺陷 G）。
 *
 * 旧实现 `turn-${Date.now()}` 在同一毫秒内两次派发会撞 id，而 timeline 用
 * `message.id` 作 Svelte 的 key（`{#each ... (item.id)}`）→ 重复 key 警告 +
 * 复用错误的 DOM 节点。计数器保证同进程内唯一，时间戳只用于可读性。
 */
export function createTurnIdFactory(prefix = 'turn'): () => string {
  let seq = 0
  return () => {
    seq += 1
    return `${prefix}-${seq}-${Date.now()}`
  }
}

/**
 * 这个终态事件是否属于"当前正在跑的回合"（外部审计缺陷 1 + 审查者 S1）。
 *
 * 场景：回合 A 流式输出中，用户点 Stop，紧接着又发了回合 B。
 * A 的 `agent_end`/`agent_settled` 会迟到（它们是在 abort 请求飞行期间才发出来的），
 * 若无条件收尾就会把**新**回合 B 当成已结束：running 归零、把只写了一半的回复
 * 提交进 timeline，之后 B 真正的内容再也进不去（finishRun 早退）。
 *
 * 判据只能是"发起这次收尾的代码是否还持有当前回合"。注意：
 *   - `activeTurnId` 为空 = 当前没有在跑的新回合 → 收尾是安全的（放行）；
 *   - `expectedTurnId` 未给出 = 调用方没有回合身份，不做限制（放行）。
 * 只有"两者都有值且不相等"才是确定的陈旧事件。
 */
export function isTurnCurrent(activeTurnId: string | undefined, expectedTurnId: string | undefined): boolean {
  if (expectedTurnId === undefined) return true
  if (activeTurnId === undefined) return true
  return activeTurnId === expectedTurnId
}

/**
 * 运行世代追踪（外部审计缺陷 1/2）。
 *
 * 为什么需要它：SDK 的事件里**没有回合身份**（`agent_end` 只有 messages，
 * `agent_settled` 什么都不带），所以"这条终态事件属于哪一轮"无法从事件本身读出。
 * 唯一可靠的判据是时间顺序：**如果在 abort 之后又派发过新一轮，那么此刻到达的
 * 终态事件必然属于被 abort 的那一轮**（sidecar 的 serialChain 保证 abort 请求在
 * 下一轮 prompt 之前完成，因此旧轮的终态事件一定排在下一轮 agent_start 之前）。
 *
 * 生命周期：
 *   dispatch(id)        —— 每次派发新回合调用，推进世代；
 *   markAborted(id)     —— Stop / 关标签发 abort 时调用，记下被中止的世代；
 *   isSuperseded(id)    —— 事件入口判定；true = 整条丢弃；
 *   clearSuperseded(id) —— 在 `agent_start` 时调用（新一轮真正开始）。
 *
 * ⚠️ 为什么**不能**在 isSuperseded 命中时就清掉标记：一次失败的运行会连发
 * `agent_end` 与 `agent_settled` 两条终态事件。若第一条就消费掉标记，第二条会被
 * 误当成"当前轮的终态"而放行，缺陷照旧。标记必须活到新一轮的 agent_start。
 *
 * 残余风险（诚实标注）：若新一轮从未真正 start（例如 prompt 在模型校验阶段就抛错），
 * 标记不会被清除，该轮的第一个终态事件会被误丢弃一次。这种情况下兜底是 180s 看门狗
 * （它会给出明确错误文案），且 `.catch` 路径用的是精确回合判据（isTurnCurrent），
 * 不受本标记影响。
 */
export interface RunEpoch {
  /** 派发新回合：推进世代并返回新代号。 */
  dispatch(id: string): number
  /** 记录"该会话的运行已被中止"，被中止的是当前世代。 */
  markAborted(id: string): void
  /** 当前到达的事件是否属于被中止的旧轮（true = 必须丢弃）。 */
  isSuperseded(id: string): boolean
  /**
   * 该会话是否处于"已记下中止、但尚未被新一轮取代"的状态（外部审计 D-A）。
   *
   * 语义与 isSuperseded 互补：`isAborted && !isSuperseded` = 用户刚刚中止了这一轮，
   * 而新一轮还没派发。preflight 阶段（模型校验/压缩/扩展钩子）按停止会产生这个状态：
   * SDK 的 `agent.abort()` 只对已建立的 activeRun 生效
   * （`pi-agent-core/dist/agent.js:202 this.activeRun?.abortController.abort()`），
   * 那时 activeRun 还不存在 ⇒ abort 是空操作，这一轮仍在继续，并在进入 loop 时
   * 无条件发 `agent_start`（`agent-loop.js:49` 之前没有任何 signal 检查）。
   */
  isAborted(id: string): boolean
  /** 当前世代号（从未派发过则 undefined）。用于"这个异步续体还属于那一轮吗"。 */
  generationOf(id: string): number | undefined
  /** 新一轮真正开始（agent_start）：解除取代态。 */
  clearSuperseded(id: string): void
  /** 会话被关闭/删除：清掉该 id 的全部记录（防泄漏）。 */
  forget(id: string): void
  /** 只读快照（诊断/测试用）。 */
  snapshot(): { generations: Record<string, number>; aborted: Record<string, number> }
}

/** 创建运行世代追踪器（见 RunEpoch 注释）。 */
export function createRunEpoch(): RunEpoch {
  let counter = 0
  const generations: Record<string, number> = {}
  const abortedAt: Record<string, number> = {}
  return {
    dispatch(id) {
      counter += 1
      generations[id] = counter
      return counter
    },
    markAborted(id) {
      const current = generations[id]
      if (current === undefined) return
      abortedAt[id] = current
    },
    isSuperseded(id) {
      const aborted = abortedAt[id]
      if (aborted === undefined) return false
      const current = generations[id]
      return current !== undefined && current > aborted
    },
    isAborted(id) {
      const aborted = abortedAt[id]
      if (aborted === undefined) return false
      return generations[id] === aborted
    },
    generationOf(id) {
      return generations[id]
    },
    clearSuperseded(id) {
      delete abortedAt[id]
    },
    forget(id) {
      delete generations[id]
      delete abortedAt[id]
    },
    snapshot() {
      return { generations: { ...generations }, aborted: { ...abortedAt } }
    },
  }
}

/**
 * 派发前奏的存活判据（外部审计缺陷 4）。
 *
 * `dispatchTurn` 的异步前奏有多个 await（create_session / set_model /
 * read_attachment / vision_describe），期间用户完全可能把标签关掉、删掉会话，或
 * Stop 之后再发一条（回合身份已变）。任一情况成立都必须放弃真正发出 prompt，
 * 否则 sidecar 里会跑起一个前端无法查看、无法停止的僵尸运行。
 *
 * 之所以抽成纯函数而**不是**在组件里写 `!closedIds.has(id) && slotFor(id)...`：
 * 组件级表达式只能用正则断言"源码里出现过这段字符串"来守护，而对抗性审查已证明
 * 字符串断言挡不住运算优先级变异（在表达式尾部追加 `|| true` 可让全部五道守卫
 * 同时变成死代码，套件仍然全绿）。判据做成可求值的纯函数后，测试直接喂输入看
 * 输出，改坏就红。
 */
export function isTurnAlive(closed: boolean, slotTurnId: string | undefined, expectedTurnId: string | undefined): boolean {
  if (closed) return false
  if (expectedTurnId === undefined) return slotTurnId === undefined
  return slotTurnId === expectedTurnId
}

/** 会话切换代数守卫（latest-request-wins）。 */
export interface EpochGuard {
  /** 自增代数并返回新令牌（作废之前所有令牌）。 */
  bump(): number
  /** 令牌是否仍是当前最新（false = 对应的异步续体必须放弃写入）。 */
  check(token: number): boolean
  /** 当前代数（只读诊断用）。 */
  current(): number
}

/**
 * 会话切换代数守卫（缺陷 B）。
 *
 * 问题：会话切换/关闭涉及多个 await（`open_session`、重启后逐条重开）。旧实现
 * 只有 `refreshCtxStats` 一处做了 `activeSessionId !== id` 比对，而
 * 「关掉会话 X → 又重开/切回 X」时 id 完全不变 —— 仅比 id 抓不住这种交错，
 * 晚到的旧响应会盖到新状态上（典型表现：切走再切回时历史加载结果互相覆盖）。
 *
 * 方案（思路来自 pi-agent-desktop 的 `latestRequestStale` / percho 的 epoch 令牌）：
 * 每次"会话拓扑变化"（切换 / 关闭 / 重建 / 重启重绑）就 `bump()` 一次；
 * 异步续体在每个 await 之后 `check(token)`，不等则立刻放弃写入。
 *
 * ⚠️ 续体必须在**每一个** await 之后复检，而不是只在最后一次 —— 中途用户切走时
 * 也要尽早退出（否则会白跑一串 IPC，并在最后一步才丢弃结果）。
 */
export function createEpochGuard(): EpochGuard {
  let epoch = 0
  return {
    bump() {
      epoch += 1
      return epoch
    },
    check(token) {
      return token === epoch
    },
    current() {
      return epoch
    },
  }
}
