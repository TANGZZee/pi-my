// 会话运行期纯逻辑单测（m04746 审计缺陷 C/G/H）
//
// 这些迁移此前内嵌在 App.svelte 里，只能靠"源码文本正则"断言 —— 两轮对抗性审查
// 已证明那是假防线（注释掉真实调用仍全绿）。抽取成纯函数后在这里做行为断言。
import test from 'node:test'
import assert from 'node:assert/strict'
import { collectSubRunUpdates, createEpochGuard, createRunEpoch, createTurnIdFactory, isTurnAlive, isTurnCurrent, planDrain } from '../src/session-run.ts'

const q = (...texts) => texts.map((text, index) => ({ id: `q-${index}`, text }))

// ── G：单调递增 turn id ────────────────────────────────────────────────

test('G：同一毫秒内连续生成的 turn id 也不重复', () => {
  const next = createTurnIdFactory()
  const ids = new Set()
  for (let i = 0; i < 500; i += 1) ids.add(next())
  assert.equal(ids.size, 500, '500 次生成必须得到 500 个不同 id（旧实现用 Date.now() 会撞）')
})

test('G：turn id 带有单调递增序号，便于排查', () => {
  const next = createTurnIdFactory()
  const a = next()
  const b = next()
  assert.match(a, /^turn-1-\d+$/)
  assert.match(b, /^turn-2-\d+$/)
  // 序号是主序，时间戳只是可读性后缀：即使时钟回拨也不会倒退
  assert.ok(Number(a.split('-')[1]) < Number(b.split('-')[1]))
})

test('G：两个工厂实例互不干扰（子代理/多会话各用自己的序号空间）', () => {
  const a = createTurnIdFactory()
  const b = createTurnIdFactory()
  assert.match(a(), /^turn-1-/)
  assert.match(b(), /^turn-1-/)
  assert.match(a(), /^turn-2-/)
})

// ── H：子会话终态回填父槽 ──────────────────────────────────────────────

const subRun = (id, status = 'running', reply = '') => ({ id, status, reply, agent: 'scout', task: 't' })

test('H：回填所有持有该子会话的父槽', () => {
  const runState = {
    p1: { subRuns: [subRun('s1'), subRun('s2')] },
    p2: { subRuns: [subRun('s1')] },
    p3: { subRuns: [subRun('other')] },
  }
  const updates = collectSubRunUpdates(runState, 's1', 'done', '结果文本')
  assert.deepEqual(updates.map((u) => u.parentId), ['p1', 'p2'])
  for (const update of updates) {
    const target = update.subRuns.find((run) => run.id === 's1')
    assert.equal(target.status, 'done')
    assert.equal(target.reply, '结果文本')
  }
  // 兄弟项与无关父槽不得被改动
  const p1 = updates.find((u) => u.parentId === 'p1')
  assert.deepEqual(p1.subRuns.find((run) => run.id === 's2'), subRun('s2'))
})

test('H：无命中时返回空数组（不得凭空造父槽）', () => {
  const runState = { p1: { subRuns: [subRun('s1')] } }
  assert.deepEqual(collectSubRunUpdates(runState, 'nope', 'done', ''), [])
})

test('H：父槽没有 subRuns 字段时不崩', () => {
  const runState = { p1: {}, p2: { subRuns: [subRun('s1')] } }
  const updates = collectSubRunUpdates(runState, 's1', 'error', '')
  assert.deepEqual(updates.map((u) => u.parentId), ['p2'])
})

test('H：同一父槽只产生一条更新（旧实现用旧快照 map，重复匹配会丢更新）', () => {
  // 两次匹配同一父槽在旧实现里分别用同一个旧数组 map，第二条会覆盖第一条；
  // 新实现先收集 id 再逐个读，父槽 id 天然唯一。
  const runState = { p1: { subRuns: [subRun('s1'), subRun('s1b')] } }
  const updates = collectSubRunUpdates(runState, 's1', 'done', 'x')
  assert.equal(updates.length, 1)
  assert.equal(updates[0].subRuns.length, 2, '兄弟项必须保留')
})

