/**
 * T2⑧ 生图原生化（评估 + 落地 + SDK 1.0.0 跟进）承重测试：
 *
 * 评估结论（锁定，防回退）：
 * - 现有 generateImage() 是任意 OpenAI 兼容 baseUrl 的直连实现（/images/generations,
 *   b64_json），不依赖 provider 注册 —— 对本应用的配置形态（用户自填 baseUrl+key+model）
 *   覆盖面严格更大；保持为主路径（纯文本输入的唯一路径）。
 * - SDK 0.99.2 评估时无图像输入路径；1.0.0 新增 ModelRuntime.generateImages(model,
 *   context, options)，补齐了图像输入能力 —— 但它只能服务 models.json/物理目录注册的
 *   type:'image' 模型（虚拟模型 route 只能回 chat 模型）。
 * - 结论：双路径并存 —— 纯文本输入归一为 prompt 走直连实现；含图像输入走 SDK 原生
 *   generateImages（getAvailableOfType('image') 挑模型）。两条路径都不静默丢内容。
 *
 * 落地防线：
 * - sidecar generate_images 复合内容别名分支：接受 pi-ai ImagesInputContent 数组按输入
 *   内容分流；generateImagesViaSdk 检查 stopReason（SDK 不 throw）、输出归一为旧形状。
 * - rpc-policy：generate_images 与 generate_image 同档超时登记。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { TIMEOUT_BY_TYPE, requestTimeoutMs } from '../src/rpc-policy.ts'
import {
  squash,
  stripComments,
  maskStrings,
  codeShapeOf,
  functionBodyOf,
  shapeWithLiteralMask,
  indexOfCode,
} from './helpers/source-assert.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function viewA(relative) {
  return squash(stripComments(readFileSync(join(root, relative), 'utf8')))
}

/** 防诱饵计数：只统计「真实代码区」的命中（字符串/注释里的同形文本不计入）。 */
function countCodeHits(rawSource, needle) {
  const { shape, literal } = shapeWithLiteralMask(stripComments(rawSource))
  let count = 0
  let pos = 0
  for (;;) {
    const idx = indexOfCode(shape, literal, needle, pos)
    if (idx < 0) break
    count += 1
    pos = idx + 1
  }
  return count
}

const sidecarA = viewA('sidecar/index.mjs')
const sidecarRaw = readFileSync(join(root, 'sidecar/index.mjs'), 'utf8')
const sectionOf = (startNeedle, endNeedle) => {
  const start = sidecarA.indexOf(startNeedle)
  const end = endNeedle ? sidecarA.indexOf(endNeedle, start + 1) : -1
  return sidecarA.slice(start, end > start ? end : start + 1600)
}

// ---------- 评估结论锁定（防无意回退到 SDK 路径） ----------

test('T2⑧ 评估结论锁定：generateImage 保持 OpenAI 兼容直连实现（纯文本主路径，不被 SDK 路径替换）', () => {
  const raw = readFileSync(join(root, 'sidecar/index.mjs'), 'utf8')
  // 代码形态断言走屏蔽视图：stripComments 不解析正则字面量（/^https?:\/\//i 里的 `//`
  // 会被误当行注释吃掉整行），maskStrings 只屏蔽字符串/模板字面量、正则原样保留。
  const maskedAll = codeShapeOf(raw)
  const start = maskedAll.indexOf('asyncfunctiongenerateImage(')
  assert.ok(start >= 0, 'generateImage 实现缺失')
  const fn = maskedAll.slice(start, start + 2600)
  // SSRF 底线与直连实现骨架（代码形态，字面量屏蔽后仍可断言）
  assert.ok(fn.includes('/^https?:\\/\\//i.test(baseUrl)'), 'baseUrl 协议校验缺失（SSRF 底线）')
  assert.ok(fn.includes('AbortSignal.timeout(180000)'), '180s 超时缺失')
  assert.ok(fn.includes('item?.b64_json'), 'b64_json 响应读取缺失')
  assert.ok(fn.includes('item?.url'), 'url 响应读取缺失')
  // prompt 长度上限（数字字面量在屏蔽视图中存活）；闭合括号防前缀子串（4000⊂40000）
  assert.ok(fn.includes('prompt.length>4000)'), 'prompt 4000 字符上限缺失')
  // 端点与响应模式在模板/字符串字面量里，走视图 A（字面量保留；诱饵风险由对抗审查兜底）
  const literalView = squash(stripComments(raw))
  const fnLiteral = literalView.slice(literalView.indexOf('asyncfunctiongenerateImage('))
  assert.ok(fnLiteral.includes('/images/generations'), 'OpenAI 兼容端点缺失')
  assert.ok(fnLiteral.includes("response_format:'b64_json'"), 'b64_json 响应模式缺失')
  // SDK 1.0.0 跟进：generateImages 调用恰好出现在 generateImagesViaSdk 助手里
  // （runtime.generateImages 原生路径）；generateImage 分支本身不得直调。
  assert.equal(countCodeHits(raw, 'runtime.generateImages('), 1, 'SDK generateImages 直调必须且只能出现在 generateImagesViaSdk 内')
  assert.equal(countCodeHits(raw, 'asyncfunctiongenerateImagesViaSdk('), 1, 'generateImagesViaSdk 助手缺失')
})

