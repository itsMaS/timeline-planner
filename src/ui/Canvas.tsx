import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ListChecks, Shuffle } from 'lucide-react'
import { iconByName } from '../model/icons'
import {
  BranchLayout, PlacedItem, ROW0_Y, ROW_H, contentExtent, fitCamera, itemMatchesFilters,
  layoutTimeline, typeOf,
} from '../model/layout'
import { useActiveProject, useStore } from '../model/store'
import type { Camera, Item, Section } from '../model/types'
import { clamp, sectionHue, snapPos, uid } from '../model/util'
import { bindParticleCanvas, burst, puff, ripple, setParticleLevel } from '../fx/particles'
import { setSoundOn, sfx } from '../fx/sound'
import { flyCamera, cancelFlight } from '../fx/springs'
import { Markdown } from './Markdown'
import { chipDrop, nav } from './nav'

const MIN_S = 0.4
const MAX_S = 700

type Drag =
  | { kind: 'pan'; startClientX: number; startClientY: number; camX: number; moved: boolean }
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'branch'; startPos: number; curPos: number }
  | { kind: 'item'; ids: string[]; startClientX: number; orig: Map<string, number>; moved: boolean; color: string }
  | { kind: 'handle'; id: string; side: 'L' | 'R'; origPos: number; origDur: number; startClientX: number }
  | { kind: 'branchEnd'; id: string; side: 'fork' | 'join'; orig: number; startClientX: number }
  | { kind: 'sectionEdge'; id: string; side: 'L' | 'R'; orig: number; startClientX: number }