test('H：不修改传入的 runState（纯函数）', () => {
  const original = { p1: { subRuns: [subRun('s1')] } }
  const snapshot = JSON.parse(JSON.stringify(original))
  collectSubRunUpdates(original, 's1', 'done', 'x')
  assert.deepEqual(original, snapshot, '入参不得被就地改写')
})

// ── C：队列出队 CAS ────────────────────────────────────────────────────

test('C：正常出队返回去掉队首的新队列并递增 revision', () => {
  const plan = planDrain(q('a', 'b', 'c'), 3)
  assert.ok(plan)
  assert.deepEqual(plan.queue.map((i) => i.text), ['b', 'c'])
  assert.equal(plan.revision, 4)
  assert.equal(plan.text, 'a', '要派发的是原队首文本')
})

test('C：空队列返回 null', () => {
  assert.equal(planDrain([], 0), null)
})

test('C：revision 过期返回 null（将来 drain 路径引入 await 时的防线）', () => {
  const plan = planDrain(q('a', 'b'), /* revision */ 5, /* expected */ 4)
  assert.equal(plan, null, '读到的 revision 与传入的 expected 不一致必须拒绝')
})

test('C：合法出队后 revision 递增，旧 expected 再出队被拒（防重复派发）', () => {
  const first = planDrain(q('a', 'b'), 1)
  assert.ok(first)
  // 第二次沿用旧 revision（模拟两个 drain 同时基于旧状态）
  const second = planDrain(first.queue, first.revision, 1)
  assert.equal(second, null, '第二个基于旧 revision 的 drain 必须被拦下')
})

test('C：不修改传入的队列数组（纯函数）', () => {
  const original = q('a', 'b')
  planDrain(original, 0)
  assert.deepEqual(original.map((i) => i.text), ['a', 'b'])
})

// ── B：会话切换代数守卫 ────────────────────────────────────────────────

test('B：bump 之后旧令牌立即失效（晚到的响应必须被丢弃）', () => {
  const epoch = createEpochGuard()
  const token = epoch.bump()
  assert.ok(epoch.check(token), '刚拿到的令牌有效')
  // 模拟：await 期间用户又切了一次会话
  epoch.bump()
  assert.equal(epoch.check(token), false, '旧令牌必须失效')
})

test('B：关闭→重开同一个会话 id 也能被区分（仅比 id 抓不住的场景）', () => {
  const epoch = createEpochGuard()
  // 第一次切到会话 X
  const first = epoch.bump()
  // 用户关掉 X：closeTab 作废在飞的响应
  epoch.bump()
  // 用户又切回 X（id 完全相同）
  const second = epoch.bump()
  assert.equal(epoch.check(first), false, '第一次切换的响应不得落到重开后的 X 上')
  assert.ok(epoch.check(second), '最新一次切换的响应有效')
})

test('B：拿令牌与校验之间的任意次数 bump 都会使其失效', () => {
  const epoch = createEpochGuard()
  const token = epoch.bump()
  for (let i = 0; i < 5; i += 1) epoch.bump()
  assert.equal(epoch.check(token), false)
})

test('B：没有并发的连续切换不会误伤（令牌仍然有效）', () => {
  const epoch = createEpochGuard()
  const token = epoch.bump()
  assert.ok(epoch.check(token), '期间无人 bump，本次续体应当继续写回')
})

test('B：current() 读取快照但不推进代数（重启重绑用它做只读快照）', () => {
  const epoch = createEpochGuard()
  const before = epoch.current()
  assert.equal(epoch.current(), before, 'current() 不得改变代数')
  const token = epoch.bump()
  assert.notEqual(token, before, 'bump() 返回的必须是新令牌')
  assert.equal(epoch.current(), token)
})

test('B：两个守卫实例互不干扰（各自独立的会话拓扑）', () => {
  const a = createEpochGuard()
  const b = createEpochGuard()
  const tokenA = a.bump()
  b.bump()
  assert.ok(a.check(tokenA), '另一个实例的 bump 不得影响本实例')
})

