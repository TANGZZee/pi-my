// T3-2: 虚拟模型（有序故障转移链）——纯路由函数，无 IO，可独立单测。
//
// 产品语义（用户可视化）：用户把若干已配置模型排成一条链。
// - user 请求 → 走链首；
// - retry（模型失败/压缩后 overflow 自动重试）→ 滑到链中下一个；
// - continuation → 保持当前模型不变；
// - direct（循环外请求，如压缩摘要）→ 忽略 state，始终用链首；
// - 已在链尾仍失败 → 停在链尾（SDK resolveModel 的模型级重试语义处理）。
// state = { i }（JSON 可序列化，SDK 以 VirtualModelStateData 持久化为分支条目）。
//
// SDK 契约锚点（model-runtime.d.ts :126-141）：route 返回 {model, thinkingLevel, state?}，
// model 必须是「有凭据 provider 的物理目录模型」，thinkingLevel 由 SDK 钳制；
// registerVirtualModel 撞物理 id 抛错——所以虚拟 id 必须加前缀隔离。

/** 虚拟模型 id 前缀：与物理 id 隔离（registerVirtualModel 撞物理 id 会抛错）。 */
export const VIRTUAL_PREFIX = 'failover:'

/** 把索引钳进链内（越界/负值/链空都安全回落）。 */
export function clampChainIndex(index, length) {
  if (!Number.isInteger(length) || length <= 0) return 0
  if (!Number.isInteger(index) || index < 0) return 0
  return Math.min(index, length - 1)
}

/** 单条链项校验（已解析形态：{provider, modelId, thinkingLevel?}）。 */
export function normalizeVirtualChain(raw) {
  if (raw === undefined || raw === null) return { ok: false, error: '缺少 chain' }
  if (!Array.isArray(raw)) return { ok: false, error: 'chain 必须是数组' }
  const seen = new Set()
  const chain = []
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false, error: `chain[${i}] 必须是对象` }
    const provider = typeof item.provider === 'string' ? item.provider.trim() : ''
    const modelId = typeof item.modelId === 'string' ? item.modelId.trim() : ''
    if (!provider || provider.length > 100) return { ok: false, error: `chain[${i}].provider 必须是 1-100 字符` }
    if (!modelId || modelId.length > 200) return { ok: false, error: `chain[${i}].modelId 必须是 1-200 字符` }
    const key = `${provider}\u0000${modelId}`
    if (seen.has(key)) return { ok: false, error: `chain[${i}] 与前面项重复: ${provider}/${modelId}` }
    seen.add(key)
    const entry = { provider, modelId }
    if (item.thinkingLevel !== undefined) {
      if (typeof item.thinkingLevel !== 'string' || !item.thinkingLevel.trim() || item.thinkingLevel.length > 40) {
        return { ok: false, error: `chain[${i}].thinkingLevel 必须是 1-40 字符字符串` }
      }
      entry.thinkingLevel = item.thinkingLevel.trim()
    }
    chain.push(entry)
  }
  if (!chain.length) return { ok: false, error: 'chain 不能为空（禁用请用 enabled:false 而非删空链）' }
  return { ok: true, chain }
}

/** 完整配置校验（set RPC 入口用）：{enabled, chain} —— enabled 任意非 true 值都视为 false。 */
export function normalizeVirtualModelConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: '配置必须是对象' }
  const chainResult = normalizeVirtualChain(raw.chain)
  if (!chainResult.ok) return chainResult
  return { ok: true, config: { enabled: raw.enabled === true, chain: chainResult.chain } }
}

/**
 * 从目录解析链（set RPC 时执行）：链项必须命中「已配置物理模型」，thinkingLevel
 * 必须在模型声明档位内（模型未声明档位则放行任意值，交由 SDK 钳制）。
 * 返回 resolved（逐项带目录元数据）与 issues（未命中明细），UI 逐项提示。
 */
export function resolveVirtualChain(chain, catalog) {
  const resolved = []
  const issues = []
  const items = Array.isArray(catalog) ? catalog : []
  for (let i = 0; i < chain.length; i++) {
    const { provider, modelId, thinkingLevel } = chain[i]
    const model = items.find((m) => m.provider === provider && m.id === modelId)
    if (!model) {
      issues.push({ index: i, provider, modelId, error: '模型不在已配置目录中' })
      continue
    }
    const levels = Array.isArray(model.thinkingLevels) ? model.thinkingLevels : []
    if (thinkingLevel && levels.length && !levels.includes(thinkingLevel)) {
      issues.push({ index: i, provider, modelId, thinkingLevel, error: 'thinkingLevel 不在该模型档位中' })
      continue
    }
    resolved.push({
      provider,
      id: modelId,
      ...(thinkingLevel ? { thinkingLevel } : {}),
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })
  }
  if (!resolved.length) return { ok: false, error: '链上没有任何可用模型（全部未命中目录）', issues }
  return { ok: true, resolved, issues }
}

/**
 * 纯路由状态机（SDK route 回调的决策核心；物理 Model 解析在 index.mjs 接线层）。
 * @param config   normalizeVirtualModelConfig 的产物 {enabled, chain}
 * @param request  SDK ModelRouteRequest 的决策字段 {reason, state?}
 * @returns {{index: number, model: {provider, id}, thinkingLevel?: string, state: {i: number}}}
 */
export function routeChain(config, request = {}) {
  if (!config || config.enabled !== true || !Array.isArray(config.chain) || !config.chain.length) {
    throw new Error('虚拟模型链未启用或为空')
  }
  const reason = request.reason || 'user'
  const prevIndex = Number.isInteger(request.state?.i) ? request.state.i : 0
  let index
  if (reason === 'user') index = 0
  else if (reason === 'continuation') index = clampChainIndex(prevIndex, config.chain.length)
  else if (reason === 'retry') index = clampChainIndex(prevIndex + 1, config.chain.length)
  else index = 0 // direct / 未知 reason：循环外请求，始终链首
  const entry = config.chain[index]
  return {
    index,
    model: { provider: entry.provider, id: entry.modelId },
    ...(entry.thinkingLevel !== undefined ? { thinkingLevel: entry.thinkingLevel } : {}),
    state: { i: index },
  }
}
