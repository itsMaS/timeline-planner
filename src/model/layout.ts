import type { Camera, Filters, Item, Project } from './types'
import { attachmentsFor, effectiveValue, formatValue } from './fields'
import { matchesRule } from './scope'
import { clamp, lerp } from './util'

export interface PlacedItem {
  item: Item
  x: number // screen px of item.pos
  /** y of the node itself (relative to the spine); the stem runs from here to the spine. */
  ny: number
  w: number // total card width (span bar or icon+label)
  row: number // 0 = closest to the line, stacking upward; negative rows stack below it
  labelShown: boolean
  ghost: boolean
  spanW: number // pixel width of the duration bar (0 for points)
  size: number // visual scale from the item's layer (1 = normal)
}

/** An item minimized to a dot on the spine (its layer's minZoom is above the camera zoom). */
export interface LayerDot {
  item: Item
  x: number
  color: string
  ghost: boolean
}

export interface Cluster {
  key: string
  x: number
  count: number
  color: string
  ids: string[]
}

export interface LayoutResult {
  placed: PlacedItem[]
  dots: LayerDot[]
  clusters: Cluster[]
  shownCount: number
  totalCount: number
}

/**
 * Derive each section's depth from geometric containment: a section nests one
 * level under every strictly larger section that fully encloses it, so the
 * hierarchy follows the actual bounds and updates as edges are dragged.
 */
export function refreshSectionDepths(p: Project) {
  const eps = 1e-9
  for (const s of p.sections) {
    let depth = 0
    for (const t of p.sections) {
      if (t === s) continue
      const larger = t.end - t.start > s.end - s.start + eps
      if (larger && t.start <= s.start + eps && t.end >= s.end - eps) depth++
    }
    s.depth = depth
  }
}

export function layerIndexOf(p: Project, it: Item): number {
  const layerId = it.layerId ?? p.types.find(t => t.id === it.typeId)?.defaultLayerId ?? null
  const idx = p.layers.findIndex(l => l.id === layerId)
  return idx < 0 ? p.layers.length : idx
}

export function typeOf(p: Project, it: Item) {
  return p.types.find(t => t.id === it.typeId) ?? p.types[0]
}

export function itemMatchesFilters(p: Project, it: Item, f: Filters): boolean {
  if (f.offTypes.includes(it.typeId)) return false
  const layerId = it.layerId ?? typeOf(p, it)?.defaultLayerId ?? null
  if (layerId && f.offLayers.includes(layerId)) return false
  if (f.tags.length && !f.tags.some(t => it.tags.includes(t))) return false
  if (f.text.trim()) {
    const q = f.text.trim().toLowerCase()
    const extra = Object.values(it.fieldValues ?? {}).filter(v => typeof v === 'string' || typeof v === 'number').join(' ')
    const hay = `${it.title} ${it.description} ${it.tags.join(' ')} ${extra}`.toLowerCase()
    if (!hay.includes(q)) return false
  }
  if (f.rules?.trim() && !matchesRule(p, { kind: 'item', entity: it }, f.rules)) return false
  return true
}

const LABEL_MAX = 200
/** Labels get more room when custom fields ride along after the title. */
const LABEL_MAX_FIELDS = 360
const FIELD_SEP = ' · '

export function labelWidth(title: string, max = LABEL_MAX): number {
  return Math.min(title.length * 6.6, max)
}

/** Title truncated to the width labelWidth actually reserves, so long labels
 *  can't overflow their slot and run into neighboring items. */
export function displayLabel(title: string, max = LABEL_MAX): string {
  if (title.length * 6.6 <= max) return title
  return title.slice(0, Math.floor(max / 6.6) - 1) + '…'
}

/**
 * "Name: value · Name: value" for every custom field the item has filled in
 * (just "value" for fields that hide their name).
 */
export function itemFieldText(p: Project, it: Item): string {
  return attachmentsFor(p, { kind: 'item', entity: it })
    .map(({ att, field }) => ({ field, v: formatValue(p, field, effectiveValue(field, att, it.fieldValues[field.id])) }))
    .filter(x => x.v.trim())
    .map(x => (x.field.showName ? `${x.field.name}: ${x.v}` : x.v))
    .join(FIELD_SEP)
}

/**
 * Full text an item's label occupies on the canvas: the title (unless titles
 * are hidden), then the fields when shown. Empty when both are off.
 */
function itemLabel(p: Project, it: Item, showFields: boolean, showTitles = true): { text: string; max: number } {
  const title = showTitles ? it.title || '…' : ''
  const fields = showFields ? itemFieldText(p, it) : ''
  if (!fields) return { text: title, max: LABEL_MAX }
  return { text: title ? title + FIELD_SEP + fields : fields, max: LABEL_MAX_FIELDS }
}

/**
 * Label split into its title and (muted) fields part, truncated as a whole so
 * it never exceeds the slot the layout reserved for it.
 */
