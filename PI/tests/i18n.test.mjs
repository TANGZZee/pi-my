// i18n 框架单测（2-11 第一阶段）
//
// 核心契约：回退链（当前语言 → zh → key）、插值、字典合并不丢键、
// 语言切换广播、订阅取消。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getLocale,
  onLocaleChange,
  registerLocale,
  setLocale,
  t,
} from '../src/i18n.ts'

test('内置字典：zh/en 核心键齐全且对齐', () => {
  // 核心域的键在两种语言里必须都有（漏一个是 UI 半截）
  const coreKeys = [
    'common.copy', 'common.copied', 'common.cancel', 'common.retry',
    'live.thinking', 'live.working', 'live.waiting',
    'ctx.title', 'ctx.tokensTotal', 'ctx.quotaTitle',
    'queue.title', 'queue.up', 'queue.remove',
    'branch.worktreeFork',
    'retry.line',
  ]
  setLocale('en')
  for (const key of coreKeys) {
    assert.notEqual(t(key), key, `en 缺少键: ${key}`)
  }
  setLocale('zh')
  for (const key of coreKeys) {
    assert.notEqual(t(key), key, `zh 缺少键: ${key}`)
  }
})

test('回退链：en 缺键回退 zh，zh 也缺则回显 key', () => {
  setLocale('en')
  registerLocale('zh', { 'only.zh': '只有中文' })
  assert.equal(t('only.zh'), '只有中文', 'en 缺 → 回退 zh')
  assert.equal(t('totally.missing.key'), 'totally.missing.key', '全缺 → 回显 key')
  setLocale('zh')
})

test('插值：{name} 占位替换', () => {
  setLocale('zh')
  assert.equal(t('queue.title', { n: 3 }), '排队 3 条')
  assert.equal(t('branch.nav', { i: 2, n: 5 }), '分支 2/5')
  assert.equal(t('retry.line', { attempt: 2, reason: '网络波动' }), '自动重试（第 2 次）· 网络波动')
})

test('切换广播与订阅取消', () => {
  let calls = 0
  const unsub = onLocaleChange(() => calls++)
  setLocale(getLocale() === 'zh' ? 'en' : 'zh') // 第一次：+1
  const afterFirst = calls
  unsub()
  setLocale(getLocale()) // 同语言不广播
  assert.equal(calls, afterFirst, '同语言切换不应广播')
  setLocale(getLocale() === 'zh' ? 'en' : 'zh') // 已取消订阅：不再计数
  assert.equal(calls, afterFirst, '取消后不应再收到广播')
})

test('字典合并：registerLocale 后注册的键优先，不覆盖其他键', () => {
  registerLocale('zh', { 'merge.a': '甲' })
  registerLocale('zh', { 'merge.a': '甲二', 'merge.b': '乙' })
  assert.equal(t('merge.a'), '甲二', '后注册覆盖同键')
  assert.equal(t('merge.b'), '乙', '不影响其他键')
})
