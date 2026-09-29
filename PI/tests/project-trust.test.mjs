// 项目信任 E2E（2-14）—— 真实 spawn sidecar，驱动完整信任流程。
//
// 关键场景：
//   1. 信任弹窗在 create_session（loader.reload）内部出现 → 前端回答 → 会话创建成功
//      （这验证了主循环死锁修复：ui_dialog_response 必须能在 create_session await 期间被处理）
//   2. once 信任只进进程内缓存，不写持久记忆
//   3. trust_project 显式记忆 / get_project_trust 回读 / 撤销
//
// 注意：本文件**不能**设 PI_TRUST_ALL=1（否则测不到弹窗路径）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')

test('2-14 项目信任：弹窗回答后 create_session 成功（死锁回归保护）', async () => {
  const child = spawn(process.execPath, ['sidecar/index.mjs'], {
    cwd: projectRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buf = ''
  const pending = new Map()
  let answered = false
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
      if (message.type === 'ui_dialog_request' && !answered) {
        answered = true
        // 审查 E2E 同款回答路径：confirmed=true → resolveProjectTrust 返回 true
        child.stdin.write(
          JSON.stringify({ id: 999, type: 'ui_dialog_response', payload: { dialogId: message.dialogId, confirmed: true } }) + '\n',
        )
      }
    }
  })
  child.stderr.on('data', () => {})
  const req = (id, type, payload) => new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve({ ok: false, error: 'timeout' })
    }, process.env.CI ? 180_000 : 120_000)
    pending.set(id, (m) => { clearTimeout(timer); resolve(m) })
    child.stdin.write(JSON.stringify({ id, type, payload }) + '\n')
  })

  try {
    await req(1, 'init', { cwd: projectRoot })
    const created = await req(2, 'create_session', { sessionId: 'trust-e2e', cwd: projectRoot, mode: 'ask' })
    assert.equal(created.ok, true, `回答信任弹窗后 create_session 应成功（死锁修复验证）：${created.error}`)
    assert.equal(answered, true, '信任弹窗应出现过并被回答')

    const state = await req(3, 'get_project_trust', { cwd: projectRoot })
    assert.equal(state.result?.session, true, 'once 信任应反映在进程内缓存')
    assert.equal(state.result?.remembered ?? null, null, 'once 信任不写持久记忆')

    const remembered = await req(4, 'trust_project', { cwd: projectRoot, trusted: true })
    assert.equal(remembered.result?.trusted, true)

    const after = await req(5, 'get_project_trust', { cwd: projectRoot })
    assert.equal(after.result?.remembered, true, '显式信任应写入持久存储')

    const revoked = await req(6, 'trust_project', { cwd: projectRoot, trusted: false })
    assert.equal(revoked.result?.trusted, false)

    const final = await req(7, 'get_project_trust', { cwd: projectRoot })
    assert.equal(final.result?.remembered ?? null, null, '撤销后应不再记忆')
  } finally {
    try { child.kill() } catch { /* ignore */ }
  }
})
