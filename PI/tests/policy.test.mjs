// P0-2 权限模式工具集语义（纯函数单测）
//
// 回归背景：旧实现把硬编码的 DEFAULT_TOOLS（4 个）当作模式切换的基准，
// 导致从 plan 切回 ask/full 时把 MCP / 扩展注册的工具**永久抹掉**。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENT_MODES,
  BASE_TOOLS,
  CONFIRM_TOOLS,
  CORE_TOOLS,
  DEFAULT_MODE,
  PLAN_TOOLS,
  isAgentMode,
  needsAskConfirm,
  summarizeToolCall,
  toolsForModeSwitch,
} from '../sidecar/policy.ts'

/** 模拟一个装了不少工具、其中含 MCP 与扩展工具的会话 */
const FULL_REGISTRY = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'mcp__github__search', 'my_ext_tool']

test('ask/full 保留全部已注册工具（含 MCP 与扩展工具）', () => {
  for (const mode of ['ask', 'full']) {
    const tools = toolsForModeSwitch(mode, FULL_REGISTRY)
    assert.deepEqual(tools, FULL_REGISTRY, `${mode} 不该丢工具`)
    assert.ok(tools.includes('mcp__github__search'), `${mode} 丢了 MCP 工具`)
    assert.ok(tools.includes('my_ext_tool'), `${mode} 丢了扩展工具`)
  }
})

test('plan 只保留确实存在的只读工具', () => {
  const tools = toolsForModeSwitch('plan', FULL_REGISTRY)
  assert.deepEqual(tools, ['read', 'grep', 'find', 'ls'])
  // 危险工具一个都不能留
  for (const dangerous of ['bash', 'edit', 'write', 'mcp__github__search', 'my_ext_tool']) {
    assert.equal(tools.includes(dangerous), false, `plan 模式不该保留 ${dangerous}`)
  }
})

test('plan 不请求注册表里不存在的名字（旧实现靠字符串巧合）', () => {
  // 某个环境只注册了 read，没有 grep/find/ls
  const tools = toolsForModeSwitch('plan', ['read', 'bash'])
  assert.deepEqual(tools, ['read'])
})

test('plan → ask → plan 往返不丢工具（P0-2 的核心回归）', () => {
  const inPlan = toolsForModeSwitch('plan', FULL_REGISTRY)
  assert.ok(inPlan.length < FULL_REGISTRY.length)
  // 切回 ask：必须以"全部注册表"为基准才能恢复
  const backToAsk = toolsForModeSwitch('ask', FULL_REGISTRY)
  assert.deepEqual(backToAsk, FULL_REGISTRY, '切回 ask 必须恢复全部工具')
  // 再回 plan 仍然正确
  assert.deepEqual(toolsForModeSwitch('plan', FULL_REGISTRY), inPlan)
})

test('输入异常/空基准时退化到 BASE_TOOLS，而不是把工具集清空', () => {
  // 清空会让 agent 什么都不能做（比旧实现更糟），故必须退化到安全基准。
  assert.deepEqual(toolsForModeSwitch('ask', undefined), [...BASE_TOOLS])
  assert.deepEqual(toolsForModeSwitch('ask', null), [...BASE_TOOLS])
  assert.deepEqual(toolsForModeSwitch('ask', 'not-an-array'), [...BASE_TOOLS])
  assert.deepEqual(toolsForModeSwitch('full', []), [...BASE_TOOLS])
  // plan 在空基准下也退化到只读子集，而不是空
  assert.deepEqual(toolsForModeSwitch('plan', []), toolsForModeSwitch('plan', BASE_TOOLS))
})

test('不修改传入的数组（调用方可能复用）', () => {
  const input = [...FULL_REGISTRY]
  toolsForModeSwitch('ask', input)
  toolsForModeSwitch('plan', input)
  assert.deepEqual(input, FULL_REGISTRY, '入参被就地改写了')
})

test('BASE_TOOLS 是无重复并集，且不包含未确认的危险工具', () => {
  // BASE_TOOLS 是创建会话时注册的集合；它必须包含 CORE ∪ PLAN，否则双向切换会丢工具。
  for (const tool of CORE_TOOLS) assert.ok(BASE_TOOLS.includes(tool), `缺少核心工具 ${tool}`)
  for (const tool of PLAN_TOOLS) assert.ok(BASE_TOOLS.includes(tool), `缺少只读工具 ${tool}`)
  assert.equal(new Set(BASE_TOOLS).size, BASE_TOOLS.length, 'BASE_TOOLS 有重复项')
})

