import { SYNC_COLLECTIONS, SYNC_SCALARS, type ColKey, type ScalarKey } from './patch'
import type { Project } from './types'
import { uid } from './util'

/**
 * Proposals: suggested edits that wait for review instead of changing the
 * document. A proposal is a list of entity-level changes, each carrying the
 * entity as it was when the proposal was made (`before`) and as suggested
 * (`after`), so the review UI can show a diff and detect conflicts with edits
 * made in the meantime. Accepted changes are applied as one normal mutation.
 *
 * Collections are the synced ones (items, types, sections, …); scalar project
 * fields (name, settings) use col 'project' with the field
 * name as entityId. Collection order is not part of a proposal.
 */

export type ChangeKind = 'add' | 'update' | 'remove' | 'set'
export type Decision = 'applied' | 'rejected'

export interface ProposalChange {
  id: string
  col: ColKey | 'project'
  kind: ChangeKind
  /** Entity id, or the field name for col 'project'. */
  entityId: string
  before: unknown | null
  after: unknown | null
  /** Optional one-line reason shown next to the change. */
  note?: string
}

export interface Proposal {
  id: string
  timelineId: string
  title: string
  summary: string
  author: string
  baseVersion: number
  changes: ProposalChange[]
  decisions: Record<string, Decision>
  status: 'open' | 'done'
  createdAt: string
  updatedAt: string
}

type Entity = { id: string }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const list = (p: Project, col: ColKey) => p[col] as unknown as Entity[]

/** Entity-level changes that turn `base` into `edited`. Notes are keyed by entity id (or scalar name). */
export function diffToChanges(base: Project, edited: Project, notes: Record<string, string> = {}): ProposalChange[] {
  const out: ProposalChange[] = []
  const push = (c: Omit<ProposalChange, 'id' | 'note'>) => {
    const note = notes[c.entityId]
    out.push({ id: uid(), ...c, ...(note ? { note } : {}) })
  }
  for (const col of SYNC_COLLECTIONS) {
    const am = new Map(list(base, col).map(e => [e.id, e]))
    const bm = new Map(list(edited, col).map(e => [e.id, e]))
    for (const e of list(edited, col)) {
      const prev = am.get(e.id)
      if (!prev) push({ col, kind: 'add', entityId: e.id, before: null, after: structuredClone(e) })
      else if (!same(prev, e)) push({ col, kind: 'update', entityId: e.id, before: structuredClone(prev), after: structuredClone(e) })
    }
    for (const e of list(base, col)) {
      if (!bm.has(e.id)) push({ col, kind: 'remove', entityId: e.id, before: structuredClone(e), after: null })
    }
  }
  for (const k of SYNC_SCALARS) {
    if (!same(base[k], edited[k])) {
      push({ col: 'project', kind: 'set', entityId: k, before: structuredClone(base[k]), after: structuredClone(edited[k]) })
    }
  }
  return out
}

export type Conflict =
  | 'none'
  /** The live entity differs from the proposal's `before` (someone edited it since). */
  | 'modified'
  /** Update/remove target no longer exists. */
  | 'missing'
  /** Add target already exists. */
  | 'exists'

function liveValue(p: Project, c: ProposalChange): unknown | undefined {
  if (c.col === 'project') return p[c.entityId as ScalarKey]
  return list(p, c.col).find(e => e.id === c.entityId)
}

export function conflictOf(p: Project, c: ProposalChange): Conflict {
  const live = liveValue(p, c)
  switch (c.kind) {
    case 'add': return live === undefined ? 'none' : 'exists'
    case 'update':
    case 'remove': return live === undefined ? 'missing' : same(live, c.before) ? 'none' : 'modified'
    case 'set': return same(live, c.before) ? 'none' : 'modified'
  }
}

/** Apply changes in place. Missing update targets are added, missing remove targets ignored. */
export function applyChanges(p: Project, changes: ProposalChange[]): void {
  for (const c of changes) {
    if (c.col === 'project') {
      ;(p as unknown as Record<string, unknown>)[c.entityId] = structuredClone(c.after)
      continue
    }
    const arr = list(p, c.col)
    const i = arr.findIndex(e => e.id === c.entityId)
    if (c.kind === 'remove') {
      if (i >= 0) arr.splice(i, 1)
    } else {
      const e = structuredClone(c.after) as Entity
      if (i >= 0) arr[i] = e
      else arr.push(e)
    }
  }
}

// ---------------------------------------------------------------- presentation helpers

const COL_LABEL: Record<ColKey | 'project', string> = {
  items: 'Item', types: 'Type', typeFolders: 'Folder', layers: 'Layer', sections: 'Section',
  views: 'View', hierarchyLevels: 'Hierarchy level', fields: 'Field', processors: 'Processor',
  project: 'Project',
}