export function splitLabel(p: Project, it: Item, showFields: boolean, showTitles = true): { title: string; fields: string } {
  const { text, max } = itemLabel(p, it, showFields, showTitles)
  const shown = displayLabel(text, max)
  if (!showTitles) return { title: '', fields: shown }
  const title = it.title || '…'
  if (!showFields || shown.length <= title.length + FIELD_SEP.length) return { title: shown, fields: '' }
  return { title, fields: shown.slice(title.length + FIELD_SEP.length) }
}

const ICON_W = 30
export const ROW_H = 46
export const ROW0_Y = -52 // y of row 0 relative to the spine

/**
 * Y of the spine within a canvas of height `h`. With markers on both sides
 * the line sits a little above centre; with markers only above it drops to
 * ~76% so the rows get the space that would otherwise sit empty below, while
 * keeping room under the line for the ruler, base dots and status bar.
 */
export function spineYFor(p: Project, h: number): number {
  if (p.settings.placement === 'both') return Math.round(h * 0.42)
  return Math.round(Math.max(h * 0.42, Math.min(h * 0.76, h - 90)))
}

/**
 * Y of a row relative to the spine. Rows >= 0 stack upward above the spine;
 * negative rows (-1, -2, …) stack downward below it.
 */
export function rowY(row: number): number {
  return row >= 0 ? ROW0_Y - row * ROW_H : -ROW0_Y - (row + 1) * ROW_H
}

interface Interval { a: number; b: number }

function fits(rows: Map<number, Interval[]>, row: number, a: number, b: number): boolean {
  const list = rows.get(row)
  if (!list) return true
  for (const iv of list) if (a < iv.b && b > iv.a) return false
  return true
}

function occupy(rows: Map<number, Interval[]>, row: number, a: number, b: number) {
  const list = rows.get(row)
  if (list) list.push({ a, b })
  else rows.set(row, [{ a, b }])
}

/**
 * Density-driven layout: items compete for rows by significance; those that
 * lose collapse into clusters. `sticky` is the set of item ids visible on the
 * previous pass — they get a priority bonus (hysteresis, no flicker).
 */
