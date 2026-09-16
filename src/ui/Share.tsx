import React, { useEffect, useState } from 'react'
import { Check, Cloud, CloudOff, Copy, HelpCircle, KeyRound, Link2, RefreshCw, Trash2, X } from 'lucide-react'
import { useActiveProject, useActiveShare, useActiveSync, useStore, type SyncStatus } from '../model/store'
import { getIdentity, setIdentity } from '../sync/client'
import { manageApiToken, refreshPresence, regenerateLink, shareLink, shareProject, stopSharing } from '../sync/share'

const ROLE_LABEL: Record<string, string> = { edit: 'can edit', suggest: 'can suggest', view: 'viewing' }

const STATUS_LABEL: Record<SyncStatus, string> = {
  connecting: 'Connecting…',
  live: 'Live',
  polling: 'Refreshing every few seconds',
  offline: 'Offline — changes will sync when you reconnect',
  gone: 'Link revoked',
}

export const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('')

/** Small cloud on a shared tab, coloured by sync state. */
export function TabSyncIcon({ projectId }: { projectId: string }) {
  const share = useStore(s => s.shares[projectId])
  const sync = useStore(s => s.sync[projectId])
  if (!share) return null
  const status = sync?.status ?? 'connecting'
  const title = `${share.owner ? 'Shared by you' : share.role === 'edit' ? 'Shared with you (can edit)' : share.role === 'suggest' ? 'Shared with you (can suggest)' : 'Shared with you (view only)'} · ${STATUS_LABEL[status]}${sync?.pending ? ' · saving…' : ''}`
  const Icon = status === 'offline' || status === 'gone' ? CloudOff : Cloud
  return (
    <span className={`tab-sync ${status} ${sync?.pending ? 'pending' : ''}`} title={title}>
      <Icon width={11} height={11} />
    </span>
  )
}

/** Avatars of everyone else on the active shared tab. */
export function PresenceBar() {
  const sync = useActiveSync()
  const peers = (sync?.peers ?? []).filter(p => !p.self)
  if (!peers.length) return null
  const shown = peers.slice(0, 6)
  return (
    <div className="presence" title={peers.map(p => `${p.name} · ${ROLE_LABEL[p.role]}`).join('\n')}>
      {shown.map(p => (
        <span key={p.key} className={`avatar ${p.role}`} style={{ background: p.color }}>{initials(p.name)}</span>
      ))}
      {peers.length > shown.length && <span className="avatar more">+{peers.length - shown.length}</span>}
    </div>
  )
}

function CopyField({ label, value, hint, onRegenerate, onRevoke, onHelp, regenerateTitle = 'Regenerate — the old link stops working' }: {
  label: string; value: string; hint: string; onRegenerate?: () => void; onRevoke?: () => void; onHelp?: () => void; regenerateTitle?: string
}) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(value) } catch {
      const el = document.createElement('textarea')
      el.value = value; document.body.appendChild(el); el.select(); document.execCommand('copy'); el.remove()
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="field">
      <label>
        {label} <span className="muted">— {hint}</span>
        {onHelp && <button className="help-btn" title="How to use the API" onClick={onHelp}><HelpCircle width={13} height={13} /></button>}
      </label>
      <div className="row gap link-row">
        <input className="input grow" readOnly value={value} onFocus={e => e.currentTarget.select()} />
        <button className="ghost-btn" title="Copy" onClick={copy}>
          {copied ? <Check width={14} height={14} /> : <Copy width={14} height={14} />}
        </button>
        {onRegenerate && (
          <button className="ghost-btn" title={regenerateTitle} onClick={onRegenerate}>
            <RefreshCw width={14} height={14} />
          </button>
        )}
        {onRevoke && (
          <button className="ghost-btn danger" title="Revoke — tools using this token stop working" onClick={onRevoke}>
            <Trash2 width={14} height={14} />
          </button>
        )}
      </div>
    </div>
  )
}

