<script lang="ts">
  // 0-5 批次 B-4b：从 App.svelte 根级抽出的「子代理检视」overlay（全局模态）。
  // viewingSub 状态经 bind:run 留在父组件（finishSubRun 同步、selectSession 分流、
  // TodoPanel/SubRunsPanel 的 onView 回调都在父侧）；slotFor(id) 兜底链需要的运行态
  // 槽位经 runProp 响应式传入（父组件绑定 runState[viewingSub?.id]，viewingSub 为空
  // 时槽位也不可缺——兜底链须维持 slotFor 原语义：无槽位用 { ...blank }，reply 兜底
  // viewingSub.reply）。
  import Icon from './Icon.svelte'
  import MarkdownView from './MarkdownView.svelte'
  import Atom from './Atom.svelte'
  import ThinkingOrb from './ThinkingOrb.svelte'
  import { liveLabel, processSummary } from './run-slot'
  import { t as tt } from './i18n.ts'

  type ProcessStep = { id: string; kind: 'think' | 'tool'; title: string; body: string; done: boolean }
  type SentMessage = { text: string; at: string }
  type SubRunSlot = {
    reply: string
    running: boolean
    sent: SentMessage[]
    process: ProcessStep[]
    confirm?: unknown
    phase?: string
  }

  /** 检视目标（可空）；bind:run 双向，关闭时组件置 null 回写父组件 viewingSub */
  export let run: { id: string; agent: string; task: string; status: string; reply: string } | null = null
  /** 父组件传入的运行态槽位（runState[viewingSub?.id]；viewingSub 为空时为空槽位） */
  export let runProp: SubRunSlot | null = null
  export let showThinking = true
  export let orb: string = 'liquid'

  function liveLabelKey(slot: SubRunSlot): string {
    const label = liveLabel(slot as Parameters<typeof liveLabel>[0])
    if (!label) return ''
    return tt(`live.${label.toLowerCase()}`)
  }

  $: slot = runProp ?? ({ reply: '', running: false, sent: [], process: [] } as SubRunSlot)
  $: visible = slot.process.filter((step) => showThinking !== false || step.kind !== 'think')
  $: summary = processSummary(slot.process, showThinking !== false)
</script>

{#if run}
  <div class="overlay" role="presentation" on:click={(event) => { if (event.target === event.currentTarget) run = null }}>
    <div class="sub-view" role="dialog" aria-label="子会话">
      <header>
        <div><strong>{run.agent}</strong><small>{run.task}</small></div>
        <span class="chip">{run.status === 'running' ? '运行中' : run.status === 'error' ? '失败' : '完成'}</span>
        <button type="button" on:click={() => (run = null)}>关闭</button>
      </header>
      <div class="sub-body">
        {#each slot.sent as message}<div class="message user-message"><div class="user-bubble">{message.text}</div></div>{/each}
        {#if slot.reply || run.reply}<div class="message assistant-message"><div class="message-meta"><strong>{run.agent}</strong><span>只读</span></div><MarkdownView text={slot.reply || run.reply} copyable={false} /></div>{/if}
        {#if visible.length}
          <div class="process-card open">
            <div class="process-head"><span class="process-head-main"><span>{summary}</span></span></div>
            <div class="process-body">
              {#each visible as step (step.id)}
                <div class="process-step" class:run={!step.done} class:tool={step.kind === 'tool'}><span class="process-step-mark"><i class:live={!step.done}></i>{#if step.done}<Icon name="check" size={11} />{/if}</span><span class="process-step-copy"><strong>{step.kind === 'think' ? '思考' : step.title}</strong>{#if step.body}<span class="process-preview" title={step.body}>{step.body}</span>{/if}</span></div>
              {/each}
            </div>
          </div>
        {/if}
        {#if slot.running}
          <div class="live-status">
            {#if orb === 'liquid'}
              <ThinkingOrb size={56} />
            {:else}
              <Atom size={56} />
            {/if}
            <strong>{liveLabelKey(slot) || tt('live.working')}</strong>
          </div>
        {/if}
      </div>
      <footer>只读检视，请在父会话继续对话。</footer>
    </div>
  </div>
{/if}
