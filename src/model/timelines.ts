import type { Camera, Id, Item, Project, Section, Timeline, TimelineSettings } from './types'
import { uid } from './util'

/**
 * Timelines (subtabs): a project holds several timelines that share its
 * schema (fields, types, folders, layers, hierarchy levels, processors,
 * views) but keep their own sections, items, settings and camera. Items and
 * sections carry `timelineId`; everything position based (section nesting,
 * processors, snapping, exports) only ever looks inside one timeline, which
 * is what `timelineView` hands out.
 *
 * Pure helpers only: the store and the agent CLI both use this file.
 */

/**
 * Id of the timeline older documents migrate into. Fixed (not random) so every
 * collaborator's copy of a shared document migrates to the same id and later
 * patches line up.
 */
export const FIRST_TIMELINE_ID = 'timeline-0'
export const FIRST_TIMELINE_NAME = 'Main'

export const defaultSettings = (): TimelineSettings => ({
  placement: 'above',
  unit: { preset: 'none', custom: '', showRuler: false },
  grid: { show: false, style: 'solid', opacity: 0.35 },
  spine: { width: 2, opacity: 1 },
  bandStrength: 1,
  sectionStyle: { labelSize: 14, edgeStrength: 0.5, showDuration: false },
})

/** Fill in settings keys missing from an older save. */
export function normalizeSettings(raw: unknown): TimelineSettings {
  const d = defaultSettings()
  const s = ((raw && typeof raw === 'object') ? raw : {}) as Partial<TimelineSettings>
  return {
    placement: s.placement === 'both' ? 'both' : d.placement,
    unit: { ...d.unit, ...(s.unit ?? {}) },
    grid: { ...d.grid, ...(s.grid ?? {}) },
    spine: { ...d.spine, ...(s.spine ?? {}) },
    bandStrength: typeof s.bandStrength === 'number' ? s.bandStrength : d.bandStrength,
    sectionStyle: { ...d.sectionStyle, ...(s.sectionStyle ?? {}) },
  }
}

export function newTimeline(name: string, settings?: TimelineSettings, id = uid()): Timeline {
  return { id, name, settings: settings ? structuredClone(settings) : defaultSettings() }
}

export function normalizeTimeline(raw: Partial<Timeline> & { id: Id }): Timeline {
  return { id: raw.id, name: typeof raw.name === 'string' ? raw.name : 'Timeline', settings: normalizeSettings(raw.settings) }
}

/**
 * Keep the timeline list consistent after any change (load, edit, undo,
 * remote patch): at least one timeline exists, every item and section points
 * at an existing one, and the active timeline is valid.
 *
 * Entities that never had a `timelineId` (old saves, old tabs still running
 * during a rollout, API writes) land on `fallback` when given, else the first
 * timeline; entities whose timeline was deleted go to the first timeline.
 */
export function repairTimelines(p: Project, fallback?: Id | null): void {
  if (!Array.isArray(p.timelines)) p.timelines = []
  if (!p.timelines.length) {
    p.timelines.push(newTimeline(FIRST_TIMELINE_NAME, normalizeSettings(p.settings), FIRST_TIMELINE_ID))
  }
  const ids = new Set(p.timelines.map(t => t.id))
  const first = p.timelines[0].id
  const fb = fallback && ids.has(fallback) ? fallback : first
  for (const it of p.items) {
    if (!it.timelineId) it.timelineId = fb
    else if (!ids.has(it.timelineId)) it.timelineId = first
  }
  for (const sc of p.sections) {
    if (!sc.timelineId) sc.timelineId = fb
    else if (!ids.has(sc.timelineId)) sc.timelineId = first
  }
  if (!p.cameras || typeof p.cameras !== 'object') p.cameras = {}
  for (const k of Object.keys(p.cameras)) if (!ids.has(k)) delete p.cameras[k]
  if (!p.activeTimelineId || !ids.has(p.activeTimelineId)) p.activeTimelineId = first
}

/** The timeline this tab shows (the first when nothing is selected). */
export function activeTimeline(p: Project): Timeline {
  return p.timelines.find(t => t.id === p.activeTimelineId) ?? p.timelines[0]
}

export const timelineById = (p: Project, id: Id | null | undefined): Timeline | undefined =>
  (id ? p.timelines.find(t => t.id === id) : undefined)

export const timelineName = (p: Project, id: Id | null | undefined): string =>
  timelineById(p, id)?.name ?? 'Timeline'

/** The timeline an item or section lives on. */
export function timelineOf(p: Project, entityId: Id): Timeline | undefined {
  const e = p.items.find(i => i.id === entityId) ?? p.sections.find(s => s.id === entityId)
  return e ? timelineById(p, e.timelineId) : undefined
}

/** Order index of a timeline, for sorting entities across timelines. */
export function timelineIndex(p: Project, id: Id): number {
  const i = p.timelines.findIndex(t => t.id === id)
  return i < 0 ? p.timelines.length : i
}

