import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const resources = path.join(root, 'src-tauri', 'resources')
const sidecarSrc = path.join(root, 'sidecar')
const sidecarDst = path.join(resources, 'sidecar')
const sdkDist = path.join(resources, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'index.js')
const nodeDst = path.join(resources, 'node.exe')

// --sidecar-only：只同步 sidecar 源码，跳过 node.exe / SDK / npm 安装。
// 用途：`tauri dev` 下 resource_dir() 会先命中 resources/sidecar 的旧副本，
// 导致改了 sidecar 却在 dev 里跑旧代码（静默验证失效）。此模式让 dev 每次刷新源码。
const sidecarOnly = process.argv.includes('--sidecar-only')

function npmCmd() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function copyNode() {
  const candidates = [
    'D:\\Node\\node.exe',
    process.execPath,
  ]
  const src = candidates.find((item) => existsSync(item))
  if (!src) throw new Error('找不到本机 node.exe，无法打进安装包')
  return src
}

await mkdir(resources, { recursive: true })
await rm(sidecarDst, { recursive: true, force: true })
await cp(sidecarSrc, sidecarDst, {
  recursive: true,
  filter: (src) => !src.includes(`${path.sep}node_modules${path.sep}`) && !src.endsWith(`${path.sep}node_modules`),
})

/** 递归找出目录下所有 .ts 文件（相对 sidecarDst 的路径，正斜杠分隔）。
 *  旧实现硬编码 3 个文件名，新增 sidecar/permissions/*.ts 后就会漏编译 —— 改为自动发现。 */
async function findTsFiles(dir, prefix = '') {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      out.push(...await findTsFiles(path.join(dir, entry.name), rel))
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(rel)
    }
  }
  return out
}

const tsFiles = await findTsFiles(sidecarDst)
if (!tsFiles.length) throw new Error('sidecar 目录里没有找到任何 .ts 文件，构建脚本可能失效')
for (const file of tsFiles) {
  const input = path.join(sidecarDst, file)
  const output = path.join(sidecarDst, file.replace(/\.ts$/, '.js'))
  execFileSync(process.execPath, [
    path.join(root, 'node_modules', 'esbuild', 'bin', 'esbuild'),
    input,
    `--outfile=${output}`,
    '--format=esm',
    '--platform=node',
  ], {
    cwd: root,
    stdio: 'inherit',
  })
}

// 把所有编译产物里的 .ts 说明符改写成 .js。
// esbuild 不重写 import 路径，而编译产物若仍指向 `.ts`，Node 会加载 .ts 源码
// ——本地碰巧能跑（type-stripping），但 .js 与 .ts 可能不同步，且打包后行为不可预测。
// ⚠️ 必须改写 **.js 产物**，不是 .ts 源文件（此前写错目标，产物永远带着 .ts 说明符）。
for (const file of tsFiles) {
  const artifactPath = path.join(sidecarDst, file.replace(/\.ts$/, '.js'))
  if (!existsSync(artifactPath)) continue
  const source = await readFile(artifactPath, 'utf8')
  const fromDir = path.posix.dirname(file)
  let rewritten = source
  for (const other of tsFiles) {
    if (other === file) continue
    // 计算从当前文件出发、指向 other 的相对说明符（含 ./ 前缀）
    const rel = path.posix.relative(fromDir, other)
    const specifier = rel.startsWith('.') ? rel : `./${rel}`
    if (!rewritten.includes(specifier)) continue
    rewritten = rewritten.split(specifier).join(specifier.replace(/\.ts$/, '.js'))
  }
  if (rewritten !== source) await writeFile(artifactPath, rewritten)
}

// index.mjs 是手写入口（不是 esbuild 产物），也需要同样处理
const indexPath = path.join(sidecarDst, 'index.mjs')
{
  const source = await readFile(indexPath, 'utf8')
  let rewritten = source
  for (const other of tsFiles) {
    const specifier = `./${other}`
    if (!rewritten.includes(specifier)) continue
    rewritten = rewritten.split(specifier).join(specifier.replace(/\.ts$/, '.js'))
  }
  if (rewritten !== source) await writeFile(indexPath, rewritten)
}

// 产物自检：sidecar 里的相对 import 必须都能解析。
// 背景：sidecar 从单文件演进为多文件后，"漏复制一个模块"不再有任何症状——
// 脚本会静默成功，直到用户装完打开才发现 sidecar 起不来（ERR_MODULE_NOT_FOUND）。
// 这里直接扫描 import，把故障提前到构建期。两种模式都要跑。
// 产物自检：sidecar 的 import 必须在**安装环境**下都能解析。
// 三类检查：
//   1) 相对 import 不得指向 .ts（编译产物只该引 .js）
//   2) 相对 import 目标文件必须存在
//   3) **裸包名 import 必须在 resources/ 为根时能解析**（装机事故根因，2026-09-29）
//
// 第 3 条为什么必须有：show-image.ts 曾写 `import { Type } from 'typebox'`。
// 开发时能解析（PI/node_modules/typebox 是提升依赖），但安装后 sidecar 跑在
// `<安装目录>/resources/sidecar/`，向上只能找到 `resources/node_modules`（仅 SDK）
// —— sidecar 启动即 ERR_MODULE_NOT_FOUND，表现为"反复退出（3 次/60 秒内）"。
// 本地测试与产物的旧冒烟测试都从仓库根跑，会向上找到 PI/node_modules 而漏判。
//
// 判定方式：把裸包名按 Node 的 ESM 解析规则在 resources/ 下查找
// （resources/node_modules/<name> 是否存在），不实际 import（避免副作用）。
const NODE_BUILTIN = (specifier) => specifier.startsWith('node:') || specifier.startsWith('bun:')

