import { entityTitle, referencesTo, stripRefs } from '../model/fields'
import { useStore } from '../model/store'
import type { Id, Project } from '../model/types'

/**
 * Delete items / sections / branches from the active project. When something
 * else references one of them through a reference field, a confirmation
 * lists the affected owners first; on OK the references are stripped too.
 */
export function requestDelete(
  what: { itemIds?: Id[]; sectionIds?: Id[]; branchIds?: Id[] },
  after?: () => void,
) {
  const st = useStore.getState()
  const proj = st.projects.find(p => p.id === st.activeId)
  if (!proj) return
  const itemIds = what.itemIds ?? []
  const sectionIds = what.sectionIds ?? []
  const branchIds = what.branchIds ?? []
  if (!itemIds.length && !sectionIds.length && !branchIds.length) return
  const gone = new Set([...itemIds, ...sectionIds])

  const run = () => {
    useStore.getState().mutate(p => {
      if (gone.size) stripRefs(p, gone)
      if (itemIds.length) p.items = p.items.filter(i => !itemIds.includes(i.id))
      for (const bid of branchIds) {
        const br = p.branches.find(b => b.id === bid)
        if (!br) continue
        const pathIds = br.paths.map(pp => pp.id)
        for (const it of p.items) if (it.pathId && pathIds.includes(it.pathId)) it.pathId = null
        p.branches = p.branches.filter(b => b.id !== bid)
      }
      if (sectionIds.length) p.sections = p.sections.filter(sc => !sectionIds.includes(sc.id))
    })
    after?.()
  }

  const refs = gone.size ? referencesTo(proj, gone) : []
  if (!refs.length) { run(); return }
  const n = gone.size
  const owners = new Map<string, string>()
  for (const r of refs) {
    const title = entityTitle(proj, r.owner.entity.id)
    const key = r.owner.entity.id
    owners.set(key, owners.has(key) ? `${owners.get(key)}, ${r.field.name}` : `${title} — via ${r.field.name}`)
  }
  st.setUI({
    confirm: {
      title: 'Delete referenced ' + describe(proj, itemIds, sectionIds) + '?',
      message: `${n === 1 ? 'It is' : 'They are'} referenced by ${owners.size} other ${owners.size === 1 ? 'entry' : 'entries'}. Those references will be removed.`,
      list: [...owners.values()],
      okLabel: 'Delete anyway',
      onOk: run,
    },
  })
}

function describe(p: Project, itemIds: Id[], sectionIds: Id[]): string {
  const parts: string[] = []
  if (itemIds.length === 1) parts.push(`item “${entityTitle(p, itemIds[0])}”`)
  else if (itemIds.length) parts.push(`${itemIds.length} items`)
  if (sectionIds.length === 1) parts.push(`section “${entityTitle(p, sectionIds[0])}”`)
  else if (sectionIds.length) parts.push(`${sectionIds.length} sections`)
  return parts.join(' and ')
}
