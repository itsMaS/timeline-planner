import type { Branch, Camera, Filters, Item, Project } from './types'
import { clamp, lerp } from './util'

export interface PlacedItem {
  item: Item
  x: number // screen px of item.pos
  w: number // total card width (span bar or icon+label)
  row: number // 0 = closest to spine, stacking upward; negative rows stack below the spine
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

export interface PathPlacedItem {
  item: Item
  x: number
  y: number
  labelShown: boolean
  ghost: boolean
  size: number
}

export interface BranchLayout {
  branch: Branch
  forkX: number
  joinX: number
  collapsed: boolean
  pathYs: number[] // y offset below spine for each path
  items: PathPlacedItem[][]
}

export interface LayoutResult {
  placed: PlacedItem[]
  dots: LayerDot[]
  clusters: Cluster[]
  branches: BranchLayout[]
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
    const hay = `${it.title} ${it.description} ${it.tags.join(' ')}`.toLowerCase()
    if (!hay.includes(q)) return false
  }
  return true
}

const LABEL_MAX = 200

export function labelWidth(title: string): number {
  return Math.min(title.length * 6.6, LABEL_MAX)
}

/** Title truncated to the width labelWidth actually reserves, so long labels
 *  can't overflow their slot and run into neighboring items. */
export function displayLabel(title: string): string {
  if (title.length * 6.6 <= LABEL_MAX) return title
  return title.slice(0, Math.floor(LABEL_MAX / 6.6) - 1) + '…'
}

