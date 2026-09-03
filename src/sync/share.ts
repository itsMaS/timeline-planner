import type { RealtimeChannel } from '@supabase/supabase-js'
import { applyPatch, patchBytes, type Patch } from '../model/patch'
import { normalizeProject, syncHooks, useStore, type Peer, type ShareInfo, type ShareRole } from '../model/store'
import type { Project } from '../model/types'
import { uid } from '../model/util'
import { CLIENT_ID, ensureSession, getIdentity, supabase } from './client'

/**
 * Realtime collaboration for shared tabs.
 *
 * - Every local edit is diffed into an entity patch (see model/patch.ts),
 *   broadcast instantly over a private Realtime channel, and folded into a
 *   debounced full-document save.
 * - Peers apply patches by id, so concurrent edits to different things both
 *   survive. A slow periodic pull (and a pull on reconnect / tab focus)
 *   catches anything a dropped socket missed.
 * - Without an anonymous session (sign-ins disabled, offline) the tab still
 *   works through the token-checked RPCs, refreshing by polling.
 */

const TOPIC = (timelineId: string) => `timeline:${timelineId}`
const SAVE_DEBOUNCE = 900
const PULL_LIVE = 25_000
const PULL_POLL = 4_000
const RETRY = 5_000
/** Patches above this size are not broadcast; peers pull the saved doc instead. */
const MAX_BROADCAST_BYTES = 200_000

interface Session {
  projectId: string
  channel: RealtimeChannel | null
  live: boolean
  stopped: boolean
  joinedOnce: boolean
  unsaved: Patch[]
  saving: boolean
  dirty: boolean
  notifyBig: boolean
  saveTimer?: ReturnType<typeof setTimeout>
  pullTimer?: ReturnType<typeof setTimeout>
}

const sessions = new Map<string, Session>()

const store = () => useStore.getState()
const shareOf = (projectId: string): ShareInfo | undefined => store().shares[projectId]
const projectOf = (projectId: string): Project | undefined => store().projects.find(p => p.id === projectId)
const setSync = (projectId: string, patch: Parameters<ReturnType<typeof useStore.getState>['setSync']>[1]) =>
  store().setSync(projectId, patch)

type RpcResult<T> = { data: T | null; error: { message: string } | null }

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = (await supabase().rpc(fn, args)) as RpcResult<T>
  if (error) throw new Error(error.message)
  return data as T
}

// ---------------------------------------------------------------- lifecycle

let booted = false

export function bootSync(opts: { startExisting: boolean }) {
  syncHooks.onLocalPatch = onLocalPatch
  syncHooks.onClose = stopSync
  if (opts.startExisting) for (const id of Object.keys(store().shares)) void startSync(id)
  if (booted) return
  booted = true
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) for (const s of sessions.values()) void pull(s)
  })
  window.addEventListener('online', () => {
    for (const s of sessions.values()) { void pull(s); if (s.unsaved.length) scheduleSave(s, 0) }
  })
}

export async function startSync(projectId: string) {
  if (sessions.has(projectId)) return
  const s: Session = {
    projectId, channel: null, live: false, stopped: false, joinedOnce: false,
    unsaved: [], saving: false, dirty: false, notifyBig: false,
  }
  sessions.set(projectId, s)
  setSync(projectId, { status: 'connecting' })
  const authed = await ensureSession()
  if (s.stopped) return
  const ok = await pull(s, true)
  if (s.stopped || !ok) { schedulePull(s); return }
  if (authed) subscribe(s)
  else setSync(projectId, { status: 'polling' })
  schedulePull(s)
}

export function stopSync(projectId: string) {
  const s = sessions.get(projectId)
  if (!s) return
  s.stopped = true
  clearTimeout(s.saveTimer)
  clearTimeout(s.pullTimer)
  if (s.channel) { void supabase().removeChannel(s.channel); s.channel = null }
  sessions.delete(projectId)
  setSync(projectId, null)
}

/** Tab keeps working as a plain local copy once its link is gone. */
function handleGone(s: Session) {
  const st = store()
  if (st.viewer) { setSync(s.projectId, { status: 'gone' }); return }
  stopSync(s.projectId)
  st.setShare(s.projectId, null)
  st.showToast('This share link was revoked — the tab is now a local copy.')
}

// ---------------------------------------------------------------- pull / refresh

interface OpenResult {
  id: string; name: string; doc: Project; version: number
  editToken: string | null; viewToken: string; role: ShareRole; owner: boolean
}
type PullResult = { gone: true } | { version: number; doc?: Project; name?: string }

