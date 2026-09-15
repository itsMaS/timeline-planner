import React, { useMemo, useRef, useState } from 'react'
import {
  ChevronDown, ChevronRight, ChevronUp, Eye, EyeOff, FolderPlus, Pin, Plus, Settings2, Target, Trash2,
} from 'lucide-react'
import { childFolders, dissolveFolder, folderTree, isSelfOrDescendant, typesInFolder, typesInSubtree } from '../model/folders'
import { iconByName } from '../model/icons'
import { attachedToNames, fieldUsage, kindGlyph, kindLabel, newFieldDef } from '../model/fields'
import { itemMatchesFilters, typeOf } from '../model/layout'
import { processorUsage } from '../model/processors'
import { newLevel, useActiveProject, useActiveShare, useCanEdit, useStore } from '../model/store'
import type { ItemType, TypeFolder } from '../model/types'
import { PALETTE, uid } from '../model/util'
import { IconPicker } from './IconPicker'
import { chipDrop, nav } from './nav'
import { ProposalsPanel } from './Proposals'
import { describeProcessor } from './SchemaEditors'
import { TypeSearch } from './TypeSearch'

// The min-zoom slider is logarithmic: camera zoom spans several orders of
// magnitude depending on the project's scope (a 4-hour plan in hours sits in
// the hundreds of px/unit; a huge custom scope well below 1), so a linear
// range can't cover the usable values. Slider 0 = never; 1..100 maps to
// [MZ_LO, MZ_HI] on a log scale.
const MZ_LO = 0.05
const MZ_HI = 5000
const minZoomFromSlider = (v: number) => (v <= 0 ? 0 : MZ_LO * Math.pow(MZ_HI / MZ_LO, (v - 1) / 99))
const sliderFromMinZoom = (mz: number) =>
  mz <= 0 ? 0 : Math.round(Math.min(100, Math.max(1, 1 + 99 * Math.log(mz / MZ_LO) / Math.log(MZ_HI / MZ_LO))))
const fmtZoom = (s: number) => (s >= 100 ? s.toFixed(0) : s >= 10 ? s.toFixed(1) : s >= 1 ? s.toFixed(2) : s.toFixed(3))

function SectionHeader(props: { title: string; open: boolean; toggle: () => void; action?: React.ReactNode }) {
  const Chev = props.open ? ChevronDown : ChevronRight
  return (
    <div className="sb-head" onClick={props.toggle}>
      <Chev width={14} height={14} />
      <span>{props.title}</span>
      <span className="grow" />
      {props.action && <span onClick={e => e.stopPropagation()}>{props.action}</span>}
    </div>
  )
}

