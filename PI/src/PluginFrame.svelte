<!--
  1-5 批次③：iframe 沙箱渲染器宿主。
  第三方 UI 代码跑在 sandbox="allow-scripts" 的 opaque-origin iframe 里
  （无 allow-same-origin ⇒ 读不到父页 DOM/token/localStorage —— 物理隔离）。
  数据单向推入（postMessage），能力白名单出（resize/notify，见 ui-sandbox.ts）。
  信任门控：trusted=false 时渲染明确的拒绝说明（绝不静默丢弃）。
-->
<script lang="ts">
  import { onMount } from 'svelte'
  import type { PluginMessage } from './ui-plugins'
  import {
    SANDBOX_IFRAME_SANDBOX_ATTR,
    buildSandboxSrcdoc,
    parseSandboxFrameMessage,
    sandboxDataMessage,
  } from './ui-sandbox'

  export let message: PluginMessage
  /** 渲染器声明里的 target（sandbox:xxx 标识 —— 预留多沙箱页；当前单一内置桥页，暂未消费） */
  // svelte 提示未使用：target 是外部契约（PluginHost 传入），模板暂不消费但保留签名
  export let target: string = ''
  void target
  /** 项目信任门控结果（sidecar list_ui_renderers 给出） */
  export let trusted = true
  /** 通知回调（notify 白名单消息上浮为宿主 toast） */
  export let onNotify: ((text: string, tone: string) => void) | undefined = undefined

  let frame: HTMLIFrameElement | undefined
  let frameHeight = 56

  // srcdoc 文档：桥脚本 + 消息体文本。body 已过 sanitizeHtml（ui-plugins.ts），
  // 这里作为纯文本进 iframe 再由扩展脚本自行呈现 —— 双层隔离。
  $: doc = buildSandboxSrcdoc({ body: buildBodyHtml(message) })

  function buildBodyHtml(m: PluginMessage): string {
    // 进入 iframe 的是「数据」：body + title + fields，全部按文本转义后塞进
    // 隐藏模板节点，扩展脚本用 textContent 读 —— 绝不直接注入扩展 HTML 结构。
    // payload 里的闭合标签必须拆散（承重：否则 srcdoc 文档被提前截断、注入任意 HTML）。
    // 注意：Svelte 模板解析器会把组件 <script> 块里的 "</script" 字面量当成脚本块
    // 结束符 —— 即便在注释或字符串里 —— 所以本文件任何位置都不得出现该字面量；
    // regex 一律用 <\/ + BACKSLASH 构造，模板串闭合用 </${''}script> 拼接。
    const fields = (m.fields ?? []).map((f) => ({ label: f?.label ?? '', value: f?.value ?? '' }))
    const payload = JSON.stringify({ customType: m.customType, title: m.title ?? '', body: m.body ?? '', fields })
      // JSON 文本里的 "<\/script" 变体会提前闭合 srcdoc 里的 script 节点：把 `/` 拆开
      .replace(new RegExp(`<${'/'}(script|${'script'})`, 'gi'), '<\\/$1')
    return `<script type="application/json" id="plugin-payload">${payload}</${''}script>`
  }

  function pushData(): void {
    // iframe load 后把插件数据推给扩展脚本（单向：数据进，特权不出）
    if (!frame?.contentWindow) return
    frame.contentWindow.postMessage(
      sandboxDataMessage({ customType: message.customType, body: message.body ?? '', title: message.title, fields: message.fields }),
      '*',
    )
  }

  function onFrameMessage(event: MessageEvent): void {
    // 只收本 iframe 的消息（source 校验承重 —— 其他窗口的消息直接忽略）
    if (!frame || event.source !== frame.contentWindow) return
    const parsed = parseSandboxFrameMessage(event.data)
    if (!parsed) return
    if (parsed.kind === 'resize') {
      frameHeight = parsed.height
      return
    }
    if (parsed.kind === 'notify') {
      // 就绪信标不上浮
      if (parsed.text === 'ready') return
      onNotify?.(parsed.text, parsed.tone)
    }
  }

  onMount(() => {
    window.addEventListener('message', onFrameMessage)
    return () => window.removeEventListener('message', onFrameMessage)
  })
</script>

{#if trusted}
  <div class="plugin-frame" style="height: {frameHeight}px">
    <!-- svelte-ignore a11y_iframe_has_title -->
    <iframe
      bind:this={frame}
      sandbox={SANDBOX_IFRAME_SANDBOX_ATTR}
      srcdoc={doc}
      title={message.title || '插件渲染器'}
      on:load={pushData}
    ></iframe>
  </div>
{:else}
  <p class="plugin-host-note">该插件的沙箱渲染器已就绪，但当前项目尚未受信。请在「设置 → 插件 UI」中确认项目信任后重试。</p>
{/if}

<style>
  .plugin-frame {
    border: 0;
    overflow: hidden;
    transition: height 120ms ease;
  }
  .plugin-frame iframe {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
    background: transparent;
  }
</style>
