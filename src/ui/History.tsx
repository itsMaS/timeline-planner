import React, { useEffect, useState } from 'react'
import { History as HistoryIcon, RotateCcw } from 'lucide-react'
import type { ColKey } from '../model/patch'
import { changedFields, type ProposalChange } from '../model/proposal'
import { useActiveShare, useActiveWhole, useCanEdit, useStore, useSuggesting } from '../model/store'
import { fetchHistory, type HistoryEntry } from '../sync/history'
import { ChangeBody, FIELD_LABEL } from './Proposals'

/**
 * Per-entity change history in the Inspector: who changed what and when, with
 * the diff of each entry on demand and a way to restore the earlier version
 * (which becomes a suggestion when the tab is in suggest mode).
 */

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  if (s < 86400 * 14) return `${Math.floor(s / 86400)} d ago`
  return new Date(iso).toLocaleDateString()
}

const toChange = (e: HistoryEntry): ProposalChange =>
  ({ id: String(e.id), col: e.col as ColKey, kind: e.kind, entityId: e.entityId, before: e.before, after: e.after })

function summary(e: HistoryEntry): string {
  if (e.kind === 'add') return 'created it'
  if (e.kind === 'remove') return 'deleted it'
  const keys = changedFields(toChange(e)).map(f => FIELD_LABEL[f.key] ?? f.key)
  if (!keys.length) return 'changed it'
  return `changed ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ` +${keys.length - 3}` : ''}`
}

export function HistorySection({ col, entityId }: { col: ColKey; entityId: string }) {
  const activeId = useStore(s => s.activeId)
  const share = useActiveShare()
  const proj = useActiveWhole()
  const canEdit = useCanEdit()
  const suggesting = useSuggesting()
  const mutate = useStore(s => s.mutate)
  const showToast = useStore(s => s.showToast)
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<number | null>(null)

  useEffect(() => {
    setEntries(null)
    setExpanded(null)
    if (!open || !share) return
    let cancelled = false
    fetchHistory(activeId, entityId)
      .then(r => { if (!cancelled) setEntries(r) })
      .catch(e => { if (!cancelled) setError((e as Error).message) })
    return () => { cancelled = true }
  }, [open, entityId, activeId, share?.id])

  if (!share) return null

  const restore = (e: HistoryEntry) => {
    mutate(p => {
      const list = p[col] as unknown as { id: string }[]
      const i = list.findIndex(x => x.id === entityId)
      if (e.kind === 'add') { if (i >= 0) list.splice(i, 1); return }
      const snapshot = structuredClone(e.before) as { id: string }
      if (i >= 0) list[i] = snapshot
      else list.push(snapshot)
    }, { source: 'restore' })
    showToast(suggesting ? 'Earlier version added to your suggestion.' : 'Earlier version restored.', !suggesting)
  }

  return (
    <div className="field history">
      <label>
        <HistoryIcon width={12} height={12} /> History
        <button className="link-btn right" onClick={() => setOpen(v => !v)}>{open ? 'hide' : 'show'}</button>
      </label>
      {open && (
        <div className="hist-list">
          {error && <div className="prop-error">{error}</div>}
          {!error && entries === null && <div className="sb-hint">loading…</div>}
          {entries && entries.length === 0 && <div className="sb-hint">no recorded changes yet</div>}
          {entries?.map(e => (
            <div key={e.id} className={`hist-entry ${expanded === e.id ? 'open' : ''}`}>
              <button className="hist-head" onClick={() => setExpanded(x => (x === e.id ? null : e.id))}>
                <span className="creator-dot" style={{ background: e.author?.color ?? '#888' }} />
                <b>{e.author?.name || 'Someone'}</b>
                <span>{summary(e)}</span>
                {e.source.startsWith('proposal') && <span className="badge accent">via suggestion</span>}
                {(e.source === 'undo' || e.source === 'redo' || e.source === 'restore') && <span className="badge">{e.source}</span>}
                <span className="muted hist-when">{ago(e.at)}</span>
              </button>
              {expanded === e.id && (
                <div className="hist-body">
                  <ChangeBody proj={proj} change={toChange(e)} />
                  {canEdit && (
                    <button className="ghost-btn add" onClick={() => restore(e)}>
                      <RotateCcw width={12} height={12} />
                      {e.kind === 'add' ? (suggesting ? 'suggest deleting it again' : 'undo creation')
                        : suggesting ? 'suggest restoring the earlier version' : 'restore the earlier version'}
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
