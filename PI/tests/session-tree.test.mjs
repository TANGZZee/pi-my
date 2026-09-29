// 会话树构建单测（0-5 抽取自 App.svelte）
//
// 覆盖重点：分支导航（"分支 N/M"）与会话树缩进的核心语义。
// 旧实现内嵌在 App.svelte 里无法测试；抽取后这些不变量第一次可被验证。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  activeBranchSiblingsOf,
  buildSessionRows,
  sameSessionFile,
  sessionParentId,
  sessionRootId,
} from '../src/session-tree.ts'

const session = (over = {}) => ({ id: 's', title: '会话', ...over })

test('sameSessionFile：斜杠与大小写不敏感（Windows 路径语义）', () => {
  assert.equal(sameSessionFile('C:\\A\\B.jsonl', 'c:/a/b.jsonl'), true)
  assert.equal(sameSessionFile('C:\\A\\B.jsonl', 'C:\\A\\C.jsonl'), false)
  assert.equal(sameSessionFile(undefined, 'x'), false)
  assert.equal(sameSessionFile('x', undefined), false)
})

test('sessionParentId：branchParentId 优先于 parentFile 反查', () => {
  const all = [
    session({ id: 'root', file: 'r.jsonl' }),
    session({ id: 'branch', file: 'b.jsonl', parentFile: 'r.jsonl', branchParentId: 'other' }),
  ]
  assert.equal(sessionParentId(all[1], all), 'other', '显式分支父优先')
})

test('sessionParentId：parentFile 反查（斜杠/大小写不敏感）', () => {
  const all = [
    session({ id: 'root', file: 'C:\\Sessions\\r.jsonl' }),
    session({ id: 'child', file: 'child.jsonl', parentFile: 'c:/sessions/R.JSONL' }),
  ]
  assert.equal(sessionParentId(all[1], all), 'root')
})

test('sessionParentId：父会话不在集合中时返回空（提升为顶层）', () => {
  const all = [session({ id: 'orphan', parentFile: 'missing.jsonl' })]
  assert.equal(sessionParentId(all[0], all), '')
})

test('sessionRootId：沿父链到根，且带环保护', () => {
  const all = [
    session({ id: 'a', file: 'a.jsonl' }),
    session({ id: 'b', file: 'b.jsonl', parentFile: 'a.jsonl' }),
    session({ id: 'c', file: 'c.jsonl', parentFile: 'b.jsonl' }),
  ]
  assert.equal(sessionRootId(all[2], all), 'a')
  // 环：a→b→a
  const cyclic = [
    session({ id: 'a', file: 'a.jsonl', parentFile: 'b.jsonl' }),
    session({ id: 'b', file: 'b.jsonl', parentFile: 'a.jsonl' }),
  ]
  assert.equal(sessionRootId(cyclic[0], cyclic), 'a', '环不得死循环')
})

test('buildSessionRows：正确的深度与 branch 标记', () => {
  const rows = buildSessionRows([
    session({ id: 'root', file: 'r.jsonl', createdAt: 1 }),
    session({ id: 'child1', file: 'c1.jsonl', parentFile: 'r.jsonl', createdAt: 2 }),
    session({ id: 'child2', file: 'c2.jsonl', parentFile: 'r.jsonl', createdAt: 3 }),
    session({ id: 'grand', file: 'g.jsonl', parentFile: 'c1.jsonl', createdAt: 4 }),
  ])
  assert.deepEqual(
    rows.map((row) => `${row.session.id}@${row.depth}${row.branch ? 'B' : ''}`),
    ['root@0', 'child1@1B', 'grand@2B', 'child2@1B'],
    '深度与顺序应符合树结构',
  )
})

test('buildSessionRows：父不可见时子会话提升为顶层（不留孤儿）', () => {
  const rows = buildSessionRows([
    session({ id: 'child', file: 'c.jsonl', parentFile: 'gone.jsonl' }),
  ])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].depth, 0, '孤儿应提升到深度 0')
  assert.equal(rows[0].branch, true, '但 branch 标记保留（UI 仍显示分支图标）')
})

test('buildSessionRows：归档的父会话其子会话提升', () => {
  const rows = buildSessionRows([
    session({ id: 'root', file: 'r.jsonl', archived: true }),
    session({ id: 'child', file: 'c.jsonl', parentFile: 'r.jsonl' }),
  ])
  // 父在集合里但归档了 —— 仍可找到父（visibleIds 含它），所以不提升
  // 这是现有语义：归档父的子会话仍在树下。锁定该行为。
  assert.equal(rows[0].session.id, 'root')
  assert.equal(rows[1].session.id, 'child')
  assert.equal(rows[1].depth, 1)
})

test('buildSessionRows：环不会死循环或重复输出', () => {
  const rows = buildSessionRows([
    session({ id: 'a', file: 'a.jsonl', parentFile: 'b.jsonl' }),
    session({ id: 'b', file: 'b.jsonl', parentFile: 'a.jsonl' }),
  ])
  assert.equal(rows.length, 2, '环中每个会话只输出一次')
})

test('buildSessionRows：空集合返回空数组', () => {
  assert.deepEqual(buildSessionRows([]), [])
})

test('activeBranchSiblingsOf：同一根下的可见兄弟按创建序排列', () => {
  const all = [
    session({ id: 'r1', file: 'r1.jsonl', createdAt: 1 }),
    session({ id: 'b1', file: 'b1.jsonl', parentFile: 'r1.jsonl', createdAt: 2 }),
    session({ id: 'b2', file: 'b2.jsonl', parentFile: 'r1.jsonl', createdAt: 3 }),
    session({ id: 'r2', file: 'r2.jsonl', createdAt: 4 }), // 另一根
    session({ id: 'archived-branch', file: 'ab.jsonl', parentFile: 'r1.jsonl', createdAt: 5, archived: true }),
  ]
  const siblings = activeBranchSiblingsOf(all, 'b2')
  assert.deepEqual(siblings.map((s) => s.id), ['r1', 'b1', 'b2'], '同根可见兄弟（含根本身），归档的排除')
})

test('activeBranchSiblingsOf：活动会话不存在时返回空', () => {
  assert.deepEqual(activeBranchSiblingsOf([session({ id: 'a' })], 'nope'), [])
})
