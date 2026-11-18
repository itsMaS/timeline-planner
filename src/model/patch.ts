import type { Project } from './types'

/**
 * Entity-level patches between two versions of a Project.
 *
 * Collections keyed by id are diffed per entity (upsert / remove / order),
 * scalar fields are replaced wholesale. Per-user state (camera, cameras,
 * filters, activeViewId, activeTimelineId) is deliberately excluded so it
 * never syncs between people.
 */

export const SYNC_COLLECTIONS = [
  'hierarchyLevels', 'fields', 'fieldFolders', 'processors', 'processorFolders', 'types', 'typeFolders', 'layers', 'timelines', 'sections', 'items', 'views',
] as const
export const SYNC_SCALARS = ['name', 'settings'] as const

export type ColKey = typeof SYNC_COLLECTIONS[number]
export type ScalarKey = typeof SYNC_SCALARS[number]

type Entity = { id: string }

export interface CollectionPatch {
  upsert?: Entity[]
  remove?: string[]
  /** Full id order of the collection after the change (only when it changed). */
  order?: string[]
}

export interface Patch {
  cols?: Partial<Record<ColKey, CollectionPatch>>
  set?: Partial<Pick<Project, ScalarKey>>
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)

const json = (x: unknown) => JSON.stringify(x)

/**
 * Structural sharing after a change: `next` (a fresh clone of `base` with an
 * edit applied) takes back `base`'s objects for every entity, collection and
 * top-level value the edit did not touch. Typing into one item then replaces
 * only that item and the `items` array; types, fields, sections and every
 * other item keep their identity, so caches and memos keyed on them survive.
 * Mutates and returns `next`; `base` is never modified.
 */
export function reuseUnchanged<T extends object>(base: T, next: T): T {
  const b = base as Record<string, unknown>
  const n = next as Record<string, unknown>
  for (const k of Object.keys(n)) {
    const a = b[k]
    const v = n[k]
    if (a === v || !a || !v || typeof a !== 'object' || typeof v !== 'object') continue
    if (Array.isArray(a) && Array.isArray(v)) {
      const byId = new Map<unknown, unknown>()
      for (const e of a) if (e && typeof e === 'object' && 'id' in e) byId.set((e as Entity).id, e)
      let whole = a.length === v.length
      const out = v.map((e, i) => {
        const old = e && typeof e === 'object' && 'id' in e ? byId.get((e as Entity).id) : a[i]
        const keep = old !== undefined && json(old) === json(e) ? old : e
        if (keep !== a[i]) whole = false
        return keep
      })
      n[k] = whole ? a : out
    } else if (!Array.isArray(a) && !Array.isArray(v) && json(a) === json(v)) {
      n[k] = a
    }
  }
  return next
}

function diffCollection(a: Entity[], b: Entity[]): CollectionPatch | null {
  const am = new Map(a.map(e => [e.id, e]))
  const bm = new Map(b.map(e => [e.id, e]))
  const upsert: Entity[] = []
  const remove: string[] = []
  for (const e of b) {
    const prev = am.get(e.id)
    if (!prev || !same(prev, e)) upsert.push(structuredClone(e))
  }
  for (const e of a) if (!bm.has(e.id)) remove.push(e.id)
  // Order matters (layers = significance, types = sidebar order). Compare the
  // sequence of ids that survive in both versions.
  const aSeq = a.filter(e => bm.has(e.id)).map(e => e.id)
  const bSeq = b.filter(e => am.has(e.id)).map(e => e.id)
  const reordered = aSeq.join('\n') !== bSeq.join('\n')
  if (!upsert.length && !remove.length && !reordered) return null
  const out: CollectionPatch = {}
  if (upsert.length) out.upsert = upsert
  if (remove.length) out.remove = remove
  if (reordered) out.order = b.map(e => e.id)
  return out
}

/** Patch that turns `a` into `b`, or null when nothing synced changed. */
export function diffProject(a: Project, b: Project): Patch | null {
  const patch: Patch = {}
  for (const k of SYNC_COLLECTIONS) {
    // Documents saved before a collection existed simply lack the key.
    const d = diffCollection((a[k] ?? []) as Entity[], (b[k] ?? []) as Entity[])
    if (d) (patch.cols ??= {})[k] = d
  }
  for (const k of SYNC_SCALARS) {
    if (!same(a[k], b[k])) (patch.set ??= {})[k] = structuredClone(b[k]) as never
  }
  return patch.cols || patch.set ? patch : null
}

/** Apply `patch` to `p` in place. Unknown ids are added, missing ids ignored. */
export function applyPatch(p: Project, patch: Patch): void {
  if (patch.cols) {
    for (const k of SYNC_COLLECTIONS) {
      const cp = patch.cols[k]
      if (!cp) continue
      let list = ((p[k] ?? []) as Entity[]).slice()
      if (cp.remove?.length) {
        const rm = new Set(cp.remove)
        list = list.filter(e => !rm.has(e.id))
      }
      if (cp.upsert?.length) {
        for (const e of cp.upsert) {
          const i = list.findIndex(x => x.id === e.id)
          if (i >= 0) list[i] = structuredClone(e)
          else list.push(structuredClone(e))
        }
      }
      if (cp.order?.length) {
        const pos = new Map(cp.order.map((id, i) => [id, i]))
        // Entities not mentioned (concurrent adds elsewhere) keep relative order at the end.
        list = list
          .map((e, i) => ({ e, key: pos.has(e.id) ? pos.get(e.id)! : cp.order!.length + i }))
          .sort((x, y) => x.key - y.key)
          .map(x => x.e)
      }
      ;(p as unknown as Record<string, unknown>)[k] = list
    }
  }
  if (patch.set) {
    for (const k of SYNC_SCALARS) {
      if (k in patch.set) (p as unknown as Record<string, unknown>)[k] = structuredClone(patch.set[k])
    }
  }
}

/** Rough size guard so a single patch can't blow past Realtime payload limits. */
export function patchBytes(patch: Patch): number {
  return JSON.stringify(patch).length
}
