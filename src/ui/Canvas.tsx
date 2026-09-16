import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  ClipboardCopy, ClipboardPaste, CopyPlus, ListChecks, Maximize2, Plus, RectangleHorizontal,
  Scissors, Settings2, Shuffle, Trash2,
} from 'lucide-react'
import { allowsTarget, attachmentsFor, backlinks, effectiveValue, formatValue, ownerOf } from '../model/fields'
import { iconByName } from '../model/icons'
import {
  BranchLayout, PATH_LIFT, PlacedItem, ROW_H, branchPathD, contentExtent, fitCamera, itemMatchesFilters, splitLabel,
  layoutTimeline, minZoomFor, refreshSectionDepths, rowY, spineD, spineYFor, terminalEndX, typeOf,
} from '../model/layout'
import { bandBadge } from '../model/processors'
import { diffToChanges, pendingChanges, previewProject, type ChangeKind, type ProposalChange } from '../model/proposal'
import { useActiveProject, useStore } from '../model/store'
import type { Camera, Item, Section } from '../model/types'
import { hideNewTypeInFilters } from '../model/views'
import { PALETTE, clamp, formatUnit, rulerStepFor, sectionHue, snapPos, timeBaseFor, uid, unitSuffix } from '../model/util'
import { bindParticleCanvas, burst, puff, ripple, setParticleLevel } from '../fx/particles'
import { setSoundOn, sfx } from '../fx/sound'
import { flyCamera, cancelFlight } from '../fx/springs'
import { creatorStamp } from '../sync/client'
import { getClipboard, setClipboard } from './clipboard'
import { requestDelete } from './deletion'
import { Markdown } from './Markdown'
import { chipDrop, nav } from './nav'
import { TypeSearch } from './TypeSearch'

const MIN_S = 0.4
const MAX_S = 700

type Drag =
  | { kind: 'pan'; button: number; startClientX: number; startClientY: number; camX: number; moved: boolean }
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'branch'; startPos: number; curPos: number }
  | {
      kind: 'item'; ids: string[]; grabId: string; startClientX: number
      orig: Map<string, number>
      /** Original positions of every item, for ripple (move-all) drags. */
      allOrig: Map<string, number>
      /** Ripple mode was on (or Shift held) when the drag started. */
      ripple: boolean
      /** Span items whose END (not start) travels with the drag — a base-dot
          drag picks up every span ending at that position, so the dragged
          delta stretches their duration instead of moving them. */
      endOrig: Map<string, { pos: number; dur: number }>
      moved: boolean; color: string; cands: number[]
    }
  | { kind: 'handle'; id: string; side: 'L' | 'R'; origPos: number; origDur: number; startClientX: number; cands: number[] }
  | {
      /** Proportionally scale every selected item (positions and span
          durations) around the group's opposite extreme — the handles on
          the first and last selected item. */
      kind: 'itemScale'; ids: string[]; side: 'L' | 'R'; startClientX: number
      orig: Map<string, { pos: number; dur: number }>
      anchor: number; grabPos: number
      cands: number[]; minFactor: number; moved: boolean; color: string
    }
  | { kind: 'branchEnd'; id: string; side: 'fork' | 'join'; orig: number; startClientX: number; cands: number[] }
  | {
      /** One or more section edges sharing the grabbed position (coincident
          edges of adjacent sections move together in global mode). */
      kind: 'sectionEdge'; edges: { id: string; side: 'L' | 'R' }[]
      orig: number; startClientX: number; cands: number[]
      /** Clamp range keeping every participating section at a minimum width. */
      min: number; max: number
      /** Original bounds of the affected sections (for item/sub-section redistribution). */
      origSects: Map<string, { start: number; end: number }>
      /** Item → its position, duration and innermost affected section at drag start. */
      itemSec: Map<string, { pos: number; dur: number; secId: string }>
      /** Contained sub-sections; they redistribute with the parent unless Shift is held. */
      subSects: Map<string, { start: number; end: number; parentId: string }>
      /** Branch → its bounds and innermost affected section; redistributes like items. */
      branchSec: Map<string, { fork: number; join: number; secId: string }>
    }
  | {
      /** Translate every selected section together (label drag). */
      kind: 'sectionMove'; ids: string[]; grabId: string; startClientX: number
      orig: Map<string, { start: number; end: number }>
      /** Items inside the moved sections; they travel with the sections. */
      itemOrig: Map<string, number>
      /** Branches inside the moved sections; they travel too. */
      branchOrig: Map<string, { fork: number; join: number }>
      cands: number[]; moved: boolean
    }
  | {
      /** Proportionally scale every selected section around the group's
          opposite extreme (edge drag with a multi-section selection). */
      kind: 'sectionScale'; ids: string[]; startClientX: number
      orig: Map<string, { start: number; end: number }>
      /** Contained (unselected) sub-sections; they scale along unless Shift is held. */
      subOrig: Map<string, { start: number; end: number }>
      /** Items inside the scaled sections (spacing rescales unless Shift is held). */
      itemOrig: Map<string, number>
      /** Branches inside the scaled sections; they rescale unless Shift is held. */
      branchOrig: Map<string, { fork: number; join: number }>
      /** Original durations of contained span items; they rescale unless Shift is held. */
      itemDur: Map<string, number>
      anchor: number; grabPos: number
      cands: number[]; minFactor: number; moved: boolean
    }

type CtxTarget = { kind: 'bg'; pos: number; rawPos: number } | { kind: 'item'; id: string }
interface CtxMenu {
  x: number; y: number; target: CtxTarget
  /** Background menu switched to the "new item" type search. */
  search?: boolean
  /** Prompting for the title of a just-created item (in place of the picker). */
  name?: { itemId: string; placeholder: string }
}

