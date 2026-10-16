import type { Item, Section } from './types'

/**
 * Ripple edits for sections: inserting one opens room for it (whatever lies
 * after slides right, every section across the spot grows), and moving one
 * closes the hole it leaves and opens room where it lands, so sections of a
 * level never overlap. Pure: callers get the new bounds and apply them.
 */

const EPS = 1e-6

export interface Bounds { start: number; end: number }

/** New bounds / positions for the entities a ripple edit touches. */
export interface Reflow {
  sections: { id: string; start: number; end: number }[]
  items: { id: string; pos: number; duration: number }[]
}

/** Write a reflow into a project (inside a `mutate` recipe). */
export function applyReflow(p: { sections: Section[]; items: Item[] }, r: Reflow) {
  const secs = new Map(r.sections.map(o => [o.id, o]))
  const its = new Map(r.items.map(o => [o.id, o]))
  for (const s of p.sections) {
    const o = secs.get(s.id)
    if (o) { s.start = o.start; s.end = o.end }
  }
  for (const it of p.items) {
    const o = its.get(it.id)
    if (o) { it.pos = o.pos; it.duration = o.duration }
  }
}

/** Take [a, b] out of the line: what lies after b slides back by its width. */
const closeAt = (x: number, a: number, b: number) => (x <= a + EPS ? x : x >= b - EPS ? x - (b - a) : a)

/**
 * Open a gap of `w` at `p`. Something exactly on p decides by its side: a
 * start slides (it lies after the gap) and an end stays (it lies before it),
 * unless the section is anchored, i.e. it grows around the gap.
 */
const openAt = (x: number, p: number, w: number, side: 'start' | 'end', anchored: boolean) => {
  if (x > p + EPS) return x + w
  if (x < p - EPS) return x
  return (side === 'start') !== anchored ? x + w : x
}

const contains = (outer: Bounds, inner: Bounds) => outer.start <= inner.start + EPS && outer.end >= inner.end - EPS

/** Sections above level `depth` that enclose `ref`: they grow around a gap opened next to it. */
export function enclosing(sections: Section[], depth: number, ref: Bounds, skip?: Set<string>): Set<string> {
  return new Set(sections.filter(s => s.depth < depth && !skip?.has(s.id) && contains(s, ref)).map(s => s.id))
}

/**
 * Apply `map` to every section and item outside `skip`, keeping a section
 * that would collapse at its old width. Only changed entries are returned.
 */
function reflow(
  sections: Section[], items: Item[], skipSecs: Set<string>, skipItems: Set<string>,
  map: (x: number, side: 'start' | 'end', anchored: boolean) => number, anchors: Set<string>,
): Reflow {
  const out: Reflow = { sections: [], items: [] }
  for (const s of sections) {
    if (skipSecs.has(s.id)) continue
    const a = anchors.has(s.id)
    const start = map(s.start, 'start', a)
    let end = map(s.end, 'end', a)
    if (end - start < EPS && s.end - s.start > EPS) end = start + (s.end - s.start)
    if (Math.abs(start - s.start) > EPS || Math.abs(end - s.end) > EPS) out.sections.push({ id: s.id, start, end })
  }
  for (const it of items) {
    if (skipItems.has(it.id)) continue
    const pos = map(it.pos, 'start', false)
    const duration = it.duration > 0 ? Math.max(0, map(it.pos + it.duration, 'end', false) - pos) : it.duration
    if (Math.abs(pos - it.pos) > EPS || Math.abs(duration - it.duration) > EPS) out.items.push({ id: it.id, pos, duration })
  }
  return out
}

/** Make room for `w` at `p`: what lies from p on slides right, sections across p and the `anchors` grow. */
export function openGap(sections: Section[], items: Item[], p: number, w: number, anchors: Set<string>): Reflow {
  return reflow(sections, items, new Set(), new Set(), (x, side, a) => openAt(x, p, w, side, a), anchors)
}

/**
 * A section with what travels with it: the deeper sections it contains and
 * the items from its start up to (not including) its end — an item on the
 * end belongs to the next section of the level, unless there is none.
 */
export function sectionContents(sections: Section[], items: Item[], sc: Section): { secIds: Set<string>; itemIds: Set<string> } {
  const secIds = new Set([sc.id, ...sections.filter(s => s.depth > sc.depth && contains(sc, s)).map(s => s.id)])
  const endTaken = sections.some(s => s.id !== sc.id && s.depth === sc.depth && Math.abs(s.start - sc.end) <= EPS)
  const itemIds = new Set(items
    .filter(it => it.pos >= sc.start - EPS && (it.pos < sc.end - EPS || (!endTaken && it.pos <= sc.end + EPS)))
    .map(it => it.id))
  return { secIds, itemIds }
}

/**
 * Where a dragged section lands when its desired span `[desiredStart, +w]`
 * overlaps sections of its level: before or after the one under its leading
 * edge (whichever half the edge is in). The hole it leaves closes (unless it is
 * a fresh duplicate) and room opens where it lands; enclosing sections grow
 * or shrink to match. Returns null when nothing of its level is in the way,
 * so the caller can move it freely.
 */
