import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateBashCommand, DEFAULT_PERMISSION_CONFIG, needsTemporaryExempt } from '../sidecar/permissions/index.ts'
const rules = DEFAULT_PERMISSION_CONFIG.rules
const tmp = (process.env.TEMP || '/tmp').replace(/\\/g, '/')
const override = (segment) => (needsTemporaryExempt(segment) ? 'allow' : null)

test('审查漏洞3回归：临时区段与危险段混合时取最严（不得放行链尾的 /important）', () => {
  const cases = [
    `rm -rf ${tmp}/x && rm -rf /important`,
    `rm -rf ${tmp}/a && rm -rf ${tmp}/b && rm -rf /etc/hosts`,
    `cd /x && rm -rf ${tmp}/a && rm -rf /important`,
  ]
  for (const cmd of cases) {
    const { action } = evaluateBashCommand(rules, cmd, 'ask', override)
    assert.notEqual(action, 'allow', `混合链被放行: ${cmd}`)
    assert.equal(action, 'ask')
  }
})

test('纯临时区 rm 仍被豁免（不打断 agent 临时工作流）', () => {
  const { action } = evaluateBashCommand(rules, `rm -rf ${tmp}/a ${tmp}/b`, 'ask', override)
  assert.equal(action, 'allow', '全临时区目标应该豁免')
})

test('全临时区但夹一个非临时目标 → 不豁免', () => {
  const { action } = evaluateBashCommand(rules, `rm -rf ${tmp}/a /etc/hosts`, 'ask', override)
  assert.equal(action, 'ask')
})
