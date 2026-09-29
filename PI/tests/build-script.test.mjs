// 构建脚本承重断言（借鉴 pi-agent-desktop 的 package.test.ts）
//
// 目的：让"删掉/改名一个承重构建步骤"变成**测试失败**，而不是
// 在打包后以 ERR_MODULE_NOT_FOUND 的形式爆发（此前发生过：
// prepare-resources.mjs 的 .ts 编译列表漏掉新模块 → 干净克隆构建出坏包）。
//
// 覆盖三处关键点：
//   1. prepare-resources.mjs 仍会编译 sidecar 的 .ts 文件（自动发现，不能删）
//   2. 产物 import 重写步骤存在（.ts → .js）
//   3. 产物自检（防"漏复制模块静默成功"）仍在
//   4. tauri.conf.json 的 beforeBuildCommand / beforeDevCommand 仍调用它
//   5. package.json 的 verify 管线仍包含 check/test/build 三段
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const read = (rel) => readFileSync(path.join(root, rel), 'utf8')
const pkg = JSON.parse(read('package.json'))
const tauriConf = JSON.parse(read('src-tauri/tauri.conf.json'))

test('verify 管线包含 check / test / build 三段（缺一则防线失效）', () => {
  const verify = pkg.scripts.verify || ''
  for (const part of ['check', 'test', 'build']) {
    assert.ok(verify.includes(part), `npm run verify 缺少 ${part} 段: "${verify}"`)
  }
})

test('check 管线必须同时覆盖 tsc 与 svelte-check（只查其一不够）', () => {
  const check = pkg.scripts.check || ''
  assert.match(check, /check:types/)
  assert.match(check, /check:svelte/)
  assert.match(pkg.scripts['check:types'] || '', /tsc/, 'check:types 应调用 tsc')
  assert.match(pkg.scripts['check:svelte'] || '', /svelte-check/, 'check:svelte 应调用 svelte-check')
})

// 以下三条针对 prepare-resources.mjs 内部实现的断言（编译/重写/自检）已改为
// **行为验证**：tests/sidecar-integration.test.mjs 用打包产物真实跑一遍 sidecar
// （若 .ts 说明符未重写或模块缺失，产物的 init 请求会立刻 ERR_MODULE_NOT_FOUND）；
// scripts/prepare-resources.mjs 的 assertSidecarImportsResolve 也在构建期兜底。
// 此前的源码 grep 断言被变异测试证实 6/11 可被"注释保留字面量/等价重构"绕过。

test('tauri.conf.json 的构建钩子仍调用 prepare-resources.mjs', () => {
  const beforeBuild = tauriConf.build.beforeBuildCommand || ''
  assert.match(beforeBuild, /prepare-resources/, 'beforeBuildCommand 缺少打包前置脚本')
  const beforeDev = tauriConf.build.beforeDevCommand || ''
  assert.match(beforeDev, /prepare:dev|prepare-resources/, 'beforeDevCommand 应同步 sidecar（dev 下加载的是 resources 副本）')
})

test('dev 与 build 都不能跳过 sidecar 同步（否则改了 sidecar 在 dev 里不生效）', () => {
  assert.match(pkg.scripts['prepare:dev'] || '', /--sidecar-only/, 'prepare:dev 应带 --sidecar-only')
  assert.match(pkg.scripts['prepare:runtime'] || '', /prepare-resources/, 'prepare:runtime 指向主脚本')
})

test('sidecar 入口仍引入瘦身/权限/审批扩展（承重 import 防误删）', () => {
  const sidecar = read('sidecar/index.mjs')
  for (const module of ['event-slim.mjs', 'policy.ts', 'approval-extension.ts', 'ui-context.ts']) {
    assert.ok(sidecar.includes(module), `sidecar/index.mjs 缺少对 ${module} 的引用`)
  }
})
