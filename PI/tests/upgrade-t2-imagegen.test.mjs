/**
 * T2⑧ 生图原生化（评估 + 落地）承重测试：
 *
 * 评估结论（锁定，防回退）：
 * - SDK generateImages(model, context, options) 需要 models.json 配置 type:'image' 模型
 *   （ProviderImageModelConfig），且 KnownImageApi 目前仅 'openrouter-images'；
 * - 现有 generateImage() 是任意 OpenAI 兼容 baseUrl 的直连实现（/images/generations,
 *   b64_json），不依赖 provider 注册 —— 对本应用的配置形态（用户自填 baseUrl+key+model）
 *   覆盖面严格更大；
 * - 迁移 SDK 路径 = 强制用户改用 models.json 注册 image 模型，能力收窄、配置成本上升，
 *   无对价收益 ⇒ 结论：保留现有实现为主路径，不做替换。
 *
 * 落地防线（原生化兼容层）：
 * - sidecar 新增 generate_images 复合内容别名分支：接受 pi-ai ImagesInputContent 数组，
 *   纯文本输入时归一为 prompt 转发旧实现；含图像输入时如实报错（不静默丢内容）。
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

test('T2⑧ 评估结论锁定：generateImage 保持 OpenAI 兼容直连实现（不迁 SDK generateImages）', () => {
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
  // 端点与响应模式在模板/字符串字面量里，走视图 A（字面量保留；诱饵风险由对抗审查兜底）
  const literalView = squash(stripComments(raw))
  const fnLiteral = literalView.slice(literalView.indexOf('asyncfunctiongenerateImage('))
  assert.ok(fnLiteral.includes('/images/generations'), 'OpenAI 兼容端点缺失')
  assert.ok(fnLiteral.includes("response_format:'b64_json'"), 'b64_json 响应模式缺失')
  // 未引入 SDK generateImages 调用（评估结论：能力收窄，不迁移）；计数走防诱饵视图
  assert.equal(countCodeHits(raw, 'generateImages('), 0, '不得引入 SDK generateImages 直调（会强制 models.json 注册 image 模型，能力收窄）')
})

// ---------- sidecar：generate_images 复合内容别名层 ----------

test('generate_images 别名层：纯文本输入归一转发；图像输入如实报错不静默丢弃', () => {
  assert.equal(countCodeHits(sidecarRaw, "type==='generate_images'"), 1, 'generate_images 分支缺失或被诱饵污染')
  const section = sectionOf("type==='generate_images'", "type==='trust_project'")
  // 缺省输入：从 payload.prompt 兜底构造 TextContent 数组（与旧调用形态兼容）
  assert.ok(section.includes("[{type:'text',text:String(payload?.prompt??'')}]"), '缺省输入必须从 prompt 兜底构造')
  // 提取纯文本部分
  assert.ok(section.includes(".filter((part)=>part?.type==='text'&&typeofpart.text==='string')"), '必须按 TextContent 形状过滤')
  // 文本表达力守卫：非纯文本输入必须报错，不得静默丢内容
  assert.ok(section.includes('if(textParts.length!==rawInput.length)'), '文本/输入数量守卫缺失（图像输入会被静默丢弃）')
  assert.ok(section.includes('暂不支持图像输入内容'), '图像输入必须如实报错')
  // 归一转发旧实现（prompt 用换行拼接多段文本）
  assert.ok(section.includes('awaitgenerateImage({...payload,prompt:textParts.join(\'\\n\')})'), '必须归一转发旧 generateImage 实现')
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
})

// ---------- 字面量诱饵防线自检 ----------

test('防诱饵自检：字面量里的 generate_images 不计入代码命中', () => {
  const { shape, literal } = shapeWithLiteralMask(stripComments("const x = \"type==='generate_images'\""))
  assert.equal(indexOfCode(shape, literal, "type==='generate_images'"), -1)
})
