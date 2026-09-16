import { create } from 'zustand'
import { repairFolders } from './folders'
import { newFieldDef, normalizeFieldDef, repairSchema } from './fields'
import { refreshSectionDepths } from './layout'
import { applyPatch, diffProject, type Patch } from './patch'
import { applyChanges, diffToChanges, type Proposal, type ProposalChange } from './proposal'
import type { Camera, FieldAttachment, FieldDef, FieldValue, Filters, HierarchyLevel, Id, Project, TimelineSettings } from './types'
import { uid } from './util'

export const emptyFilters = (): Filters => ({ offTypes: [], offLayers: [], tags: [], text: '' })

export const defaultSettings = (): TimelineSettings => ({
  placement: 'above',
  unit: { preset: 'none', custom: '', showRuler: false },
  grid: { show: false, style: 'solid', opacity: 0.35 },
  spine: { width: 2, opacity: 1 },
  bandStrength: 1,
  sectionStyle: { labelSize: 14, edgeStrength: 0.5, showDuration: false },
})

/** Fill in fields missing from projects saved by older versions. */
export function normalizeProject(p: Project): Project {
  const d = defaultSettings()
  const s = (p.settings ?? {}) as Partial<TimelineSettings>
  p.settings = {
    placement: s.placement ?? d.placement,
    unit: { ...d.unit, ...s.unit },
    grid: { ...d.grid, ...s.grid },
    spine: { ...d.spine, ...s.spine },
    bandStrength: s.bandStrength ?? d.bandStrength,
    sectionStyle: { ...d.sectionStyle, ...s.sectionStyle },
  }
  p.hierarchyLevels = normalizeLevels(p.hierarchyLevels)
  p.fields = Array.isArray(p.fields) ? p.fields.map(f => normalizeFieldDef(f)) : []
  p.processors = Array.isArray(p.processors) ? p.processors : []
  for (const pr of p.processors) { pr.targets ??= []; pr.fieldId ??= null }
  p.types ??= []
  p.layers ??= []
  p.sections ??= []
  p.branches ??= []
  p.items ??= []
  p.views ??= []
  p.camera ??= { x: -8, s: 14 }
  p.filters ??= emptyFilters()
  p.activeViewId ??= null
  for (const l of p.layers) {
    l.size ??= 1
    l.minZoom ??= 0
  }
  for (const sc of p.sections) { sc.description ??= ''; sc.fieldValues ??= {} }
  for (const it of p.items) it.fieldValues ??= {}
  p.typeFolders ??= []
  for (const f of p.typeFolders) {
    f.parentId ??= null
    f.fields = Array.isArray(f.fields) ? f.fields.map(a => ({ fieldId: a.fieldId, defaultValue: a.defaultValue ?? null })) : []
  }
  for (const t of p.types) t.folderId ??= null
  migrateLegacyFields(p)
  repairFolders(p)
  refreshSectionDepths(p)
  repairSchema(p)
  return p
}

export const DEFAULT_LEVEL_NAMES = ['Chapter', 'Level', 'Section']

export const newLevel = (name: string, id = uid()): HierarchyLevel => ({ id, name, fields: [], processors: [] })

/**
 * Hierarchy levels used to be plain strings. Migrated ids are derived from
 * the index so every collaborator's copy of a shared document migrates to
 * the same ids and later patches line up.
 */
function normalizeLevels(raw: unknown): HierarchyLevel[] {
  const list = Array.isArray(raw) && raw.length ? raw : DEFAULT_LEVEL_NAMES
  return list.map((l, i) => {
    if (typeof l === 'string') return newLevel(l, `level-${i}`)
    const o = (l ?? {}) as Partial<HierarchyLevel>
    return {
      id: o.id ?? `level-${i}`,
      name: o.name ?? `Level ${i + 1}`,
      fields: Array.isArray(o.fields) ? o.fields.map(a => ({ fieldId: a.fieldId, defaultValue: a.defaultValue ?? null })) : [],
      processors: Array.isArray(o.processors) ? o.processors.map(a => ({ processorId: a.processorId, showOnBand: !!a.showOnBand })) : [],
    }
  })
}

