// sidecar 级集成测试：真实 spawn `sidecar/index.mjs`，用 NDJSON 驱动。
//
// 为什么必须要有它（审查员的结论）：本次三个最有价值的缺陷
//   - forkSession 的审批扩展读到过期 mode（对象身份分裂）→ ask 模式确认被绕过
//   - openSession 硬编码 DEFAULT_MODE → plan 会话重开后静默获得写权限
//   - 模式切换丢失工具集（P0-2）
// 全都是"纯函数单测抓不到、只有真跑 sidecar 才暴露"的问题。
//
// 注意：这些用例**不需要真实模型凭据**（只做会话/工具/模式操作，不发 prompt）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')

/** 启动 sidecar 并用 NDJSON 与其对话；返回 req 与 close。
 *  `entry` 可指定入口脚本（默认源码 sidecar/index.mjs；
 *  传 'src-tauri/resources/sidecar/index.mjs' 则验证**打包产物**）。
 *  PI_TRUST_ALL=1：2-14 的项目信任弹窗会阻塞 create_session（等用户回答），
 *  集成测试不测信任语义时用它跳过弹窗（专用的信任 E2E 不带此变量）。 */
function startSidecar(entry = 'sidecar/index.mjs') {
  const child = spawn(process.execPath, [entry], {
    cwd: projectRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PI_TRUST_ALL: '1' },
  })
  let buffer = ''
  const pending = new Map()
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      if (message.type === 'response' && pending.has(message.id)) {
        pending.get(message.id)(message)
        pending.delete(message.id)
      }
    }
  })
  child.stderr.on('data', () => { /* sidecar 日志噪音，测试不关心 */ })
  let sequence = 0
  // 超时参数化（审查 P1）：本地 init 实测 24.7s，CI windows runner 慢 2-3 倍；
  // 30s 硬编码在 CI 上会误报超时。
  // 2026-10-01 再修：本地机器高负载（16 逻辑核 68% 占用）下 init 实测 17s、
  // create_session（建 runtime + 绑定扩展 UI）叠加排队后 >30s —— 首个测试反复
  // 以「create_session 超时」假失败。本地超时提高到 60s；CI 维持 120s。
  const requestTimeoutMs = process.env.CI ? 120_000 : 60_000
  const req = (type, payload) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`sidecar 请求超时: ${type}`))
    }, requestTimeoutMs)
    pending.set(id, (message) => { clearTimeout(timer); resolve(message) })
    child.stdin.write(`${JSON.stringify({ id, type, payload })}\n`)
  })
  const close = () => { try { child.kill() } catch { /* ignore */ } }
  return { req, close }
}

/** 整个测试文件共用一个 sidecar 进程。
 *  每个用例单独 spawn 会让整轮测试花 2 分钟以上（每次 init 要加载 SDK 与扩展），
 *  不利于日常回归；用例之间只用不同的 sessionId 隔离即可。 */
let shared = null
async function getSidecar() {
  if (!shared) {
    shared = startSidecar()
    const init = await shared.req('init', { cwd: projectRoot })
    assert.equal(init.ok, true, `init 失败: ${init.error}`)
  }
  return shared
}

test.after(() => { shared?.close() })

/** 一次性完成：取共享 sidecar → 执行 body */
async function withSidecar(body) {
  const { req } = await getSidecar()
  return body(req)
}

/** 打包产物沙箱：真实启动 prepare:dev 的产物（行为验证，替代源码 grep）。
 *  审查发现源码 grep 断言可被"注释保留字面量/等价重构"绕过（6/11），
 *  而产物起不来/引用 .ts 会在这里直接爆出来。
 *
 *  ⚠️ 关键：**必须在隔离目录里跑**（装机事故根因，2026-09-29）。
 *  旧版从 projectRoot 启动，Node 解析裸包名时会向上找到 `PI/node_modules`
 *  （提升依赖 typebox 就在那儿），于是 `import 'typebox'` 这类**装机必崩**的
 *  依赖被静默放过 —— 用户装到 D:\Pi\Pi-My 后 sidecar 启动即
 *  ERR_MODULE_NOT_FOUND，表现为"反复退出（3 次/60 秒内）"。
 *  现在把 sidecar 拷到 %TEMP% 下的模拟安装目录（其祖先链上没有 node_modules），
 *  并把 resources/node_modules 以 junction 挂进来 —— 与真实安装布局一致，
 *  任何缺失的裸包名都会在这里当场炸出来。 */
