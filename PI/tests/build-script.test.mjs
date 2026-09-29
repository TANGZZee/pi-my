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
import fs from 'node:fs'
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

test('装机冒烟脚本仍在且已接入管线（2026-09-29 事故的验收防线）', () => {
  // 该脚本在临时目录模拟真实安装布局跑真实请求 —— 没有它，
  // "只有装机才暴露"的缺陷（缺裸包名、工具未注册）会直接送到用户手里。
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'smoke-install.mjs')), 'smoke-install.mjs 被删除')
  assert.match(pkg.scripts['smoke:install'] || '', /smoke-install/, 'smoke:install 脚本未注册')
  assert.match(pkg.scripts['verify:install'] || '', /smoke/, 'verify:install 未把冒烟纳入')
  // CI 必须跑它（漏了这一步等于防线只在本地）。
  // 注意：CI 工作流在**仓库根**（PI 的上一级），不在 PI/ 内。
  const ciPath = path.join(root, '..', '.github', 'workflows', 'ci.yml')
  assert.ok(fs.existsSync(ciPath), `CI 工作流不存在: ${ciPath}`)
  assert.match(readFileSync(ciPath, 'utf8'), /smoke:install|smoke-install/, 'CI 未运行装机冒烟')
})

test('sidecar 入口仍引入瘦身/权限/审批扩展（承重 import 防误删）', () => {
  const sidecar = read('sidecar/index.mjs')
  for (const module of ['event-slim.mjs', 'policy.ts', 'approval-extension.ts', 'ui-context.ts']) {
    assert.ok(sidecar.includes(module), `sidecar/index.mjs 缺少对 ${module} 的引用`)
  }
})

// ---------------------------------------------------------------------------
// 装机事故回归（2026-09-29）：sidecar 不得依赖开发期的"提升依赖"
//
// 事故：show-image.ts 写了 `import { Type } from 'typebox'`。开发目录能解析
// （PI/node_modules/typebox 来自依赖提升），但安装后 sidecar 跑在
// `<安装目录>/resources/sidecar/`，向上只有 resources/node_modules（仅含 SDK）
// → ERR_MODULE_NOT_FOUND → sidecar 启动即崩 → 前端显示"反复退出（3 次/60 秒内）"。
//
// 这里**独立实现**一遍解析检查（不依赖 prepare-resources.mjs 的实现），
// 双重保险：构建期由脚本自检拦，CI 由本测试拦。
// 只扫源码即可 —— 产物由源码编译而来，源码干净则产物干净（脚本自检兜底产物）。
// ---------------------------------------------------------------------------
test('sidecar 源码的全部裸包名都能在安装包 resources/node_modules 中解析（装机事故回归）', () => {
  const resourcesModules = path.join(root, 'src-tauri', 'resources', 'node_modules')
  const sdkRoot = path.join(resourcesModules, '@earendil-works', 'pi-coding-agent')
  if (!fs.existsSync(sdkRoot)) {
    // 环境未准备 SDK（如纯前端环境）：无法判定，跳过而非误报
    return
  }
  const sdkAvailable = new Set(fs.readdirSync(resourcesModules))
  const scopedAvailable = new Map()
  for (const entry of sdkAvailable) {
    if (!entry.startsWith('@')) continue
    scopedAvailable.set(entry, new Set(fs.readdirSync(path.join(resourcesModules, entry))))
  }
  const canResolve = (specifier) => {
    const parts = specifier.split('/')
    const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
    if (name.startsWith('@')) {
      const [scope, pkg] = name.split('/')
      return Boolean(scopedAvailable.get(scope)?.has(pkg))
    }
    return sdkAvailable.has(name)
  }

  const builtins = (s) => s.startsWith('node:') || s.startsWith('bun:')
  const files = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        walk(full)
      } else if (/\.(mjs|ts)$/.test(entry.name)) {
        files.push(full)
      }
    }
  }
  walk(path.join(root, 'sidecar'))

  const offenders = []
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const specs = new Set()
    for (const m of source.matchAll(/(?:from|(?<![\w.])import)\s+['"]([^'"]+)['"]/g)) specs.add(m[1])
    for (const m of source.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.add(m[1])
    for (const spec of specs) {
      if (spec.startsWith('.') || builtins(spec)) continue
      if (!canResolve(spec)) offenders.push(`${path.relative(root, file)} → ${spec}`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `以下裸包名在安装包里不存在（开发期靠提升依赖才解析成功，装机必崩）:\n  ${offenders.join('\n  ')}`,
  )
})
