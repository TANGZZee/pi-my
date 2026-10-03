// 终态兜底仲裁器单测（F4，用户 m11305 报障：「用不可用模型发消息后界面永久停在 Thinking」）
//
// 这条防线的全部价值在于「什么时候不该开火」：正常重试、正常但慢的模型、
// 用户主动中止，都绝不能被它误判成失败。所以这里用假时钟逐条验边界，
// 而不是在 Svelte 组件里靠源码文本正则（那已被证明是假防线）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { SETTLE_FALLBACK_TEXT, SETTLE_GRACE_MS, createSettleArbiter } from '../src/run-settle.ts'

/**
 * 假时钟：记录挂起/撤销，支持手动推进与"只推进到某个时刻"。
 * 返回的 controls 让测试能观察 handle 是否被真正 unschedule（泄漏 vs 撤销）。
 */
function createClock() {
  let nextHandle = 1
  let now = 0
  const timers = new Map()
  const scheduled = []
  const unscheduled = []

  const clock = {
    schedule(callback, ms) {
      const handle = nextHandle++
      timers.set(handle, { at: now + ms, callback })
      scheduled.push({ handle, ms })
      return handle
    },
    unschedule(handle) {
      unscheduled.push(handle)
      timers.delete(handle)
    },
    /**
     * 推进到 now + ms，循环取最早到期的计时器依次触发，直到没有 <= target 的为止。
     *
     * ⚠️ 与早期注释相反：回调**内部**新挂的计时器，只要到期时刻 <= target，**会被同一轮
     * 推进带到**（外层 for(;;) 每轮重扫 timers）。第六轮审查用 probe/clock-advance.mjs
     * 实测：一个 ms=0 的新计时器在回调里挂上后，同一次 advance 就产生了
     * fired=["A@100","B@100"]。这正是不需要在 advance 里排除新计时器的原因 ——
     * 但写测试时别指望"同轮新挂的一定不触发"。
     */
    advance(ms) {
      const target = now + ms
      for (;;) {
        let pick = null
        for (const [handle, timer] of timers) {
          if (timer.at > target) continue
          if (!pick || timer.at < pick.timer.at || (timer.at === pick.timer.at && handle < pick.handle)) {
            pick = { handle, timer }
          }
        }
        if (!pick) break
        timers.delete(pick.handle)
        now = pick.timer.at
        pick.timer.callback()
      }
      now = target
    },
    pendingTimers: () => timers.size,
    now: () => now,
    scheduled,
    unscheduled,
  }
  return clock
}

function createHarness() {
  const clock = createClock()
  const fired = []
  const arbiter = createSettleArbiter({
    onFire: (id, raw) => fired.push({ id, raw }),
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  })
  return { arbiter, fired, clock }
}

// ── 不该开火的路径（误报就是比原缺陷更糟的回归） ─────────────────────

test('没有错误文本时不挂计时器：正常但很慢的模型绝不能误报', () => {
  const { arbiter, fired, clock } = createHarness()
  arbiter.arm('s1', '')
  arbiter.arm('s1', '   ')
  arbiter.arm('s1', undefined)
  assert.equal(arbiter.size(), 0)
  assert.equal(arbiter.pending('s1'), false)
  assert.equal(clock.scheduled.length, 0)
  clock.advance(60_000)
  assert.deepEqual(fired, [])
})

test('宽限期内收到任何事件（cancel）就不开火', () => {
  const { arbiter, fired, clock } = createHarness()
  arbiter.arm('s1', '402 余额不足')
  assert.equal(arbiter.pending('s1'), true)
  arbiter.cancel('s1')
  assert.equal(arbiter.pending('s1'), false)
  clock.advance(SETTLE_GRACE_MS * 3)
  assert.deepEqual(fired, [])
})

test('8 秒是固定的宽限常量，且远短于 180 秒看门狗', () => {
  assert.equal(SETTLE_GRACE_MS, 8_000)
  assert.equal(SETTLE_GRACE_MS < 180_000, true)
})

