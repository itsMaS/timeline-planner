import type { Branch, Camera, Filters, Item, Project } from './types'
import { clamp, lerp } from './util'

export interface PlacedItem {
  item: Item
  x: number // screen px of item.pos
  /** y of the line this item hangs off: 0 = the spine, otherwise a branch path. */
  y: number
  /** y of the node itself (relative to the spine); the stem runs from here to `y`. */
  ny: number
  w: number // total card width (span bar or icon+label)
  row: number // 0 = closest to the line, stacking upward; negative rows stack below it
  labelShown: boolean
  ghost: boolean
  spanW: number // pixel width of the duration bar (0 for points)
  size: number // visual scale from the item's layer (1 = normal)
}

/** An item minimized to a dot on its line (its layer's minZoom is above the camera zoom). */
export interface LayerDot {
  item: Item
  x: number
  y: number
  color: string
  ghost: boolean
}

export interface Cluster {
  key: string
  x: number
  y: number
  count: number
  color: string
  ids: string[]
}

export interface BranchLayout {
  branch: Branch
  forkX: number
  joinX: number
  /** Horizontal length of the fork/join transition curves (shrinks when zoomed out). */
  curveW: number
  /** y offset from the spine of each path; negative = above. Symmetric around 0. */
  pathYs: number[]
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
/** Vertical distance between neighbouring branch paths: one row of items + the line. */
export const PATH_GAP = 92
/** How far above its path a path item's node sits (shorter stem than the spine's rows). */
export const PATH_LIFT = 30

/** Path y offsets for an n-way branch, spread symmetrically around the spine. */
export function branchPathYs(n: number): number[] {
  return Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * PATH_GAP)
}

