<script lang="ts">
  // 2-12：虚拟化文件预览 —— 只渲染可视窗口附近的行，配合 sidecar 的
  // read_file_chunk 分块协议，大文件（几十万行）也能秒开、滚动流畅。
  import { createEventDispatcher, onDestroy, onMount } from 'svelte'

  export let path = ''
  export let readFileChunk: (offset: number, limit: number) => Promise<{ totalLines: number; lines: string[]; offset: number }>
  export let height = 420

  const LINE_HEIGHT = 20
  const CHUNK = 800 // 每次拉取的行数（窗口外各留 1 个缓冲块）
  const VIEWPORT = Math.ceil(height / LINE_HEIGHT) + 10

  const dispatch = createEventDispatcher<{ loaded: { totalLines: number } ; error: { message: string } }>()

  let viewport: HTMLDivElement
  let totalLines = 0
  let loaded = new Map<number, string>() // 行号 → 内容
  let firstRendered = 0
  let lastRendered = 0
  let loading = false
  let error = ''
  let pendingScroll: (() => void) | null = null

  // 可视窗口的起止行（含缓冲）
  let renderStart = 0
  let renderLines: Array<{ n: number; text: string }> = []

  async function ensureRange(start: number, end: number) {
    const missing: number[] = []
    for (let i = start; i <= end; i++) if (!loaded.has(i)) missing.push(i)
    if (!missing.length) return
    // 把缺失行聚合成连续段拉取（避免一行一个请求）
    const segments: Array<[number, number]> = []
    let segStart = missing[0]
    let prev = missing[0]
    for (const n of missing.slice(1)) {
      if (n === prev + 1) { prev = n; continue }
      segments.push([segStart, prev])
      segStart = n
      prev = n
    }
    segments.push([segStart, prev])
    await Promise.all(segments.map(async ([from, to]) => {
      const result = await readFileChunk(from, Math.min(to - from + 1, CHUNK))
      for (const [index, text] of result.lines.entries()) loaded.set(from + index, text)
    }))
  }

  async function render() {
    if (!viewport || !totalLines) return
    const scrollTop = viewport.scrollTop
    const first = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - 5)
    const last = Math.min(totalLines - 1, first + VIEWPORT + 10)
    try {
      loading = true
      await ensureRange(
        Math.max(0, first - CHUNK),
        Math.min(totalLines - 1, last + CHUNK),
      )
      firstRendered = first
      lastRendered = last
      renderStart = first
      renderLines = []
      for (let n = first; n <= last; n++) {
        const text = loaded.get(n)
        if (text !== undefined) renderLines.push({ n, text })
      }
      error = ''
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      dispatch('error', { message: error })
    } finally {
      loading = false
    }
  }

  function onScroll() {
    // 滚动节流：一帧一次
    if (pendingScroll) return
    pendingScroll = () => {
      pendingScroll = null
      void render()
    }
    requestAnimationFrame(pendingScroll)
  }

  $: if (path && readFileChunk) {
    loaded = new Map()
    totalLines = 0
    renderLines = []
    void (async () => {
      try {
        const first = await readFileChunk(0, CHUNK)
        totalLines = first.totalLines
        for (const [index, text] of first.lines.entries()) loaded.set(index, text)
        dispatch('loaded', { totalLines })
        await render()
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
        dispatch('error', { message: error })
      }
    })()
  }

  onMount(() => {
    viewport?.addEventListener('scroll', onScroll, { passive: true })
  })
  onDestroy(() => {
    viewport?.removeEventListener('scroll', onScroll)
  })
</script>

<div class="vfile" bind:this={viewport} style={`height:${height}px`}>
  {#if error}
    <div class="vfile-error" role="alert">{error}</div>
  {:else if !totalLines}
    <div class="vfile-empty">加载中…</div>
  {:else}
    <!-- 总高占位：让滚动条长度对应真实文件规模 -->
    <div style={`height:${totalLines * LINE_HEIGHT}px;position:relative`}>
      <div style={`position:absolute;top:${renderStart * LINE_HEIGHT}px;left:0;right:0`}>
        {#each renderLines as line (line.n)}
          <div class="vfile-row" style={`height:${LINE_HEIGHT}px`}>
            <span class="vfile-n">{line.n + 1}</span>
            <span class="vfile-text">{line.text}</span>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .vfile { overflow: auto; border: 1px solid var(--border-2); border-radius: 6px; background: var(--surface-2); font-family: var(--mono, monospace); font-size: 11px; }
  .vfile-row { display: flex; gap: 10px; white-space: pre; }
  .vfile-n { flex: none; min-width: 52px; padding-right: 8px; text-align: right; color: var(--muted-2); user-select: none; border-right: 1px solid var(--border-2); }
  .vfile-text { overflow: hidden; text-overflow: ellipsis; }
  .vfile-empty, .vfile-error { padding: 16px; color: var(--muted); }
  .vfile-error { color: var(--danger, #c0392b); }
</style>
