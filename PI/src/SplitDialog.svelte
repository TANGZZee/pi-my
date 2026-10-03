<script lang="ts">
  // 0-5 批次 B-4a：从 App.svelte 根级抽出的「并行拆分」overlay（全局模态）。
  // 状态（splitOpen/splitRows）经 bind: 双向同步留在父组件——/split 斜杠命令、
  // TodoPanel/SubRunsPanel 的开面板回调都发生在父组件侧，开合由父驱动；
  // agentDefs 由父组件传入，开始按钮经 onRun 回调触发父组件的 runSplit。
  import type { AgentDef } from './agents'

  export let open = false
  export let rows: Array<{ agent: string; task: string }> = [{ agent: 'scout', task: '' }]
  export let agentDefs: AgentDef[] = []
  /** 开始按钮：父组件读取 rows 组装 jobs（trim 空默认 scout、过滤空任务） */
  export let onRun: () => void = () => {}
</script>

{#if open}
  <div class="overlay" role="presentation" on:click={(event) => { if (event.target === event.currentTarget) open = false }}>
    <div class="split-card" role="dialog" aria-label="并行拆分子代理">
      <header><strong>并行拆分</strong><button type="button" on:click={() => (open = false)}>×</button></header>
      <p>内置 scout 只读侦察；也可选自定义 agent。最多一次发多条。</p>
      {#each rows as row, index (index)}
        <div class="split-row">
          <select bind:value={row.agent}>{#each agentDefs as def (def.name)}<option value={def.name}>{def.name}</option>{/each}</select>
          <input bind:value={row.task} placeholder="独立任务…" />
          <button type="button" on:click={() => (rows = rows.filter((_, i) => i !== index))}>×</button>
        </div>
      {/each}
      <div class="split-actions">
        <button type="button" on:click={() => (rows = [...rows, { agent: 'scout', task: '' }])}>＋ 任务</button>
        <button class="primary" type="button" on:click={onRun}>开始</button>
      </div>
    </div>
  </div>
{/if}
