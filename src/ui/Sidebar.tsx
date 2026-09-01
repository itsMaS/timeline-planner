import React, { useMemo, useRef, useState } from 'react'
import {
  ChevronDown, ChevronRight, ChevronUp, Eye, EyeOff, Pin, Plus, Settings2, Trash2,
} from 'lucide-react'
import { iconByName } from '../model/icons'
import { itemMatchesFilters, typeOf } from '../model/layout'
import { useActiveProject, useStore } from '../model/store'
import { uid } from '../model/util'
import { chipDrop, nav } from './nav'

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
        chipDrop.current?.(ev.clientX, ev.clientY, d.typeId)
        setUI({ dragTypeId: null })
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

  return (
    <aside className="sidebar">
      {/* -------- types */}
      <SectionHeader
        title="Types" open={open.types} toggle={() => toggle('types')}
        action={
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
        }
      />
      {open.types && (
        <div className="sb-body">
          {proj.types.map(t => {
            const Icon = iconByName(t.icon)
            const off = proj.filters.offTypes.includes(t.id)
            return (
              <div
                key={t.id}
                className={`type-row ${off ? 'off' : ''}`}
                onPointerDown={e => chipPointerDown(e, t.id)}
                title="Click to filter · Alt-click to solo · Drag onto the timeline to create"
              >
                <span className="type-swatch" style={{ background: `${t.color}26`, color: t.color }}>
                  <Icon width={14} height={14} />
                </span>
                <span className="type-name">{t.name}</span>
                <span className="count">{counts.get(t.id) ?? 0}</span>
                <button
                  className="ghost-btn row-gear"
                  onPointerDown={e => e.stopPropagation()}
                  onClick={() => setUI({ editTypeId: t.id })}
                ><Settings2 width={13} height={13} /></button>
              </div>
            )
          })}
          <div className="sb-hint">drag a type onto the line to place it</div>
        </div>
      )}

      {/* -------- layers */}
      <SectionHeader
        title="Layers" open={open.layers} toggle={() => toggle('layers')}
        action={
          <button className="ghost-btn" title="Add layer"
            onClick={() => mutate(p => p.layers.push({ id: uid(), name: 'New layer', eye: false, pin: false }))}
          ><Plus width={14} height={14} /></button>
        }
      />
      {open.layers && (
        <div className="sb-body">
          {proj.layers.map((l, i) => (
            <div key={l.id} className={`layer-row ${l.eye ? 'off' : ''}`}>
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
                className="ghost-btn" title="Delete layer" disabled={proj.layers.length <= 1}
                onClick={() => mutate(p => {
                  p.layers = p.layers.filter(y => y.id !== l.id)
                  const fallback = p.layers[0]?.id ?? null
                  for (const t of p.types) if (t.defaultLayerId === l.id) t.defaultLayerId = fallback
                  for (const it of p.items) if (it.layerId === l.id) it.layerId = null
                })}
              ><Trash2 width={13} height={13} /></button>
            </div>
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
          {[...proj.sections].sort((a, b) => a.depth - b.depth || a.start - b.start).map(sc => (
            <div key={sc.id} className="section-row" style={{ paddingLeft: 8 + sc.depth * 14 }}>
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