export function ShareModal() {
  const proj = useActiveProject()
  const share = useActiveShare()
  const sync = useActiveSync()
  const setUI = useStore(s => s.setUI)
  const showToast = useStore(s => s.showToast)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [me, setMe] = useState(() => getIdentity())

  useEffect(() => { setError(null) }, [proj.id])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  const close = () => setUI({ overlay: null })
  const status = sync?.status ?? 'connecting'

  return (
    <div className="modal-scrim" onPointerDown={e => { if (e.target === e.currentTarget) close() }}>
      <div className="modal share">
        <div className="modal-head">
          <Link2 width={16} height={16} />
          <strong>Share “{proj.name}”</strong>
          <span className="grow" />
          <button className="ghost-btn" onClick={close}><X width={16} height={16} /></button>
        </div>

        {!share ? (
          <>
            <p className="muted">
              Sharing publishes this timeline online and gives you three links: one that lets people edit together in
              real time, one that only lets them suggest changes for you to review, and one that only shows the timeline.
            </p>
            <p className="muted small">
              Pasted images are moved to online storage. Your camera, filters and selection stay private to you.
            </p>
            <div className="modal-foot">
              <button className="primary-btn" disabled={busy} onClick={() => run(async () => { await shareProject(proj.id) })}>
                {busy ? 'Publishing…' : 'Share this timeline'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className={`sync-line ${status}`}>
              <span className="status-dot" />
              <span>{STATUS_LABEL[status]}{sync?.pending ? ' · saving…' : ''}</span>
              <span className="grow" />
              <span className="muted small">{share.owner ? 'You own this timeline' : share.role === 'edit' ? 'You can edit' : share.role === 'suggest' ? 'You can suggest changes' : 'View only'}</span>
            </div>
            {status === 'polling' && (
              <p className="muted small">
                Live updates are unavailable right now (usually because anonymous sign-ins are disabled in Supabase);
                edits still save and refresh every few seconds.
              </p>
            )}

            {share.editToken && (
              <CopyField
                label="Edit link" value={shareLink(share.editToken)} hint="anyone with it can edit"
                onRegenerate={share.owner ? () => {
                  if (window.confirm('Regenerate the edit link? Everyone using the old one loses edit access.'))
                    run(() => regenerateLink(proj.id, 'edit'))
                } : undefined}
              />
            )}
            {share.suggestToken && (
              <CopyField
                label="Suggest link" value={shareLink(share.suggestToken)} hint="can propose changes for you to review, not edit"
                onRegenerate={share.owner ? () => {
                  if (window.confirm('Regenerate the suggest link? Everyone using the old one loses access.'))
                    run(() => regenerateLink(proj.id, 'suggest'))
                } : undefined}
              />
            )}
            <CopyField
              label="View link" value={shareLink(share.viewToken)} hint="read-only preview"
              onRegenerate={share.owner ? () => {
                if (window.confirm('Regenerate the view link? The old one stops working.'))
                  run(() => regenerateLink(proj.id, 'view'))
              } : undefined}
            />

            {share.owner && share.editToken && (
              share.apiToken ? (
                <CopyField
                  label="API token" value={share.apiToken}
                  hint="for tools such as a Unity plugin"
                  regenerateTitle="Rotate — the old token stops working"
                  onHelp={() => setUI({ overlay: 'apihelp' })}
                  onRegenerate={() => {
                    if (window.confirm('Rotate the API token? Every tool using the old one stops working until it gets the new token.'))
                      run(async () => { await manageApiToken(proj.id, 'rotate') })
                  }}
                  onRevoke={() => {
                    if (window.confirm('Revoke the API token? Tools using it lose access. You can create a new one later.'))
                      run(async () => { await manageApiToken(proj.id, 'revoke') })
                  }}
                />
              ) : (
                <div className="field">
                  <label>
                    API token <span className="muted">— lets tools such as a Unity plugin read and update this timeline</span>
                    <button className="help-btn" title="How to use the API" onClick={() => setUI({ overlay: 'apihelp' })}><HelpCircle width={13} height={13} /></button>
                  </label>
                  <div className="row gap">
                    <button className="ghost-btn" disabled={busy} onClick={() => run(async () => { await manageApiToken(proj.id, 'create') })}>
                      <KeyRound width={13} height={13} /> Create API token
                    </button>
                    <button className="ghost-btn" onClick={() => setUI({ overlay: 'apihelp' })}>
                      <HelpCircle width={13} height={13} /> What can it do?
                    </button>
                  </div>
                </div>
              )
            )}

            <div className="field">
              <label>Your name <span className="muted">— shown to collaborators</span></label>
              <div className="row gap">
                <span className="avatar" style={{ background: me.color }}>{initials(me.name)}</span>
                <input
                  className="input grow" value={me.name} maxLength={40}
                  onChange={e => {
                    const next = { ...me, name: e.target.value }
                    setMe(next); setIdentity(next); refreshPresence()
                  }}
                />
              </div>
            </div>

            {sync && sync.peers.length > 0 && (
              <div className="field">
                <label>Here now</label>
                <div className="peer-list">
                  {sync.peers.map(p => (
                    <span key={p.key} className="peer">
                      <span className="avatar" style={{ background: p.color }}>{initials(p.name)}</span>
                      {p.name}{p.self ? ' (you)' : ''}
                      <span className="muted small"> · {ROLE_LABEL[p.role]}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="modal-foot between">
              <button
                className="ghost-btn danger" disabled={busy}
                onClick={() => {
                  const msg = share.owner
                    ? 'Stop sharing? The online copy is deleted for everyone. This tab keeps a local copy.'
                    : 'Disconnect this tab? It keeps a local copy but stops syncing.'
                  if (!window.confirm(msg)) return
                  run(async () => { await stopSharing(proj.id); showToast(share.owner ? 'Sharing stopped.' : 'Disconnected.'); close() })
                }}
              >
                <Trash2 width={13} height={13} /> {share.owner ? 'Stop sharing' : 'Disconnect'}
              </button>
              <button className="primary-btn" onClick={close}>Done</button>
            </div>
          </>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  )
}