test('B：令牌是 number 且严格递增（便于日志比对）', () => {
  const epoch = createEpochGuard()
  const t1 = epoch.bump()
  const t2 = epoch.bump()
  assert.equal(typeof t1, 'number')
  assert.ok(t2 > t1)
})

// ── 缺陷 1（前端）：精确回合判据 isTurnCurrent ─────────────────────────
//
// 用于 `.catch` 这类**带回合身份**的路径：dispatchTurn 发起时钉住 activeTurnId，
// 回调到达时若槽里的 round 已换成新的，就说明这次失败属于上一轮，不能拿它去
// 收尾新一轮（否则新一轮刚显示"思考中"就被旧错误打进 error 红条）。

test('缺陷1：回合一致时放行', () => {
  assert.equal(isTurnCurrent('turn-1-100', 'turn-1-100'), true)
})

test('缺陷1：回合不一致时判陈旧', () => {
  assert.equal(isTurnCurrent('turn-2-200', 'turn-1-100'), false)
})

test('缺陷1：未提供 expected 时放行（调用点不知道回合身份的路径）', () => {
  assert.equal(isTurnCurrent('turn-2-200', undefined), true)
})

test('缺陷1：槽里没有 activeTurnId 时放行（已收尾，收尾本身是幂等的）', () => {
  assert.equal(isTurnCurrent(undefined, 'turn-1-100'), true)
})

// ── 缺陷 1（前端）：运行世代 createRunEpoch ────────────────────────────
//
// SDK 的 agent_end / agent_settled **不带回合身份**，所以"这条终态事件属于哪一轮"
// 只能靠时间顺序判定：sidecar 的 serialChain 保证 abort 请求在下一轮 prompt 之前
// 完成，因此"abort 之后又派发过新一轮 ⇒ 此刻到达的终态事件必属被 abort 的旧轮"。

test('缺陷1：派发第一轮后未被取代', () => {
  const epoch = createRunEpoch()
  epoch.dispatch('s1')
  assert.equal(epoch.isSuperseded('s1'), false)
})

test('缺陷1：abort 之后没有新派发 → 终态事件仍属当前轮（不得丢弃）', () => {
  const epoch = createRunEpoch()
  epoch.dispatch('s1')
  epoch.markAborted('s1')
  assert.equal(epoch.isSuperseded('s1'), false, '没有新一轮时，迟到终态就是这一轮的收尾')
})

test('缺陷1：abort 之后又派发新一轮 → 旧轮终态必须被丢弃', () => {
  const epoch = createRunEpoch()
  epoch.dispatch('s1')
  epoch.markAborted('s1')
  epoch.dispatch('s1')
  assert.equal(epoch.isSuperseded('s1'), true, '这正是"Stop 后立刻再发一条"的缺陷场景')
})

test('缺陷1：标记必须活到新一轮 agent_start —— 连发两条终态事件都要被丢弃', () => {
  const epoch = createRunEpoch()
  epoch.dispatch('s1')
  epoch.markAborted('s1')
  epoch.dispatch('s1')
  assert.equal(epoch.isSuperseded('s1'), true, '第一条终态事件')
  // 关键：不能在第一次命中时就消费掉标记，否则 agent_settled 会漏网。
  assert.equal(epoch.isSuperseded('s1'), true, '第二条终态事件（agent_settled）同样要被丢弃')
  epoch.clearSuperseded('s1')
  assert.equal(epoch.isSuperseded('s1'), false, '新一轮 agent_start 之后恢复正常收尾')
})

test('缺陷1：世代按会话隔离（中止 A 不影响 B 的收尾）', () => {
  const epoch = createRunEpoch()
  epoch.dispatch('s1')
  epoch.dispatch('s2')
  epoch.markAborted('s1')
  epoch.dispatch('s1')
  assert.equal(epoch.isSuperseded('s1'), true)
  assert.equal(epoch.isSuperseded('s2'), false, 'B 会话完全不受影响（缺陷 5 的行为化防线）')
})

