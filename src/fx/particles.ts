import { reducedMotion } from './springs'

interface Spark {
  x: number; y: number; vx: number; vy: number
  life: number; t: number; color: string; size: number; kind: 'shard' | 'ring'
  rot: number; vrot: number
}

let sparks: Spark[] = []
let canvas: HTMLCanvasElement | null = null
let ctx: CanvasRenderingContext2D | null = null
let raf: number | null = null
let level: 'off' | 'subtle' | 'full' = 'full'

export function setParticleLevel(l: 'off' | 'subtle' | 'full') { level = l }

export function bindParticleCanvas(c: HTMLCanvasElement | null) {
  canvas = c
  ctx = c ? c.getContext('2d') : null
}

function ensureLoop() {
  if (raf || !ctx || !canvas) return
  let last = performance.now()
  const tick = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    if (!ctx || !canvas) { raf = null; return }
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr)
    sparks = sparks.filter(s => (s.t += dt) < s.life)
    for (const s of sparks) {
      const k = s.t / s.life
      if (s.kind === 'ring') {
        ctx.globalAlpha = (1 - k) * 0.55
        ctx.strokeStyle = s.color
        ctx.lineWidth = 2 * (1 - k) + 0.5
        ctx.beginPath()
        ctx.arc(s.x, s.y, s.size * (0.3 + k * 1.4), 0, Math.PI * 2)
        ctx.stroke()
      } else {
        s.vy += 380 * dt
        s.x += s.vx * dt
        s.y += s.vy * dt
        s.rot += s.vrot * dt
        ctx.globalAlpha = 1 - k
        ctx.fillStyle = s.color
        ctx.save()
        ctx.translate(s.x, s.y)
        ctx.rotate(s.rot)
        const sz = s.size * (1 - k * 0.5)
        ctx.fillRect(-sz / 2, -sz / 2, sz, sz * 0.62)
        ctx.restore()
      }
    }
    ctx.globalAlpha = 1
    if (sparks.length) raf = requestAnimationFrame(tick)
    else raf = null
  }
  raf = requestAnimationFrame(tick)
}

function spawn(list: Spark[]) {
  if (level === 'off' || reducedMotion()) return
  sparks.push(...list)
  if (sparks.length > 300) sparks = sparks.slice(-300)
  ensureLoop()
}

/** Geometric shard burst (create/delete). */
export function burst(x: number, y: number, color: string, n = 9) {
  const count = level === 'subtle' ? Math.ceil(n / 2) : n
  const list: Spark[] = []
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2
    const v = 90 + Math.random() * 170
    list.push({
      x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 60,
      life: 0.45 + Math.random() * 0.3, t: 0, color,
      size: 3.5 + Math.random() * 3.5, kind: 'shard',
      rot: Math.random() * Math.PI, vrot: (Math.random() - 0.5) * 14,
    })
  }
  spawn(list)
}

/** Expanding ripple ring (click/select). */
export function ripple(x: number, y: number, color: string) {
  spawn([{ x, y, vx: 0, vy: 0, life: 0.45, t: 0, color, size: 16, kind: 'ring', rot: 0, vrot: 0 }])
}

/** Landing puff (snap/drop). */
export function puff(x: number, y: number, color: string) {
  const list: Spark[] = []
  const count = level === 'subtle' ? 3 : 6
  for (let i = 0; i < count; i++) {
    const a = Math.PI + (Math.random() - 0.5) * 1.6
    const v = 40 + Math.random() * 60
    list.push({
      x, y, vx: Math.cos(a) * v * (Math.random() > 0.5 ? -1 : 1), vy: -Math.abs(Math.sin(a)) * v,
      life: 0.35 + Math.random() * 0.2, t: 0, color, size: 2.5 + Math.random() * 2, kind: 'shard',
      rot: 0, vrot: (Math.random() - 0.5) * 8,
    })
  }
  spawn(list)
}
