<script lang="ts">
  import { onDestroy } from 'svelte'
  import { renderMarkdown } from './markdown'
  import { renderMarkdownIncremental, clearMarkdownCache } from './markdown-incremental'

  export let text = ''
  export let copyable = true
  /** 增量缓存的 key：流式期间同一消息的 id 不变，可复用已闭合块的 HTML。
   *  不传（如静态预览）则退回全量渲染。 */
  export let streamKey = ''

  let copied = false

  // 0-7：流式期间每个 delta 只重渲染"活动尾部"，已闭合块复用缓存。
  // 修复点：旧实现对全文从头解析，长回复是 O(N²) CPU。
  $: html = streamKey
    ? renderMarkdownIncremental(text || '', streamKey).html
    : renderMarkdown(text || '')

  onDestroy(() => { if (streamKey) clearMarkdownCache(streamKey) })

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      copied = true
      window.setTimeout(() => (copied = false), 1200)
    } catch { /* ignore */ }
  }

  function preview(event: MouseEvent) {
    const node = event.target
    if (!(node instanceof HTMLImageElement) || !node.classList.contains('md-img')) return
    window.open(node.src, '_blank', 'noopener')
  }
</script>

<div class="md-wrap">
  {#if copyable && text}
    <button class="copy" type="button" on:click={() => void copy()}>{copied ? '已复制' : '复制'}</button>
  {/if}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="md" role="presentation" on:click={preview}>{@html html}</div>
</div>

<style>
  .md-wrap { position: relative; }
  .copy {
    position: absolute;
    top: -2px;
    right: 0;
    z-index: 1;
    padding: 3px 8px;
    border-radius: 4px;
    background: var(--hover);
    color: var(--text-3);
    font-size: 10px;
    opacity: 0;
  }
  .md-wrap:hover .copy { opacity: 1; }
  .copy:hover { background: var(--active); color: var(--text); }
  .md :global(p) { margin: 0 0 10px; }
  .md :global(p:last-child) { margin-bottom: 0; }
  .md :global(h1), .md :global(h2), .md :global(h3), .md :global(h4) {
    margin: 14px 0 8px;
    color: var(--text);
    font-weight: 650;
    line-height: 1.35;
  }
  .md :global(h1) { font-size: 18px; }
  .md :global(h2) { font-size: 16px; }
  .md :global(h3) { font-size: 14px; }
  .md :global(ul), .md :global(ol) { margin: 0 0 10px; padding-left: 1.3em; }
  .md :global(li) { margin: 3px 0; }
  .md :global(code) {
    padding: 1px 5px;
    border-radius: 3px;
    background: var(--surface-3);
    font: 12px/1.45 ui-monospace, "Cascadia Mono", monospace;
  }
  .md :global(pre) {
    overflow: auto;
    margin: 0 0 10px;
    padding: 10px 12px;
    border: 1px solid var(--border-2);
    border-radius: 6px;
    background: var(--surface-3);
  }
  .md :global(pre code) { padding: 0; background: transparent; font-size: 12px; }
  .md :global(blockquote) {
    margin: 0 0 10px;
    padding: 4px 0 4px 10px;
    border-left: 3px solid var(--border);
    color: var(--text-3);
  }
  .md :global(hr) { border: 0; border-top: 1px solid var(--hover); margin: 12px 0; }
  .md :global(a) { color: var(--text); text-decoration: underline; }
  .md :global(img.md-img) {
    display: block;
    max-width: min(520px, 100%);
    max-height: 360px;
    margin: 8px 0;
    border: 1px solid var(--hover-2);
    border-radius: 6px;
    background: var(--raised);
    object-fit: contain;
    cursor: zoom-in;
  }
  .md :global(strong) { color: var(--text); }
</style>
