import { itemMatchesFilters, typeOf } from '../model/layout'
import { derived } from '../model/timelines'
import type { Item, Project, Section } from '../model/types'

/**
 * What an export covers: the same rule for every format. Items hidden on the
 * canvas (eye-hidden layers, type / layer / tag / text filters) are left out,
 * and selecting sections narrows the export to just those sub-trees.
 */
export interface ExportScope {
  /** Selected sections (deduplicated, in timeline order); empty = whole timeline. */
  sections: Section[]
  /** Ids of the selected sections, or null for the whole timeline (what the document export takes). */
  sectionIds: string[] | null
  /** Range covered by the selected sections; null for the whole timeline. */
  range: { min: number; max: number } | null
  /** Whether an item is part of the export. */
  includes: (it: Item) => boolean
  /** Items in scope, in timeline order. */
  items: Item[]
  /** Anything hidden by filters? (for labels) */
  filtered: boolean
  /** "PNG of whole timeline" / "PNG of “Chapter 1”" / "PNG of 3 selected sections". */
  describe: (what: string, whole?: string) => string
}

/** Same rule the canvas uses to hide an item outright or ghost it. */
export function isItemVisible(proj: Project, it: Item): boolean {
  const layerId = it.layerId ?? typeOf(proj, it)?.defaultLayerId ?? null
  if (layerId && proj.layers.find(l => l.id === layerId)?.eye) return false
  return itemMatchesFilters(proj, it, proj.filters)
}

const EPS = 1e-9

export function exportScope(proj: Project, selection: string[]): ExportScope {
  const ids = [...new Set(selection.filter(x => x.startsWith('S:')).map(x => x.slice(2)))]
  const sections = ids
    .map(id => proj.sections.find(sc => sc.id === id))
    .filter((sc): sc is Section => !!sc)
    .sort((a, b) => a.start - b.start || a.depth - b.depth)
  const range = sections.length
    ? { min: Math.min(...sections.map(s => s.start)), max: Math.max(...sections.map(s => s.end)) }
    : null
  const inSections = (it: Item) => !sections.length || sections.some(sc => it.pos >= sc.start - EPS && it.pos <= sc.end + EPS)
  const includes = (it: Item) => isItemVisible(proj, it) && inSections(it)
  const items = proj.items.filter(includes).sort((a, b) => a.pos - b.pos)
  const filtered = proj.items.some(it => !isItemVisible(proj, it))
  const describe = (what: string, whole = 'whole timeline') => sections.length === 0
    ? `${what} of ${filtered ? 'visible items' : whole}`
    : sections.length === 1
      ? `${what} of “${sections[0].name || 'Untitled'}”`
      : `${what} of ${sections.length} selected sections`
  return { sections, sectionIds: sections.length ? sections.map(s => s.id) : null, range, includes, items, filtered, describe }
}

/** A copy of the project holding only the items in scope (sections and layers stay for context). */
export function scopedProject(proj: Project, scope: ExportScope): Project {
  return derived(proj, { items: scope.items })
}