export const itemsOf = (p: Project, timelineId: Id): Item[] => p.items.filter(it => it.timelineId === timelineId)
export const sectionsOf = (p: Project, timelineId: Id): Section[] => p.sections.filter(sc => sc.timelineId === timelineId)

// Views are cached per (project object, timeline id) so a store selector that
// returns one hands React the same object until the project actually changes.
const viewCache = new WeakMap<Project, Map<Id, Project>>()

/**
 * A view remembers the whole project it was cut from (non-enumerable, so it
 * never reaches JSON, patches or clones). Entity lookups fall back to it, so
 * a reference to an entry on another timeline still resolves to its title.
 */
const WHOLE = Symbol('whole')

export function wholeOf(p: Project): Project {
  return (p as unknown as Record<symbol, Project | undefined>)[WHOLE] ?? p
}

/** `{ ...p, ...patch }` that keeps the link to the whole project a view carries. */
export function derived(p: Project, patch: Partial<Project>): Project {
  const out = { ...p, ...patch } as Project
  const whole = (p as unknown as Record<symbol, Project | undefined>)[WHOLE]
  if (whole) Object.defineProperty(out, WHOLE, { value: whole, enumerable: false })
  return out
}

/**
 * The project as one timeline sees it: only that timeline's items and
 * sections, with `settings` and `camera` taken from it. The schema is the
 * shared one. This is what the canvas, layout, processors, exports and the
 * sidebar work on; mutations still go to the whole project.
 */
export function timelineView(p: Project, timelineId?: Id | null): Project {
  const tl = timelineById(p, timelineId) ?? activeTimeline(p)
  if (!tl) return p
  let perTimeline = viewCache.get(p)
  if (!perTimeline) { perTimeline = new Map(); viewCache.set(p, perTimeline) }
  const hit = perTimeline.get(tl.id)
  if (hit) return hit
  const camera: Camera = tl.id === p.activeTimelineId || !p.cameras?.[tl.id]
    ? p.camera
    : p.cameras[tl.id]
  const view: Project = {
    ...p,
    items: itemsOf(p, tl.id),
    sections: sectionsOf(p, tl.id),
    settings: tl.settings,
    camera,
    activeTimelineId: tl.id,
  }
  Object.defineProperty(view, WHOLE, { value: wholeOf(p), enumerable: false })
  perTimeline.set(tl.id, view)
  return view
}

/** Number of timelines an entity id set spans, for labels. */
export function countTimelines(p: Project): number {
  return p.timelines.length
}

/**
 * Copy of a timeline: new timeline entity, fresh ids for its sections and
 * items, references between the copied entries remapped to the copies
 * (references to entries elsewhere are kept as they are).
 */
export function duplicateTimeline(p: Project, sourceId: Id, name: string): Timeline | null {
  const src = timelineById(p, sourceId)
  if (!src) return null
  const tl = newTimeline(name, src.settings)
  const idMap = new Map<Id, Id>()
  const sections = sectionsOf(p, src.id).map(sc => { const id = uid(); idMap.set(sc.id, id); return { ...structuredClone(sc), id, timelineId: tl.id } })
  const items = itemsOf(p, src.id).map(it => { const id = uid(); idMap.set(it.id, id); return { ...structuredClone(it), id, timelineId: tl.id } })
  const refIds = new Set(p.fields.filter(f => f.kind === 'ref').map(f => f.id))
  const remap = (rec: Record<Id, unknown> | undefined) => {
    if (!rec) return
    for (const fid of refIds) {
      const v = rec[fid]
      if (Array.isArray(v)) rec[fid] = v.map(x => idMap.get(String(x)) ?? x)
    }
  }
  for (const sc of sections) remap(sc.fieldValues)
  for (const it of items) remap(it.fieldValues)
  const at = p.timelines.findIndex(t => t.id === src.id)
  p.timelines.splice(at + 1, 0, tl)
  p.sections.push(...sections)
  p.items.push(...items)
  return tl
}

/** Remove a timeline with everything on it. Refuses to remove the last one. */
export function removeTimeline(p: Project, id: Id): boolean {
  if (p.timelines.length <= 1 || !p.timelines.some(t => t.id === id)) return false
  p.timelines = p.timelines.filter(t => t.id !== id)
  p.items = p.items.filter(it => it.timelineId !== id)
  p.sections = p.sections.filter(sc => sc.timelineId !== id)
  delete p.cameras?.[id]
  return true
}

/** A name no other timeline uses yet ("Timeline 2", "Timeline 3", …). */
export function nextTimelineName(p: Project, base = 'Timeline'): string {
  const taken = new Set(p.timelines.map(t => t.name.trim().toLowerCase()))
  for (let n = p.timelines.length + 1; ; n++) {
    const name = `${base} ${n}`
    if (!taken.has(name.toLowerCase())) return name
  }
}