export function Sidebar() {
  const proj = useActiveProject()
  const ui = useStore(s => s.ui)
  const setUI = useStore(s => s.setUI)
  const mutate = useStore(s => s.mutate)
  const tweak = useStore(s => s.tweak)
  const select = useStore(s => s.select)
  const canEdit = useCanEdit()
  const share = useActiveShare()
  const openProposals = useStore(s => (s.proposals[s.activeId] ?? []).filter(p => p.status === 'open').length)
  const reviewing = useStore(s => s.ui.reviewProposalId !== null)
  const [open, setOpen] = useState({ proposals: true, types: true, layers: true, structure: false, schema: false, tags: false })
  const toggle = (k: keyof typeof open) => setOpen(o => ({ ...o, [k]: !o[k] }))
  const [openLayerId, setOpenLayerId] = useState<string | null>(null)
  const [openFolderId, setOpenFolderId] = useState<string | null>(null)
  const [folderIconPick, setFolderIconPick] = useState(false)
  // Folder collapse state lives in the document (and syncs); a read-only
  // viewer can't write it, so it keeps its own overrides locally instead.
  const [localCollapsed, setLocalCollapsed] = useState<Record<string, boolean>>({})
  const isCollapsed = (f: TypeFolder) => (canEdit ? f.collapsed : (localCollapsed[f.id] ?? f.collapsed))
  const toggleCollapsed = (f: TypeFolder) => {
    if (canEdit) tweak(p => { const x = p.typeFolders.find(y => y.id === f.id); if (x) x.collapsed = !x.collapsed })
    else setLocalCollapsed(m => ({ ...m, [f.id]: !isCollapsed(f) }))
  }

  // ---- type visibility helpers (shared by rows, folders, and solo buttons)
  const setTypesOff = (ids: string[], off: boolean) => tweak(p => {
    const set = new Set(p.filters.offTypes)
    for (const id of ids) { if (off) set.add(id); else set.delete(id) }
    p.filters.offTypes = [...set]
    p.activeViewId = null
  })
  /**
   * Show only the given types; if they are already the only ones on, go back
   * to the type visibility (and active view) from before the solo. Falls back
   * to showing all when there is nothing remembered (e.g. after a reload).
   */
  const preSolo = useRef<{ offTypes: string[]; activeViewId: string | null; soloOff: string[] } | null>(null)
  const sameSet = (a: string[], b: string[]) => a.length === b.length && b.every(id => a.includes(id))
  const soloTypes = (ids: string[]) => {
    const others = proj.types.filter(t => !ids.includes(t.id)).map(t => t.id)
    if (sameSet(proj.filters.offTypes, others)) {
      const prev = preSolo.current
      preSolo.current = null
      tweak(p => { p.filters.offTypes = prev ? [...prev.offTypes] : []; p.activeViewId = prev ? prev.activeViewId : null })
      return
    }
    // Hopping between solos keeps the original pre-solo state; anything else
    // (filters changed by hand since) snapshots the current one.
    if (!preSolo.current || !sameSet(proj.filters.offTypes, preSolo.current.soloOff)) {
      preSolo.current = { offTypes: [...proj.filters.offTypes], activeViewId: proj.activeViewId, soloOff: others }
    } else preSolo.current.soloOff = others
    tweak(p => { p.filters.offTypes = others; p.activeViewId = null })
  }
  /** Viewer-side layer hiding goes through the per-user filter, never the shared layer flag. */
  const toggleLayerFilter = (id: string) => tweak(p => {
    p.filters.offLayers = p.filters.offLayers.includes(id)
      ? p.filters.offLayers.filter(x => x !== id)
      : [...p.filters.offLayers, id]
    p.activeViewId = null
  })

  // Counts respecting all other filter groups (not the type toggle itself).
  const counts = useMemo(() => {
    const map = new Map<string, number>()
    const f = { ...proj.filters, offTypes: [] as string[] }
    for (const it of proj.items) {
      if (!itemMatchesFilters(proj, it, f)) continue
      map.set(it.typeId, (map.get(it.typeId) ?? 0) + 1)
    }
    return map
  }, [proj])

  const layerCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const it of proj.items) {
      const lid = it.layerId ?? typeOf(proj, it)?.defaultLayerId
      if (lid) map.set(lid, (map.get(lid) ?? 0) + 1)
    }
    return map
  }, [proj])

  const allTags = useMemo(() => {
    const s = new Set<string>()
    for (const it of proj.items) for (const t of it.tags) s.add(t)
    return [...s].sort()
  }, [proj.items])

  // Sections as a containment tree: each section nests under the smallest
  // section that fully encloses it, children ordered by start.
  const sectionTree = useMemo(() => {
    const secs = proj.sections
    const eps = 1e-9
    const parentOf = new Map<string, string | null>()
    for (const s of secs) {
      let best: (typeof secs)[number] | null = null
      for (const t of secs) {
        if (t === s) continue
        const larger = t.end - t.start > s.end - s.start + eps
        if (larger && t.start <= s.start + eps && t.end >= s.end - eps) {
          if (!best || t.end - t.start < best.end - best.start) best = t
        }
      }
      parentOf.set(s.id, best?.id ?? null)
    }
    const childrenOf = new Map<string | null, (typeof secs)[number][]>()
    for (const s of secs) {
      const pid = parentOf.get(s.id) ?? null
      const list = childrenOf.get(pid)
      if (list) list.push(s)
      else childrenOf.set(pid, [s])
    }
    childrenOf.forEach(list => list.sort((a, b) => a.start - b.start))
    const out: { sc: (typeof secs)[number]; level: number }[] = []
    const walk = (pid: string | null, level: number) => {
      for (const s of childrenOf.get(pid) ?? []) {
        out.push({ sc: s, level })
        walk(s.id, level + 1)
      }
    }
    walk(null, 0)
    return out
  }, [proj.sections])

  /** Folder id under the pointer ('' = the top-level drop zone), or null when not over the sidebar. */
  const folderUnderPointer = (x: number, y: number): string | null => {
    const el = document.elementFromPoint(x, y)
    if (!el?.closest('.sidebar')) return null
    const drop = el.closest('[data-type-folder]')
    return drop ? (drop.getAttribute('data-type-folder') ?? '') : null
  }

  // ---- chip drag-to-create (edit mode) / click-to-filter (both modes)
  const dragStart = useRef<{ x: number; y: number; typeId: string; started: boolean } | null>(null)
  const chipPointerDown = (e: React.PointerEvent, typeId: string) => {
    if (e.button !== 0) return
    dragStart.current = { x: e.clientX, y: e.clientY, typeId, started: false }
    const onMove = (ev: PointerEvent) => {
      const d = dragStart.current
      if (!d || !canEdit) return
      if (!d.started && Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 5) {
        d.started = true
        setUI({ dragTypeId: d.typeId })
      }
    }
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const d = dragStart.current
      dragStart.current = null
      if (d?.started) {
        setUI({ dragTypeId: null })
        // Dropping back onto the sidebar files the type into (or out of) a
        // folder instead of creating an item on the timeline.
        const over = folderUnderPointer(ev.clientX, ev.clientY)
        if (over !== null) {
          const fid = over || null
          const cur = proj.types.find(t => t.id === d.typeId)?.folderId ?? null
          if (fid !== cur) mutate(p => { const t = p.types.find(x => x.id === d.typeId); if (t) t.folderId = fid })
        } else {
          chipDrop.current?.(ev.clientX, ev.clientY, d.typeId)
        }
      } else if (d) {
        // Plain click: toggle filter. Alt-click: solo.
        if (ev.altKey) soloTypes([d.typeId])
        else setTypesOff([d.typeId], !proj.filters.offTypes.includes(d.typeId))
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // ---- folder drag-to-nest: drop a folder row onto another folder (or the
  // top-level area) to re-parent it.
  const folderDrag = useRef<{ x: number; y: number; folderId: string; started: boolean } | null>(null)
  const folderPointerDown = (e: React.PointerEvent, folderId: string) => {
    if (e.button !== 0 || !canEdit) return
    if ((e.target as Element).closest('input, button')) return
    folderDrag.current = { x: e.clientX, y: e.clientY, folderId, started: false }
    const onMove = (ev: PointerEvent) => {
      const d = folderDrag.current
      if (!d) return
      if (!d.started && Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 5) {
        d.started = true
        setUI({ dragFolderId: d.folderId })
      }
    }
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const d = folderDrag.current
      folderDrag.current = null
      if (!d?.started) return
      setUI({ dragFolderId: null })
      const over = folderUnderPointer(ev.clientX, ev.clientY)
      if (over === null) return
      const target = over || null
      if (target && isSelfOrDescendant(proj, d.folderId, target)) return
      const cur = proj.typeFolders.find(f => f.id === d.folderId)?.parentId ?? null
      if (target === cur) return
      mutate(p => { const f = p.typeFolders.find(x => x.id === d.folderId); if (f) f.parentId = target })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const newType = (folderId: string | null, color?: string, name?: string) => {
    const id = uid()
    mutate(p => p.types.push({
      id, name: name ?? 'New type', icon: 'Circle',
      color: color ?? (name ? PALETTE[p.types.length % PALETTE.length] : '#8b5cf6'), folderId,
      defaultLayerId: p.layers[Math.min(1, p.layers.length - 1)]?.id ?? null, fields: [],
    }))
    if (folderId) tweak(p => { const x = p.typeFolders.find(y => y.id === folderId); if (x) x.collapsed = false })
    // A named type (from the add-item search) is ready to use; a blank one opens its editor.
    if (!name) setUI({ editTypeId: id })
    return id
  }

  const newFolder = (parentId: string | null, color?: string) => {
    mutate(p => p.typeFolders.push({
      id: uid(), name: 'New folder', color: color ?? '#8b5cf6', icon: 'Folder', collapsed: false, parentId,
    }))
    if (parentId) tweak(p => { const x = p.typeFolders.find(y => y.id === parentId); if (x) x.collapsed = false })
  }

  if (!ui.sidebarOpen) return null

  const typeRow = (t: ItemType) => {
    const Icon = iconByName(t.icon)
    const off = proj.filters.offTypes.includes(t.id)
    return (
      <div
        key={t.id}
        className={`type-row ${off ? 'off' : ''}`}
        onPointerDown={e => chipPointerDown(e, t.id)}
        title={canEdit
          ? 'Click to filter · Alt-click to solo · Drag onto the timeline to create, onto a folder to file'
          : 'Click to filter · Alt-click to solo'}
      >
        <span className="type-swatch" style={{ background: `${t.color}26`, color: t.color }}>
          <Icon width={14} height={14} />
        </span>
        <span className="type-name">{t.name}</span>
        <span className="count">{counts.get(t.id) ?? 0}</span>
        <button
          className={`ghost-btn row-act ${off ? 'on' : ''}`}
          title={off ? 'Unhide' : 'Hide'}
          onPointerDown={e => e.stopPropagation()}
          onClick={() => setTypesOff([t.id], !off)}
        >{off ? <EyeOff width={13} height={13} /> : <Eye width={13} height={13} />}</button>
        <button
          className="ghost-btn row-act"
          title="Solo — show only this type (again to go back)"
          onPointerDown={e => e.stopPropagation()}
          onClick={() => soloTypes([t.id])}
        ><Target width={13} height={13} /></button>
        {canEdit && (
          <button
            className="ghost-btn row-act"
            title="Edit type"
            onPointerDown={e => e.stopPropagation()}
            onClick={() => setUI({ editTypeId: t.id })}
          ><Settings2 width={13} height={13} /></button>
        )}
      </div>
    )
  }

  const folderNode = (f: TypeFolder): React.ReactNode => {
    const subs = childFolders(proj, f.id)
    const direct = typesInFolder(proj, f.id)
    const all = typesInSubtree(proj, f.id)
    const FIcon = iconByName(f.icon)
    const collapsed = isCollapsed(f)
    const Chev = collapsed ? ChevronRight : ChevronDown
    const allOff = all.length > 0 && all.every(t => proj.filters.offTypes.includes(t.id))
    const lifting = ui.dragFolderId === f.id
    const editFolder = (recipe: (x: TypeFolder) => void) =>
      mutate(p => { const x = p.typeFolders.find(y => y.id === f.id); if (x) recipe(x) })
    // Destinations for "move to": everything except this folder and its own subtree.
    const moveTargets = folderTree(proj).filter(({ folder }) => !isSelfOrDescendant(proj, f.id, folder.id))
    return (
      <React.Fragment key={f.id}>
        <div
          className={`folder-row ${allOff ? 'off' : ''} ${lifting ? 'lifting' : ''}`}
          data-type-folder={f.id}
          onPointerDown={e => folderPointerDown(e, f.id)}
          title={canEdit ? 'Drag onto another folder to nest it' : undefined}
        >
          <button
            className="ghost-btn"
            title={collapsed ? 'Expand' : 'Collapse'}
            onClick={() => toggleCollapsed(f)}
          ><Chev width={13} height={13} /></button>
          <span className="type-swatch" style={{ background: `${f.color}26`, color: f.color }}>
            <FIcon width={14} height={14} />
          </span>
          {canEdit ? (
            <input
              className="bare-input"
              value={f.name}
              onChange={e => editFolder(x => { x.name = e.target.value })}
            />
          ) : (
            <span className="type-name folder-name">{f.name}</span>
          )}
          <span className="count" title={`${all.length} type(s) inside`}>{all.length}</span>
          {canEdit && (
            <button
              className="ghost-btn row-act"
              title="New type in this folder"
              onClick={() => newType(f.id, f.color)}
            ><Plus width={13} height={13} /></button>
          )}
          <button
            className={`ghost-btn row-act ${allOff ? 'on' : ''}`}
            title={allOff ? 'Unhide folder' : 'Hide folder'}
            onClick={() => setTypesOff(all.map(t => t.id), !allOff)}
            disabled={all.length === 0}
          >{allOff ? <EyeOff width={13} height={13} /> : <Eye width={13} height={13} />}</button>
          <button
            className="ghost-btn row-act"
            title="Solo — show only this folder's types (again to go back)"
            onClick={() => soloTypes(all.map(t => t.id))}
            disabled={all.length === 0}
          ><Target width={13} height={13} /></button>
          {canEdit && (
            <button
              className={`ghost-btn row-act ${openFolderId === f.id ? 'on' : ''}`}
              title="Folder settings"
              onClick={() => { setOpenFolderId(id => (id === f.id ? null : f.id)); setFolderIconPick(false) }}
            ><Settings2 width={13} height={13} /></button>
          )}
        </div>
        {canEdit && openFolderId === f.id && (
          <div className="layer-config">
            <div className="palette">
              {PALETTE.map(c => (
                <button
                  key={c}
                  className={`swatch ${f.color === c ? 'on' : ''}`}
                  style={{ background: c }}
                  onClick={() => editFolder(x => { x.color = c })}
                />
              ))}
              <input
                type="color" value={f.color} title="Custom color"
                onChange={e => editFolder(x => { x.color = e.target.value })}
              />
            </div>
            <button className="ghost-btn add" onClick={() => setFolderIconPick(v => !v)}>
              {folderIconPick ? 'close icon picker' : 'change icon…'}
            </button>
            {folderIconPick && (
              <IconPicker value={f.icon} onPick={n => { editFolder(x => { x.icon = n }); setFolderIconPick(false) }} />
            )}
            <button className="ghost-btn add" onClick={() => newFolder(f.id, f.color)}>
              <FolderPlus width={12} height={12} /> new sub-folder
            </button>
            <label className="slider-row">
              <span>Inside</span>
              <select
                className="input"
                value={f.parentId ?? ''}
                onChange={e => editFolder(x => { x.parentId = e.target.value || null })}
              >
                <option value="">(top level)</option>
                {moveTargets.map(({ folder, depth: d }) => (
                  <option key={folder.id} value={folder.id}>{'  '.repeat(d)}{folder.name}</option>
                ))}
              </select>
            </label>
            <button
              className="ghost-btn add"
              onClick={() => {
                mutate(p => dissolveFolder(p, f.id))
                setOpenFolderId(null)
              }}
            ><Trash2 width={12} height={12} /> delete folder (contents move out)</button>
          </div>
        )}
        {!collapsed && (
          <div className="folder-types" data-type-folder={f.id}>
            {subs.map(folderNode)}
            {direct.map(typeRow)}
            {subs.length === 0 && direct.length === 0 && (
              <div className="sb-hint">{canEdit ? 'drag types or folders here' : 'empty folder'}</div>
            )}
          </div>
        )}
      </React.Fragment>
    )
  }

  return (
    <aside
      className={`sidebar ${ui.dragTypeId || ui.dragFolderId ? 'dragging' : ''} ${canEdit ? '' : 'readonly'}`}
      style={{ width: ui.sidebarW, minWidth: ui.sidebarW }}
    >
      {/* -------- proposals (suggested changes awaiting review; edit shares only) */}
      {canEdit && share && (share.role === 'edit' ? !!share.editToken : share.role === 'suggest') && (
        <>
          <SectionHeader
            title={share.role === 'suggest' ? 'Suggestions' : 'Proposals'} open={open.proposals || reviewing} toggle={() => toggle('proposals')}
            action={openProposals > 0 && <span className="badge accent">{openProposals}</span>}
          />
          {(open.proposals || reviewing) && <ProposalsPanel />}
        </>
      )}

      {/* -------- types */}
      <SectionHeader
        title="Types" open={open.types} toggle={() => toggle('types')}
        action={canEdit && (
          <>
            <button className="ghost-btn" title="Add folder" onClick={() => newFolder(null)}>
              <FolderPlus width={14} height={14} />
            </button>
            <button className="ghost-btn" title="Add type" onClick={() => newType(null)}>
              <Plus width={14} height={14} />
            </button>
          </>
        )}
      />
      {open.types && (
        <div className="sb-body" data-type-folder="">
          {canEdit && proj.types.length > 0 && (
            <TypeSearch
              proj={proj}
              placeholder="Add item… (search types)"
              onPick={typeId => { nav.current?.addItem(typeId) }}
              onCreateType={name => { nav.current?.addItem(newType(null, undefined, name)) }}
            />
          )}
          {childFolders(proj, null).map(folderNode)}
          {typesInFolder(proj, null).map(typeRow)}
          {proj.types.length === 0 && <div className="sb-hint">no types yet</div>}
          {canEdit && (
            <div className="sb-hint">drag a type onto the line to place it · drop types and folders onto a folder to file them</div>
          )}
        </div>
      )}

      {/* -------- layers */}
      <SectionHeader
        title="Layers" open={open.layers} toggle={() => toggle('layers')}
        action={canEdit && (
          <button className="ghost-btn" title="Add layer"
            onClick={() => mutate(p => p.layers.push({ id: uid(), name: 'New layer', eye: false, pin: false, size: 1, minZoom: 0 }))}
          ><Plus width={14} height={14} /></button>
        )}
      />
      {open.layers && !canEdit && (
        <div className="sb-body">
          {proj.layers.map((l, i) => {
            const off = l.eye || proj.filters.offLayers.includes(l.id)
            return (
              <div key={l.id} className={`layer-row ${off ? 'off' : ''}`}>
                <span className="sig-dot" style={{ opacity: 1 - i * 0.85 / Math.max(proj.layers.length - 1, 1) }} />
                <span className="type-name">{l.name}</span>
                {l.pin && <Pin width={11} height={11} className="muted" />}
                <span className="count">{layerCounts.get(l.id) ?? 0}</span>
                <button
                  className={`ghost-btn ${off ? 'on' : ''}`}
                  title={l.eye ? 'Hidden by the author' : off ? 'Show layer' : 'Hide layer (only for you)'}
                  disabled={l.eye}
                  onClick={() => toggleLayerFilter(l.id)}
                >{off ? <EyeOff width={13} height={13} /> : <Eye width={13} height={13} />}</button>
              </div>
            )
          })}
          <div className="sb-hint">top = most significant · survives zoom-out longest</div>
        </div>
      )}
      {open.layers && canEdit && (
        <div className="sb-body">
          {proj.layers.map((l, i) => (
            <React.Fragment key={l.id}>
              <div className={`layer-row ${l.eye ? 'off' : ''}`}>
                <span className="sig-dot" style={{ opacity: 1 - i * 0.85 / Math.max(proj.layers.length - 1, 1) }} />
                <input
                  className="bare-input"
                  value={l.name}
                  onChange={e => mutate(p => { const x = p.layers.find(y => y.id === l.id); if (x) x.name = e.target.value })}
                />
                <span className="count">{layerCounts.get(l.id) ?? 0}</span>
                <button
                  className={`ghost-btn ${l.eye ? 'on' : ''}`} title="Hide always"
                  onClick={() => mutate(p => { const x = p.layers.find(y => y.id === l.id); if (x) { x.eye = !x.eye; if (x.eye) x.pin = false } })}
                >{l.eye ? <EyeOff width={13} height={13} /> : <Eye width={13} height={13} />}</button>
                <button
                  className={`ghost-btn ${l.pin ? 'on' : ''}`} title="Show always (ignore density)"
                  onClick={() => mutate(p => { const x = p.layers.find(y => y.id === l.id); if (x) { x.pin = !x.pin; if (x.pin) x.eye = false } })}
                ><Pin width={13} height={13} /></button>
                <button
                  className="ghost-btn" title="More significant" disabled={i === 0}
                  onClick={() => mutate(p => { const j = p.layers.findIndex(y => y.id === l.id); if (j > 0) [p.layers[j - 1], p.layers[j]] = [p.layers[j], p.layers[j - 1]] })}
                ><ChevronUp width={13} height={13} /></button>
                <button
                  className={`ghost-btn ${openLayerId === l.id ? 'on' : ''}`} title="Layer display settings"
                  onClick={() => setOpenLayerId(id => (id === l.id ? null : l.id))}
                ><Settings2 width={13} height={13} /></button>
                <button
                  className="ghost-btn" title="Delete layer" disabled={proj.layers.length <= 1}
                  onClick={() => mutate(p => {
                    p.layers = p.layers.filter(y => y.id !== l.id)
                    const fallback = p.layers[0]?.id ?? null
                    for (const t of p.types) if (t.defaultLayerId === l.id) t.defaultLayerId = fallback
                    for (const it of p.items) if (it.layerId === l.id) it.layerId = null
                  })}
                ><Trash2 width={13} height={13} /></button>
              </div>
              {openLayerId === l.id && (
                <div className="layer-config">
                  <label className="slider-row">
                    <span>Item size</span>
                    <input
                      type="range" min={0.5} max={1.8} step={0.05} value={l.size}
                      onChange={e => tweak(p => { const x = p.layers.find(y => y.id === l.id); if (x) x.size = Number(e.target.value) })}
                    />
                    <em>{l.size.toFixed(2)}×</em>
                  </label>
                  <label className="slider-row">
                    <span>Min zoom</span>
                    <input
                      type="range" min={0} max={100} step={1} value={sliderFromMinZoom(l.minZoom)}
                      onChange={e => tweak(p => {
                        const x = p.layers.find(y => y.id === l.id)
                        if (x) x.minZoom = minZoomFromSlider(Number(e.target.value))
                      })}
                    />
                    <em>{l.minZoom === 0 ? 'never' : fmtZoom(l.minZoom)}</em>
                  </label>
                  <div className="sb-hint">
                    zoomed out below min zoom, items become dots on the line
                    · current zoom: {fmtZoom(proj.camera.s)}
                  </div>
                  <button
                    className="ghost-btn add"
                    onClick={() => tweak(p => {
                      const x = p.layers.find(y => y.id === l.id)
                      if (x) x.minZoom = Math.max(MZ_LO, proj.camera.s)
                    })}
                  >set to current zoom</button>
                </div>
              )}
            </React.Fragment>
          ))}
          <div className="sb-hint">top = most significant · survives zoom-out longest</div>
        </div>
      )}

      {/* -------- structure */}
      <SectionHeader title="Structure" open={open.structure} toggle={() => toggle('structure')} />
      {open.structure && (
        <div className="sb-body">
          <div className="sb-sub">Hierarchy levels</div>
          {proj.hierarchyLevels.map((level, d) => (
            <div key={level.id} className="row gap level-row">
              {canEdit ? (
                <input
                  className="bare-input grow"
                  value={level.name}
                  onChange={e => mutate(p => { const l = p.hierarchyLevels.find(x => x.id === level.id); if (l) l.name = e.target.value })}
                />
              ) : (
                <span className="level-name grow" style={{ paddingLeft: d * 10 }}>{level.name}</span>
              )}
              {(level.fields.length > 0 || level.processors.length > 0) && (
                <span className="count" title={`${level.fields.length} field(s) · ${level.processors.length} processor(s)`}>
                  {level.fields.length}f · {level.processors.length}p
                </span>
              )}
              {canEdit && (
                <button
                  className="ghost-btn" title={`Add ${level.name} at current view`}
                  onClick={() => {
                    const st = useStore.getState()
                    const p0 = st.projects.find(p => p.id === st.activeId)!
                    const w = window.innerWidth * 0.5
                    const center = p0.camera.x + w / p0.camera.s
                    const span = (w * 0.6) / p0.camera.s
                    mutate(p => p.sections.push({
                      id: uid(), name: `New ${level.name.toLowerCase()}`, depth: d,
                      start: center - span / 2, end: center + span / 2, fieldValues: {},
                    }))
                  }}
                ><Plus width={13} height={13} /></button>
              )}
              {canEdit && (
                <button className="ghost-btn" title="Level fields & processors" onClick={() => setUI({ editLevelId: level.id })}>
                  <Settings2 width={13} height={13} />
                </button>
              )}
              {canEdit && d === proj.hierarchyLevels.length - 1 && d > 0 && (
                <button
                  className="ghost-btn" title="Remove level" disabled={proj.sections.some(s => s.depth === d)}
                  onClick={() => mutate(p => { p.hierarchyLevels.pop() })}
                ><Trash2 width={13} height={13} /></button>
              )}
            </div>
          ))}
          {canEdit && proj.hierarchyLevels.length < 5 && (
            <button className="ghost-btn add" onClick={() => mutate(p => p.hierarchyLevels.push(newLevel('Sub-level')))}>
              + Add hierarchy level
            </button>
          )}
          <div className="sb-sub">Sections</div>
          {sectionTree.map(({ sc, level }) => (
            <div key={sc.id} className="section-row" style={{ paddingLeft: 8 + level * 14 }}>
              <button
                className={`link-btn ${ui.selection.includes(`S:${sc.id}`) ? 'sel' : ''}`}
                title={canEdit ? 'Jump to section' : 'Jump to section and open its details'}
                onClick={() => {
                  nav.current?.flyToSection(sc.id)
                  // In view mode the inspector is the only way to read a
                  // section's notes, so jumping also opens it there.
                  if (!canEdit) select([`S:${sc.id}`])
                }}
              >{sc.name}</button>
            </div>
          ))}
          {proj.sections.length === 0 && (
            <div className="sb-hint">{canEdit ? 'no sections yet — use + next to a level name' : 'no sections'}</div>
          )}
        </div>
      )}

      {/* -------- fields & processors */}
      <SectionHeader
        title="Fields & processors" open={open.schema} toggle={() => toggle('schema')}
        action={canEdit && (
          <>
            <button className="ghost-btn" title="New field" onClick={() => {
              const id = uid()
              mutate(p => p.fields.push(newFieldDef(id, 'New field')))
              setUI({ editFieldId: id })
            }}><Plus width={14} height={14} /></button>
          </>
        )}
      />
      {open.schema && (
        <div className="sb-body">
          <div className="sb-sub">Fields</div>
          {proj.fields.map(f => {
            const u = fieldUsage(proj, f.id)
            const attached = attachedToNames(proj, f.id)
            const values = u.items.length + u.sections.length
            return (
              <div key={f.id} className="schema-row" title={`${kindLabel(f.kind)} · on ${attached.join(', ') || 'nothing'} · ${values} value(s)`}
                onClick={() => { if (canEdit) setUI({ editFieldId: f.id }) }}>
                <span className="kind-glyph">{kindGlyph(f.kind)}</span>
                <span className="type-name">{f.name}</span>
                <span className="schema-sub">{attached.length ? attached.join(', ') : 'unused'}</span>
                <span className="count">{values}</span>
                {canEdit && <Settings2 width={12} height={12} className="row-gear" />}
              </div>
            )
          })}
          {proj.fields.length === 0 && <div className="sb-hint">{canEdit ? 'no fields yet — add one here or from a type editor' : 'no fields'}</div>}
          <div className="sb-sub row">
            <span className="grow">Processors</span>
            {canEdit && (
              <button className="ghost-btn" title="New processor" onClick={() => {
                const id = uid()
                mutate(p => p.processors.push({ id, name: 'New processor', op: 'count', fieldId: null, targets: [] }))
                setUI({ editProcessorId: id })
              }}><Plus width={13} height={13} /></button>
            )}
          </div>
          {proj.processors.map(pr => {
            const levels = processorUsage(proj, pr.id)
            return (
              <div key={pr.id} className="schema-row" title={`${describeProcessor(proj.fields, pr)} · on ${levels.map(l => l.name).join(', ') || 'no level'}`}
                onClick={() => { if (canEdit) setUI({ editProcessorId: pr.id }) }}>
                <span className="kind-glyph">Σ</span>
                <span className="type-name">{pr.name}</span>
                <span className="schema-sub">{describeProcessor(proj.fields, pr)}{levels.length ? ` · ${levels.map(l => l.name).join(', ')}` : ''}</span>
                {canEdit && <Settings2 width={12} height={12} className="row-gear" />}
              </div>
            )
          })}
          {proj.processors.length === 0 && <div className="sb-hint">{canEdit ? 'processors sum or count what sits inside a section — attach them to a hierarchy level' : 'no processors'}</div>}
        </div>
      )}

      {/* -------- tags */}
      <SectionHeader title="Tags" open={open.tags} toggle={() => toggle('tags')} />
      {open.tags && (
        <div className="sb-body tag-cloud">
          {allTags.map(t => (
            <button
              key={t}
              className={`chip ${proj.filters.tags.includes(t) ? 'on' : ''}`}
              onClick={() => tweak(p => {
                p.filters.tags = p.filters.tags.includes(t)
                  ? p.filters.tags.filter(x => x !== t)
                  : [...p.filters.tags, t]
                p.activeViewId = null
              })}
            >{t}</button>
          ))}
          {allTags.length === 0 && (
            <div className="sb-hint">{canEdit ? 'tag items in the inspector to filter by tag' : 'no tags'}</div>
          )}
        </div>
      )}
    </aside>
  )
}
