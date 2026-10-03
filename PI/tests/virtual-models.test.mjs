// T3-2 虚拟模型（有序故障转移链）—— 纯路由函数的行为承重测试
//
// 被测模块 PI/sidecar/virtual-models.mjs 无 IO、无 SDK 依赖，这里直接驱动全状态机：
// routeChain 的 reason 分派（user/direct/continuation/retry/未知）与 state={i} 演进，
// 以及 normalize/resolve 两层校验的逐项报错语义。这些语义是 set_virtual_models RPC
// 与 runtime route 回调的共同决策核心 —— 改这里必须先过这里。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  VIRTUAL_PREFIX,
  clampChainIndex,
  normalizeVirtualChain,
  normalizeVirtualModelConfig,
  resolveVirtualChain,
  routeChain,
} from '../sidecar/virtual-models.mjs'

/** [provider, modelId, thinkingLevel?] 元组 → 链项对象（省心 fixture）。 */
const chainOf = (entries) => entries.map((entry) => (
  entry.length >= 3 ? { provider: entry[0], modelId: entry[1], thinkingLevel: entry[2] } : { provider: entry[0], modelId: entry[1] }
))

const enabledChain = (entries) => ({ enabled: true, chain: chainOf(entries) })

test('VIRTUAL_PREFIX 固定为 failover:（与物理 id 隔离，registerVirtualModel 撞 id 会抛错）', () => {
  assert.equal(VIRTUAL_PREFIX, 'failover:')
})

test('clampChainIndex：负值/非整数回落 0，越界钳到链尾，空链安全', () => {
  assert.equal(clampChainIndex(0, 3), 0)
  assert.equal(clampChainIndex(2, 3), 2)
  assert.equal(clampChainIndex(-1, 3), 0)
  assert.equal(clampChainIndex(99, 3), 2)
  assert.equal(clampChainIndex(1.5, 3), 0)
  assert.equal(clampChainIndex(Number('x'), 3), 0)
  assert.equal(clampChainIndex(0, 0), 0)
  assert.equal(clampChainIndex(0, undefined), 0)
})

test('normalizeVirtualChain：合法链通过，provider/modelId 去空白', () => {
  const result = normalizeVirtualChain(chainOf([[' a ', ' m1 '], ['b', 'm2', ' high ']]))
  assert.deepEqual(result, {
    ok: true,
    chain: [
      { provider: 'a', modelId: 'm1' },
      { provider: 'b', modelId: 'm2', thinkingLevel: 'high' },
    ],
  })
})

test('normalizeVirtualChain：结构性错误逐项报错', () => {
  assert.equal(normalizeVirtualChain(undefined).error, '缺少 chain')
  assert.equal(normalizeVirtualChain(null).error, '缺少 chain')
  assert.equal(normalizeVirtualChain('nope').error, 'chain 必须是数组')
  assert.equal(normalizeVirtualChain(['x']).error, 'chain[0] 必须是对象')
  assert.equal(normalizeVirtualChain([42]).error, 'chain[0] 必须是对象')
  const nested = normalizeVirtualChain([[]])
  assert.equal(nested.error, 'chain[0] 必须是对象')
})

test('normalizeVirtualChain：字段校验（长度边界 + thinkingLevel 类型）', () => {
  assert.equal(normalizeVirtualChain([{ provider: '', modelId: 'm1' }]).error, 'chain[0].provider 必须是 1-100 字符')
  assert.equal(normalizeVirtualChain([{ provider: 'a'.repeat(101), modelId: 'm1' }]).error, 'chain[0].provider 必须是 1-100 字符')
  assert.equal(normalizeVirtualChain([{ provider: 'a', modelId: '' }]).error, 'chain[0].modelId 必须是 1-200 字符')
  assert.equal(normalizeVirtualChain([{ provider: 'a', modelId: 'm'.repeat(201) }]).error, 'chain[0].modelId 必须是 1-200 字符')
  assert.equal(normalizeVirtualChain([{ provider: 'a', modelId: 'm1', thinkingLevel: '' }]).error, 'chain[0].thinkingLevel 必须是 1-40 字符字符串')
  assert.equal(normalizeVirtualChain([{ provider: 'a', modelId: 'm1', thinkingLevel: 3 }]).error, 'chain[0].thinkingLevel 必须是 1-40 字符字符串')
  assert.equal(normalizeVirtualChain([{ provider: 'a', modelId: 'm1', thinkingLevel: 'x'.repeat(41) }]).error, 'chain[0].thinkingLevel 必须是 1-40 字符字符串')
  // 边界值放行：恰好 100/200/40 字符
  assert.equal(normalizeVirtualChain([{ provider: 'p'.repeat(100), modelId: 'm'.repeat(200), thinkingLevel: 't'.repeat(40) }]).ok, true)
})

