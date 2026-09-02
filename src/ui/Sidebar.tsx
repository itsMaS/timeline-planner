import React, { useMemo, useRef, useState } from 'react'
import {
  ChevronDown, ChevronRight, ChevronUp, Eye, EyeOff, FolderPlus, Pin, Plus, Settings2, Target, Trash2,
} from 'lucide-react'
import { iconByName } from '../model/icons'
import { itemMatchesFilters, typeOf } from '../model/layout'
import { useActiveProject, useStore } from '../model/store'
import type { ItemType } from '../model/types'
import { PALETTE, uid } from '../model/util'
import { IconPicker } from './IconPicker'
import { chipDrop, nav } from './nav'

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
  const [open, setOpen] = useState({ types: true, layers: true, structure: false, tags: false })
  const toggle = (k: keyof typeof open) => setOpen(o => ({ ...o, [k]: !o[k] }))
  const [openLayerId, setOpenLayerId] = useState<string | null>(null)
  const [openFolderId, setOpenFolderId] = useState<string | null>(null)
  const [folderIconPick, setFolderIconPick] = useState(false)

  // ---- type visibility helpers (shared by rows, folders, and solo buttons)
  const setTypesOff = (ids: string[], off: boolean) => tweak(p => {
    const set = new Set(p.filters.offTypes)
    for (const id of ids) { if (off) set.add(id); else set.delete(id) }
    p.filters.offTypes = [...set]
    p.activeViewId = null
  })
  /** Show only the given types; if they are already the only ones on, show all. */
  const soloTypes = (ids: string[]) => {
    const others = proj.types.filter(t => !ids.includes(t.id)).map(t => t.id)
    const isSolo = proj.filters.offTypes.length === others.length && others.every(id => proj.filters.offTypes.includes(id))
    tweak(p => { p.filters.offTypes = isSolo ? [] : others; p.activeViewId = null })
  }

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

  // ---- chip drag-to-create
  const dragStart = useRef<{ x: number; y: number; typeId: string; started: boolean } | null>(null)
  const chipPointerDown = (e: React.PointerEvent, typeId: string) => {
    if (e.button !== 0) return
    dragStart.current = { x: e.clientX, y: e.clientY, typeId, started: false }
    const onMove = (ev: PointerEvent) => {
      const d = dragStart.current
      if (!d) return
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
        const el = document.elementFromPoint(ev.clientX, ev.clientY)
        if (el?.closest('.sidebar')) {
          const drop = el.closest('[data-type-folder]')
          const fid = drop?.getAttribute('data-type-folder') || null
          const cur = proj.types.find(t => t.id === d.typeId)?.folderId ?? null
          if (drop && fid !== cur) {
            mutate(p => { const t = p.types.find(x => x.id === d.typeId); if (t) t.folderId = fid })
          }
        } else {
          chipDrop.current?.(ev.clientX, ev.clientY, d.typeId)
        }
      } else if (d) {
        // Plain click: toggle filter. Alt-click: solo.
        if (ev.altKey) {
          const others = proj.types.filter(t => t.id !== d.typeId).map(t => t.id)
          const isSolo = proj.filters.offTypes.length === others.length && others.every(id => proj.filters.offTypes.includes(id))
          tweak(p => { p.filters.offTypes = isSolo ? [] : others; p.activeViewId = null })
        } else {
          tweak(p => {
            p.filters.offTypes = p.filters.offTypes.includes(d.typeId)
              ? p.filters.offTypes.filter(id => id !== d.typeId)
              : [...p.filters.offTypes, d.typeId]
            p.activeViewId = null
          })
        }
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
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
        title="Click to filter · Alt-click to solo · Drag onto the timeline to create, onto a folder to file"
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
          title="Solo — show only this type (again to show all)"
          onPointerDown={e => e.stopPropagation()}
          onClick={() => soloTypes([t.id])}
        ><Target width={13} height={13} /></button>
        <button
          className="ghost-btn row-act"
          title="Edit type"
          onPointerDown={e => e.stopPropagation()}
          onClick={() => setUI({ editTypeId: t.id })}
        ><Settings2 width={13} height={13} /></button>
      </div>
    )
  }

  return (
    <aside className={`sidebar ${ui.dragTypeId ? 'dragging' : ''}`}>
      {/* -------- types */}
      <SectionHeader
        title="Types" open={open.types} toggle={() => toggle('types')}
        action={
          <>
            <button
              className="ghost-btn"
              title="Add folder"
              onClick={() => mutate(p => p.typeFolders.push({
                id: uid(), name: 'New folder', color: '#8b5cf6', icon: 'Folder', collapsed: false,
              }))}
            ><FolderPlus width={14} height={14} /></button>
            <button
              className="ghost-btn"
              title="Add type"
              onClick={() => {
                const id = uid()
                mutate(p => p.types.push({
                  id, name: 'New type', icon: 'Circle', color: '#8b5cf6',
                  defaultLayerId: p.layers[Math.min(1, p.layers.length - 1)]?.id ?? null, fields: [],
                }))
                setUI({ editTypeId: id })
              }}
            ><Plus width={14} height={14} /></button>
          </>
        }
      />
      {open.types && (
        <div className="sb-body" data-type-folder="">
          {proj.typeFolders.map(f => {
            const inside = proj.types.filter(t => t.folderId === f.id)
            const FIcon = iconByName(f.icon)
            const Chev = f.collapsed ? ChevronRight : ChevronDown
            const allOff = inside.length > 0 && inside.every(t => proj.filters.offTypes.includes(t.id))
            const editFolder = (recipe: (x: typeof f) => void) =>
              mutate(p => { const x = p.typeFolders.find(y => y.id === f.id); if (x) recipe(x) })
            return (
              <React.Fragment key={f.id}>
                <div className={`folder-row ${allOff ? 'off' : ''}`} data-type-folder={f.id}>
                  <button
                    className="ghost-btn"
                    title={f.collapsed ? 'Expand' : 'Collapse'}
                    onClick={() => tweak(p => { const x = p.typeFolders.find(y => y.id === f.id); if (x) x.collapsed = !x.collapsed })}
                  ><Chev width={13} height={13} /></button>
                  <span className="type-swatch" style={{ background: `${f.color}26`, color: f.color }}>
                    <FIcon width={14} height={14} />
                  </span>
                  <input
                    className="bare-input"
                    value={f.name}
                    onChange={e => editFolder(x => { x.name = e.target.value })}
                  />
                  <span className="count">{inside.length}</span>
                  <button
                    className="ghost-btn row-act"
                    title="New type in this folder"
                    onClick={() => {
                      const id = uid()
                      mutate(p => p.types.push({
                        id, name: 'New type', icon: 'Circle', color: f.color, folderId: f.id,
                        defaultLayerId: p.layers[Math.min(1, p.layers.length - 1)]?.id ?? null, fields: [],
                      }))
                      tweak(p => { const x = p.typeFolders.find(y => y.id === f.id); if (x) x.collapsed = false })
                      setUI({ editTypeId: id })
                    }}
                  ><Plus width={13} height={13} /></button>
                  <button
                    className={`ghost-btn row-act ${allOff ? 'on' : ''}`}
                    title={allOff ? 'Unhide folder' : 'Hide folder'}
                    onClick={() => setTypesOff(inside.map(t => t.id), !allOff)}
                    disabled={inside.length === 0}
                  >{allOff ? <EyeOff width={13} height={13} /> : <Eye width={13} height={13} />}</button>
                  <button
                    className="ghost-btn row-act"
                    title="Solo — show only this folder's types (again to show all)"
                    onClick={() => soloTypes(inside.map(t => t.id))}
                    disabled={inside.length === 0}
                  ><Target width={13} height={13} /></button>
                  <button
                    className={`ghost-btn row-act ${openFolderId === f.id ? 'on' : ''}`}
                    title="Folder settings"
                    onClick={() => { setOpenFolderId(id => (id === f.id ? null : f.id)); setFolderIconPick(false) }}
                  ><Settings2 width={13} height={13} /></button>
                </div>
                {openFolderId === f.id && (
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
                    <button
                      className="ghost-btn add"
                      onClick={() => {
                        mutate(p => {
                          p.typeFolders = p.typeFolders.filter(y => y.id !== f.id)
                          for (const t of p.types) if (t.folderId === f.id) t.folderId = null
                        })
                        setOpenFolderId(null)
                      }}
                    ><Trash2 width={12} height={12} /> delete folder (types move out)</button>
                  </div>
                )}
                {!f.collapsed && (
                  <div className="folder-types" data-type-folder={f.id}>
                    {inside.map(typeRow)}
                    {inside.length === 0 && <div className="sb-hint">drag types here</div>}
                  </div>
                )}
              </React.Fragment>
            )
          })}
          {proj.types.filter(t => !t.folderId).map(typeRow)}
          <div className="sb-hint">drag a type onto the line to place it · drop it on a folder to file it</div>
        </div>
      )}

      {/* -------- layers */}
      <SectionHeader
        title="Layers" open={open.layers} toggle={() => toggle('layers')}
        action={
          <button className="ghost-btn" title="Add layer"
            onClick={() => mutate(p => p.layers.push({ id: uid(), name: 'New layer', eye: false, pin: false, size: 1, minZoom: 0 }))}
          ><Plus width={14} height={14} /></button>
        }
      />
      {open.layers && (
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
          {proj.hierarchyLevels.map((name, d) => (
            <div key={d} className="row gap">
              <input
                className="bare-input grow"
                value={name}
                onChange={e => mutate(p => { p.hierarchyLevels[d] = e.target.value })}
              />
              <button
                className="ghost-btn" title={`Add ${name} at current view`}
                onClick={() => {
                  const st = useStore.getState()
                  const p0 = st.projects.find(p => p.id === st.activeId)!
                  const w = window.innerWidth * 0.5
                  const center = p0.camera.x + w / p0.camera.s
                  const span = (w * 0.6) / p0.camera.s
                  mutate(p => p.sections.push({
                    id: uid(), name: `New ${name.toLowerCase()}`, depth: d,
                    start: center - span / 2, end: center + span / 2,
                  }))
                }}
              ><Plus width={13} height={13} /></button>
              {d === proj.hierarchyLevels.length - 1 && d > 0 && (
                <button
                  className="ghost-btn" title="Remove level" disabled={proj.sections.some(s => s.depth === d)}
                  onClick={() => mutate(p => { p.hierarchyLevels.pop() })}
                ><Trash2 width={13} height={13} /></button>
              )}
            </div>
          ))}
          {proj.hierarchyLevels.length < 5 && (
            <button className="ghost-btn add" onClick={() => mutate(p => p.hierarchyLevels.push('Sub-level'))}>
              + Add hierarchy level
            </button>
          )}
          <div className="sb-sub">Sections</div>
          {sectionTree.map(({ sc, level }) => (
            <div key={sc.id} className="section-row" style={{ paddingLeft: 8 + level * 14 }}>
              <button className="link-btn" onClick={() => nav.current?.flyToSection(sc.id)}>{sc.name}</button>
            </div>
          ))}
          {proj.sections.length === 0 && <div className="sb-hint">no sections yet — use + next to a level name</div>}
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
          {allTags.length === 0 && <div className="sb-hint">tag items in the inspector to filter by tag</div>}
        </div>
      )}
    </aside>
  )
}
