// 权限门控扩展（extension.ts）的集成级测试
//
// 为什么必须要有（审查结论）：门控扩展是安全边界，但其逻辑（路径边界/临时区 hook/
// 记忆/deny 短路/full 短路）在纯函数测试里完全测不到——本批的 3 个 P0 安全缺陷
// 全部位于这一层。这里用 fake-pi 捕获 tool_call 处理器，直接喂事件断言结果。
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { createPermissionGateExtension } from '../sidecar/permissions/index.ts'

/** 搭一个临时 agentDir + 捕获 tool_call 处理器的沙箱 */
function makeGate({ allowedPatterns = [], mode = 'ask', projectRoot, rules } = {}) {
  const agentDir = mkdtempSync(path.join(os.tmpdir(), 'pi-gate-'))
  if (rules) {
    writeFileSync(path.join(agentDir, 'permissions.json'), JSON.stringify({ enabled: true, rules }))
  }
  const asks = []
  let factory
  const fakePi = {
    on: (_event, handler) => { factory = handler },
  }
  const extension = createPermissionGateExtension({
    agentDir,
    getMode: () => mode,
    sessionId: 'test',
    getProjectRoot: () => projectRoot,
    getAllowedPatterns: () => allowedPatterns,
    rememberAllowed: (pattern) => allowedPatterns.push(pattern),
    confirm: async (title, message) => {
      asks.push({ title, message })
      return true // 默认放行，便于测试记忆行为
    },
    warn: () => {},
  })
  extension.factory(fakePi)
  const call = (toolName, input) => factory({ toolName, input })
  return {
    call, asks, agentDir,
    cleanup: () => rmSync(agentDir, { recursive: true, force: true }),
  }
}

test('确认过的命令记住的是精确段，不再放大到整个命令族（P0-2 回归）', async () => {
  const gate = makeGate()
  // 第一次：确认 rm -rf /tmp/a（默认策略 ask）→ 记忆
  const first = await gate.call('bash', { command: 'rm -rf /tmp/a' })
  assert.equal(first, undefined, '确认后放行')
  assert.equal(gate.asks.length, 1)
  // 弹窗标题可读（suggestPattern 的通配只用于展示）
  assert.match(gate.asks[0].title, /^bash: rm -rf/, `标题应指向命令: ${gate.asks[0].title}`)
  // 换一个目标：不得被记忆放行，必须再弹
  await gate.call('bash', { command: 'rm -rf /etc' })
  assert.ok(gate.asks.length >= 2, 'rm -rf /etc 必须再次弹窗（不得被旧记忆放行）')
  gate.cleanup()
})

test('确认过无害命令后，链中夹带危险命令仍会被拦（P0-1 回归）', async () => {
  const gate = makeGate({ allowedPatterns: ['bash: ls'] })
  const result = await gate.call('bash', { command: 'cd / && ls; rm -rf /important' })
  // 记忆是整串匹配：'cd / && ls; rm -rf /important' !== 'ls' → 必须弹确认
  assert.equal(gate.asks.length, 1, '链中夹带危险段必须弹窗')
  assert.equal(result, undefined, '确认后放行')
  gate.cleanup()
})

test('full 模式仍执行显式 deny 规则（deny 高于模式）', async () => {
  const gate = makeGate({
    mode: 'full',
    rules: { bash: { 'rm -rf *': 'deny' } },
  })
  const result = await gate.call('bash', { command: 'rm -rf /important' })
  assert.equal(result?.block, true, 'full 模式必须仍然执行 deny')
  assert.match(result.reason, /被权限规则拒绝/)
  gate.cleanup()
})

test('full 模式不再弹确认（语义：跳过 ask 层）', async () => {
  const gate = makeGate({ mode: 'full' })
  await gate.call('bash', { command: 'echo hello' })
  assert.equal(gate.asks.length, 0, 'full 模式不弹确认')
  gate.cleanup()
})

test('plan 模式拦截写工具与 bash（纵深防御）', async () => {
  const gate = makeGate({ mode: 'plan' })
  for (const [tool, input] of [['bash', { command: 'ls' }], ['write', { path: '/a' }], ['edit', { path: '/a' }]]) {
    const result = await gate.call(tool, input)
    assert.equal(result?.block, true, `plan 模式必须拦截 ${tool}`)
    assert.match(result.reason, /计划模式/)
  }
  // 只读工具放行
  assert.equal(await gate.call('read', { path: '/a' }), undefined)
  gate.cleanup()
})

test('deny 规则在任何模式下都不可被记忆或豁免覆盖', async () => {
  const gate = makeGate({
    mode: 'ask',
    rules: { bash: { 'rm -rf *': 'deny' } },
    allowedPatterns: ['bash: rm -rf /tmp/a'],
  })
  const result = await gate.call('bash', { command: 'rm -rf /tmp/a' })
  assert.equal(result?.block, true, 'deny 必须拦，即使记忆命中')
  assert.match(result.reason, /被权限规则拒绝/)
  gate.cleanup()
})

