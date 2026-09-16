import React, { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowLeft, Check, ChevronDown, ChevronRight, RefreshCw, Trash2, X } from 'lucide-react'
import {
  changeLabel, changedFields, conflictOf, fmtValue, wordDiff,
  type Conflict, type Decision, type Proposal, type ProposalChange,
} from '../model/proposal'
import { coerceValue, formatValue } from '../model/fields'
import { useActiveProject, useActiveShare, useStore } from '../model/store'
import type { Project } from '../model/types'
import { decideProposal, deleteProposal, refreshProposals } from '../sync/proposals'
import { nav } from './nav'

/**
 * Review panel for proposals (suggested changes from agents or collaborators).
 * Lists open proposals; opening one shows every change with a git-style diff.
 * Each change can be applied or rejected on its own (buttons on the row, or
 * in the Inspector when its item is selected), or in bulk through the
 * checkboxes; every apply is one undo step. While a proposal is open the
 * canvas previews it, and selecting a previewed item scrolls the panel to its
 * change. Decided proposals stay in a collapsible history.
 */

/** Decide one or more changes of a proposal and report the outcome as a toast. */
export async function decideChanges(projectId: string, proposal: Proposal, ids: string[], d: Decision): Promise<void> {
  if (!ids.length) return
  const decisions: Record<string, Decision> = {}
  for (const id of ids) decisions[id] = d
  await decideProposal(projectId, proposal, decisions)
  const n = ids.length
  useStore.getState().showToast(d === 'applied'
    ? `Applied ${n} change${n === 1 ? '' : 's'}.`
    : `Rejected ${n} change${n === 1 ? '' : 's'}.`, d === 'applied')
}

/** The pending change of the proposal under review that targets the given entity, if any. */
export function usePendingChange(col: ProposalChange['col'], entityId: string | null): { proposal: Proposal; change: ProposalChange } | null {
  const proposal = useStore(s => (s.ui.reviewProposalId ? s.proposals[s.activeId]?.find(p => p.id === s.ui.reviewProposalId) : undefined))
  return useMemo(() => {
    if (!entityId || !proposal || proposal.status !== 'open') return null
    const change = proposal.changes.find(c => c.col === col && c.entityId === entityId && !proposal.decisions[c.id])
    return change ? { proposal, change } : null
  }, [proposal, col, entityId])
}

