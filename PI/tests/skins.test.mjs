// 皮肤注册表单测
//
// 核心契约：SKINS 里的每个 id 必须在 app.css 里有对应的 [data-appearance] 令牌块；
// 反之 CSS 里的皮肤块也必须在 SKINS 注册（否则选色器里是死皮肤/隐藏皮肤）。
// prefs.thinkingOrb（U2）与 skin（第4批）的可选值也在这里锁定。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { SKINS } from '../src/skins.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const appCss = readFileSync(path.join(here, '..', 'src', 'app.css'), 'utf8')
const prefsSource = readFileSync(path.join(here, '..', 'src', 'prefs.ts'), 'utf8')

/** 从 app.css 提取所有已定义的皮肤 id（graphite 是 :root 基础令牌，无独立块） */
function cssSkinIds() {
  const ids = new Set(['graphite']) // graphite = :root 基础令牌（app.css 顶部），无独立覆盖块
  for (const m of appCss.matchAll(/html\[data-appearance="([a-z]+)"\] \{/g)) ids.add(m[1])
  return ids
}

const BASE_SKIN = 'graphite' // :root 基础令牌，无需独立 CSS 块

test('每个注册的皮肤都有 CSS 令牌块（graphite 是 :root 基础，无需独立块）', () => {
  const cssIds = cssSkinIds()
  const missing = SKINS.filter((skin) => skin.id !== BASE_SKIN && !cssIds.has(skin.id))
  assert.deepEqual(
    missing.map((skin) => skin.id),
    [],
    `以下皮肤缺少 app.css 令牌块: ${missing.map((skin) => skin.id).join(', ')}`,
  )
})

test('CSS 里的皮肤块都已在 SKINS 注册（否则是隐藏的死皮肤）', () => {
  const registered = new Set(SKINS.map((skin) => skin.id))
  const orphan = [...cssSkinIds()].filter((id) => id !== BASE_SKIN && !registered.has(id))
  assert.deepEqual(orphan, [], `CSS 有令牌块但未注册: ${orphan.join(', ')}`)
})

test('每个皮肤的 preview 色块齐全（选色器 UI 需要）', () => {
  for (const skin of SKINS) {
    for (const key of ['bg', 'sidebar', 'panel', 'accent', 'border']) {
      assert.ok(skin.preview[key], `${skin.id} 的 preview.${key} 缺失`)
    }
    assert.ok(skin.label && skin.desc, `${skin.id} 缺少 label/desc`)
  }
})

test('液态玻璃皮肤：CSS 含玻璃专属变量与材质层（U2/第4批）', () => {
  // 分段断言，失败时能定位到具体缺哪一项。
  // 注意：app.css 前部本来就有 html[data-theme="dark"] 深色覆盖块，
  // 所以不能用 data-theme="dark" 作为 glass 块的结束锚点。
  const glassStart = appCss.indexOf('data-appearance="glass"')
  const glassBlock = appCss.slice(glassStart, glassStart + 4000)
  assert.ok(glassBlock.includes('--glass-blur'), '玻璃皮肤缺少 --glass-blur')
  assert.ok(glassBlock.includes('--glass-sheen'), '缺少玻璃光泽变量 --glass-sheen')
  assert.ok(appCss.includes('backdrop-filter: blur(var(--glass-blur))'), '缺少 backdrop-filter 材质层')
  // 深色玻璃要有独立令牌（glass + data-theme="dark" 组合选择器）
  assert.match(appCss, /data-appearance="glass"\]\[data-theme="dark"\]/)
})

test('皮肤 id 无重复且符合命名规范（data-appearance 属性值约束）', () => {
  const ids = SKINS.map((skin) => skin.id)
  assert.equal(new Set(ids).size, ids.length, '皮肤 id 重复')
  for (const id of ids) {
    assert.match(id, /^[a-z]+$/, `皮肤 id "${id}" 含非法字符`)
  }
})

test('thinkingOrb 的可选值锁定为 liquid/atom（U2）', () => {
  assert.match(prefsSource, /thinkingOrb: 'liquid' \| 'atom'/, 'thinkingOrb 类型定义漂移')
  assert.match(prefsSource, /thinkingOrb: 'liquid'/, '默认应为液态思考球')
})

test('玻璃材质层引用的每个 class 都真实存在（防死选择器回归，审查 P2-3）', () => {
  // 收集玻璃材质层（第二段玻璃 CSS）里的 class 选择器
  const materialStart = appCss.indexOf('---- 液态玻璃：材质层')
  assert.ok(materialStart > 0, '找不到玻璃材质层注释')
  const materialBlock = appCss.slice(materialStart)
  const referenced = new Set(
    [...materialBlock.matchAll(/html\[data-appearance="glass"\] \.([a-z-]+)/g)].map((m) => m[1]),
  )
  assert.ok(referenced.size >= 10, `材质层解析异常（仅 ${referenced.size} 个 class）`)
  // 白名单：这些 class 必须在 Svelte 源码里真实使用（.overlay > div 除外）
  const svelteSources = collectSvelteSources()
  const allSvelte = svelteSources.join('\n')
  const dead = [...referenced].filter((name) => !allSvelte.includes(`class="${name}`) && !allSvelte.includes(`class:${name}`) && !allSvelte.includes(`"${name}"`))
  assert.deepEqual(
    dead,
    [],
    `玻璃材质层引用了 Svelte 中不存在的 class（死选择器）: ${dead.join(', ')}`,
  )
})

/** 递归读 src 下全部 .svelte 文本（class 存在性校验用） */
function collectSvelteSources() {
  const out = []
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.svelte')) out.push(fs.readFileSync(full, 'utf8'))
    }
  }
  walk(path.join(here, '..', 'src'))
  return out
}
