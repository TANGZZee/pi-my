// provider 错误契约测试（真实 SDK + 真实 event-slim + 前端纯函数）
//
// 为什么必须有这条测试（真实事故，用户报障）：
//   模型提供商返回 404 时，SDK **不抛异常、也不发 `type:'error'` 事件**，而是产出一条
//   `stopReason:'error'` + `errorMessage` 的 assistant 终态消息，然后照常发 agent_end /
//   agent_settled。前端当时只读 `agent_end.willRetry`、只处理 `type:'error'`，错误文本被
//   整条丢弃 → 用户看到"没有任何反馈"，思考球永久旋转。
//
// 单元测试用**合成事件**无法证明真实链路（SDK 原始事件 → summarizeEvent 瘦身 → 前端取值）
// 里 errorMessage 不会中途被剥掉。本测试起一个本地 404 HTTP 服务，跑真 SDK，把每个真实
// 事件喂给真实的 summarizeEvent，再喂给 run-slot 的取值函数，断言最终用户可见文案。
//
// 注意：本文件同时是对 SDK 契约的**哨兵**。SDK 若改变失败表现（例如真的开始发
// type:'error'），这里会失败并提醒重新评估前端归约逻辑。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { summarizeEvent } from '../sidecar/event-slim.mjs'
import {
  assistantErrorFrom,
  isCancellationText,
  stashProviderError,
  takeProviderError,
} from '../src/run-slot.ts'

// 不联网拉模型目录，避免测试受网络影响（SDK 只认这个环境变量的存在性）。
process.env.PI_OFFLINE = '1'

// 仓库根用本文件位置推导，**不要用 process.cwd()**：CI 与本地可能从不同目录
// 启动 node --test，cwd 依赖会让 SDK 解析不到（其余测试文件同此约定）。
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SDK_ENTRY = pathToFileURL(
  path.join(repoRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'index.js')
).href

/** 起一个本地 HTTP 服务，按 handler 应答；返回 { port, close }。 */
async function startServer(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: server.address().port, close: () => server.close() }
}

/**
 * 用真 SDK 跑一次 prompt，返回经 event-slim 瘦身后的**真实事件序列**。
 * 每个用例独占临时 agentDir（models.json/auth.json/settings.json），互不干扰。
 */
async function runRealPrompt({ reply }) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-provider-e2e-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-provider-e2e-cwd-'))
  const sdk = await import(SDK_ENTRY)
  const server = await startServer(reply)

  try {
    const baseUrl = `http://127.0.0.1:${server.port}/v1`
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
      providers: {
        probe: {
          baseUrl,
          api: 'openai-completions',
          apiKey: 'probe-key',
          models: [{ id: 'probe-model', name: 'probe-model', input: ['text'] }],
        },
      },
    }))
    fs.writeFileSync(path.join(agentDir, 'auth.json'), JSON.stringify({
      probe: { type: 'api_key', key: 'probe-key' },
    }))
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({
      defaultProvider: 'probe', defaultModel: 'probe-model',
    }))

    const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, extensionFactories: [] })
    await loader.reload({ resolveProjectTrust: async () => true })
    // 注意：ModelRuntime.create 只认 authPath/modelsPath，**不认 agentDir**；
    // 传 agentDir 会被忽略并回退到真实 ~/.pi/agent（探针曾因此报
    // "No API key found for the selected model."）。createAgentSession 也不会从
    // 临时 agentDir 的 settings.json 解析默认模型，所以显式取模型再传入。
    const modelRuntime = await sdk.ModelRuntime.create({
      authPath: path.join(agentDir, 'auth.json'),
      modelsPath: path.join(agentDir, 'models.json'),
      refreshOnCreate: false,
    })
    const model = modelRuntime.getModel('probe', 'probe-model')
    assert.ok(model, 'models.json 未被 SDK 解析出探针模型')

    const { session } = await sdk.createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model,
      sessionManager: sdk.SessionManager.create(cwd, path.join(agentDir, 'sessions')),
      resourceLoader: loader,
    })

    const events = []
    session.subscribe((raw) => events.push(summarizeEvent(raw)))
    await session.prompt('你好')
    // 给收尾事件（agent_end/agent_settled）一点时间到位。
    await new Promise((resolve) => setTimeout(resolve, 1200))
    return events
  } finally {
    server.close()
    fs.rmSync(agentDir, { recursive: true, force: true })
    fs.rmSync(cwd, { recursive: true, force: true })
  }
}

/**
 * 复刻 App.svelte 的事件归约（staging + 终态消费），与组件里的分支一一对应。
 * 组件无法在 node 环境挂载，因此这里验证的是"SDK 事件契约 + 取值/暂存函数"，
 * 而不是 Svelte 模板本身。分支来源：App.svelte 的 providerErrors 相关逻辑。
 *   入队：message_end(assistant) / turn_end / agent_end.messages / auto_retry_end(finalError)
 *   消费：agent_end(willRetry=false) / agent_settled  →  中文归因
 *
 * 暂存/消费直接调用 run-slot.ts 里的**真实纯函数**（stashProviderError / takeProviderError），
 * 不再手写一份 staged 变量。此前是手工复刻的 `staged = raw ? raw : staged === '' ? '' : staged`
 * （空 raw 保留旧值），与真实 setProviderError 的"空串清除"语义不同 —— 复刻与真实实现会各自
 * 漂移，测过也不代表组件正确。现在接线与语义共用同一实现。
 */
