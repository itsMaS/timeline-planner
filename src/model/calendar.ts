/**
 * Calendar dates: the 'calendar' unit preset. One world unit is one day and
 * position 0 is the timeline's base date (`settings.unit.baseDate`,
 * YYYY-MM-DD), so a position reads as a real date. All maths runs in UTC so
 * days are always 24 h long and every collaborator sees the same dates.
 *
 * The ruler picks its unit from the zoom (hours → days → half months →
 * months → years → decades → centuries) and puts ticks on real calendar
 * boundaries (the 1st of a month, 1 January), not on multiples of 30 days.
 *
 * Pure helpers only: the store, the canvas, exports and the agent CLI use it.
 */

const DAY_MS = 86400000
const HOUR_MS = 3600000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Base date used when a calendar timeline has none (only ever set by hand-edited docs). */
const FALLBACK_BASE = '2000-01-01'

/** UTC midnight of a calendar date; works for years below 100 and BC years too. */
function utc(y: number, m: number, d = 1): number {
  y += Math.floor(m / 12)
  m -= Math.floor(m / 12) * 12
  const t = new Date(Date.UTC(2000, m, d))
  t.setUTCFullYear(y)
  return t.getTime()
}

/** Today's local date as YYYY-MM-DD (what "today" means to the person looking). */
export function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Parse YYYY-MM-DD to UTC midnight; null when it is not a date. */
export function parseISODate(iso: string): number | null {
  const m = /^(-?\d{1,6})-(\d{1,2})-(\d{1,2})$/.exec(iso.trim())
  if (!m) return null
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3])
  if (mo < 0 || mo > 11 || d < 1 || d > 31) return null
  return utc(y, mo, d)
}

/** UTC ms of position 0 for a base date. */
export function baseMs(baseDate: string): number {
  return parseISODate(baseDate) ?? (parseISODate(FALLBACK_BASE) as number)
}

export const posToMs = (pos: number, baseDate: string) => baseMs(baseDate) + pos * DAY_MS
export const msToPos = (ms: number, baseDate: string) => (ms - baseMs(baseDate)) / DAY_MS

/** Whole days between two base dates (b − a), for re-anchoring a timeline. */
export function daysBetween(a: string, b: string): number {
  return Math.round((baseMs(b) - baseMs(a)) / DAY_MS)
}