/**
 * Per-type text fields ({ id, name }) become global fields; same-named ones
 * merge into a single definition (first occurrence wins the id, so the
 * migration is deterministic across collaborators) and item values follow.
 */
function migrateLegacyFields(p: Project) {
  const remap = new Map<Id, Id>()
  for (const t of p.types) {
    t.fields ??= []
    const next: FieldAttachment[] = []
    for (const raw of t.fields as unknown as ({ id: Id; name: string } | FieldAttachment)[]) {
      if ('fieldId' in raw) { next.push({ fieldId: raw.fieldId, defaultValue: raw.defaultValue ?? null }); continue }
      const key = (raw.name ?? '').trim().toLowerCase()
      let def: FieldDef | undefined = p.fields.find(f => f.kind === 'text' && f.name.trim().toLowerCase() === key)
      if (!def) { def = newFieldDef(raw.id, raw.name || 'Field', 'text'); p.fields.push(def) }
      if (def.id !== raw.id) remap.set(raw.id, def.id)
      next.push({ fieldId: def.id, defaultValue: null })
    }
    t.fields = next
  }
  if (!remap.size) return
  for (const it of p.items) {
    for (const [from, to] of remap) {
      const v = it.fieldValues[from] as FieldValue | undefined
      if (v === undefined) continue
      delete it.fieldValues[from]
      if (it.fieldValues[to] === undefined) it.fieldValues[to] = v
    }
  }
}

export function blankProject(name: string): Project {
  const layers = [
    { id: uid(), name: 'Critical', eye: false, pin: false, size: 1, minZoom: 0 },
    { id: uid(), name: 'Major', eye: false, pin: false, size: 1, minZoom: 0 },
    { id: uid(), name: 'Minor', eye: false, pin: false, size: 1, minZoom: 0 },
    { id: uid(), name: 'Detail', eye: false, pin: false, size: 1, minZoom: 0 },
  ]
  return {
    schemaVersion: 1,
    id: uid(),
    name,
    hierarchyLevels: DEFAULT_LEVEL_NAMES.map(n => newLevel(n)),
    fields: [],
    processors: [],
    types: [
      { id: uid(), name: 'Note', icon: 'StickyNote', color: '#0ea5e9', defaultLayerId: layers[1].id, fields: [] },
    ],
    typeFolders: [],
    layers,
    sections: [],
    branches: [],
    items: [],
    views: [],
    camera: { x: -8, s: 14 },
    filters: emptyFilters(),
    activeViewId: null,
    settings: defaultSettings(),
  }
}

export type Tool = 'select' | 'branch'
export type AnimLevel = 'off' | 'subtle' | 'full'

export interface Toast {
  msg: string
  undo?: boolean
  key: number
}

export interface ConfirmRequest {
  title: string
  message: string
  /** Affected things, listed under the message. */
  list?: string[]
  okLabel?: string
  danger?: boolean
  onOk: () => void
}

export const SIDEBAR_W = 271
export const INSPECTOR_W = 292
export const clampSidebarW = (w: number) => Math.round(Math.max(200, Math.min(600, w)))
export const clampInspectorW = (w: number) => Math.round(Math.max(240, Math.min(720, w)))

// ---------------------------------------------------------------- sharing

export type ShareRole = 'edit' | 'suggest' | 'view'

/** Link between a local project (tab) and a shared timeline in Supabase. */
export interface ShareInfo {
  /** Remote timeline id (uuid). */
  id: string
  role: ShareRole
  editToken: string | null
  /** Suggest link token; known to editors and suggesters. */
  suggestToken: string | null
  viewToken: string
  /** API token for external tools (Unity plugin, scripts); owners only, null until created. */
  apiToken?: string | null
  /** Last server version we know about. */
  version: number
  owner: boolean
}

export type SyncStatus = 'connecting' | 'live' | 'polling' | 'offline' | 'gone'

export interface Peer {
  key: string
  name: string
  color: string
  role: ShareRole
  self: boolean
}

