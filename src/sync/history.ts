import type { ProposalChange } from '../model/proposal'
import { useStore } from '../model/store'
import { getIdentity, rpc, SUPABASE_KEY, SUPABASE_URL } from './client'

/**
 * Change history: every change that reaches a shared document is recorded per
 * entity with who made it. Entries are buffered and coalesced (a burst of
 * keystrokes on one description becomes one entry: first `before`, last
 * `after`) and flushed after a short pause, when the tab hides, and on unload.
 */

export interface HistoryEntry {
  id: number
  col: string
  entityId: string
  kind: ProposalChange['kind']
  before: unknown | null
  after: unknown | null
  author: { name?: string; color?: string }
  source: string
  at: string
}

interface Pending { col: string; entityId: string; kind: ProposalChange['kind']; before: unknown; after: unknown; at: string }

const FLUSH_AFTER = 4_000
const MAX_BUFFER = 60

const buffers = new Map<string, { source: string; entries: Map<string, Pending>; timer?: ReturnType<typeof setTimeout> }>()

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const editTokenOf = (projectId: string): string | null => {
  const share = useStore.getState().shares[projectId]
  return share?.role === 'edit' ? share.editToken : null
}

/** Store hook: record entity-level changes of one edit. */
export function onHistory(projectId: string, changes: ProposalChange[], source: string): void {
  if (!changes.length || !editTokenOf(projectId)) return
  const key = `${projectId}|${source}`
  let buf = buffers.get(key)
  if (!buf) { buf = { source, entries: new Map() }; buffers.set(key, buf) }
  const now = new Date().toISOString()
  for (const c of changes) {
    const k = `${c.col}:${c.entityId}`
    const prev = buf.entries.get(k)
    if (prev) {
      // Coalesce: keep the original before, take the newest after; add+remove cancels out.
      if (prev.kind === 'add' && c.kind === 'remove') { buf.entries.delete(k); continue }
      prev.after = c.after
      prev.at = now
      if (prev.kind === 'remove' && c.kind === 'add') prev.kind = 'update'
      if (prev.kind === 'update' && c.kind === 'remove') prev.kind = 'remove'
    } else {
      buf.entries.set(k, { col: c.col, entityId: c.entityId, kind: c.kind, before: c.before, after: c.after, at: now })
    }
  }
  clearTimeout(buf.timer)
  if (buf.entries.size >= MAX_BUFFER) void flush(key)
  else buf.timer = setTimeout(() => void flush(key), FLUSH_AFTER)
}

function take(key: string): { projectId: string; source: string; entries: Pending[] } | null {
  const buf = buffers.get(key)
  if (!buf) return null
  clearTimeout(buf.timer)
  buffers.delete(key)
  const entries = [...buf.entries.values()].filter(e => !same(e.before, e.after))
  if (!entries.length) return null
  return { projectId: key.slice(0, key.indexOf('|')), source: buf.source, entries }
}

async function flush(key: string): Promise<void> {
  const batch = take(key)
  if (!batch) return
  const token = editTokenOf(batch.projectId)
  if (!token) return
  try {
    await rpc('history_append', { p_edit_token: token, p_author: getIdentity(), p_source: batch.source, p_entries: batch.entries })
  } catch (e) {
    console.warn('[history] append failed', e)
  }
}

/** Send everything buffered right now (tab hiding / closing): fire-and-forget with keepalive. */
export function flushHistory(): void {
  for (const key of [...buffers.keys()]) {
    const batch = take(key)
    if (!batch) continue
    const token = editTokenOf(batch.projectId)
    if (!token) continue
    try {
      void fetch(`${SUPABASE_URL}/rest/v1/rpc/history_append`, {
        method: 'POST', keepalive: true,
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_edit_token: token, p_author: getIdentity(), p_source: batch.source, p_entries: batch.entries }),
      })
    } catch { /* best effort */ }
  }
}

/** History of one entity, newest first. Works with any of the three links. */
export async function fetchHistory(projectId: string, entityId: string): Promise<HistoryEntry[]> {
  const share = useStore.getState().shares[projectId]
  if (!share) return []
  const token = share.editToken ?? share.suggestToken ?? share.viewToken
  const rows = await rpc<HistoryEntry[] | null>('history_list', { p_token: token, p_entity_id: entityId, p_limit: 50 })
  return rows ?? []
}
