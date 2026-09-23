import React, { useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Eye, EyeOff, FolderPlus, Plus, Settings2, Target, Trash2 } from 'lucide-react'
import {
  attachedToNames, childrenOf, descendantsOf, fieldUsage, glyphFor, isDerived, kindLabel, newFieldDef, rootFields, typesWithField,
} from '../model/fields'
import {
  childFolders, dissolveFolder, foldersOf, folderTree, isSelfOrDescendant, membersInFolder, membersInSubtree, membersOf,
  moveMember, newFolder, type FolderMember,
} from '../model/folders'
import { iconByName } from '../model/icons'
import { processorUsage } from '../model/processors'
import { useActiveProject, useCanEdit, useStore } from '../model/store'
import type { FieldDef, Folder, FolderKind, ProcessorDef } from '../model/types'
import { PALETTE, uid } from '../model/util'
import { IconPicker } from './IconPicker'
import { describeProcessor } from './SchemaEditors'
import { Select } from './Select'

type Kind = Exclude<FolderKind, 'types'>

type Drag =
  | { what: 'member'; id: string; x: number; y: number; started: boolean }
  | { what: 'folder'; id: string; x: number; y: number; started: boolean }

/** Where a dragged row would land: into a folder ('' = root), or before / after a sibling member. */
type Drop = { folderId: string } | { memberId: string; side: 'before' | 'after' }

/**
 * The fields or processors tree in the sidebar: nested folders (colour, icon,
 * collapse, drag to nest) and member rows that drag to reorder or to file
 * into a folder. Clicking a member opens its editor.
 */