export interface SyncState {
  status: SyncStatus
  peers: Peer[]
  /** Local edits not yet persisted remotely. */
  pending: boolean
}

/** Hooks the sync layer registers so the store never imports Supabase code. */
export const syncHooks: {
  onLocalPatch: ((projectId: Id, patch: Patch) => void) | null
  /** Entity-level record of a change that reached the document (for the history log). */
  onHistory: ((projectId: Id, changes: ProposalChange[], source: string) => void) | null
  onClose: ((projectId: Id) => void) | null
} = { onLocalPatch: null, onHistory: null, onClose: null }

interface UIState {
  selection: string[] // item ids, or 'B:<id>' branch, 'S:<id>' section
  ghostHidden: boolean
  density: number // 0..1
  theme: 'dark' | 'light'
  soundOn: boolean
  animLevel: AnimLevel
  /** Snap dragged positions to the grid steps. */
  snap: boolean
  /** Stick dragged positions to other items / section edges nearby. */
  magnet: boolean
  /** Dragging one item moves every other item by the same amount. */
  ripple: boolean
  tool: Tool
  overlay: 'templates' | 'cheatsheet' | 'settings' | 'share' | 'apihelp' | 'suggest' | null
  editTypeId: Id | null
  /** Field / processor / hierarchy-level editor modals. */
  editFieldId: Id | null
  editProcessorId: Id | null
  editLevelId: Id | null
  /** Entity glowing on the canvas (hovered in a reference search). */
  highlightId: Id | null
  /** Reference pick mode: the next canvas click fills this field. */
  pickRef: { ownerId: Id; fieldId: Id } | null
  /** Pending confirmation dialog. */
  confirm: ConfirmRequest | null
  /** Panel widths in px (per browser, never synced). */
  sidebarW: number
  inspectorW: number
  dragTypeId: Id | null
  /** A sidebar folder being dragged onto another folder (or out to the top level). */
  dragFolderId: Id | null
  lastTypeId: Id | null
  toast: Toast | null
  sidebarOpen: boolean
  /** Viewer mode: every structural edit is blocked. */
  readOnly: boolean
  /** Show filled-in custom field values next to item titles on the canvas. */
  showFields: boolean
  /** Show item titles on the canvas; off packs items closer (icons only, or fields only). */
  showTitles: boolean
  /** Proposal currently open in the review panel; its pending items are highlighted on the canvas. */
  reviewProposalId: Id | null
}

interface Store {
  projects: Project[]
  activeId: Id
  ui: UIState
  /** Share metadata keyed by local project id. */
  shares: Record<Id, ShareInfo>
  /** Live sync state keyed by local project id. */
  sync: Record<Id, SyncState>
  /** Suggested changes awaiting review, keyed by local project id (edit shares only). */
  proposals: Record<Id, Proposal[]>
  /**
   * Suggest-mode drafts keyed by project id. While a draft exists the tab
   * shows and edits the draft instead of the document; the difference between
   * the two is what gets sent as a proposal.
   */
  drafts: Record<Id, Project>
  /** True when the app was opened from a read-only link: nothing is persisted. */
  viewer: boolean
  setUI: (patch: Partial<UIState>) => void
  select: (ids: string[]) => void
  active: () => Project
  /** Undoable structural mutation of the active project (or of its draft in suggest mode). */
  mutate: (recipe: (p: Project) => void, meta?: { source?: string }) => void
  /** Non-undoable, lightly persisted (camera, filters, settings). */
  tweak: (recipe: (p: Project) => void) => void
  setCamera: (cam: Camera) => void
  undo: () => void
  redo: () => void
  addProject: (p?: Project) => void
  closeProject: (id: Id) => void
  setActive: (id: Id) => void
  renameProject: (id: Id, name: string) => void
  importProject: (json: string) => string | null
  showToast: (msg: string, undo?: boolean) => void
  // -- sharing
  setShare: (projectId: Id, info: ShareInfo | null) => void
  setSync: (projectId: Id, patch: Partial<SyncState> | null) => void
  /** Apply a patch from a collaborator (not undoable, not re-broadcast). */
  applyRemotePatch: (projectId: Id, patch: Patch) => void
  /** Replace a project with the server document, keeping per-user state and re-applying unsaved local patches. */
  replaceRemoteDoc: (projectId: Id, doc: Project, version: number, reapply?: Patch[]) => void
  /** Enter read-only viewer mode for a shared timeline. */
  openViewer: (p: Project, info: ShareInfo) => void
  /** Replace or merge the proposal list of a project (null clears it). */
  setProposals: (projectId: Id, list: Proposal[] | null) => void
  // -- suggest mode
  /** Start collecting edits into a draft instead of the document. */
  enterSuggest: (projectId: Id) => void
  /** Drop the draft (keeping camera/filters) and edit the document directly again. */
  exitSuggest: (projectId: Id) => void
  /** Rebuild the draft as document + `keep` (what was not sent yet). */
  resetDraft: (projectId: Id, keep: ProposalChange[]) => void
}