async function pull(s: Session, initial = false): Promise<boolean> {
  const share = shareOf(s.projectId)
  if (!share || s.stopped) return false
  const token = share.editToken ?? share.viewToken
  try {
    if (initial) {
      const r = await rpc<OpenResult | null>('share_open', { p_token: token })
      if (s.stopped) return false
      if (!r) { handleGone(s); return false }
      store().setShare(s.projectId, {
        id: r.id, role: r.role, editToken: r.editToken, viewToken: r.viewToken, version: share.version,
        // Keep a locally known ownership (we created it) even if the auth session changed.
        owner: share.owner || r.owner,
      })
      store().replaceRemoteDoc(s.projectId, r.doc, r.version, s.unsaved)
    } else {
      const r = await rpc<PullResult>('share_pull', { p_token: token, p_version: share.version })
      if (s.stopped) return false
      if ('gone' in r) { handleGone(s); return false }
      if (r.doc && r.version > share.version) store().replaceRemoteDoc(s.projectId, r.doc, r.version, s.unsaved)
    }
    if (!s.live) setSync(s.projectId, { status: 'polling' })
    return true
  } catch (e) {
    console.warn('[sync] pull failed', e)
    if (!s.stopped) setSync(s.projectId, { status: 'offline' })
    return false
  }
}

function schedulePull(s: Session) {
  clearTimeout(s.pullTimer)
  if (s.stopped) return
  s.pullTimer = setTimeout(async () => {
    await pull(s)
    schedulePull(s)
  }, s.live ? PULL_LIVE : PULL_POLL)
}

// ---------------------------------------------------------------- realtime channel

interface PresenceMeta { name: string; color: string; role: ShareRole }

function subscribe(s: Session) {
  const share = shareOf(s.projectId)
  if (!share) return
  const ch = supabase().channel(TOPIC(share.id), {
    config: { private: true, broadcast: { self: false, ack: false }, presence: { key: CLIENT_ID } },
  })
  s.channel = ch
  ch.on('broadcast', { event: 'patch' }, ({ payload }) => {
    const p = payload as { from: string; patch?: Patch; big?: boolean }
    if (p.from === CLIENT_ID) return
    if (p.patch) store().applyRemotePatch(s.projectId, p.patch)
    if (p.big) void pull(s)
  })
  ch.on('presence', { event: 'sync' }, () => {
    const state = ch.presenceState<PresenceMeta>()
    const peers: Peer[] = Object.entries(state).map(([key, metas]) => ({
      key, name: metas[0]?.name ?? 'Someone', color: metas[0]?.color ?? '#888', role: metas[0]?.role ?? 'view',
      self: key === CLIENT_ID,
    }))
    setSync(s.projectId, { peers })
  })
  ch.subscribe(async (status, err) => {
    if (s.stopped) return
    if (status === 'SUBSCRIBED') {
      s.live = true
      setSync(s.projectId, { status: 'live' })
      await trackPresence(s)
      // A re-join after a drop: catch up on anything missed.
      if (s.joinedOnce) void pull(s)
      s.joinedOnce = true
      schedulePull(s)
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      if (err) console.warn('[sync] channel', status, err.message)
      s.live = false
      setSync(s.projectId, { status: 'polling' })
      schedulePull(s)
    } else if (status === 'CLOSED') {
      s.live = false
      setSync(s.projectId, { status: 'polling' })
      schedulePull(s)
    }
  })
}

async function trackPresence(s: Session) {
  const share = shareOf(s.projectId)
  if (!s.channel || !share || !s.live) return
  const me = getIdentity()
  try { await s.channel.track({ name: me.name, color: me.color, role: share.role } satisfies PresenceMeta) } catch { /* ok */ }
}

/** Re-announce after the display name changes. */
export function refreshPresence() {
  for (const s of sessions.values()) void trackPresence(s)
}

// ---------------------------------------------------------------- local edits → remote

function onLocalPatch(projectId: string, patch: Patch) {
  const s = sessions.get(projectId)
  const share = shareOf(projectId)
  if (!s || !share || share.role !== 'edit') return
  s.unsaved.push(patch)
  setSync(projectId, { pending: true })
  if (s.live && s.channel) {
    if (patchBytes(patch) <= MAX_BROADCAST_BYTES) {
      void s.channel.send({ type: 'broadcast', event: 'patch', payload: { from: CLIENT_ID, patch } })
    } else {
      s.notifyBig = true
    }
  }
  scheduleSave(s)
}

function scheduleSave(s: Session, delay = SAVE_DEBOUNCE) {
  clearTimeout(s.saveTimer)
  if (s.stopped) return
  s.saveTimer = setTimeout(() => void save(s), delay)
}

async function save(s: Session) {
  if (s.stopped) return
  if (s.saving) { s.dirty = true; return }
  const share = shareOf(s.projectId)
  const proj = projectOf(s.projectId)
  if (!share?.editToken || !proj) return
  s.saving = true
  const batch = s.unsaved.length
  try {
    const r = await rpc<{ gone?: true; version?: number }>('share_save', {
      p_token: share.editToken, p_name: proj.name, p_doc: proj,
    })
    if (s.stopped) return
    if (r.gone) { handleGone(s); return }
    s.unsaved = s.unsaved.slice(batch)
    const cur = shareOf(s.projectId)
    if (cur) store().setShare(s.projectId, { ...cur, version: r.version ?? cur.version })
    setSync(s.projectId, { pending: s.unsaved.length > 0, status: s.live ? 'live' : 'polling' })
    if (s.notifyBig && s.live && s.channel) {
      s.notifyBig = false
      void s.channel.send({ type: 'broadcast', event: 'patch', payload: { from: CLIENT_ID, big: true } })
    }
  } catch (e) {
    console.warn('[sync] save failed', e)
    if (!s.stopped) { setSync(s.projectId, { status: 'offline' }); scheduleSave(s, RETRY) }
  } finally {
    s.saving = false
    if (s.dirty) { s.dirty = false; scheduleSave(s) }
  }
}