const ICON_W = 30
export const ROW_H = 46
export const ROW0_Y = -52 // y of row 0 relative to the spine

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
): LayoutResult {
  const toX = (pos: number) => (pos - cam.x) * cam.s
  const margin = 220
  const minGap = lerp(46, 10, density)
  const maxRows = Math.round(lerp(3, 7, density))

  const eyeHidden = new Set(p.layers.filter(l => l.eye).map(l => l.id))
  const pinned = new Set(p.layers.filter(l => l.pin).map(l => l.id))

  const mainItems: { it: Item; li: number; ghost: boolean; pin: boolean; size: number }[] = []
  const dots: LayerDot[] = []
  const pathItems = new Map<string, Item[]>()
  let totalCount = 0

  for (const it of p.items) {
    if (it.pathId) {
      ;(pathItems.get(it.pathId) ?? pathItems.set(it.pathId, []).get(it.pathId)!).push(it)
      continue
    }
    const x = toX(it.pos)
    const xEnd = toX(it.pos + it.duration)
    if (xEnd < -margin || x > width + margin) continue
    totalCount++
    const layerId = it.layerId ?? typeOf(p, it)?.defaultLayerId ?? null
    if (layerId && eyeHidden.has(layerId)) { totalCount--; continue }
    const ghost = !itemMatchesFilters(p, it, filters)
    if (ghost && ghostHidden) { continue }
    const layer = layerId ? p.layers.find(l => l.id === layerId) : undefined
    // Zoomed out past the layer's minZoom → the item collapses to a dot on the
    // line. Selected (forced) items stay full-size so they remain editable.
    if (layer && (layer.minZoom ?? 0) > 0 && cam.s < layer.minZoom && !forced.has(it.id)) {
      dots.push({ item: it, x, color: typeOf(p, it)?.color ?? '#888', ghost })
      continue
    }
    mainItems.push({
      it, li: layerIndexOf(p, it), ghost,
      pin: (!!layerId && pinned.has(layerId)) || forced.has(it.id),
      size: layer?.size ?? 1,
    })
  }

  // Priority: pinned first, then real items by layer significance (sticky bonus), ghosts last.
  mainItems.sort((a, b) => {
    const pa = (a.ghost ? 100 : 0) + (a.pin ? -50 : 0) + a.li - (sticky.has(a.it.id) ? 0.6 : 0)
    const pb = (b.ghost ? 100 : 0) + (b.pin ? -50 : 0) + b.li - (sticky.has(b.it.id) ? 0.6 : 0)
    return pa - pb || a.it.pos - b.it.pos
  })

  const rows = new Map<number, Interval[]>()
  const placed: PlacedItem[] = []
  const overflow: { it: Item; ghost: boolean }[] = []

  // Branch fans live below the spine — reserve those rows so below-spine
  // markers don't overlap the paths.
  if (placement === 'both') {
    for (const br of p.branches) {
      const fx = toX(br.forkPos)
      const jx = toX(br.joinPos)
      if (jx < -margin || fx > width + margin) continue
      const maxY = 64 + (br.paths.length - 1) * 58 + 26
      for (let r = 1; rowY(-r) <= maxY; r++) occupy(rows, -r, fx - 24, jx + 24)
    }
  }

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

  for (const { it, ghost, pin, size } of mainItems) {
    const x = toX(it.pos)
    const spanW = it.duration > 0 ? Math.max(it.duration * cam.s, 10) : 0
    const rowCap = pin ? maxRows + 4 : maxRows
    const iconW = ICON_W * size
    const tryPlace = (withLabel: boolean): PlacedItem | null => {
      const lw = withLabel ? (labelWidth(it.title || '…') + 8) * size : 0
      const w = Math.max(iconW + lw, spanW)
      const a = x - iconW / 2 - minGap / 2
      const b = x - iconW / 2 + w + minGap / 2
      for (const r of candidateRows(rowCap)) {
        if (fits(rows, r, a, b)) {
          occupy(rows, r, a, b)
          return { item: it, x, w, row: r, labelShown: withLabel, ghost, spanW, size }
        }
      }
      return null
    }
    const pl = tryPlace(true) ?? tryPlace(false)
    if (pl) placed.push(pl)
    else if (!ghost) overflow.push({ it, ghost })
  }

  // Stable render order: keyed siblings must never reorder between layout
  // passes, or React moves their DOM nodes and every CSS enter-animation
  // (the pop tween) restarts on items that were already on screen.
  placed.sort((a, b) => (a.item.id < b.item.id ? -1 : 1))
  dots.sort((a, b) => (a.item.id < b.item.id ? -1 : 1))

  // Cluster overflow items by screen proximity.
  overflow.sort((a, b) => a.it.pos - b.it.pos)
  const clusters: Cluster[] = []
  for (const { it } of overflow) {
    const x = toX(it.pos)
    const last = clusters[clusters.length - 1]
    if (last && Math.abs(x - last.x) < 36) {
      last.count++
      last.ids.push(it.id)
      last.x = last.x + (x - last.x) / last.count
    } else {
      clusters.push({ key: `c${clusters.length}:${it.id}`, x, count: 1, color: typeOf(p, it)?.color ?? '#888', ids: [it.id] })
    }
  }
  // Single-item "clusters" render as tiny dots; that's fine.

  // Branches
  const branches: BranchLayout[] = []
  for (const br of p.branches) {
    const forkX = toX(br.forkPos)
    const joinX = toX(br.joinPos)
    if (joinX < -margin || forkX > width + margin) continue
    const collapsed = joinX - forkX < 110
    const pathYs = br.paths.map((_, i) => 64 + i * 58)
    const items: PathPlacedItem[][] = br.paths.map((path, pi) => {
      const list = (pathItems.get(path.id) ?? [])
        .filter(it => {
          const layerId = it.layerId ?? typeOf(p, it)?.defaultLayerId ?? null
          return !(layerId && eyeHidden.has(layerId))
        })
        .sort((a, b) => a.pos - b.pos)
      const out: PathPlacedItem[] = []
      for (let i = 0; i < list.length; i++) {
        const it = list[i]
        const ghost = !itemMatchesFilters(p, it, filters)
        if (ghost && ghostHidden) continue
        const x = clamp(toX(it.pos), forkX + 30, joinX - 30)
        const next = list[i + 1]
        const gap = next ? Math.abs(clamp(toX(next.pos), forkX + 30, joinX - 30) - x) : Infinity
        const lid = it.layerId ?? typeOf(p, it)?.defaultLayerId ?? null
        const size = (lid ? p.layers.find(l => l.id === lid)?.size : 1) ?? 1
        out.push({ item: it, x, y: pathYs[pi], labelShown: gap > 74 && !collapsed, ghost, size })
      }
      return out
    })
    branches.push({ branch: br, forkX, joinX, collapsed, pathYs, items })
  }

  const shownCount = placed.filter(pl => !pl.ghost).length +
    dots.filter(d => !d.ghost).length +
    branches.reduce((n, b) => n + (b.collapsed ? 0 : b.items.flat().filter(i => !i.ghost).length), 0)
  const totalWithPaths = totalCount + [...pathItems.values()].reduce((n, l) => n + l.length, 0)

  return { placed, dots, clusters, branches, shownCount, totalCount: totalWithPaths }
}

/** World extent of all content, padded. */
export function contentExtent(p: Project): { min: number; max: number } {
  let min = Infinity
  let max = -Infinity
  for (const it of p.items) { min = Math.min(min, it.pos); max = Math.max(max, it.pos + it.duration) }
  for (const sc of p.sections) { min = Math.min(min, sc.start); max = Math.max(max, sc.end) }
  for (const br of p.branches) { min = Math.min(min, br.forkPos); max = Math.max(max, br.joinPos) }
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
