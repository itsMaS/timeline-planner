import React, { useMemo, useState } from 'react'
import { Lightbulb, Send, X } from 'lucide-react'
import { diffToChanges, type ProposalChange } from '../model/proposal'
import { useActiveBase, useActiveShare, useActiveWhole, useStore } from '../model/store'
import { getIdentity } from '../sync/client'
import { submitSuggestion } from '../sync/proposals'
import { ChangeRow } from './Proposals'

/**
 * Suggest mode for people: while it is on, every edit lands in a draft that
 * only this tab sees. "Review & send" turns the draft (or part of it) into a
 * proposal for the editors to review. Suggest-link tabs are always in this
 * mode; edit-link tabs toggle it from the toolbar.
 */

/** Leave suggest mode, asking first when unsent changes would be lost. */
export function exitSuggestSafely(projectId: string): boolean {
  const st = useStore.getState()
  const base = st.projects.find(p => p.id === projectId)
  const draft = st.drafts[projectId]
  if (!base || !draft) return true
  const n = diffToChanges(base, draft).length
  if (n > 0 && !window.confirm(`Exit suggest mode and discard ${n} unsent change${n === 1 ? '' : 's'}?`)) return false
  st.exitSuggest(projectId)
  return true
}

export function SuggestBar() {
  const activeId = useStore(s => s.activeId)
  const base = useActiveBase()
  const draft = useStore(s => s.drafts[s.activeId])
  const share = useActiveShare()
  const setUI = useStore(s => s.setUI)
  const resetDraft = useStore(s => s.resetDraft)
  const changes = useMemo(() => (draft ? diffToChanges(base, draft) : []), [base, draft])
  if (!draft || !share) return null
  const n = changes.length
  return (
    <div className="suggest-bar">
      <Lightbulb width={14} height={14} />
      <strong>Suggest mode</strong>
      <span className="muted">
        {n === 0
          ? 'your edits are collected here and sent for review instead of changing the project'
          : `${n} pending change${n === 1 ? '' : 's'} — only you can see them until you send`}
      </span>
      <span className="grow" />
      <button className="primary-btn small" disabled={!n} onClick={() => setUI({ overlay: 'suggest' })}>
        <Send width={12} height={12} /> Review &amp; send
      </button>
      <button
        className="ghost-btn add" disabled={!n}
        onClick={() => { if (window.confirm(`Discard ${n} unsent change${n === 1 ? '' : 's'}?`)) resetDraft(activeId, []) }}
      >discard</button>
      {share.role === 'edit' && (
        <button className="ghost-btn add" title="Back to editing the project directly" onClick={() => exitSuggestSafely(activeId)}>
          <X width={12} height={12} /> exit
        </button>
      )}
    </div>
  )
}

export function SuggestModal() {
  const activeId = useStore(s => s.activeId)
  const base = useActiveBase()
  const draft = useActiveWhole()
  const share = useActiveShare()
  const setUI = useStore(s => s.setUI)
  const resetDraft = useStore(s => s.resetDraft)
  const exitSuggest = useStore(s => s.exitSuggest)
  const showToast = useStore(s => s.showToast)
  const changes = useMemo(() => diffToChanges(base, draft), [base, draft])
  const [title, setTitle] = useState(() => `Suggestion from ${getIdentity().name}`)
  const [summary, setSummary] = useState('')
  const [checked, setChecked] = useState<Set<string>>(() => new Set(changes.map(c => c.id)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = () => setUI({ overlay: null })
  const toggle = (id: string) => setChecked(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const all = checked.size === changes.length

  const send = async () => {
    const selected: ProposalChange[] = changes.filter(c => checked.has(c.id))
    const rest = changes.filter(c => !checked.has(c.id))
    if (!selected.length) return
    setBusy(true)
    setError(null)
    try {
      await submitSuggestion(activeId, title.trim() || 'Suggestion', summary.trim(), selected)
      // Whatever was not sent stays in the draft; an editor who sent everything goes back to direct editing.
      if (rest.length || share?.role === 'suggest') resetDraft(activeId, rest)
      else exitSuggest(activeId)
      showToast(`Sent ${selected.length} change${selected.length === 1 ? '' : 's'} for review.`)
      close()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-scrim" onPointerDown={e => { if (e.target === e.currentTarget) close() }}>
      <div className="modal suggest">
        <div className="modal-head">
          <Lightbulb width={16} height={16} />
          <strong>Send suggestion</strong>
          <span className="grow" />
          <button className="ghost-btn" onClick={close}><X width={16} height={16} /></button>
        </div>
        <div className="field">
          <label>Title</label>
          <input className="input" value={title} maxLength={120} onChange={e => setTitle(e.target.value)} />
        </div>
        <div className="field">
          <label>Why <span className="muted">— optional, shown to the reviewer</span></label>
          <textarea className="input" rows={2} value={summary} maxLength={2000} onChange={e => setSummary(e.target.value)} />
        </div>
        <div className="field">
          <label>
            Changes <span className="muted">({checked.size} of {changes.length} selected)</span>
            <button className="link-btn right" onClick={() => setChecked(all ? new Set() : new Set(changes.map(c => c.id)))}>
              {all ? 'none' : 'all'}
            </button>
          </label>
          <div className="suggest-changes">
            {changes.map(c => (
              <ChangeRow key={c.id} proj={draft} change={c} conflict="none" checked={checked.has(c.id)} onToggle={() => toggle(c.id)} />
            ))}
            {changes.length === 0 && <div className="sb-hint">nothing changed yet</div>}
          </div>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="modal-foot between">
          <span className="muted small">Unselected changes stay in your draft.</span>
          <button className="primary-btn" disabled={busy || !checked.size} onClick={send}>
            <Send width={13} height={13} /> {busy ? 'Sending…' : 'Send for review'}
          </button>
        </div>
      </div>
    </div>
  )
}