// ---------------------------------------------------------------- images

const isDataUrl = (src: string) => src.startsWith('data:')

/** Upload a data-URL image to the timeline's folder; returns its public URL. */
export async function uploadImage(timelineId: string, dataUrl: string): Promise<string> {
  const authed = await ensureSession()
  if (!authed) throw new Error('No session for uploads')
  const blob = await (await fetch(dataUrl)).blob()
  const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' } as Record<string, string>)[blob.type] ?? 'png'
  const path = `${timelineId}/${uid()}.${ext}`
  const bucket = supabase().storage.from('timeline-images')
  const { error } = await bucket.upload(path, blob, { contentType: blob.type || 'image/png', upsert: false })
  if (error) throw new Error(error.message)
  return bucket.getPublicUrl(path).data.publicUrl
}

/** Move inline images of a freshly shared project into Storage. Returns how many stayed inline. */
async function migrateImages(projectId: string, timelineId: string): Promise<number> {
  const proj = projectOf(projectId)
  if (!proj) return 0
  let failed = 0
  const changed: Project['items'] = []
  for (const it of proj.items) {
    if (!it.images.some(isDataUrl)) continue
    const images: string[] = []
    for (const src of it.images) {
      if (!isDataUrl(src)) { images.push(src); continue }
      try { images.push(await uploadImage(timelineId, src)) } catch { images.push(src); failed++ }
    }
    changed.push({ ...it, images })
  }
  if (changed.length) {
    const patch: Patch = { cols: { items: { upsert: changed } } }
    store().applyRemotePatch(projectId, patch)
    onLocalPatch(projectId, patch)
  }
  return failed
}

// ---------------------------------------------------------------- share management

interface CreateResult {
  id: string; name: string; version: number; editToken: string; viewToken: string; role: 'edit'; owner: true
}

/** Publish a local tab as a shared timeline (this browser becomes its owner). */
export async function shareProject(projectId: string): Promise<ShareInfo> {
  await ensureSession()
  const proj = projectOf(projectId)
  if (!proj) throw new Error('Project not found')
  const r = await rpc<CreateResult>('share_create', { p_name: proj.name, p_doc: proj })
  const info: ShareInfo = { id: r.id, role: 'edit', editToken: r.editToken, viewToken: r.viewToken, version: r.version, owner: true }
  store().setShare(projectId, info)
  await startSync(projectId)
  const failed = await migrateImages(projectId, r.id)
  if (failed) store().showToast(`${failed} image${failed === 1 ? '' : 's'} could not be uploaded and stay inline.`)
  return info
}

/** Resolve a share link. Throws when the token is unknown or revoked. */
export async function openShared(token: string): Promise<{ project: Project; info: ShareInfo }> {
  await ensureSession()
  const r = await rpc<OpenResult | null>('share_open', { p_token: token })
  if (!r) throw new Error('This link is not valid any more.')
  const project = normalizeProject(structuredClone(r.doc))
  project.id = r.id
  project.name = r.name
  const info: ShareInfo = { id: r.id, role: r.role, editToken: r.editToken, viewToken: r.viewToken, version: r.version, owner: r.owner }
  return { project, info }
}

export async function regenerateLink(projectId: string, which: ShareRole): Promise<void> {
  const share = shareOf(projectId)
  if (!share?.editToken) throw new Error('Only editors can regenerate links')
  const r = await rpc<{ token: string } | null>('share_regenerate', { p_edit_token: share.editToken, p_which: which })
  if (!r) throw new Error('Only the owner can regenerate links')
  const cur = shareOf(projectId)
  if (!cur) return
  store().setShare(projectId, which === 'edit' ? { ...cur, editToken: r.token } : { ...cur, viewToken: r.token })
}

/** Owner: delete the remote timeline. Everyone else: just disconnect this tab. */
export async function stopSharing(projectId: string): Promise<void> {
  const share = shareOf(projectId)
  if (share?.owner && share.editToken) {
    try { await rpc<boolean>('share_delete', { p_edit_token: share.editToken }) } catch (e) { console.warn('[sync] delete failed', e) }
  }
  stopSync(projectId)
  store().setShare(projectId, null)
}

export function shareLink(token: string): string {
  const base = `${location.origin}${location.pathname}${location.search}`
  return `${base}#/s/${token}`
}

export function parseShareHash(hash = location.hash): string | null {
  const m = hash.match(/^#\/s\/([A-Za-z0-9_-]{8,})/)
  return m ? m[1] : null
}
