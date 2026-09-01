import type { Camera } from '../model/types'

export const reducedMotion = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

let flight: number | null = null

/** Smooth camera flight with a slight zoom-out "arc" on long jumps. */
export function flyCamera(
  from: Camera,
  to: Camera,
  onFrame: (cam: Camera) => void,
  onDone?: () => void,
  animate = true,
) {
  if (flight) cancelAnimationFrame(flight)
  if (!animate || reducedMotion()) {
    onFrame(to)
    onDone?.()
    return
  }
  const t0 = performance.now()
  const dur = 420
  const l0 = Math.log(from.s)
  const l1 = Math.log(to.s)
  // Horizontal distance in screens decides how much we arc outward.
  const midS = Math.min(from.s, to.s)
  const distPx = Math.abs((to.x - from.x)) * midS
  const arc = Math.min(0.9, distPx / 4000)
  const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
  const step = (now: number) => {
    const t = Math.min(1, (now - t0) / dur)
    const e = ease(t)
    const ls = l0 + (l1 - l0) * e - Math.sin(Math.PI * t) * arc
    const s = Math.exp(ls)
    // Interpolate the world coordinate of the viewport center.
    // Callers pass x as "world at left edge" for a fixed width; interpolate x directly (visually fine).
    const x = from.x + (to.x - from.x) * e
    onFrame({ x, s })
    if (t < 1) flight = requestAnimationFrame(step)
    else { flight = null; onDone?.() }
  }
  flight = requestAnimationFrame(step)
}

export function cancelFlight() {
  if (flight) cancelAnimationFrame(flight)
  flight = null
}
