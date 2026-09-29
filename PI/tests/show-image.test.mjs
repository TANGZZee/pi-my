// show_image 工具单测（1-3）
//
// 核心断言：图片只进 details（UI 数据源），**不进模型上下文**；
// 路径规整正确；类型/大小/存在性校验 fail-safe。
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { makeShowImageTool, resolveShowImagePath } from '../sidecar/tools/show-image.ts'

/** 构造工具实例 + 临时图片目录的沙箱 */
function makeSandbox() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pi-showimg-'))
  const writePng = (name, bytes = 100) => writeFileSync(path.join(dir, name), Buffer.alloc(bytes, 0x89))
  return { dir, writePng, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const tool = makeShowImageTool()
const ctx = (cwd) => ({ cwd })

test('工具定义：名称/参数 schema/描述齐备', () => {
  assert.equal(tool.name, 'show_image')
  assert.ok(tool.label)
  assert.ok(tool.description.length > 50, '描述应足够长（LLM 依赖它判断何时调用）')
  assert.ok(tool.description.includes('read'), '描述应引导模型用 read 看图内容')
  assert.ok(tool.parameters, '必须有参数 schema')
  assert.equal(typeof tool.execute, 'function')
})

test('resolveShowImagePath：~ 展开、unicode 空格归一、相对路径', () => {
  const home = os.homedir()
  assert.equal(resolveShowImagePath('~', '/proj'), home)
  // 实现用 join(home, ...)（正/反斜杠随平台），resolve 后等价
  assert.equal(
    path.resolve(resolveShowImagePath('~/x.png', '/proj')),
    path.resolve(path.join(home, 'x.png')),
  )
  // unicode 空格归一：比较时消除盘符差异（Windows 对 "/x" 的 resolve 会补当前盘符）
  assert.equal(
    resolveShowImagePath('/proj/a\u00A0b.png', '/proj').replace(/\\/g, '/').slice(-13),
    '/proj/a b.png',
  )
  // 相对路径挂到 cwd 下（只断言结尾，规避盘符差异）
  const rel = resolveShowImagePath('sub/x.png', '/proj').replace(/\\/g, '/')
  assert.ok(rel.endsWith('/proj/sub/x.png'), `相对路径未按 cwd 解析: ${rel}`)
  assert.equal(resolveShowImagePath('C:\\abs\\x.png', '/proj'), 'C:\\abs\\x.png')
})

test('正常路径：返回 text 占位 + details.images（图片不进模型上下文）', async () => {
  const { dir, writePng, cleanup } = makeSandbox()
  writePng('shot.png')
  const result = await tool.execute('call-1', { paths: [path.join(dir, 'shot.png')] }, undefined, undefined, ctx(dir))
  assert.ok(Array.isArray(result.content))
  assert.match(result.content[0].text, /shot\.png/)
  // 关键：图片在 details，content 里只有文本占位
  assert.equal(result.details.images.length, 1)
  assert.equal(result.details.images[0].mimeType, 'image/png')
  assert.ok(result.details.images[0].data.length > 0)
  assert.equal(JSON.stringify(result.content).includes('iVBOR'), false, 'base64 不应出现在模型可见的 content 里')
  cleanup()
})

test('多张图一次调用：全部进 details，顺序保持', async () => {
  const { dir, writePng, cleanup } = makeSandbox()
  writePng('a.png')
  writePng('b.png')
  writePng('c.gif')
  const result = await tool.execute('call-1', { paths: ['a.png', 'b.png', 'c.gif'].map((n) => path.join(dir, n)) }, undefined, undefined, ctx(dir))
  assert.equal(result.details.images.length, 3)
  assert.deepEqual(result.details.images.map((i) => i.mimeType), ['image/png', 'image/png', 'image/gif'])
  cleanup()
})

test('不支持的类型报错并列出支持的类型', async () => {
  const { dir, cleanup } = makeSandbox()
  writeFileSync(path.join(dir, 'doc.pdf'), 'x')
  await assert.rejects(
    () => tool.execute('c', { paths: [path.join(dir, 'doc.pdf')] }, undefined, undefined, ctx(dir)),
    /不支持的图片类型|png\/jpg/,
  )
  cleanup()
})

test('文件不存在报错且信息含原始路径', async () => {
  const { dir, cleanup } = makeSandbox()
  await assert.rejects(
    () => tool.execute('c', { paths: [path.join(dir, 'nope.png')] }, undefined, undefined, ctx(dir)),
    /文件不存在/,
  )
  cleanup()
})

test('超过 10MB 报错（防 IPC 拖垮渲染）', async () => {
  const { dir, cleanup } = makeSandbox()
  // 写一个 >10MB 的"png"（只测大小，不校验内容）
  writeFileSync(path.join(dir, 'big.png'), Buffer.alloc(11 * 1024 * 1024))
  await assert.rejects(
    () => tool.execute('c', { paths: [path.join(dir, 'big.png')] }, undefined, undefined, ctx(dir)),
    /过大|10MB/,
  )
  cleanup()
})

test('目录而不是文件 → 报错', async () => {
  const { dir, cleanup } = makeSandbox()
  mkdirSync(path.join(dir, 'sub.png'))
  await assert.rejects(
    () => tool.execute('c', { paths: [path.join(dir, 'sub.png')] }, undefined, undefined, ctx(dir)),
    /不是文件/,
  )
  cleanup()
})

test('相对路径按 cwd 解析（agent 的主用例）', async () => {
  const { dir, writePng, cleanup } = makeSandbox()
  writePng('rel.png')
  const result = await tool.execute('c', { paths: ['rel.png'] }, undefined, undefined, ctx(dir))
  assert.equal(result.details.images.length, 1)
  cleanup()
})
