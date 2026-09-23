import type { FieldDef, Folder, FolderKind, Id, ItemType, ProcessorDef, Project } from './types'

/**
 * Helpers for the nested sidebar folder trees: item types, fields and
 * processors each have their own list of folders (`typeFolders`,
 * `fieldFolders`, `processorFolders`), all the same shape.
 *
 * Folders reference their parent by id (Folder.parentId); members reference
 * the folder they are filed in (folderId). Everything here is derived on the
 * fly from those two fields — no cached tree in the document. Every helper
 * takes the folder kind, defaulting to the type folders the code grew up with.
 */

export type FolderMember = { id: Id; folderId?: Id | null; name: string }

export const foldersOf = (p: Project, kind: FolderKind): Folder[] =>
  kind === 'types' ? p.typeFolders : kind === 'fields' ? p.fieldFolders : p.processorFolders

export const setFoldersOf = (p: Project, kind: FolderKind, list: Folder[]) => {
  if (kind === 'types') p.typeFolders = list
  else if (kind === 'fields') p.fieldFolders = list
  else p.processorFolders = list
}

/** The entities a folder list files: types, fields or processors. */
export const membersOf = (p: Project, kind: FolderKind): (ItemType | FieldDef | ProcessorDef)[] =>
  kind === 'types' ? p.types : kind === 'fields' ? p.fields : p.processors

export const childFolders = (p: Project, parentId: Id | null, kind: FolderKind = 'types'): Folder[] =>
  foldersOf(p, kind).filter(f => (f.parentId ?? null) === parentId)

export const typesInFolder = (p: Project, folderId: Id | null): ItemType[] =>
  p.types.filter(t => (t.folderId ?? null) === folderId)

/** Members (types / fields / processors) filed directly in `folderId`, in document order. */
export function membersInFolder<T extends FolderMember>(list: T[], folderId: Id | null): T[] {
  return list.filter(m => (m.folderId ?? null) === folderId)
}

/** Every folder id below `folderId` (not including itself). */
export function descendantFolderIds(p: Project, folderId: Id, kind: FolderKind = 'types'): Id[] {
  const out: Id[] = []
  const walk = (id: Id) => {
    for (const f of childFolders(p, id, kind)) { out.push(f.id); walk(f.id) }
  }
  walk(folderId)
  return out
}

/** Types filed in `folderId` or any folder below it. */
export function typesInSubtree(p: Project, folderId: Id): ItemType[] {
  const ids = new Set([folderId, ...descendantFolderIds(p, folderId)])
  return p.types.filter(t => t.folderId && ids.has(t.folderId))
}

/** Members filed in `folderId` or any folder below it. */
export function membersInSubtree<T extends FolderMember>(p: Project, kind: FolderKind, list: T[], folderId: Id): T[] {
  const ids = new Set([folderId, ...descendantFolderIds(p, folderId, kind)])
  return list.filter(m => m.folderId && ids.has(m.folderId))
}

/** True when `maybeChild` is `folderId` itself or sits anywhere below it. */
export function isSelfOrDescendant(p: Project, folderId: Id, maybeChild: Id, kind: FolderKind = 'types'): boolean {
  return folderId === maybeChild || descendantFolderIds(p, folderId, kind).includes(maybeChild)
}