/** Horizontal length of the split/rejoin curves for a branch of the given screen width. */
export function branchCurveW(forkX: number, joinX: number): number {
  return clamp((joinX - forkX) * 0.3, 6, 58)
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
 *
 * Branch paths are laid out with the same rules as the spine: each path is a
 * line of its own with one row of items above it, and whatever doesn't fit
 * clusters on the path.
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

  type Cand = { it: Item; li: number; ghost: boolean; pin: boolean; size: number }
  const dots: LayerDot[] = []
  const placed: PlacedItem[] = []
  const clusters: Cluster[] = []
  let totalCount = 0

  // Branch geometry first: it decides where path items live and which spine
  // rows they block.
  const branches: BranchLayout[] = []
  const pathHome = new Map<string, { visible: boolean; y: number; lo: number; hi: number }>()
  for (const br of p.branches) {
    const forkX = toX(br.forkPos)
    const joinX = toX(br.joinPos)
    const curveW = branchCurveW(forkX, joinX)
    const pathYs = branchPathYs(br.paths.length)
    const visible = !(joinX < -margin || forkX > width + margin)
    const mid = (forkX + joinX) / 2
    br.paths.forEach((path, i) => {
      pathHome.set(path.id, {
        visible, y: pathYs[i],
        lo: Math.min(forkX + curveW + 6, mid),
        hi: Math.max(joinX - curveW - 6, mid),
      })
    })
    if (visible) branches.push({ branch: br, forkX, joinX, curveW, pathYs })
  }

  /** Visibility / layer / filter sieve shared by the spine and the paths. */
  const consider = (it: Item, x: number, xEnd: number, y: number): Cand | null => {
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
      dots.push({ item: it, x, y, color: typeOf(p, it)?.color ?? '#888', ghost })
      return null
    }
    return {
      it, li: layerIndexOf(p, it), ghost,
      pin: (!!layerId && pinned.has(layerId)) || forced.has(it.id),
      size: layer?.size ?? 1,
    }
  }

  const spineCands: Cand[] = []
  const pathCands = new Map<string, Cand[]>()
  for (const it of p.items) {
    const home = it.pathId ? pathHome.get(it.pathId) : undefined
    if (home) {
      if (!home.visible) continue
      const x = clamp(toX(it.pos), home.lo, home.hi)
      const c = consider(it, x, x + Math.max(it.duration * cam.s, 0), home.y)
      if (c) (pathCands.get(it.pathId!) ?? pathCands.set(it.pathId!, []).get(it.pathId!)!).push(c)
      continue
    }
    // Spine item (a dangling pathId falls back to the spine rather than vanishing).
    const c = consider(it, toX(it.pos), toX(it.pos + it.duration), 0)
    if (c) spineCands.push(c)
  }

  // Priority: pinned first, then real items by layer significance (sticky bonus), ghosts last.
  const byPriority = (a: Cand, b: Cand) => {
    const pa = (a.ghost ? 100 : 0) + (a.pin ? -50 : 0) + a.li - (sticky.has(a.it.id) ? 0.6 : 0)
    const pb = (b.ghost ? 100 : 0) + (b.pin ? -50 : 0) + b.li - (sticky.has(b.it.id) ? 0.6 : 0)
    return pa - pb || a.it.pos - b.it.pos
  }

  /**
   * Greedy row packing along one line at `y`. Items that fit nowhere (and
   * aren't ghosts) come back as overflow for clustering.
   */
  const packLine = (
    cands: Cand[],
    rows: Map<number, Interval[]>,
    candidateRows: (cap: number) => number[],
    xOf: (it: Item) => number,
    y: number,
    nyOf: (row: number) => number,
    spanCap: number,
  ): Item[] => {
    const overflow: Item[] = []
    cands.sort(byPriority)
    for (const { it, ghost, pin, size } of cands) {
      const x = xOf(it)
      const spanW = it.duration > 0 ? Math.max(Math.min(it.duration * cam.s, spanCap - x), 10) : 0
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
            return { item: it, x, y, ny: nyOf(r), w, row: r, labelShown: withLabel, ghost, spanW, size }
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

  /** Cluster overflow items by screen proximity along their line. */
  const clusterize = (overflow: Item[], xOf: (it: Item) => number, y: number, prefix: string) => {
    overflow.sort((a, b) => a.pos - b.pos)
    let n = 0
    for (const it of overflow) {
      const x = xOf(it)
      const last = clusters[clusters.length - 1]
      if (last && last.y === y && Math.abs(x - last.x) < 36) {
        last.count++
        last.ids.push(it.id)
        last.x = last.x + (x - last.x) / last.count
      } else {
        clusters.push({ key: `${prefix}${n++}:${it.id}`, x, y, count: 1, color: typeOf(p, it)?.color ?? '#888', ids: [it.id] })
      }
    }
    // Single-item "clusters" render as tiny dots; that's fine.
  }

  // ---- branch paths: one row of items each, clamped onto the straight run.
  // Paths that share a line (same y, across branches) pack together so their
  // items never overlap even when zoomed far out.
  const lineRows = new Map<number, Map<number, Interval[]>>()
  const reach = new Map<string, number>() // branch id → right edge of its widest path item
  for (const bl of branches) {
    let right = bl.joinX
    bl.branch.paths.forEach(path => {
      const home = pathHome.get(path.id)!
      const cands = pathCands.get(path.id) ?? []
      if (!cands.length) return
      const rows = lineRows.get(home.y) ?? lineRows.set(home.y, new Map()).get(home.y)!
      const xOf = (it: Item) => clamp(toX(it.pos), home.lo, home.hi)
      const before = placed.length
      const over = packLine(cands, rows, () => [0], xOf, home.y, () => home.y - PATH_LIFT, home.hi + 14)
      for (let i = before; i < placed.length; i++) right = Math.max(right, placed[i].x + placed[i].w)
      clusterize(over, xOf, home.y, `p${path.id}:`)
    })
    reach.set(bl.branch.id, right)
  }

  // ---- spine
  const rows = new Map<number, Interval[]>()

  // Branches split the spine: reserve every spine row their paths (and the
  // items above them) pass through, so spine markers never overlap a branch.
  for (const bl of branches) {
    const top = Math.min(...bl.pathYs) - PATH_LIFT - 14 - 8
    const bottom = Math.max(...bl.pathYs) + 16
    const cap = maxRows + 4
    for (let r = -cap; r <= cap; r++) {
      const cy = rowY(r)
      if (cy + 26 > top && cy - 22 < bottom) occupy(rows, r, bl.forkX - 30, reach.get(bl.branch.id)! + 30)
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
  const spineX = (it: Item) => toX(it.pos)
  clusterize(packLine(spineCands, rows, candidateRows, spineX, 0, rowY, Infinity), spineX, 0, 'c')

  // Stable render order: keyed siblings must never reorder between layout
  // passes, or React moves their DOM nodes and every CSS enter-animation
  // (the pop tween) restarts on items that were already on screen.
  placed.sort((a, b) => (a.item.id < b.item.id ? -1 : 1))
  dots.sort((a, b) => (a.item.id < b.item.id ? -1 : 1))

  const shownCount = placed.filter(pl => !pl.ghost).length + dots.filter(d => !d.ghost).length

  return { placed, dots, clusters, branches, shownCount, totalCount }
}

/** Path geometry of one branch path: the spine splits at the fork, runs level
 *  at `y`, and rejoins at the join (or ends short of it for terminal paths). */
export function branchPathD(bl: BranchLayout, y: number, terminal: boolean): string {
  const { forkX, joinX, curveW: cw } = bl
  const enter = `M ${forkX} 0 C ${forkX + cw * 0.55} 0, ${forkX + cw * 0.45} ${y}, ${forkX + cw} ${y}`
  if (terminal) return `${enter} L ${terminalEndX(bl)} ${y}`
  return `${enter} L ${joinX - cw} ${y} C ${joinX - cw * 0.55} ${y}, ${joinX - cw * 0.45} 0, ${joinX} 0`
}

/** Where a terminal (dead-end) path stops, short of the join. */
export function terminalEndX(bl: BranchLayout): number {
  return Math.max(bl.forkX + bl.curveW + 4, bl.joinX - bl.curveW - 18)
}

/** The spine as one path with a gap wherever a branch splits it. */
export function spineD(width: number, branches: BranchLayout[]): string {
  const gaps = branches
    .map(bl => [bl.forkX, bl.joinX] as [number, number])
    .sort((a, b) => a[0] - b[0])
  let d = ''
  let x = 0
  for (const [a, b] of gaps) {
    if (b <= x) continue
    if (a > x) d += `M ${x} 0 L ${a} 0 `
    x = Math.max(x, b)
  }
  if (x < width) d += `M ${x} 0 L ${width} 0`
  return d.trim()
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