export function SchemaTree({ kind, query }: { kind: Kind; query: string }) {
  const proj = useActiveProject()
  const canEdit = useCanEdit()
  const mutate = useStore(s => s.mutate)
  const tweak = useStore(s => s.tweak)
  const setUI = useStore(s => s.setUI)
  const [openFolderId, setOpenFolderId] = useState<string | null>(null)
  const [iconPick, setIconPick] = useState(false)
  const [localCollapsed, setLocalCollapsed] = useState<Record<string, boolean>>({})
  const [drag, setDrag] = useState<Drag | null>(null)
  const [drop, setDrop] = useState<Drop | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const dropRef = useRef<Drop | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const q = query.trim().toLowerCase()
  // Children of a composite are listed under their group, never as members of the tree themselves.
  const members = (kind === 'fields' ? rootFields(proj) : membersOf(proj, kind)) as (FieldDef | ProcessorDef)[]
  const folders = foldersOf(proj, kind)
  const describe = (m: FieldDef | ProcessorDef) =>
    kind === 'fields' ? kindLabel((m as FieldDef).kind) : describeProcessor(proj.fields, m as ProcessorDef)
  const matchesSelf = (m: FieldDef | ProcessorDef) => !q || m.name.toLowerCase().includes(q) || describe(m).toLowerCase().includes(q)
  const matches = (m: FieldDef | ProcessorDef): boolean =>
    matchesSelf(m) || (kind === 'fields' && (m as FieldDef).kind === 'group' && descendantsOf(proj, m as FieldDef).some(matchesSelf))
  const isCollapsed = (f: Folder) => (q ? false : canEdit ? f.collapsed : (localCollapsed[f.id] ?? f.collapsed))
  const toggleCollapsed = (f: Folder) => {
    if (canEdit) tweak(p => { const x = foldersOf(p, kind).find(y => y.id === f.id); if (x) x.collapsed = !x.collapsed })
    else setLocalCollapsed(m => ({ ...m, [f.id]: !isCollapsed(f) }))
  }
  const editFolder = (id: string, recipe: (f: Folder) => void) =>
    mutate(p => { const x = foldersOf(p, kind).find(y => y.id === id); if (x) recipe(x) })
  const openEditor = (id: string) => setUI(kind === 'fields' ? { editFieldId: id } : { editProcessorId: id })

  // ---- visibility (per-user filters, saved with views): hidden fields leave
  // the canvas labels, tooltip and exports; hidden processors the band badge
  // and exports. The inspector always shows both.
  const offList = (f: typeof proj.filters) => (kind === 'fields' ? f.offFields : f.offProcessors)
  const isOff = (id: string) => offList(proj.filters).includes(id)
  const setOff = (ids: string[], off: boolean) => tweak(p => {
    const set = new Set(offList(p.filters))
    for (const id of ids) { if (off) set.add(id); else set.delete(id) }
    if (kind === 'fields') p.filters.offFields = [...set]; else p.filters.offProcessors = [...set]
  })
  /** Unhide every type whose items carry the field (and the field itself). */
  const reveal = (fieldId: string) => tweak(p => {
    const ids = new Set(typesWithField(p, fieldId).map(t => t.id))
    p.filters.offTypes = p.filters.offTypes.filter(id => !ids.has(id))
    p.filters.offFields = p.filters.offFields.filter(id => id !== fieldId)
  })

  const addMember = (folderId: string | null) => {
    const id = uid()
    mutate(p => {
      if (kind === 'fields') p.fields.push({ ...newFieldDef(id, 'New field'), folderId })
      else p.processors.push({ id, name: 'New processor', op: 'count', fieldId: null, targets: [], folderId })
    })
    openEditor(id)
  }
  const addFolder = (parentId: string | null, color?: string) => {
    const id = uid()
    mutate(p => foldersOf(p, kind).push(newFolder(id, parentId, color, kind)))
    if (parentId) tweak(p => { const x = foldersOf(p, kind).find(y => y.id === parentId); if (x) x.collapsed = false })
    setOpenFolderId(id)
  }

  // ---- drag: members reorder / file, folders re-parent. Targets are read
  // from the DOM under the pointer so nested folders need no bookkeeping.
  const targetAt = (x: number, y: number): Drop | null => {
    const el = document.elementFromPoint(x, y)
    if (!el || !rootRef.current?.contains(el)) return null
    const row = el.closest<HTMLElement>('[data-st-member]')
    if (row) {
      const r = row.getBoundingClientRect()
      return { memberId: row.dataset.stMember!, side: y < r.top + r.height / 2 ? 'before' : 'after' }
    }
    const fo = el.closest<HTMLElement>('[data-st-folder]')
    if (fo) return { folderId: fo.dataset.stFolder ?? '' }
    return null
  }
  const setDropBoth = (d: Drop | null) => { dropRef.current = d; setDrop(d) }
  const startDrag = (e: React.PointerEvent, d: Drag) => {
    if (e.button !== 0 || !canEdit) return
    if ((e.target as Element).closest('input, button, .select-trigger')) return
    dragRef.current = d
    const onMove = (ev: PointerEvent) => {
      const cur = dragRef.current
      if (!cur) return
      if (!cur.started && Math.hypot(ev.clientX - cur.x, ev.clientY - cur.y) > 5) { cur.started = true }
      if (!cur.started) return
      cur.x = ev.clientX; cur.y = ev.clientY
      setDrag({ ...cur })
      setDropBoth(targetAt(ev.clientX, ev.clientY))
    }
    const finish = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', finish)
      dragRef.current = null
      setDrag(null)
      setDropBoth(null)
    }
    const onUp = () => {
      const cur = dragRef.current
      const at = dropRef.current
      finish()
      if (!cur?.started || !at) return
      if (cur.what === 'member') {
        mutate(p => {
          const list = membersOf(p, kind) as FolderMember[]
          if ('memberId' in at) {
            if (at.memberId === cur.id) return
            const sib = list.find(m => m.id === at.memberId)
            if (!sib) return
            moveMember(list, cur.id, sib.folderId ?? null, at.side === 'before' ? { beforeId: sib.id } : { afterId: sib.id })
          } else {
            moveMember(list, cur.id, at.folderId || null)
          }
        })
      } else {
        // Folder drop: nest under the target folder (or the parent of the target member), never inside itself.
        let target: string | null
        if ('memberId' in at) target = (members.find(m => m.id === at.memberId)?.folderId ?? null)
        else target = at.folderId || null
        if (target && isSelfOrDescendant(proj, cur.id, target, kind)) return
        const curParent = folders.find(f => f.id === cur.id)?.parentId ?? null
        if (target === curParent) return
        editFolder(cur.id, f => { f.parentId = target })
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', finish)
  }

  const dropClass = (id: string) => {
    if (!drop || !('memberId' in drop) || drop.memberId !== id) return ''
    return drop.side === 'before' ? 'drop-before' : 'drop-after'
  }
  const folderDropClass = (id: string) => (drop && 'folderId' in drop && drop.folderId === id ? 'drop-into' : '')

  const memberRow = (m: FieldDef | ProcessorDef, depth = 0): React.ReactNode => {
    if (depth === 0 && !matches(m)) return null
    let sub: string
    let count: string | null = null
    let title: string
    if (kind === 'fields') {
      const f = m as FieldDef
      const u = fieldUsage(proj, f.id)
      const attached = attachedToNames(proj, f.id)
      const values = u.items.length + u.sections.length
      sub = f.kind === 'group'
        ? `${childrenOf(proj, f).length} inside${attached.length ? ` · ${attached.join(', ')}` : ''}`
        : isDerived(f) ? `= ${f.formula}` : attached.length ? attached.join(', ') : 'unused'
      count = String(values)
      title = `${kindLabel(f.kind)} · on ${attached.join(', ') || 'nothing'} · ${values} value(s)`
    } else {
      const pr = m as ProcessorDef
      const levels = processorUsage(proj, pr.id)
      sub = `${describeProcessor(proj.fields, pr)}${levels.length ? ` · ${levels.map(l => l.name).join(', ')}` : ''}`
      title = `${describeProcessor(proj.fields, pr)} · on ${levels.map(l => l.name).join(', ') || 'no level'}`
    }
    const lifting = drag?.what === 'member' && drag.id === m.id
    const off = isOff(m.id)
    const stop = (e: React.SyntheticEvent) => e.stopPropagation()
    const child = depth > 0
    const kids = kind === 'fields' && (m as FieldDef).kind === 'group' ? childrenOf(proj, m as FieldDef) : []
    return (
      <React.Fragment key={m.id}>
      <div
        className={`schema-row ${child ? 'child' : dropClass(m.id)} ${lifting ? 'lifting' : ''} ${off ? 'off' : ''}`}
        style={child ? { marginLeft: depth * 14 } : undefined}
        data-st-member={child ? undefined : m.id}
        title={canEdit && !child ? `${title} · drag to reorder or file into a folder` : title}
        onPointerDown={child ? undefined : e => startDrag(e, { what: 'member', id: m.id, x: e.clientX, y: e.clientY, started: false })}
        onClick={() => { if (canEdit && !dragRef.current?.started) openEditor(m.id) }}
      >
        <span className="kind-glyph">{kind === 'fields' ? glyphFor(m as FieldDef) : 'Σ'}</span>
        <span className="type-name">{m.name}</span>
        <span className="schema-sub">{sub}</span>
        {count !== null && <span className="count">{count}</span>}
        {kind === 'fields' && (
          <button
            className="ghost-btn row-act" title="Reveal: show every type that has this field (and the field)"
            onPointerDown={stop} onClick={e => { stop(e); reveal(m.id) }}
          ><Target width={12} height={12} /></button>
        )}
        <button
          className={`ghost-btn row-act ${off ? 'on' : ''}`}
          title={kind === 'fields'
            ? (off ? 'Hidden from the canvas, tooltip and exports · click to show' : 'Hide from the canvas, tooltip and exports (saved with views)')
            : (off ? 'Hidden from the band and exports · click to show' : 'Hide from the band and exports (saved with views)')}
          onPointerDown={stop} onClick={e => { stop(e); setOff([m.id], !off) }}
        >{off ? <EyeOff width={12} height={12} /> : <Eye width={12} height={12} />}</button>
        {canEdit && <Settings2 width={12} height={12} className="row-gear" />}
      </div>
      {kids.map(c => memberRow(c, depth + 1))}
      </React.Fragment>
    )
  }

  const folderNode = (f: Folder): React.ReactNode => {
    const subs = childFolders(proj, f.id, kind)
    const direct = membersInFolder(members, f.id)
    const all = membersInSubtree(proj, kind, members, f.id)
    if (q && !all.some(matches)) return null
    const FIcon = iconByName(f.icon)
    const collapsed = isCollapsed(f)
    const Chev = collapsed ? ChevronRight : ChevronDown
    const lifting = drag?.what === 'folder' && drag.id === f.id
    const allOff = all.length > 0 && all.every(m => isOff(m.id))
    const moveTargets = folderTree(proj, kind).filter(({ folder }) => !isSelfOrDescendant(proj, f.id, folder.id, kind))
    return (
      <React.Fragment key={f.id}>
        <div
          className={`folder-row ${lifting ? 'lifting' : ''} ${allOff ? 'off' : ''} ${folderDropClass(f.id)}`}
          data-st-folder={f.id}
          onPointerDown={e => startDrag(e, { what: 'folder', id: f.id, x: e.clientX, y: e.clientY, started: false })}
          title={canEdit ? 'Drag onto another folder to nest it' : undefined}
        >
          <button className="ghost-btn" title={collapsed ? 'Expand' : 'Collapse'} onClick={() => toggleCollapsed(f)}>
            <Chev width={13} height={13} />
          </button>
          <span className="type-swatch" style={{ background: `${f.color}26`, color: f.color }}><FIcon width={14} height={14} /></span>
          {canEdit
            ? <input className="bare-input" value={f.name} onChange={e => editFolder(f.id, x => { x.name = e.target.value })} />
            : <span className="type-name folder-name">{f.name}</span>}
          <span className="count" title={`${all.length} inside`}>{all.length}</span>
          {canEdit && (
            <button className="ghost-btn row-act" title={kind === 'fields' ? 'New field in this folder' : 'New processor in this folder'} onClick={() => addMember(f.id)}>
              <Plus width={13} height={13} />
            </button>
          )}
          <button
            className={`ghost-btn row-act ${allOff ? 'on' : ''}`}
            title={allOff ? 'Show everything in this folder' : 'Hide everything in this folder'}
            disabled={all.length === 0}
            onClick={() => setOff(all.map(m => m.id), !allOff)}
          >{allOff ? <EyeOff width={13} height={13} /> : <Eye width={13} height={13} />}</button>
          {canEdit && (
            <button
              className={`ghost-btn row-act ${openFolderId === f.id ? 'on' : ''}`} title="Folder settings"
              onClick={() => { setOpenFolderId(id => (id === f.id ? null : f.id)); setIconPick(false) }}
            ><Settings2 width={13} height={13} /></button>
          )}
        </div>
        {canEdit && openFolderId === f.id && (
          <div className="layer-config">
            <div className="palette">
              {PALETTE.map(c => (
                <button key={c} className={`swatch ${f.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => editFolder(f.id, x => { x.color = c })} />
              ))}
              <input type="color" value={f.color} title="Custom color" onChange={e => editFolder(f.id, x => { x.color = e.target.value })} />
            </div>
            <button className="ghost-btn add" onClick={() => setIconPick(v => !v)}>{iconPick ? 'close icon picker' : 'change icon…'}</button>
            {iconPick && <IconPicker value={f.icon} onPick={n => { editFolder(f.id, x => { x.icon = n }); setIconPick(false) }} />}
            <button className="ghost-btn add" onClick={() => addFolder(f.id, f.color)}><FolderPlus width={12} height={12} /> new sub-folder</button>
            <label className="slider-row">
              <span>Inside</span>
              <Select
                value={f.parentId ?? ''}
                options={[{ value: '', label: '(top level)' }, ...moveTargets.map(({ folder, depth }) => ({ value: folder.id, label: folder.name, depth }))]}
                searchPlaceholder="Search folders…"
                onChange={v => editFolder(f.id, x => { x.parentId = v || null })}
              />
            </label>
            <button className="ghost-btn add" onClick={() => { mutate(p => dissolveFolder(p, f.id, kind)); setOpenFolderId(null) }}>
              <Trash2 width={12} height={12} /> delete folder (contents move out)
            </button>
          </div>
        )}
        {!collapsed && (
          <div className={`folder-types ${folderDropClass(f.id)}`} data-st-folder={f.id}>
            {subs.map(folderNode)}
            {direct.map(memberRow)}
            {subs.length === 0 && direct.length === 0 && <div className="sb-hint">{canEdit ? 'drag rows here' : 'empty folder'}</div>}
          </div>
        )}
      </React.Fragment>
    )
  }

  const rootMembers = membersInFolder(members, null)
  const known = new Set(folders.map(f => f.id))
  const stray = members.filter(m => m.folderId && !known.has(m.folderId))
  const dragged = drag?.started
    ? (drag.what === 'member' ? members.find(m => m.id === drag.id) : folders.find(f => f.id === drag.id))
    : null
  return (
    <div ref={rootRef} className={`schema-tree ${drag?.started ? 'dragging' : ''} ${folderDropClass('')}`} data-st-folder="">
      {childFolders(proj, null, kind).map(folderNode)}
      {[...rootMembers, ...stray].map(memberRow)}
      {members.length === 0 && (
        <div className="sb-hint">
          {kind === 'fields'
            ? (canEdit ? 'no fields yet — add one here or from a type editor' : 'no fields')
            : (canEdit ? 'processors sum or count what sits inside a section — attach them to a hierarchy level' : 'no processors')}
        </div>
      )}
      {q && members.length > 0 && !members.some(matches) && <div className="sb-hint">nothing matches</div>}
      {dragged && drag && (
        <div className="drag-ghost" style={{ left: drag.x + 10, top: drag.y + 8, borderColor: 'color' in dragged ? dragged.color : 'var(--accent)' }}>
          {dragged.name}
        </div>
      )}
    </div>
  )
}

/** Header actions for a schema tree section: new folder, new member. */
export function SchemaTreeActions({ kind }: { kind: Kind }) {
  const mutate = useStore(s => s.mutate)
  const setUI = useStore(s => s.setUI)
  return (
    <>
      <button className="ghost-btn" title="New folder" onClick={() => mutate(p => foldersOf(p, kind).push(newFolder(uid(), null, undefined, kind)))}>
        <FolderPlus width={13} height={13} />
      </button>
      <button
        className="ghost-btn" title={kind === 'fields' ? 'New field' : 'New processor'}
        onClick={() => {
          const id = uid()
          mutate(p => {
            if (kind === 'fields') p.fields.push(newFieldDef(id, 'New field'))
            else p.processors.push({ id, name: 'New processor', op: 'count', fieldId: null, targets: [] })
          })
          setUI(kind === 'fields' ? { editFieldId: id } : { editProcessorId: id })
        }}
      ><Plus width={13} height={13} /></button>
    </>
  )
}
