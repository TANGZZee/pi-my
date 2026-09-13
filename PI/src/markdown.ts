function escapeHtml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function safeUrl(raw: string) {
  const url = raw.trim()
  if (/^https?:\/\//i.test(url) || /^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(url) || /^blob:/i.test(url)) return url
  if (/^(\.\/|\/|[A-Za-z]:[\\/]|[A-Za-z0-9._\-]+\/)/.test(url) && !url.includes('..') && !/[\s<>"]/.test(url)) return url
  return null
}

function inline(text: string) {
  let out = escapeHtml(text)
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_m, alt, src) => {
    const url = safeUrl(src.replace(/&amp;/g, '&'))
    if (!url) return escapeHtml(`![${alt}](${src})`)
    return `<img class="md-img" src="${escapeHtml(url)}" alt="${alt}" loading="lazy" />`
  })
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, src) => {
    const url = safeUrl(src.replace(/&amp;/g, '&'))
    if (!url || url.startsWith('data:') || url.startsWith('blob:')) return label
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${label}</a>`
  })
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>')
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/__(.+?)__/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*])\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1<em>$2</em>')
  out = out.replace(/(https?:\/\/[^\s<]+)/g, (url) => {
    if (out.includes(`href="${url}"`) || out.includes(`src="${url}"`)) return url
    const safe = safeUrl(url)
    return safe ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noreferrer">${escapeHtml(url)}</a>` : escapeHtml(url)
  })
  return out
}

function closeLists(stack: string[]) {
  let html = ''
  while (stack.length) html += stack.pop() === 'ol' ? '</ol>' : '</ul>'
  return html
}

/** 流式友好：未闭合的围栏按代码块渲染，第一帧到结束都能出 HTML。 */
export function renderMarkdown(source: string) {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  let html = ''
  let fence: { lang: string; body: string[] } | null = null
  const lists: string[] = []
  let para: string[] = []

  const flushPara = () => {
    if (!para.length) return
    html += `<p>${inline(para.join('\n'))}</p>`
    para = []
  }

  for (const line of lines) {
    const fenceOpen = line.match(/^```([\w+-]*)\s*$/)
    if (fence) {
      if (/^```\s*$/.test(line)) {
        html += `<pre><code${fence.lang ? ` class="lang-${escapeHtml(fence.lang)}"` : ''}>${escapeHtml(fence.body.join('\n'))}</code></pre>`
        fence = null
      } else fence.body.push(line)
      continue
    }
    if (fenceOpen) {
      flushPara()
      html += closeLists(lists)
      fence = { lang: fenceOpen[1] || '', body: [] }
      continue
    }
    if (/^\s*$/.test(line)) {
      flushPara()
      html += closeLists(lists)
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      flushPara()
      html += closeLists(lists)
      const level = heading[1].length
      html += `<h${level}>${inline(heading[2])}</h${level}>`
      continue
    }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara()
      html += closeLists(lists)
      html += '<hr />'
      continue
    }
    if (/^>\s?/.test(line)) {
      flushPara()
      html += closeLists(lists)
      html += `<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`
      continue
    }
    const ul = line.match(/^[-*+]\s+(.+)$/)
    const ol = line.match(/^\d+\.\s+(.+)$/)
    if (ul || ol) {
      flushPara()
      const kind = ul ? 'ul' : 'ol'
      if (lists[lists.length - 1] !== kind) {
        html += closeLists(lists)
        lists.push(kind)
        html += kind === 'ol' ? '<ol>' : '<ul>'
      }
      html += `<li>${inline((ul || ol)?.[1] || '')}</li>`
      continue
    }
    html += closeLists(lists)
    para.push(line)
  }
  if (fence) html += `<pre><code${fence.lang ? ` class="lang-${escapeHtml(fence.lang)}"` : ''}>${escapeHtml(fence.body.join('\n'))}</code></pre>`
  flushPara()
  html += closeLists(lists)
  return html || '<p></p>'
}
