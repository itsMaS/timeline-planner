import { repairFolders } from './folders'
import { newFieldDef, normalizeFieldDef, repairSchema } from './fields'
import { refreshSectionDepths } from './layout'
import { defaultSettings, FIRST_TIMELINE_ID, FIRST_TIMELINE_NAME, newTimeline, normalizeSettings, normalizeTimeline, repairTimelines } from './timelines'
import type { FieldAttachment, FieldDef, FieldValue, Filters, HierarchyLevel, Id, Item, Project } from './types'
import { uid } from './util'

/**
 * Pure document helpers: normalising a stored project (migration of old
 * saves), the empty filters and a blank project. Kept apart from the store
 * so the agent CLI and the Edge Function can use them without pulling in
 * zustand or browser globals.
 */

export { defaultSettings }

export const emptyFilters = (): Filters => ({ offTypes: [], offLayers: [], tags: [], text: '', rules: '', offFields: [], offProcessors: [] })

/** Fill in filter fields missing from older saves (views and the live filters alike). */
export function normalizeFilters(f: Partial<Filters> | undefined): Filters {
  return {
    offTypes: Array.isArray(f?.offTypes) ? f!.offTypes : [],
    offLayers: Array.isArray(f?.offLayers) ? f!.offLayers : [],
    tags: Array.isArray(f?.tags) ? f!.tags : [],
    text: typeof f?.text === 'string' ? f!.text : '',
    rules: typeof f?.rules === 'string' ? f!.rules : '',
    offFields: Array.isArray(f?.offFields) ? f!.offFields : [],
    offProcessors: Array.isArray(f?.offProcessors) ? f!.offProcessors : [],
  }
}

/** Fill in fields missing from projects saved by older versions. */
export function normalizeProject(p: Project): Project {
  p.settings = normalizeSettings(p.settings)
  // Timelines (subtabs) came later: an older document becomes one timeline
  // carrying the project-level settings, with a fixed id so every
  // collaborator migrates a shared document identically.
  p.timelines = Array.isArray(p.timelines)
    ? p.timelines.filter(t => t && typeof t.id === 'string').map(t => normalizeTimeline(t))
    : []
  if (!p.timelines.length) p.timelines = [newTimeline(FIRST_TIMELINE_NAME, p.settings, FIRST_TIMELINE_ID)]
  p.cameras = p.cameras && typeof p.cameras === 'object' ? p.cameras : {}
  p.activeTimelineId ??= null
  p.hierarchyLevels = normalizeLevels(p.hierarchyLevels)
  p.fields = Array.isArray(p.fields) ? p.fields.map(f => normalizeFieldDef(f)) : []
  p.processors = Array.isArray(p.processors) ? p.processors : []
  for (const pr of p.processors) { pr.targets ??= []; pr.fieldId ??= null; pr.where ??= '' }
  p.types ??= []
  p.layers ??= []
  p.sections ??= []
  p.items ??= []
  p.views ??= []
  for (const v of p.views) v.filters = normalizeFilters(v.filters)
  p.camera ??= { x: -8, s: 14 }
  p.filters = normalizeFilters(p.filters)
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
    f.fields = Array.isArray(f.fields) ? f.fields.map(a => normalizeAttachment(a)) : []
  }
  for (const t of p.types) t.folderId ??= null
  p.fieldFolders = Array.isArray(p.fieldFolders) ? p.fieldFolders : []
  p.processorFolders = Array.isArray(p.processorFolders) ? p.processorFolders : []
  for (const f of [...p.fieldFolders, ...p.processorFolders]) { f.parentId ??= null; f.collapsed = !!f.collapsed }
  for (const f of p.fields) f.folderId ??= null
  for (const pr of p.processors) pr.folderId ??= null
  migrateLegacyFields(p)
  // Branching paths were removed: drop the leftovers from older saves so any
  // item that lived on a path comes back onto the main line.
  delete (p as Project & { branches?: unknown }).branches
  for (const it of p.items) delete (it as Item & { pathId?: unknown }).pathId
  repairTimelines(p)
  repairFolders(p)
  refreshSectionDepths(p)
  repairSchema(p)
  return p
}

/** An attachment as stored: field id, default override and (for composites) per-child defaults. */
function normalizeAttachment(a: FieldAttachment): FieldAttachment {
  const out: FieldAttachment = { fieldId: a.fieldId, defaultValue: a.defaultValue ?? null }
  if (a.childDefaults && typeof a.childDefaults === 'object' && Object.keys(a.childDefaults).length) out.childDefaults = a.childDefaults
  return out
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
      fields: Array.isArray(o.fields) ? o.fields.map(a => normalizeAttachment(a)) : [],
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
      if ('fieldId' in raw) { next.push(normalizeAttachment(raw)); continue }
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
  const settings = defaultSettings()
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
    fieldFolders: [],
    processorFolders: [],
    layers,
    timelines: [newTimeline(FIRST_TIMELINE_NAME, settings, FIRST_TIMELINE_ID)],
    sections: [],
    items: [],
    views: [],
    camera: { x: -8, s: 14 },
    cameras: {},
    filters: emptyFilters(),
    activeViewId: null,
    activeTimelineId: FIRST_TIMELINE_ID,
    settings,
  }
}