function reduceLikeApp(events) {
  let stash = {}
  let seenErrorEvent = false
  let settled = false
  let settledText = ''
  let finishedWith = null

  for (const event of events) {
    if (event.type === 'error') { seenErrorEvent = true; continue }
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      stash = stashProviderError(stash, 's', assistantErrorFrom(event.message))
    }
    if (event.type === 'turn_end') {
      stash = stashProviderError(stash, 's', assistantErrorFrom(event.message))
    }
    if (event.type === 'auto_retry_end' && event.success === false) {
      const finalError = String(event.finalError ?? '')
      // 与组件一致：用户主动 Stop 的取消文案不是 provider 故障，必须过滤。
      if (!isCancellationText(finalError)) stash = stashProviderError(stash, 's', finalError)
    }
    if (event.type === 'agent_end') {
      stash = stashProviderError(stash, 's', assistantErrorFrom(event.messages))
      if (!event.willRetry) {
        const taken = takeProviderError(stash, 's')
        stash = taken.stash
        finishedWith = taken.message || ''
      }
    }
    if (event.type === 'agent_settled') {
      settled = true
      const taken = takeProviderError(stash, 's')
      stash = taken.stash
      settledText = taken.message || ''
    }
  }
  return { seenErrorEvent, settled, finishedWith, settledText }
}

test('provider 404：错误文本必须穿过 event-slim 到达前端并被归因（真实 SDK 复现）', async () => {
  const events = await runRealPrompt({
    reply: (_req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('404 page not found\n')
    },
  })

  // ① SDK 确实不发 type:'error' —— 这是本 bug 的根因，也是本测试存在的理由。
  //    若这条失败（SDK 开始发 error 事件），说明上游契约变了，需重新评估前端归约。
  assert.equal(
    events.some((event) => event.type === 'error'), false,
    'SDK 不再用 type:"error" 报告 provider 失败，前端归约逻辑需要重新评估'
  )

  // ② 终态信号必须到达（永久 Thinking 的解药）。
  assert.ok(events.some((event) => event.type === 'agent_settled'), 'agent_settled 未到达')

  // ③ assistant 错误字段必须完好穿过 event-slim（这是本修复的承重点）。
  const errored = events.filter((event) => event.message?.role === 'assistant' && event.message.stopReason === 'error')
  assert.ok(errored.length > 0, 'assistant 终态 stopReason=error 在瘦身后丢失')
  assert.match(String(errored[0].message.errorMessage), /404/, 'errorMessage 在瘦身后丢失或被改写')

  // ④ 归约出的用户可见文案必须非空且带归因。
  const reduced = reduceLikeApp(events)
  assert.equal(reduced.finishedWith, '接口地址不正确（baseUrl 或 API 路径有误）：404 404 page not found')
  // ⑤ agent_settled 是兜底：错误已在 agent_end 被消费，兜底不应重复报（否则文案闪烁）。
  assert.equal(reduced.settledText, '', 'agent_settled 重复报错')
  assert.equal(reduced.seenErrorEvent, false)
})

test('provider 正常回复：不得产生任何"请求失败"误报（真实 SDK 复现）', async () => {
  // SDK 走 **SSE 流式**（openai-completions）。若这里回一个普通 JSON body，SDK 会报
  // "Stream ended without finish_reason" —— 该文案命中其可重试正则（ended without），
  // 于是触发 3 次重试后才失败。必须发真正的 SSE 分片 + 终止的 finish_reason。
  const chunk = (delta, finishReason = null) => `data: ${JSON.stringify({
    id: 'chatcmpl-probe',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'probe-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`

  const events = await runRealPrompt({
    reply: (_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(chunk({ role: 'assistant', content: '' }))
      res.write(chunk({ content: '你好，我很好。' }))
      res.write(chunk({}, 'stop'))
      res.write('data: [DONE]\n\n')
      res.end()
    },
  })

  // 成功路径必须无错误：stopReason 非 error → assistantErrorFrom 返回空串。
  assert.equal(
    events.some((event) => event.message?.role === 'assistant' && event.message.stopReason === 'error'),
    false, '成功回复被误判为 provider 错误'
  )
  const reduced = reduceLikeApp(events)
  assert.equal(reduced.finishedWith, '', '正常回复被误报为"请求失败"')
  assert.equal(reduced.settledText, '', '正常回复在兜底路径被误报为"请求失败"')
  assert.ok(reduced.settled, 'agent_settled 未到达（成功路径也必须到达）')
})
