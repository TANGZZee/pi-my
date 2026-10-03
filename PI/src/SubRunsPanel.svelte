<script lang="ts">
  // 0-5 批次 B-3：从 App.svelte 抽出的「子代理」运行面板（纯展示）。
  // 注意：并行拆分 overlay 与子代理检视 overlay 仍留在 App.svelte 根级——
  // /split、/scout 空参、待办拆分、子会话点击都可能发生在任意面板下，
  // 而本组件只在「子代理」面板分支内挂载，overlay 状态放这里会造成
  // 组件未挂载时 open() 静默失效。这里只负责列表展示与回调上报。
  import type { SubRun } from './run-slot'

  export let subRuns: SubRun[] = []
  /** 点击子代理行：父组件打开只读检视 overlay（含 slotFor(run.id).reply 兜底） */
  export let onView: (run: SubRun) => void = () => {}
  /** 「并行拆分」按钮：父组件打开拆分 overlay（agentDefs = loadAgents() 也在父组件） */
  export let onOpenSplit: () => void = () => {}
</script>

<div class="panel-content">
  <div class="panel-title"><div><strong>子代理</strong><small>{subRuns.length} 个任务</small></div><button class="primary-small" on:click={onOpenSplit}>并行拆分</button></div>
  {#if subRuns.length}
    {#each subRuns as run (run.id)}
      <button class="sub-row block" type="button" on:click={() => onView(run)}>
        <i class:run={run.status === 'running'} class:bad={run.status === 'error'}></i>
        <strong>{run.agent}</strong>
        <span class="sub-task">{run.task}</span>
        <em>{run.status === 'running' ? '运行中' : run.status === 'error' ? '失败' : '完成'}</em>
      </button>
    {/each}
  {:else}
    <div class="empty-panel"><span>◌</span><strong>暂无子代理</strong><small>/scout 任务 或点「并行拆分」</small></div>
  {/if}
</div>
