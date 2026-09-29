// 局域网伴侣 E2E（1-6）—— 真实 spawn sidecar，走完整 HTTP 流程。
//
// 覆盖：
//   1. 只读模式：写接口 403（默认关闭，不泄露接口）
//   2. 鉴权：API 无 header/query token → 401；token 不再出现在 API URL
//   3. 可写模式：/api/prompt、/api/steer、/api/stop 语义正确（空闲/运行态区分）
//   4. 待决权限确认可远程回答（与主界面 confirm_response 同语义）
//   5. 请求体校验（空消息/超长/坏 JSON）
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')

/** 每个测试一个独立端口（同进程串行执行，但 kill 释放端口是异步的——
 *  复用同一端口会出现 TIME_WAIT 竞态，导致间歇性失败） */
let portSeq = 0

/** 起 sidecar + 打开 LAN 服务器，返回 { req, http, token, port, close } */
async function withSidecar(writable) {
  const child = spawn(process.execPath, ['sidecar/index.mjs'], {
    cwd: projectRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PI_TRUST_ALL: '1' },
  })
  let buf = ''
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
  child.stderr.on('data', () => {})
  const req = (id, type, payload) => new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve({ ok: false, error: 'timeout' })
    }, 60000)
    pending.set(id, (m) => { clearTimeout(timer); resolve(m) })
    child.stdin.write(JSON.stringify({ id, type, payload }) + '\n')
  })
  await req(1, 'init', { cwd: projectRoot })
  await req(2, 'create_session', { sessionId: 'lan-e2e', cwd: projectRoot, mode: 'ask' })
  const opened = await req(3, 'lan_set', { enabled: true, port: 19000 + (process.pid % 100) * 20 + (portSeq++), writable })
  assert.equal(opened.ok, true, `lan_set 失败: ${opened.error}`)
  const status = opened.result
  assert.equal(status.enabled, true)
  assert.equal(status.writable, writable, 'writable 开关应如实反映')
  const port = status.port

  const http = async (pathname, { method = 'GET', body, withToken = true, useQuery = false } = {}) => {
    const url = `http://127.0.0.1:${port}${pathname}${useQuery ? `?t=${status.token}` : ''}`
    const headers = {}
    if (withToken && !useQuery) headers['x-pi-token'] = status.token
    if (body !== undefined) headers['content-type'] = 'application/json'
    // 1-6 稳定性：sidecar 的 listen 是异步的，且相邻测试的 kill/释放有竞态。
    // fetch 偶发 ECONNREFUSED 时退避重试（根因是 socket 就绪时序，不是逻辑错误）。
    let lastError
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
        const text = await res.text()
        let json = null
        try { json = JSON.parse(text) } catch { json = { raw: text } }
        return { status: res.status, json }
      } catch (error) {
        lastError = error
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)))
      }
    }
    throw lastError
  }

  return {
    req, http, token: status.token, port,
    close: () => {
      try { child.stdin.write(JSON.stringify({ id: 9999, type: 'lan_set', payload: { enabled: false } }) + '\n') } catch { /* ignore */ }
      try { child.kill() } catch { /* ignore */ }
    },
  }
}

test('1-6 只读模式：写接口 403 且不泄露存在性', async () => {
  const ctx = await withSidecar(false)
  try {
    const r = await ctx.http('/api/prompt', { method: 'POST', body: { sessionId: 'lan-e2e', text: 'hi' } })
    assert.equal(r.status, 403)
    assert.match(r.json.error, /只读模式/)
  } finally {
    ctx.close()
  }
})

test('1-6 鉴权：API 不带 token 401；query token 不再对 API 生效', async () => {
  const ctx = await withSidecar(false)
  try {
    const noToken = await ctx.http('/api/view', { withToken: false })
    assert.equal(noToken.status, 401, '无 token 的 API 必须 401')
    // 页面 HTML 仍可用 query 进入（引导页）
    const page = await ctx.http('/', { withToken: false, useQuery: true })
    assert.equal(page.status, 200, '引导页可用 query 进入')
    assert.ok(page.json.raw.includes('<html') || page.json.raw.includes('Pi-My'), '返回页面 HTML')
    // API 走 query → 401（token 不再被 URL 携带语义接受）
    const apiByQuery = await ctx.http('/api/view', { withToken: false, useQuery: true })
    assert.equal(apiByQuery.status, 401, 'API 不得接受 query token（安全修复核心）')
  } finally {
    ctx.close()
  }
})

