// P0-B/P0-F 请求等待策略单测
//
// 重点不是"函数返回了某个数"，而是**策略表与 sidecar 的真实请求类型保持一致**：
// 一旦有人加了新的长耗时请求却忘了登记，就会拿到 30 秒默认超时而误伤功能。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { DEFAULT_TIMEOUT_MS, TIMEOUT_BY_TYPE, requestTimeoutMs, timeoutMessage, partitionPendingOnRestart } from '../src/rpc-policy.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const sidecarSource = readFileSync(path.join(here, '..', 'sidecar', 'index.mjs'), 'utf8')
const protocolSource = readFileSync(path.join(here, '..', 'src', 'protocol.ts'), 'utf8')

/** 从 sidecar 的 handle() 里提取所有请求类型分支。
 *
 * 容错要点（都是审查中实测出的漏洞）：
 * - 允许数字与连字符（`fetch_models_v2`），旧正则 `[a-z_]+` 会**静默漏掉**它，
 *   而那正是本测试想防的场景（漏登记 → 拿到 30 秒默认超时而误伤功能）。
 * - 同时接受单/双引号、`if` / `else if` / `switch case`，避免重构后解析归零
 *   并报出误导性的错误信息。
 * - 不匹配 `event.type === '...'`（事件字段），故要求 `type` 前是 `(` 或空白，
 *   且该行以 if/else 或 case 开头。
 */