// ---------------------------------------------------------------- persistence

const LS_INDEX = 'tp.index.v1'
const LS_PROJ = (id: string) => `tp.project.v1.${id}`
const LS_SNAP = (id: string) => `tp.snapshots.v1.${id}`
const LS_DRAFT = (id: string) => `tp.draft.v1.${id}`

/** Undo history is patch-based so that undo only reverts *your* edits on shared tabs. */
interface HistEntry { fwd: Patch; inv: Patch }
interface Hist { past: HistEntry[]; future: HistEntry[] }
const histories: Record<string, Hist> = {}
const hist = (id: string) => (histories[id] ??= { past: [], future: [] })

let persistTimer: ReturnType<typeof setTimeout> | undefined
const lastSnapAt: Record<string, number> = {}

function persistSoon(get: () => Store) {
  clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    try {
      const s = get()
      if (s.viewer) return
      localStorage.setItem(LS_INDEX, JSON.stringify({
        order: s.projects.map(p => p.id),
        activeId: s.activeId,
        shares: s.shares,
        prefs: {
          ghostHidden: s.ui.ghostHidden, density: s.ui.density, theme: s.ui.theme,
          soundOn: s.ui.soundOn, animLevel: s.ui.animLevel, snap: s.ui.snap, magnet: s.ui.magnet, ripple: s.ui.ripple,
          sidebarW: s.ui.sidebarW, inspectorW: s.ui.inspectorW,
          showFields: s.ui.showFields, showTitles: s.ui.showTitles,
        },
      }))
      for (const p of s.projects) {
        const data = JSON.stringify(p)
        localStorage.setItem(LS_PROJ(p.id), data)
        const draft = s.drafts[p.id]
        if (draft) localStorage.setItem(LS_DRAFT(p.id), JSON.stringify(draft))
        else localStorage.removeItem(LS_DRAFT(p.id))
        const now = Date.now()
        if (now - (lastSnapAt[p.id] ?? 0) > 4 * 60_000) {
          lastSnapAt[p.id] = now
          const snaps = JSON.parse(localStorage.getItem(LS_SNAP(p.id)) ?? '[]') as { t: number; data: string }[]
          snaps.push({ t: now, data })
          while (snaps.length > 8) snaps.shift()
          try { localStorage.setItem(LS_SNAP(p.id), JSON.stringify(snaps)) } catch { /* quota */ }
        }
      }
    } catch { /* storage unavailable */ }
  }, 350)
}

