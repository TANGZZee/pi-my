<script lang="ts">
  // 0-5 批次 B-1：从 App.svelte 抽出的「变更」面板（git）。
  // 状态（gitChanges/diffContent/staged/commitMessage/gitError）与全部 git 操作
  // 在本组件内自持；父组件通过 bind: 引用这些状态（activateProject/removeProject
  // 清空、saveFile 后刷新仍由父组件跨组件驱动）。
  import { confirm } from '@tauri-apps/plugin-dialog'
  import Icon from './Icon.svelte'
  import { loadPrefs } from './prefs'

  type GitChange = { code: string; path: string }

  export let sidecarReady = false
  export let workspacePath = '.'
  /** 请求通道：request(type, payload)（ok:false 时 result 为 null）；requestRaw 返回 {ok,result,error} */
  export let request: (type: string, payload?: Record<string, unknown>) => Promise<unknown>
  export let requestRaw: (type: string, payload?: Record<string, unknown>) => Promise<{ ok: boolean; result: unknown; error?: string }>
  /** diff 内容/错误提示里的 gitTemplate（与旧 placeholder 语义一致） */
  export let gitTemplate = ''

  export let gitChanges: GitChange[] = []
  export let diffContent = ''
  export let staged: Record<string, boolean> = {}
  export let commitMessage = ''
  export let gitError = ''

  async function refreshGit(cwd = workspacePath) {
    if (!sidecarReady) return
    const target = cwd
    const changes = await request('git_status', { cwd: target }) as GitChange[]
    if (workspacePath === target) gitChanges = changes
  }

  // 供父组件在 activateProject/saveFile/启动后触发刷新（行为与旧实现一致）
  export async function refresh(cwd?: string) {
    await refreshGit(cwd)
  }

  async function loadDiff(file: string) {
    if (!sidecarReady) return
    diffContent = await request('git_diff', { cwd: workspacePath, path: file }) as string
  }

  function isStaged(code: string) {
    return code[0] !== ' ' && code[0] !== '?'
  }

  async function runGit(type: string, payload: Record<string, unknown>) {
    gitError = ''
    const res = await requestRaw(type, payload)
    if (!res.ok) {
      gitError = res.error || '操作失败'
      return false
    }
    commitMessage = ''
    staged = {}
    await refreshGit()
    return true
  }

  async function stageFiles() {
    const paths = gitChanges.filter((change) => (staged[change.path] ?? false) && !isStaged(change.code)).map((change) => change.path)
    if (!paths.length) return
    const ok = await confirm(`确认暂存勾选的 ${paths.length} 个文件？`, { title: '暂存更改', kind: 'warning' })
    if (!ok) return
    await runGit('git_add', { cwd: workspacePath, paths })
  }

  async function commitChanges() {
    const message = commitMessage.trim() || loadPrefs().gitTemplate.trim()
    if (!message) return
    const stagedCount = gitChanges.filter((change) => isStaged(change.code)).length
    const ok = await confirm(`确认提交「${message}」？将提交当前全部已暂存的 ${stagedCount} 个文件。`, { title: '提交更改', kind: 'warning' })
    if (!ok) return
    await runGit('git_commit', { cwd: workspacePath, message })
  }

  async function pushChanges() {
    const ok = await confirm('确认将本地提交推送到远程仓库？', { title: '推送', kind: 'warning' })
    if (!ok) return
    await runGit('git_push', { cwd: workspacePath })
  }

  function toggleStaged(path: string) {
    staged = { ...staged, [path]: !(staged[path] ?? false) }
  }
</script>

<div class="git-panel">
  <div class="panel-content">
    <div class="panel-title"><div><strong>工作区变更</strong><small>{gitChanges.length} 个文件已修改</small></div><button class="primary-small" on:click={() => void refreshGit()}>刷新</button></div>
    <div class="git-changes">
      {#each gitChanges as change (change.path)}
        <div class="change-item" role="button" tabindex="0" on:click={() => void loadDiff(change.path)} on:keydown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void loadDiff(change.path) } }}>
          <input class="change-check" type="checkbox" checked={staged[change.path] ?? false} on:click={(event) => event.stopPropagation()} on:change={() => toggleStaged(change.path)} />
          <span class="file-dot" class:modified={change.code.includes('M')} class:added={change.code.includes('A') || change.code.includes('?')}>{change.code.includes('A') || change.code.includes('?') ? 'A' : 'M'}</span>
          <div class="change-meta"><strong>{change.path}</strong><small>{change.code}</small></div>
        </div>
      {:else}
        <div class="diff-placeholder">当前工作区没有未提交变更</div>
      {/each}
      {#if diffContent}<pre class="diff-content">{diffContent}</pre>{/if}
    </div>
  </div>
  <div class="git-actions">
    {#if gitError}<div class="git-error">{gitError}</div>{/if}
    <input class="commit-input" bind:value={commitMessage} placeholder={gitTemplate || '提交信息…'} />
    <div class="git-actions-row">
      <button disabled={!sidecarReady} on:click={() => void stageFiles()}>暂存</button>
      <button disabled={!sidecarReady} on:click={() => void commitChanges()}>提交</button>
      <button disabled={!sidecarReady} on:click={() => void pushChanges()}>推送</button>
    </div>
  </div>
</div>