test('取消过的旧计时器即使漏掉 unschedule 也不能顶掉新一次挂起', () => {
  const { arbiter, fired, clock } = createHarness()
  // 模拟 unschedule 失效：直接不删计时器，看 token 守卫能否救回来。
  const leaked = createSettleArbiter({
    onFire: (id, raw) => fired.push({ id, raw }),
    schedule: clock.schedule,
    unschedule: () => {},
  })
  leaked.arm('s1', '第一条错误')
  leaked.arm('s1', '第二条错误') // 重新计时，第一条的 handle 泄漏但仍会在 8s 时到期
  clock.advance(SETTLE_GRACE_MS)
  assert.equal(fired.length, 1, '陈旧回调只能被丢弃，正确的那条只允许开火一次')
  assert.equal(fired[0].raw, '第二条错误')
  assert.equal(leaked.pending('s1'), false)
  clock.advance(SETTLE_GRACE_MS * 2)
  assert.equal(fired.length, 1)

  // 同一时刻的另一个仲裁器（未被泄漏计时器污染）作为对照
  assert.equal(arbiter.size(), 0)
})

// 上面那条测试**杀不掉**删掉 token 守卫的变异（第四轮审查实测 M3/M4 SURVIVED）：
// 两次 arm 发生在**同一时刻**（中间没有 advance），泄漏的旧计时器与新计时器同刻到期，
// 假时钟按 handle 升序先跑旧的 —— 而它 `entries.get(id)` 取到的正是**新的**那条 entry，
// 于是文本、fired.length、pending 三处断言全部满足。两种实现的可观测行为完全相同，
// 场景本身没有把二者区分开。修法：让两次 arm **错开时间**，"陈旧计时器到点的那一刻
// 绝不能开火"才变成一条真正承重的断言。

test('错开时间：陈旧计时器到点时新一次挂起仍在等待，绝不能提前开火', () => {
  const clock = createClock()
  const fired = []
  const arbiter = createSettleArbiter({
    onFire: (id, raw) => fired.push({ id, raw, at: clock.now() }),
    schedule: clock.schedule,
    // 模拟 unschedule 彻底失效：旧计时器一定泄漏，只能靠 token 守卫救回来。
    unschedule: () => {},
  })
  arbiter.arm('s1', '旧错误') // 旧计时器到期时刻 = 8000
  clock.advance(4_000) // now = 4000
  arbiter.arm('s1', '新错误') // 新计时器到期时刻 = 12000
  clock.advance(4_000) // now = 8000：泄漏的旧计时器**正好到点**
  assert.deepEqual(
    fired,
    [],
    '旧计时器到点时新一次挂起仍在等待：它必须被 token 守卫丢弃，绝不能替新那条开火',
  )
  assert.equal(arbiter.pending('s1'), true, '新一次挂起仍应存在，不能被陈旧回调摘掉')
  clock.advance(4_000) // now = 12000：真正该开火的那次
  assert.deepEqual(
    fired.map((item) => item.raw),
    ['新错误'],
    '只有新一次的挂起允许开火，且必须交回新那条错误文本',
  )
  assert.equal(arbiter.pending('s1'), false)
})

test('陈旧计时器不得抢先消费掉新一次挂起（防"提前收尾"）', () => {
  const clock = createClock()
  const fired = []
  const arbiter = createSettleArbiter({
    onFire: (id, raw) => fired.push({ id, raw }),
    schedule: clock.schedule,
    unschedule: () => {},
  })
  arbiter.arm('s1', '旧错误')
  clock.advance(7_000)
  arbiter.arm('s1', '新错误')
  clock.advance(1_000) // now = 8000，旧计时器到点
  assert.equal(fired.length, 0, '旧计时器到点不得开火（否则等于把宽限期从 8 秒偷偷缩短）')
  clock.advance(7_000) // now = 15000，新计时器到点
  assert.deepEqual(fired.map((item) => item.raw), ['新错误'])
  assert.equal(fired.length, 1)
})

// ── 该开火的路径 ───────────────────────────────────────────────────

test('宽限期走到头且期间没有任何事件时开火，并交回当初的错误文本', () => {
  const { arbiter, fired, clock } = createHarness()
  arbiter.arm('s1', '  404 404 page not found  ')
  clock.advance(SETTLE_GRACE_MS - 1)
  assert.deepEqual(fired, [], '差一毫秒都不能提前开火')
  assert.equal(arbiter.pending('s1'), true)
  clock.advance(1)
  assert.deepEqual(fired, [{ id: 's1', raw: '404 404 page not found' }])
  assert.equal(arbiter.pending('s1'), false, '开火后必须自行摘除，避免重复回调')
})

