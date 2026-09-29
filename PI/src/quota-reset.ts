// Provider 额度摘要（2-8 / U4 收尾）
//
// 需求（用户原话）："查看会话 Token、缓存用量、上下文容量及支持的 provider 额度和重置时间"。
// - Token/缓存/容量：get_state 已覆盖（session-state.ts）
// - 额度：config.runProbe 按模板拉取（OpenRouter limit_remaining / Moonshot balance / 自定义）
// - 重置时间：多数网关不提供；这里提供**周期估算**——由用户配置的重置周期
//   （monthly/weekly/daily，缺省 monthly，锚点=当月 1 日）计算"距下次重置"。
//   有真实 reset 字段的接口直接透传。
//
// 纯函数模块：时间计算可单测，不碰网络。

export type ResetCycle = 'daily' | 'weekly' | 'monthly' | 'none'

export interface ProviderQuota {
  provider: string
  /** runProbe/余额查询的文本结果（可能为 "$12.34" 或 "额度 80%"） */
  message?: string
  value?: unknown
  supported?: boolean
  ok?: boolean
  /** 真实重置信息（接口提供时） */
  resetAt?: string | number | null
  /** 用户配置的周期（无真实字段时用于估算） */
  cycle?: ResetCycle
}

export interface QuotaWithReset extends ProviderQuota {
  /** 下次重置时间（ISO 或时间戳）；无周期配置时为 null */
  nextResetAt: string | null
  /** 距下次重置的毫秒数；null = 未知 */
  msUntilReset: number | null
  /** 本周期已流逝百分比（0-100）；null = 未知 */
  cycleElapsedPercent: number | null
}

const MS_DAY = 24 * 60 * 60 * 1000

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/**
 * 计算给定周期的下一次重置时间。
 * - daily：明天 00:00（本地时区）
 * - weekly：下周一 00:00
 * - monthly：下月 1 日 00:00
 * - none/未知：null
 */
export function nextResetFor(cycle: ResetCycle | undefined, now: Date = new Date()): Date | null {
  const base = startOfDay(now)
  switch (cycle) {
    case 'daily':
      return new Date(base.getTime() + MS_DAY)
    case 'weekly': {
      // getDay(): 0=周日 … 6=周六；下周一 = 今天 + (8 - day) % 7 || 7 天
      const day = base.getDay()
      const days = day === 1 ? 7 : (8 - day) % 7
      return new Date(base.getTime() + days * MS_DAY)
    }
    case 'monthly': {
      return new Date(base.getFullYear(), base.getMonth() + 1, 1)
    }
    default:
      return null
  }
}

/** 估算字段一次性算好（面板直接渲染）。 */
export function withResetEstimate(quota: ProviderQuota, now: Date = new Date()): QuotaWithReset {
  // 优先透传接口真实字段
  const rawReset = quota.resetAt
  let next: Date | null = null
  let fromRealField = false
  if (rawReset !== undefined && rawReset !== null && rawReset !== '') {
    const parsed = typeof rawReset === 'number' ? new Date(rawReset) : new Date(String(rawReset))
    if (!Number.isNaN(parsed.getTime())) {
      next = parsed
      fromRealField = true
    }
  }
  if (!next) next = nextResetFor(quota.cycle, now)

  if (!next) {
    return { ...quota, nextResetAt: null, msUntilReset: null, cycleElapsedPercent: null }
  }
  const ms = next.getTime() - now.getTime()
  // 真实字段不知道周期起点，"已流逝百分比"无从谈起 —— 诚实返回 null
  if (fromRealField) {
    return { ...quota, nextResetAt: next.toISOString(), msUntilReset: ms, cycleElapsedPercent: null }
  }
  // 周期估算：起点 = now - (next - periodLength)；百分比 = 已流逝/总长
  let periodLength: number
  switch (quota.cycle) {
    case 'daily': periodLength = MS_DAY; break
    case 'weekly': periodLength = 7 * MS_DAY; break
    case 'monthly': {
      // 当月 1 日 0 点 → 下月 1 日 0 点
      const start = new Date(now.getFullYear(), now.getMonth(), 1)
      periodLength = next.getTime() - start.getTime()
      break
    }
    default: periodLength = 0
  }
  const elapsed = periodLength > 0
    ? Math.max(0, Math.min(100, Math.round(((periodLength - ms) / periodLength) * 100)))
    : null
  return {
    ...quota,
    nextResetAt: next.toISOString(),
    msUntilReset: ms,
    cycleElapsedPercent: elapsed,
  }
}

/** 人类可读的"距重置"文案。 */
export function formatResetCountdown(ms: number | null, now: Date = new Date()): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  if (ms <= 0) return '已重置'
  const days = Math.floor(ms / MS_DAY)
  const hours = Math.floor((ms % MS_DAY) / (60 * 60 * 1000))
  if (days > 0) return `${days} 天 ${hours} 小时后`
  const minutes = Math.floor((ms % (60 * 60 * 1000)) / 60000)
  if (hours > 0) return `${hours} 小时 ${minutes} 分后`
  return `${minutes} 分钟后`
}