test('缺陷1：从未派发过的会话不会被误判为被取代', () => {
  const epoch = createRunEpoch()
  assert.equal(epoch.isSuperseded('unknown'), false)
  epoch.markAborted('unknown')
  assert.equal(epoch.isSuperseded('unknown'), false, '没有世代基数时不能凭空判陈旧')
})

test('缺陷1：forget 清掉两个表，同 id 复用不会继承旧标记', () => {
  const epoch = createRunEpoch()
  epoch.dispatch('s1')
  epoch.markAborted('s1')
  epoch.dispatch('s1')
  assert.equal(epoch.isSuperseded('s1'), true)
  epoch.forget('s1')
  assert.equal(epoch.isSuperseded('s1'), false, 'closeTab/deleteSession 之后同 id 复用必须干净')
})

// D5（f15bc3a3 对抗性审查确证的真 SURVIVED）：`clearSuperseded` 只能解标记，**绝不许**
// 动世代号。变异 N4 把它实现成 `{ delete abortedAt[id]; delete generations[id] }`，
// 在当时的 51+46+15 条断言上**不可区分**（三套件全绿），而运行时后果是毁灭性的：
// markAborted 的开头是 `const current = generations[id]; if (current === undefined) return`
// ⇒ 该会话此后每次点 Stop 都不留标记，D-A 整套世代守卫对该会话彻底失效。
// 修法是把契约写成行为断言，而不是依靠代码里"看起来只删了一个表"。
test('D5：clearSuperseded 不得动世代号，解标记后仍能中止', () => {
  const epoch = createRunEpoch()
  const gen = epoch.dispatch('s1')
  epoch.markAborted('s1')
  assert.equal(epoch.isAborted('s1'), true, '前提：中止标记已生效')
  epoch.clearSuperseded('s1')
  assert.equal(
    epoch.generationOf('s1'),
    gen,
    'clearSuperseded 动了世代号（变异 N4）：世代号一旦被删，markAborted 会因为 ' +
      '`generations[id] === undefined` 直接 return，此后该会话每次点 Stop 都不留标记，' +
      'D-A 的整套世代守卫对该会话永久失效',
  )
  assert.equal(epoch.isAborted('s1'), false, '解标记后 isAborted 必须回到 false')
  // 关键后半段：解标记之后仍必须能重新中止（这才是"守卫还活着"的证明）。
  epoch.dispatch('s1')
  epoch.markAborted('s1')
  assert.equal(
    epoch.isAborted('s1'),
    true,
    'clearSuperseded 之后 markAborted 不再生效：世代号已被删掉（D5 回归）',
  )
  assert.equal(epoch.generationOf('s1'), gen + 1, '解标记不得影响后续 dispatch 的世代递增')
})

test('缺陷1：dispatch 返回递增世代号且 snapshot 可读（排查用）', () => {
  const epoch = createRunEpoch()
  const a = epoch.dispatch('s1')
  const b = epoch.dispatch('s1')
  assert.ok(b > a)
  assert.equal(epoch.snapshot().generations.s1, b)
})

// ── 缺陷 1 的生命周期回归（App.svelte 事件入口闸门的等价模型）─────────────
//
// 这是本仓库第一次把"派发 → Stop → 立刻再发 → 旧终态迟到 → 新轮 agent_start"
// 这条完整时序写成断言。此前只有孤立的状态断言，于是出现过一个真实的抵消缺陷：
// dispatchTurn 在派发时顺手多写了一句 clearSuperseded(id)，理由是"新一轮已开始"。
// 但派发只代表 prompt 发出，旧轮终态正是在 abort 飞行期间到达的 —— 提前清标记让
// 闸门在这个唯一该起作用的窗口里恒为 false，标记形同虚设（守卫被自己的解除调用抵消）。
// gate() 忠实复刻 App.svelte 事件入口的世代闸门：agent_start 清标记，被取代的轮次
// 一律丢弃 —— **除了** type:'error'（新一轮在 agent_start 之前失败时的唯一信号）。

