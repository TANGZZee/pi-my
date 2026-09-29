// 队列乐观并发（2-4，思路移植自 pi-agent-desktop 的 queue CAS）
//
// 问题：队列有多个写入方（上移/下移/移除按钮、drain 出队、watchdog 自动清空），
// 都基于"读 slot → patch slot"——两次渲染之间发生两次操作会互相覆盖（丢更新）。
//
// 方案：revision 乐观并发（CAS）。
//   - 每次变更必须带上读到的 revision；不匹配说明期间别人改过 → 拒绝本次操作
//   - 重排类操作额外校验"待重排 id 全集一致"，防止重排一个已经变化的队列
// 这里提供纯函数实现（可单测），App.svelte 的 slot 上存 revision 计数。
export interface CasResult<T> {
  ok: boolean
  revision: number
  /** ok=true 时为新数组；ok=false 时为当前最新数组（调用方可提示冲突） */
  value: T[]
  /** ok=false 时的失败原因 */
  reason?: 'stale' | 'not-permutation'
}

/** 新数组 + 递增后的 revision。 */
function commit<T>(value: T[], revision: number): CasResult<T> {
  return { ok: true, revision: revision + 1, value }
}

/** 通用 CAS：expected 不等于 current 时拒绝。 */
export function casReplace<T>(
  current: T[],
  revision: number,
  expected: number,
  next: (value: T[]) => T[],
): CasResult<T> {
  if (expected !== revision) return { ok: false, revision, value: current, reason: 'stale' }
  return commit(next(current), revision)
}

/**
 * 重排（相邻交换）的 CAS。
 * 除 revision 外还校验 `expectedIds` 与当前队列的 id 全集一致——
 * 防止"读到旧队列 → 别人移除一项 → 用旧集合重排"把已移除的项"复活"回来。
 */
export function casReorder<T extends { id: string }>(
  current: T[],
  revision: number,
  expected: number,
  index: number,
  dir: -1 | 1,
  expectedIds: readonly string[],
): CasResult<T> {
  if (expected !== revision) return { ok: false, revision, value: current, reason: 'stale' }
  const target = index + dir
  if (index < 0 || target < 0 || target >= current.length) {
    return { ok: false, revision, value: current, reason: 'not-permutation' }
  }
  const currentIds = current.map((item) => item.id)
  const sameSet =
    currentIds.length === expectedIds.length &&
    [...currentIds].sort().join('\u0000') === [...expectedIds].sort().join('\u0000')
  if (!sameSet) return { ok: false, revision, value: current, reason: 'not-permutation' }
  const next = [...current]
  const swap = next[index]
  next[index] = next[target]
  next[target] = swap
  return commit(next, revision)
}

/** 移除项的 CAS：同样校验 id 全集，防止移除错位的项。 */
export function casRemove<T extends { id: string }>(
  current: T[],
  revision: number,
  expected: number,
  id: string,
): CasResult<T> {
  if (expected !== revision) return { ok: false, revision, value: current, reason: 'stale' }
  if (!current.some((item) => item.id === id)) {
    return { ok: false, revision, value: current, reason: 'not-permutation' }
  }
  return commit(current.filter((item) => item.id !== id), revision)
}