async function assertSidecarImportsResolve() {
  const problems = []
  const seen = new Set()
  const scan = async (file) => {
    if (seen.has(file) || !existsSync(file)) return
    seen.add(file)
    const source = await readFile(file, 'utf8')
    // 三种 import 形态都要扫（漏一种就是一条装机崩溃路径）：
    //   1) import ... from 'x' / export ... from 'x'
    //   2) import 'x'（副作用导入）
    //   3) import('x')（动态导入 —— 裸包名同样必须在包里存在）
    const specifiers = new Set()
    for (const match of source.matchAll(/(?:from|(?<![\w.])import)\s+['"]([^'"]+)['"]/g)) specifiers.add(match[1])
    for (const match of source.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.add(match[1])
    for (const specifier of specifiers) {
      const isRelative = specifier.startsWith('.')
      if (!isRelative) {
        if (NODE_BUILTIN(specifier)) continue
        // 裸包名：必须在 resources/node_modules 下可解析
        if (!resolveBarePackage(specifier)) {
          problems.push(
            `${path.relative(root, file)} → ${specifier}（裸包名在安装包里不存在；` +
            `开发期靠 PI/node_modules 提升依赖才解析成功，装机必崩）`,
          )
        }
        continue
      }
      const target = path.resolve(path.dirname(file), specifier)
      if (specifier.endsWith('.ts') || existsSync(`${target}.ts`)) {
        // 编译产物或入口引用了 .ts —— 说明重写步骤漏了它
        problems.push(`${path.relative(root, file)} → ${specifier}（编译产物不得引用 .ts 源码）`)
        continue
      }
      const hit = [target, `${target}.mjs`, `${target}.js`].find((candidate) => existsSync(candidate))
      if (!hit) { problems.push(`${path.relative(root, file)} → ${specifier}（文件缺失）`); continue }
      if (hit.endsWith('.mjs') || hit.endsWith('.js')) await scan(hit)
    }
  }
  await scan(indexPath)
  if (problems.length) {
    throw new Error(`sidecar 产物有问题，应用会无法启动:\n${problems.map((item) => `  - ${item}`).join('\n')}`)
  }
}

/** 按 Node ESM 规则，在 resources/node_modules 下查找裸包名。支持 @scope/name 与子路径。
 *  环境不完整（resources/node_modules 尚未安装 SDK）时跳过 —— --sidecar-only 模式即此情形，
 *  此时无法判定，宁可放过也不能误报阻断 dev。 */
function resolveBarePackage(specifier) {
  const sdkRoot = path.join(resources, 'node_modules', '@earendil-works', 'pi-coding-agent')
  if (!existsSync(sdkRoot)) return true // 环境不完整：跳过裸包名判定
  const parts = specifier.split('/')
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  const base = path.join(resources, 'node_modules', name)
  if (!existsSync(base)) return false
  // 子路径（如 @scope/pkg/dist/x.js）：确认目标存在
  const rest = specifier.slice(name.length).replace(/^\//, '')
  if (!rest) return true
  return existsSync(path.join(base, rest)) || existsSync(path.join(base, rest, 'index.js'))
}

await assertSidecarImportsResolve()

if (sidecarOnly) {
  console.log('sidecar-only sync 完成（跳过 node.exe / SDK）:', indexPath)
  process.exit(0)
}

const nodeSource = copyNode()
await cp(nodeSource, nodeDst)

// 修改：把 npm 一起放进安装包，用户电脑没有单独安装 Node/npm 时也能直接更新 Pi SDK。
const bundledNpmSource = path.join(path.dirname(nodeSource), 'node_modules', 'npm')
if (existsSync(bundledNpmSource)) {
  await rm(path.join(resources, 'node_modules', 'npm'), { recursive: true, force: true })
  await cp(bundledNpmSource, path.join(resources, 'node_modules', 'npm'), { recursive: true })
  const npmCommandSource = path.join(path.dirname(nodeSource), 'npm.cmd')
  if (existsSync(npmCommandSource)) await cp(npmCommandSource, path.join(resources, 'npm.cmd'))
}

if (!existsSync(sdkDist)) {
  await writeFile(path.join(resources, 'package.json'), `${JSON.stringify({
    name: 'pi-my-runtime',
    private: true,
    type: 'module',
    dependencies: {
      '@earendil-works/pi-coding-agent': '0.85.1',
    },
  }, null, 2)}\n`)
  execFileSync(npmCmd(), ['install', '--omit=dev', '--registry=https://registry.npmjs.org'], {
    cwd: resources,
    stdio: 'inherit',
    shell: true,
  })
}

if (!existsSync(sdkDist)) {
  throw new Error('pi-coding-agent 没有编译产物 dist/，安装包不能缺这个')
}

console.log('runtime ready:', {
  node: nodeDst,
  sidecar: indexPath,
  sdk: sdkDist,
})
