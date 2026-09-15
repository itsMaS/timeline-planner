import { applyChanges, type Decision, type Proposal, type ProposalChange } from '../model/proposal'
import { useStore } from '../model/store'
import { getIdentity, rpc } from './client'

/**
 * Proposals (suggested changes awaiting review) for shared tabs opened with an
 * edit link. They live in their own table and are fetched alongside the
 * document refresh; applying accepted changes is one ordinary `mutate`, so it
 * is undoable and reaches collaborators through the normal sync path.
 */

const store = () => useStore.getState()
/** Newest `updatedAt` seen per project, so refreshes only fetch what changed. */
const lastSeen = new Map<string, string>()

interface ListResult { version: number; ids: string[]; rows: Proposal[] }

/** Reviewing (apply / reject / delete) needs the edit link. */
const editTokenOf = (projectId: string): string | null => {
  const share = store().shares[projectId]
  return share?.role === 'edit' ? share.editToken : null
}
/** Listing and creating proposals works with the edit or the suggest link. */
const proposeTokenOf = (projectId: string): string | null => {
  const share = store().shares[projectId]
  return share?.editToken ?? share?.suggestToken ?? null
}

export async function refreshProposals(projectId: string, full = false): Promise<void> {
  const token = proposeTokenOf(projectId)
  if (!token) return
  const since = full ? null : lastSeen.get(projectId) ?? null
  let r: ListResult | null
  try {
    r = await rpc<ListResult | null>('proposal_list', { p_edit_token: token, p_since: since })
  } catch (e) {
    console.warn('[proposals] refresh failed', e)
    return
  }
  if (!r) return
  const st = store()
  const cur = st.proposals[projectId] ?? []
  const keep = new Set(r.ids)
  const byId = new Map(cur.filter(p => keep.has(p.id)).map(p => [p.id, p]))
  const fresh: Proposal[] = []
  for (const row of r.rows) {
    if (since && !byId.has(row.id) && row.status === 'open') fresh.push(row)
    byId.set(row.id, row)
  }
  const merged = [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  let newest = lastSeen.get(projectId) ?? ''
  for (const p of merged) if (p.updatedAt > newest) newest = p.updatedAt
  if (newest) lastSeen.set(projectId, newest)
  st.setProposals(projectId, merged)
  // Announce proposals that arrived while this tab was open (not the initial load); reviewers only.
  if (fresh.length && st.activeId === projectId && editTokenOf(projectId)) {
    st.showToast(fresh.length === 1 ? `New proposal: “${fresh[0].title}”` : `${fresh.length} new proposals to review`)
  }
}

function replaceRow(projectId: string, row: Proposal) {
  const st = store()
  const cur = st.proposals[projectId] ?? []
  st.setProposals(projectId, cur.some(p => p.id === row.id) ? cur.map(p => (p.id === row.id ? row : p)) : [...cur, row])
  if (row.updatedAt > (lastSeen.get(projectId) ?? '')) lastSeen.set(projectId, row.updatedAt)
}

/**
 * Record decisions for some of a proposal's changes. Changes marked 'applied'
 * are applied to the document first, as a single undoable edit.
 */
export async function decideProposal(projectId: string, proposal: Proposal, decisions: Record<string, Decision>): Promise<void> {
  const token = editTokenOf(projectId)
  if (!token) throw new Error('This tab cannot review proposals')
  const st = store()
  if (st.activeId !== projectId) throw new Error('Switch to the tab first')
  // Record the decision first: if the request fails nothing has changed locally.
  const row = await rpc<Proposal | null>('proposal_decide', { p_edit_token: token, p_id: proposal.id, p_decisions: decisions })
  if (!row) {
    st.setProposals(projectId, (st.proposals[projectId] ?? []).filter(p => p.id !== proposal.id))
    throw new Error('This proposal no longer exists')
  }
  const toApply = proposal.changes.filter(c => decisions[c.id] === 'applied')
  if (toApply.length) st.mutate(p => applyChanges(p, toApply))
  replaceRow(projectId, row)
}

export async function deleteProposal(projectId: string, id: string): Promise<void> {
  const token = editTokenOf(projectId)
  if (!token) return
  await rpc<boolean>('proposal_delete', { p_edit_token: token, p_id: id })
  const st = store()
  st.setProposals(projectId, (st.proposals[projectId] ?? []).filter(p => p.id !== id))
}

/**
 * Turn (part of) the suggest-mode draft into a proposal. Works with the edit
 * and the suggest link; the author is this browser's display identity.
 */
export async function submitSuggestion(projectId: string, title: string, summary: string, changes: ProposalChange[]): Promise<Proposal> {
  const token = proposeTokenOf(projectId)
  if (!token) throw new Error('This tab cannot send suggestions')
  if (!changes.length) throw new Error('Nothing to send')
  const st = store()
  const share = st.shares[projectId]
  const row = await rpc<Proposal | null>('proposal_create', {
    p_edit_token: token, p_title: title, p_summary: summary, p_author: getIdentity().name,
    p_base_version: share?.version ?? null, p_changes: changes,
  })
  if (!row) throw new Error('This share link is not valid any more')
  replaceRow(projectId, row)
  return row
}
