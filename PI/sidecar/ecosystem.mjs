import { mkdir, readdir, readFile, rename, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const VISION_FILE = 'pi-desktop-vision.json'
const VISION_PROMPT = '请详细描述这张图片的内容。如果有文字请完整转录；如果是图表请说明类型和关键数值。使用中文。'

let featuredCache = null
async function featuredPrompts() {
  if (featuredCache) return featuredCache
  try {
    const html = await (await fetch('https://prompts.chat/', { signal: AbortSignal.timeout(15000) })).text()
    const idx = html.indexOf('Featured Prompts</h2>')
    const chunk = html.slice(idx > 0 ? idx : 0, idx > 0 ? idx + 30000 : 0)
    const ids = [...chunk.matchAll(/href="\/prompts\/([a-z0-9]+)_[a-z0-9-]+"[^>]*>([^<]+)<\/a>/g)].map((m) => ({ id: m[1], title: m[2] }))
    const items = []
    for (const { id } of ids.slice(0, 8)) {
      try {
        const r = await fetch(`https://prompts.chat/api/prompts/${id}`, { signal: AbortSignal.timeout(12000) })
        if (!r.ok) continue
        const p = await r.json()
        if (!p || !p.id) continue
        items.push({
          id: p.id,
          title: p.title,
          description: p.description || '',
          content: p.content || '',
          author: p.author?.name || '',
          category: p.category?.name || '',
          votes: p.voteCount || 0,
          views: p.viewCount || 0,
          featured: true
        })
      } catch { /* skip */ }
    }
    featuredCache = items
  } catch { featuredCache = [] }
  return featuredCache
}

const XUE_SEED = [
  { id: 'x1', category: '写作', title: '润色中文', content: '请润色以下中文，保持原意，让表达更准确、简洁、专业。' },
  { id: 'x2', category: '写作', title: '会议纪要', content: '把下面的讨论整理成会议纪要：结论、待办、责任人、截止时间。' },
  { id: 'x3', category: '编程', title: '代码审查', content: '请审查这段代码：正确性、可读性、性能、安全，并给出修改建议。' },
  { id: 'x4', category: '编程', title: '解释报错', content: '请解释以下报错的原因，给出最小复现和修复步骤。' },
  { id: 'x5', category: '编程', title: '重构方案', content: '在不改变外部行为的前提下，提出分层重构方案和迁移步骤。' },
  { id: 'x6', category: '产品', title: '需求拆分', content: '把这个需求拆成可开发的用户故事，含验收标准和优先级。' },
  { id: 'x7', category: '产品', title: '竞品对比', content: '对比相关产品的核心功能、差异和可借鉴点，列成表格。' },
  { id: 'x8', category: '学习', title: '费曼讲解', content: '用费曼技巧讲解这个概念，先给类比，再给严谨定义。' },
  { id: 'x9', category: '翻译', title: '中英对照', content: '翻译以下内容，中英对照，保留术语一致性。' },
  { id: 'x10', category: '职场', title: '周报', content: '根据以下工作记录写周报：进展、风险、下周计划。' }
]

function slug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || `item-${Date.now()}`
}

async function exists(file) {
  try { await stat(file); return true } catch { return false }
}

async function listMarkdownSkills(root, source, sourceLabel) {
  if (!await exists(root)) return []
  const out = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(root, entry.name)
    const disabled = entry.name.endsWith('.disabled')
    if (entry.isDirectory()) {
      const skillMd = path.join(full, 'SKILL.md')
      const name = entry.name.replace(/\.disabled$/, '')
      out.push({
        id: `${source}:${name}`,
        name,
        path: await exists(skillMd) ? skillMd : full,
        source,
        sourceLabel,
        type: 'directory',
        enabled: !disabled
      })
    } else if (entry.name.endsWith('.md') || entry.name.endsWith('.md.disabled')) {
      const name = entry.name.replace(/\.md(\.disabled)?$/, '')
      out.push({ id: `${source}:${name}`, name, path: full, source, sourceLabel, type: 'markdown', enabled: !disabled })
    }
  }
  return out
}

