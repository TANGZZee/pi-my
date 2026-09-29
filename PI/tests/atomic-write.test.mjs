// 原子写单测（2-13）
//
// 核心契约：目标文件要么是完整新内容、要么是完整旧内容，绝不出现半截；
// Windows EPERM 重试路径可用模拟 fs 错误触发（不真造并发句柄）。
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { atomicWriteJson, atomicWriteText } from '../sidecar/atomic-write.mjs'

test('原子写：正常路径写入完整内容', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-aw-'))
  const file = path.join(dir, 'config.json')
  await atomicWriteText(file, '{"a":1}\n')
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}\n')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('原子写：覆盖已有文件不残留临时文件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-aw-'))
  const file = path.join(dir, 'list.json')
  await atomicWriteText(file, 'v1\n')
  await atomicWriteText(file, 'v2\n')
  assert.equal(fs.readFileSync(file, 'utf8'), 'v2\n')
  const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp'))
  assert.deepEqual(leftovers, [], 'rename 成功后不得残留 .tmp 文件')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('原子写 JSON：键序与尾换行稳定（并发读者看到的格式可预期）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-aw-'))
  const file = path.join(dir, 'data.json')
  await atomicWriteJson(file, { b: 1, a: [1, 2] })
  assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "b": 1,\n  "a": [\n    1,\n    2\n  ]\n}\n')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('原子写：目标目录不存在时失败且不静默（调用方负责 mkdir）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-aw-'))
  const file = path.join(dir, 'missing', 'config.json')
  await assert.rejects(() => atomicWriteText(file, 'x'), /ENOENT/)
  // 目录必须没被创建（与 config.mjs 的约定：调用方先 mkdir）
  assert.equal(fs.existsSync(path.join(dir, 'missing')), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('原子写：EPERM 重试路径真实生效（注入前 2 次失败）', async () => {
  const { __test } = await import('../sidecar/atomic-write.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-aw-'))
  const file = path.join(dir, 'x.json')
  fs.writeFileSync(file, 'old\n')
  __test.forceRetryableFailures(2)
  try {
    await atomicWriteText(file, 'new\n')
    assert.equal(fs.readFileSync(file, 'utf8'), 'new\n', '重试后应成功写入')
    const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp'))
    assert.deepEqual(leftovers, [], '重试成功后不得残留临时文件')
  } finally {
    __test.forceRetryableFailures(0) // 复位，避免影响其他用例
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

test('原子写：超限 EPERM 走兜底直写，数据不丢', async () => {
  const { __test } = await import('../sidecar/atomic-write.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-aw-'))
  const file = path.join(dir, 'y.json')
  fs.writeFileSync(file, 'old\n')
  // 注入超过重试上限（100）的失败次数 → 兜底直写生效
  __test.forceRetryableFailures(200)
  try {
    await atomicWriteText(file, 'fallback\n')
    // 兜底 writeFile 不走 rename，直接覆盖 → 内容应为新值
    assert.equal(fs.readFileSync(file, 'utf8'), 'fallback\n', '兜底直写应保住数据')
  } finally {
    __test.forceRetryableFailures(0)
  }
  fs.rmSync(dir, { recursive: true, force: true })
})