function sidecarRequestTypes() {
  const types = new Set()
  const patterns = [
    // if (type === 'x') / else if (type === "x")
    /^\s*(?:else\s+)?if\s*\(\s*type\s*===\s*['"]([\w-]+)['"]/gm,
    // switch (type) { case 'x': }
    /^\s*case\s+['"]([\w-]+)['"]\s*:/gm,
  ]
  for (const pattern of patterns) {
    for (const match of sidecarSource.matchAll(pattern)) types.add(match[1])
  }
  return types
}

test('策略表覆盖 sidecar 的全部请求类型（漏登记会退回 30 秒默认超时而误伤）', () => {
  const declared = sidecarRequestTypes()
  assert.ok(declared.size > 40, `解析到的请求类型只有 ${declared.size} 个，解析逻辑可能失效`)

  const missing = [...declared].filter((type) => !Object.prototype.hasOwnProperty.call(TIMEOUT_BY_TYPE, type))
  assert.deepEqual(missing, [], `以下请求类型未登记超时策略：${missing.join(', ')}`)
})

test('策略表不含 sidecar 不认识的类型（防止拼写错误长期潜伏）', () => {
  const declared = sidecarRequestTypes()
  // 少数前端侧仅用于兼容/内部的键，允许存在
  const allowedExtra = new Set(['read_attachment_response'])
  const unknown = Object.keys(TIMEOUT_BY_TYPE).filter((type) => !declared.has(type) && !allowedExtra.has(type))
  assert.deepEqual(unknown, [], `策略表里有 sidecar 不认识的类型：${unknown.join(', ')}`)
})

test('长耗时请求必须显式放宽（回归保护：默认 30 秒会打断这些功能）', () => {
  // 这些请求天然要等很久：人类去做 OAuth、npm 下载、外部推理 API
  const mustBeGenerous = ['oauth_login', 'update_pi_sdk', 'generate_image', 'vision_describe', 'eco_install_package']
  for (const type of mustBeGenerous) {
    const timeout = requestTimeoutMs(type)
    assert.ok(
      timeout > DEFAULT_TIMEOUT_MS,
      `${type} 的超时是 ${timeout}ms，未超过默认值 ${DEFAULT_TIMEOUT_MS}ms —— 会打断正常功能`,
    )
  }
})

test('oauth_login 给足人类操作时间（15 分钟），但仍有限', () => {
  const timeout = requestTimeoutMs('oauth_login')
  assert.ok(timeout >= 300_000, `oauth_login 只给了 ${timeout}ms，不够用户完成浏览器授权`)
  assert.ok(Number.isFinite(timeout), 'oauth_login 不能是无限超时')
})

test('未知类型回落到保守默认值', () => {
  assert.equal(requestTimeoutMs('完全不存在的请求'), DEFAULT_TIMEOUT_MS)
})

test('普通交互请求不该被放宽（否则挂住时用户要等很久）', () => {
  // 这些是用户点一下就期望立刻有反馈的操作，不该给到分钟级
  for (const type of ['info', 'session_stats', 'set_mode', 'set_model', 'abort', 'confirm_response']) {
    assert.ok(requestTimeoutMs(type) <= DEFAULT_TIMEOUT_MS, `${type} 的超时偏大（${requestTimeoutMs(type)}ms）`)
  }
})

test('任何请求都不会永久挂住（P0-F 的核心不变量）', () => {
  // 即便等人类操作的 oauth_login 也必须有限——否则又回到"永远转圈"的老问题
  for (const [type, timeout] of Object.entries(TIMEOUT_BY_TYPE)) {
    assert.ok(Number.isFinite(timeout), `${type} 的超时是无限，会让界面永久挂起`)
    assert.ok(timeout > 0, `${type} 的超时非正数`)
    assert.ok(timeout <= 900_000, `${type} 的超时 ${timeout}ms 超过 15 分钟上限`)
  }
})

test('所有登记的超时都是正数且有限或 Infinity', () => {
  for (const [type, timeout] of Object.entries(TIMEOUT_BY_TYPE)) {
    assert.ok(typeof timeout === 'number', `${type} 超时不是数字`)
    assert.ok(timeout > 0, `${type} 超时非正数`)
    assert.ok(Number.isFinite(timeout) || timeout === Number.POSITIVE_INFINITY, `${type} 超时非法`)
  }
})

test('超时提示包含请求类型与秒数（便于用户自助定位）', () => {
  const message = timeoutMessage('git_push', 120_000)
  assert.match(message, /git_push/)
  assert.match(message, /120 秒/)
})

test('sidecar 主动推送的事件类型都必须在 protocol.ts 里声明（防类型收窄漏项）', () => {
  // 0-2 引入 typecheck 后这一条由 svelte-check 兜底；这里再做一次交叉校验，
  // 因为新增推送类型时最容易漏的就是前端的判别联合。
  const pushed = new Set([...sidecarSource.matchAll(/send\(\{\s*type:\s*'([a-z_]+)'/g)].map((m) => m[1]))
  assert.ok(pushed.size >= 8, `只解析到 ${pushed.size} 个推送类型，解析逻辑可能失效`)
  const missing = [...pushed].filter((type) => !protocolSource.includes(`type: '${type}'`))
  assert.deepEqual(missing, [], `以下事件类型未在 src/protocol.ts 声明: ${missing.join(', ')}`)
})

test('策略表是只读快照（防止运行期被意外改写）', () => {
  // Object.freeze 未加时这条会失败，提醒维护者保持契约稳定
  assert.ok(Object.isFrozen(TIMEOUT_BY_TYPE), 'TIMEOUT_BY_TYPE 应被冻结')
})

// ---------------------------------------------------------------------------
// 重启时的 pending 归属（这里踩过一个真 bug，见 partitionPendingOnRestart 注释）
// ---------------------------------------------------------------------------

test('重启时保留 Rust 侧重试的那个请求（否则它会永远没回音）', () => {
  const { aborted, kept } = partitionPendingOnRestart([7, 8, 9], 8)
  assert.deepEqual(kept, [8], '触发重启的请求必须保留，Rust 已用新进程重发它')
  assert.deepEqual(aborted, [7, 9])
})

test('重启时中止所有其它未完成请求（它们的响应永远不会到了）', () => {
  const { aborted } = partitionPendingOnRestart([1, 2, 3, 4])
  assert.deepEqual(aborted, [1, 2, 3, 4])
})

test('无 keepId 时不做保留', () => {
  const { aborted, kept } = partitionPendingOnRestart([5], undefined)
  assert.deepEqual(aborted, [5])
  assert.deepEqual(kept, [])
})

test('keepId 不在 pending 里时不会凭空造出一个', () => {
  const { aborted, kept } = partitionPendingOnRestart([1, 2], 99)
  assert.deepEqual(aborted, [1, 2])
  assert.deepEqual(kept, [], 'keepId 不在 pending 中就不该被保留')
})

test('分区覆盖全部输入且不重复（不变量）', () => {
  const ids = [11, 22, 33]
  const { aborted, kept } = partitionPendingOnRestart(ids, 22)
  assert.deepEqual([...aborted, ...kept].sort((a, b) => a - b), [...ids].sort((a, b) => a - b))
})