async function listExtensionFiles(root, source, sourceLabel) {
  if (!await exists(root)) return []
  const out = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const disabled = entry.name.endsWith('.disabled')
    const name = entry.name.replace(/\.disabled$/, '')
    if (entry.isFile() && /\.(ts|js)$/.test(name)) {
      out.push({ id: `${source}:${name}`, name, path: path.join(root, entry.name), source, sourceLabel, type: 'file', enabled: !disabled, builtin: name.includes('retry-no-body') })
    } else if (entry.isDirectory()) {
      out.push({ id: `${source}:${name}`, name, path: path.join(root, entry.name), source, sourceLabel, type: 'directory', enabled: !disabled, builtin: false })
    }
  }
  return out
}

async function listNpmPackages(agentDir) {
  try {
    const raw = JSON.parse(await readFile(path.join(agentDir, 'npm', 'package.json'), 'utf8'))
    const deps = raw.dependencies && typeof raw.dependencies === 'object' ? raw.dependencies : {}
    return Object.keys(deps).map((name) => ({
      id: `npm:${name}`,
      name,
      path: 'npm',
      source: 'npm',
      sourceLabel: 'npm 包',
      type: 'package',
      enabled: true,
      builtin: false
    }))
  } catch {
    return []
  }
}

export async function listEco(agentDir, cwd) {
  const skills = [
    ...await listMarkdownSkills(path.join(agentDir, 'skills'), 'global', '全局 Skills'),
    ...await listMarkdownSkills(path.join(cwd, '.pi', 'skills'), 'project', '项目 Skills')
  ]
  const extensions = [
    { id: 'builtin:retry-no-body', name: 'pi-deck-retry-no-body', path: 'builtin', source: 'builtin', sourceLabel: '内置', type: 'file', enabled: true, builtin: true, description: '空响应 / 瞬态网关错误自动改写以便重试' },
    { id: 'builtin:imagegen-skill', name: 'image-generation', path: 'template', source: 'builtin', sourceLabel: '内置模板', type: 'markdown', enabled: true, builtin: true, description: 'OpenAI 兼容生图技能模板' },
    ...await listExtensionFiles(path.join(agentDir, 'extensions'), 'global', '全局扩展'),
    ...await listExtensionFiles(path.join(cwd, '.pi', 'extensions'), 'project', '项目扩展'),
    ...await listNpmPackages(agentDir)
  ]
  return {
    skills,
    extensions,
    locations: {
      skillsGlobal: path.join(agentDir, 'skills'),
      skillsProject: path.join(cwd, '.pi', 'skills'),
      extGlobal: path.join(agentDir, 'extensions'),
      extProject: path.join(cwd, '.pi', 'extensions'),
      prompts: path.join(agentDir, 'prompts')
    }
  }
}

export async function toggleEco(targetPath, enable) {
  if (!targetPath || targetPath === 'builtin' || targetPath === 'template') throw new Error('内置项请在设置中配置，无需开关文件')
  const disabled = targetPath.endsWith('.disabled')
  if (enable && disabled) {
    const next = targetPath.slice(0, -'.disabled'.length)
    await rename(targetPath, next)
    return { path: next, enabled: true }
  }
  if (!enable && !disabled) {
    const next = `${targetPath}.disabled`
    await rename(targetPath, next)
    return { path: next, enabled: false }
  }
  return { path: targetPath, enabled: !disabled }
}

