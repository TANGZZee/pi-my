// 0-5 拆分 App.svelte · 批次 A：文件树/路径纯逻辑（从 App.svelte :310-319、:917-920、:935-937 抽出）
//
// 与 app-models.ts 同批次：纯函数收进可单测模块。树过滤不依赖组件状态——
// 文件列表与目录展开状态都由调用方传入。

// 显式 .ts 扩展名：本文件被 PI/tests 下的 node --test 直接加载。

export interface FileEntry {
  path: string
  kind: 'file' | 'directory'
}

/** 路径尾段（原 App.svelte fileName :310-312；注意原实现只按 '/' 切，保留原语义）。 */
export function fileName(path: string): string {
  return path.split('/').pop() || path
}

/**
 * 文件树一层的可见条目（原 App.svelte treeChildren :313-319）。
 * @param files 已经过查询过滤的扁平列表
 * @param prefix 目录前缀（'' 表示根层）
 * @returns 属于该层（不再含 '/'）的条目
 */
export function treeChildren(files: FileEntry[], prefix: string): FileEntry[] {
  const base = prefix ? `${prefix}/` : ''
  return files.filter((item) => {
    const rest = prefix ? (item.path.startsWith(base) ? item.path.slice(base.length) : '') : item.path
    return rest !== '' && !rest.includes('/')
  })
}

/** 项目显示名：路径尾段（同时接受 / 与 \ 分隔；原 App.svelte projectName :935-937）。 */
export function projectName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}

/** 工作区显示名：'.' 显示"当前目录"，否则取路径尾段（原 App.svelte workspaceBase :917-920）。 */
export function workspaceBase(workspacePath: string): string {
  if (workspacePath === '.') return '当前目录'
  return workspacePath.split(/[\\/]/).pop() || workspacePath
}