function makeGate(epoch) {
  const dropped = []
  return {
    dropped,
    /** 返回 'delivered' | 'dropped'，与 App.svelte 事件入口的判据一致。 */
    deliver(id, type) {
      if (type === 'agent_start') {
        epoch.clearSuperseded(id)
        return 'delivered'
      }
      if (epoch.isSuperseded(id)) {
        if (type !== 'error') {
          dropped.push(type)
          return 'dropped'
        }
      }
      return 'delivered'
    },
  }
}

test('缺陷1 生命周期：Stop 后立刻再发一条，旧轮的 agent_end/agent_settled 必须双双被丢弃', () => {
  const epoch = createRunEpoch()
  const gate = makeGate(epoch)

  // 回合 A 派发（dispatchTurn：只 dispatch，**不** clearSuperseded）
  gate.deliver('s1', 'agent_start')
  epoch.dispatch('s1')
  // 用户点 Stop（stop()：markAborted）
  epoch.markAborted('s1')
  // 用户立刻又发一条（dispatchTurn：dispatch —— 事故版本会在这里多一句 clearSuperseded）
  epoch.dispatch('s1')

  // A 的终态事件在 abort 飞行期间迟到：两条都必须被丢弃
  assert.equal(gate.deliver('s1', 'agent_end'), 'dropped', '旧轮 agent_end 被放行 → 新回合被判已结束（缺陷 1 原症状）')
  assert.equal(gate.deliver('s1', 'agent_settled'), 'dropped', '旧轮 agent_settled 被放行 → 半截回复被提交为终态')
  assert.deepEqual(gate.dropped, ['agent_end', 'agent_settled'])

  // 新回合真正开始，标记解除，之后的终态事件正常收尾
  assert.equal(gate.deliver('s1', 'agent_start'), 'delivered')
  assert.equal(gate.deliver('s1', 'turn_end'), 'delivered', '新一轮的正常事件不得被误伤')
  assert.equal(gate.deliver('s1', 'agent_settled'), 'delivered')
})

test('缺陷1 生命周期：反向对照 —— 若派发时提前清标记，旧轮终态即漏网（该写法已被移除）', () => {
  const epoch = createRunEpoch()
  const gate = makeGate(epoch)

  gate.deliver('s1', 'agent_start')
  epoch.dispatch('s1')
  epoch.markAborted('s1')
  epoch.dispatch('s1')
  // 事故版本的 dispatchTurn 额外做了这一步：
  epoch.clearSuperseded('s1')

  assert.equal(
    gate.deliver('s1', 'agent_end'),
    'delivered',
    '这正是被移除的写法会造成的后果：旧轮 agent_end 被当成新回合收尾',
  )
  assert.equal(gate.dropped.length, 0, '标记被提前清掉后，闸门在这个窗口里完全失效')
})

test('缺陷1 生命周期：没有新一轮时，被中止那一轮的终态仍须放行（不能把正常收尾也吃掉）', () => {
  const epoch = createRunEpoch()
  const gate = makeGate(epoch)
  gate.deliver('s1', 'agent_start')
  epoch.dispatch('s1')
  epoch.markAborted('s1')
  // 用户点了 Stop 但没有再发消息：这一轮的收尾必须正常进行
  assert.equal(gate.deliver('s1', 'agent_end'), 'delivered')
  assert.equal(gate.deliver('s1', 'agent_settled'), 'delivered')
})

test('缺陷1 边界：新一轮在 agent_start 之前失败时，sidecar 的 error 事件不得被吞（外部审计缺陷 4）', () => {
  const epoch = createRunEpoch()
  const gate = makeGate(epoch)
  gate.deliver('s1', 'agent_start')
  epoch.dispatch('s1')
  epoch.markAborted('s1')
  // 用户 Stop 后立刻再发一条（新一轮），但它在 preflight 就失败了：
  // SDK 的 _runAgentPrompt 从未进入 ⇒ 没有 agent_start、没有 agent_settled、没有
  // agent_end，前端唯一的信号是 sidecar 在 prompt().catch 里发的 type:'error'。
  epoch.dispatch('s1')
  assert.equal(
    gate.deliver('s1', 'error'),
    'delivered',
    '被取代的轮次吞掉了 error 事件 → running 永久卡住、agent_start 永不到来（缺陷 4）',
  )
  // 与此同时迟到的旧轮终态仍必须被拦住，否则新回合会被误判为已结束
  assert.equal(gate.deliver('s1', 'agent_end'), 'dropped')
  assert.equal(gate.deliver('s1', 'agent_settled'), 'dropped')
  assert.deepEqual(gate.dropped, ['agent_end', 'agent_settled'])
})