async function withPackagedSidecar(body) {
  const realResources = path.join(projectRoot, 'src-tauri', 'resources')
  const simRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-my-pkgsim-'))
  const simResources = path.join(simRoot, 'resources')
  fs.mkdirSync(simResources, { recursive: true })
  // sidecar 是纯文本（小），直接拷贝
  fs.cpSync(path.join(realResources, 'sidecar'), path.join(simResources, 'sidecar'), { recursive: true })
  // node_modules 体积大（含 SDK），用 junction 避免拷贝；Node 的解析语义与真实安装一致
  const realModules = path.join(realResources, 'node_modules')
  if (fs.existsSync(realModules)) {
    fs.symlinkSync(realModules, path.join(simResources, 'node_modules'), 'junction')
  }
  const entry = path.join(simResources, 'sidecar', 'index.mjs')
  if (!fs.existsSync(entry)) {
    fs.rmSync(simRoot, { recursive: true, force: true })
    throw new Error('打包产物缺失：请先运行 npm run prepare:dev')
  }
  const child = spawn(process.execPath, [entry], {
    cwd: simRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PI_TRUST_ALL: '1' },
  })
  let buffer = ''
  const pending = new Map()
  // 捕获启动期 stderr：模块解析失败会在这里出现，比"请求超时"更早、更可诊断
  let stderrText = ''
  child.stderr.on('data', (chunk) => { stderrText += chunk.toString().slice(0, 4000) })
  child.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      for (const [, resolve] of pending) resolve({ ok: false, error: `sidecar 提前退出(${code}) ${stderrText.slice(0, 400)}` })
      pending.clear()
    }
  })
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      if (message.type === 'response' && pending.has(message.id)) {
        pending.get(message.id)(message)
        pending.delete(message.id)
      }
    }
  })
  let sequence = 0
  const req = (type, payload) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => {
      pending.delete(id)
      // 把 stderr 带进错误信息：缺包/语法错误时用户能看到真正原因
      reject(new Error(`打包产物请求超时: ${type}${stderrText ? ` | stderr: ${stderrText.slice(0, 400)}` : ''}`))
    }, process.env.CI ? 120_000 : 45_000)
    pending.set(id, (message) => { clearTimeout(timer); resolve(message) })
    child.stdin.write(`${JSON.stringify({ id, type, payload })}\n`)
  })
  try {
    const init = await req('init', { cwd: simRoot })
    assert.equal(init.ok, true, `打包产物 sidecar init 失败: ${init.error}`)
    return await body(req)
  } finally {
    try { child.kill() } catch { /* ignore */ }
    try { fs.rmSync(simRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

const toolsOf = (response) => (response.result && response.result.tools) || []

test('sidecar 集成：ask 模式创建后能看到写工具', async () => {
  await withSidecar(async (req) => {
    await req('create_session', { sessionId: 's1', cwd: projectRoot, mode: 'ask' })
    const ask = await req('set_mode', { sessionId: 's1', mode: 'ask' })
    assert.ok(toolsOf(ask).includes('bash'), 'ask 应有 bash')
  })
})

test('sidecar 集成 P0-2：plan → ask 必须恢复写工具（回归保护）', async () => {
  await withSidecar(async (req) => {
    await req('create_session', { sessionId: 's2', cwd: projectRoot, mode: 'ask' })
    const plan = await req('set_mode', { sessionId: 's2', mode: 'plan' })
    for (const dangerous of ['bash', 'edit', 'write']) {
      assert.equal(toolsOf(plan).includes(dangerous), false, `plan 不该有 ${dangerous}`)
    }
    assert.ok(toolsOf(plan).includes('read'), 'plan 应保留只读工具')

    const back = await req('set_mode', { sessionId: 's2', mode: 'ask' })
    assert.ok(toolsOf(back).includes('bash'), 'plan 之后切回 ask 必须恢复 bash（P0-2 核心）')
  })
})

test('sidecar 集成：在 plan 模式创建会话，切 ask 仍能恢复写工具', async () => {
  await withSidecar(async (req) => {
    // 这是"注册表被创建时裁剪"才会暴露的场景
    await req('create_session', { sessionId: 's3', cwd: projectRoot, mode: 'plan' })
    const ask = await req('set_mode', { sessionId: 's3', mode: 'ask' })
    assert.ok(toolsOf(ask).includes('bash'), 'plan 中创建的会话切 ask 必须能拿回 bash')
    assert.ok(toolsOf(ask).includes('grep'), 'plan 中创建的会话也要能有 grep')
  })
})

test('sidecar 集成：会话不存在时 set_mode 返回错误而非伪成功', async () => {
  await withSidecar(async (req) => {
    const response = await req('set_mode', { sessionId: '不存在的会话', mode: 'ask' })
    assert.equal(response.ok, false, '对不存在的会话必须报错，否则前端以为切换生效了')
    assert.match(String(response.error), /会话不存在/)
  })
})

// ── 缺陷 4（外部审计 P1）：prompt 不得静默重建已关闭的会话 ────────────────
// 前端 closeTab/deleteSession 会先发 close_session，若此时还有异步前奏在飞行，
// 随后发出的 prompt 会命中 sidecar —— 旧实现里 `if (!entry) await createSession(...)`
// 会把会话重新造出来并真跑模型，而前端早已删掉标签与运行槽：
// 用户看不到、也停不掉这个运行。正确语义是报错，让前端 .catch 给出反馈。
test('sidecar 集成：已关闭会话收到 prompt 必须报错，且不得被静默重建（缺陷 4）', async () => {
  await withSidecar(async (req) => {
    const created = await req('create_session', { sessionId: 's-prompt-gone', cwd: projectRoot, mode: 'ask' })
    assert.equal(created.ok, true, `create_session 失败: ${created.error}`)
    const closed = await req('close_session', { sessionId: 's-prompt-gone' })
    assert.equal(closed.ok, true, `close_session 失败: ${closed.error}`)

    const prompted = await req('prompt', { sessionId: 's-prompt-gone', text: '你好', behavior: 'followUp' })
    assert.equal(
      prompted.ok,
      false,
      '对已关闭会话的 prompt 必须失败：静默重建会在前端已删除标签的情况下真跑模型，造出无人可管的僵尸运行',
    )
    assert.match(
      String(prompted.error),
      /不存在|已关闭/,
      `错误信息必须说明会话不可用，实际是：${prompted.error}`,
    )

    // 关键反证：报错之后该会话**仍然**不存在（不能"先报错再偷偷建好"）。
    const still = await req('set_mode', { sessionId: 's-prompt-gone', mode: 'ask' })
    assert.equal(still.ok, false, 'prompt 失败后会话被静默重建了：set_mode 竟然成功')
    assert.match(String(still.error), /会话不存在/)
  })
})

test('sidecar 集成：open_session 回传 mode（防止 UI 与 sidecar 失同步）', async () => {
  await withSidecar(async (req) => {
    const created = await req('create_session', { sessionId: 's4', cwd: projectRoot, mode: 'ask' })
    const file = created.result && created.result.file
    assert.ok(file, 'create_session 应返回文件路径')

    await req('close_session', { sessionId: 's4' })
    // 传 plan 打开，回传值必须是 plan（旧实现硬编码 DEFAULT_MODE 且不回传）
    const opened = await req('open_session', { sessionId: 's5', file, mode: 'plan' })
    assert.equal(opened.ok, true, `open_session 失败: ${opened.error}`)
    assert.equal(opened.result && opened.result.mode, 'plan', 'open_session 必须回传并沿用请求的 mode')

    // 且该模式真的生效：plan 下不应有写工具
    const plan = await req('set_mode', { sessionId: 's5', mode: 'plan' })
    assert.equal(toolsOf(plan).includes('bash'), false)
  })
})

test('sidecar 集成：open_session 不传 mode 时退回默认（向前兼容）', async () => {
  await withSidecar(async (req) => {
    const created = await req('create_session', { sessionId: 's6', cwd: projectRoot, mode: 'full' })
    const file = created.result && created.result.file
    await req('close_session', { sessionId: 's6' })
    const opened = await req('open_session', { sessionId: 's7', file })
    assert.equal(opened.ok, true)
    // 未指定时必须给出一个合法模式，而不是 undefined
    assert.ok(['plan', 'ask', 'full'].includes(opened.result && opened.result.mode))
  })
})

// ---------------------------------------------------------------------------
// 打包产物行为验证（替代此前可被绕过的源码 grep 断言，审查 P2-4）
// ---------------------------------------------------------------------------

test('打包产物：sidecar 可启动，模式切换与 show_image 注册正常', async () => {
  // 若 .ts 说明符未被重写 / 模块漏编译，这里的 init 会直接 ERR_MODULE_NOT_FOUND
  await withPackagedSidecar(async (req) => {
    const created = await req('create_session', { sessionId: 'pkg', cwd: projectRoot, mode: 'ask' })
    assert.equal(created.ok, true, `create_session 失败: ${created.error}`)
    // 模式切换（P0-2 回归，在产物上验证）
    const plan = await req('set_mode', { sessionId: 'pkg', mode: 'plan' })
    assert.equal(plan.ok, true)
    assert.ok((plan.result?.tools ?? []).includes('read'))
    assert.equal((plan.result?.tools ?? []).includes('bash'), false)
    const ask = await req('set_mode', { sessionId: 'pkg', mode: 'ask' })
    assert.ok((ask.result?.tools ?? []).includes('bash'), '产物上 plan -> ask 也要恢复 bash')
  })
})

test('打包产物：get_state 快照可用（1-8/U4 数据层）', async () => {
  await withPackagedSidecar(async (req) => {
    await req('create_session', { sessionId: 'pkg2', cwd: projectRoot, mode: 'ask' })
    const state = await req('get_state', { sessionId: 'pkg2' })
    assert.equal(state.ok, true, `get_state 失败: ${state.error}`)
    const result = state.result || {}
    assert.equal(result.mode, 'ask')
    assert.ok(result.stats, '缺少 stats（U4 面板数据）')
    assert.ok(Array.isArray(result.tools), '缺少 tools')
  })
})
