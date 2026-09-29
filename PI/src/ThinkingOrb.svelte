<script lang="ts">
  // U2：液态思考球 —— 用正弦扰动的有机斑点模拟"思考中"的液态流动。
  // 与 Atom（3D 电子轨道）形成两种可选风格；偏好存 prefs.thinkingOrb。
  import { onDestroy, onMount } from 'svelte'

  export let size = 56

  let canvas: HTMLCanvasElement
  let raf = 0

  // 主色随皮肤走，深色皮肤下保持可见
  let base = '#8a8a8a'
  let accent = '#c9c9c9'
  let glow = '#ffffff'

  function readColors() {
    const cs = getComputedStyle(document.documentElement)
    const read = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback
    base = read('--accent', '#8a8a8a')
    accent = read('--text-2', '#c9c9c9')
    glow = read('--text', '#ffffff')
  }

  // 5 组谐波扰动：让轮廓像液体一样缓慢起伏（不同频率/相位/方向）
  const WAVES = [
    { freq: 2.1, amp: 0.06, speed: 0.9, phase: 0.0 },
    { freq: 3.3, amp: 0.045, speed: -1.3, phase: 1.7 },
    { freq: 4.7, amp: 0.03, speed: 0.7, phase: 2.9 },
    { freq: 6.1, amp: 0.02, speed: -0.55, phase: 4.1 },
    { freq: 8.3, amp: 0.012, speed: 1.7, phase: 5.3 },
  ]

  function draw(ctx: CanvasRenderingContext2D, s: number, t: number) {
    const cx = s / 2
    const cy = s / 2
    const radius = s * 0.32
    ctx.clearRect(0, 0, s, s)

    // 外圈柔光
    const glowGrad = ctx.createRadialGradient(cx, cy, radius * 0.4, cx, cy, radius * 1.7)
    glowGrad.addColorStop(0, `${glow}14`)
    glowGrad.addColorStop(1, `${glow}00`)
    ctx.fillStyle = glowGrad
    ctx.fillRect(0, 0, s, s)

    // 液态轮廓：极坐标采样，半径随谐波扰动
    ctx.beginPath()
    const STEPS = 64
    for (let i = 0; i <= STEPS; i++) {
      const angle = (i / STEPS) * Math.PI * 2
      let r = radius
      for (const wave of WAVES) {
        r += Math.sin(angle * wave.freq + t * wave.speed + wave.phase) * radius * wave.amp
      }
      const x = cx + Math.cos(angle) * r
      const y = cy + Math.sin(angle) * r * 0.94
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.closePath()

    // 内部渐变：液体质感
    const bodyGrad = ctx.createRadialGradient(
      cx - radius * 0.35, cy - radius * 0.4, radius * 0.1,
      cx, cy, radius * 1.25,
    )
    bodyGrad.addColorStop(0, accent)
    bodyGrad.addColorStop(0.55, base)
    bodyGrad.addColorStop(1, `${base}cc`)
    ctx.fillStyle = bodyGrad
    ctx.fill()

    // 高光：随流动缓慢移动的"液面反光"
    const hx = cx + Math.cos(t * 0.7) * radius * 0.3
    const hy = cy - radius * 0.35 + Math.sin(t * 1.1) * radius * 0.1
    const hi = ctx.createRadialGradient(hx, hy, 0, hx, hy, radius * 0.5)
    hi.addColorStop(0, `${glow}55`)
    hi.addColorStop(1, `${glow}00`)
    ctx.fillStyle = hi
    ctx.fill()

    // 内部悬浮小气泡（思考"翻涌"的隐喻）
    for (let i = 0; i < 3; i++) {
      const bubblePhase = t * (0.5 + i * 0.23) + i * 2.4
      const bx = cx + Math.sin(bubblePhase) * radius * 0.32
      const by = cy + Math.cos(bubblePhase * 0.8 + i) * radius * 0.3
      const br = radius * (0.07 + 0.03 * Math.sin(t * 1.3 + i))
      ctx.beginPath()
      ctx.arc(bx, by, br, 0, Math.PI * 2)
      ctx.fillStyle = `${glow}33`
      ctx.fill()
    }
  }

  onMount(() => {
    readColors()
    const ctx2d = canvas.getContext('2d')
    if (!ctx2d) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = size * dpr
    canvas.height = size * dpr
    ctx2d.scale(dpr, dpr)
    const start = performance.now()
    // 审查 P3-3：页面不可见时暂停 rAF（浏览器对隐藏页面本就暂停 rAF，
    // 但显式守卫覆盖"可见性恢复前的最后一帧"与未来宿主差异，零成本）。
    let paused = document.hidden
    const onVisibility = () => {
      paused = document.hidden
      if (!paused && !raf) raf = requestAnimationFrame(loop)
    }
    document.addEventListener('visibilitychange', onVisibility)
    const loop = (now: number) => {
      if (paused) { raf = 0; return }
      draw(ctx2d, size, (now - start) / 1000)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    onDestroyCleanup = () => document.removeEventListener('visibilitychange', onVisibility)
  })

  let onDestroyCleanup: () => void = () => {}

  onDestroy(() => {
    cancelAnimationFrame(raf)
    onDestroyCleanup()
  })
</script>

<canvas bind:this={canvas} style={`width:${size}px;height:${size}px`} aria-hidden="true"></canvas>