test('normalizeVirtualChain：重复项（去空白后判定）与空链拒绝', () => {
  const dup = normalizeVirtualChain([{ provider: 'a', modelId: 'm1' }, { provider: 'a', modelId: 'm1' }])
  assert.ok(dup.error.includes('重复'), '重复项必须报错')
  assert.ok(dup.error.includes('a/m1'), '报错必须带上具体 provider/modelId')
  // 去空白后相同也算重复（否则校验产物与原始输入不一致）
  const dupTrimmed = normalizeVirtualChain([{ provider: ' a', modelId: 'm1' }, { provider: 'a', modelId: 'm1' }])
  assert.ok(dupTrimmed.error.includes('重复'), '去空白后相同的两项必须判重')
  assert.equal(normalizeVirtualChain([]).error, 'chain 不能为空（禁用请用 enabled:false 而非删空链）')
})

test('normalizeVirtualModelConfig：对象校验 + enabled 严格判定（非 true 一律 false）', () => {
  assert.equal(normalizeVirtualModelConfig(null).error, '配置必须是对象')
  assert.equal(normalizeVirtualModelConfig('x').error, '配置必须是对象')
  assert.equal(normalizeVirtualModelConfig([1]).error, '配置必须是对象')
  // 缺 chain 透传 chain 层的报错
  assert.equal(normalizeVirtualModelConfig({ enabled: true }).error, '缺少 chain')
  const off = normalizeVirtualModelConfig({ enabled: 'yes', chain: [{ provider: 'a', modelId: 'm1' }] })
  assert.deepEqual(off, { ok: true, config: { enabled: false, chain: [{ provider: 'a', modelId: 'm1' }] } })
  const on = normalizeVirtualModelConfig({ enabled: true, chain: [{ provider: ' a ', modelId: 'm1' }] })
  assert.deepEqual(on, { ok: true, config: { enabled: true, chain: [{ provider: 'a', modelId: 'm1' }] } })
})

test('resolveVirtualChain：目录命中透传元数据（contextWindow/maxTokens/thinkingLevel）', () => {
  const catalog = [
    { provider: 'a', id: 'm1', thinkingLevels: ['off', 'high'], contextWindow: 128000, maxTokens: 4096 },
    { provider: 'b', id: 'm2' },
  ]
  const hit = resolveVirtualChain(chainOf([['a', 'm1', 'high']]), catalog)
  assert.equal(hit.ok, true)
  assert.deepEqual(hit.issues, [])
  assert.deepEqual(hit.resolved, [
    { provider: 'a', id: 'm1', thinkingLevel: 'high', contextWindow: 128000, maxTokens: 4096 },
  ])
  // 模型未声明档位 → 任意 thinkingLevel 放行（交由 SDK 钳制）
  const loose = resolveVirtualChain(chainOf([['b', 'm2', 'mega']]), catalog)
  assert.equal(loose.ok, true)
  assert.equal(loose.issues.length, 0)
})

test('resolveVirtualChain：未命中目录逐项进 issues；全部未命中整体拒绝', () => {
  const catalog = [{ provider: 'a', id: 'm1', thinkingLevels: ['off', 'high'], contextWindow: 1, maxTokens: 2 }]
  const miss = resolveVirtualChain(chainOf([['x', 'nope']]), catalog)
  assert.equal(miss.ok, false)
  assert.equal(miss.error, '链上没有任何可用模型（全部未命中目录）')
  assert.deepEqual(miss.issues, [{ index: 0, provider: 'x', modelId: 'nope', error: '模型不在已配置目录中' }])
  // 档位不在模型声明内 → 逐项 issue（错误信息可读）
  const badLevel = resolveVirtualChain(chainOf([['a', 'm1', 'xhigh']]), catalog)
  assert.equal(badLevel.ok, false)
  assert.deepEqual(badLevel.issues, [{ index: 0, provider: 'a', modelId: 'm1', thinkingLevel: 'xhigh', error: 'thinkingLevel 不在该模型档位中' }])
  // 非数组目录视为空目录 → 全部未命中
  const empty = resolveVirtualChain(chainOf([['a', 'm1']]), undefined)
  assert.equal(empty.ok, false)
})