export async function searchPrompts(query) {
  const q = String(query || '').trim()
  const params = new URLSearchParams({ q, perPage: q ? '20' : '40' })
  const response = await fetch(`https://prompts.chat/api/prompts?${params}`, { signal: AbortSignal.timeout(12000) })
  if (!response.ok) throw new Error(`prompts.chat HTTP ${response.status}`)
  const raw = await response.json()
  const prompts = Array.isArray(raw.prompts) ? raw.prompts : []
  // 精选优先（isFeatured / featuredAt），再按投票数、浏览数排序
  prompts.sort((a, b) => {
    if (Boolean(a.isFeatured) !== Boolean(b.isFeatured)) return a.isFeatured ? -1 : 1
    const da = a.featuredAt ? new Date(a.featuredAt).getTime() : 0
    const db = b.featuredAt ? new Date(b.featuredAt).getTime() : 0
    if (db !== da) return db - da
    if (Number(b.voteCount || 0) !== Number(a.voteCount || 0)) return Number(b.voteCount || 0) - Number(a.voteCount || 0)
    return Number(b.viewCount || 0) - Number(a.viewCount || 0)
  })
  let items = prompts.map((item) => ({
    id: item.id,
    title: item.title,
    description: item.description || '',
    content: item.content || '',
    author: item.author?.name || '',
    category: item.category?.name || '',
    votes: item.voteCount || 0,
    views: item.viewCount || 0,
    featured: Boolean(item.isFeatured)
  }))
  let featured = []
  if (!q) {
    try { featured = await featuredPrompts() } catch { featured = [] }
    const seen = new Set(featured.map((item) => item.id))
    items = [...featured, ...items.filter((item) => !seen.has(item.id))]
  }
  return {
    query: q,
    total: (raw.total ?? prompts.length) + featured.length,
    items
  }
}

export async function searchSkillsHub(query) {
  const q = String(query || '').trim() || 'agent'
  const response = await fetch(`https://www.skills.sh/api/search?q=${encodeURIComponent(q)}&limit=30`, { signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(`skills.sh HTTP ${response.status}`)
  const json = await response.json()
  const skills = Array.isArray(json.skills ?? json.items) ? (json.skills ?? json.items) : []
  skills.sort((a, b) => Number(b.installs || b.downloads || 0) - Number(a.installs || a.downloads || 0))
  return {
    query: q,
    items: skills.map((item) => ({
      slug: item.id || item.slug || item.skillId,
      name: item.name || item.title || item.id,
      installs: item.installs || item.downloads || 0,
      source: item.source || 'skills.sh'
    }))
  }
}

export async function searchExtensions(query) {
  const q = String(query || '').trim()
  const text = q ? `keywords:pi-package ${q}` : 'keywords:pi-package'
  const response = await fetch(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=20`, { signal: AbortSignal.timeout(12000) })
  if (!response.ok) throw new Error(`npm HTTP ${response.status}`)
  const json = await response.json()
  const items = (json.objects || []).map((entry) => ({
    name: entry.package?.name,
    description: entry.package?.description || '',
    version: entry.package?.version,
    url: entry.package?.links?.npm,
    updatedAt: entry.package?.date || '',
    score: Number(entry.score?.final || 0),
    downloads: 0
  })).filter((item) => item.name)
  await Promise.all(items.map(async (item) => {
    try {
      const r = await fetch(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(item.name)}`, { signal: AbortSignal.timeout(6000) })
      if (r.ok) { const d = await r.json(); item.downloads = Number(d.downloads || 0) }
    } catch { /* ignore */ }
  }))
  items.sort((a, b) => b.score - a.score || b.downloads - a.downloads)
  return { query: q, items }
}

export function searchXue(query, category, page = 1) {
  const q = (query || '').trim().toLowerCase()
  let items = XUE_SEED.filter((item) => (!category || item.category === category) && (!q || item.title.includes(q) || item.content.includes(q) || item.category.includes(q)))
  const categories = [...new Set(XUE_SEED.map((item) => item.category))]
  const perPage = 8
  const total = items.length
  items = items.slice((page - 1) * perPage, page * perPage)
  return { categories, total, page, perPage, items, note: '内置精选。完整 XuePrompt 库未打包，可同时搜 prompts.chat。' }
}

export async function downloadPet(agentDir, pet) {
  if (pet?.type === 'sprite') return downloadSpritePet(agentDir, pet)
  return downloadLive2DPet(agentDir, pet)
}

