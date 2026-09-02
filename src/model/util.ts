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

/** Smallest world step whose labels stay at least ~90px apart at the given scale. */
export function rulerStepFor(s: number): number {
  for (const st of RULER_STEPS) if (st * s >= 90) return st
  return RULER_STEPS[RULER_STEPS.length - 1]
}

const UNIT_SUFFIX: Record<string, string> = {
  none: '', minutes: 'min', hours: 'h', days: 'd', weeks: 'w', months: 'mo', years: 'y',
}

export function unitSuffix(preset: string, custom: string): string {
  return preset === 'custom' ? custom.trim() : (UNIT_SUFFIX[preset] ?? '')
}

/** Tick label for a ruler value, e.g. "12.5 d" or "40". */
export function formatUnit(v: number, step: number, suffix: string): string {
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