function loadInitial(): { projects: Project[]; activeId: Id; prefs: Partial<UIState>; shares: Record<Id, ShareInfo>; drafts: Record<Id, Project>; fresh: boolean } {
  try {
    const idx = JSON.parse(localStorage.getItem(LS_INDEX) ?? 'null')
    if (idx && Array.isArray(idx.order) && idx.order.length) {
      const projects: Project[] = []
      for (const id of idx.order) {
        const raw = localStorage.getItem(LS_PROJ(id))
        if (raw) projects.push(normalizeProject(JSON.parse(raw)))
      }
      if (projects.length) {
        const activeId = projects.some(p => p.id === idx.activeId) ? idx.activeId : projects[0].id
        const shares: Record<Id, ShareInfo> = {}
        const raw = (idx.shares ?? {}) as Record<Id, ShareInfo>
        for (const p of projects) if (raw[p.id]?.id && raw[p.id]?.viewToken) shares[p.id] = { ...raw[p.id], suggestToken: raw[p.id].suggestToken ?? null }
        // Suggest-mode drafts survive reloads; a suggest-link tab is always in suggest mode.
        const drafts: Record<Id, Project> = {}
        for (const p of projects) {
          const rawDraft = localStorage.getItem(LS_DRAFT(p.id))
          if (rawDraft) {
            try { drafts[p.id] = normalizeProject(JSON.parse(rawDraft)) } catch { /* ignore a broken draft */ }
          }
          if (!drafts[p.id] && shares[p.id]?.role === 'suggest') drafts[p.id] = structuredClone(p)
        }
        return { projects, activeId, prefs: idx.prefs ?? {}, shares, drafts, fresh: false }
      }
    }
  } catch { /* fall through */ }
  const p = blankProject('Untitled')
  return { projects: [p], activeId: p.id, prefs: {}, shares: {}, drafts: {}, fresh: true }
}

const init = loadInitial()

/** Editing is blocked in viewer mode and on tabs joined through a view link (suggesters edit a draft). */
function canEdit(s: Store, projectId: Id): boolean {
  if (s.ui.readOnly) return false
  const share = s.shares[projectId]
  return !share || share.role !== 'view'
}

/** Rebase a draft onto a new version of the document: same changes, new base. */
function rebaseDraft(oldBase: Project, newBase: Project, draft: Project): Project {
  const changes = diffToChanges(oldBase, draft)
  const next = structuredClone(newBase)
  applyChanges(next, changes)
  next.camera = draft.camera
  next.filters = draft.filters
  next.activeViewId = draft.activeViewId
  repairFolders(next)
  refreshSectionDepths(next)
  repairSchema(next)
  return next
}

function withDraft(s: Store, projectId: Id, draft: Project | null): Record<Id, Project> {
  const drafts = { ...s.drafts }
  if (draft) drafts[projectId] = draft
  else delete drafts[projectId]
  return drafts
}

