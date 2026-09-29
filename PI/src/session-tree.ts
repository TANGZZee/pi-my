// 会话树构建与关系判定（纯函数，0-5 第一步抽取）
//
// 为什么先抽这些：它们是 App.svelte 里**完全无副作用**的逻辑（只读入参、返回新值），
// 且是"分支导航/会话树展示"的核心语义。抽出来后可以脱离 Svelte 单测，
// 也为后续把侧栏拆成独立组件铺路。

export interface SessionLike {
  id: string
  file?: string
  parentFile?: string
  branchParentId?: string
  parentId?: string
  archived?: boolean
  createdAt?: number
  [key: string]: unknown
}

/** 文件路径等价比较：统一斜杠 + 忽略大小写（Windows 盘符/路径大小写不敏感） */
export function sameSessionFile(left?: string, right?: string): boolean {
  if (!left || !right) return false
  return left.replaceAll('\\', '/').toLowerCase() === right.replaceAll('\\', '/').toLowerCase()
}

/**
 * 会话的父会话 id。
 * 优先 branchParentId（显式分支），其次按 parentFile 反查集合中的父会话。
 */
export function sessionParentId(session: SessionLike, all: SessionLike[]): string {
  if (session.branchParentId) return session.branchParentId
  if (!session.parentFile) return ''
  return all.find((item) => sameSessionFile(item.file, session.parentFile))?.id || ''
}

/** 沿父链追溯到根会话 id（带环保护）。 */
export function sessionRootId(session: SessionLike, all: SessionLike[]): string {
  let current: SessionLike | undefined = session
  const visited = new Set<string>()
  while (current && !visited.has(current.id)) {
    visited.add(current.id)
    const parentId = sessionParentId(current, all)
    if (!parentId) return current.id
    const parent = all.find((item) => item.id === parentId)
    if (!parent) return current.id
    current = parent
  }
  return session.id
}

/** 同一根下的兄弟排序：创建时间优先，其次 id（保证稳定）。 */
export function sessionOrder(left: SessionLike, right: SessionLike): number {
  return (left.createdAt || 0) - (right.createdAt || 0) || left.id.localeCompare(right.id)
}

export interface SessionRow<S extends SessionLike = SessionLike> {
  session: S
  depth: number
  branch: boolean
}

/**
 * 把扁平会话集合构建成带缩进深度的展示行。
 * - 父会话不可见（归档/未在集合中）的子会话提升为顶层，避免"消失的父节点"留下孤儿
 * - 同一会话只出现一次（环保护）
 */
export function buildSessionRows<S extends SessionLike>(items: S[]): SessionRow<S>[] {
  const visibleIds = new Set(items.map((item) => item.id))
  const rows: SessionRow<S>[] = []
  const visited = new Set<string>()
  const children = (parentId: string) =>
    items.filter((item) => sessionParentId(item, items) === parentId).sort(sessionOrder)
  const walk = (session: S, depth: number) => {
    if (visited.has(session.id)) return
    visited.add(session.id)
    rows.push({ session, depth, branch: depth > 0 || Boolean(session.parentFile) })
    for (const child of children(session.id)) walk(child, depth + 1)
  }
  for (const item of [...items].sort(sessionOrder)) {
    const parentId = sessionParentId(item, items)
    if (!parentId || !visibleIds.has(parentId)) walk(item, 0)
  }
  for (const item of items) walk(item, 0)
  return rows
}

/** 活动会话在同一根下的全部可见兄弟（用于"分支 N/M"导航）。 */
export function activeBranchSiblingsOf<S extends SessionLike>(
  sessions: S[],
  activeSessionId: string,
): S[] {
  const active = sessions.find((item) => item.id === activeSessionId)
  if (!active) return []
  const rootId = sessionRootId(active, sessions)
  return sessions
    .filter(
      (item) => !item.archived && !item.parentId && sessionRootId(item, sessions) === rootId,
    )
    .sort(sessionOrder)
}