async function downloadSpritePet(agentDir, pet) {
  const id = slug(pet?.id || 'pet')
  const spriteUrl = String(pet?.spriteUrl || '')
  if (!spriteUrl) throw new Error('精灵图 URL 缺失')
  if (!/^https?:\/\//i.test(spriteUrl)) throw new Error('精灵图 URL 无效')
  const base = path.join(agentDir, 'pets', id)
  await mkdir(base, { recursive: true })
  const resp = await fetch(spriteUrl, { signal: AbortSignal.timeout(120000) })
  if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}`)
  await writeFile(path.join(base, 'sprite.webp'), Buffer.from(await resp.arrayBuffer()))
  await writeFile(path.join(base, 'pet.json'), JSON.stringify({ id, displayName: pet?.name || id, description: pet?.description || '', spritesheetPath: 'sprite.webp' }, null, 2))
  return { id, dir: base, count: 2, model: path.join(base, 'pet.json'), sprite: 'sprite.webp' }
}

async function downloadLive2DPet(agentDir, pet) {
  const repo = String(pet?.repo || '')
  const branch = String(pet?.branch || 'master')
  const dir = String(pet?.dir || '')
  const petId = slug(pet?.id || dir.split('/').pop() || 'pet')
  if (!repo || !dir) throw new Error('模型信息不完整')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.split('/').some((part) => part === '.' || part === '..')) throw new Error('模型仓库地址无效')
  if (branch.includes('..') || branch.startsWith('/') || branch.includes('\\')) throw new Error('模型分支无效')
  if (dir.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('模型目录无效')
  const encodedBranch = encodeURIComponent(branch)
  const treeUrl = `https://api.github.com/repos/${repo}/git/trees/${encodedBranch}?recursive=1`
  const treeResp = await fetch(treeUrl, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'pi-my', Accept: 'application/vnd.github+json' } })
  if (!treeResp.ok) throw new Error(`列目录失败 HTTP ${treeResp.status}`)
  const tree = await treeResp.json()
  const files = (Array.isArray(tree.tree) ? tree.tree : []).filter((entry) => entry.type === 'blob' && entry.path.startsWith(`${dir}/`))
  if (!files.length) throw new Error('未找到模型文件')
  const base = path.join(agentDir, 'pets', petId)
  await mkdir(base, { recursive: true })
  for (const f of files) {
    const rel = f.path.slice(dir.length + 1)
    const url = `https://cdn.jsdelivr.net/gh/${repo}@${encodedBranch}/${f.path.split('/').map(encodeURIComponent).join('/')}`
    const resp = await fetch(url, { signal: AbortSignal.timeout(120000) })
    if (!resp.ok) continue
    const target = path.resolve(base, rel)
    if (target !== base && !target.startsWith(`${base}${path.sep}`)) continue
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, Buffer.from(await resp.arrayBuffer()))
  }
  const modelFile = files.find((f) => f.path.endsWith('.model3.json') || f.path.endsWith('.model.json'))
  return { id: petId, dir: base, count: files.length, model: modelFile ? path.join(base, modelFile.path.slice(dir.length + 1)) : null }
}

export async function listPets(agentDir, base) {
  const root = path.join(agentDir, 'pets')
  const pets = []
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const dir = path.join(root, entry.name)
      // sprite：pet.json
      try {
        const manifest = JSON.parse(await readFile(path.join(dir, 'pet.json'), 'utf8'))
        if (manifest.spritesheetPath) {
          pets.push({ id: entry.name, sprite: manifest.spritesheetPath })
          continue
        }
      } catch { /* 非 sprite */ }
      // live2d：递归找 model3.json / model.json
      const files = []
      async function walk(d) {
        for (const e of await readdir(d, { withFileTypes: true })) {
          const full = path.join(d, e.name)
          if (e.isDirectory()) await walk(full)
          else files.push(path.relative(root, full).replaceAll('\\', '/'))
        }
      }
      await walk(dir)
      const model = files.find((f) => f.endsWith('.model3.json') || f.endsWith('.model.json'))
      if (model) pets.push({ id: entry.name, model })
    }
  } catch { /* 还没下载过桌宠 */ }
  return { base, pets }
}