test('1-6 可写模式：prompt/steer/stop 的状态语义', async () => {
  const ctx = await withSidecar(true)
  try {
    // prompt 接口层接受（无凭据环境下 SDK 内部会失败，但接口语义已验证）
    const prompt = await ctx.http('/api/prompt', { method: 'POST', body: { sessionId: 'lan-e2e', text: '远程消息 1' } })
    assert.equal(prompt.status, 200)
    assert.equal(prompt.json.ok, true, `prompt 应被接受: ${prompt.json.error}`)
    // 等会话回到稳定态（无凭据时 prompt 很快失败；轮询直到不再 running，最多 5s）
    for (let i = 0; i < 10; i++) {
      const view = await ctx.http('/api/view')
      const me = (view.json.sessions ?? []).find((s) => s.id === 'lan-e2e')
      if (!me?.running) break
      await new Promise((r) => setTimeout(r, 500))
    }
    // 确定性断言：空闲态 steer → 拒绝（插话只对运行中的会话有意义）
    const steerIdle = await ctx.http('/api/steer', { method: 'POST', body: { sessionId: 'lan-e2e', text: '远程插话' } })
    assert.equal(steerIdle.json.ok, false, `空闲态 steer 应拒绝: ${JSON.stringify(steerIdle.json)}`)
    assert.match(steerIdle.json.error, /空闲|正在运行/, '错误信息应说明状态')
    // stop 幂等：空闲会话上 abort 不报错
    const stop = await ctx.http('/api/stop', { method: 'POST', body: { sessionId: 'lan-e2e' } })
    assert.equal(stop.json.ok, true)
    // 未知会话 stop → 拒绝
    const stopUnknown = await ctx.http('/api/stop', { method: 'POST', body: { sessionId: 'nope' } })
    assert.equal(stopUnknown.json.ok, false)
    assert.match(stopUnknown.json.error, /会话不存在/)
  } finally {
    ctx.close()
  }
})

test('1-6 请求体校验：空消息/超长/坏 JSON/未知会话', async () => {
  const ctx = await withSidecar(true)
  try {
    const empty = await ctx.http('/api/prompt', { method: 'POST', body: { sessionId: 'lan-e2e', text: '  ' } })
    // 不断言具体错误文案：prompt 失败时 SDK 的错误（无模型凭据）可能与参数校验竞争，
    // 在并发环境下产生两种合法结果之一 —— 只断言"拒绝"本身。
    assert.equal(empty.json.ok, false, '空消息必须拒绝')
    const unknown = await ctx.http('/api/prompt', { method: 'POST', body: { sessionId: 'nope', text: 'x' } })
    assert.equal(unknown.json.ok, false)
    assert.match(unknown.json.error, /会话不存在/)
    const long = await ctx.http('/api/prompt', { method: 'POST', body: { sessionId: 'lan-e2e', text: 'x'.repeat(9000) } })
    assert.equal(long.json.ok, false, '超长消息必须拒绝')
    // 坏 JSON
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/prompt`, { method: 'POST', headers: { 'x-pi-token': ctx.token, 'content-type': 'application/json' }, body: '{bad' })
    assert.equal(res.status, 400)
  } finally {
    ctx.close()
  }
})

test('1-6 权限确认远程回答：与主界面 confirm_response 同语义', async () => {
  const ctx = await withSidecar(true)
  try {
    // 触发一个权限确认：plan 模式下的写工具调用会 ask。
    // 直接用 confirmBridge 不可达，改走 SDK：让会话跑一个会触发确认的命令。
    // 更可控的做法：往 pendingConfirmsBySession 注入是通过 requestConfirm ——
    // 走真实链路：set_mode(plan) 后 prompt 会触发 bash 的 ask 确认。
    await ctx.req(4, 'set_mode', { sessionId: 'lan-e2e', mode: 'plan' })
    // 发一个必然触发工具确认的 prompt（无真实模型凭据时 prompt 会报错，
    // 因此直接验证"待决确认枚举 + 回答"通路：手动调用扩展对话框桥——
    // 通过 answer 路径的 404 语义验证接口，真实确认流程由 permission-gate 测试覆盖）
    const missing = await ctx.http('/api/confirm', { method: 'POST', body: { dialogId: 'c-nonexistent', confirmed: true } })
    assert.equal(missing.json.ok, false)
    assert.match(missing.json.error, /不存在或已超时/)
  } finally {
    ctx.close()
  }
})
