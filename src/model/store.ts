import { create } from 'zustand'
import { refreshSectionDepths } from './layout'
import { applyPatch, diffProject, type Patch } from './patch'
import type { Camera, Filters, Id, Project, TimelineSettings } from './types'
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
  p.hierarchyLevels ??= ['Chapter', 'Level', 'Section']
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
  for (const sc of p.sections) sc.description ??= ''
  p.typeFolders ??= []
  for (const t of p.types) t.folderId ??= null
  refreshSectionDepths(p)
  return p
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
    hierarchyLevels: ['Chapter', 'Level', 'Section'],
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

// ---------------------------------------------------------------- sharing

export type ShareRole = 'edit' | 'view'

/** Link between a local project (tab) and a shared timeline in Supabase. */
export interface ShareInfo {
  /** Remote timeline id (uuid). */
  id: string
  role: ShareRole
  editToken: string | null
  viewToken: string
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
  onClose: ((projectId: Id) => void) | null
} = { onLocalPatch: null, onClose: null }

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
  overlay: 'templates' | 'cheatsheet' | 'settings' | 'share' | null
  editTypeId: Id | null
  dragTypeId: Id | null
  lastTypeId: Id | null
  toast: Toast | null
  sidebarOpen: boolean
  /** Viewer mode: every structural edit is blocked. */
  readOnly: boolean
}

interface Store {
  projects: Project[]
  activeId: Id
  ui: UIState
  /** Share metadata keyed by local project id. */
  shares: Record<Id, ShareInfo>
  /** Live sync state keyed by local project id. */
  sync: Record<Id, SyncState>
  /** True when the app was opened from a read-only link: nothing is persisted. */
  viewer: boolean
  setUI: (patch: Partial<UIState>) => void
  select: (ids: string[]) => void
  active: () => Project
  /** Undoable structural mutation of the active project. */
  mutate: (recipe: (p: Project) => void) => void
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
}

// ---------------------------------------------------------------- persistence

const LS_INDEX = 'tp.index.v1'
const LS_PROJ = (id: string) => `tp.project.v1.${id}`
const LS_SNAP = (id: string) => `tp.snapshots.v1.${id}`

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
        },
      }))
      for (const p of s.projects) {
        const data = JSON.stringify(p)
        localStorage.setItem(LS_PROJ(p.id), data)
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

function loadInitial(): { projects: Project[]; activeId: Id; prefs: Partial<UIState>; shares: Record<Id, ShareInfo>; fresh: boolean } {
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
        for (const p of projects) if (raw[p.id]?.id && raw[p.id]?.viewToken) shares[p.id] = raw[p.id]
        return { projects, activeId, prefs: idx.prefs ?? {}, shares, fresh: false }
      }
    }
  } catch { /* fall through */ }
  const p = blankProject('Untitled')
  return { projects: [p], activeId: p.id, prefs: {}, shares: {}, fresh: true }
}

const init = loadInitial()

/** Editing is blocked in viewer mode and on tabs joined through a view link. */
function canEdit(s: Store, projectId: Id): boolean {
  if (s.ui.readOnly) return false
  const share = s.shares[projectId]
  return !share || share.role === 'edit'
}

