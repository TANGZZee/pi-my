// U4 状态栏面板数据格式化单测（session-state.ts）
//
// 这些格式化直接决定用户在面板里看到的数字；缺字段/NaN 的兜底是重点。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  contextPercent,
  formatCacheRate,
  formatCost,
  formatPercent,
  formatTokens,
  safeNum,
  stateSummary,
} from '../src/session-state.ts'

test('safeNum：NaN/负数/非数字 → 0，正常值保留', () => {
  assert.equal(safeNum(NaN), 0)
  assert.equal(safeNum(-5), 0)
  assert.equal(safeNum('abc'), 0)
  assert.equal(safeNum(undefined), 0)
  assert.equal(safeNum(null), 0)
  assert.equal(safeNum(42), 42)
  assert.equal(safeNum('42'), 42)
})

test('formatTokens：万位缩写与千分位', () => {
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(8432), '8,432')
  assert.equal(formatTokens(12000), '1.2万')
  assert.equal(formatTokens(150000), '15万', '10 万以上不留小数')
  assert.equal(formatTokens(undefined), '0')
})

test('formatCost：零显示占位，小额保留 4 位，常规 2 位', () => {
  assert.equal(formatCost(0), '—')
  assert.equal(formatCost(undefined), '—')
  assert.equal(formatCost(0.0032), '$0.0032')
  assert.equal(formatCost(1.256), '$1.26')
})

test('formatPercent：钳到 0-100，窗口为 0 时返回 null', () => {
  assert.equal(formatPercent(500, 1000), 50)
  assert.equal(formatPercent(1500, 1000), 100, '超窗钳到 100')
  assert.equal(formatPercent(0, 1000), 0)
  assert.equal(formatPercent(100, 0), null, '无窗口容量 → null（UI 显示—）')
  assert.equal(formatPercent(undefined, undefined), null)
})

test('formatCacheRate：0 显示占位，正数转百分比', () => {
  assert.equal(formatCacheRate(0), '—')
  assert.equal(formatCacheRate(undefined), '—')
  assert.equal(formatCacheRate(0.726), '73%')
})

test('contextPercent：优先本地口径，否则回退 SDK contextUsage', () => {
  assert.equal(
    contextPercent({ currentContext: 300, window: 1000 }),
    30,
    '本地口径优先',
  )
  assert.equal(
    contextPercent({
      window: 0,
      stats: { contextUsage: { tokens: 250, window: 1000 } },
    }),
    25,
    '本地缺失时回退 SDK',
  )
  assert.equal(contextPercent({}), null, '都没有 → null')
})

test('stateSummary：完整快照 → 四行摘要', () => {
  const summary = stateSummary({
    sessionId: 's',
    mode: 'ask',
    running: false,
    model: { provider: 'Jy', id: 'deepseek-flash' },
    thinkingLevel: 'high',
    steering: [],
    followUp: ['排队消息'],
    stats: {
      totalMessages: 12,
      tokens: { input: 1000, output: 500, cacheRead: 800, cacheWrite: 100, total: 2400 },
      cost: 0.0125,
      contextUsage: { tokens: 1500, window: 4000 },
    },
    currentContext: 1500,
    window: 4000,
    cacheHitRate: 0.444,
    tools: ['read', 'bash'],
  })
  assert.equal(summary.mode, 'ask')
  assert.equal(summary.model, 'Jy/deepseek-flash')
  assert.equal(summary.thinking, 'high')
  assert.equal(summary.totalTokens, '2,400')
  assert.equal(summary.cacheRead, '800')
  assert.equal(summary.cacheRate, '44%')
  assert.equal(summary.cost, '$0.01')
  assert.equal(summary.contextPercent, 38)
  assert.equal(summary.queued, 1, 'steering + followUp 之和')
})

test('stateSummary：空快照不抛错，全部走兜底', () => {
  const summary = stateSummary({ sessionId: 's', mode: 'ask', running: false })
  assert.equal(summary.totalTokens, '0')
  assert.equal(summary.cost, '—')
  assert.equal(summary.model, null)
  assert.equal(summary.contextPercent, null)
  assert.equal(summary.contextWindow, null)
  assert.equal(summary.queued, 0)
})

test('stateSummary：运行中标记透传', () => {
  assert.equal(stateSummary({ sessionId: 's', mode: 'ask', running: true }).running, true)
  assert.equal(stateSummary({ sessionId: 's', mode: 'ask', running: false }).running, false)
})
