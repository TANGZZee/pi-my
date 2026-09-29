<script lang="ts">
  // 0-9 code-split：pixi.js（~450KB）+ pixi-live2d-display（~190KB）只在启用桌宠时才需要。
  // 之前它们被静态 import 进主包，导致主包 1.1MB。这里改为按需动态加载组件本身，
  // Vite 会把 Pet/Live2DPet/SpritePet 及其依赖切到独立 chunk，主包不再包含 pixi。
  import { onMount } from 'svelte'

  export let kind: 'sprite' | 'live2d' | 'atom' = 'atom'
  export let enabled = false
  export let url = ''

  let Component: any = null
  let props: Record<string, unknown> = {}

  $: if (enabled) {
    void loadComponent(kind).then((loaded) => {
      if (loaded) {
        Component = loaded.component
        props = loaded.props
      }
    })
  }

  async function loadComponent(kind: string) {
    if (kind === 'sprite') {
      const mod = await import('./SpritePet.svelte')
      return { component: mod.default, props: { enabled: true, url } }
    }
    if (kind === 'live2d') {
      const mod = await import('./Live2DPet.svelte')
      return { component: mod.default, props: { enabled: true, url } }
    }
    const mod = await import('./Pet.svelte')
    return { component: mod.default, props: { enabled: true } }
  }

  // url / kind 变化时同步 props
  $: if (Component) {
    props = { ...props, enabled, url }
  }
</script>

{#if Component}
  <svelte:component this={Component} {...props} />
{/if}
