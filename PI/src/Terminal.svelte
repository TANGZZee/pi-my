<script lang="ts">
  import { onMount } from 'svelte'
  import { invoke } from '@tauri-apps/api/core'
  import { listen, type UnlistenFn } from '@tauri-apps/api/event'
  import '@xterm/xterm/css/xterm.css'

  // 0-9：xterm 体积大（~300KB min），而终端面板多数时候根本没打开。
  // 改为首次进入面板时才动态 import，主包不再包含 xterm。
  let TerminalCtor: typeof import('@xterm/xterm').Terminal | undefined
  let FitAddonCtor: typeof import('@xterm/addon-fit').FitAddon | undefined
  async function loadXterm() {
    if (TerminalCtor) return
    const [xterm, fit] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ])
    TerminalCtor = xterm.Terminal
    FitAddonCtor = fit.FitAddon
  }

  let { visible = false }: { visible?: boolean } = $props()

  let host: HTMLDivElement
  let term: import('@xterm/xterm').Terminal | undefined
  let fit: import('@xterm/addon-fit').FitAddon | undefined
  let ptyId: number | undefined
  let unlisten: UnlistenFn | undefined
  let resizeHandler: (() => void) | undefined

  // 关键：清理逻辑必须由**同步**的 onMount 回调返回。
  // Svelte 只在回调返回值 `typeof === 'function'` 时才注册清理函数
  // （见 svelte/src/index-client.js：`if (typeof cleanup === 'function') return cleanup`）。
  // 若写成 `onMount(async () => { ...; return () => {...} })`，返回的是 Promise，
  // 清理函数**永远不会被注册** —— 曾经因此让 pty_kill / unlisten / dispose 全部失效。
  // 这里用同步外壳 + 内部 async IIFE，并用 disposed 标记关掉"创建过程中已被卸载"的竞态。
  let disposed = false
  // xterm chunk 加载失败时的用户可见提示（审查中-2：之前静默无提示）。
  // $state 必需：Svelte 5 中普通 let 的变更不会触发更新（svelte-check 抓到的）。
  let loadError = $state('')

  onMount(() => {
    void (async () => {
      // 首次挂载才加载 xterm（0-9 code-split）
      try {
        await loadXterm()
      } catch (error) {
        // chunk 加载失败（磁盘/杀软误报等）：PTY 不会 spawn（在 ctor 之后），无进程泄漏
        loadError = `终端组件加载失败：${error instanceof Error ? error.message : String(error)}。请重启应用重试。`
        console.error('[pi-my] xterm 加载失败', error)
        return
      }
      if (disposed || !TerminalCtor || !FitAddonCtor) return
      term = new TerminalCtor({
        fontSize: 11,
        fontFamily: "'DM Mono', monospace",
        theme: { background: '#202622', foreground: '#c7d4c9' }
      })
      fit = new FitAddonCtor()
      term.loadAddon(fit)
      term.open(host)
      fit.fit()
      term.focus()

      const shell = localStorage.getItem('pdn.shell') || 'cmd'
      const spawned = await invoke<number>('pty_spawn', { shell }).catch(() => undefined)
      // 组件已在 spawn 期间被卸载 → 立刻回收，绝不遗留 shell 进程
      if (disposed) {
        if (spawned !== undefined) void invoke('pty_kill', { id: spawned }).catch(() => {})
        return
      }
      if (spawned === undefined) return
      ptyId = spawned

      const stop = await listen<{ id: number; data: string }>('pty-output', ({ payload }) => {
        if (payload.id === ptyId) term?.write(payload.data)
      })
      // 若在注册期间已被卸载，立刻退订，避免监听器永久泄漏
      if (disposed) { stop(); return }
      unlisten = stop

      term?.onData((data) => {
        if (ptyId !== undefined) void invoke('pty_write', { id: ptyId, data }).catch(() => {})
      })
    })()

    resizeHandler = () => fit?.fit()
    window.addEventListener('resize', resizeHandler)

    // 同步返回 → Svelte 一定会注册它
    return () => {
      disposed = true
      if (resizeHandler) window.removeEventListener('resize', resizeHandler)
      if (ptyId !== undefined) void invoke('pty_kill', { id: ptyId }).catch(() => {})
      unlisten?.()
      term?.dispose()
    }
  })

  $effect(() => {
    if (visible && term && fit) fit.fit()
  })
</script>

<div class="terminal-host" bind:this={host}></div>
{#if loadError}
  <div class="terminal-load-error" role="alert">{loadError}</div>
{/if}

<style>
  .terminal-load-error {
    padding: 16px;
    color: var(--danger, #f7768e);
    font-size: 12px;
    line-height: 1.6;
  }
</style>