/** Selection key → the proposal change it corresponds to (items, sections and branches). */
function selectionTarget(sel: string[]): { col: ProposalChange['col']; id: string } | null {
  if (sel.length !== 1) return null
  const k = sel[0]
  if (k.startsWith('S:')) return { col: 'sections', id: k.slice(2) }
  if (k.startsWith('B:')) return { col: 'branches', id: k.slice(2) }
  return { col: 'items', id: k }
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

const countDecisions = (p: Proposal) => {
  let applied = 0
  let rejected = 0
  for (const c of p.changes) {
    const d = p.decisions[c.id]
    if (d === 'applied') applied++
    else if (d === 'rejected') rejected++
  }
  return { applied, rejected, pending: p.changes.length - applied - rejected }
}

export function ProposalsPanel() {
  const proj = useActiveProject()
  const activeId = useStore(s => s.activeId)
  const share = useActiveShare()
  const proposals = useStore(s => s.proposals[s.activeId]) ?? []
  const reviewId = useStore(s => s.ui.reviewProposalId)
  const setUI = useStore(s => s.setUI)
  const [showDone, setShowDone] = useState(false)
  const [busy, setBusy] = useState(false)

  const open = proposals.filter(p => p.status === 'open')
  const done = proposals.filter(p => p.status !== 'open')
  const review = reviewId ? proposals.find(p => p.id === reviewId) : undefined

  // Leave the review view once its proposal is gone or fully decided.
  useEffect(() => {
    if (reviewId && (!review || review.status !== 'open')) setUI({ reviewProposalId: null })
  }, [reviewId, review])

  const refresh = async () => {
    setBusy(true)
    try { await refreshProposals(activeId, true) } finally { setBusy(false) }
  }

  if (review && review.status === 'open') {
    return <ProposalReview proj={proj} projectId={activeId} proposal={review} back={() => setUI({ reviewProposalId: null })} />
  }

  if (share?.role === 'suggest') {
    // Suggesters see what they (and others) sent and how it was decided, but cannot review.
    return (
      <div className="sb-body">
        {proposals.length === 0 && <div className="sb-hint">nothing sent yet · use Review &amp; send in the bar above the timeline</div>}
        {[...proposals].reverse().map(p => {
          const n = countDecisions(p)
          return (
            <div key={p.id} className={`prop-row ${p.status === 'open' ? '' : 'done'}`}>
              <div className="prop-title">{p.title}</div>
              <div className="prop-meta">
                {p.author} · {ago(p.updatedAt)} · {p.status === 'open'
                  ? `${n.pending} of ${p.changes.length} awaiting review`
                  : `${n.applied} applied · ${n.rejected} rejected`}
              </div>
            </div>
          )
        })}
        <div className="row gap prop-actions">
          <button className="ghost-btn add" onClick={refresh} disabled={busy}>
            <RefreshCw width={12} height={12} className={busy ? 'spin' : ''} /> refresh
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="sb-body">
      {open.length === 0 && (
        <div className="sb-hint">no suggestions waiting · agents with the edit link can propose changes here</div>
      )}
      {open.map(p => (
        <div key={p.id} className="prop-row" onClick={() => setUI({ reviewProposalId: p.id })} title="Review this proposal">
          <div className="prop-title">{p.title}</div>
          <div className="prop-meta">
            {p.author} · {ago(p.createdAt)} · {p.changes.length} change{p.changes.length === 1 ? '' : 's'}
            {countDecisions(p).pending < p.changes.length && ' · partly reviewed'}
          </div>
        </div>
      ))}
      <div className="row gap prop-actions">
        <button className="ghost-btn add" onClick={refresh} disabled={busy}>
          <RefreshCw width={12} height={12} className={busy ? 'spin' : ''} /> refresh
        </button>
        {done.length > 0 && (
          <button className="ghost-btn add" onClick={() => setShowDone(v => !v)}>
            {showDone ? <ChevronDown width={12} height={12} /> : <ChevronRight width={12} height={12} />} history ({done.length})
          </button>
        )}
      </div>
      {showDone && done.map(p => {
        const n = countDecisions(p)
        return (
          <div key={p.id} className="prop-row done">
            <div className="prop-title">{p.title}</div>
            <div className="prop-meta">
              {p.author} · {ago(p.updatedAt)} · {n.applied} applied · {n.rejected} rejected
              <button
                className="ghost-btn row-act" title="Remove from history"
                onClick={() => { void deleteProposal(activeId, p.id) }}
              ><Trash2 width={12} height={12} /></button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------- review

const CONFLICT_TEXT: Record<Conflict, string> = {
  none: '',
  modified: 'Changed since this was proposed — applying overwrites the current version.',
  missing: 'No longer exists — applying re-creates it.',
  exists: 'Already exists — applying overwrites it.',
}

function ProposalReview(props: { proj: Project; projectId: string; proposal: Proposal; back: () => void }) {
  const { proj, projectId, proposal } = props
  const pending = useMemo(() => proposal.changes.filter(c => !proposal.decisions[c.id]), [proposal])
  const conflicts = useMemo(() => new Map(pending.map(c => [c.id, conflictOf(proj, c)])), [pending, proj])
  // Everything without a conflict starts ticked.
  const [checked, setChecked] = useState<Set<string>>(() => new Set(pending.filter(c => conflicts.get(c.id) === 'none').map(c => c.id)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setChecked(prev => new Set(pending.filter(c => prev.has(c.id) || (!prev.size && conflicts.get(c.id) === 'none')).map(c => c.id)))
  }, [pending])

  const toggle = (id: string) => setChecked(s => {
    const n = new Set(s)
    if (n.has(id)) n.delete(id); else n.add(id)
    return n
  })
  const all = checked.size === pending.length
  const toggleAll = () => setChecked(all ? new Set() : new Set(pending.map(c => c.id)))

  const run = async (ids: string[], d: Decision) => {
    if (!ids.length) return
    setBusy(true)
    setError(null)
    try {
      await decideChanges(projectId, proposal, ids, d)
      setChecked(prev => { const n = new Set(prev); for (const id of ids) n.delete(id); return n })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const decide = (d: Decision) => run([...checked], d)

  // The change whose entity is selected on the canvas is highlighted and scrolled into view.
  const selection = useStore(s => s.ui.selection)
  const target = useMemo(() => selectionTarget(selection), [selection])
  const focusedId = target ? pending.find(c => c.col === target.col && c.entityId === target.id)?.id ?? null : null
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  useEffect(() => {
    if (!focusedId) return
    rowRefs.current.get(focusedId)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [focusedId])

  const discard = async () => {
    if (!window.confirm(`Discard “${proposal.title}” and all its remaining suggestions?`)) return
    setBusy(true)
    try { await deleteProposal(projectId, proposal.id); props.back() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  const decided = proposal.changes.length - pending.length

  return (
    <div className="sb-body prop-review">
      <div className="row gap">
        <button className="ghost-btn" title="Back to the list" onClick={props.back}><ArrowLeft width={14} height={14} /></button>
        <strong className="grow prop-title">{proposal.title}</strong>
      </div>
      <div className="prop-meta">{proposal.author} · {ago(proposal.createdAt)}{decided > 0 && ` · ${decided} already decided`}</div>
      {proposal.summary && <p className="prop-summary">{proposal.summary}</p>}

      {pending.length > 0 && (
        <label className="prop-all">
          <input type="checkbox" checked={all} onChange={toggleAll} />
          <span>{checked.size} of {pending.length} selected</span>
        </label>
      )}
      {pending.map(c => (
        <ChangeRow
          key={c.id} proj={proj} change={c} conflict={conflicts.get(c.id) ?? 'none'}
          checked={checked.has(c.id)} onToggle={() => toggle(c.id)}
          focused={c.id === focusedId} busy={busy} onDecide={d => run([c.id], d)}
          rowRef={el => { if (el) rowRefs.current.set(c.id, el); else rowRefs.current.delete(c.id) }}
        />
      ))}
      {pending.length === 0 && <div className="sb-hint">every change has been decided</div>}

      {error && <div className="prop-error">{error}</div>}
      <div className="prop-buttons">
        <button className="primary-btn" disabled={busy || !checked.size} onClick={() => decide('applied')}>
          <Check width={13} height={13} /> Apply selected
        </button>
        <button className="ghost-btn add" disabled={busy || !checked.size} onClick={() => decide('rejected')}>
          <X width={12} height={12} /> reject selected
        </button>
        <button className="ghost-btn add danger" disabled={busy} onClick={discard}>
          <Trash2 width={12} height={12} /> discard proposal
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- one change

export const FIELD_LABEL: Record<string, string> = {
  title: 'title', description: 'description', tags: 'tags', link: 'link', images: 'images', fieldValues: 'fields',
  pos: 'position', duration: 'duration', typeId: 'type', layerId: 'layer', pathId: 'branch path',
  name: 'name', icon: 'icon', color: 'color', defaultLayerId: 'default layer', fields: 'fields', folderId: 'folder',
  kind: 'kind', help: 'help text', required: 'required', showInTooltip: 'show in tooltip', defaultValue: 'default',
  maxLength: 'max length', min: 'min', max: 'max', decimals: 'decimals', unit: 'unit', refTargets: 'can reference',
  refMultiple: 'multiple', refShowLinks: 'connectors', op: 'operation', fieldId: 'field', targets: 'include', processors: 'processors',
  start: 'start', end: 'end', depth: 'depth', parentId: 'parent', collapsed: 'collapsed',
  eye: 'hidden', pin: 'pinned', size: 'size', minZoom: 'min zoom', filters: 'filters', mode: 'mode',
  forkPos: 'fork', joinPos: 'join', paths: 'paths', createdBy: 'created by',
}

/** Resolve ids to names where the field is a reference, so diffs read naturally. */
function display(proj: Project, key: string, v: unknown): unknown {
  if (typeof v !== 'string') return v
  if (key === 'typeId') return proj.types.find(t => t.id === v)?.name ?? v
  if (key === 'layerId' || key === 'defaultLayerId') return proj.layers.find(l => l.id === v)?.name ?? v
  if (key === 'folderId' || key === 'parentId') return proj.typeFolders.find(f => f.id === v)?.name ?? v
  return v
}

function Diff({ before, after }: { before: string; after: string }) {
  const parts = useMemo(() => wordDiff(before, after), [before, after])
  return (
    <span className="diff">
      {parts.map((p, i) => p.t === 'eq'
        ? <span key={i}>{p.s}</span>
        : <span key={i} className={p.t === 'add' ? 'diff-add' : 'diff-del'}>{p.s}</span>)}
    </span>
  )
}

function ValueDelta({ proj, k, before, after }: { proj: Project; k: string; before: unknown; after: unknown }) {
  const b = display(proj, k, before)
  const a = display(proj, k, after)
  if (typeof b === 'string' && typeof a === 'string') return <Diff before={b} after={a} />
  if (k === 'fieldValues' && typeof b === 'object' && typeof a === 'object') {
    const bo = (b ?? {}) as Record<string, unknown>
    const ao = (a ?? {}) as Record<string, unknown>
    // Values are typed per field (text, number, reference ids) — render each through its definition.
    const text = (id: string, v: unknown) => {
      const f = proj.fields.find(x => x.id === id)
      if (v === undefined || v === null) return ''
      if (f) return formatValue(proj, f, coerceValue(f, v))
      return Array.isArray(v) ? v.join(', ') : String(v)
    }
    const keys = [...new Set([...Object.keys(bo), ...Object.keys(ao)])].filter(id => text(id, bo[id]) !== text(id, ao[id]))
    const nameOf = (id: string) => proj.fields.find(f => f.id === id)?.name ?? id
    return (
      <span className="diff">
        {keys.map(id => <div key={id}><em>{nameOf(id)}:</em> <Diff before={text(id, bo[id])} after={text(id, ao[id])} /></div>)}
      </span>
    )
  }
  return (
    <span className="diff">
      <span className="diff-del">{fmtValue(b)}</span> <span className="diff-add">{fmtValue(a)}</span>
    </span>
  )
}

/** Fields worth showing for a freshly added entity. */
function addedSummary(proj: Project, c: ProposalChange): { k: string; v: unknown }[] {
  const e = (c.after ?? {}) as Record<string, unknown>
  const out: { k: string; v: unknown }[] = []
  for (const [k, v] of Object.entries(e)) {
    if (k === 'id' || k === 'createdBy') continue
    if (v === null || v === '' || (Array.isArray(v) && v.length === 0)) continue
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0) continue
    if (typeof v === 'boolean' && !v) continue
    if (k === 'duration' && v === 0) continue
    if (k === 'name' || k === 'title') continue // already in the heading
    out.push({ k, v: display(proj, k, v) })
  }
  return out
}

/** The diff part of a change: changed fields, the new entity, or the deletion notice. */
export function ChangeBody({ proj, change: c }: { proj: Project; change: ProposalChange }) {
  const fields = useMemo(() => changedFields(c), [c])
  return (
    <>
      {c.kind === 'update' && fields.map(f => (
        <div key={f.key} className="prop-field">
          <em>{FIELD_LABEL[f.key] ?? f.key}</em>
          <ValueDelta proj={proj} k={f.key} before={f.before} after={f.after} />
        </div>
      ))}
      {c.kind === 'add' && addedSummary(proj, c).map(({ k, v }) => (
        <div key={k} className="prop-field">
          <em>{FIELD_LABEL[k] ?? k}</em>
          <span className="diff"><span className="diff-add">{fmtValue(v)}</span></span>
        </div>
      ))}
      {c.kind === 'remove' && (
        <div className="prop-field"><span className="diff"><span className="diff-del">will be deleted</span></span></div>
      )}
      {c.kind === 'set' && (
        <div className="prop-field">
          <ValueDelta proj={proj} k={c.entityId} before={c.before} after={c.after} />
        </div>
      )}
    </>
  )
}

/**
 * Select the entity a change targets and bring it into view. Items under
 * review are previewed on the canvas (added ones included), sections are
 * framed; other entities have no place on the timeline.
 */
function jumpToChange(proj: Project, c: ProposalChange): boolean {
  const st = useStore.getState()
  if (c.col === 'items') {
    const previewed = st.ui.reviewProposalId !== null && c.kind === 'add'
    if (!previewed && !proj.items.some(it => it.id === c.entityId)) return false
    nav.current?.flyToItem(c.entityId)
    return true
  }
  if (c.col === 'sections' && proj.sections.some(sc => sc.id === c.entityId)) {
    st.select([`S:${c.entityId}`])
    nav.current?.flyToSection(c.entityId)
    return true
  }
  return false
}

const canJumpTo = (proj: Project, c: ProposalChange, reviewing: boolean): boolean => {
  if (c.col === 'items') return (reviewing && c.kind === 'add') || proj.items.some(it => it.id === c.entityId)
  if (c.col === 'sections') return proj.sections.some(sc => sc.id === c.entityId)
  return false
}

/** Apply / reject buttons for a single change. */
function DecideButtons({ busy, onDecide, kind }: { busy?: boolean; onDecide: (d: Decision) => void; kind: ChangeKindLike }) {
  const verb = kind === 'add' ? 'Create' : kind === 'remove' ? 'Delete' : 'Apply'
  return (
    <span className="prop-decide">
      <button className="ghost-btn ok" title={`${verb} this change`} disabled={busy} onClick={e => { e.preventDefault(); e.stopPropagation(); onDecide('applied') }}>
        <Check width={13} height={13} />
      </button>
      <button className="ghost-btn danger" title="Reject this change" disabled={busy} onClick={e => { e.preventDefault(); e.stopPropagation(); onDecide('rejected') }}>
        <X width={13} height={13} />
      </button>
    </span>
  )
}
type ChangeKindLike = ProposalChange['kind']

export function ChangeRow(props: {
  proj: Project
  change: ProposalChange
  conflict: Conflict
  checked: boolean
  onToggle: () => void
  /** The change's entity is selected on the canvas. */
  focused?: boolean
  busy?: boolean
  /** Present when the row can be decided on its own (review panel), absent in the send dialog. */
  onDecide?: (d: Decision) => void
  rowRef?: (el: HTMLDivElement | null) => void
}) {
  const { proj, change: c, conflict } = props
  const label = changeLabel(c)
  const reviewing = useStore(s => s.ui.reviewProposalId !== null)
  const canJump = !!props.onDecide && canJumpTo(proj, c, reviewing)
  return (
    <div ref={props.rowRef} className={`prop-change ${props.checked ? 'on' : ''} ${props.focused ? 'focus' : ''} ${c.kind}`}>
      <label className="prop-change-head">
        <input type="checkbox" checked={props.checked} onChange={props.onToggle} />
        <span className="prop-kind">{label.kind}</span>
        <span
          className={`prop-name ${canJump ? 'jump' : ''}`}
          title={canJump ? 'Show it on the timeline' : undefined}
          onClick={e => { if (canJump) { e.preventDefault(); jumpToChange(proj, c) } }}
        >{label.name}</span>
        <span className="prop-tail">
          <span className={`prop-verb ${c.kind}`}>{label.verb}</span>
          {props.onDecide && <DecideButtons busy={props.busy} onDecide={props.onDecide} kind={c.kind} />}
        </span>
      </label>
      {conflict !== 'none' && (
        <div className="prop-conflict"><AlertTriangle width={12} height={12} /> {CONFLICT_TEXT[conflict]}</div>
      )}
      {c.note && <div className="prop-note">{c.note}</div>}
      <ChangeBody proj={proj} change={c} />
    </div>
  )
}

/**
 * Inspector card for the pending change that targets the selected entity:
 * the same diff as the review panel plus its own apply / reject buttons, so
 * a change can be decided right where its effect is visible.
 */
export function ProposalChangeCard({ proposal, change: c }: { proposal: Proposal; change: ProposalChange }) {
  const proj = useActiveProject()
  const projectId = useStore(s => s.activeId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const conflict = useMemo(() => conflictOf(proj, c), [proj, c])
  const label = changeLabel(c)
  const decide = async (d: Decision) => {
    setBusy(true)
    setError(null)
    try { await decideChanges(projectId, proposal, [c.id], d) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className={`insp-proposal prop-change ${c.kind}`}>
      <div className="prop-change-head">
        <span className="prop-kind">Proposal</span>
        <span className="prop-name">{proposal.title}</span>
        <span className={`prop-verb ${c.kind}`}>{label.verb} by {proposal.author}</span>
      </div>
      {conflict !== 'none' && (
        <div className="prop-conflict"><AlertTriangle width={12} height={12} /> {CONFLICT_TEXT[conflict]}</div>
      )}
      {c.note && <div className="prop-note">{c.note}</div>}
      <ChangeBody proj={proj} change={c} />
      {error && <div className="prop-error">{error}</div>}
      <div className="prop-buttons row">
        <button className="primary-btn" disabled={busy} onClick={() => decide('applied')}>
          <Check width={13} height={13} /> {c.kind === 'add' ? 'Create' : c.kind === 'remove' ? 'Delete' : 'Apply'}
        </button>
        <button className="ghost-btn add" disabled={busy} onClick={() => decide('rejected')}>
          <X width={12} height={12} /> reject
        </button>
      </div>
    </div>
  )
}
