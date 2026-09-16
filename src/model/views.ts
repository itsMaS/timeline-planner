import type { Filters, Id, Project, View } from './types'

/** Saved views and the live filter set. */

const sameSet = (a: string[], b: string[]) => a.length === b.length && b.every(x => a.includes(x))

export function filtersEqual(a: Filters, b: Filters): boolean {
  return sameSet(a.offTypes, b.offTypes) && sameSet(a.offLayers, b.offLayers)
    && sameSet(a.tags, b.tags) && a.text.trim() === b.text.trim()
}

export function isUnfiltered(f: Filters): boolean {
  return !f.offTypes.length && !f.offLayers.length && !f.tags.length && !f.text.trim()
}

export const activeView = (p: Project): View | undefined =>
  (p.activeViewId ? p.views.find(v => v.id === p.activeViewId) : undefined)

/** The active view's filters have been changed since it was applied. */
export function viewDirty(p: Project): boolean {
  const v = activeView(p)
  return !!v && !filtersEqual(p.filters, v.filters)
}

/**
 * A freshly created type stays *off* wherever types are already being
 * filtered: every saved view that hides some types, and the live filters when
 * they do. Views that show everything keep showing everything.
 */
export function hideNewTypeInFilters(p: Project, typeId: Id) {
  for (const v of p.views) if (v.filters.offTypes.length && !v.filters.offTypes.includes(typeId)) v.filters.offTypes.push(typeId)
  if (p.filters.offTypes.length && !p.filters.offTypes.includes(typeId)) p.filters.offTypes.push(typeId)
}