export const useStore = create<Store>((set, get) => ({
  projects: init.projects,
  activeId: init.activeId,
  shares: init.shares,
  sync: {},
  proposals: {},
  drafts: init.drafts,
  viewer: false,
  ui: {
    selection: [],
    ghostHidden: init.prefs.ghostHidden ?? false,
    density: init.prefs.density ?? 0.55,
    theme: (init.prefs.theme as 'dark' | 'light') ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'),
    soundOn: init.prefs.soundOn ?? false,
    animLevel: (init.prefs.animLevel as AnimLevel) ?? 'full',
    snap: init.prefs.snap ?? false,
    magnet: init.prefs.magnet ?? true,
    ripple: init.prefs.ripple ?? false,
    tool: 'select',
    overlay: init.fresh ? 'templates' : null,
    editTypeId: null,
    editFieldId: null,
    editProcessorId: null,
    editLevelId: null,
    highlightId: null,
    pickRef: null,
    confirm: null,
    sidebarW: clampSidebarW(init.prefs.sidebarW ?? SIDEBAR_W),
    inspectorW: clampInspectorW(init.prefs.inspectorW ?? INSPECTOR_W),
    dragTypeId: null,
    dragFolderId: null,
    lastTypeId: init.projects[0]?.types[0]?.id ?? null,
    toast: null,
    sidebarOpen: true,
    readOnly: false,
    showFields: init.prefs.showFields ?? true,
    showTitles: init.prefs.showTitles ?? true,
    reviewProposalId: null,
  } as UIState,

  setUI: patch => { set(s => ({ ui: { ...s.ui, ...patch } })); persistSoon(get) },
  // Changing the selection always leaves reference pick mode and clears any glow.
  select: ids => set(s => ({ ui: { ...s.ui, selection: ids, pickRef: null, highlightId: null } })),
  active: () => {
    const s = get()
    return s.drafts[s.activeId] ?? s.projects.find(p => p.id === s.activeId) ?? s.projects[0]
  },

  mutate: (recipe, meta) => {
    const s = get()
    const cur = s.projects.find(p => p.id === s.activeId)
    if (!cur || !canEdit(s, cur.id)) return
    const base = s.drafts[cur.id] ?? cur
    const next = structuredClone(base)
    recipe(next)
    repairFolders(next)
    refreshSectionDepths(next)
    repairSchema(next)
    const fwd = diffProject(base, next)
    if (fwd) {
      const inv = diffProject(next, base)!
      const h = hist(s.drafts[cur.id] ? `d:${cur.id}` : cur.id)
      h.past.push({ fwd, inv })
      if (h.past.length > 100) h.past.shift()
      h.future = []
    }
    if (s.drafts[cur.id]) {
      // Suggest mode: the draft changes, the document does not.
      set({ drafts: withDraft(s, cur.id, next) })
      persistSoon(get)
      return
    }
    set({ projects: s.projects.map(p => (p.id === cur.id ? next : p)) })
    persistSoon(get)
    if (fwd) {
      syncHooks.onLocalPatch?.(cur.id, fwd)
      syncHooks.onHistory?.(cur.id, diffToChanges(cur, next), meta?.source ?? 'edit')
    }
  },

  tweak: recipe => {
    const s = get()
    const cur = s.projects.find(p => p.id === s.activeId)
    if (!cur) return
    const base = s.drafts[cur.id] ?? cur
    const next = structuredClone(base)
    recipe(next)
    refreshSectionDepths(next)
    // Only synced fields (settings, name…) travel; camera/filters stay per user.
    const fwd = diffProject(base, next)
    if (fwd && !canEdit(s, cur.id)) return
    if (s.drafts[cur.id]) {
      set({ drafts: withDraft(s, cur.id, next) })
      persistSoon(get)
      return
    }
    set({ projects: s.projects.map(p => (p.id === cur.id ? next : p)) })
    persistSoon(get)
    if (fwd) {
      syncHooks.onLocalPatch?.(cur.id, fwd)
      syncHooks.onHistory?.(cur.id, diffToChanges(cur, next), 'edit')
    }
  },

  setCamera: cam => {
    const s = get()
    const draft = s.drafts[s.activeId]
    if (draft) set({ drafts: withDraft(s, s.activeId, { ...draft, camera: cam }) })
    else set({ projects: s.projects.map(p => (p.id === s.activeId ? { ...p, camera: cam } : p)) })
    persistSoon(get)
  },

  undo: () => {
    const s = get()
    const cur = s.projects.find(p => p.id === s.activeId)
    if (!cur || !canEdit(s, cur.id)) return
    const draft = s.drafts[cur.id]
    const h = hist(draft ? `d:${cur.id}` : cur.id)
    const entry = h.past.pop()
    if (!entry) return
    h.future.push(entry)
    const base = draft ?? cur
    const next = structuredClone(base)
    applyPatch(next, entry.inv)
    refreshSectionDepths(next)
    repairSchema(next)
    if (draft) {
      set({ drafts: withDraft(s, cur.id, next), ui: { ...s.ui, selection: [] } })
      persistSoon(get)
      return
    }
    set({ projects: s.projects.map(p => (p.id === cur.id ? next : p)), ui: { ...s.ui, selection: [] } })
    persistSoon(get)
    syncHooks.onLocalPatch?.(cur.id, entry.inv)
    syncHooks.onHistory?.(cur.id, diffToChanges(cur, next), 'undo')
  },

  redo: () => {
    const s = get()
    const cur = s.projects.find(p => p.id === s.activeId)
    if (!cur || !canEdit(s, cur.id)) return
    const draft = s.drafts[cur.id]
    const h = hist(draft ? `d:${cur.id}` : cur.id)
    const entry = h.future.pop()
    if (!entry) return
    h.past.push(entry)
    const base = draft ?? cur
    const next = structuredClone(base)
    applyPatch(next, entry.fwd)
    refreshSectionDepths(next)
    repairSchema(next)
    if (draft) {
      set({ drafts: withDraft(s, cur.id, next), ui: { ...s.ui, selection: [] } })
      persistSoon(get)
      return
    }
    set({ projects: s.projects.map(p => (p.id === cur.id ? next : p)), ui: { ...s.ui, selection: [] } })
    persistSoon(get)
    syncHooks.onLocalPatch?.(cur.id, entry.fwd)
    syncHooks.onHistory?.(cur.id, diffToChanges(cur, next), 'redo')
  },

  addProject: p => {
    const proj = p ?? blankProject('Untitled')
    set(s => ({ projects: [...s.projects, proj], activeId: proj.id, ui: { ...s.ui, selection: [], overlay: null } }))
    persistSoon(get)
  },

  closeProject: id => {
    const s = get()
    if (s.projects.length <= 1) return
    try { localStorage.removeItem(LS_PROJ(id)); localStorage.removeItem(LS_SNAP(id)); localStorage.removeItem(LS_DRAFT(id)) } catch { /* ok */ }
    syncHooks.onClose?.(id)
    const projects = s.projects.filter(p => p.id !== id)
    const shares = { ...s.shares }
    delete shares[id]
    const sync = { ...s.sync }
    delete sync[id]
    const proposals = { ...s.proposals }
    delete proposals[id]
    const drafts = { ...s.drafts }
    delete drafts[id]
    delete histories[id]
    delete histories[`d:${id}`]
    set({ projects, shares, sync, proposals, drafts, activeId: s.activeId === id ? projects[0].id : s.activeId, ui: { ...s.ui, selection: [] } })
    persistSoon(get)
  },

  setActive: id => { set(s => ({ activeId: id, ui: { ...s.ui, selection: [], reviewProposalId: null } })); persistSoon(get) },

  renameProject: (id, name) => {
    const s = get()
    if (!canEdit(s, id)) return
    const draft = s.drafts[id]
    if (draft) { set({ drafts: withDraft(s, id, { ...draft, name }) }); persistSoon(get); return }
    const cur = s.projects.find(p => p.id === id)
    set({ projects: s.projects.map(p => (p.id === id ? { ...p, name } : p)) })
    persistSoon(get)
    syncHooks.onLocalPatch?.(id, { set: { name } })
    if (cur && cur.name !== name) {
      syncHooks.onHistory?.(id, [{ id: uid(), col: 'project', kind: 'set', entityId: 'name', before: cur.name, after: name }], 'edit')
    }
  },

  importProject: json => {
    try {
      const p = JSON.parse(json) as Project
      if (!p || p.schemaVersion !== 1 || !Array.isArray(p.items)) return 'Not a valid timeline file.'
      p.id = uid()
      get().addProject(normalizeProject(p))
      return null
    } catch {
      return 'Could not parse that file as JSON.'
    }
  },

  showToast: (msg, undo) => {
    const key = Date.now()
    set(s => ({ ui: { ...s.ui, toast: { msg, undo, key } } }))
    setTimeout(() => {
      const s = get()
      if (s.ui.toast?.key === key) set({ ui: { ...s.ui, toast: null } })
    }, 8000)
  },

  // ---------------------------------------------------------------- sharing

  setShare: (projectId, info) => {
    set(s => {
      const shares = { ...s.shares }
      if (info) shares[projectId] = info
      else delete shares[projectId]
      return { shares }
    })
    persistSoon(get)
  },

  setSync: (projectId, patch) => {
    set(s => {
      const sync = { ...s.sync }
      if (!patch) delete sync[projectId]
      else {
        const base: SyncState = sync[projectId] ?? { status: 'connecting', peers: [], pending: false }
        sync[projectId] = { ...base, ...patch }
      }
      return { sync }
    })
  },

  applyRemotePatch: (projectId, patch) => {
    const s = get()
    const cur = s.projects.find(p => p.id === projectId)
    if (!cur) return
    const next = structuredClone(cur)
    applyPatch(next, patch)
    repairFolders(next)
    refreshSectionDepths(next)
    repairSchema(next)
    const draft = s.drafts[projectId]
    set({
      projects: s.projects.map(p => (p.id === projectId ? next : p)),
      drafts: draft ? withDraft(s, projectId, rebaseDraft(cur, next, draft)) : s.drafts,
    })
    persistSoon(get)
  },

  replaceRemoteDoc: (projectId, doc, version, reapply = []) => {
    const s = get()
    const cur = s.projects.find(p => p.id === projectId)
    if (!cur) return
    const next = normalizeProject(structuredClone(doc))
    next.id = projectId
    next.camera = cur.camera
    next.filters = cur.filters
    next.activeViewId = cur.activeViewId
    for (const p of reapply) applyPatch(next, p)
    refreshSectionDepths(next)
    repairSchema(next)
    const share = s.shares[projectId]
    const draft = s.drafts[projectId]
    set({
      projects: s.projects.map(p => (p.id === projectId ? next : p)),
      shares: share ? { ...s.shares, [projectId]: { ...share, version } } : s.shares,
      drafts: draft ? withDraft(s, projectId, rebaseDraft(cur, next, draft)) : s.drafts,
    })
    persistSoon(get)
  },

  // ---------------------------------------------------------------- suggest mode

  enterSuggest: projectId => {
    const s = get()
    if (s.drafts[projectId]) return
    const cur = s.projects.find(p => p.id === projectId)
    if (!cur) return
    set({ drafts: withDraft(s, projectId, structuredClone(cur)), ui: { ...s.ui, selection: [] } })
    persistSoon(get)
  },

  exitSuggest: projectId => {
    const s = get()
    const draft = s.drafts[projectId]
    if (!draft) return
    delete histories[`d:${projectId}`]
    set({
      projects: s.projects.map(p => (p.id === projectId ? { ...p, camera: draft.camera, filters: draft.filters, activeViewId: draft.activeViewId } : p)),
      drafts: withDraft(s, projectId, null),
      ui: { ...s.ui, selection: [] },
    })
    persistSoon(get)
  },

  resetDraft: (projectId, keep) => {
    const s = get()
    const cur = s.projects.find(p => p.id === projectId)
    const draft = s.drafts[projectId]
    if (!cur || !draft) return
    const next = structuredClone(cur)
    applyChanges(next, keep)
    next.camera = draft.camera
    next.filters = draft.filters
    next.activeViewId = draft.activeViewId
    repairFolders(next)
    refreshSectionDepths(next)
    repairSchema(next)
    delete histories[`d:${projectId}`]
    set({ drafts: withDraft(s, projectId, next), ui: { ...s.ui, selection: [] } })
    persistSoon(get)
  },

  setProposals: (projectId, list) => {
    set(s => {
      const proposals = { ...s.proposals }
      if (list) proposals[projectId] = list
      else delete proposals[projectId]
      return { proposals }
    })
  },

  openViewer: (p, info) => {
    set(s => ({
      projects: [...s.projects.filter(x => x.id !== p.id), p],
      activeId: p.id,
      shares: { ...s.shares, [p.id]: info },
      viewer: true,
      ui: { ...s.ui, readOnly: true, overlay: null, selection: [], tool: 'select' },
    }))
  },
}))

/** The project as the tab sees it: the suggest-mode draft when there is one. */
export function useActiveProject(): Project {
  return useStore(s => s.drafts[s.activeId] ?? s.projects.find(p => p.id === s.activeId) ?? s.projects[0])
}

/** The saved document (never the draft). */
export function useActiveBase(): Project {
  return useStore(s => s.projects.find(p => p.id === s.activeId) ?? s.projects[0])
}

/** True while the active tab collects edits into a draft instead of the document. */
export function useSuggesting(): boolean {
  return useStore(s => !!s.drafts[s.activeId])
}

export function useActiveShare(): ShareInfo | undefined {
  return useStore(s => s.shares[s.activeId])
}

export function useActiveSync(): SyncState | undefined {
  return useStore(s => s.sync[s.activeId])
}

/** False in viewer mode and on tabs joined through a view link: the UI should render read-only. */
export function useCanEdit(): boolean {
  return useStore(s => canEdit(s, s.activeId))
}