// ---------- sidecar：generate_images 复合内容别名层 ----------

test('generate_images 别名层：纯文本归一转发直连实现；图像输入分流 SDK 原生路径', () => {
  assert.equal(countCodeHits(sidecarRaw, "type==='generate_images'"), 1, 'generate_images 分支缺失或被诱饵污染')
  const section = sectionOf("type==='generate_images'", "type==='trust_project'")
  // 缺省输入：从 payload.prompt 兜底构造 TextContent 数组（与旧调用形态兼容）
  assert.ok(section.includes("[{type:'text',text:String(payload?.prompt??'')}]"), '缺省输入必须从 prompt 兜底构造')
  // 数组判别必须 Array.isArray（放宽成 != null 会让畸形 input 从兜底变 crash）
  assert.ok(section.includes('Array.isArray(payload?.input)'), 'input 数组判别缺失')
  // 提取纯文本部分
  assert.ok(section.includes(".filter((part)=>part?.type==='text'&&typeofpart.text==='string')"), '必须按 TextContent 形状过滤')
  // 分流守卫：非纯文本输入不得静默丢内容（数量守卫仍锁在分支里）
  assert.ok(section.includes('if(textParts.length!==rawInput.length)'), '文本/输入数量守卫缺失（图像输入会被静默丢弃）')
  // 图像输入分流：走 SDK 原生路径（不再是「暂不支持」报错 —— SDK 1.0.0 已补齐能力）
  assert.ok(!section.includes('暂不支持图像输入内容'), '旧「暂不支持图像输入」报错必须移除（1.0.0 已有原生路径）')
  assert.ok(section.includes('awaitgenerateImagesViaSdk(payload,rawInput)'), '图像输入必须分流到 generateImagesViaSdk')
  // 归一转发旧实现（prompt 用换行拼接多段文本）
  assert.ok(section.includes('awaitgenerateImage({...payload,prompt:textParts.join(\'\\n\')})'), '纯文本必须归一转发旧 generateImage 实现')
})