test('开火后再次 advance 不会重复开火', () => {
  const { arbiter, fired, clock } = createHarness()
  arbiter.arm('s1', 'boom')
  clock.advance(SETTLE_GRACE_MS * 5)
  assert.equal(fired.length, 1)
})

test('多个会话各自独立计时，互不干扰', () => {
  const { arbiter, fired, clock } = createHarness()
  arbiter.arm('s1', '错误一')
  clock.advance(4_000)
  arbiter.arm('s2', '错误二')
  assert.equal(arbiter.size(), 2)
  clock.advance(4_000) // s1 到点，s2 还差 4 秒
  assert.deepEqual(fired, [{ id: 's1', raw: '错误一' }])
  assert.equal(arbiter.pending('s2'), true)
  clock.advance(4_000)
  assert.deepEqual(
    fired.map((item) => item.id),
    ['s1', 's2']
  )
  assert.equal(arbiter.size(), 0)
})

test('重复 arm 重新计时：较新的错误文本胜出，旧的被 unschedule', () => {
  const { arbiter, fired, clock } = createHarness()
  arbiter.arm('s1', '旧错误')
  const firstHandle = clock.scheduled[0].handle
  clock.advance(7_000)
  arbiter.arm('s1', '新错误')
  assert.equal(arbiter.size(), 1, '重复 arm 绝不能留下两条计时器')
  assert.ok(clock.unscheduled.includes(firstHandle), '旧 handle 必须被显式撤销')
  clock.advance(7_999)
  assert.deepEqual(fired, [], '重新计时后要再等满一个宽限期')
  clock.advance(1)
  assert.deepEqual(fired, [{ id: 's1', raw: '新错误' }])
})

test('可以自定义宽限期，且不影响默认值', () => {
  const { arbiter, fired, clock } = createHarness()
  arbiter.arm('s1', '短宽限', 100)
  clock.advance(99)
  assert.deepEqual(fired, [])
  clock.advance(1)
  assert.deepEqual(fired, [{ id: 's1', raw: '短宽限' }])
  assert.equal(SETTLE_GRACE_MS, 8_000)
})

test('cancelAll 撤销全部（组件销毁 / 侧车重启时的兜底）', () => {
  const { arbiter, fired, clock } = createHarness()
  arbiter.arm('s1', 'e1')
  arbiter.arm('s2', 'e2')
  arbiter.arm('s3', 'e3')
  assert.equal(arbiter.size(), 3)
  arbiter.cancelAll()
  assert.equal(arbiter.size(), 0)
  assert.equal(clock.pendingTimers(), 0, 'cancelAll 必须真正 unschedule，不能只是清表')
  clock.advance(SETTLE_GRACE_MS * 2)
  assert.deepEqual(fired, [])
})

test('cancel 不存在的会话是安全的空操作', () => {
  const { arbiter, fired, clock } = createHarness()
  arbiter.cancel('never-armed')
  assert.equal(arbiter.size(), 0)
  clock.advance(SETTLE_GRACE_MS)
  assert.deepEqual(fired, [])
})

test('开火回调里再调 cancel / pending 不会重入或留下脏状态', () => {
  const clock = createClock()
  const seen = []
  const arbiter = createSettleArbiter({
    onFire: (id) => {
      seen.push({ id, pending: arbiter.pending(id), size: arbiter.size() })
      arbiter.cancel(id)
    },
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  })
  arbiter.arm('s1', 'boom')
  clock.advance(SETTLE_GRACE_MS)
  assert.deepEqual(seen, [{ id: 's1', pending: false, size: 0 }], '回调内必须已经看不到自己')
})

// ── 与调用方约定的文案 ─────────────────────────────────────────────

test('兜底文案明确说明"事件链中断 + 已按失败收尾"，且不与真实错误混淆', () => {
  assert.match(SETTLE_FALLBACK_TEXT, /终态事件没有到达界面/)
  assert.match(SETTLE_FALLBACK_TEXT, /已按失败收尾/)
  assert.match(SETTLE_FALLBACK_TEXT, /重试/)
  assert.notEqual(SETTLE_FALLBACK_TEXT.trim(), '')
})