test('P0-2 回归：plan 之后切回 ask/full 必须能恢复非只读工具', () => {
  // 实测确认过的行为：full -> plan 只剩只读，plan -> ask 恢复 bash
  const known = [...BASE_TOOLS]
  const inPlan = toolsForModeSwitch('plan', known)
  assert.ok(inPlan.length > 0 && !inPlan.includes('bash'))
  const back = toolsForModeSwitch('ask', known)
  assert.ok(back.includes('bash'), 'plan 之后必须能恢复 bash，否则就是旧的丢工具缺陷')
  assert.deepEqual(back, known)
})

test('BASE_TOOLS 是核心集 ∪ 只读集（保证任何初始模式都能双向切换）', () => {
  for (const tool of CORE_TOOLS) assert.ok(BASE_TOOLS.includes(tool), `缺少核心工具 ${tool}`)
  for (const tool of PLAN_TOOLS) assert.ok(BASE_TOOLS.includes(tool), `缺少只读工具 ${tool}`)
  // 无重复
  assert.equal(new Set(BASE_TOOLS).size, BASE_TOOLS.length, 'BASE_TOOLS 有重复项')
})

test('回归：从 plan 中创建的会话，切 ask 也拿得回 bash（曾漏掉的漏洞）', () => {
  // 场景：会话在 plan 模式下创建时，注册表若被裁剪成 PLAN_TOOLS，
  // 切到 ask 时基准里就没有 bash —— 用户永远拿不回来。
  // 正确做法是创建时注册 BASE_TOOLS，故这里的基准必须是 BASE_TOOLS 而非 PLAN_TOOLS。
  const seed = [...BASE_TOOLS]
  const askTools = toolsForModeSwitch('ask', seed)
  assert.ok(askTools.includes('bash'), '从 plan 创建的会话切 ask 必须能拿回 bash')
  assert.ok(askTools.includes('edit') && askTools.includes('write'))
})

test('regression: ask 创建的会话切 plan 也能拿到只读工具', () => {
  // 反向：创建时若只注册 CORE_TOOLS，plan 就拿不到 grep/find/ls
  const seed = [...BASE_TOOLS]
  const planTools = toolsForModeSwitch('plan', seed)
  for (const tool of PLAN_TOOLS) assert.ok(planTools.includes(tool), `plan 缺少 ${tool}`)
})

test('plan 模式在空基准下退化为只读子集（不落到空工具集）', () => {
  // 历史边界：早期实现在空基准下会返回 []，让 agent 无工具可用。
  // 现改为退化到 BASE_TOOLS 后再过滤，保证只读工具始终可用。
  const planTools = toolsForModeSwitch('plan', [])
  assert.ok(planTools.length > 0, 'plan 不该清空工具')
  for (const tool of planTools) assert.ok(PLAN_TOOLS.includes(tool))
})

test('PLAN_TOOLS 只含只读工具（不得混入写/命令工具）', () => {
  for (const dangerous of ['bash', 'powershell', 'edit', 'write', 'mcp__x']) {
    assert.equal(PLAN_TOOLS.includes(dangerous), false, `plan 白名单混入了 ${dangerous}`)
  }
  for (const tool of PLAN_TOOLS) assert.equal(CONFIRM_TOOLS.includes(tool), false, `${tool} 不该既是只读又需确认`)
})

test('模式与确认工具集的既有契约不变', () => {
  assert.deepEqual(AGENT_MODES, ['plan', 'ask', 'full'])
  assert.equal(DEFAULT_MODE, 'ask')
  for (const mode of AGENT_MODES) assert.equal(isAgentMode(mode), true)
  assert.equal(isAgentMode('nope'), false)
  // ask 才需要确认；plan/full 不弹确认框
  assert.equal(needsAskConfirm('ask', 'bash'), true)
  assert.equal(needsAskConfirm('plan', 'bash'), false)
  assert.equal(needsAskConfirm('full', 'bash'), false)
  for (const tool of CONFIRM_TOOLS) assert.equal(needsAskConfirm('ask', tool), true)
})

test('summarizeToolCall 截断超长命令（防止确认卡被撑爆）', () => {
  const long = 'x'.repeat(500)
  const summary = summarizeToolCall('bash', { command: long })
  assert.ok(summary.length <= 160, `摘要过长: ${summary.length}`)
  assert.ok(summary.startsWith('$ '))
  assert.equal(summarizeToolCall('write', { path: 'a.ts' }), '写入 a.ts')
  assert.equal(summarizeToolCall('unknown_tool'), 'unknown_tool')
})