/** Depth-first flattening of the folder tree with nesting depth, for dropdowns. */
export function folderTree(p: Project, kind: FolderKind = 'types'): { folder: Folder; depth: number }[] {
  const out: { folder: Folder; depth: number }[] = []
  const walk = (parentId: Id | null, depth: number) => {
    for (const f of childFolders(p, parentId, kind)) {
      out.push({ folder: f, depth })
      walk(f.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

/** "Parent › Child" breadcrumb path for a folder. */
export function folderPath(p: Project, folderId: Id | null, kind: FolderKind = 'types'): string {
  return folderChain(p, folderId, kind).map(f => f.name).join(' › ')
}

/** Ancestors of `folderId`, root-most first, ending with the folder itself. */
export function folderChain(p: Project, folderId: Id | null, kind: FolderKind = 'types'): Folder[] {
  const out: Folder[] = []
  const folders = foldersOf(p, kind)
  let cur = folderId
  const seen = new Set<Id>()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const f = folders.find(x => x.id === cur)
    if (!f) break
    out.unshift(f)
    cur = f.parentId ?? null
  }
  return out
}

/**
 * Members in sidebar order: root members first, then each folder's members
 * depth-first in tree order (stable within a folder). The inspector and the
 * exports use this so fields appear grouped the way the sidebar shows them.
 */
export function orderedMembers<T extends FolderMember>(p: Project, kind: FolderKind, list: T[]): T[] {
  const out: T[] = membersInFolder(list, null)
  for (const { folder } of folderTree(p, kind)) out.push(...membersInFolder(list, folder.id))
  // Members pointing at a folder that no longer exists come last.
  const seen = new Set(out.map(m => m.id))
  for (const m of list) if (!seen.has(m.id)) out.push(m)
  return out
}

/** Members grouped by folder in sidebar order; the root group (folder null) comes first when non-empty. */
export function groupedMembers<T extends FolderMember>(p: Project, kind: FolderKind, list: T[]): { folder: Folder | null; members: T[] }[] {
  const out: { folder: Folder | null; members: T[] }[] = []
  const root = membersInFolder(list, null)
  const known = new Set(foldersOf(p, kind).map(f => f.id))
  const stray = list.filter(m => m.folderId && !known.has(m.folderId))
  if (root.length || stray.length) out.push({ folder: null, members: [...root, ...stray] })
  for (const { folder } of folderTree(p, kind)) {
    const members = membersInFolder(list, folder.id)
    if (members.length) out.push({ folder, members })
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
  for (const kind of ['types', 'fields', 'processors'] as FolderKind[]) {
    const folders = foldersOf(p, kind)
    const byId = new Map(folders.map(f => [f.id, f]))
    for (const f of folders) {
      if (f.parentId && (!byId.has(f.parentId) || f.parentId === f.id)) f.parentId = null
    }
    for (const f of folders) {
      const seen = new Set<Id>([f.id])
      let cur = f
      while (cur.parentId) {
        if (seen.has(cur.parentId)) { cur.parentId = null; break }
        seen.add(cur.parentId)
        cur = byId.get(cur.parentId)!
      }
    }
    for (const m of membersOf(p, kind)) {
      if (m.folderId && !byId.has(m.folderId)) m.folderId = null
    }
  }
}

/**
 * Remove a folder, lifting its members and sub-folders into its parent so
 * nothing is lost. Mutates in place.
 */
export function dissolveFolder(p: Project, folderId: Id, kind: FolderKind = 'types'): void {
  const folders = foldersOf(p, kind)
  const f = folders.find(x => x.id === folderId)
  if (!f) return
  const parent = f.parentId ?? null
  for (const m of membersOf(p, kind)) if (m.folderId === folderId) m.folderId = parent
  for (const c of folders) if (c.parentId === folderId) c.parentId = parent
  setFoldersOf(p, kind, folders.filter(x => x.id !== folderId))
}

/** A fresh folder for any of the three trees. */
export const newFolder = (id: Id, parentId: Id | null, color = '#8b5cf6', kind: FolderKind = 'types'): Folder => ({
  id, name: 'New folder', color, icon: 'Folder', collapsed: false, parentId, ...(kind === 'types' ? { fields: [] } : {}),
})

/**
 * Move a member (field / processor / type) within its list: file it into
 * `folderId` and, when `beforeId` / `afterId` names a sibling, place it right
 * before / after that sibling in document order. Mutates the list in place.
 */
export function moveMember<T extends FolderMember>(list: T[], id: Id, folderId: Id | null, at?: { beforeId?: Id; afterId?: Id }): void {
  const i = list.findIndex(m => m.id === id)
  if (i < 0) return
  const [m] = list.splice(i, 1)
  m.folderId = folderId
  const ref = at?.beforeId ?? at?.afterId
  const j = ref ? list.findIndex(x => x.id === ref) : -1
  if (j < 0) list.push(m)
  else list.splice(at?.beforeId ? j : j + 1, 0, m)
}