const SCALAR_LABEL: Record<string, string> = { name: 'name', settings: 'settings' }

/** Short heading for a change: what kind of thing and what it is called. */
export function changeLabel(c: ProposalChange): { kind: string; name: string; verb: string } {
  const kind = COL_LABEL[c.col]
  if (c.col === 'project') return { kind, name: SCALAR_LABEL[c.entityId] ?? c.entityId, verb: 'changed' }
  const e = (c.after ?? c.before) as Record<string, unknown> | null
  const raw = (e?.title ?? e?.name ?? e?.label ?? '') as string
  const name = raw.trim() || 'Untitled'
  const verb = c.kind === 'add' ? 'added' : c.kind === 'remove' ? 'removed' : 'changed'
  return { kind, name, verb }
}

export interface FieldDelta { key: string; before: unknown; after: unknown }

/** Fields that differ between before and after (top level; nested objects compare as a whole). */
export function changedFields(c: ProposalChange): FieldDelta[] {
  if (c.kind !== 'update') return []
  const a = (c.before ?? {}) as Record<string, unknown>
  const b = (c.after ?? {}) as Record<string, unknown>
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  const out: FieldDelta[] = []
  for (const k of keys) {
    if (k === 'id') continue
    if (!same(a[k], b[k])) out.push({ key: k, before: a[k], after: b[k] })
  }
  return out
}

/** Item ids the (undecided part of a) proposal touches, for canvas highlighting. */
export function proposalItemIds(p: Proposal): string[] {
  return p.changes.filter(c => c.col === 'items' && !p.decisions[c.id]).map(c => c.entityId)
}

/** Undecided changes of one collection keyed by entity id. */
export function pendingChanges(p: Proposal, col: ColKey): Map<string, ProposalChange> {
  const out = new Map<string, ProposalChange>()
  for (const c of p.changes) if (c.col === col && !p.decisions[c.id]) out.set(c.entityId, c)
  return out
}

/** Collections the canvas preview applies: what items look like and what they are made of. */
const PREVIEW_COLS: ColKey[] = ['items', 'types', 'typeFolders', 'layers', 'fields', 'hierarchyLevels', 'processors']

/**
 * The project as the canvas shows it while a proposal is under review: the
 * proposal's undecided additions and updates are applied on top of `base`, so
 * new items appear and moved ones sit at their proposed position. Removals
 * are *not* applied (the entity stays, to be drawn struck through), and
 * sections and project scalars keep their live state. Returns
 * `base` itself when nothing applies.
 */
export function previewProject(base: Project, p: Proposal): Project {
  const pending = p.changes.filter(c =>
    !p.decisions[c.id] && c.kind !== 'remove' && c.col !== 'project' && PREVIEW_COLS.includes(c.col as ColKey))
  if (!pending.length) return base
  const out = { ...base } as Project
  for (const col of PREVIEW_COLS) (out as unknown as Record<string, unknown>)[col] = [...list(base, col)]
  applyChanges(out, pending)
  return out
}

// ---------------------------------------------------------------- word diff

export interface DiffPart { t: 'eq' | 'add' | 'del'; s: string }

const tokenize = (s: string) => s.match(/\s+|[A-Za-z0-9_À-ɏ']+|[^\sA-Za-z0-9_À-ɏ']/g) ?? []

/** Word-level diff (LCS) between two strings; whitespace travels with its neighbours. */
export function wordDiff(a: string, b: string): DiffPart[] {
  const A = tokenize(a)
  const B = tokenize(b)
  const n = A.length
  const m = B.length
  // Cap the quadratic table for very long texts; fall back to whole replace.
  if (n * m > 4_000_000) return [{ t: 'del', s: a }, { t: 'add', s: b }]
  const dp: Uint32Array[] = []
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const raw: DiffPart[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (A[i] === B[j]) { raw.push({ t: 'eq', s: A[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { raw.push({ t: 'del', s: A[i] }); i++ }
    else { raw.push({ t: 'add', s: B[j] }); j++ }
  }
  while (i < n) raw.push({ t: 'del', s: A[i++] })
  while (j < m) raw.push({ t: 'add', s: B[j++] })
  // Merge runs of the same kind; deletions before additions inside a run.
  const out: DiffPart[] = []
  for (const part of raw) {
    const last = out[out.length - 1]
    if (last && last.t === part.t) last.s += part.s
    else out.push({ ...part })
  }
  return out
}

/** Human-readable rendering of a non-string value for the review panel. */
export function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'string') return v || '—'
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.length ? v.map(fmtValue).join(', ') : '—'
  return JSON.stringify(v)
}
