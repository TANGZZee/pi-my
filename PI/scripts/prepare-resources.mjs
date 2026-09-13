import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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

const tsFiles = ['policy.ts', 'approval-extension.ts', 'retry-no-body.ts']
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

const indexPath = path.join(sidecarDst, 'index.mjs')
let index = await readFile(indexPath, 'utf8')
index = index
  .replaceAll('./policy.ts', './policy.js')
  .replaceAll('./approval-extension.ts', './approval-extension.js')
  .replaceAll('./retry-no-body.ts', './retry-no-body.js')
await writeFile(indexPath, index)

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
