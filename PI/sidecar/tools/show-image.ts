// show_image 工具：把图片显示到对话区（0-7/1-3，移植自 percho, MIT）
//
// 关键设计：图片只放进 result.details（UI 渲染 + jsonl 持久化），**不进模型上下文**
// ——模型要看图内容应使用 read 工具。这避免了"把整张 base64 塞进对话"的 token 浪费。
//
// 前端消费点：App.svelte 在 tool_execution_end 里读取 result.details.images
// 并渲染到消息区。
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { Type } from 'typebox'

/** 单图上限：过大的文件拖慢 IPC/渲染 */
const MAX_BYTES = 10 * 1024 * 1024
/** 单次调用最多发图数量（对话区单行可容纳，防滥发） */
const MAX_IMAGES = 9

/** 与 read 工具的图片类型白名单一致（按扩展名识别） */
const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

/** unicode 空格（macOS 截图名常带窄空格 等）归一为普通空格 */
const UNICODE_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\uFEFF]/g

/** 输入路径规整：~ 展开为 home、unicode 空格归一、相对路径按 cwd resolve。 */
export function resolveShowImagePath(rawPath, cwd, home = homedir()) {
  let p = String(rawPath ?? '').replace(UNICODE_SPACES, ' ')
  if (p === '~') p = home
  else if (p.startsWith('~/') || p.startsWith('~\\')) p = join(home, p.slice(2))
  return isAbsolute(p) ? p : resolve(cwd, p)
}

/** show_image 工具的结构化详情（tool_execution_end 的 result.details；模型不可见） */
export interface ShowImageDetails {
  paths: string[]
  images: Array<{ data: string; mimeType: string }>
}

const showImageParams = Type.Object({
  paths: Type.Array(Type.String({ description: '图片文件路径：绝对路径、相对工作目录、或以 ~ 开头' }), {
    minItems: 1,
    maxItems: MAX_IMAGES,
    description: `要展示的图片路径（1-${MAX_IMAGES} 张）。多张相关图片应在一次调用里全部传入，而不是反复调用`,
  }),
})

/**
 * 内置 show_image 工具：把一组图片显示到桌面端对话区。
 * 图片只走 details（UI 渲染 + jsonl 持久化），不进模型上下文 ——
 * 模型要看图内容应使用 read 工具。
 */
export function makeShowImageTool() {
  return {
    name: 'show_image',
    label: 'Show Image',
    description:
      '把图片文件展示给用户看。只在用户明确要求看图、或确有必要展示视觉内容（如你刚生成的截图/图表）时调用。' +
      '多张相关图片请在一次调用的 paths 里全部传入，不要反复调用。图片只展示给用户，不会进入你的上下文 —— 你自己要看图内容请用 read 工具。',
    promptSnippet: 'show_image({paths})',
    parameters: showImageParams,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const images: Array<{ data: string; mimeType: string }> = []
      for (const rawPath of params.paths) {
        const resolved = resolveShowImagePath(rawPath, ctx.cwd)
        const mimeType = MIME_BY_EXT[extname(resolved).toLowerCase()]
        if (!mimeType) {
          throw new Error(`show_image: 不支持的图片类型 "${rawPath}"（支持 png/jpg/jpeg/gif/webp/bmp）`)
        }
        const info = await stat(resolved).catch(() => {
          throw new Error(`show_image: 文件不存在: ${resolved}`)
        })
        if (!info.isFile()) throw new Error(`show_image: 不是文件: ${resolved}`)
        if (info.size > MAX_BYTES) {
          throw new Error(`show_image: 图片过大（${Math.ceil(info.size / 1024 / 1024)}MB > 10MB 限制）: ${rawPath}`)
        }
        images.push({ data: (await readFile(resolved)).toString('base64'), mimeType })
      }
      const count = images.length
      return {
        content: [
          {
            type: 'text',
            text:
              count === 1
                ? `已向用户展示图片: ${params.paths[0]}`
                : `已向用户展示 ${count} 张图片: ${params.paths.join(', ')}`,
          },
        ],
        // details 是 UI 数据源，模型不可见；瘦身层（event-slim）会保留 details
        details: { paths: [...params.paths], images },
      }
    },
  }
}