export function layoutTimeline(
  p: Project,
  cam: Camera,
  width: number,
  filters: Filters,
  density: number,
  ghostHidden: boolean,
  sticky: Set<string>,
  forced: Set<string> = new Set(),
  placement: 'above' | 'both' = 'above',
  /** Hard cap on rows above the spine so items never reach the section header bars. */
  maxUpRows = Infinity,
  /** Reserve label room for custom field values shown after the title. */
  showFields = false,
  /** Titles hidden: labels hold only the fields (or nothing), so items pack tighter. */
  showTitles = true,
): LayoutResult {
  const toX = (pos: number) => (pos - cam.x) * cam.s
  const margin = 220
  const minGap = lerp(46, 10, density)
  const maxRows = Math.round(lerp(3, 7, density))

  const eyeHidden = new Set(p.layers.filter(l => l.eye).map(l => l.id))
  const pinned = new Set(p.layers.filter(l => l.pin).map(l => l.id))

  type Cand = { it: Item; li: number; ghost: boolean; pin: boolean; size: number }
  const dots: LayerDot[] = []
  const placed: PlacedItem[] = []
  const clusters: Cluster[] = []
  let totalCount = 0

  /** Visibility / layer / filter sieve. */
  const consider = (it: Item, x: number, xEnd: number): Cand | null => {
    if (xEnd < -margin || x > width + margin) return null
    const layerId = it.layerId ?? typeOf(p, it)?.defaultLayerId ?? null
    if (layerId && eyeHidden.has(layerId)) return null
    totalCount++
    const ghost = !itemMatchesFilters(p, it, filters)
    if (ghost && ghostHidden) return null
    const layer = layerId ? p.layers.find(l => l.id === layerId) : undefined
    // Zoomed out past the layer's minZoom → the item collapses to a dot on the
    // line. Selected (forced) items stay full-size so they remain editable.
    if (layer && (layer.minZoom ?? 0) > 0 && cam.s < layer.minZoom && !forced.has(it.id)) {
      dots.push({ item: it, x, color: typeOf(p, it)?.color ?? '#888', ghost })
      return null
    }
    return {
      it, li: layerIndexOf(p, it), ghost,
      pin: (!!layerId && pinned.has(layerId)) || forced.has(it.id),
      size: layer?.size ?? 1,
    }
  }

  const spineCands: Cand[] = []
  for (const it of p.items) {
    const c = consider(it, toX(it.pos), toX(it.pos + it.duration))
    if (c) spineCands.push(c)
  }

  // Priority: pinned first, then real items by layer significance (sticky bonus), ghosts last.
  const byPriority = (a: Cand, b: Cand) => {
    const pa = (a.ghost ? 100 : 0) + (a.pin ? -50 : 0) + a.li - (sticky.has(a.it.id) ? 0.6 : 0)
    const pb = (b.ghost ? 100 : 0) + (b.pin ? -50 : 0) + b.li - (sticky.has(b.it.id) ? 0.6 : 0)
    return pa - pb || a.it.pos - b.it.pos
  }

  /**
   * Greedy row packing along the spine. Items that fit nowhere (and aren't
   * ghosts) come back as overflow for clustering.
   */
  const packLine = (
    cands: Cand[],
    rows: Map<number, Interval[]>,
    candidateRows: (cap: number) => number[],
    xOf: (it: Item) => number,
  ): Item[] => {
    const overflow: Item[] = []
    cands.sort(byPriority)
    for (const { it, ghost, pin, size } of cands) {
      const x = xOf(it)
      const spanW = it.duration > 0 ? Math.max(it.duration * cam.s, 10) : 0
      const rowCap = pin ? maxRows + 4 : maxRows
      const iconW = ICON_W * size
      const tryPlace = (withLabel: boolean): PlacedItem | null => {
        const lbl = itemLabel(p, it, showFields, showTitles)
        const lw = withLabel && lbl.text ? (labelWidth(lbl.text, lbl.max) + 8) * size : 0
        const w = Math.max(iconW + lw, spanW)
        const a = x - iconW / 2 - minGap / 2
        const b = x - iconW / 2 + w + minGap / 2
        for (const r of candidateRows(rowCap)) {
          if (fits(rows, r, a, b)) {
            occupy(rows, r, a, b)
            return { item: it, x, ny: rowY(r), w, row: r, labelShown: withLabel && !!lbl.text, ghost, spanW, size }
          }
        }
        return null
      }
      const pl = tryPlace(true) ?? tryPlace(false)
      if (pl) placed.push(pl)
      else if (!ghost) overflow.push(it)
    }
    return overflow
  }

  /** Cluster overflow items by screen proximity along the spine. */
  const clusterize = (overflow: Item[], xOf: (it: Item) => number) => {
    overflow.sort((a, b) => a.pos - b.pos)
    let n = 0
    for (const it of overflow) {
      const x = xOf(it)
      const last = clusters[clusters.length - 1]
      if (last && Math.abs(x - last.x) < 36) {
        last.count++
        last.ids.push(it.id)
        last.x = last.x + (x - last.x) / last.count
      } else {
        clusters.push({ key: `c${n++}:${it.id}`, x, count: 1, color: typeOf(p, it)?.color ?? '#888', ids: [it.id] })
      }
    }
    // Single-item "clusters" render as tiny dots; that's fine.
  }

  const rows = new Map<number, Interval[]>()

  // Candidate rows in preference order: 0, -1, 1, -2, … when both sides are
  // allowed (alternating keeps the timeline vertically balanced).
  const candidateRows = (cap: number): number[] => {
    const out: number[] = []
    for (let r = 0; r < cap; r++) {
      if (r < maxUpRows) out.push(r)
      if (placement === 'both') out.push(-(r + 1))
    }
    return out
  }
  const spineX = (it: Item) => toX(it.pos)
  clusterize(packLine(spineCands, rows, candidateRows, spineX), spineX)

  // Stable render order: keyed siblings must never reorder between layout
  // passes, or React moves their DOM nodes and every CSS enter-animation
  // (the pop tween) restarts on items that were already on screen.
  placed.sort((a, b) => (a.item.id < b.item.id ? -1 : 1))
  dots.sort((a, b) => (a.item.id < b.item.id ? -1 : 1))

  const shownCount = placed.filter(pl => !pl.ghost).length + dots.filter(d => !d.ghost).length

  return { placed, dots, clusters, shownCount, totalCount }
}

/** World extent of all content, padded. */
export function contentExtent(p: Project): { min: number; max: number } {
  let min = Infinity
  let max = -Infinity
  for (const it of p.items) { min = Math.min(min, it.pos); max = Math.max(max, it.pos + it.duration) }
  for (const sc of p.sections) { min = Math.min(min, sc.start); max = Math.max(max, sc.end) }
  if (!isFinite(min)) { min = 0; max = 100 }
  if (max - min < 10) max = min + 10
  const pad = (max - min) * 0.06
  return { min: min - pad, max: max + pad }
}

/**
 * Lowest allowed camera zoom for a project: far enough out that the whole
 * content span fits in half the viewport, whatever scale the project works at,
 * with an absolute floor. Never above the regular zoom-out limit.
 */
export function minZoomFor(p: Project, width: number): number {
  const { min, max } = contentExtent(p)
  return clamp((width * 0.5) / (max - min), 0.0005, 0.4)
}

export function fitCamera(p: Project, width: number): Camera {
  const { min, max } = contentExtent(p)
  const s = clamp(width / (max - min), 0.0005, 600)
  return { x: min, s }
}