// ── isTurnAlive：dispatchTurn 前奏的存活判据（可求值，非字符串断言） ─────

test('isTurnAlive：关标签即视为不存活，无论回合号是否一致', () => {
  assert.equal(isTurnAlive(true, 'turn-1', 'turn-1'), false, '已关闭的会话不得继续跑前奏（缺陷 4）')
  assert.equal(isTurnAlive(true, undefined, 'turn-1'), false)
})

test('isTurnAlive：回合号不一致即视为已被取代', () => {
  assert.equal(isTurnAlive(false, 'turn-2', 'turn-1'), false, 'Stop 后再发一条时旧前奏必须放弃')
  assert.equal(isTurnAlive(false, 'turn-1', 'turn-1'), true, '同一个回合的续体必须继续')
})

test('isTurnAlive：尾部追加恒真常量不得让判据复活（外部审计变异 C4）', () => {
  // 原实现 `!closed && slot === expected` 若被改成 `... || true`，恒为 true。
  // 行为断言直接暴露该差异：这两种输入都必须是 false。
  const mutated = () => true
  assert.equal(isTurnAlive(true, 'turn-1', 'turn-1'), false)
  assert.notEqual(isTurnAlive(true, 'turn-1', 'turn-1'), mutated(), '判据被短路常量污染时行为会变')
  assert.equal(isTurnAlive(false, undefined, 'turn-1'), false)
})

// ── isAborted / generationOf：D-A 与 S-4 的铰链判据（红队 M13/M18/M19 空档）──
//
// 红队报告（确证缺陷 3）实测：全 tests 目录里 `isAborted` 只出现在 session-wiring
// 的一条源码正则里，`generationOf` 只出现在三条源码正则里 —— **没有任何行为断言**。
// 于是三个变异全部 SURVIVED（151/0 全绿）：
//   M13 `session-run.ts:215` `===` → `!==`  ⇒ D-A 完整回归（startedButAborted 恒假，
//        用户点停止后 agent_start 仍把 running 打回 true）
//   M18 `generationOf` 恒返回 0             ⇒ S-4 的 `!==` 守卫恒假、永远放行
//   M19 `generationOf` 恒返回 undefined     ⇒ S-4 守卫恒真提前 return、收尾永不执行
// 这两个函数是"调用形状被正则钉住、语义无人守"的典型，必须在纯逻辑层钉死语义。

test('isAborted：从未标记过 ⇒ false（不能凭空判中止）', () => {
  const epoch = createRunEpoch()
  assert.equal(epoch.isAborted('s1'), false, '没有世代基数时不得判为已中止')
  epoch.dispatch('s1')
  assert.equal(epoch.isAborted('s1'), false, '派发本身不是中止')
})

test('isAborted：标记当代 ⇒ true（D-A 的启动前提）', () => {
  const epoch = createRunEpoch()
  epoch.dispatch('s1')
  epoch.markAborted('s1')
  assert.equal(epoch.isAborted('s1'), true, 'D-A 靠这一条识别"preflight 期被停止、agent_start 还会来"')
})

test('isAborted：世代推进后失效 ⇒ false（标记不得吞掉下一轮）', () => {
  const epoch = createRunEpoch()
  epoch.dispatch('s1')
  epoch.markAborted('s1')
  epoch.dispatch('s1')
  assert.equal(
    epoch.isAborted('s1'),
    false,
    'M13 把这里翻成 true 后，新一轮的 agent_start 会被误当"被中止的旧轮"而早退，running 永远起不来',
  )
})

