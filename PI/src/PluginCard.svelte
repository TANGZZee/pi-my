<script lang="ts">
  // 1-5 UI 插件：卡片渲染器（card / text / html 三形态）。
  // 数据已在 ui-plugins.normalizePluginMessage 清洗；这里只做展示。
  import type { PluginMessage } from './ui-plugins'

  export let message: PluginMessage
</script>

<div class="plug-card" data-tone={message.tone} data-component={message.component}>
  <div class="plug-head">
    <strong>{message.title}</strong>
    <span class="plug-type">{message.customType}</span>
  </div>
  {#if message.component === 'card' && (message.fields?.length ?? 0)}
    <div class="plug-fields">
      {#each message.fields as field (field.label)}
        <div class="plug-field">
          <span class="plug-label">{field.label}</span>
          <span class="plug-value">{field.value}</span>
        </div>
      {/each}
    </div>
  {:else if message.component === 'html'}
    {@html message.body}
  {:else if message.component === 'text'}
    <pre class="plug-text">{message.body}</pre>
  {/if}
</div>

<style>
  /* margin 一律由 app.css 宿主层控制（批次①对抗审查 D8）：
     scoped 的 margin 与 app.css 的 .plugin-float-stack .plug-card{margin:0}
     特异性平局且后注入，导致各槽位宿主层的 margin:0 永远不生效。 */
  .plug-card { padding: 10px 12px; border: 1px solid var(--border-2); border-left: 3px solid var(--accent); border-radius: 8px; background: var(--surface-2); }
  .plug-card[data-tone='warn'] { border-left-color: #d97706; }
  .plug-card[data-tone='danger'] { border-left-color: #dc2626; }
  .plug-card[data-tone='ok'] { border-left-color: #16a34a; }
  .plug-head { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
  .plug-head strong { font-size: 12px; }
  .plug-type { color: var(--muted-2); font-size: 10px; font-family: var(--mono, monospace); }
  .plug-fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 4px 14px; }
  .plug-field { display: flex; justify-content: space-between; gap: 10px; font-size: 11px; }
  .plug-label { color: var(--muted); }
  .plug-value { font-family: var(--mono, monospace); word-break: break-all; text-align: right; }
  .plug-text { margin: 0; white-space: pre-wrap; font: 11px/1.5 var(--mono, monospace); }
</style>