export function CanvasView() {
  const proj = useActiveProject()
  const ui = useStore(s => s.ui)
  const setUI = useStore(s => s.setUI)
  const select = useStore(s => s.select)
  const mutate = useStore(s => s.mutate)
  const tweak = useStore(s => s.tweak)
  const setCamera = useStore(s => s.setCamera)
  const showToast = useStore(s => s.showToast)

  const wrapRef = useRef<HTMLDivElement>(null)
  const fxRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 1200, h: 700 })
  const [drag, setDrag] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const [posOverride, setPosOverride] = useState<Map<string, number> | null>(null)
  const [durOverride, setDurOverride] = useState<{ id: string; pos: number; duration: number }[] | null>(null)
  const [branchOverride, setBranchOverride] = useState<{ id: string; forkPos: number; joinPos: number }[] | null>(null)
  const [sectionOverride, setSectionOverride] = useState<{ id: string; start: number; end: number }[] | null>(null)
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [expandedCluster, setExpandedCluster] = useState<string | null>(null)
  const stickyRef = useRef<Set<string>>(new Set())
  const historyRef = useRef<{ past: Camera[]; future: Camera[] }>({ past: [], future: [] })
  const [menu, setMenu] = useState<CtxMenu | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  /** Set after a right-drag pan so the browser's contextmenu event doesn't open the menu. */
  const suppressMenuRef = useRef(false)
  /** Last pointer position over the canvas (null once it leaves) — where Space places the picker. */
  const pointerRef = useRef<{ x: number; y: number } | null>(null)
  /** Text typed so far into the new-item name prompt; committed when the prompt closes. */
  const pendingNameRef = useRef('')

  const cam = proj.camera
  const st = proj.settings
  // Time presets can zoom far enough in to read individual seconds.
  const timeBase = timeBaseFor(st.unit.preset)
  const maxS = timeBase ? Math.max(MAX_S, timeBase * 400) : MAX_S
  // Zoom-out limit follows the content extent so large scopes stay reachable.
  const minS = Math.min(MIN_S, minZoomFor(proj, size.w))
  const spineY = spineYFor(proj, size.h)
  const selection = useMemo(() => new Set(ui.selection), [ui.selection])
  // While a proposal is open in the review panel the canvas shows it applied:
  // added items appear, moved ones sit at their proposed position and removed
  // ones stay, struck through. `view` is what gets laid out and drawn; `proj`
  // stays the document every edit goes to. `review` maps item id → its
  // pending change, so touched items can be styled and kept out of drags.
  const reviewProposal = useStore(s => (s.ui.reviewProposalId ? s.proposals[s.activeId]?.find(p => p.id === s.ui.reviewProposalId) : undefined))
  const view = useMemo(() => (reviewProposal ? previewProject(proj, reviewProposal) : proj), [proj, reviewProposal])
  const review = useMemo(() => (reviewProposal ? pendingChanges(reviewProposal, 'items') : new Map<string, ProposalChange>()), [reviewProposal])
  // In suggest mode, items that differ from the saved document get the same dashed ring.
  const baseProj = useStore(s => s.projects.find(p => p.id === s.activeId) ?? s.projects[0])
  const proposed = useMemo(() => {
    const ids = new Set(review.keys())
    if (proj !== baseProj) for (const c of diffToChanges(baseProj, proj)) if (c.col === 'items') ids.add(c.entityId)
    return ids
  }, [review, proj, baseProj])

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
    if (!posOverride && !durOverride && !branchOverride && !sectionOverride) return view
    const p = { ...view }
    if (posOverride || durOverride) {
      p.items = view.items.map(it => {
        let out = it
        if (posOverride?.has(it.id)) out = { ...out, pos: posOverride.get(it.id)! }
        const dv = durOverride?.find(x => x.id === it.id)
        if (dv) out = { ...out, pos: dv.pos, duration: dv.duration }
        return out
      })
    }
    if (branchOverride) {
      p.branches = proj.branches.map(b => {
        const o = branchOverride.find(x => x.id === b.id)
        return o ? { ...b, forkPos: o.forkPos, joinPos: o.joinPos } : b
      })
    }
    if (sectionOverride) {
      // Clone every section (depths are recomputed in place) so the live
      // hierarchy follows the drag without touching the stored project.
      p.sections = proj.sections.map(s => {
        const o = sectionOverride.find(x => x.id === s.id)
        return o ? { ...s, start: o.start, end: o.end } : { ...s }
      })
      refreshSectionDepths(p)
    }
    return p
  }, [view, posOverride, durOverride, branchOverride, sectionOverride])

  // Depth-graded emphasis: top-level sections get bigger labels and stronger
  // borders; each level down shrinks. Header bars stack flush from the very
  // top of the canvas (no gap that would expose band edges above them).
  const sizeAtDepth = (d0: number) => Math.max(10, st.sectionStyle.labelSize - 2.5 * d0)
  const barTopFor = (depth: number) => {
    let y = 0
    for (let d0 = 0; d0 < depth; d0++) y += sizeAtDepth(d0) + 10
    return y
  }
  // Vertical space taken by the header bar stack — item rows must stay below it.
  const maxSectionDepth = proj.sections.length ? Math.max(...proj.sections.map(s => s.depth)) : -1
  const headerH = maxSectionDepth >= 0 ? barTopFor(maxSectionDepth + 1) : 0
  const maxUpRows = Math.max(1, Math.floor((spineY - headerH - 76) / ROW_H) + 1)

  const layout = useMemo(
    () => layoutTimeline(effective, cam, size.w, proj.filters, ui.density, ui.ghostHidden, stickyRef.current, selection, st.placement, maxUpRows, ui.showFields, ui.showTitles),
    [effective, cam, size.w, proj.filters, ui.density, ui.ghostHidden, selection, st.placement, maxUpRows, ui.showFields, ui.showTitles],
  )
  useEffect(() => {
    stickyRef.current = new Set(layout.placed.map(pl => pl.item.id))
  }, [layout])

  // ---- exit animations
  const prevPlaced = useRef<Map<string, PlacedItem>>(new Map())
  const [leaving, setLeaving] = useState<Map<string, { item: Item; ny: number }>>(new Map())
  useEffect(() => {
    const cur = new Map(layout.placed.map(pl => [pl.item.id, pl]))
    if (ui.animLevel !== 'off') {
      const gone = new Map<string, { item: Item; ny: number }>()
      prevPlaced.current.forEach((pl, id) => {
        if (!cur.has(id) && gone.size < 40) gone.set(id, { item: pl.item, ny: pl.ny })
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
        const s = clamp(cam.s * f, minS, maxS)
        const cx = size.w / 2
        flyTo({ x: toPos(cx) - cx / s, s }, false)
      },
      flyToItem: id => {
        const it = view.items.find(i => i.id === id)
        if (!it) return
        const s = Math.max(cam.s, 30)
        flyTo({ x: it.pos - size.w / 2 / s, s })
        select([id])
      },
      flyToSection: id => {
        const sc = proj.sections.find(s0 => s0.id === id)
        if (!sc) return
        const span = Math.max(sc.end - sc.start, 0.5)
        const s = clamp((size.w * 0.86) / span, minS, maxS)
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
      addItem: typeId => {
        if (ui.readOnly) return null
        const raw = toPos(size.w / 2)
        const pos = ui.snap ? snapPos(raw, cam.s) : raw
        const id = createItem(typeId, pos, null, size.w / 2, spineY)
        if (id) promptName(id, size.w / 2, spineY + 14, pos)
        return id
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
      const p0 = st.projects.find(p => p.id === st.activeId) ?? st.projects[0]
      const c = p0.camera
      const base = timeBaseFor(p0.settings.unit.preset)
      const wheelMaxS = base ? Math.max(MAX_S, base * 400) : MAX_S
      const rect = el.getBoundingClientRect()
      const wheelMinS = Math.min(MIN_S, minZoomFor(p0, rect.width))
      const mx = e.clientX - rect.left
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        st.setCamera({ x: c.x + e.deltaX / c.s, s: c.s })
      } else {
        const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.006 : 0.0018))
        const s = clamp(c.s * k, wheelMinS, wheelMaxS)
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
        if (x <= bl.forkX + 8 || x >= bl.joinX - 8) continue
        // Each path owns the band from its row of items down to the line itself.
        const top = Math.min(...bl.pathYs) - PATH_LIFT - 20
        const bottom = Math.max(...bl.pathYs) + 20
        if (y < top || y > bottom) continue
        let best = Infinity
        bl.pathYs.forEach((py, i) => {
          const d = Math.abs(y - (py - PATH_LIFT / 2))
          if (d < best) { best = d; pathId = bl.branch.paths[i].id }
        })
      }
      const pos = ui.snap ? snapPos(toPos(x), cam.s) : toPos(x)
      createItem(typeId, pos, pathId, clientX - rect.left, clientY - rect.top)
    }
    return () => { chipDrop.current = null }
  })

  const createItem = (typeId: string, pos: number, pathId: string | null, fxX: number, fxY: number): string | null => {
    const type = useStore.getState().projects.find(p => p.id === proj.id)?.types.find(t => t.id === typeId)
      ?? proj.types.find(t => t.id === typeId) ?? proj.types[0]
    if (!type) return null
    const id = uid()
    mutate(p => {
      p.items.push({
        id, typeId: type.id, layerId: null, pathId, pos, duration: 0,
        title: type.name, description: '', tags: [], link: '', images: [], fieldValues: {},
        createdBy: creatorStamp(),
      })
    })
    setUI({ lastTypeId: type.id })
    select([id])
    burst(fxX, fxY, type.color)
    sfx.create()
    return id
  }

  /**
   * Ask for a just-created item's title in a small prompt at (x, y): Enter or
   * clicking anywhere else commits what was typed (empty keeps the default
   * title), Escape keeps the default.
   */
  const promptName = (itemId: string, x: number, y: number, pos: number) => {
    const it = useStore.getState().projects.find(p => p.id === proj.id)?.items.find(i => i.id === itemId)
    pendingNameRef.current = ''
    setMenu({ x, y, target: { kind: 'bg', pos, rawPos: pos }, name: { itemId, placeholder: it?.title ?? 'Name…' } })
  }

  /** Close the context menu / picker / name prompt, committing a pending name unless cancelled. */
  const closeMenu = (commit = true) => {
    const m = menu
    const text = pendingNameRef.current.trim()
    pendingNameRef.current = ''
    if (m?.name && commit && text) {
      const { itemId } = m.name
      mutate(p => { const it = p.items.find(i => i.id === itemId); if (it) it.title = text })
    }
    setMenu(null)
  }

  /** New type under the given name (next palette colour), for the "new type" row of a type search. */
  const createType = (name: string): string => {
    const id = uid()
    mutate(p => {
      p.types.push({
        id, name, icon: 'Circle', color: PALETTE[p.types.length % PALETTE.length], folderId: null,
        defaultLayerId: p.layers[Math.min(1, p.layers.length - 1)]?.id ?? null, fields: [],
      })
      hideNewTypeInFilters(p, id)
    })
    // The item about to be created with it should be visible right away.
    tweak(p => { p.filters.offTypes = p.filters.offTypes.filter(x => x !== id) })
    return id
  }

  // ---- Space: open the "new item" type search at the pointer (or the view
  // centre when the pointer is elsewhere), like the context menu's entry.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== ' ' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return
      const st = useStore.getState()
      if (st.ui.readOnly || st.ui.overlay || st.ui.editTypeId || dragRef.current) return
      e.preventDefault()
      // A focused toolbar button would also "click" on Space — drop its focus.
      if (t.tagName === 'BUTTON' || t.tagName === 'A') t.blur()
      const at = pointerRef.current ?? { x: size.w / 2, y: spineY - 40 }
      const rawPos = toPos(at.x)
      const pos = st.ui.snap ? snapPos(rawPos, cam.s) : rawPos
      setMenu({ x: at.x, y: at.y, target: { kind: 'bg', pos, rawPos }, search: true })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ---- context menu close (outside click / Escape)
  useEffect(() => {
    if (!menu) return
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) closeMenu()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMenu(false) }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  // ---- snapping
  /** World positions dragged edges/items stick to while the magnet is on. */
  const magnetCands = (exclude: { items?: Set<string>; itemEnds?: Set<string>; sectionIds?: Set<string>; branchId?: string }): number[] => {
    const out: number[] = []
    for (const it of proj.items) {
      if (exclude.items?.has(it.id)) continue
      out.push(it.pos)
      if (it.duration > 0 && !exclude.itemEnds?.has(it.id)) out.push(it.pos + it.duration)
    }
    for (const sc of proj.sections) {
      if (exclude.sectionIds?.has(sc.id)) continue
      out.push(sc.start, sc.end)
    }
    for (const br of proj.branches) {
      if (br.id === exclude.branchId) continue
      out.push(br.forkPos, br.joinPos)
    }
    return out
  }

  /** Magnet (stick to candidates within ~8px) first, then grid snap; Alt bypasses both. */
  const snapWorld = (np: number, cands: number[] | undefined, bypass: boolean): number => {
    if (bypass) return np
    if (ui.magnet && cands) {
      const thr = 8 / cam.s
      let best: number | null = null
      for (const c of cands) {
        const dd = Math.abs(c - np)
        if (dd < thr && (best === null || dd < Math.abs(best - np))) best = c
      }
      if (best !== null) return best
    }
    return ui.snap ? snapPos(np, cam.s) : np
  }

  const selectedSectionIds = useMemo(
    () => ui.selection.filter(s => s.startsWith('S:')).map(s => s.slice(2)),
    [ui.selection],
  )
  const anySectionSelected = selectedSectionIds.length > 0

  /** Expand a set of section ids with every section geometrically contained in one of them. */
  const expandContained = (ids: string[]): string[] => {
    const set = new Set(ids)
    for (const s0 of proj.sections) {
      if (set.has(s0.id)) continue
      if (proj.sections.some(par => set.has(par.id) && par.start <= s0.start + 1e-9 && par.end >= s0.end - 1e-9)) {
        set.add(s0.id)
      }
    }
    return [...set]
  }

  /** Items whose position lies inside any of the given section ranges. */
  const itemsWithin = (sects: Iterable<{ start: number; end: number }>): Map<string, number> => {
    const list = [...sects]
    const out = new Map<string, number>()
    for (const it of proj.items) {
      if (list.some(s0 => it.pos >= s0.start - 1e-9 && it.pos <= s0.end + 1e-9)) out.set(it.id, it.pos)
    }
    return out
  }

  /** Branches whose whole span lies inside any of the given section ranges. */
  const branchesWithin = (sects: Iterable<{ start: number; end: number }>): Map<string, { fork: number; join: number }> => {
    const list = [...sects]
    const out = new Map<string, { fork: number; join: number }>()
    for (const br of proj.branches) {
      if (list.some(s0 => br.forkPos >= s0.start - 1e-9 && br.joinPos <= s0.end + 1e-9)) {
        out.set(br.id, { fork: br.forkPos, join: br.joinPos })
      }
    }
    return out
  }

  /** Each contained branch mapped to the innermost of the given sections. */
  const branchSecFor = (sects: Map<string, { start: number; end: number }>): Map<string, { fork: number; join: number; secId: string }> => {
    const out = new Map<string, { fork: number; join: number; secId: string }>()
    for (const br of proj.branches) {
      let bestId: string | null = null
      let bestSpan = Infinity
      sects.forEach((b, id) => {
        if (br.forkPos >= b.start - 1e-9 && br.joinPos <= b.end + 1e-9 && b.end - b.start < bestSpan) {
          bestId = id
          bestSpan = b.end - b.start
        }
      })
      if (bestId) out.set(br.id, { fork: br.forkPos, join: br.joinPos, secId: bestId })
    }
    return out
  }

  /** Each contained item mapped to the innermost of the given sections. */
  const itemSecFor = (sects: Map<string, { start: number; end: number }>): Map<string, { pos: number; dur: number; secId: string }> => {
    const out = new Map<string, { pos: number; dur: number; secId: string }>()
    for (const it of proj.items) {
      let bestId: string | null = null
      let bestSpan = Infinity
      sects.forEach((b, id) => {
        if (it.pos >= b.start - 1e-9 && it.pos <= b.end + 1e-9 && b.end - b.start < bestSpan) {
          bestId = id
          bestSpan = b.end - b.start
        }
      })
      if (bestId) out.set(it.id, { pos: it.pos, dur: it.duration, secId: bestId })
    }
    return out
  }

  /** Durations of span items among the given ids (points are skipped). */
  const durationsOf = (ids: Iterable<string>): Map<string, number> => {
    const set = new Set(ids)
    const out = new Map<string, number>()
    for (const it of proj.items) if (set.has(it.id) && it.duration > 0) out.set(it.id, it.duration)
    return out
  }

  /**
   * Start dragging a section edge. With no section selected (global mode),
   * coincident edges of other sections are picked up too, so a shared border
   * between adjacent sections moves as one. With a selection, only the
   * selected section's own edge moves.
   */
  const startSectionEdge = (e: React.PointerEvent, sc: Section, side: 'L' | 'R') => {
    if (e.button !== 0) return
    if (ui.readOnly) { e.stopPropagation(); select([`S:${sc.id}`]); return }
    e.stopPropagation()
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    const pos = side === 'L' ? sc.start : sc.end
    // Multi-section selection: an edge drag scales the whole selected group
    // proportionally around its opposite extreme.
    if (selectedSectionIds.length > 1 && selectedSectionIds.includes(sc.id)) {
      const selBounds = proj.sections.filter(s0 => selectedSectionIds.includes(s0.id))
      const allIds = expandContained(selectedSectionIds)
      const all = proj.sections.filter(s0 => allIds.includes(s0.id))
      const orig = new Map(selBounds.map(s0 => [s0.id, { start: s0.start, end: s0.end }]))
      const subOrig = new Map(
        all.filter(s0 => !selectedSectionIds.includes(s0.id)).map(s0 => [s0.id, { start: s0.start, end: s0.end }]),
      )
      // Anchor on the selected group's extremes (contained children just follow).
      const anchor = side === 'R'
        ? Math.min(...selBounds.map(s0 => s0.start))
        : Math.max(...selBounds.map(s0 => s0.end))
      if (Math.abs(pos - anchor) < 1e-9) return
      const minW = Math.min(...all.map(s0 => s0.end - s0.start))
      setDragBoth({
        kind: 'sectionScale', ids: selectedSectionIds, startClientX: e.clientX,
        orig, subOrig, itemOrig: itemsWithin(orig.values()), branchOrig: branchesWithin(orig.values()),
        itemDur: durationsOf(itemsWithin(orig.values()).keys()),
        anchor, grabPos: pos,
        cands: magnetCands({ sectionIds: new Set(allIds) }),
        minFactor: minW > 0 ? 0.25 / minW : 0.05, moved: false,
      })
      return
    }
    let edges: { id: string; side: 'L' | 'R' }[] = [{ id: sc.id, side }]
    if (!anySectionSelected) {
      const tol = 1 / cam.s
      for (const other of proj.sections) {
        if (other.id === sc.id) continue
        if (Math.abs(other.start - pos) <= tol) edges.push({ id: other.id, side: 'L' })
        if (Math.abs(other.end - pos) <= tol) edges.push({ id: other.id, side: 'R' })
      }
      // A sub-section flush with the grabbed boundary is content of its parent,
      // not a border peer: drop any participant contained inside another one so
      // it redistributes with the parent instead of getting one edge stretched.
      const boundsOf = (id: string) => proj.sections.find(x => x.id === id)
      edges = edges.filter(ed => {
        const a = boundsOf(ed.id)
        if (!a) return false
        return !edges.some(other => {
          if (other.id === ed.id) return false
          const b = boundsOf(other.id)
          return !!b && b.end - b.start > a.end - a.start + 1e-9 &&
            b.start <= a.start + 1e-9 && b.end >= a.end - 1e-9
        })
      })
    }
    let min = -Infinity
    let max = Infinity
    for (const ed of edges) {
      const s0 = proj.sections.find(x => x.id === ed.id)
      if (!s0) continue
      if (ed.side === 'L') max = Math.min(max, s0.end - 0.25)
      else min = Math.max(min, s0.start + 0.25)
    }
    const origSects = new Map(
      edges.map(ed => {
        const s0 = proj.sections.find(x => x.id === ed.id)!
        return [ed.id, { start: s0.start, end: s0.end }] as const
      }),
    )
    // Sub-sections contained in a dragged section, mapped to their innermost
    // dragged parent — they redistribute with it unless Shift is held.
    const subSects = new Map<string, { start: number; end: number; parentId: string }>()
    for (const s0 of proj.sections) {
      if (origSects.has(s0.id)) continue
      let parentId: string | null = null
      let span = Infinity
      origSects.forEach((b, id) => {
        if (s0.start >= b.start - 1e-9 && s0.end <= b.end + 1e-9 && b.end - b.start < span) {
          parentId = id
          span = b.end - b.start
        }
      })
      if (parentId) subSects.set(s0.id, { start: s0.start, end: s0.end, parentId })
    }
    setDragBoth({
      kind: 'sectionEdge', edges, orig: pos, startClientX: e.clientX,
      cands: magnetCands({ sectionIds: new Set(edges.map(ed => ed.id)) }), min, max,
      origSects, itemSec: itemSecFor(origSects), subSects, branchSec: branchSecFor(origSects),
    })
  }

  /** Label drag: select the section (shift adds) and move all selected together.
      Alt at the start duplicates the section (with contained sections and
      items) and drags the copy instead. */
  /**
   * Reference pick mode: while `ui.pickRef` is set, clicking an item or a
   * section header fills that field instead of selecting. Returns true when
   * the click was consumed.
   */
  const tryPick = (targetId: string): boolean => {
    const st0 = useStore.getState()
    const pr = st0.ui.pickRef
    if (!pr) return false
    const p0 = st0.projects.find(x => x.id === st0.activeId)
    const field = p0?.fields.find(f => f.id === pr.fieldId)
    const target = p0 ? ownerOf(p0, targetId) : null
    if (!p0 || !field || !target) { setUI({ pickRef: null }); return true }
    if (targetId === pr.ownerId) { showToast('An entry can’t reference itself.'); return true }
    if (!allowsTarget(p0, field, target)) { showToast(`“${field.name}” can’t reference that kind of entry.`); return true }
    mutate(pp => {
      const o = ownerOf(pp, pr.ownerId)
      if (!o) return
      o.entity.fieldValues ??= {}
      const cur = o.entity.fieldValues[field.id]
      const ids = Array.isArray(cur) ? cur : []
      o.entity.fieldValues[field.id] = field.refMultiple ? [...ids.filter(x => x !== targetId), targetId] : [targetId]
    })
    setUI({ pickRef: null })
    sfx.select()
    return true
  }

  const labelPointerDown = (e: React.PointerEvent, sc: Section) => {
    if (e.button !== 0) return
    if (tryPick(sc.id)) { e.stopPropagation(); return }
    if (ui.readOnly) { e.stopPropagation(); select([`S:${sc.id}`]); return }
    e.stopPropagation()
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    if (e.altKey) {
      const srcIds = expandContained([sc.id])
      const srcSects = proj.sections.filter(s0 => srcIds.includes(s0.id))
      const srcItems = itemsWithin(srcSects)
      const idMap = new Map(srcIds.map(id => [id, uid()]))
      const newItemIds: string[] = []
      const orig = new Map<string, { start: number; end: number }>()
      const itemOrig = new Map<string, number>()
      mutate(p => {
        for (const s0 of srcSects) {
          const nid = idMap.get(s0.id)!
          p.sections.push({
            ...s0, id: nid, name: s0.id === sc.id ? `${s0.name} copy` : s0.name,
            fieldValues: structuredClone(s0.fieldValues ?? {}),
          })
          orig.set(nid, { start: s0.start, end: s0.end })
        }
        for (const it of p.items) {
          if (!srcItems.has(it.id)) continue
          const cp = structuredClone(it)
          cp.id = uid()
          cp.createdBy = creatorStamp()
          newItemIds.push(cp.id)
          itemOrig.set(cp.id, cp.pos)
          p.items.push(cp)
        }
      })
      const newGrabId = idMap.get(sc.id)!
      select([`S:${newGrabId}`])
      setDragBoth({
        kind: 'sectionMove', ids: [...idMap.values()], grabId: newGrabId,
        startClientX: e.clientX, orig, itemOrig,
        // Branches are not duplicated, so the copy's drag moves none of them.
        branchOrig: new Map(),
        cands: magnetCands({ sectionIds: new Set(idMap.values()), items: new Set(newItemIds) }),
        moved: false,
      })
      return
    }
    const key = `S:${sc.id}`
    let ids: string[]
    if (selection.has(key)) {
      ids = selectedSectionIds
    } else if (e.shiftKey) {
      select([...ui.selection, key])
      ids = [...selectedSectionIds, sc.id]
    } else {
      select([key])
      ids = [sc.id]
      sfx.select()
    }
    // Contained sections and the items inside all of them travel with the move.
    const allIds = expandContained(ids)
    const orig = new Map(
      proj.sections.filter(s0 => allIds.includes(s0.id)).map(s0 => [s0.id, { start: s0.start, end: s0.end }]),
    )
    const itemOrig = itemsWithin(orig.values())
    setDragBoth({
      kind: 'sectionMove', ids: allIds, grabId: sc.id, startClientX: e.clientX, orig, itemOrig,
      branchOrig: branchesWithin(orig.values()),
      cands: magnetCands({ sectionIds: new Set(allIds), items: new Set(itemOrig.keys()) }), moved: false,
    })
  }

  // ---- pointer interactions
  const setDragBoth = (d: Drag | null) => {
    // Viewer mode: only camera gestures and selection may start a drag.
    if (d && ui.readOnly && d.kind !== 'pan' && d.kind !== 'marquee') return
    dragRef.current = d
    setDrag(d)
  }

  const bgPointerDown = (e: React.PointerEvent) => {
    const rect = wrapRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    // Panning is reserved for the right and middle mouse buttons.
    if (e.button === 1 || e.button === 2) {
      e.preventDefault()
      cancelFlight()
      ;(e.target as Element).setPointerCapture?.(e.pointerId)
      setDragBoth({ kind: 'pan', button: e.button, startClientX: e.clientX, startClientY: e.clientY, camX: cam.x, moved: false })
      return
    }
    if (e.button !== 0) return
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    if (ui.tool === 'branch' && !ui.readOnly) {
      const pos = ui.snap ? snapPos(toPos(x), cam.s) : toPos(x)
      setDragBoth({ kind: 'branch', startPos: pos, curPos: pos })
    } else {
      setDragBoth({ kind: 'marquee', x0: x, y0: y, x1: x, y1: y })
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const rect = wrapRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    pointerRef.current = { x, y }
    const d = dragRef.current
    if (!d) return
    if (d.kind === 'pan') {
      const dx = e.clientX - d.startClientX
      if (Math.abs(dx) + Math.abs(e.clientY - d.startClientY) > 3) {
        if (!d.moved) setMenu(null)
        d.moved = true
      }
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
      const rippleOn = d.ripple || e.shiftKey
      // Snap the grabbed item (magnet is pointless in ripple mode — everything
      // moves together), then shift the rest by the same delta so gaps hold.
      const gp = d.orig.get(d.grabId) ?? d.orig.values().next().value ?? 0
      const delta = snapWorld(gp + du, rippleOn ? undefined : d.cands, e.altKey) - gp
      const src = rippleOn ? d.allOrig : d.orig
      src.forEach((op, id) => next.set(id, op + delta))
      setPosOverride(next)
      // Spans ending at the grabbed position stretch with the drag (in ripple
      // mode they translate whole, like everything else).
      if (rippleOn || !d.endOrig.size) {
        setDurOverride(null)
      } else {
        const durOvs: { id: string; pos: number; duration: number }[] = []
        d.endOrig.forEach(({ pos, dur }, id) => {
          durOvs.push({ id, pos, duration: Math.max(0, dur + delta) })
        })
        setDurOverride(durOvs)
      }
    } else if (d.kind === 'itemScale') {
      if (!d.moved && Math.abs(e.clientX - d.startClientX) <= 3) return
      d.moved = true
      const du = (e.clientX - d.startClientX) / cam.s
      const np = snapWorld(d.grabPos + du, d.cands, e.altKey)
      const factor = Math.max((np - d.anchor) / (d.grabPos - d.anchor), d.minFactor)
      const durOvs: { id: string; pos: number; duration: number }[] = []
      d.orig.forEach(({ pos, dur }, id) => {
        durOvs.push({ id, pos: d.anchor + (pos - d.anchor) * factor, duration: dur * factor })
      })
      setDurOverride(durOvs)
    } else if (d.kind === 'handle') {
      const du = (e.clientX - d.startClientX) / cam.s
      if (d.side === 'R') {
        const end = snapWorld(d.origPos + d.origDur + du, d.cands, e.altKey)
        setDurOverride([{ id: d.id, pos: d.origPos, duration: Math.max(0, end - d.origPos) }])
      } else {
        let start = snapWorld(d.origPos + du, d.cands, e.altKey)
        const end = d.origPos + d.origDur
        start = Math.min(start, end)
        setDurOverride([{ id: d.id, pos: start, duration: end - start }])
      }
    } else if (d.kind === 'branchEnd') {
      const du = (e.clientX - d.startClientX) / cam.s
      const np = snapWorld(d.orig + du, d.cands, e.altKey)
      const br = proj.branches.find(b => b.id === d.id)
      if (!br) return
      if (d.side === 'fork') setBranchOverride([{ id: d.id, forkPos: Math.min(np, br.joinPos - 0.5), joinPos: br.joinPos }])
      else setBranchOverride([{ id: d.id, forkPos: br.forkPos, joinPos: Math.max(np, br.forkPos + 0.5) }])
    } else if (d.kind === 'sectionEdge') {
      const du = (e.clientX - d.startClientX) / cam.s
      const np = clamp(snapWorld(d.orig + du, d.cands, e.altKey), d.min, d.max)
      const ovs: { id: string; start: number; end: number }[] = []
      const ovById = new Map<string, { start: number; end: number }>()
      for (const ed of d.edges) {
        const os = d.origSects.get(ed.id)
        if (!os) continue
        const nb = ed.side === 'L' ? { start: np, end: os.end } : { start: os.start, end: np }
        ovById.set(ed.id, nb)
        ovs.push({ id: ed.id, ...nb })
      }
      // Default: the section's contents — sub-sections and items — redistribute
      // linearly into its new span; holding Shift leaves them in place.
      if (!e.shiftKey) {
        const remap = (secId: string, v: number): number | null => {
          const os = d.origSects.get(secId)
          const nb = ovById.get(secId)
          if (!os || !nb || os.end - os.start < 1e-9) return null
          return nb.start + ((v - os.start) / (os.end - os.start)) * (nb.end - nb.start)
        }
        const ratioOf = (secId: string): number => {
          const os = d.origSects.get(secId)
          const nb = ovById.get(secId)
          if (!os || !nb || os.end - os.start < 1e-9) return 1
          return (nb.end - nb.start) / (os.end - os.start)
        }
        d.subSects.forEach((sb, id) => {
          const a = remap(sb.parentId, sb.start)
          const b = remap(sb.parentId, sb.end)
          if (a !== null && b !== null) ovs.push({ id, start: Math.min(a, b), end: Math.max(a, b) })
        })
        const pv = new Map<string, number>()
        const durOvs: { id: string; pos: number; duration: number }[] = []
        d.itemSec.forEach(({ pos, dur, secId }, itemId) => {
          const npos = remap(secId, pos)
          if (npos === null) return
          if (dur > 0) durOvs.push({ id: itemId, pos: npos, duration: dur * ratioOf(secId) })
          else pv.set(itemId, npos)
        })
        // Branches redistribute into the new span like items do.
        const bvs: { id: string; forkPos: number; joinPos: number }[] = []
        d.branchSec.forEach(({ fork, join, secId }, brId) => {
          const a = remap(secId, fork)
          const b = remap(secId, join)
          if (a !== null && b !== null) bvs.push({ id: brId, forkPos: Math.min(a, b), joinPos: Math.max(a, b) })
        })
        setPosOverride(pv)
        setDurOverride(durOvs.length ? durOvs : null)
        setBranchOverride(bvs.length ? bvs : null)
      } else {
        setPosOverride(null)
        setDurOverride(null)
        setBranchOverride(null)
      }
      setSectionOverride(ovs)
    } else if (d.kind === 'sectionMove') {
      if (!d.moved && Math.abs(e.clientX - d.startClientX) <= 3) return
      d.moved = true
      const du = (e.clientX - d.startClientX) / cam.s
      const grab = d.orig.get(d.grabId) ?? d.orig.values().next().value
      if (!grab) return
      const delta = snapWorld(grab.start + du, d.cands, e.altKey) - grab.start
      const ovs: { id: string; start: number; end: number }[] = []
      d.orig.forEach((o, id) => ovs.push({ id, start: o.start + delta, end: o.end + delta }))
      setSectionOverride(ovs)
      // Items and branches inside the moved sections travel along.
      const pv = new Map<string, number>()
      d.itemOrig.forEach((pos, id) => pv.set(id, pos + delta))
      setPosOverride(pv)
      const bvs: { id: string; forkPos: number; joinPos: number }[] = []
      d.branchOrig.forEach((b, id) => bvs.push({ id, forkPos: b.fork + delta, joinPos: b.join + delta }))
      setBranchOverride(bvs.length ? bvs : null)
    } else if (d.kind === 'sectionScale') {
      if (!d.moved && Math.abs(e.clientX - d.startClientX) <= 3) return
      d.moved = true
      const du = (e.clientX - d.startClientX) / cam.s
      const np = snapWorld(d.grabPos + du, d.cands, e.altKey)
      const factor = Math.max((np - d.anchor) / (d.grabPos - d.anchor), d.minFactor)
      const ovs: { id: string; start: number; end: number }[] = []
      const scaleBounds = (o: { start: number; end: number }, id: string) => {
        const a = d.anchor + (o.start - d.anchor) * factor
        const b = d.anchor + (o.end - d.anchor) * factor
        ovs.push({ id, start: Math.min(a, b), end: Math.max(a, b) })
      }
      d.orig.forEach(scaleBounds)
      // Default: contained sub-sections, item spacing, span durations, and
      // branches all scale along with the selection; holding Shift leaves
      // them where they are.
      if (!e.shiftKey) {
        d.subOrig.forEach(scaleBounds)
        const pv = new Map<string, number>()
        const durOvs: { id: string; pos: number; duration: number }[] = []
        d.itemOrig.forEach((pos, id) => {
          const npos = d.anchor + (pos - d.anchor) * factor
          const dur = d.itemDur.get(id)
          if (dur) durOvs.push({ id, pos: npos, duration: dur * factor })
          else pv.set(id, npos)
        })
        setPosOverride(pv)
        setDurOverride(durOvs.length ? durOvs : null)
        const bvs: { id: string; forkPos: number; joinPos: number }[] = []
        d.branchOrig.forEach((b, id) => {
          const a = d.anchor + (b.fork - d.anchor) * factor
          const c = d.anchor + (b.join - d.anchor) * factor
          bvs.push({ id, forkPos: Math.min(a, c), joinPos: Math.max(a, c) })
        })
        setBranchOverride(bvs.length ? bvs : null)
      } else {
        setPosOverride(null)
        setDurOverride(null)
        setBranchOverride(null)
      }
      setSectionOverride(ovs)
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current
    setDragBoth(null)
    if (!d) return
    const rect = wrapRef.current!.getBoundingClientRect()
    if (d.kind === 'pan') {
      // A completed right-drag pan must not pop the context menu on release.
      if (d.moved && d.button === 2) suppressMenuRef.current = true
    } else if (d.kind === 'marquee') {
      const [ax, bx] = [Math.min(d.x0, d.x1), Math.max(d.x0, d.x1)]
      const [ay, by] = [Math.min(d.y0, d.y1), Math.max(d.y0, d.y1)]
      if (bx - ax < 4 && by - ay < 4) {
        // Plain click on empty space.
        if (!e.shiftKey) select([])
        return
      }
      const hits: string[] = []
      for (const pl of layout.placed) {
        const iy = spineY + pl.ny
        if (pl.x >= ax && pl.x <= bx && iy >= ay && iy <= by) hits.push(pl.item.id)
      }
      // Sections join the marquee through their header bars (same geometry as render).
      for (const sc of proj.sections) {
        const sx1 = toX(sc.start)
        const sx2 = toX(sc.end)
        if (sx2 < -40 || sx1 > size.w + 40 || sx2 - sx1 < 2) continue
        const barTop = barTopFor(sc.depth)
        const barBottom = barTop + sizeAtDepth(sc.depth) + 10
        if (sx1 < bx && sx2 > ax && barTop < by && barBottom > ay) hits.push(`S:${sc.id}`)
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
      const dv = durOverride
      setPosOverride(null)
      setDurOverride(null)
      if (d.moved && (ov || dv)) {
        mutate(p => {
          if (ov) for (const it of p.items) if (ov.has(it.id)) it.pos = ov.get(it.id)!
          if (dv) for (const o of dv) {
            const it = p.items.find(i => i.id === o.id)
            if (it) { it.pos = o.pos; it.duration = o.duration }
          }
        })
        puff(e.clientX - rect.left, e.clientY - rect.top, d.color)
        sfx.snap()
      }
    } else if (d.kind === 'itemScale') {
      const dv = durOverride
      setDurOverride(null)
      if (d.moved && dv) {
        mutate(p => {
          for (const o of dv) {
            const it = p.items.find(i => i.id === o.id)
            if (it) { it.pos = o.pos; it.duration = o.duration }
          }
        })
        puff(e.clientX - rect.left, e.clientY - rect.top, d.color)
        sfx.snap()
      }
    } else if (d.kind === 'handle') {
      const ov = durOverride
      setDurOverride(null)
      if (ov) {
        mutate(p => {
          for (const o of ov) {
            const it = p.items.find(i => i.id === o.id)
            if (it) { it.pos = o.pos; it.duration = o.duration }
          }
        })
        sfx.snap()
      }
    } else if (d.kind === 'branchEnd') {
      const ov = branchOverride
      setBranchOverride(null)
      if (ov) {
        mutate(p => {
          for (const o of ov) {
            const br = p.branches.find(b => b.id === o.id)
            if (br) { br.forkPos = o.forkPos; br.joinPos = o.joinPos }
          }
        })
        sfx.snap()
      }
    } else if (d.kind === 'sectionEdge' || d.kind === 'sectionMove' || d.kind === 'sectionScale') {
      const ov = sectionOverride
      const pv = posOverride
      const dv = durOverride
      const bv = branchOverride
      setSectionOverride(null)
      setPosOverride(null)
      setDurOverride(null)
      setBranchOverride(null)
      const moved = d.kind === 'sectionEdge' || d.moved
      if (ov?.length && moved) {
        mutate(p => {
          for (const o of ov) {
            const sc = p.sections.find(s0 => s0.id === o.id)
            if (sc) { sc.start = o.start; sc.end = o.end }
          }
          if (pv) for (const it of p.items) if (pv.has(it.id)) it.pos = pv.get(it.id)!
          if (dv) for (const o of dv) {
            const it = p.items.find(i => i.id === o.id)
            if (it) { it.pos = o.pos; it.duration = o.duration }
          }
          if (bv) for (const o of bv) {
            const br = p.branches.find(b => b.id === o.id)
            if (br) { br.forkPos = o.forkPos; br.joinPos = o.joinPos }
          }
        })
        sfx.snap()
      }
    }
  }

  const bgDoubleClick = (e: React.MouseEvent) => {
    if (ui.tool !== 'select' || ui.readOnly) return
    const rect = wrapRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const pos = ui.snap ? snapPos(toPos(x), cam.s) : toPos(x)
    const typeId = ui.lastTypeId ?? proj.types[0]?.id
    if (typeId) createItem(typeId, pos, null, x, e.clientY - rect.top)
  }

  const itemPointerDown = (e: React.PointerEvent, item: Item) => {
    if (e.button !== 0) return
    if (tryPick(item.id)) { e.stopPropagation(); return }
    if (ui.readOnly || review.has(item.id)) {
      // Viewer mode, or an item whose proposed state is being previewed: select only.
      e.stopPropagation()
      select(e.shiftKey ? [...ui.selection.filter(s0 => !s0.includes(':')), item.id] : [item.id])
      return
    }
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
          cp.createdBy = creatorStamp()
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
        const state = useStore.getState()
        const cur = state.projects.find(p => p.id === state.activeId)
        const it2 = cur?.items.find(i => i.id === id)
        if (it2) orig.set(id, it2.pos)
      }
    }
    const allOrig = new Map<string, number>()
    {
      const state = useStore.getState()
      const cur = state.projects.find(p => p.id === state.activeId) ?? proj
      for (const it of cur.items) allOrig.set(it.id, it.pos)
    }
    const type = typeOf(proj, item)
    setDragBoth({
      kind: 'item', ids, grabId: ids.includes(item.id) ? item.id : ids[0], startClientX: e.clientX,
      orig, allOrig, endOrig: new Map(), ripple: ui.ripple || e.shiftKey, moved: false, color: type?.color ?? '#888',
      cands: magnetCands({ items: new Set(ids) }),
    })
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

  // ---- base dots: one per stack of placed items sharing a position; dragging
  // the dot moves every item in that stack together. A span whose END lands
  // on such a position joins the stack too (as `endIds`): the drag then
  // stretches that span so its end keeps following the stack.
  type Column = { x: number; y: number; ids: string[]; endIds: string[]; color: string; ghost: boolean }
  const columns = useMemo(() => {
    const sorted = [...layout.placed].sort((a, b) => a.y - b.y || a.x - b.x)
    const cols: Column[] = []
    for (const pl of sorted) {
      const last = cols[cols.length - 1]
      if (last && last.y === pl.y && Math.abs(pl.x - last.x) < 5) {
        last.ids.push(pl.item.id)
        // The dot fades with its stack: it stays solid while any item in the
        // stack survives the current filters.
        last.ghost = last.ghost && pl.ghost
      } else {
        cols.push({ x: pl.x, y: pl.y, ids: [pl.item.id], endIds: [], color: typeOf(proj, pl.item)?.color ?? '#888', ghost: pl.ghost })
      }
    }
    for (const pl of layout.placed) {
      if (pl.item.duration <= 0) continue
      const ex = toX(pl.item.pos + pl.item.duration)
      const col = cols.find(c => c.y === pl.y && Math.abs(c.x - ex) < 5 && !c.ids.includes(pl.item.id))
      if (col) col.endIds.push(pl.item.id)
    }
    return cols
  }, [layout, proj, cam])

  const basePointerDown = (e: React.PointerEvent, col: Column) => {
    if (e.button !== 0) return
    if (ui.readOnly) { e.stopPropagation(); select(col.ids); return }
    e.stopPropagation()
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    const orig = new Map<string, number>()
    for (const id of col.ids) {
      const it = proj.items.find(i => i.id === id)
      if (it) orig.set(id, it.pos)
    }
    const endOrig = new Map<string, { pos: number; dur: number }>()
    for (const id of col.endIds) {
      const it = proj.items.find(i => i.id === id)
      if (it) endOrig.set(id, { pos: it.pos, dur: it.duration })
    }
    const allOrig = new Map<string, number>()
    for (const it of proj.items) allOrig.set(it.id, it.pos)
    setDragBoth({
      kind: 'item', ids: col.ids, grabId: col.ids[0], startClientX: e.clientX,
      orig, allOrig, endOrig, ripple: ui.ripple || e.shiftKey, moved: false, color: col.color,
      cands: magnetCands({ items: new Set(col.ids), itemEnds: new Set(col.endIds) }),
    })
  }

  // ---- group scale: with several items selected, the first (leftmost start)
  // and last (rightmost end) selected item carry handles that scale the whole
  // selection — positions and span durations — around the opposite extreme.
  const groupScale = useMemo(() => {
    const sel = proj.items.filter(it => selection.has(it.id))
    if (sel.length < 2) return null
    let first = sel[0]
    let last = sel[0]
    for (const it of sel) {
      if (it.pos < first.pos) first = it
      if (it.pos + it.duration > last.pos + last.duration) last = it
    }
    const minPos = first.pos
    const maxEnd = last.pos + last.duration
    if (maxEnd - minPos < 1e-9) return null
    return { ids: sel.map(it => it.id), firstId: first.id, lastId: last.id, minPos, maxEnd }
  }, [proj.items, selection])

  const startGroupScale = (e: React.PointerEvent, side: 'L' | 'R', color: string) => {
    if (e.button !== 0 || ui.readOnly || !groupScale) return
    e.stopPropagation()
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    const orig = new Map<string, { pos: number; dur: number }>()
    for (const it of proj.items) if (selection.has(it.id)) orig.set(it.id, { pos: it.pos, dur: it.duration })
    const grabPos = side === 'L' ? groupScale.minPos : groupScale.maxEnd
    const anchor = side === 'L' ? groupScale.maxEnd : groupScale.minPos
    // Keep the group from collapsing below a hair's width on screen.
    const minFactor = Math.min(0.5, (8 / cam.s) / (groupScale.maxEnd - groupScale.minPos))
    setDragBoth({
      kind: 'itemScale', ids: groupScale.ids, side, startClientX: e.clientX, orig, anchor, grabPos,
      cands: magnetCands({ items: new Set(groupScale.ids) }), minFactor, moved: false, color,
    })
  }

  // ---- context menu
  const bgContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    if (ui.readOnly) return
    if (suppressMenuRef.current) { suppressMenuRef.current = false; return }
    const rect = wrapRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const rawPos = toPos(x)
    const pos = ui.snap ? snapPos(rawPos, cam.s) : rawPos
    setMenu({ x, y, target: { kind: 'bg', pos, rawPos } })
  }

  const itemContextMenu = (e: React.MouseEvent, item: Item) => {
    e.preventDefault()
    e.stopPropagation()
    if (ui.readOnly) { select([item.id]); return }
    if (suppressMenuRef.current) { suppressMenuRef.current = false; return }
    if (!selection.has(item.id)) select([item.id])
    const rect = wrapRef.current!.getBoundingClientRect()
    setMenu({ x: e.clientX - rect.left, y: e.clientY - rect.top, target: { kind: 'item', id: item.id } })
  }

  const selectedItemIds = () => {
    const sel = useStore.getState().ui.selection.filter(s => !s.includes(':'))
    return sel.length ? sel : []
  }

  const menuCopy = () => {
    const ids = selectedItemIds()
    setClipboard(proj.items.filter(i => ids.includes(i.id)))
    showToast(`Copied ${ids.length} item${ids.length === 1 ? '' : 's'}.`)
    setMenu(null)
  }

  const menuDuplicate = () => {
    const ids = selectedItemIds()
    const nids: string[] = []
    mutate(p => {
      for (const id of ids) {
        const src = p.items.find(i => i.id === id)
        if (!src) continue
        const cp = structuredClone(src)
        cp.id = uid()
        cp.pos += Math.max(0.5, cp.duration)
        cp.createdBy = creatorStamp()
        nids.push(cp.id)
        p.items.push(cp)
      }
    })
    select(nids)
    setMenu(null)
  }

  const menuDelete = () => {
    const ids = selectedItemIds()
    setMenu(null)
    requestDelete({ itemIds: ids }, () => { select([]); showToast('Deleted.', true) })
  }

  const menuSplitSection = (id: string, rawPos: number) => {
    mutate(p => {
      const sc = p.sections.find(s0 => s0.id === id)
      if (!sc) return
      const cut = clamp(ui.snap ? snapPos(rawPos, cam.s) : rawPos, sc.start + 0.05, sc.end - 0.05)
      p.sections.push({ ...sc, id: uid(), name: `${sc.name} (2)`, start: cut, fieldValues: structuredClone(sc.fieldValues ?? {}) })
      sc.end = cut
    })
    showToast('Section split.', true)
    sfx.snap()
    setMenu(null)
  }

  const menuPasteAt = (pos: number) => {
    const clip = getClipboard()
    if (!clip.length) return
    const base = Math.min(...clip.map(i => i.pos))
    const nids: string[] = []
    mutate(p => {
      for (const src of clip) {
        const cp = structuredClone(src)
        cp.id = uid()
        cp.pos = pos + (src.pos - base)
        cp.pathId = null
        cp.createdBy = creatorStamp()
        nids.push(cp.id)
        p.items.push(cp)
      }
    })
    select(nids)
    setMenu(null)
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
  const hoverItem = hover ? view.items.find(i => i.id === hover.id) : null
  const hoverType = hoverItem ? typeOf(view, hoverItem) : null
  const hoverFields = hoverItem
    ? attachmentsFor(view, { kind: 'item', entity: hoverItem })
      .filter(a => a.field.showInTooltip)
      .map(a => ({ field: a.field, text: formatValue(view, a.field, effectiveValue(a.field, a.att, hoverItem.fieldValues[a.field.id])) }))
      .filter(a => a.text)
    : []

  // Processor results flagged "show on band", per section. Recomputed only
  // when the document changes, never per pointer move.
  const badges = useMemo(
    () => new Map(proj.sections.map(sc => [sc.id, bandBadge(proj, sc)])),
    [proj.sections, proj.items, proj.fields, proj.processors, proj.hierarchyLevels, proj.types],
  )

  // Reference connectors for the single selected entry: outgoing links of its
  // own ref fields and incoming links, both only for fields that opt in.
  const links = useMemo(() => {
    if (ui.selection.length !== 1) return []
    const key = ui.selection[0]
    const selId = key.startsWith('S:') ? key.slice(2) : key.includes(':') ? null : key
    if (!selId) return []
    const owner = ownerOf(proj, selId)
    if (!owner) return []
    const out: { from: string; to: string }[] = []
    for (const { att, field } of attachmentsFor(proj, owner)) {
      if (field.kind !== 'ref' || !field.refShowLinks) continue
      const v = effectiveValue(field, att, owner.entity.fieldValues?.[field.id])
      if (Array.isArray(v)) for (const id of v) out.push({ from: selId, to: id })
    }
    for (const bl of backlinks(proj, selId)) if (bl.field.refShowLinks) out.push({ from: bl.owner.entity.id, to: selId })
    return out
  }, [proj, ui.selection])
  const highlightId = ui.highlightId

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

  const bandGeo = sectionsSorted.flatMap(sc => {
    const x1 = toX(sc.start)
    const x2 = toX(sc.end)
    const w = x2 - x1
    if (x2 < -40 || x1 > size.w + 40 || w < 2) return []
    const sel = selection.has(`S:${sc.id}`)
    const labelPx = sizeAtDepth(sc.depth)
    // The label renders only when it fits fully inside the (visible part of
    // the) bar — otherwise the colored bar alone marks the section. The faint
    // duration follows only if it fits too.
    const avail = x2 - (Math.max(x1, 0) + 8)
    const nameW = sc.name.length * labelPx * 0.62
    const dur = sc.end - sc.start
    const durText = st.sectionStyle.showDuration
      ? formatUnit(dur, dur, unitSuffix(st.unit.preset, st.unit.custom), st.unit.preset)
      : ''
    const durPx = Math.max(labelPx - 2.5, 9)
    // Processor badge sits right-aligned in the visible part of the bar and
    // shows only when it clears the name (and the duration, if shown).
    const badge = badges.get(sc.id) ?? ''
    const showDur = !!durText && avail >= nameW + 8 + durText.length * durPx * 0.62 + 10
    const textEnd = Math.max(x1, 0) + 8 + nameW + (showDur ? 8 + durText.length * durPx * 0.62 : 0)
    const badgeX = Math.min(x2, size.w) - 8
    const showBadge = !!badge && avail >= nameW + 8 && badgeX - badge.length * durPx * 0.62 >= textEnd + 14
    return [{
      sc, x1, x2, w, sel, labelPx, hl: highlightId === sc.id, badge, badgeX, showBadge,
      hue: sectionHue(depthIndex.get(sc.id) ?? 0),
      barTop: -spineY + barTopFor(sc.depth),
      barH: labelPx + 10,
      showText: avail >= nameW + 8,
      durText, durPx,
      durX: Math.max(x1, 0) + 8 + nameW + 8,
      showDur,
      edgeAlpha: sel ? 0.8 : clamp(st.sectionStyle.edgeStrength * Math.max(1 - 0.3 * sc.depth, 0.25), 0, 1),
      edgeW: sc.depth === 0 ? 1.6 : 1,
    }]
  })

  return (
    <div
      ref={wrapRef}
      className={`canvas-wrap tool-${ui.tool} ${drag?.kind === 'pan' ? 'panning' : ''} ${ui.pickRef ? 'picking' : ''}`}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => { pointerRef.current = null }}
      onContextMenu={bgContextMenu}
      onMouseDown={e => { if (e.button === 1) e.preventDefault() }}
    >
      <svg
        className="scene"
        width={size.w}
        height={size.h}
        onPointerDown={bgPointerDown}
        onDoubleClick={bgDoubleClick}
      >
        <g transform={`translate(0, ${spineY})`}>
          {/* section bands (fills + edges; header bars render on top later) */}
          {bandGeo.map(({ sc, x1, x2, w, hue, edgeAlpha, edgeW }) => (
            <g key={sc.id} className="band-g" pointerEvents="none">
              <rect
                x={x1} y={-spineY} width={w} height={size.h}
                className="band"
                style={{ fill: `hsl(${hue} 60% 55% / ${(0.024 + sc.depth * 0.013) * st.bandStrength})` }}
              />
              <line x1={x1} y1={-spineY} x2={x1} y2={size.h - spineY} className="band-edge"
                style={{ stroke: `hsl(${hue} 55% 55% / ${edgeAlpha})`, strokeWidth: edgeW }} />
              <line x1={x2} y1={-spineY} x2={x2} y2={size.h - spineY} className="band-edge"
                style={{ stroke: `hsl(${hue} 55% 55% / ${edgeAlpha})`, strokeWidth: edgeW }} />
            </g>
          ))}

          {/* unit ruler & background grid */}
          {(st.grid.show || st.unit.showRuler) && (() => {
            const step = rulerStepFor(cam.s, st.unit.preset)
            const n0 = Math.floor(cam.x / step)
            const n1 = Math.ceil((cam.x + size.w / cam.s) / step)
            const suffix = unitSuffix(st.unit.preset, st.unit.custom)
            const dash = st.grid.style === 'dashed' ? '5 7' : st.grid.style === 'dots' ? '0.5 9' : undefined
            const ticks: React.ReactNode[] = []
            for (let n = n0; n <= n1; n++) {
              const v = n * step
              const x = toX(v)
              ticks.push(
                <g key={n}>
                  {st.grid.show && (
                    <line
                      x1={x} y1={-spineY} x2={x} y2={size.h - spineY}
                      className="grid-line" style={{ opacity: st.grid.opacity }}
                      strokeDasharray={dash} strokeLinecap={st.grid.style === 'dots' ? 'round' : undefined}
                    />
                  )}
                  {st.unit.showRuler && (
                    <>
                      <line x1={x} y1={-5} x2={x} y2={5} className="ruler-tick" />
                      <text x={x + 5} y={16} className="ruler-label">{formatUnit(v, step, suffix, st.unit.preset)}</text>
                    </>
                  )}
                </g>,
              )
            }
            return <g pointerEvents="none">{ticks}</g>
          })()}

          {/* section header bars — a padding-free, fully opaque strip spanning
              the whole section at its depth row, drawn above everything else in
              the band so nothing cuts through it. Also the section's drag target. */}
          {bandGeo.map(({ sc, x1, w, hue, sel, hl, labelPx, barTop, barH, showText, showDur, durText, durX, durPx, badge, badgeX, showBadge }) => (
            <g
              key={`hdr-${sc.id}`}
              className="band-label-g"
              onPointerDown={e => labelPointerDown(e, sc)}
            >
              <rect
                x={x1} y={barTop} width={w} height={barH}
                className={`band-label-box ${hl ? 'hl' : ''}`}
                style={{
                  fill: `color-mix(in srgb, hsl(${hue} 60% 55%) 16%, var(--panel))`,
                  stroke: `hsl(${hue} 55% 55% / ${sel ? 0.95 : 0.45})`,
                }}
              />
              {showText && (
                <text
                  x={Math.max(x1, 0) + 8} y={barTop + labelPx + 3}
                  className={`band-label ${sel ? 'sel' : ''}`}
                  style={{
                    fill: `hsl(${hue} 50% var(--band-label-l))`,
                    fontSize: labelPx,
                    fontWeight: sc.depth === 0 ? 700 : 600,
                  }}
                >
                  {sc.name}
                </text>
              )}
              {showDur && (
                <text
                  x={durX} y={barTop + labelPx + 3}
                  className="band-dur"
                  style={{ fill: `hsl(${hue} 45% var(--band-label-l) / 0.55)`, fontSize: durPx }}
                >
                  {durText}
                </text>
              )}
              {showBadge && (
                <text
                  x={badgeX} y={barTop + labelPx + 3} textAnchor="end"
                  className="band-badge"
                  style={{ fill: `hsl(${hue} 50% var(--band-label-l) / 0.85)`, fontSize: durPx }}
                >
                  {badge}
                </text>
              )}
            </g>
          ))}

          {/* Edge handles: with no section selected every edge is live (nearly
              invisible until hovered) and coincident edges drag together; with
              a selection only that section's edges work. They live only in the
              header-bar strip — between the header boxes — never as grab lines
              inside the timeline itself. */}
          {bandGeo.map(({ sc, x1, x2, sel, barTop, barH }) => (!anySectionSelected || sel) && (
            <g key={`eh-${sc.id}`}>
              <line
                x1={x1} y1={barTop - 2} x2={x1} y2={barTop + barH + 2} className={`band-handle ${sel ? '' : 'quiet'}`}
                onPointerDown={e => startSectionEdge(e, sc, 'L')}
              />
              <line
                x1={x2} y1={barTop - 2} x2={x2} y2={barTop + barH + 2} className={`band-handle ${sel ? '' : 'quiet'}`}
                onPointerDown={e => startSectionEdge(e, sc, 'R')}
              />
            </g>
          ))}

          {/* spine — broken where a branch splits it into paths */}
          <path
            d={spineD(size.w, layout.branches)} className="spine"
            style={{ strokeWidth: st.spine.width, opacity: st.spine.opacity }}
          />

          {/* stems — one layer under every node, so a stem heading for a high
              row can never show through the icons of the rows below it */}
          <g pointerEvents="none">
            {layout.placed.map(pl => {
              const t = typeOf(proj, pl.item)
              const z = pl.size || 1
              return (
                <line
                  key={`stem-${pl.item.id}`} className="stem"
                  x1={pl.x} y1={pl.ny + (pl.ny < pl.y ? 14 * z : -14 * z)} x2={pl.x} y2={pl.y}
                  style={{ stroke: t?.color }}
                />
              )
            })}
          </g>

          {/* reference connectors (selected entry ↔ its referenced / referencing entries) */}
          {links.length > 0 && (() => {
            const anchor = (id: string): { x: number; y: number } | null => {
              const pl = layout.placed.find(x => x.item.id === id)
              if (pl) return { x: pl.x, y: pl.ny }
              const dot = layout.dots.find(x => x.item.id === id)
              if (dot) return { x: dot.x, y: dot.y }
              const bg = bandGeo.find(g => g.sc.id === id)
              if (bg) return { x: (Math.max(bg.x1, 0) + Math.min(bg.x2, size.w)) / 2, y: bg.barTop + bg.barH / 2 }
              return null
            }
            return (
              <g className="ref-links" pointerEvents="none">
                {links.map((l, i) => {
                  const a = anchor(l.from)
                  const b = anchor(l.to)
                  if (!a || !b) return null
                  const mx = (a.x + b.x) / 2
                  const lift = Math.min(Math.abs(b.x - a.x) * 0.25, 120)
                  const my = Math.min(a.y, b.y) - lift
                  return (
                    <g key={`${l.from}-${l.to}-${i}`}>
                      <path d={`M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`} className="ref-link" />
                      <circle cx={b.x} cy={b.y} r={3.5} className="ref-link-end" />
                    </g>
                  )
                })}
              </g>
            )
          })()}

          {/* branches */}
          {layout.branches.map(bl => (
            <BranchG
              key={bl.branch.id}
              bl={bl}
              selected={selection.has(`B:${bl.branch.id}`)}
              selectBranch={() => { select([`B:${bl.branch.id}`]); sfx.select() }}
              startEndDrag={(side, e) => {
                e.stopPropagation()
                ;(e.target as Element).setPointerCapture?.(e.pointerId)
                setDragBoth({
                  kind: 'branchEnd', id: bl.branch.id, side,
                  orig: side === 'fork' ? bl.branch.forkPos : bl.branch.joinPos,
                  startClientX: e.clientX, cands: magnetCands({ branchId: bl.branch.id }),
                })
              }}
              zoomIn={() => {
                const span = bl.branch.joinPos - bl.branch.forkPos
                const s = clamp((size.w * 0.7) / span, minS, maxS)
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
              <g key={`leave-${id}`} className="node" transform={`translate(${x}, ${l.ny})`} pointerEvents="none">
                <g className="node-inner out">
                  <circle r={13} style={{ fill: `${type?.color}22`, stroke: type?.color }} />
                </g>
              </g>
            )
          })}

          {/* placed items */}
          {layout.placed.map(pl => {
            const ch = review.get(pl.item.id)
            // A moved or resized item keeps a faint ghost where it is now.
            const before = ch?.kind === 'update' ? (ch.before as Item) : null
            const ghost = before && (before.pos !== pl.item.pos || before.duration !== pl.item.duration)
              ? { dx: toX(before.pos) - pl.x, spanW: before.duration > 0 ? before.duration * cam.s : 0 }
              : null
            return (
            <ItemG
              key={pl.item.id}
              pl={pl}
              proj={view}
              selected={selection.has(pl.item.id)}
              highlight={highlightId === pl.item.id}
              proposed={proposed.has(pl.item.id)}
              review={ch?.kind}
              ghost={ghost}
              showFields={ui.showFields}
              showTitles={ui.showTitles}
              scaleL={!ui.readOnly && groupScale?.firstId === pl.item.id}
              scaleR={!ui.readOnly && groupScale?.lastId === pl.item.id}
              anim={ui.animLevel !== 'off'}
              onPointerDown={e => itemPointerDown(e, pl.item)}
              onContextMenu={e => itemContextMenu(e, pl.item)}
              onHoverStart={e => itemHoverStart(e, pl.item.id)}
              onHoverEnd={itemHoverEnd}
              startHandle={(side, e) => {
                if (ui.readOnly) return
                e.stopPropagation()
                ;(e.target as Element).setPointerCapture?.(e.pointerId)
                const cur = effective.items.find(i => i.id === pl.item.id) ?? pl.item
                setDragBoth({
                  kind: 'handle', id: pl.item.id, side, origPos: cur.pos, origDur: cur.duration,
                  startClientX: e.clientX, cands: magnetCands({ items: new Set([pl.item.id]) }),
                })
              }}
              startScale={(side, e) => startGroupScale(e, side, typeOf(view, pl.item)?.color ?? '#888')}
            />
            )
          })}

          {/* minimized layer items (below their layer's min zoom) */}
          {layout.dots.map(dot => (
            <g
              key={dot.item.id}
              className={`layer-dot ${dot.ghost ? 'ghost' : ''} ${highlightId === dot.item.id ? 'hl' : ''}`}
              transform={`translate(${dot.x}, ${dot.y})`}
              onPointerDown={e => itemPointerDown(e, dot.item)}
              onContextMenu={e => itemContextMenu(e, dot.item)}
              onPointerEnter={e => itemHoverStart(e, dot.item.id)}
              onPointerLeave={itemHoverEnd}
            >
              <circle r={9} className="dot-hit" />
              <circle r={3.5} className="dot-core" style={{ fill: dot.color }} />
            </g>
          ))}

          {/* clusters */}
          {layout.clusters.map(cl => (
            <g
              key={cl.key}
              transform={`translate(${cl.x}, ${cl.y})`}
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
                    const s = clamp(cam.s * 2.4, minS, maxS)
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
                    const it = view.items.find(x => x.id === id)
                    if (!it) return null
                    const t = typeOf(view, it)
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

          {/* base dots — drag one to move every item stacked at that position */}
          {!drag && columns.map(col => (
            <circle
              key={`base-${col.ids[0]}`}
              cx={col.x} cy={col.y} r={4}
              className={`base-dot ${col.ghost ? 'ghost' : ''}`}
              style={{ stroke: col.color }}
              onPointerDown={e => basePointerDown(e, col)}
            >
              <title>{col.ids.length + col.endIds.length > 1 ? `Move ${col.ids.length + col.endIds.length} items` : 'Move item'}</title>
            </circle>
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
        {ui.pickRef && <span className="status-hint"> — click an item or section header to reference it (Esc to cancel)</span>}
      </div>

      {/* tooltip */}
      {hoverItem && hoverType && !drag && (
        <div className="tooltip" style={{ left: Math.min(hover!.x + 14, size.w - 280), top: Math.max(hover!.y - 10, 8) }}>
          <div className="tt-head">
            <span className="tt-dot" style={{ background: hoverType.color }} />
            <strong>{hoverItem.title}</strong>
          </div>
          <div className="tt-type">{hoverType.name}{hoverItem.duration > 0 ? ` · span ${hoverItem.duration.toFixed(1)}` : ''}</div>
          {hoverItem.createdBy && (
            <div className="tt-type creator">
              <span className="creator-dot" style={{ background: hoverItem.createdBy.color }} />
              {hoverItem.createdBy.name}
            </div>
          )}
          {hoverItem.tags.length > 0 && (
            <div className="tt-tags">{hoverItem.tags.map(t => <span key={t} className="tag">{t}</span>)}</div>
          )}
          {hoverFields.length > 0 && (
            <div className="tt-fields">
              {hoverFields.map(f => <div key={f.field.id}>{f.field.showName && <span className="muted">{f.field.name}</span>} {f.text}</div>)}
            </div>
          )}
          {hoverItem.images[0] && <img src={hoverItem.images[0]} alt="" className="tt-img" />}
          {hoverItem.description && <div className="tt-desc"><Markdown text={hoverItem.description.slice(0, 400)} /></div>}
        </div>
      )}

      {/* context menu */}
      {menu && (
        <div
          ref={menuRef}
          className="menu ctx"
          style={menu.search || menu.name
            // The in-place type search is wider and taller than the menu; keep it on the canvas.
            ? { left: clamp(menu.x, 0, size.w - 250), top: clamp(menu.y, 0, size.h - (menu.name ? 60 : 340)) }
            : { left: clamp(menu.x, 0, size.w - 200), top: clamp(menu.y, 0, size.h - 200) }}
          onContextMenu={e => e.preventDefault()}
        >
          {menu.target.kind === 'bg' && menu.search ? (() => {
            // "New item here": a type search in place of the menu — type to
            // filter, Enter/click to place an item of that type at the click.
            const { pos } = menu.target
            return (
              <TypeSearch
                proj={proj}
                placeholder="New item here…"
                autoFocus
                listWhenEmpty
                onPick={typeId => {
                  const id = createItem(typeId, pos, null, menu.x, menu.y)
                  if (id) promptName(id, menu.x, menu.y, pos); else setMenu(null)
                }}
                onCreateType={name => {
                  const id = createItem(createType(name), pos, null, menu.x, menu.y)
                  if (id) promptName(id, menu.x, menu.y, pos); else setMenu(null)
                }}
                onClose={() => setMenu(null)}
              />
            )
          })() : menu.name ? (
            // Name the item just created from the picker: Enter or a click
            // elsewhere keeps what's typed; Escape keeps the default title.
            <NamePrompt
              key={menu.name.itemId}
              placeholder={menu.name.placeholder}
              onChange={t => { pendingNameRef.current = t }}
              onCommit={() => closeMenu()}
              onCancel={() => closeMenu(false)}
            />
          ) : menu.target.kind === 'bg' ? (() => {
            const { pos, rawPos } = menu.target
            return (
              <>
                <button onClick={() => setMenu({ ...menu, search: true })}>
                  <Plus width={13} height={13} /> New item here…
                </button>
                <button onClick={() => {
                  const levelName = proj.hierarchyLevels[0]?.name ?? 'Section'
                  const span = (size.w * 0.25) / cam.s
                  const id = uid()
                  mutate(p => p.sections.push({
                    id, name: `New ${levelName.toLowerCase()}`, depth: 0, start: pos, end: pos + span, fieldValues: {},
                  }))
                  select([`S:${id}`])
                  setMenu(null)
                }}><RectangleHorizontal width={13} height={13} /> New section here</button>
                {proj.sections
                  .filter(sc => sc.start < rawPos && sc.end > rawPos)
                  .sort((a, b) => a.depth - b.depth)
                  .map(sc => (
                    <button key={`split-${sc.id}`} onClick={() => menuSplitSection(sc.id, rawPos)}>
                      <Scissors width={13} height={13} /> Split “{sc.name}” here
                    </button>
                  ))}
                {getClipboard().length > 0 && (
                  <button onClick={() => menuPasteAt(pos)}><ClipboardPaste width={13} height={13} /> Paste here</button>
                )}
                <button onClick={() => { flyTo(fitCamera(proj, size.w)); setMenu(null) }}>
                  <Maximize2 width={13} height={13} /> Fit everything
                </button>
                <button onClick={() => { setUI({ overlay: 'settings' }); setMenu(null) }}>
                  <Settings2 width={13} height={13} /> Timeline settings…
                </button>
              </>
            )
          })() : (
            <>
              <button onClick={menuCopy}><ClipboardCopy width={13} height={13} /> Copy</button>
              <button onClick={menuDuplicate}><CopyPlus width={13} height={13} /> Duplicate</button>
              <button className="danger" onClick={menuDelete}><Trash2 width={13} height={13} /> Delete</button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ NamePrompt

/** Single-line title prompt: Enter or blur commits, Escape cancels. */
function NamePrompt(props: {
  placeholder: string
  onChange: (text: string) => void
  onCommit: () => void
  onCancel: () => void
}) {
  const [text, setText] = useState('')
  return (
    <div className="type-search name-prompt">
      <div className="search-box type-search-box">
        <input
          className="search-input"
          placeholder={props.placeholder}
          value={text}
          autoFocus
          onChange={e => { setText(e.target.value); props.onChange(e.target.value) }}
          onBlur={props.onCommit}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); props.onCommit() }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); props.onCancel() }
          }}
        />
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ ItemG

function ItemG(props: {
  pl: PlacedItem
  proj: ReturnType<typeof useActiveProject>
  selected: boolean
  highlight: boolean
  /** Part of the proposal being reviewed, or edited in the suggest-mode draft. */
  proposed: boolean
  /** Kind of the pending proposal change previewed on this item (undefined when none). */
  review?: ChangeKind
  /** Where the item currently is while its proposed position is previewed (offset in px, current bar width). */
  ghost?: { dx: number; spanW: number } | null
  /** This item is the first of a multi-selection: its start carries the group scale handle. */
  scaleL: boolean
  /** This item is the last of a multi-selection: its end carries the group scale handle. */
  scaleR: boolean
  anim: boolean
  onPointerDown: (e: React.PointerEvent) => void
  onContextMenu: (e: React.MouseEvent) => void
  onHoverStart: (e: React.PointerEvent) => void
  onHoverEnd: () => void
  startHandle: (side: 'L' | 'R', e: React.PointerEvent) => void
  startScale: (side: 'L' | 'R', e: React.PointerEvent) => void
  showFields: boolean
  showTitles: boolean
}) {
  const { pl, proj, selected, scaleL, scaleR } = props
  const type = typeOf(proj, pl.item)
  const Icon = iconByName(type?.icon ?? 'Circle')
  const label = splitLabel(proj, pl.item, props.showFields, props.showTitles)
  const color = type?.color ?? '#888'
  const z = pl.size || 1
  const barY = 3 + 14 * z
  // Under review the item is a preview: no duration handles, no dragging.
  const locked = !!props.review
  return (
    <g
      className={`node ${pl.ghost ? 'ghost' : ''} ${selected ? 'sel' : ''} ${props.highlight ? 'hl' : ''} ${props.review ? `prop-${props.review}` : ''}`}
      transform={`translate(${pl.x}, ${pl.ny})`}
      onPointerDown={props.onPointerDown}
      onContextMenu={props.onContextMenu}
      onPointerEnter={props.onHoverStart}
      onPointerLeave={props.onHoverEnd}
    >
      {props.ghost && (
        <g className="prop-ghost" pointerEvents="none">
          <line x1={props.ghost.dx} y1={0} x2={0} y2={0} className="prop-ghost-link" />
          {props.ghost.spanW > 0 && (
            <rect x={props.ghost.dx} y={barY} width={props.ghost.spanW} height={6} rx={3} className="prop-ghost-bar" style={{ fill: color }} />
          )}
          <circle cx={props.ghost.dx} r={14 * z} className="prop-ghost-node" style={{ stroke: color }} />
        </g>
      )}
      <g className={`node-inner ${props.anim ? 'pop' : ''}`}>
        {pl.spanW > 0 && (
          <g>
            <rect x={0} y={barY} width={pl.spanW} height={6} rx={3} style={{ fill: `${color}55`, stroke: `${color}88` }} />
            {selected && !locked && (
              <>
                {!scaleL && (
                  <circle cx={0} cy={barY + 3} r={6} className="dur-handle" style={{ stroke: color }}
                    onPointerDown={e => props.startHandle('L', e)} />
                )}
                {!scaleR && (
                  <circle cx={pl.spanW} cy={barY + 3} r={6} className="dur-handle" style={{ stroke: color }}
                    onPointerDown={e => props.startHandle('R', e)} />
                )}
              </>
            )}
          </g>
        )}
        {/* Group scale handles: a bracket at the selection's first start and
            last end (a span's own duration handle steps aside for it). */}
        {scaleL && (
          <g className="scale-handle" transform={`translate(0, ${barY + 3})`} onPointerDown={e => props.startScale('L', e)}>
            <rect x={-5} y={-9} width={10} height={18} rx={3} style={{ stroke: color }} />
            <path d="M 1.5 -4 L -1.5 0 L 1.5 4" style={{ stroke: color }} />
            <title>Scale selection</title>
          </g>
        )}
        {scaleR && (
          <g className="scale-handle" transform={`translate(${pl.spanW}, ${barY + 3})`} onPointerDown={e => props.startScale('R', e)}>
            <rect x={-5} y={-9} width={10} height={18} rx={3} style={{ stroke: color }} />
            <path d="M -1.5 -4 L 1.5 0 L -1.5 4" style={{ stroke: color }} />
            <title>Scale selection</title>
          </g>
        )}
        {selected && <circle r={19 * z} className="sel-ring" style={{ stroke: color }} />}
        {props.highlight && <circle r={22 * z} className="hl-ring" />}
        {props.proposed && <circle r={(selected ? 24 : 20) * z} className={`prop-ring ${props.review ?? ''}`} />}
        <circle r={14 * z} className="node-under" />
        <circle r={14 * z} className="node-bg" style={{ fill: `${color}26`, stroke: color }} />
        <Icon x={-8 * z} y={-8 * z} width={16 * z} height={16 * z} color={color} strokeWidth={2} />
        {pl.labelShown && (
          <text
            x={20 * z} y={4 * z} className="node-label"
            style={{ fill: `color-mix(in srgb, ${color} 30%, var(--text))`, fontSize: 11.5 * clamp(z, 0.8, 1.35) }}
          >
            {label.title}
            {label.fields && <tspan className="node-fields">{label.title ? ' · ' : ''}{label.fields}</tspan>}
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
  startEndDrag: (side: 'fork' | 'join', e: React.PointerEvent) => void
  zoomIn: () => void
}) {
  const { bl, selected } = props
  const { branch } = bl
  const GateIcon = branch.mode === 'any' ? Shuffle : ListChecks
  const dash = branch.mode === 'any' ? '7 5' : undefined
  const pick = (e: React.PointerEvent) => { e.stopPropagation(); props.selectBranch() }
  // Labels and the ALL checkboxes sit just under each path's straight run; they
  // get out of the way when the branch is squeezed too narrow to read them.
  const labelX = bl.forkX + bl.curveW + 6
  const roomy = bl.joinX - bl.forkX > 2 * bl.curveW + 40
  return (
    <g className={`branch ${selected ? 'sel' : ''}`}>
      {branch.paths.map((path, i) => {
        const y = bl.pathYs[i]
        return (
          <g key={path.id}>
            <path
              d={branchPathD(bl, y, path.terminal)}
              className="branch-path"
              strokeDasharray={dash}
              onPointerDown={pick}
              onDoubleClick={props.zoomIn}
            />
            {path.terminal && (
              <rect x={terminalEndX(bl) - 2} y={y - 8} width={4} height={16} rx={2} className="terminal-cap" />
            )}
            {roomy && branch.mode === 'all' && (
              <rect x={labelX} y={y + 5} width={9} height={9} rx={2} className="all-check" />
            )}
            {roomy && path.label && (
              <text x={labelX + (branch.mode === 'all' ? 14 : 0)} y={y + 13} className="path-label" onPointerDown={pick}>
                {path.label}
              </text>
            )}
          </g>
        )
      })}
      {/* gate + join */}
      <g className="gate" onPointerDown={pick}>
        <circle cx={bl.forkX} r={12} className="gate-bg" />
        <GateIcon x={bl.forkX - 7} y={-7} width={14} height={14} className="gate-icon" />
      </g>
      <circle cx={bl.joinX} r={5} className="join-dot" onPointerDown={pick} />
      {selected && (
        <>
          <circle cx={bl.forkX} r={17} className="end-handle" onPointerDown={e => props.startEndDrag('fork', e)} />
          <circle cx={bl.joinX} r={12} className="end-handle" onPointerDown={e => props.startEndDrag('join', e)} />
        </>
      )}
    </g>
  )
}
