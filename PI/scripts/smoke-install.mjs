// 装机前冒烟（2026-09-29 事故的验收脚本）
//
// 在**临时目录**完整模拟安装布局：
//   <tmp>/Pi-My/resources/{node.exe, node_modules, sidecar, package.json}
// 然后跑一串真实请求 —— 任何"只有装机才暴露"的问题（缺失裸包名、路径假设、
// 资源漏拷）都会在这里当场炸出来，而不是等用户装完打开才发现。
//
// 用真实的打包 node.exe（若存在），与用户环境一致。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')
const realResources = path.join(projectRoot, 'src-tauri', 'resources')

const simRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-my-install-sim-'))
const simResources = path.join(simRoot, 'Pi-My', 'resources')
fs.mkdirSync(simResources, { recursive: true })

console.log('模拟安装目录:', simResources)
// sidecar + package.json 直接拷贝；node_modules 用 junction（体积大，语义等价）
fs.cpSync(path.join(realResources, 'sidecar'), path.join(simResources, 'sidecar'), { recursive: true })
if (fs.existsSync(path.join(realResources, 'package.json'))) {
  fs.copyFileSync(path.join(realResources, 'package.json'), path.join(simResources, 'package.json'))
}
const realModules = path.join(realResources, 'node_modules')
if (fs.existsSync(realModules)) {
  fs.symlinkSync(realModules, path.join(simResources, 'node_modules'), 'junction')
}
// 用打包的 node.exe（真实用户环境），回退到系统 node
const realNode = path.join(realResources, 'node.exe')
const nodeBin = fs.existsSync(realNode) ? realNode : process.execPath
console.log('使用 node:', nodeBin)

// 先做一次纯同步的"模块可加载性"预检：直接 import 入口（若缺包会立刻报错）
const entry = path.join(simResources, 'sidecar', 'index.mjs')
const precheck = spawn(nodeBin, ['--input-type=module', '-e', `
  const url = ${JSON.stringify(new URL('file:///' + entry.replace(/\\\\/g, '/')).href)}
  await import(url)
`], { cwd: simResources, stdio: ['ignore', 'pipe', 'pipe'] })

const child = spawn(nodeBin, [entry], {
  cwd: simResources,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, PI_TRUST_ALL: '1' },
})
let buf = ''
let stderrText = ''
const pending = new Map()
child.stdout.on('data', (chunk) => {
  buf += chunk.toString()
  let index
  while ((index = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, index)
    buf = buf.slice(index + 1)
    if (!line.trim()) continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    if (message.type === 'response' && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  }
})
child.stderr.on('data', (chunk) => { stderrText += chunk.toString() })

const req = (id, type, payload) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ ok: false, error: `超时(${type})` }), 90_000)
  pending.set(id, (m) => { clearTimeout(timer); resolve(m) })
  child.stdin.write(JSON.stringify({ id, type, payload }) + '\n')
})

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
}

// 1) 关键：sidecar 能否启动（模块解析全通过）—— 这正是本次事故的死因
const init = await req(1, 'init', { cwd: simRoot })
check('sidecar 启动（init）', init.ok === true, init.ok ? '' : String(init.error || '').slice(0, 300) || stderrText.slice(0, 300))
if (!init.ok) {
  console.log('\nstderr:\n' + stderrText.slice(0, 800))
  child.kill()
  fs.rmSync(simRoot, { recursive: true, force: true })
  process.exit(1)
}

// 2) 会话创建（走 SDK + 扩展加载）
const created = await req(2, 'create_session', { sessionId: 'smoke', cwd: simRoot, mode: 'ask' })
check('创建会话', created.ok === true, created.ok ? '' : String(created.error || ''))

// 3) show_image 工具已注册（本次事故的当事模块）
const state = await req(3, 'get_state', { sessionId: 'smoke' })
const tools = state.result?.tools ?? []
check('get_state 快照', state.ok === true)
check('show_image 工具已注册', tools.includes('show_image'), `工具: ${tools.join(',')}`)

// 4) 权限引擎（含 tmp-zone / 规则求值）
const mode = await req(4, 'set_mode', { sessionId: 'smoke', mode: 'plan' })
check('模式切换（权限引擎求值）', mode.ok === true && (mode.result?.tools ?? []).includes('read'))

// 5) 长期记忆（node:sqlite 在打包 node.exe 下可用）
const mem = await req(5, 'memory_remember', { content: '装机冒烟测试记忆' })
check('长期记忆写入（node:sqlite）', mem.ok === true, mem.ok ? `id=${mem.result?.id}` : String(mem.error || ''))
const found = await req(6, 'memory_search', { query: '冒烟测试' })
check('长期记忆检索（FTS5）', found.ok === true && (found.result?.memories ?? []).length >= 1)

// 6) 原子写 + MCP 配置读取
const mcp = await req(7, 'mcp_list', {})
check('MCP 配置读取', mcp.ok === true)
const trust = await req(8, 'trust_project', { cwd: simRoot, trusted: true })
check('项目信任写入（原子写）', trust.ok === true)

// 7) 分块读文件（2-12）
fs.writeFileSync(path.join(simRoot, 'big.txt'), Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n'))
const chunk = await req(9, 'read_file_chunk', { cwd: simRoot, path: 'big.txt', offset: 0, limit: 10 })
check('分块读文件', chunk.ok === true && chunk.result?.totalLines === 500, `totalLines=${chunk.result?.totalLines}`)

// 8) 事件流（prompt 会因无凭据报 error，但事件通道必须通）
let sawEvent = false
await new Promise((resolve) => {
  const onData = (c) => { if (String(c).includes('"type":"event"')) sawEvent = true }
  child.stdout.on('data', onData)
  void req(10, 'prompt', { sessionId: 'smoke', text: 'hello', behavior: 'followUp' })
  setTimeout(() => { child.stdout.off('data', onData); resolve() }, 8000)
})
check('事件通道（prompt → event）', sawEvent, sawEvent ? '' : '未收到事件（无凭据时应至少收到 error 事件）')

child.kill()
precheck.kill()
fs.rmSync(simRoot, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过`)
if (failed.length) {
  console.log('失败项: ' + failed.map((f) => f.name).join(', '))
  process.exit(1)
}
console.log('装机冒烟全部通过 —— 安装包可交付')
process.exit(0)