export const useStore = create<Store>((set, get) => ({
  projects: init.projects,
  activeId: init.activeId,
  shares: init.shares,
  sync: {},
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
    dragTypeId: null,
    lastTypeId: init.projects[0]?.types[0]?.id ?? null,
    toast: null,
    sidebarOpen: true,
    readOnly: false,
  } as UIState,

  setUI: patch => { set(s => ({ ui: { ...s.ui, ...patch } })); persistSoon(get) },
  select: ids => set(s => ({ ui: { ...s.ui, selection: ids } })),
  active: () => {
    const s = get()
    return s.projects.find(p => p.id === s.activeId) ?? s.projects[0]
  },

  mutate: recipe => {
    const s = get()
    const cur = s.projects.find(p => p.id === s.activeId)
    if (!cur || !canEdit(s, cur.id)) return
    const draft = structuredClone(cur)
    recipe(draft)
    refreshSectionDepths(draft)
    const fwd = diffProject(cur, draft)
    if (fwd) {
      const inv = diffProject(draft, cur)!
      const h = hist(cur.id)
      h.past.push({ fwd, inv })
      if (h.past.length > 100) h.past.shift()
      h.future = []
    }
    set({ projects: s.projects.map(p => (p.id === cur.id ? draft : p)) })
    persistSoon(get)
    if (fwd) syncHooks.onLocalPatch?.(cur.id, fwd)
  },

  tweak: recipe => {
    const s = get()
    const cur = s.projects.find(p => p.id === s.activeId)
    if (!cur) return
    const draft = structuredClone(cur)
    recipe(draft)
    refreshSectionDepths(draft)
    // Only synced fields (settings, name…) travel; camera/filters stay per user.
    const fwd = diffProject(cur, draft)
    if (fwd && !canEdit(s, cur.id)) return
    set({ projects: s.projects.map(p => (p.id === cur.id ? draft : p)) })
    persistSoon(get)
    if (fwd) syncHooks.onLocalPatch?.(cur.id, fwd)
  },

  setCamera: cam => {
    const s = get()
    set({ projects: s.projects.map(p => (p.id === s.activeId ? { ...p, camera: cam } : p)) })
    persistSoon(get)
  },

  undo: () => {
    const s = get()
    const cur = s.projects.find(p => p.id === s.activeId)
    if (!cur || !canEdit(s, cur.id)) return
    const h = hist(cur.id)
    const entry = h.past.pop()
    if (!entry) return
    h.future.push(entry)
    const draft = structuredClone(cur)
    applyPatch(draft, entry.inv)
    refreshSectionDepths(draft)
    set({ projects: s.projects.map(p => (p.id === cur.id ? draft : p)), ui: { ...s.ui, selection: [] } })
    persistSoon(get)
    syncHooks.onLocalPatch?.(cur.id, entry.inv)
  },

  redo: () => {
    const s = get()
    const cur = s.projects.find(p => p.id === s.activeId)
    if (!cur || !canEdit(s, cur.id)) return
    const h = hist(cur.id)
    const entry = h.future.pop()
    if (!entry) return
    h.past.push(entry)
    const draft = structuredClone(cur)
    applyPatch(draft, entry.fwd)
    refreshSectionDepths(draft)
    set({ projects: s.projects.map(p => (p.id === cur.id ? draft : p)), ui: { ...s.ui, selection: [] } })
    persistSoon(get)
    syncHooks.onLocalPatch?.(cur.id, entry.fwd)
  },

  addProject: p => {
    const proj = p ?? blankProject('Untitled')
    set(s => ({ projects: [...s.projects, proj], activeId: proj.id, ui: { ...s.ui, selection: [], overlay: null } }))
    persistSoon(get)
  },

  closeProject: id => {
    const s = get()
    if (s.projects.length <= 1) return
    try { localStorage.removeItem(LS_PROJ(id)); localStorage.removeItem(LS_SNAP(id)) } catch { /* ok */ }
    syncHooks.onClose?.(id)
    const projects = s.projects.filter(p => p.id !== id)
    const shares = { ...s.shares }
    delete shares[id]
    const sync = { ...s.sync }
    delete sync[id]
    delete histories[id]
    set({ projects, shares, sync, activeId: s.activeId === id ? projects[0].id : s.activeId, ui: { ...s.ui, selection: [] } })
    persistSoon(get)
  },

  setActive: id => { set(s => ({ activeId: id, ui: { ...s.ui, selection: [] } })); persistSoon(get) },

  renameProject: (id, name) => {
    const s = get()
    if (!canEdit(s, id)) return
    set({ projects: s.projects.map(p => (p.id === id ? { ...p, name } : p)) })
    persistSoon(get)
    syncHooks.onLocalPatch?.(id, { set: { name } })
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
    const draft = structuredClone(cur)
    applyPatch(draft, patch)
    refreshSectionDepths(draft)
    set({ projects: s.projects.map(p => (p.id === projectId ? draft : p)) })
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
    const share = s.shares[projectId]
    set({
      projects: s.projects.map(p => (p.id === projectId ? next : p)),
      shares: share ? { ...s.shares, [projectId]: { ...share, version } } : s.shares,
    })
    persistSoon(get)
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

export function useActiveProject(): Project {
  return useStore(s => s.projects.find(p => p.id === s.activeId) ?? s.projects[0])
}

export function useActiveShare(): ShareInfo | undefined {
  return useStore(s => s.shares[s.activeId])
}

export function useActiveSync(): SyncState | undefined {
  return useStore(s => s.sync[s.activeId])
}
