// Pi-My agent 客户端（供 Hermes 等外部 agent 复用；1-6 之后的接口扩展）
//
// 与 PI/docs/agent-protocol.md 第六节一一对应。
// 设计：薄封装——协议处理（id 关联/事件分发/超时）在这里，业务语义不掺。
// （纯 .mjs：客户端要被任意 Node 进程直接 import，不引入 TS 编译依赖；
//   类型契约用 JSDoc 表达，TS 消费者可获得完整提示。）
import { spawn } from 'node:child_process'

/**
 * @typedef {Object} PiMyEvent
 * @property {string} type
 * @property {string} [sessionId]
 * @property {{ type?: string, [key: string]: unknown }} [event]
 */

/**
 * @typedef {Object} PiMyClient
 * @property {(type: string, payload?: Record<string, unknown>) => Promise<unknown>} request
 * @property {(fn: (message: PiMyEvent) => void) => () => void} onMessage
 * @property {() => void} close
 * @property {() => Promise<unknown>} init
 * @property {(sessionId: string, mode?: 'plan' | 'ask' | 'full') => Promise<unknown>} createSession
 * @property {(sessionId: string, text: string) => Promise<unknown>} send
 * @property {(sessionId: string, text: string) => Promise<unknown>} steer
 * @property {(sessionId: string) => Promise<unknown>} stop
 * @property {(sessionId: string) => Promise<unknown>} state
 * @property {(confirmId: string, ok: boolean) => Promise<unknown>} answerConfirm
 */

/**
 * 连接一个 Pi-My sidecar 进程。
 * @param {{ sidecarPath: string, cwd: string, requestTimeoutMs?: number, env?: Record<string, string> }} options
 * @returns {PiMyClient}
 */
export function connectPiMy(options) {
  const { sidecarPath, cwd, requestTimeoutMs = 120_000, env } = options
  const child = spawn(process.execPath, [sidecarPath], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  })
  let buf = ''
  const pending = new Map()
  const listeners = []
  let seq = 0
  let closed = false

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
      } else {
        for (const fn of listeners) {
          try { fn(message) } catch { /* 单个订阅者错误不影响其他 */ }
        }
      }
    }
  })
  child.stderr.on('data', () => { /* sidecar 日志走 stderr，客户端默认不关心 */ })

  const request = (type, payload = {}) => {
    if (closed) return Promise.reject(new Error('客户端已关闭'))
    const id = ++seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`请求超时: ${type}`))
      }, requestTimeoutMs)
      pending.set(id, (message) => {
        clearTimeout(timer)
        if (message.ok) resolve(message.result)
        else reject(new Error(String(message.error || '请求失败')))
      })
      child.stdin.write(JSON.stringify({ id, type, payload }) + '\n')
    })
  }

  return {
    request,
    onMessage: (fn) => {
      listeners.push(fn)
      return () => {
        const i = listeners.indexOf(fn)
        if (i >= 0) listeners.splice(i, 1)
      }
    },
    close: () => {
      closed = true
      try { child.kill() } catch { /* ignore */ }
    },
    init: () => request('init', { cwd }),
    createSession: (sessionId, mode = 'ask') => request('create_session', { sessionId, cwd, mode }),
    send: (sessionId, text) => request('prompt', { sessionId, text, behavior: 'followUp' }),
    steer: (sessionId, text) => request('prompt', { sessionId, text, behavior: 'steer' }),
    stop: (sessionId) => request('abort', { sessionId }),
    state: (sessionId) => request('get_state', { sessionId }),
    answerConfirm: (confirmId, ok) => request('confirm_response', { confirmId, ok }),
  }
}
