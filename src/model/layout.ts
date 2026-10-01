import type { Camera, FieldDef, Filters, Item, Project } from './types'
import { attachmentsFor, displayEntries, readValue, type Owner } from './fields'
import { matchesRule } from './scope'
import { compareStack, stackKey } from './stacks'
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
 * A section's level (`depth`) is chosen by the user and never follows its
 * bounds; this only keeps it a whole number inside the hierarchy levels.
 */
export function clampSectionDepths(p: Project) {
  const max = Math.max(p.hierarchyLevels.length - 1, 0)
  for (const s of p.sections) {
    const d = Math.round(Number(s.depth))
    s.depth = Number.isFinite(d) ? Math.min(Math.max(d, 0), max) : 0
  }
}

/**
 * Starting level for a new section at [start, end]: one below the deepest
 * section of the same timeline that encloses it. Only used on creation.
 */
export function initialSectionDepth(p: Project, timelineId: string | undefined, start: number, end: number): number {
  const eps = 1e-9
  let depth = 0
  for (const t of p.sections) {
    if (timelineId && t.timelineId !== timelineId) continue
    if (t.start <= start + eps && t.end >= end - eps && t.end - t.start > end - start + eps) depth = Math.max(depth, t.depth + 1)
  }
  return Math.min(depth, Math.max(p.hierarchyLevels.length - 1, 0))
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

/** Fields hidden by the live filters (canvas labels, tooltip, exports); badged toggles never ride in the label. */
export function isFieldShown(p: Project, field: FieldDef): boolean {
  return !(p.filters?.offFields ?? []).includes(field.id) && !(field.kind === 'toggle' && field.badge)
}

/**
 * "Name: value · Name: value" for every custom field the item has filled in
 * (just "value" for fields that hide their name), skipping fields hidden by
 * the filters and toggles that show as an icon badge instead.
 */
export function itemFieldText(p: Project, it: Item): string {
  return displayEntries(p, { kind: 'item', entity: it }, { skip: f => !isFieldShown(p, f) })
    .map(x => (x.label ? `${x.label}: ${x.text}` : x.text))
    .join(FIELD_SEP)
}

/** Toggle badges to draw on an entity: its badged toggle fields (not hidden), with the effective state. */
export function toggleBadges(p: Project, owner: Owner): { field: FieldDef; on: boolean | null }[] {
  return attachmentsFor(p, owner)
    .filter(({ field }) => field.kind === 'toggle' && field.badge && !(p.filters?.offFields ?? []).includes(field.id))
    .map(({ att, field }) => {
      const v = readValue(p, owner, field, att)
      return { field, on: typeof v === 'boolean' ? v : null }
    })
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

function release(rows: Map<number, Interval[]>, row: number, a: number, b: number) {
  const list = rows.get(row)
  const i = list ? list.findIndex(iv => iv.a === a && iv.b === b) : -1
  if (i >= 0) list!.splice(i, 1)
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
  /** Hard cap on rows below the spine (placement 'both') so items stay above the ruler and status bar. */
  maxDownRows = Infinity,
): LayoutResult {
  const toX = (pos: number) => (pos - cam.x) * cam.s
  const margin = 220
  const minGap = lerp(46, 10, density)
  // Rows per side follow the room on screen: from mid detail up every row
  // that fits is used, below it the cap shrinks toward 3 so low detail still
  // declutters. Without a known room (Infinity) the old 3..7 scale applies.
  const fill = clamp(density * 2, 0, 1)
  const capFor = (room: number) => Number.isFinite(room)
    ? Math.max(1, Math.round(lerp(Math.min(3, room), room, fill)))
    : Math.round(lerp(3, 7, density))
  const upCap = capFor(maxUpRows)
  const downCap = capFor(maxDownRows)
  // Pinned and selected items may use every row there is room for.
  const pinCap = (room: number, cap: number) => (Number.isFinite(room) ? room : cap + 4)

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
    candidateRows: (pin: boolean) => number[],
    xOf: (it: Item) => number,
  ): Item[] => {
    const overflow: Item[] = []
    cands.sort(byPriority)
    /** Where an item would sit and the interval it claims on its row. */
    const measure = (c: Cand, withLabel: boolean) => {
      const x = xOf(c.it)
      const spanW = c.it.duration > 0 ? Math.max(c.it.duration * cam.s, 10) : 0
      const iconW = ICON_W * c.size
      const lbl = itemLabel(p, c.it, showFields, showTitles)
      const lw = withLabel && lbl.text ? (labelWidth(lbl.text, lbl.max) + 8) * c.size : 0
      const w = Math.max(iconW + lw, spanW)
      const a = x - iconW / 2 - minGap / 2
      return { x, spanW, w, labelShown: withLabel && !!lbl.text, a, b: a + w + minGap }
    }
    const put = (c: Cand, r: number, m: ReturnType<typeof measure>): PlacedItem => {
      occupy(rows, r, m.a, m.b)
      return { item: c.it, x: m.x, ny: rowY(r), w: m.w, row: r, labelShown: m.labelShown, ghost: c.ghost, spanW: m.spanW, size: c.size }
    }
    // Items sharing a position are placed together, when the first of them
    // comes up. Rows go to them in stack order (each on a later candidate row
    // than the one before), so the first ranks stay when space runs out; the
    // rows are then dealt out again top-down, so rank 0 sits on top.
    const stacks = new Map<number, Cand[]>()
    for (const c of cands) {
      const k = stackKey(c.it.pos)
      const s = stacks.get(k)
      if (s) s.push(c)
      else stacks.set(k, [c])
    }
    const done = new Set<number>()
    for (const first of cands) {
      const key = stackKey(first.it.pos)
      if (done.has(key)) continue
      done.add(key)
      const members = stacks.get(key)!
      if (members.length > 1) members.sort((a, b) => compareStack(p, a.it, b.it))
      let from = 0
      const got: { c: Cand; pl: PlacedItem; a: number; b: number }[] = []
      for (const c of members) {
        const cand = candidateRows(c.pin)
        let hit: (typeof got)[number] | null = null
        for (const withLabel of [true, false]) {
          const m = measure(c, withLabel)
          for (let i = from; i < cand.length && !hit; i++) {
            if (!fits(rows, cand[i], m.a, m.b)) continue
            hit = { c, pl: put(c, cand[i], m), a: m.a, b: m.b }
            from = i + 1
          }
          if (hit) break
        }
        if (hit) got.push(hit)
        else if (!c.ghost) overflow.push(c.it)
      }
      if (got.length < 2) {
        for (const g of got) placed.push(g.pl)
        continue
      }
      for (const g of got) release(rows, g.pl.row, g.a, g.b)
      const slots = got.map(g => g.pl.row).sort((r1, r2) => rowY(r1) - rowY(r2))
      got.forEach(({ c }, k) => {
        const m = [measure(c, true), measure(c, false)].find(m0 => fits(rows, slots[k], m0.a, m0.b))
        if (m) placed.push(put(c, slots[k], m))
        else if (!c.ghost) overflow.push(c.it)
      })
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
  const candidateRows = (pin: boolean): number[] => {
    const up = pin ? pinCap(maxUpRows, upCap) : upCap
    const down = placement === 'both' ? (pin ? pinCap(maxDownRows, downCap) : downCap) : 0
    const out: number[] = []
    for (let r = 0; r < Math.max(up, down); r++) {
      if (r < up) out.push(r)
      if (r < down) out.push(-(r + 1))
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
