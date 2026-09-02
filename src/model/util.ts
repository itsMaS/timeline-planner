export const uid = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6)

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t

const SNAP_STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100]

/** Smallest world step that spans at least ~18px at the given scale. */
export function snapStepFor(s: number): number {
  for (const st of SNAP_STEPS) if (st * s >= 18) return st
  return SNAP_STEPS[SNAP_STEPS.length - 1]
}

export function snapPos(pos: number, s: number): number {
  const st = snapStepFor(s)
  return Math.round(pos / st) * st
}

const RULER_STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]

// ---- time-aware ruler -------------------------------------------------------
// For time presets, one world unit equals this many seconds; the ruler then
// picks calendar-natural steps and renders compound labels ("3h 20m") instead
// of raw multiples of the base unit ("200 min").

const MINUTE = 60
const HOUR = 3600
const DAY = 86400
const WEEK = 604800
const MONTH = 2629800 // average month (30.4375 d); a year is exactly 12 of these
const YEAR = 31557600

const TIME_BASE: Record<string, number> = {
  minutes: MINUTE, hours: HOUR, days: DAY, weeks: WEEK, months: MONTH, years: YEAR,
}

/** Seconds per world unit for time presets, null for none/custom. */
export function timeBaseFor(preset: string): number | null {
  return TIME_BASE[preset] ?? null
}

const TIME_STEPS = [
  1, 2, 5, 10, 15, 30,
  MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE,
  HOUR, 2 * HOUR, 6 * HOUR, 12 * HOUR,
  DAY, 2 * DAY, WEEK, 2 * WEEK,
  MONTH, 3 * MONTH, 6 * MONTH,
  YEAR, 2 * YEAR, 5 * YEAR, 10 * YEAR, 25 * YEAR, 50 * YEAR, 100 * YEAR, 250 * YEAR, 1000 * YEAR,
]

/** Smallest world step whose labels stay at least ~90px apart at the given scale. */
export function rulerStepFor(s: number, preset = 'none'): number {
  const base = TIME_BASE[preset]
  if (base) {
    for (const st of TIME_STEPS) {
      const w = st / base
      if (w * s >= 90) return w
    }
    let st = TIME_STEPS[TIME_STEPS.length - 1]
    while ((st / base) * s < 90) st *= 10
    return st / base
  }
  for (const st of RULER_STEPS) if (st * s >= 90) return st
  let st = RULER_STEPS[RULER_STEPS.length - 1]
  while (st * s < 90) st *= 10
  return st
}

const UNIT_SUFFIX: Record<string, string> = {
  none: '', minutes: 'min', hours: 'h', days: 'd', weeks: 'w', months: 'mo', years: 'y',
}

export function unitSuffix(preset: string, custom: string): string {
  return preset === 'custom' ? custom.trim() : (UNIT_SUFFIX[preset] ?? '')
}

/** Compound time label, at most two components: "3h 20m", "2d", "1y 3mo", "45s". */
function formatTimeLabel(totalSeconds: number, stepSeconds: number): string {
  const neg = totalSeconds < 0
  let t = Math.round(Math.abs(totalSeconds))
  if (t === 0) return '0'
  // Months/years use an average length, so only use them when the tick step is
  // at least a month — then every value is an exact multiple. Below that the
  // exact s/m/h/d/w chain keeps labels truthful.
  const allowMonths = stepSeconds >= MONTH - 1
  const units: [string, number][] = [
    ['y', YEAR], ['mo', MONTH], ['w', WEEK], ['d', DAY], ['h', HOUR], ['m', MINUTE], ['s', 1],
  ]
  const parts: string[] = []
  for (const [name, f] of units) {
    if (!allowMonths && (name === 'y' || name === 'mo')) continue
    if (parts.length === 2) break
    const k = Math.floor(t / f)
    if (k > 0) {
      parts.push(`${k}${name}`)
      t -= k * f
    }
  }
  return (neg ? '-' : '') + (parts.join(' ') || '0')
}

/** Tick label for a ruler value: compound time for time presets, else "12.5 beats". */
export function formatUnit(v: number, step: number, suffix: string, preset = 'none'): string {
  const base = TIME_BASE[preset]
  if (base) return formatTimeLabel(v * base, step * base)
  const decimals = step < 0.1 ? 2 : step < 1 ? 1 : 0
  const n = v.toFixed(decimals).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
  return suffix ? `${n} ${suffix}` : n
}

export const PALETTE = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308',
  '#84cc16', '#22c55e', '#10b981', '#14b8a6',
  '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1',
  '#8b5cf6', '#a855f7', '#d946ef', '#ec4899',
]

/** Auto palette for section bands: muted rotation by index. */
export function sectionHue(index: number): number {
  return (index * 137.508) % 360
}

export function download(filename: string, blob: Blob) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}