export function CanvasView() {
  const proj = useActiveProject()
  const ui = useStore(s => s.ui)
  const setUI = useStore(s => s.setUI)
  const select = useStore(s => s.select)
  const mutate = useStore(s => s.mutate)
  const setCamera = useStore(s => s.setCamera)
  const showToast = useStore(s => s.showToast)

  const wrapRef = useRef<HTMLDivElement>(null)
  const fxRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 1200, h: 700 })
  const [drag, setDrag] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const [posOverride, setPosOverride] = useState<Map<string, number> | null>(null)
  const [durOverride, setDurOverride] = useState<{ id: string; pos: number; duration: number } | null>(null)
  const [branchOverride, setBranchOverride] = useState<{ id: string; forkPos: number; joinPos: number } | null>(null)
  const [sectionOverride, setSectionOverride] = useState<{ id: string; start: number; end: number } | null>(null)
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [expandedCluster, setExpandedCluster] = useState<string | null>(null)
  const stickyRef = useRef<Set<string>>(new Set())
  const historyRef = useRef<{ past: Camera[]; future: Camera[] }>({ past: [], future: [] })

  const cam = proj.camera
  const spineY = Math.round(size.h * 0.42)
  const selection = useMemo(() => new Set(ui.selection), [ui.selection])

  useEffect(() => { setParticleLevel(ui.animLevel) }, [ui.animLevel])
  useEffect(() => { setSoundOn(ui.soundOn) }, [ui.soundOn])

  // ---- size / particle canvas
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      setSize({ w: Math.max(200, r.width), h: Math.max(200, r.height) })
      const c = fxRef.current
      if (c) {
        const dpr = window.devicePixelRatio || 1
        c.width = r.width * dpr
        c.height = r.height * dpr
      }
    })
    ro.observe(el)
    bindParticleCanvas(fxRef.current)
    return () => { ro.disconnect(); bindParticleCanvas(null) }
  }, [])

  // ---- effective project (ephemeral drag overrides applied)
  const effective = useMemo(() => {
    if (!posOverride && !durOverride && !branchOverride && !sectionOverride) return proj
    const p = { ...proj }
    if (posOverride || durOverride) {
      p.items = proj.items.map(it => {
        let out = it
        if (posOverride?.has(it.id)) out = { ...out, pos: posOverride.get(it.id)! }
        if (durOverride?.id === it.id) out = { ...out, pos: durOverride.pos, duration: durOverride.duration }
        return out
      })
    }
    if (branchOverride) {
      p.branches = proj.branches.map(b => b.id === branchOverride.id
        ? { ...b, forkPos: branchOverride.forkPos, joinPos: branchOverride.joinPos } : b)
    }
    if (sectionOverride) {
      p.sections = proj.sections.map(s => s.id === sectionOverride.id
        ? { ...s, start: sectionOverride.start, end: sectionOverride.end } : s)
    }
    return p
  }, [proj, posOverride, durOverride, branchOverride, sectionOverride])

  const layout = useMemo(
    () => layoutTimeline(effective, cam, size.w, proj.filters, ui.density, ui.ghostHidden, stickyRef.current, selection),
    [effective, cam, size.w, proj.filters, ui.density, ui.ghostHidden, selection],
  )
  useEffect(() => {
    stickyRef.current = new Set(layout.placed.map(pl => pl.item.id))
  }, [layout])

  // ---- exit animations
  const prevPlaced = useRef<Map<string, PlacedItem>>(new Map())
  const [leaving, setLeaving] = useState<Map<string, { item: Item; row: number }>>(new Map())
  useEffect(() => {
    const cur = new Map(layout.placed.map(pl => [pl.item.id, pl]))
    if (ui.animLevel !== 'off') {
      const gone = new Map<string, { item: Item; row: number }>()
      prevPlaced.current.forEach((pl, id) => {
        if (!cur.has(id) && gone.size < 40) gone.set(id, { item: pl.item, row: pl.row })
      })
      if (gone.size) {
        setLeaving(l => {
          const next = new Map(l)
          gone.forEach((v, k) => next.set(k, v))
          return next
        })
        setTimeout(() => setLeaving(l => {
          const next = new Map(l)
          gone.forEach((_, k) => next.delete(k))
          return next
        }), 230)
      }
    }
    prevPlaced.current = cur
  }, [layout, ui.animLevel])

  // ---- navigation
  const toX = (pos: number) => (pos - cam.x) * cam.s
  const toPos = (x: number) => cam.x + x / cam.s

  const animate = ui.animLevel !== 'off'
  const flyTo = (target: Camera, remember = true) => {
    if (remember) {
      historyRef.current.past.push({ ...cam })
      if (historyRef.current.past.length > 50) historyRef.current.past.shift()
      historyRef.current.future = []
    }
    flyCamera(cam, target, c => setCamera(c), undefined, animate)
  }

  useEffect(() => {
    nav.current = {
      flyTo: c => flyTo(c),
      fitAll: () => flyTo(fitCamera(proj, size.w)),
      zoomBy: f => {
        const s = clamp(cam.s * f, MIN_S, MAX_S)
        const cx = size.w / 2
        flyTo({ x: toPos(cx) - cx / s, s }, false)
      },
      flyToItem: id => {
        const it = proj.items.find(i => i.id === id)
        if (!it) return
        const s = Math.max(cam.s, 30)
        flyTo({ x: it.pos - size.w / 2 / s, s })
        select([id])
      },
      flyToSection: id => {
        const sc = proj.sections.find(s0 => s0.id === id)
        if (!sc) return
        const span = Math.max(sc.end - sc.start, 0.5)
        const s = clamp((size.w * 0.86) / span, MIN_S, MAX_S)
        flyTo({ x: sc.start - (size.w - span * s) / 2 / s, s })
      },
      back: () => {
        const prev = historyRef.current.past.pop()
        if (!prev) return
        historyRef.current.future.push({ ...cam })
        flyCamera(cam, prev, c => setCamera(c), undefined, animate)
      },
      forward: () => {
        const nxt = historyRef.current.future.pop()
        if (!nxt) return
        historyRef.current.past.push({ ...cam })
        flyCamera(cam, nxt, c => setCamera(c), undefined, animate)
      },
    }
    return () => { nav.current = null }
  })

  // ---- wheel zoom / pan
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      cancelFlight()
      const st = useStore.getState()
      const c = (st.projects.find(p => p.id === st.activeId) ?? st.projects[0]).camera
      const rect = el.getBoundingClientRect()
      const mx = e.clientX - rect.left
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        st.setCamera({ x: c.x + e.deltaX / c.s, s: c.s })
      } else {
        const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.006 : 0.0018))
        const s = clamp(c.s * k, MIN_S, MAX_S)
        const wx = c.x + mx / c.s
        st.setCamera({ x: wx - mx / s, s })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // ---- chip drop from the sidebar
  useEffect(() => {
    chipDrop.current = (clientX, clientY, typeId) => {
      const el = wrapRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return
      const x = clientX - rect.left
      const y = clientY - rect.top - spineY
      let pathId: string | null = null
      for (const bl of layout.branches) {
        if (bl.collapsed) continue
        bl.pathYs.forEach((py, i) => {
          if (Math.abs(y - py) < 26 && x > bl.forkX + 20 && x < bl.joinX - 20) pathId = bl.branch.paths[i].id
        })
      }
      const pos = ui.snap ? snapPos(toPos(x), cam.s) : toPos(x)
      createItem(typeId, pos, pathId, clientX - rect.left, clientY - rect.top)
    }
    return () => { chipDrop.current = null }
  })

  const createItem = (typeId: string, pos: number, pathId: string | null, fxX: number, fxY: number) => {
    const type = proj.types.find(t => t.id === typeId) ?? proj.types[0]
    if (!type) return
    const id = uid()
    mutate(p => {
      p.items.push({
        id, typeId: type.id, layerId: null, pathId, pos, duration: 0,
        title: `New ${type.name.toLowerCase()}`, description: '', tags: [], link: '', images: [], fieldValues: {},
      })
    })
    setUI({ lastTypeId: type.id })
    select([id])
    burst(fxX, fxY, type.color)
    sfx.create()
  }

  // ---- pointer interactions
  const setDragBoth = (d: Drag | null) => { dragRef.current = d; setDrag(d) }

  const bgPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const rect = wrapRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    if (ui.tool === 'branch') {
      const pos = ui.snap ? snapPos(toPos(x), cam.s) : toPos(x)
      setDragBoth({ kind: 'branch', startPos: pos, curPos: pos })
    } else if (e.shiftKey) {
      setDragBoth({ kind: 'marquee', x0: x, y0: y, x1: x, y1: y })
    } else {
      cancelFlight()
      setDragBoth({ kind: 'pan', startClientX: e.clientX, startClientY: e.clientY, camX: cam.x, moved: false })
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const rect = wrapRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    if (d.kind === 'pan') {
      const dx = e.clientX - d.startClientX
      if (Math.abs(dx) + Math.abs(e.clientY - d.startClientY) > 3) d.moved = true
      setCamera({ x: d.camX - dx / cam.s, s: cam.s })
    } else if (d.kind === 'marquee') {
      d.x1 = x; d.y1 = y
      setDrag({ ...d })
    } else if (d.kind === 'branch') {
      d.curPos = ui.snap ? snapPos(toPos(x), cam.s) : toPos(x)
      setDrag({ ...d })
    } else if (d.kind === 'item') {
      const du = (e.clientX - d.startClientX) / cam.s
      if (Math.abs(e.clientX - d.startClientX) > 3) d.moved = true
      const next = new Map<string, number>()
      d.orig.forEach((op, id) => {
        let np = op + du
        if (ui.snap && !e.altKey) np = snapPos(np, cam.s)
        next.set(id, np)
      })
      setPosOverride(next)
    } else if (d.kind === 'handle') {
      const du = (e.clientX - d.startClientX) / cam.s
      if (d.side === 'R') {
        let end = d.origPos + d.origDur + du
        if (ui.snap && !e.altKey) end = snapPos(end, cam.s)
        setDurOverride({ id: d.id, pos: d.origPos, duration: Math.max(0, end - d.origPos) })
      } else {
        let start = d.origPos + du
        if (ui.snap && !e.altKey) start = snapPos(start, cam.s)
        const end = d.origPos + d.origDur
        start = Math.min(start, end)
        setDurOverride({ id: d.id, pos: start, duration: end - start })
      }
    } else if (d.kind === 'branchEnd') {
      const du = (e.clientX - d.startClientX) / cam.s
      let np = d.orig + du
      if (ui.snap && !e.altKey) np = snapPos(np, cam.s)
      const br = proj.branches.find(b => b.id === d.id)
      if (!br) return
      if (d.side === 'fork') setBranchOverride({ id: d.id, forkPos: Math.min(np, br.joinPos - 0.5), joinPos: br.joinPos })
      else setBranchOverride({ id: d.id, forkPos: br.forkPos, joinPos: Math.max(np, br.forkPos + 0.5) })
    } else if (d.kind === 'sectionEdge') {
      const du = (e.clientX - d.startClientX) / cam.s
      let np = d.orig + du
      if (ui.snap && !e.altKey) np = snapPos(np, cam.s)
      const sc = proj.sections.find(s0 => s0.id === d.id)
      if (!sc) return
      if (d.side === 'L') setSectionOverride({ id: d.id, start: Math.min(np, sc.end - 0.25), end: sc.end })
      else setSectionOverride({ id: d.id, start: sc.start, end: Math.max(np, sc.start + 0.25) })
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current
    setDragBoth(null)
    if (!d) return
    const rect = wrapRef.current!.getBoundingClientRect()
    if (d.kind === 'pan') {
      if (!d.moved && !e.shiftKey) select([])
    } else if (d.kind === 'marquee') {
      const [ax, bx] = [Math.min(d.x0, d.x1), Math.max(d.x0, d.x1)]
      const [ay, by] = [Math.min(d.y0, d.y1), Math.max(d.y0, d.y1)]
      const hits: string[] = []
      for (const pl of layout.placed) {
        const iy = spineY + ROW0_Y - pl.row * ROW_H
        if (pl.x >= ax && pl.x <= bx && iy >= ay && iy <= by) hits.push(pl.item.id)
      }
      for (const bl of layout.branches) {
        bl.items.forEach(list => list.forEach(pi => {
          const iy = spineY + pi.y
          if (pi.x >= ax && pi.x <= bx && iy >= ay && iy <= by) hits.push(pi.item.id)
        }))
      }
      select(hits)
    } else if (d.kind === 'branch') {
      const a = Math.min(d.startPos, d.curPos)
      const b = Math.max(d.startPos, d.curPos)
      setUI({ tool: 'select' })
      if (b - a >= 1) {
        const id = uid()
        mutate(p => {
          p.branches.push({
            id, mode: 'any', forkPos: a, joinPos: b,
            paths: [
              { id: uid(), label: '', terminal: false },
              { id: uid(), label: '', terminal: false },
            ],
          })
        })
        select([`B:${id}`])
        burst(e.clientX - rect.left, e.clientY - rect.top, '#8b5cf6')
        sfx.create()
      }
    } else if (d.kind === 'item') {
      const ov = posOverride
      setPosOverride(null)
      if (d.moved && ov) {
        mutate(p => {
          for (const it of p.items) if (ov.has(it.id)) it.pos = ov.get(it.id)!
        })
        puff(e.clientX - rect.left, e.clientY - rect.top, d.color)
        sfx.snap()
      }
    } else if (d.kind === 'handle') {
      const ov = durOverride
      setDurOverride(null)
      if (ov) {
        mutate(p => {
          const it = p.items.find(i => i.id === ov.id)
          if (it) { it.pos = ov.pos; it.duration = ov.duration }
        })
        sfx.snap()
      }
    } else if (d.kind === 'branchEnd') {
      const ov = branchOverride
      setBranchOverride(null)
      if (ov) {
        mutate(p => {
          const br = p.branches.find(b => b.id === ov.id)
          if (br) { br.forkPos = ov.forkPos; br.joinPos = ov.joinPos }
        })
        sfx.snap()
      }
    } else if (d.kind === 'sectionEdge') {
      const ov = sectionOverride
      setSectionOverride(null)
      if (ov) {
        mutate(p => {
          const sc = p.sections.find(s0 => s0.id === ov.id)
          if (sc) { sc.start = ov.start; sc.end = ov.end }
        })
        sfx.snap()
      }
    }
  }

  const bgDoubleClick = (e: React.MouseEvent) => {
    if (ui.tool !== 'select') return
    const rect = wrapRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const pos = ui.snap ? snapPos(toPos(x), cam.s) : toPos(x)
    const typeId = ui.lastTypeId ?? proj.types[0]?.id
    if (typeId) createItem(typeId, pos, null, x, e.clientY - rect.top)
  }

  const itemPointerDown = (e: React.PointerEvent, item: Item) => {
    if (e.button !== 0) return
    e.stopPropagation()
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    const rect = wrapRef.current!.getBoundingClientRect()
    let ids: string[]
    if (selection.has(item.id)) {
      ids = ui.selection.filter(s => !s.includes(':'))
    } else if (e.shiftKey) {
      ids = [...ui.selection.filter(s => !s.includes(':')), item.id]
      select(ids)
    } else {
      ids = [item.id]
      select(ids)
      const type = typeOf(proj, item)
      ripple(e.clientX - rect.left, e.clientY - rect.top, type?.color ?? '#888')
      sfx.select()
    }
    if (e.altKey) {
      // Clone the dragged set, then drag the clones.
      const cloneIds: string[] = []
      mutate(p => {
        for (const id of ids) {
          const src = p.items.find(i => i.id === id)
          if (!src) continue
          const cp = structuredClone(src)
          cp.id = uid()
          cloneIds.push(cp.id)
          p.items.push(cp)
        }
      })
      select(cloneIds)
      ids = cloneIds
    }
    const orig = new Map<string, number>()
    for (const id of ids) {
      const it = (e.altKey ? useStore.getState().projects.find(p => p.id === proj.id) : proj)?.items.find(i => i.id === id)
        ?? proj.items.find(i => i.id === id)
      if (it) orig.set(id, it.pos)
      else {
        const st = useStore.getState()
        const cur = st.projects.find(p => p.id === st.activeId)
        const it2 = cur?.items.find(i => i.id === id)
        if (it2) orig.set(id, it2.pos)
      }
    }
    const type = typeOf(proj, item)
    setDragBoth({ kind: 'item', ids, startClientX: e.clientX, orig, moved: false, color: type?.color ?? '#888' })
  }

  const itemHoverStart = (e: React.PointerEvent, id: string) => {
    clearTimeout(hoverTimer.current)
    const rect = wrapRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    hoverTimer.current = setTimeout(() => setHover({ id, x, y }), 250)
  }
  const itemHoverEnd = () => {
    clearTimeout(hoverTimer.current)
    setHover(null)
  }

  // ---- breadcrumb
  const centerPos = toPos(size.w / 2)
  const crumbs = useMemo(() => {
    const within = proj.sections
      .filter(sc => sc.start <= centerPos && sc.end >= centerPos)
      .sort((a, b) => a.depth - b.depth)
    const out: Section[] = []
    for (const sc of within) if (!out.some(o => o.depth === sc.depth)) out.push(sc)
    return out
  }, [proj.sections, centerPos])

  // ---- render helpers
  const hoverItem = hover ? proj.items.find(i => i.id === hover.id) : null
  const hoverType = hoverItem ? typeOf(proj, hoverItem) : null

  const sectionsSorted = useMemo(
    () => [...(effective.sections)].sort((a, b) => a.depth - b.depth),
    [effective.sections],
  )
  const depthIndex = useMemo(() => {
    const byDepth = new Map<number, string[]>()
    for (const sc of [...proj.sections].sort((a, b) => a.start - b.start)) {
      ;(byDepth.get(sc.depth) ?? byDepth.set(sc.depth, []).get(sc.depth)!).push(sc.id)
    }
    const idx = new Map<string, number>()
    byDepth.forEach(list => list.forEach((id, i) => idx.set(id, i)))
    return idx
  }, [proj.sections])

  return (
    <div
      ref={wrapRef}
      className={`canvas-wrap tool-${ui.tool}`}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <svg
        className="scene"
        width={size.w}
        height={size.h}
        onPointerDown={bgPointerDown}
        onDoubleClick={bgDoubleClick}
      >
        <g transform={`translate(0, ${spineY})`}>
          {/* section bands */}
          {sectionsSorted.map(sc => {
            const x1 = toX(sc.start)
            const x2 = toX(sc.end)
            const w = x2 - x1
            if (x2 < -40 || x1 > size.w + 40 || w < 24) return null
            const yTop = -spineY
            const hFull = size.h
            const hue = sectionHue(depthIndex.get(sc.id) ?? 0)
            const sel = selection.has(`S:${sc.id}`)
            const labelX = Math.max(x1, 0) + 10
            const labelY = yTop + 20 + sc.depth * 19
            return (
              <g key={sc.id} className="band-g">
                <rect
                  x={x1} y={yTop} width={w} height={hFull}
                  className="band"
                  style={{ fill: `hsl(${hue} 60% 55% / ${0.024 + sc.depth * 0.013})` }}
                  pointerEvents="none"
                />
                <line x1={x1} y1={yTop} x2={x1} y2={yTop + hFull} className="band-edge"
                  style={{ stroke: `hsl(${hue} 55% 55% / ${sel ? 0.8 : 0.2})` }} pointerEvents="none" />
                <line x1={x2} y1={yTop} x2={x2} y2={yTop + hFull} className="band-edge"
                  style={{ stroke: `hsl(${hue} 55% 55% / ${sel ? 0.8 : 0.2})` }} pointerEvents="none" />
                {w > 60 && (
                  <text
                    x={labelX} y={labelY}
                    className={`band-label ${sel ? 'sel' : ''}`}
                    style={{ fill: `hsl(${hue} 50% var(--band-label-l))` }}
                    onPointerDown={e => { e.stopPropagation(); select([`S:${sc.id}`]) }}
                  >
                    {sc.name}
                  </text>
                )}
                {sel && (
                  <>
                    <line
                      x1={x1} y1={yTop} x2={x1} y2={yTop + hFull} className="band-handle"
                      onPointerDown={e => {
                        e.stopPropagation()
                        ;(e.target as Element).setPointerCapture?.(e.pointerId)
                        setDragBoth({ kind: 'sectionEdge', id: sc.id, side: 'L', orig: sc.start, startClientX: e.clientX })
                      }}
                    />
                    <line
                      x1={x2} y1={yTop} x2={x2} y2={yTop + hFull} className="band-handle"
                      onPointerDown={e => {
                        e.stopPropagation()
                        ;(e.target as Element).setPointerCapture?.(e.pointerId)
                        setDragBoth({ kind: 'sectionEdge', id: sc.id, side: 'R', orig: sc.end, startClientX: e.clientX })
                      }}
                    />
                  </>
                )}
              </g>
            )
          })}

          {/* spine */}
          <line x1={0} y1={0} x2={size.w} y2={0} className="spine" />

          {/* branches */}
          {layout.branches.map(bl => (
            <BranchG
              key={bl.branch.id}
              bl={bl}
              selected={selection.has(`B:${bl.branch.id}`)}
              selectBranch={() => { select([`B:${bl.branch.id}`]); sfx.select() }}
              itemSelection={selection}
              proj={proj}
              itemPointerDown={itemPointerDown}
              itemHoverStart={itemHoverStart}
              itemHoverEnd={itemHoverEnd}
              startEndDrag={(side, e) => {
                e.stopPropagation()
                ;(e.target as Element).setPointerCapture?.(e.pointerId)
                setDragBoth({
                  kind: 'branchEnd', id: bl.branch.id, side,
                  orig: side === 'fork' ? bl.branch.forkPos : bl.branch.joinPos,
                  startClientX: e.clientX,
                })
              }}
              zoomIn={() => {
                const span = bl.branch.joinPos - bl.branch.forkPos
                const s = clamp((size.w * 0.7) / span, MIN_S, MAX_S)
                flyTo({ x: bl.branch.forkPos - (size.w - span * s) / 2 / s, s })
              }}
            />
          ))}

          {/* exiting items */}
          {[...leaving.entries()].map(([id, l]) => {
            const type = typeOf(proj, l.item)
            const x = toX(l.item.pos)
            if (x < -60 || x > size.w + 60) return null
            return (
              <g key={`leave-${id}`} className="node" transform={`translate(${x}, ${ROW0_Y - l.row * ROW_H})`} pointerEvents="none">
                <g className="node-inner out">
                  <circle r={13} style={{ fill: `${type?.color}22`, stroke: type?.color }} />
                </g>
              </g>
            )
          })}

          {/* placed items */}
          {layout.placed.map(pl => (
            <ItemG
              key={pl.item.id}
              pl={pl}
              proj={proj}
              selected={selection.has(pl.item.id)}
              anim={ui.animLevel !== 'off'}
              onPointerDown={e => itemPointerDown(e, pl.item)}
              onHoverStart={e => itemHoverStart(e, pl.item.id)}
              onHoverEnd={itemHoverEnd}
              startHandle={(side, e) => {
                e.stopPropagation()
                ;(e.target as Element).setPointerCapture?.(e.pointerId)
                const cur = effective.items.find(i => i.id === pl.item.id) ?? pl.item
                setDragBoth({ kind: 'handle', id: pl.item.id, side, origPos: cur.pos, origDur: cur.duration, startClientX: e.clientX })
              }}
            />
          ))}

          {/* clusters */}
          {layout.clusters.map(cl => (
            <g
              key={cl.key}
              transform={`translate(${cl.x}, 0)`}
              className="cluster"
              onPointerEnter={() => setExpandedCluster(cl.key)}
              onPointerLeave={() => setExpandedCluster(c => (c === cl.key ? null : c))}
            >
              {cl.count === 1 ? (
                <circle r={4.5} style={{ fill: cl.color }} className="cluster-dot"
                  onPointerDown={e => { e.stopPropagation(); select([cl.ids[0]]) }} />
              ) : (
                <g
                  onPointerDown={e => {
                    e.stopPropagation()
                    const s = clamp(cam.s * 2.4, MIN_S, MAX_S)
                    const wx = toPos(cl.x)
                    flyTo({ x: wx - size.w / 2 / s, s })
                  }}
                >
                  <rect x={-15} y={-10} width={30} height={20} rx={10} className="cluster-pill" style={{ stroke: cl.color }} />
                  <text y={4} textAnchor="middle" className="cluster-count" style={{ fill: cl.color }}>+{cl.count}</text>
                </g>
              )}
              {expandedCluster === cl.key && cl.count > 1 && (
                <g className="cluster-fan">
                  {cl.ids.slice(0, 8).map((id, i) => {
                    const it = proj.items.find(x => x.id === id)
                    if (!it) return null
                    const t = typeOf(proj, it)
                    const Icon = iconByName(t?.icon ?? 'Circle')
                    return (
                      <g key={id} transform={`translate(0, ${-26 - i * 26})`} className="node"
                        onPointerDown={e => { e.stopPropagation(); select([id]) }}>
                        <g className="node-inner pop">
                          <circle r={11} style={{ fill: 'var(--panel)', stroke: t?.color }} />
                          <Icon x={-7} y={-7} width={14} height={14} color={t?.color} strokeWidth={2} />
                          <text x={16} y={4} className="fan-label">{it.title}</text>
                        </g>
                      </g>
                    )
                  })}
                </g>
              )}
            </g>
          ))}

          {/* branch creation preview */}
          {drag?.kind === 'branch' && (
            <g className="branch-preview">
              <line x1={toX(Math.min(drag.startPos, drag.curPos))} y1={0} x2={toX(Math.max(drag.startPos, drag.curPos))} y2={0} />
              <circle cx={toX(drag.startPos)} r={6} />
              <circle cx={toX(drag.curPos)} r={6} />
            </g>
          )}
        </g>

        {/* marquee */}
        {drag?.kind === 'marquee' && (
          <rect
            className="marquee"
            x={Math.min(drag.x0, drag.x1)} y={Math.min(drag.y0, drag.y1)}
            width={Math.abs(drag.x1 - drag.x0)} height={Math.abs(drag.y1 - drag.y0)}
          />
        )}
      </svg>

      <canvas ref={fxRef} className="fx-canvas" />

      {/* breadcrumb */}
      <div className="crumbs">
        {crumbs.length === 0 && <span className="crumb muted">{proj.name}</span>}
        {crumbs.map((sc, i) => (
          <React.Fragment key={sc.id}>
            {i > 0 && <span className="crumb-sep">›</span>}
            <button className="crumb" onClick={() => nav.current?.flyToSection(sc.id)}>{sc.name}</button>
          </React.Fragment>
        ))}
      </div>

      {/* status */}
      <div className="canvas-status">
        showing {layout.shownCount} of {layout.totalCount} items
        {ui.tool === 'branch' && <span className="status-hint"> — drag along the line to create a branch (Esc to cancel)</span>}
      </div>

      {/* tooltip */}
      {hoverItem && hoverType && !drag && (
        <div className="tooltip" style={{ left: Math.min(hover!.x + 14, size.w - 280), top: Math.max(hover!.y - 10, 8) }}>
          <div className="tt-head">
            <span className="tt-dot" style={{ background: hoverType.color }} />
            <strong>{hoverItem.title}</strong>
          </div>
          <div className="tt-type">{hoverType.name}{hoverItem.duration > 0 ? ` · span ${hoverItem.duration.toFixed(1)}` : ''}</div>
          {hoverItem.tags.length > 0 && (
            <div className="tt-tags">{hoverItem.tags.map(t => <span key={t} className="tag">{t}</span>)}</div>
          )}
          {hoverItem.images[0] && <img src={hoverItem.images[0]} alt="" className="tt-img" />}
          {hoverItem.description && <div className="tt-desc"><Markdown text={hoverItem.description.slice(0, 400)} /></div>}
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ ItemG

function ItemG(props: {
  pl: PlacedItem
  proj: ReturnType<typeof useActiveProject>
  selected: boolean
  anim: boolean
  onPointerDown: (e: React.PointerEvent) => void
  onHoverStart: (e: React.PointerEvent) => void
  onHoverEnd: () => void
  startHandle: (side: 'L' | 'R', e: React.PointerEvent) => void
}) {
  const { pl, proj, selected } = props
  const type = typeOf(proj, pl.item)
  const Icon = iconByName(type?.icon ?? 'Circle')
  const y = ROW0_Y - pl.row * ROW_H
  const color = type?.color ?? '#888'
  return (
    <g
      className={`node ${pl.ghost ? 'ghost' : ''} ${selected ? 'sel' : ''}`}
      transform={`translate(${pl.x}, ${y})`}
      onPointerDown={props.onPointerDown}
      onPointerEnter={props.onHoverStart}
      onPointerLeave={props.onHoverEnd}
    >
      <line className="stem" x1={0} y1={14} x2={0} y2={-y} style={{ stroke: color }} />
      <g className={`node-inner ${props.anim ? 'pop' : ''}`}>
        {pl.spanW > 0 && (
          <g>
            <rect x={0} y={17} width={pl.spanW} height={6} rx={3} style={{ fill: `${color}55`, stroke: `${color}88` }} />
            {selected && (
              <>
                <circle cx={0} cy={20} r={6} className="dur-handle" style={{ stroke: color }}
                  onPointerDown={e => props.startHandle('L', e)} />
                <circle cx={pl.spanW} cy={20} r={6} className="dur-handle" style={{ stroke: color }}
                  onPointerDown={e => props.startHandle('R', e)} />
              </>
            )}
          </g>
        )}
        {selected && <circle r={19} className="sel-ring" style={{ stroke: color }} />}
        <circle r={14} className="node-bg" style={{ fill: `${color}26`, stroke: color }} />
        <Icon x={-8} y={-8} width={16} height={16} color={color} strokeWidth={2} />
        {pl.labelShown && (
          <text x={20} y={4} className="node-label" style={{ fill: `color-mix(in srgb, ${color} 30%, var(--text))` }}>
            {pl.item.title}
          </text>
        )}
      </g>
    </g>
  )
}

// ------------------------------------------------------------------ BranchG

function BranchG(props: {
  bl: BranchLayout
  selected: boolean
  selectBranch: () => void
  itemSelection: Set<string>
  proj: ReturnType<typeof useActiveProject>
  itemPointerDown: (e: React.PointerEvent, item: Item) => void
  itemHoverStart: (e: React.PointerEvent, id: string) => void
  itemHoverEnd: () => void
  startEndDrag: (side: 'fork' | 'join', e: React.PointerEvent) => void
  zoomIn: () => void
}) {
  const { bl, selected, proj } = props
  const { branch } = bl
  const GateIcon = branch.mode === 'any' ? Shuffle : ListChecks
  if (bl.collapsed) {
    const cx = (bl.forkX + bl.joinX) / 2
    return (
      <g className="braid" onPointerDown={e => { e.stopPropagation(); props.selectBranch() }} onDoubleClick={props.zoomIn}>
        <path
          d={`M ${bl.forkX} 0 C ${cx} -14, ${cx} -14, ${bl.joinX} 0 C ${cx} 14, ${cx} 14, ${bl.forkX} 0 Z`}
          className={`braid-lens ${selected ? 'sel' : ''}`}
        />
        <rect x={cx - 14} y={8} width={28} height={16} rx={8} className="cluster-pill" />
        <text x={cx} y={20} textAnchor="middle" className="cluster-count">{branch.paths.length}⑂</text>
      </g>
    )
  }
  const dash = branch.mode === 'any' ? '7 5' : undefined
  return (
    <g className={`branch ${selected ? 'sel' : ''}`}>
      {branch.paths.map((path, i) => {
        const yOff = bl.pathYs[i]
        const endX = path.terminal ? bl.joinX - 74 : bl.joinX
        const enter = `M ${bl.forkX} 0 C ${bl.forkX + 30} 0, ${bl.forkX + 26} ${yOff}, ${bl.forkX + 58} ${yOff}`
        const mid = `L ${Math.max(bl.forkX + 58, endX - 58)} ${yOff}`
        const exit = path.terminal ? '' : `C ${endX - 26} ${yOff}, ${endX - 30} 0, ${endX} 0`
        return (
          <g key={path.id}>
            <path
              d={`${enter} ${mid} ${exit}`}
              className="branch-path"
              strokeDasharray={dash}
              onPointerDown={e => { e.stopPropagation(); props.selectBranch() }}
            />
            {path.terminal && (
              <rect x={Math.max(bl.forkX + 58, endX - 58) - 2} y={yOff - 8} width={4} height={16} rx={2} className="terminal-cap" />
            )}
            {branch.mode === 'all' && (
              <rect x={bl.forkX + 52} y={yOff - 22} width={9} height={9} rx={2} className="all-check" />
            )}
            {path.label && (
              <text x={bl.forkX + 68} y={yOff - 10} className="path-label"
                onPointerDown={e => { e.stopPropagation(); props.selectBranch() }}>
                {path.label}
              </text>
            )}
            {bl.items[i].map(pi => {
              const t = typeOf(proj, pi.item)
              const Icon = iconByName(t?.icon ?? 'Circle')
              const sel = props.itemSelection.has(pi.item.id)
              return (
                <g
                  key={pi.item.id}
                  className={`node ${pi.ghost ? 'ghost' : ''} ${sel ? 'sel' : ''}`}
                  transform={`translate(${pi.x}, ${pi.y})`}
                  onPointerDown={e => props.itemPointerDown(e, pi.item)}
                  onPointerEnter={e => props.itemHoverStart(e, pi.item.id)}
                  onPointerLeave={props.itemHoverEnd}
                >
                  <g className="node-inner pop">
                    {sel && <circle r={16} className="sel-ring" style={{ stroke: t?.color }} />}
                    <circle r={11} className="node-bg" style={{ fill: `${t?.color}26`, stroke: t?.color }} />
                    <Icon x={-6.5} y={-6.5} width={13} height={13} color={t?.color} strokeWidth={2} />
                    {pi.labelShown && <text x={16} y={21} className="node-label sm">{pi.item.title}</text>}
                  </g>
                </g>
              )
            })}
          </g>
        )
      })}
      {/* gate + join */}
      <g className="gate" onPointerDown={e => { e.stopPropagation(); props.selectBranch() }}>
        <circle cx={bl.forkX} r={12} className="gate-bg" />
        <GateIcon x={bl.forkX - 7} y={-7} width={14} height={14} className="gate-icon" />
      </g>
      <circle cx={bl.joinX} r={5} className="join-dot"
        onPointerDown={e => { e.stopPropagation(); props.selectBranch() }} />
      {selected && (
        <>
          <circle cx={bl.forkX} r={17} className="end-handle" onPointerDown={e => props.startEndDrag('fork', e)} />
          <circle cx={bl.joinX} r={12} className="end-handle" onPointerDown={e => props.startEndDrag('join', e)} />
        </>
      )}
    </g>
  )
}