/** YYYY-MM-DD of the day a position falls on. */
export function isoOfPos(pos: number, baseDate: string): string {
  const d = new Date(Math.floor(posToMs(pos, baseDate) / DAY_MS) * DAY_MS)
  const y = d.getUTCFullYear()
  const ys = y < 0 ? '-' + String(-y).padStart(4, '0') : String(y).padStart(4, '0')
  return `${ys}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

/** Position of a YYYY-MM-DD date, null when it is not a date. */
export function posOfISO(iso: string, baseDate: string): number | null {
  const ms = parseISODate(iso)
  return ms === null ? null : msToPos(ms, baseDate)
}

/** Position of today's date. */
export const todayPos = (baseDate: string) => posOfISO(todayISO(), baseDate) as number

const yearLabel = (y: number) => (y <= 0 ? `${1 - y} BC` : String(y))
const hhmm = (d: Date) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`

/** "12 Mar 2024", with the time of day ("12 Mar 2024 14:30") when the position is not on midnight. */
export function formatDate(pos: number, baseDate: string): string {
  const ms = posToMs(pos, baseDate)
  // Round to the minute so float noise never prints "23:59".
  const d = new Date(Math.round(ms / 60000) * 60000)
  const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${yearLabel(d.getUTCFullYear())}`
  return d.getUTCHours() || d.getUTCMinutes() ? `${day} ${hhmm(d)}` : day
}

// ---- ruler ------------------------------------------------------------------

type StepKind = 'hour' | 'day' | 'half' | 'month' | 'year'
interface Step { kind: StepKind; n: number; days: number }

/** Ruler steps from fine to coarse; `days` is the typical width used to pick one. */
const STEPS: Step[] = [
  ...[1, 3, 6, 12].map(n => ({ kind: 'hour' as const, n, days: n / 24 })),
  ...[1, 2].map(n => ({ kind: 'day' as const, n, days: n })),
  { kind: 'half', n: 1, days: 15.2 },
  ...[1, 3, 6].map(n => ({ kind: 'month' as const, n, days: n * 30.44 })),
  ...[1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000].map(n => ({ kind: 'year' as const, n, days: n * 365.25 })),
]

function stepFor(s: number, minPx: number): Step {
  return STEPS.find(st => st.days * s >= minPx) ?? STEPS[STEPS.length - 1]
}

export interface Tick { pos: number; label: string }

/**
 * Ruler ticks between positions x0 and x1 at zoom s (px per day), at least
 * ~90px apart, on calendar boundaries. Labels carry just enough context:
 * months show the year in January and on the first tick in view, days show
 * the year on 1 January and on the first tick.
 */
export function calendarTicks(x0: number, x1: number, s: number, baseDate: string): Tick[] {
  const step = stepFor(s, 90)
  const b = baseMs(baseDate)
  const m0 = b + x0 * DAY_MS
  const m1 = b + x1 * DAY_MS
  const out: Tick[] = []
  let first = true
  const push = (ms: number, label: (d: Date, full: boolean) => string) => {
    const pos = (ms - b) / DAY_MS
    // The first tick at or right of the left edge carries the full context.
    const full = first && pos >= x0
    if (full) first = false
    out.push({ pos, label: label(new Date(ms), full) })
  }
  const dayLabel = (d: Date, full: boolean) => {
    const yearStart = d.getUTCMonth() === 0 && d.getUTCDate() === 1
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${full || yearStart ? ' ' + yearLabel(d.getUTCFullYear()) : ''}`
  }
  const limit = 400
  switch (step.kind) {
    case 'hour': {
      const w = step.n * HOUR_MS
      for (let t = Math.floor(m0 / w) * w; t <= m1 && out.length < limit; t += w) {
        push(t, (d, full) => (d.getUTCHours() === 0 || full ? `${dayLabel(d, full)}${d.getUTCHours() ? ' ' + hhmm(d) : ''}` : hhmm(d)))
      }
      break
    }
    case 'day': {
      const w = step.n * DAY_MS
      for (let t = Math.floor(m0 / w) * w; t <= m1 && out.length < limit; t += w) push(t, dayLabel)
      break
    }
    case 'half': {
      const d0 = new Date(m0)
      for (let y = d0.getUTCFullYear(), mo = d0.getUTCMonth(); out.length < limit; mo++) {
        const a = utc(y, mo, 1)
        if (a > m1) break
        if (a >= m0 - 16 * DAY_MS) push(a, dayLabel)
        const h = utc(y, mo, 16)
        if (h > m1) break
        if (h >= m0 - 16 * DAY_MS) push(h, dayLabel)
      }
      break
    }
    case 'month': {
      const d0 = new Date(m0)
      let mi = Math.floor((d0.getUTCFullYear() * 12 + d0.getUTCMonth()) / step.n) * step.n
      for (; out.length < limit; mi += step.n) {
        const y = Math.floor(mi / 12), mo = mi - y * 12
        const t = utc(y, mo, 1)
        if (t > m1) break
        push(t, (d, full) => (d.getUTCMonth() === 0 || full ? `${MONTHS[d.getUTCMonth()]} ${yearLabel(d.getUTCFullYear())}` : MONTHS[d.getUTCMonth()]))
      }
      break
    }
    case 'year': {
      let y = Math.floor(new Date(m0).getUTCFullYear() / step.n) * step.n
      for (; out.length < limit; y += step.n) {
        const t = utc(y, 0, 1)
        if (t > m1) break
        push(t, d => yearLabel(d.getUTCFullYear()))
      }
      break
    }
  }
  return out
}

/** Nearest calendar boundary (hour, day, month start, year start, decade) that spans ~18px at zoom s. */
export function calendarSnap(pos: number, s: number, baseDate: string): number {
  const step = stepFor(s, 18)
  const b = baseMs(baseDate)
  const ms = b + pos * DAY_MS
  const nearest = (a: number, c: number) => (ms - a <= c - ms ? a : c)
  let t: number
  if (step.kind === 'hour' || step.kind === 'day') {
    const w = step.kind === 'hour' ? step.n * HOUR_MS : step.n * DAY_MS
    t = Math.round(ms / w) * w
  } else {
    const d = new Date(ms)
    const y = d.getUTCFullYear(), mo = d.getUTCMonth()
    if (step.kind === 'half') {
      const cands = [utc(y, mo, 1), utc(y, mo, 16), utc(y, mo + 1, 1)]
      t = cands.reduce((best, c) => (Math.abs(c - ms) < Math.abs(best - ms) ? c : best))
    } else if (step.kind === 'month') {
      const mi = Math.floor((y * 12 + mo) / step.n) * step.n
      const yy = Math.floor(mi / 12)
      t = nearest(utc(yy, mi - yy * 12, 1), utc(yy, mi - yy * 12 + step.n, 1))
    } else {
      const yy = Math.floor(y / step.n) * step.n
      t = nearest(utc(yy, 0, 1), utc(yy + step.n, 0, 1))
    }
  }
  return (t - b) / DAY_MS
}