test('isAborted：重复标记同一代仍是 true（幂等）', () => {
  const epoch = createRunEpoch()
  epoch.dispatch('s1')
  epoch.markAborted('s1')
  epoch.markAborted('s1')
  assert.equal(epoch.isAborted('s1'), true)
})

test('isAborted：forget 之后回到 false（同 id 复用不得继承旧标记）', () => {
  const epoch = createRunEpoch()
  epoch.dispatch('s1')
  epoch.markAborted('s1')
  epoch.forget('s1')
  assert.equal(epoch.isAborted('s1'), false, 'closeTab/deleteSession 之后同 id 复用必须是干净状态')
})

test('isAborted：按会话隔离（中止 A 不影响 B）', () => {
  const epoch = createRunEpoch()
  epoch.dispatch('s1')
  epoch.dispatch('s2')
  epoch.markAborted('s1')
  assert.equal(epoch.isAborted('s1'), true)
  assert.equal(epoch.isAborted('s2'), false)
})

test('isAborted 与 isSuperseded 互补：中止后未再派发 = aborted 且非 superseded', () => {
  const epoch = createRunEpoch()
  epoch.dispatch('s1')
  epoch.markAborted('s1')
  // D-A 的判定窗口正是这一格：用户的 Stop 已记下，但新一轮还没派发。
  assert.equal(epoch.isAborted('s1'), true)
  assert.equal(epoch.isSuperseded('s1'), false)
  // 派发新一轮后翻转：标记仍在中止态（isAborted false），取代态成立。
  epoch.dispatch('s1')
  assert.equal(epoch.isAborted('s1'), false)
  assert.equal(epoch.isSuperseded('s1'), true, '两者必须是互斥的两个窗口，不能同时为真')
})

test('generationOf：从未派发 ⇒ undefined', () => {
  const epoch = createRunEpoch()
  assert.equal(epoch.generationOf('s1'), undefined, 'S-4 的守卫依赖"没有世代就是 undefined"这一事实')
})

test('generationOf：返回数值且逐次递增', () => {
  const epoch = createRunEpoch()
  const a = epoch.generationOf('s1')
  assert.equal(a, undefined)
  const first = epoch.dispatch('s1')
  assert.equal(typeof first, 'number')
  assert.equal(epoch.generationOf('s1'), first, 'generationOf 必须读回 dispatch 的返回值，不能是常量')
  epoch.dispatch('s1')
  assert.ok(epoch.generationOf('s1') > first, 'M18 恒返回 0 会让 S-4 的 `!==` 守卫永远为假、守卫失效')
})

test('generationOf：同一世代内不变（await 期间无人派发时必须相等）', () => {
  const epoch = createRunEpoch()
  const generation = epoch.dispatch('s1')
  // stop() 在 await request('abort') 之前快照世代，回来后再比对；期间无人派发
  // ⇒ 两者必须相等，否则停下来的运行永远清理不掉。
  assert.equal(epoch.generationOf('s1'), generation)
  assert.equal(epoch.generationOf('s1'), generation)
})

test('generationOf：forget 之后回到 undefined（S-4 守卫不再放行）', () => {
  const epoch = createRunEpoch()
  epoch.dispatch('s1')
  epoch.forget('s1')
  assert.equal(
    epoch.generationOf('s1'),
    undefined,
    'M19 恒返回 undefined 会让 stop 的 `.then` 守卫恒真提前 return，running 永远不清',
  )
})

test('generationOf：按会话隔离且独立递增', () => {
  const epoch = createRunEpoch()
  const a1 = epoch.dispatch('s1')
  const b1 = epoch.dispatch('s2')
  const a2 = epoch.dispatch('s1')
  assert.notEqual(a1, b1, '不同会话各自持有世代号')
  assert.ok(a2 > a1)
  assert.equal(epoch.generationOf('s2'), b1, 'A 的重新派发不得推进 B 的世代')
})