export function planSectionMove(
  sections: Section[], items: Item[], grab: Section,
  moved: { secIds: Set<string>; itemIds: Set<string> }, desiredStart: number, duplicate: boolean,
): Reflow | null {
  const a = grab.start
  const b = grab.end
  const w = b - a
  const mid = (s: Bounds) => (s.start + s.end) / 2
  // The edge leading the drag decides: past a neighbour's middle, it swaps.
  const lead = desiredStart < a ? desiredStart : desiredStart + w
  const over = sections.filter(s =>
    s.depth === grab.depth && !moved.secIds.has(s.id) && s.end - s.start > EPS &&
    s.start < desiredStart + w - EPS && s.end > desiredStart + EPS)
  if (!over.length) return null
  const target = over.find(s => s.start <= lead && s.end >= lead)
    ?? over.reduce((best, s) => (Math.abs(mid(s) - lead) < Math.abs(mid(best) - lead) ? s : best))
  const edge = lead < mid(target) ? target.start : target.end
  const anchors = enclosing(sections, grab.depth, target, moved.secIds)
  const p = duplicate ? edge : closeAt(edge, a, b)
  const out = reflow(
    sections, items, moved.secIds, moved.itemIds,
    (x, side, an) => openAt(duplicate ? x : closeAt(x, a, b), p, w, side, an), anchors,
  )
  for (const s of sections) {
    if (moved.secIds.has(s.id)) out.sections.push({ id: s.id, start: p + (s.start - a), end: p + (s.end - a) })
  }
  for (const it of items) {
    if (moved.itemIds.has(it.id)) out.items.push({ id: it.id, pos: p + (it.pos - a), duration: it.duration })
  }
  return out
}

/** What a right-click at a spot on the canvas offers for sections. */
export interface SectionSpot {
  /** The section "Split here" cuts: the one under the pointer, unless the
      spot is on its edge or in a gap between sections of the level below. */
  split: Section | null
  /** Level, position and growing sections for "New section here". */
  depth: number
  at: number
  anchors: Set<string>
}

/**
 * Resolve a right-click at world position `pos`. On a header bar
 * (`rowDepth`) it is about that level; elsewhere about the innermost
 * section there. Within `tol` of an edge counts as between two sections:
 * no split, and a new section goes onto that edge. A new section otherwise
 * goes one level down at the spot, or beside the section when it is
 * already at the deepest level (`maxDepth`) or on its header bar.
 */
export function sectionSpot(sections: Section[], pos: number, tol: number, maxDepth: number, rowDepth: number | null): SectionSpot {
  const inside = (s: Section) => s.start < pos - EPS && s.end > pos + EPS
  const nearEdge = (s: Section) => pos - s.start <= tol || s.end - pos <= tol
  const nearer = (s: Section) => (pos - s.start <= s.end - pos ? s.start : s.end)
  /** A section of the level with an edge within tol of pos (the nearest). */
  const edgeNear = (list: Section[]): { s: Section; at: number } | null => {
    let best: { s: Section; at: number } | null = null
    for (const s of list) {
      for (const e of [s.start, s.end]) {
        if (Math.abs(e - pos) <= tol && (!best || Math.abs(e - pos) < Math.abs(best.at - pos))) best = { s, at: e }
      }
    }
    return best
  }

  let split: Section | null = null
  let depth: number
  let at = pos
  let ref: Section | null = null
  if (rowDepth !== null) {
    depth = rowDepth
    const level = sections.filter(s => s.depth === rowDepth)
    const y = level.find(inside)
    if (y) {
      if (!nearEdge(y)) split = y
      ref = y
      at = nearer(y)
    } else {
      const hit = edgeNear(level)
      if (hit) { ref = hit.s; at = hit.at }
    }
  } else {
    const x = sections.filter(inside).sort((s1, s2) => s2.depth - s1.depth || (s1.end - s1.start) - (s2.end - s2.start))[0]
    if (x && nearEdge(x)) {
      depth = x.depth
      ref = x
      at = nearer(x)
    } else if (x && x.depth + 1 > maxDepth) {
      split = x
      depth = x.depth
      ref = x
      at = nearer(x)
    } else {
      depth = x ? x.depth + 1 : 0
      const level = sections.filter(s => s.depth === depth && (!x || contains(x, s)))
      const gap = level.some(s => s.end <= pos + EPS) && level.some(s => s.start >= pos - EPS)
      if (x && !gap) split = x
      const hit = edgeNear(level)
      if (hit) { ref = hit.s; at = hit.at }
    }
  }
  const anchors = ref
    ? enclosing(sections, depth, ref)
    : new Set(sections.filter(s => s.depth < depth && s.start < at - EPS && s.end > at + EPS).map(s => s.id))
  return { split, depth, at, anchors }
}
