// 队列 CAS 单测（2-4）
//
// 核心契约：并发写入方的丢更新必须被拦下——
//   - revision 不匹配（stale）→ 拒绝
//   - 重排/移除时的 id 全集校验 → 防止"复活"已出队的项
import test from 'node:test'
import assert from 'node:assert/strict'
import { casRemove, casReorder, casReplace } from '../src/queue-cas.ts'

const item = (id) => ({ id, text: `内容 ${id}` })
const queue = () => [item('a'), item('b'), item('c')]

test('casReplace：revision 匹配才生效并递增', () => {
  const r = casReplace(queue(), 3, 3, (items) => [...items, item('d')])
  assert.equal(r.ok, true)
  assert.equal(r.revision, 4)
  assert.equal(r.value.length, 4)
})

test('casReplace：revision 不匹配（stale）→ 拒绝且返回当前值', () => {
  const current = queue()
  const r = casReplace(current, 5, 3, (items) => [...items, item('d')])
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'stale')
  assert.equal(r.value, current, '拒绝时返回当前数组（调用方可展示冲突）')
})

test('casReorder：相邻交换正确', () => {
  const r = casReorder(queue(), 2, 2, 1, 1, ['a', 'b', 'c'])
  assert.equal(r.ok, true)
  assert.deepEqual(r.value.map((i) => i.id), ['a', 'c', 'b'])
  assert.equal(r.revision, 3)
})

test('casReorder：越界拒绝', () => {
  assert.equal(casReorder(queue(), 1, 1, 2, 1, ['a', 'b', 'c']).ok, false)
  assert.equal(casReorder(queue(), 1, 1, 0, -1, ['a', 'b', 'c']).ok, false)
})

test('casReorder：id 全集不一致拒绝（防"复活"已出队的项）', () => {
  // 调用方读到的旧队列含 d，但当前队列已被别人移除了 d
  const current = [item('a'), item('b')]
  const r = casReorder(current, 4, 4, 0, 1, ['a', 'b', 'd'])
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'not-permutation')
  assert.deepEqual(r.value.map((i) => i.id), ['a', 'b'], '不得改动当前队列')
})

test('casReorder：同长但内容不同的 id 集也拒绝', () => {
  const current = [item('a'), item('x'), item('c')]
  const r = casReorder(current, 2, 2, 0, 1, ['a', 'b', 'c'])
  assert.equal(r.ok, false, 'b→x 的替换必须被 id 全集校验拦下')
})

test('casRemove：按 id 移除', () => {
  const r = casRemove(queue(), 1, 1, 'b')
  assert.equal(r.ok, true)
  assert.deepEqual(r.value.map((i) => i.id), ['a', 'c'])
})

test('casRemove：id 不存在拒绝', () => {
  const r = casRemove(queue(), 1, 1, 'zzz')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'not-permutation')
})

test('casRemove：stale revision 拒绝', () => {
  const r = casRemove(queue(), 7, 6, 'b')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'stale')
})

test('CAS 并发时序还原：drain 与用户移除竞争', () => {
  // 时序：用户读到 rev=2 队列 [a,b,c] → drain 出队 a（rev=3, [b,c]）→
  // 用户的"移除 c"操作（基于 rev=2）到达 → 必须 stale 拒绝
  let revision = 2
  let current = queue()
  // drain：
  const drainSlot = { revision, queue: current }
  const [, ...rest] = drainSlot.queue
  current = rest
  revision += 1
  // 用户移除（stale）：
  const user = casRemove(current, revision, 2, 'c')
  assert.equal(user.ok, false)
  assert.equal(user.reason, 'stale')
  assert.deepEqual(current.map((i) => i.id), ['b', 'c'], 'c 不得被旧操作误删')
})