test('临时区 rm 默认豁免，但 junction 逃逸不算临时区（P0-3 回归）', async () => {
  const gate = makeGate()
  // 用真实的 os.tmpdir() 下文件（Windows 上 /tmp 不是临时区，会被正确询问）
  const tmpFile = path.join(os.tmpdir(), `pi-gate-test-${Date.now()}.txt`)
  writeFileSync(tmpFile, 'x')
  const ok = await gate.call('bash', { command: `rm -rf "${tmpFile}"` })
  assert.equal(ok, undefined, '临时区内的 rm 应豁免')
  assert.equal(gate.asks.length, 0, '临时区 rm 不该弹窗')

  // junction 逃逸：junction 建在临时区里、指向**真正在临时区外**的目录。
  // 注意"外面"必须是临时区之外 —— 用项目目录（进程 cwd）作靶子。
  const projectRoot = process.cwd()
  const outside = mkdtempSync(path.join(projectRoot, 'pi-gate-out-'))
  const link = path.join(os.tmpdir(), `pi-gate-esc-${Date.now()}`)
  let made = false
  try {
    writeFileSync(path.join(outside, 'secret.txt'), 'x')
    if (process.platform === 'win32') {
      const { execSync } = await import('node:child_process')
      try { execSync(`cmd /c mklink /J "${link}" "${outside}"`, { stdio: 'ignore' }); made = true } catch { /* 无权限则跳过 */ }
    } else {
      const { symlinkSync } = await import('node:fs')
      try { symlinkSync(outside, link, 'junction'); made = true } catch { /* ignore */ }
    }
    if (made) {
      const escaped = path.join(link, 'secret.txt')
      await gate.call('bash', { command: `rm -rf "${escaped}"` })
      assert.ok(gate.asks.length >= 1, 'junction 逃逸必须弹窗确认，不得静默豁免')
    }
  } finally {
    rmSync(outside, { recursive: true, force: true })
    if (made) { try { rmSync(link, { force: true }) } catch { /* ignore */ } }
  }
  gate.cleanup()
})

test('界外写确认、界外读放行（projectRoot 必须存在）', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pi-gate-root-'))
  const gate = makeGate({ projectRoot: root })
  // 界外写 → 确认
  await gate.call('write', { path: path.join(os.tmpdir(), 'outside.txt') })
  assert.ok(gate.asks.length >= 1, '界外写必须确认')
  // 界外读 → 默认放行（效率取舍）
  assert.equal(await gate.call('read', { path: path.join(os.tmpdir(), 'outside.txt') }), undefined)
  // 界内写 → 不弹
  const inside = makeGate({ projectRoot: root })
  await inside.call('write', { path: path.join(root, 'inside.txt') })
  assert.equal(inside.asks.length, 0, '界内写不该弹（ask 模式的写确认由确认桥的 bash/edit/write 规则决定，界内写按默认 allow）')
  rmSync(root, { recursive: true, force: true })
  gate.cleanup()
})

test('记忆命中只放行完全相同的命令，projectRoot 缺省时仍有路径边界', async () => {
  // projectRoot 未显式给出 → 用进程 cwd 兜底（审查 P1-5）
  const gate = makeGate()
  const outside = path.join(os.tmpdir(), `pi-gate-o2-${Date.now()}.txt`)
  writeFileSync(outside, 'x')
  await gate.call('write', { path: outside })
  assert.ok(gate.asks.length >= 1, 'projectRoot 缺省时界外写仍须确认（P1-5 回归）')
  rmSync(outside, { force: true })
  gate.cleanup()
})

test('确认通道异常按拒绝处理，且不写记忆（P0-4 相关）', async () => {
  const agentDir = mkdtempSync(path.join(os.tmpdir(), 'pi-gate-'))
  const allowedPatterns = []
  const extension = createPermissionGateExtension({
    agentDir,
    getMode: () => 'ask',
    sessionId: 't',
    getProjectRoot: () => process.cwd(),
    getAllowedPatterns: () => allowedPatterns,
    rememberAllowed: (pattern) => allowedPatterns.push(pattern),
    confirm: async () => { throw new Error('前端崩了') },
    warn: () => {},
  })
  extension.factory({ on: (_e, h) => { extension.handler = h } })
  const result = await extension.handler({ toolName: 'bash', input: { command: 'rm -rf /tmp/a' } })
  assert.equal(result?.block, true, '通道异常必须按拒绝处理')
  assert.equal(allowedPatterns.length, 0, '通道异常不得写记忆')
  rmSync(agentDir, { recursive: true, force: true })
})