export async function installPrompt(agentDir, item) {
  const dir = path.join(agentDir, 'prompts')
  await mkdir(dir, { recursive: true })
  const name = slug(item.title || item.name)
  const file = path.join(dir, `${name}.md`)
  const body = `---\nname: ${name}\ndescription: ${(item.description || item.title || '').replace(/\r?\n/g, ' ')}\nsource: store\n---\n\n# ${item.title || name}\n\n${item.content || ''}\n`
  await writeFile(file, body, 'utf8')
  return { path: file, name }
}

export async function installSkill(agentDir, cwd, item, scope = 'global') {
  const root = scope === 'project' ? path.join(cwd, '.pi', 'skills') : path.join(agentDir, 'skills')
  const name = slug(item.title || item.name)
  const dir = path.join(root, name)
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, 'SKILL.md')
  const body = `---\nname: ${name}\ndescription: ${(item.description || item.title || '').replace(/\r?\n/g, ' ')}\nsource: ${item.source || 'store'}\n---\n\n# ${item.title || name}\n\n${item.content || item.description || ''}\n`
  await writeFile(file, body, 'utf8')
  return { path: file, name, scope }
}

export async function installImageGenSkill(agentDir) {
  return installSkill(agentDir, agentDir, {
    title: 'image-generation',
    description: 'OpenAI 兼容图片生成技能模板',
    content: '当用户要求生成图片时，使用已配置的 OpenAI 兼容 images/generations 接口。不要编造未返回的图片。',
    source: 'builtin'
  }, 'global')
}

export async function readVision(agentDir) {
  try {
    const parsed = JSON.parse(await readFile(path.join(agentDir, VISION_FILE), 'utf8'))
    const merged = { enabled: false, provider: '', model: '', baseUrl: '', apiKey: '', promptTemplate: VISION_PROMPT, ...parsed }
    return { ...merged, apiKey: merged.apiKey ? '••••' : '', hasKey: Boolean(parsed.apiKey) }
  } catch {
    return { enabled: false, provider: '', model: '', baseUrl: '', apiKey: '', promptTemplate: VISION_PROMPT, hasKey: false }
  }
}

export async function writeVision(agentDir, data) {
  let previous = {}
  try { previous = JSON.parse(await readFile(path.join(agentDir, VISION_FILE), 'utf8')) } catch { previous = {} }
  const incoming = String(data?.apiKey || '')
  const next = {
    enabled: Boolean(data?.enabled),
    provider: String(data?.provider || ''),
    model: String(data?.model || ''),
    baseUrl: String(data?.baseUrl || '').replace(/\/+$/, ''),
    apiKey: incoming && incoming !== '••••' ? incoming : String(previous.apiKey || ''),
    promptTemplate: String(data?.promptTemplate || VISION_PROMPT)
  }
  await mkdir(agentDir, { recursive: true })
  await writeFile(path.join(agentDir, VISION_FILE), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return { ...next, apiKey: next.apiKey ? '••••' : '', hasKey: Boolean(next.apiKey) }
}

export async function describeImage(agentDir, image) {
  const config = await readVision(agentDir)
  if (!config.enabled) return { skipped: true }
  if (!config.baseUrl || !config.apiKey || !config.model) throw new Error('视觉桥未配置模型 / 接口 / Key')
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: config.promptTemplate || VISION_PROMPT },
          { type: 'image_url', image_url: { url: `data:${image.mimeType || 'image/png'};base64,${image.data}` } }
        ]
      }]
    }),
    signal: AbortSignal.timeout(120000)
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`视觉桥 HTTP ${response.status}: ${text.slice(0, 200)}`)
  const json = JSON.parse(text)
  const description = json.choices?.[0]?.message?.content
  if (!description) throw new Error('视觉桥未返回描述')
  return { description }
}

export { VISION_PROMPT }
