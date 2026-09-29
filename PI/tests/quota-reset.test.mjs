// 额度重置估算单测（2-8/U4）
//
// 核心契约：周期估算的边界正确（月尾/周一/跨年）、真实字段优先透传、
// 无周期配置时不虚构时间。
import test from 'node:test'
import assert from 'node:assert/strict'
import { formatResetCountdown, nextResetFor, withResetEstimate } from '../src/quota-reset.ts'

test('daily：明天 0 点', () => {
  const now = new Date(2026, 8, 28, 15, 30) // 2026-09-28 15:30 周一
  const next = nextResetFor('daily', now)
  assert.deepEqual(next, new Date(2026, 8, 29, 0, 0))
})

test('weekly：下周一 0 点（周一当天查=下周一，不是今天）', () => {
  const monday = new Date(2026, 8, 28, 10, 0) // 周一
  const next = nextResetFor('weekly', monday)
  assert.equal(next.getDay(), 1, '结果必须是周一')
  assert.deepEqual(next, new Date(2026, 9, 5, 0, 0), '周一查 = 下周一')
  // 周六查 → 两天后的周一
  const saturday = new Date(2026, 9, 3, 22, 0)
  assert.deepEqual(nextResetFor('weekly', saturday), new Date(2026, 9, 5, 0, 0))
})

test('monthly：下月 1 日 0 点（跨年正确）', () => {
  const dec31 = new Date(2026, 11, 31, 23, 0)
  assert.deepEqual(nextResetFor('monthly', dec31), new Date(2027, 0, 1, 0, 0), '12 月 31 日查 → 明年 1 月 1 日')
  const jan15 = new Date(2026, 0, 15, 12, 0)
  assert.deepEqual(nextResetFor('monthly', jan15), new Date(2026, 1, 1, 0, 0))
})

test('none/未配置：返回 null（不虚构）', () => {
  assert.equal(nextResetFor('none', new Date()), null)
  assert.equal(nextResetFor(undefined, new Date()), null)
})

test('withResetEstimate：接口提供真实 resetAt 时优先（不按周期估算）', () => {
  const now = new Date(2026, 8, 28, 12, 0)
  const result = withResetEstimate({ provider: 'x', cycle: 'monthly', resetAt: '2026-10-15T00:00:00Z' }, now)
  assert.equal(result.nextResetAt, '2026-10-15T00:00:00.000Z', '真实字段透传')
  assert.equal(result.cycleElapsedPercent, null, '真实字段无周期长度，百分比未知')
})

test('withResetEstimate：无真实字段时按周期估算', () => {
  const now = new Date(2026, 8, 28, 12, 0) // 9 月 28 日（30 天月的第 28 天）
  const result = withResetEstimate({ provider: 'x', cycle: 'monthly' }, now)
  assert.deepEqual(new Date(result.nextResetAt), new Date(2026, 9, 1))
  assert.ok(result.cycleElapsedPercent > 85 && result.cycleElapsedPercent < 100, `9/28 应已流逝 85-100%: ${result.cycleElapsedPercent}`)
})

test('withResetEstimate：无效 resetAt 字符串回退到周期估算', () => {
  const now = new Date(2026, 8, 28, 12, 0)
  const result = withResetEstimate({ provider: 'x', cycle: 'daily', resetAt: 'not-a-date' }, now)
  assert.deepEqual(new Date(result.nextResetAt), new Date(2026, 8, 29))
})

test('withResetEstimate：无周期配置 → 全 null', () => {
  const result = withResetEstimate({ provider: 'x' }, new Date())
  assert.equal(result.nextResetAt, null)
  assert.equal(result.msUntilReset, null)
  assert.equal(result.cycleElapsedPercent, null)
})

test('formatResetCountdown：人类可读', () => {
  assert.equal(formatResetCountdown(null), '—')
  assert.equal(formatResetCountdown(0), '已重置')
  assert.equal(formatResetCountdown(-100), '已重置')
  assert.equal(formatResetCountdown(3 * 86400000 + 5 * 3600000), '3 天 5 小时后')
  assert.equal(formatResetCountdown(2 * 3600000 + 30 * 60000), '2 小时 30 分后')
  assert.equal(formatResetCountdown(45 * 60000), '45 分钟后')
})
