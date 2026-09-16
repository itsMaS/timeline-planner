import type { Id, ItemType, Project, TypeFolder } from './types'

/**
 * Helpers for the nested type-folder tree in the sidebar.
 *
 * Folders reference their parent by id (TypeFolder.parentId); types reference
 * the folder they are filed in (ItemType.folderId). Everything here is
 * derived on the fly from those two fields — no cached tree in the document.
 */

export const childFolders = (p: Project, parentId: Id | null): TypeFolder[] =>
  p.typeFolders.filter(f => (f.parentId ?? null) === parentId)

export const typesInFolder = (p: Project, folderId: Id | null): ItemType[] =>
  p.types.filter(t => (t.folderId ?? null) === folderId)

/** Every folder id below `folderId` (not including itself). */
export function descendantFolderIds(p: Project, folderId: Id): Id[] {
  const out: Id[] = []
  const walk = (id: Id) => {
    for (const f of childFolders(p, id)) { out.push(f.id); walk(f.id) }
  }
  walk(folderId)
  return out
}

/** Types filed in `folderId` or any folder below it. */
export function typesInSubtree(p: Project, folderId: Id): ItemType[] {
  const ids = new Set([folderId, ...descendantFolderIds(p, folderId)])
  return p.types.filter(t => t.folderId && ids.has(t.folderId))
}

/** True when `maybeChild` is `folderId` itself or sits anywhere below it. */
export function isSelfOrDescendant(p: Project, folderId: Id, maybeChild: Id): boolean {
  return folderId === maybeChild || descendantFolderIds(p, folderId).includes(maybeChild)
}

/** Depth-first flattening of the folder tree with nesting depth, for dropdowns. */
export function folderTree(p: Project): { folder: TypeFolder; depth: number }[] {
  const out: { folder: TypeFolder; depth: number }[] = []
  const walk = (parentId: Id | null, depth: number) => {
    for (const f of childFolders(p, parentId)) {
      out.push({ folder: f, depth })
      walk(f.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

/** "Parent › Child" breadcrumb path for a folder. */
export function folderPath(p: Project, folderId: Id | null): string {
  return folderChain(p, folderId).map(f => f.name).join(' › ')
}

/** Ancestors of `folderId`, root-most first, ending with the folder itself. */
export function folderChain(p: Project, folderId: Id | null): TypeFolder[] {
  const out: TypeFolder[] = []
  let cur = folderId
  const seen = new Set<Id>()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const f = p.typeFolders.find(x => x.id === cur)
    if (!f) break
    out.unshift(f)
    cur = f.parentId ?? null
  }
  return out
}

/**
 * Repair folder links after load / concurrent edits: dangling parents become
 * top-level, and any cycle (a folder nested inside its own descendant) is cut
 * at the offending link. Only invalid links are touched, so a healthy project
 * comes back byte-identical (no spurious undo entries or sync patches).
 */
export function repairFolders(p: Project): void {
  const byId = new Map(p.typeFolders.map(f => [f.id, f]))
  for (const f of p.typeFolders) {
    if (f.parentId && (!byId.has(f.parentId) || f.parentId === f.id)) f.parentId = null
  }
  for (const f of p.typeFolders) {
    const seen = new Set<Id>([f.id])
    let cur = f
    while (cur.parentId) {
      if (seen.has(cur.parentId)) { cur.parentId = null; break }
      seen.add(cur.parentId)
      cur = byId.get(cur.parentId)!
    }
  }
  for (const t of p.types) {
    if (t.folderId && !byId.has(t.folderId)) t.folderId = null
  }
}

/**
 * Remove a folder, lifting its types and sub-folders into its parent so
 * nothing is lost. Mutates in place.
 */
export function dissolveFolder(p: Project, folderId: Id): void {
  const f = p.typeFolders.find(x => x.id === folderId)
  if (!f) return
  const parent = f.parentId ?? null
  for (const t of p.types) if (t.folderId === folderId) t.folderId = parent
  for (const c of p.typeFolders) if (c.parentId === folderId) c.parentId = parent
  p.typeFolders = p.typeFolders.filter(x => x.id !== folderId)
}
