<script lang="ts">
  // UI 插件宿主（1-5 完整版 · 批次①）
  //
  // ui-plugins.ts:10 的注释承诺「PluginHost.svelte 维护插件注册表（UIPluginRegistry），
  // 按 slot 分发」——本组件兑现这句话：它按 slot 收消息、经 ui-registry 挑选渲染器、
  // 再渲染成具体组件。
  //
  // 挂在哪：App.svelte 的 timeline / float / status 三处，Settings.svelte 的「插件 UI」页。
  // 每个宿主实例在 onMount 时 registerSlotHost(slot, hostId)，卸载时注销 ——
  // 这样 ui-registry 能回答"哪些槽位有内容却没有宿主"（插件无声消失的诊断依据）。
  //
  // 容器样式一律写在 app.css（scoped style 无法作用于父组件传入的动态 class）。
  import { onMount } from 'svelte'
  import PluginCard from './PluginCard.svelte'
  import PluginFrame from './PluginFrame.svelte'
  import type { PluginMessage, PluginSlot } from './ui-plugins'
  import {
    pluginEntryKey,
    registerSlotHost,
    selectVisibleEntries,
    type PluginEntry,
  } from './ui-registry'

  /** 本宿主负责的挂载点。 */
  export let slot: PluginSlot
  /** 待渲染的插件消息（调用方给全量或已过滤均可，本组件按 slot 再过滤一次）。 */
  export let messages: PluginMessage[] = []
  /** 只渲染最近 N 条（status/float 用）。0 = 不限制。 */
  export let limit = 0
  /** 每条消息的外层 class：timeline 用 "message plugin-message" 保证排版。 */
  export let itemClass = 'plugin-host-item'
  /** 容器 class：float 用 plugin-float-stack，status 用 plugin-status-bar。 */
  export let containerClass = 'plugin-host'
  /** card = 完整卡片；inline = 状态栏一行 chip（点击展开完整卡片）。 */
  export let variant: 'card' | 'inline' = 'card'
  /** 宿主 id：同槽多宿主时用于区分（如 'timeline' / 'settings'）。 */
  export let hostId = 'host'
  /** 项目信任门控（批次③）：false 时 iframe 渲染器渲染显式拒绝说明。 */
  export let trusted = true

  /** inline 变体下正在展开的消息 entryId；undefined 表示都收起。
   *  批次①对抗审查 D5：不存下标 —— limit 窗口滑动时下标会错位指向别的消息。 */
  let expanded: string | undefined

  onMount(() => {
    // 清理函数必须由同步回调返回（App.svelte:1562 同款教训）。
    return registerSlotHost(slot, hostId)
  })

  // 渲染管线收在 ui-registry.selectVisibleEntries（纯函数，可单测）：
  // 槽过滤 → 取最近 N 条 → 按注册表解析渲染器。
  $: entries = selectVisibleEntries(slot, messages, limit)
</script>

{#if entries.length}
  <div class={containerClass} data-slot={slot} data-count={entries.length}>
    {#each entries as entry, index (pluginEntryKey(entry, index))}
      {#if variant === 'inline'}
        <div class="plugin-status-item">
          <button
            type="button"
            class="plugin-status-chip"
            data-tone={entry.message.tone}
            aria-expanded={expanded === entry.message.entryId}
            on:click={() => (expanded = expanded === entry.message.entryId ? undefined : entry.message.entryId)}
          >
            <span class="plugin-status-dot" aria-hidden="true"></span>
            <span class="plugin-status-title">{entry.message.title}</span>
          </button>
          {#if expanded === entry.message.entryId}
            <div class="plugin-status-detail">
              <PluginCard message={entry.message} />
            </div>
          {/if}
        </div>
      {:else}
        <div class={itemClass} data-renderer={entry.renderer.id}>
          {#if entry.renderer.spec.kind === 'iframe'}
            <!-- 批次③：沙箱 iframe 渲染器 —— 代码跑在 opaque-origin iframe，前端永不 eval -->
            <PluginFrame message={entry.message} target={entry.renderer.spec.target} {trusted} />
          {:else}
            <PluginCard message={entry.message} />
            {#if entry.renderer.spec.kind !== 'builtin'}
              <!-- 其余非内置 kind：显式说明，绝不静默丢弃 -->
              <p class="plugin-host-note">该插件请求了尚未启用的渲染器「{entry.renderer.id}」。</p>
            {/if}
          {/if}
        </div>
      {/if}
    {/each}
  </div>
{/if}