test('resolveVirtualChain：部分命中放行（issues 供 UI 逐项告警，不整体拒绝）', () => {
  const catalog = [{ provider: 'a', id: 'm1', thinkingLevels: ['off'], contextWindow: 1, maxTokens: 2 }]
  const partial = resolveVirtualChain(chainOf([['a', 'm1'], ['x', 'nope']]), catalog)
  assert.equal(partial.ok, true)
  assert.equal(partial.resolved.length, 1)
  assert.equal(partial.issues.length, 1)
  assert.deepEqual(partial.issues, [{ index: 1, provider: 'x', modelId: 'nope', error: '模型不在已配置目录中' }])
})

test('routeChain：未启用/空链直接抛错（调用方不得静默回落）', () => {
  assert.throws(() => routeChain({ enabled: false, chain: chainOf([['a', 'm1']]) }), /虚拟模型链未启用或为空/)
  assert.throws(() => routeChain({ enabled: true, chain: [] }), /虚拟模型链未启用或为空/)
  assert.throws(() => routeChain(undefined), /虚拟模型链未启用或为空/)
})

test('routeChain：user/direct/未知 reason 都走链首（direct 忽略 state）', () => {
  const config = enabledChain([['a', 'm1'], ['b', 'm2'], ['c', 'm3']])
  const user = routeChain(config, { reason: 'user', state: { i: 2 } })
  assert.deepEqual(user, { index: 0, model: { provider: 'a', id: 'm1' }, state: { i: 0 } })
  const direct = routeChain(config, { reason: 'direct', state: { i: 2 } })
  assert.equal(direct.index, 0)
  const unknown = routeChain(config, { reason: 'wat' })
  assert.equal(unknown.index, 0)
  // 缺省 request（无参/空对象）= user 语义
  assert.equal(routeChain(config).index, 0)
  assert.equal(routeChain(config, {}).index, 0)
})

test('routeChain：continuation 保持当前模型；state 异常回落 0 并钳制越界', () => {
  const config = enabledChain([['a', 'm1'], ['b', 'm2'], ['c', 'm3']])
  assert.equal(routeChain(config, { reason: 'continuation', state: { i: 1 } }).index, 1)
  assert.equal(routeChain(config, { reason: 'continuation', state: { i: 2 } }).index, 2)
  assert.equal(routeChain(config, { reason: 'continuation', state: { i: 99 } }).index, 2)
  assert.equal(routeChain(config, { reason: 'continuation', state: { i: -3 } }).index, 0)
  // state 缺失 / 非整数 i → 视为链首
  assert.equal(routeChain(config, { reason: 'continuation' }).index, 0)
  assert.equal(routeChain(config, { reason: 'continuation', state: { i: 'x' } }).index, 0)
})

test('routeChain：retry 滑向链上下一个；已在链尾则停留', () => {
  const config = enabledChain([['a', 'm1'], ['b', 'm2'], ['c', 'm3']])
  const slide = routeChain(config, { reason: 'retry', state: { i: 0 } })
  assert.deepEqual(slide, { index: 1, model: { provider: 'b', id: 'm2' }, state: { i: 1 } })
  assert.equal(routeChain(config, { reason: 'retry', state: { i: 1 } }).index, 2)
  const atEnd = routeChain(config, { reason: 'retry', state: { i: 2 } })
  assert.equal(atEnd.index, 2, '链尾失败不再外滑（SDK 模型级重试语义接管）')
  assert.equal(atEnd.model.id, 'm3')
  // 无 state（首个请求即失败重试）→ 从链首滑到第 2 项
  assert.equal(routeChain(config, { reason: 'retry' }).index, 1)
})

test('routeChain：链项声明的 thinkingLevel 透传给 SDK（钳制在 SDK 侧）', () => {
  const config = enabledChain([['a', 'm1', 'high'], ['b', 'm2']])
  const head = routeChain(config, { reason: 'user' })
  assert.equal(head.thinkingLevel, 'high')
  assert.equal(head.index, 0)
  // 未声明 thinkingLevel 的链项：结果不得携带该键（让 SDK 走会话默认档位）
  const second = routeChain(config, { reason: 'retry', state: { i: 0 } })
  assert.ok(!('thinkingLevel' in second), `未声明档位时不得携带 thinkingLevel 键: ${JSON.stringify(second)}`)
})
