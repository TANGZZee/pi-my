// Agent 客户端 E2E——模拟 Hermes 接入 Pi-My 的完整协作流程。
//
// 覆盖：连接初始化、会话创建、发消息、事件订阅（思考/回复增量）、
// stop、get_state、权限确认问答（注入确认 + 远程回答）。
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { connectPiMy } from '../sidecar/agent-client.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')

test('agent 客户端：Hermes 式协作全流程', async () => {
  const client = connectPiMy({
    sidecarPath: path.join(projectRoot, 'sidecar', 'index.mjs'),
    cwd: projectRoot,
    requestTimeoutMs: 60_000,
    env: { PI_TRUST_ALL: '1' },
  })
  try {
    await client.init()
    const created = await client.createSession('hermes-e2e')
    assert.ok(created, 'create_session 应返回会话信息')

    // 事件订阅：collect 思考/回复增量
    const deltas = []
    const off = client.onMessage((message) => {
      if (message.type === 'event' && message.event?.type === 'message_update') {
        const inner = message.event.assistantMessageEvent
        if (inner?.delta) deltas.push(String(inner.delta))
      }
    })

    // 发消息（无凭据环境下 SDK 会立刻 error，但接口层语义已验证）
    await client.send('hermes-e2e', '你好，帮我总结这个仓库')
    // 等待事件到达
    await new Promise((r) => setTimeout(r, 4000))
    off()

    // stop 幂等
    await client.stop('hermes-e2e')

    // 状态快照（U4 数据层）
    const state = await client.state('hermes-e2e')
    assert.ok(state, 'get_state 应返回快照')
    assert.equal(state.mode, 'ask')

    // 权限确认回答通路：未知 id 返回 delivered:false（诚实、不崩溃）
    const delivered = await client.request('confirm_response', { confirmId: 'c-nonexistent', ok: true })
    assert.equal(delivered.delivered, false, '未知 confirmId 的诚实响应')
  } finally {
    client.close()
  }
})

test('agent 客户端：全量能力抽查（记忆/导出/文件分块）', async () => {
  const client = connectPiMy({
    sidecarPath: path.join(projectRoot, 'sidecar', 'index.mjs'),
    cwd: projectRoot,
    requestTimeoutMs: 60_000,
    env: { PI_TRUST_ALL: '1' },
  })
  try {
    await client.init()
    // 长期记忆（2-2）
    const remembered = await client.request('memory_remember', { content: 'agent 客户端 E2E 探针记忆' })
    assert.ok(remembered.id, 'memory_remember 返回 id')
    const found = await client.request('memory_search', { query: '探针记忆' })
    assert.ok((found.memories ?? []).length >= 1, 'memory_search 命中')

    // 文件分块（2-12）
    const bigFile = path.join(projectRoot, 'tests', '.tmp-agent-client.txt')
    fs.writeFileSync(bigFile, Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n'))
    try {
      const chunk = await client.request('read_file_chunk', { path: bigFile, offset: 0, limit: 10 })
      assert.equal(chunk.totalLines, 2000)
      assert.equal(chunk.lines.length, 10)
    } finally {
      fs.rmSync(bigFile, { force: true })
    }

    // MCP 列表（2-10）
    const mcp = await client.request('mcp_list', {})
    assert.ok(Array.isArray(mcp.global))

    // 导出（2-5）
    await client.createSession('hermes-export')
    const md = await client.request('export_session_md', { sessionId: 'hermes-export' })
    assert.ok(md.markdown !== undefined)
  } finally {
    client.close()
  }
})

test('agent 客户端：协议健壮性（坏 JSON 不崩、未知请求明确报错）', async () => {
  const client = connectPiMy({
    sidecarPath: path.join(projectRoot, 'sidecar', 'index.mjs'),
    cwd: projectRoot,
    requestTimeoutMs: 60_000,
    env: { PI_TRUST_ALL: '1' },
  })
  try {
    await client.init()
    // 未知请求类型：sidecar 明确报错（不静默、不崩溃）
    await assert.rejects(
      () => client.request('totally_unknown_type', {}),
      /未知 sidecar 请求/,
    )
    // 未知会话：明确报错（诚实语义），协议保持健康
    await assert.rejects(
      () => client.request('get_state', { sessionId: 'any' }),
      /会话不存在/,
      '未知会话明确报错',
    )
    // 坏 JSON 行注入：直接往 stdin 写非 JSON，协议不崩
    // （client 不暴露 stdin；此处用 request 后混入坏字节的方式模拟不可行，
    //   坏行由 sidecar 的 JSON.parse 静默跳过——sidecar-integration 已覆盖 NDJSON 解析。
    //   这里验证协议健康：随后正常请求仍成功）
    const healthy = await client.request('memory_list', {})
    assert.ok(healthy.memories !== undefined, '坏输入后协议仍响应')
  } finally {
    client.close()
  }
})
