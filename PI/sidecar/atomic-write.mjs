// Windows 原子写（2-13，思路移植自 pi-agent-desktop lib/atomic-write.ts）
//
// 问题：并发读 + 写在同一文件上时，Windows 的 rename/unlink 可能抛 EPERM 或 EACCES
// （pi-agent-desktop issue #33："另一个终端同时跑 Pi 导致桌面白屏"）。
// 直接 writeFile 则可能被并发读者看到半截内容。
//
// 方案：先写临时文件（同目录，保证同盘原子 rename），再 rename 到目标；
// Windows 上 rename 撞上并发句柄时按 25ms 间隔重试（最多 ~2.5s），最后兜底直接写。
// 所有配置类写入（models.json/auth.json/settings.json/archived-sessions.json）都应走这里。
import { rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

const EPERM_RETRIES = 100
const RETRY_DELAY_MS = 25

// 测试钩子：注入"前 N 次 rename 抛 EPERM"，让重试路径真实可测。
// 生产代码路径完全不读这个变量。
let testInjectedFailures = 0
export const __test = {
  forceRetryableFailures(count) { testInjectedFailures = count },
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function isRetryableWindowsError(error) {
  return (
    process.platform === 'win32' &&
    error &&
    typeof error.code === 'string' &&
    ['EPERM', 'EACCES'].includes(error.code)
  )
}

/**
 * 原子写文本：写同目录临时文件 → rename 到目标。
 * Windows rename 撞并发句柄时重试（EPERM/EACCES，100 × 25ms ≈ 2.5s）。
 */
export async function atomicWriteText(file, content) {
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`,
  )
  await writeFile(temp, content, 'utf8')
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        if (testInjectedFailures > 0) {
          testInjectedFailures--
          const error = new Error('模拟并发句柄占用')
          error.code = 'EPERM'
          throw error
        }
        await rename(temp, file)
        return
      } catch (error) {
        if (isRetryableWindowsError(error) && attempt < EPERM_RETRIES) {
          await sleep(RETRY_DELAY_MS)
          continue
        }
        throw error
      }
    }
  } catch (error) {
    // 兜底：rename 失败（跨盘/权限异常）时直接写目标，保证数据不丢
    await writeFile(file, content, 'utf8').catch(() => {
      throw error
    })
  }
}

/** 便捷包装：JSON.stringify(obj, null, 2) + 尾换行后原子写。 */
export async function atomicWriteJson(file, value) {
  return atomicWriteText(file, `${JSON.stringify(value, null, 2)}\n`)
}
