import type { Item, Project } from './types'

/**
 * Items sharing a position form a stack. Their order (`Item.stack`, lower
 * first) is the priority within it: first sits closest to the spine on the
 * canvas, is the last to collapse into a cluster, and comes first in the
 * document export. Vertical drags on the canvas rewrite it.
 */

/** Positions that round to the same key share a stack (float noise aside). */
export const stackKey = (pos: number) => Math.round(pos * 1e6)

const layerOf = (p: Project, it: Item) => {
  const layerId = it.layerId ?? p.types.find(t => t.id === it.typeId)?.defaultLayerId ?? null
  const idx = p.layers.findIndex(l => l.id === layerId)
  return { idx: idx < 0 ? p.layers.length : idx, pin: idx >= 0 && p.layers[idx].pin }
}

/**
 * Order within a stack: explicit ranks first (ascending), then items never
 * reordered by their layer (pinned layers, then significance). Ties keep
 * their incoming order, so use it with a stable sort.
 */
export function compareStack(p: Project, a: Item, b: Item): number {
  const sa = a.stack ?? Infinity
  const sb = b.stack ?? Infinity
  if (sa !== sb) return sa < sb ? -1 : 1
  const la = layerOf(p, a)
  const lb = layerOf(p, b)
  if (la.pin !== lb.pin) return la.pin ? -1 : 1
  return la.idx - lb.idx
}

/** Items by position, stacks in their stack order (stable otherwise). */
export function sortByPosition(p: Project, items: Item[]): Item[] {
  return [...items].sort((a, b) => stackKey(a.pos) - stackKey(b.pos) || compareStack(p, a, b))
}

/** Consecutive runs of items sharing a position, from a list sorted with `sortByPosition`. */
export function stackRuns(items: Item[]): Item[][] {
  const runs: Item[][] = []
  for (const it of items) {
    const last = runs[runs.length - 1]
    if (last && stackKey(last[0].pos) === stackKey(it.pos)) last.push(it)
    else runs.push([it])
  }
  return runs
}