test('generateImagesViaSdk：物理 image 模型挑选 + stopReason 检查（SDK 不 throw）+ 输出归一', () => {
  const maskedAll = codeShapeOf(sidecarRaw)
  const start = maskedAll.indexOf('asyncfunctiongenerateImagesViaSdk(')
  assert.ok(start >= 0, 'generateImagesViaSdk 实现缺失')
  const fn = maskedAll.slice(start, start + 2000)
  // runtime 能力守卫：缺 generateImages（旧 SDK）时如实报错（'function' 字面量在屏蔽视图中不可见）
  assert.ok(fn.includes('typeofruntime.generateImages!=='), 'SDK 版本守卫缺失')
  // 只在物理目录 image 模型里挑（虚拟模型 route 只能回 chat 模型）
  assert.ok(fn.includes('.getAvailableOfType('), '必须从物理 image 模型中挑选')
  // 显式指定优先，缺省回退第一个（wanted&&find(...)）||candidates[0]）
  // M2/M3 修补：wanted 取值与守卫前缀都锁进断言（缺 wanted&& 时显式 model 永远失效）
  assert.ok(fn.includes('wanted&&candidates.find((item)=>item.id===wanted))||candidates[0]'), '模型挑选逻辑缺失（显式指定优先，缺省回退第一个）')
  // SDK 捕获错误为 stopReason:'error'/'aborted' 不 throw —— 调用方必须检查两个档位
  assert.equal((fn.match(/result\?\.stopReason===/g) || []).length, 2, 'stopReason 检查缺失（SDK 失败会被当成成功）')
  // 输出提取：image part 判别 + base64 data 字符串判别（M5 修补：type 值走字面量保留视图）
  assert.ok(fn.includes('typeofpart.data==='), '输出提取缺失（typeofpart.data===）')
  assert.ok(fn.includes('{data:first.data,mimeType:first.mimeType||'), '输出必须归一为旧返回形状')
  // M2/M4/M6 修补：字面量值（'error'/'aborted'/'image'/'image/png'/''）在屏蔽视图中不可见
  // —— 用 functionBodyOf（保留字面量+squash）锁定值本身。
  const fnLit = functionBodyOf(stripComments(sidecarRaw), 'generateImagesViaSdk')
  assert.ok(fnLit.includes("String(payload?.model||'').trim()"), 'model 取值必须 trim 空-安全取自 payload.model')
  assert.ok(fnLit.includes("result?.stopReason==='error'"), "stopReason 'error' 档位缺失")
  assert.ok(fnLit.includes("result?.stopReason==='aborted'"), "stopReason 'aborted' 档位缺失")
  assert.ok(fnLit.includes("part?.type==='image'"), '输出提取必须只认 image part（字面量锁定）')
  assert.ok(fnLit.includes("mimeType:first.mimeType||'image/png'"), 'mimeType 缺省必须为 image/png')
  // 错误消息走字面量保留视图（防诱饵由对抗审查兜底）
  const literalView = squash(stripComments(sidecarRaw))
  const fnLiteral = literalView.slice(literalView.indexOf('asyncfunctiongenerateImagesViaSdk('))
  assert.ok(fnLiteral.includes('没有可用的图像模型'), '无可用模型错误提示缺失（需指引纯文本路径）')
  assert.ok(fnLiteral.includes('SDK版本不支持图像输入生图'), 'SDK 版本守卫错误消息缺失')
})

// ---------- rpc-policy：同档超时登记 ----------

test('generate_images 与 generate_image 同档超时登记：rpc-policy ↔ sidecar 分支一致', () => {
  for (const type of ['generate_image', 'generate_images']) {
    assert.equal(countCodeHits(sidecarRaw, `type==='${type}'`), 1)
    assert.ok(TIMEOUT_BY_TYPE[type] > 0, `TIMEOUT_BY_TYPE 缺少 ${type}`)
    assert.equal(requestTimeoutMs(type), TIMEOUT_BY_TYPE[type])
  }
  // 同档锁定：别名层转发旧实现，超时预算必须一致（否则外层先超时，内层还在跑）
  assert.equal(TIMEOUT_BY_TYPE.generate_images, TIMEOUT_BY_TYPE.generate_image, 'generate_images 必须与 generate_image 同档')
  // M24 修补：绝对下限 —— 内层 AbortSignal.timeout(180000) 必须小于外层 rpc-policy 预算，
  // 否则外层先超时、内层还在跑；两档都必须 ≥ 内层 180s。
  assert.ok(TIMEOUT_BY_TYPE.generate_image >= 180_000, 'generate_image 预算必须 ≥ 内层 180s（AbortSignal.timeout）')
  assert.ok(TIMEOUT_BY_TYPE.generate_images >= 180_000, 'generate_images 预算必须 ≥ 内层 180s（AbortSignal.timeout）')
})

// ---------- 字面量诱饵防线自检 ----------

test('防诱饵自检：字面量里的 generate_images 不计入代码命中', () => {
  const { shape, literal } = shapeWithLiteralMask(stripComments("const x = \"type==='generate_images'\""))
  assert.equal(indexOfCode(shape, literal, "type==='generate_images'"), -1)
})
