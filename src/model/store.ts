import { create } from 'zustand'
import type { Camera, Filters, Id, Project, TimelineSettings } from './types'
import { uid } from './util'

export const emptyFilters = (): Filters => ({ offTypes: [], offLayers: [], tags: [], text: '' })

export const defaultSettings = (): TimelineSettings => ({
  placement: 'above',
  unit: { preset: 'none', custom: '', showRuler: false },
  grid: { show: false, style: 'solid', opacity: 0.35 },
  spine: { width: 2, opacity: 1 },
  bandStrength: 1,
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
  }
  return p
}

export function blankProject(name: string): Project {
  const layers = [
    { id: uid(), name: 'Critical', eye: false, pin: false },
    { id: uid(), name: 'Major', eye: false, pin: false },
    { id: uid(), name: 'Minor', eye: false, pin: false },
    { id: uid(), name: 'Detail', eye: false, pin: false },
  ]
  return {
    schemaVersion: 1,
    id: uid(),
    name,
    hierarchyLevels: ['Chapter', 'Level', 'Section'],
    types: [
      { id: uid(), name: 'Note', icon: 'StickyNote', color: '#0ea5e9', defaultLayerId: layers[1].id, fields: [] },
    ],
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
  overlay: 'templates' | 'cheatsheet' | 'settings' | null
  editTypeId: Id | null
  dragTypeId: Id | null
  lastTypeId: Id | null
  toast: Toast | null
  sidebarOpen: boolean
}

interface Store {
  projects: Project[]
  activeId: Id
  ui: UIState
  setUI: (patch: Partial<UIState>) => void
  select: (ids: string[]) => void
  active: () => Project
  /** Undoable structural mutation of the active project. */
  mutate: (recipe: (p: Project) => void) => void
  /** Non-undoable, lightly persisted (camera, filters). */
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
}

// ---------------------------------------------------------------- persistence

const LS_INDEX = 'tp.index.v1'
const LS_PROJ = (id: string) => `tp.project.v1.${id}`
const LS_SNAP = (id: string) => `tp.snapshots.v1.${id}`

interface Hist { past: string[]; future: string[] }
const histories: Record<string, Hist> = {}
const hist = (id: string) => (histories[id] ??= { past: [], future: [] })

let persistTimer: ReturnType<typeof setTimeout> | undefined
const lastSnapAt: Record<string, number> = {}

function persistSoon(get: () => Store) {
  clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    try {
      const s = get()
      localStorage.setItem(LS_INDEX, JSON.stringify({
        order: s.projects.map(p => p.id),
        activeId: s.activeId,
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

function loadInitial(): { projects: Project[]; activeId: Id; prefs: Partial<UIState>; fresh: boolean } {
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
        return { projects, activeId, prefs: idx.prefs ?? {}, fresh: false }
      }
    }
  } catch { /* fall through */ }
  const p = blankProject('Untitled')
  return { projects: [p], activeId: p.id, prefs: {}, fresh: true }
}

const init = loadInitial()

export const useStore = create<Store>((set, get) => ({
  projects: init.projects,
  activeId: init.activeId,
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
    if (!cur) return
    const h = hist(cur.id)
    h.past.push(JSON.stringify(cur))
    if (h.past.length > 100) h.past.shift()
    h.future = []
    const draft = structuredClone(cur)
    recipe(draft)
    set({ projects: s.projects.map(p => (p.id === cur.id ? draft : p)) })
    persistSoon(get)
  },

  tweak: recipe => {
    const s = get()
    const cur = s.projects.find(p => p.id === s.activeId)
    if (!cur) return
    const draft = structuredClone(cur)
    recipe(draft)
    set({ projects: s.projects.map(p => (p.id === cur.id ? draft : p)) })
    persistSoon(get)
  },

  setCamera: cam => {
    const s = get()
    set({ projects: s.projects.map(p => (p.id === s.activeId ? { ...p, camera: cam } : p)) })
    persistSoon(get)
  },

  undo: () => {
    const s = get()
    const cur = s.projects.find(p => p.id === s.activeId)
    if (!cur) return
    const h = hist(cur.id)
    const prev = h.past.pop()
    if (!prev) return
    h.future.push(JSON.stringify(cur))
    const restored = JSON.parse(prev) as Project
    restored.camera = cur.camera
    set({ projects: s.projects.map(p => (p.id === cur.id ? restored : p)), ui: { ...s.ui, selection: [] } })
    persistSoon(get)
  },

  redo: () => {
    const s = get()
    const cur = s.projects.find(p => p.id === s.activeId)
    if (!cur) return
    const h = hist(cur.id)
    const next = h.future.pop()
    if (!next) return
    h.past.push(JSON.stringify(cur))
    const restored = JSON.parse(next) as Project
    restored.camera = cur.camera
    set({ projects: s.projects.map(p => (p.id === cur.id ? restored : p)), ui: { ...s.ui, selection: [] } })
    persistSoon(get)
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
    const projects = s.projects.filter(p => p.id !== id)
    set({ projects, activeId: s.activeId === id ? projects[0].id : s.activeId, ui: { ...s.ui, selection: [] } })
    persistSoon(get)
  },

  setActive: id => { set(s => ({ activeId: id, ui: { ...s.ui, selection: [] } })); persistSoon(get) },

  renameProject: (id, name) => {
    set(s => ({ projects: s.projects.map(p => (p.id === id ? { ...p, name } : p)) }))
    persistSoon(get)
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
}))

export function useActiveProject(): Project {
  return useStore(s => s.projects.find(p => p.id === s.activeId) ?? s.projects[0])
}
