<script lang="ts">
  // 0-5 批次 B-5：从 App.svelte 抽出的「文档」面板（文件树 + 预览 + 编辑）。
  // selectedFile/fileContent/largeFile/editingFile 经 bind: 双向同步留在父组件
  // （activateProject/removeProject 清空、loadFiles 由父驱动——files 只在父侧变化，
  // 经 filteredFiles 响应式下传；@ 补全 mentionList 仍直接用父侧 files）；
  // 保存后 onSaved 回调驱动父组件 refreshGit。openDirs 是组件本地展开态——旧实现里
  // activateProject 也不重置它，行为保持一致。
  import VirtualFile from './VirtualFile.svelte'
  import Icon from './Icon.svelte'
  import { fileName, treeChildren as treeChildrenOf, workspaceBase } from './app-files'

  type FileEntry = { path: string; kind: 'file' | 'directory' }

  export let filteredFiles: FileEntry[] = []
  export let filesLoading = false
  export let projectBusy = ''
  export let sidecarReady = false
  export let workspacePath = '.'

  export let selectedFile = ''
  export let fileContent = ''
  export let largeFile: { path: string } | null = null
  export let editingFile = false

  /** 请求通道：request(type, payload)（ok:false 时 result 为 null）；requestRaw 返回 {ok,result,error} */
  export let request: (type: string, payload?: Record<string, unknown>) => Promise<unknown>
  export let requestRaw: (type: string, payload?: Record<string, unknown>) => Promise<{ ok: boolean; result: unknown; error?: string }>
  /** 保存成功后由父组件刷新 git 变更 */
  export let onSaved: () => void = () => {}
  /** 刷新文件列表（loadFiles 留在父组件：files 还被 @ 补全 mentionList 依赖） */
  export let onRefresh: () => void = () => {}
  /** 读取失败时交父组件把错误写进当前会话槽位（patchSlot(ensureActiveId(),{error})） */
  export let onReadError: (message: string) => void = () => {}

  let openDirs: Record<string, boolean> = {}

  // fileName/treeChildren 已抽到 app-files.ts（0-5 批次 A）；树过滤的输入是
  // 父组件按侧栏 query 过滤后的 filteredFiles。
  function treeChildren(prefix: string) {
    return treeChildrenOf(filteredFiles, prefix)
  }

  function toggleDir(path: string) {
    openDirs = { ...openDirs, [path]: !openDirs[path] }
  }

  function documentStats() {
    if (!selectedFile) return ''
    const lines = fileContent ? fileContent.split('\n').length : 0
    const kb = Math.max(1, Math.ceil(new TextEncoder().encode(fileContent).length / 1024))
    return `${lines} 行 · ${kb} KB`
  }

  async function saveFile() {
    if (!selectedFile || !sidecarReady) return
    await request('write_file', { cwd: workspacePath, path: selectedFile, content: fileContent })
    editingFile = false
    onSaved()
  }

  async function previewFile(file: string) {
    selectedFile = file
    editingFile = false
    if (sidecarReady) {
      // requestRaw 对失败返回 ok:false 不 reject，所以判 result 而不是 catch
      const response = await requestRaw('read_file', { cwd: workspacePath, path: file })
      const result = response.ok ? (response.result as { content: string } | null) : null
      if (result?.content !== undefined) {
        fileContent = result.content
        largeFile = null
        return
      }
      // 2-12：超过 512KB 的文件 → 虚拟化分块预览（此前直接报错打不开）
      const message = String(response.error || '')
      if (message.includes('512 KB') || message.includes('超过')) {
        await previewLargeFile(file)
        return
      }
      fileContent = ''
      selectedFile = ''
      onReadError(message || '未知错误')
    }
  }

  /** 2-12：大文件分块读取（虚拟化预览路径）。 */
  export async function readFileChunk(offset: number, limit: number): Promise<{ totalLines: number; lines: string[]; offset: number }> {
    const response = await requestRaw('read_file_chunk', { cwd: workspacePath, path: selectedFile, offset, limit })
    if (!response.ok) throw new Error(response.error || '读取失败')
    return response.result as { totalLines: number; lines: string[]; offset: number }
  }

  /** 大文件入口：read_file 会拒绝 >512KB，捕获后切虚拟化预览。 */
  async function previewLargeFile(file: string) {
    selectedFile = file
    editingFile = false
    fileContent = ''
    largeFile = { path: file }
  }
</script>

<div class="resource-head"><span>{workspaceBase(workspacePath)}</span><button aria-label="刷新文件" disabled={filesLoading || projectBusy !== ''} on:click={() => void onRefresh()}><Icon name="refresh" size={13} /></button></div>
<div class="resource-tree">
  {#snippet treeRows(prefix: string, depth: number)}
    {#each treeChildren(prefix) as file}
      <button class:file-directory={file.kind === 'directory'} class:file-selected={selectedFile === file.path} class:open={openDirs[file.path]} style={`padding-left:${6 + depth * 12}px`} on:click={() => (file.kind === 'file' ? void previewFile(file.path) : toggleDir(file.path))}>
        <span class="resource-chevron">{#if file.kind === 'directory'}<Icon name={openDirs[file.path] ? 'chevron-down' : 'chevron-right'} size={10} strokeWidth={1.9} />{/if}</span><span class="resource-icon">{#if file.kind === 'file'}<Icon name="file" size={11} strokeWidth={1.6} />{/if}</span><span>{fileName(file.path)}</span>
      </button>
      {#if file.kind === 'directory' && openDirs[file.path]}
        {@render treeRows(file.path, depth + 1)}
      {/if}
    {:else}
      {#if depth === 0}<div class="resource-empty">{filesLoading || projectBusy ? '正在加载项目文件…' : '选择工作区后显示文件'}</div>{/if}
    {/each}
  {/snippet}
  {@render treeRows('', 0)}
</div>
{#if selectedFile}
  <div class="resource-preview-head"><span class="doc-name">{selectedFile}</span><span class="doc-stats">{largeFile ? '大文件 · 虚拟化预览' : documentStats()}</span>{#if !largeFile}{#if !editingFile}<button on:click={() => (editingFile = true)}>编辑</button>{:else}<button on:click={() => void saveFile()}>保存</button><button on:click={() => (editingFile = false)}>取消</button>{/if}{/if}</div>
  {#if largeFile}
    <!-- 2-12：大文件虚拟化预览（只读；编辑仍限 512KB 内文件） -->
    <VirtualFile path={largeFile.path} readFileChunk={readFileChunk} height={480} />
  {:else}
    <article class="resource-preview">{#if editingFile}<textarea class="file-editor" bind:value={fileContent}></textarea>{:else}<pre class="file-preview">{fileContent}</pre>{/if}</article>
  {/if}
{/if}
