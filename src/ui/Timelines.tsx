import React, { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronUp, Copy, Pencil, Plus, Trash2, X } from 'lucide-react'
import { entityTitle, referencesTo } from '../model/fields'
import { useActiveWhole, useCanEdit, useStore } from '../model/store'
import { itemsOf, sectionsOf, timelineName } from '../model/timelines'
import type { Id } from '../model/types'

/**
 * Timelines (subtabs) of a project. The active project tab grows a chevron
 * once the project has more than one timeline; it opens a menu to switch,
 * rename, reorder, duplicate and delete them. The first extra timeline is
 * created from the tab's context menu (right-click, or long-press on a phone).
 * The viewer page shows the same menu without the editing actions.
 */

/** Anchor a fixed-position menu under an element, keeping it on screen. */
function menuStyle(anchor: DOMRect | null): React.CSSProperties {
  if (!anchor) return { left: 8, top: 48 }
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - 268))
  return { left, top: anchor.bottom + 4 }
}

/** Close on outside click or Escape. */
function useDismiss(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [ref, onClose])
}

/** Create / rename / duplicate / delete with the prompts and confirmations they need. */
export function useTimelineOps() {
  const st = useStore
  const create = (): Id | null => {
    const s = st.getState()
    const whole = s.active()
    const n = whole.timelines.length + 1
    const name = window.prompt('Timeline name', `Timeline ${n}`)
    if (name === null) return null
    return s.addTimeline(name)
  }
  const rename = (id: Id) => {
    const s = st.getState()
    const tl = s.active().timelines.find(t => t.id === id)
    if (!tl) return
    const name = window.prompt('Timeline name', tl.name)
    if (name && name.trim() && name !== tl.name) s.renameTimeline(id, name)
  }
  const duplicate = (id: Id) => { st.getState().duplicateTimeline(id) }
  const remove = (id: Id) => {
    const s = st.getState()
    const whole = s.active()
    const tl = whole.timelines.find(t => t.id === id)
    if (!tl || whole.timelines.length <= 1) return
    const items = itemsOf(whole, id)
    const sections = sectionsOf(whole, id)
    const gone = new Set([...items.map(i => i.id), ...sections.map(sc => sc.id)])
    // References from other timelines to anything on this one break with it.
    const refs = gone.size ? referencesTo(whole, gone).filter(r => r.owner.entity.timelineId !== id) : []
    const owners = new Map<string, string>()
    for (const r of refs) {
      const key = r.owner.entity.id
      const where = timelineName(whole, r.owner.entity.timelineId)
      owners.set(key, owners.has(key) ? `${owners.get(key)}, ${r.field.name}` : `${entityTitle(whole, key)} (${where}) — via ${r.field.name}`)
    }
    const what = [
      items.length ? `${items.length} item${items.length === 1 ? '' : 's'}` : '',
      sections.length ? `${sections.length} section${sections.length === 1 ? '' : 's'}` : '',
    ].filter(Boolean).join(' and ')
    s.setUI({
      confirm: {
        title: `Delete timeline “${tl.name}”?`,
        message: `${what ? `Everything on it goes with it: ${what}. ` : 'It is empty. '}${owners.size
          ? `${owners.size} entr${owners.size === 1 ? 'y' : 'ies'} on other timelines reference${owners.size === 1 ? 's' : ''} it; those references will be removed.`
          : 'You can undo this.'}`,
        list: owners.size ? [...owners.values()] : undefined,
        okLabel: 'Delete timeline',
        danger: true,
        onOk: () => { st.getState().deleteTimeline(id); st.getState().showToast(`Timeline “${tl.name}” deleted.`, true) },
      },
    })
  }
  return { create, rename, duplicate, remove }
}

/** Dropdown listing the project's timelines; management actions only when the tab can edit. */
export function TimelineMenu({ anchor, onClose }: { anchor: DOMRect | null; onClose: () => void }) {
  const whole = useActiveWhole()
  const canEdit = useCanEdit()
  const setActiveTimeline = useStore(s => s.setActiveTimeline)
  const moveTimeline = useStore(s => s.moveTimeline)
  const ops = useTimelineOps()
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, onClose)
  const active = whole.activeTimelineId ?? whole.timelines[0]?.id
  return (
    <div ref={ref} className="menu tl-menu" style={menuStyle(anchor)} onContextMenu={e => e.preventDefault()}>
      {whole.timelines.map((t, i) => {
        const on = t.id === active
        const n = itemsOf(whole, t.id).length
        return (
          <div key={t.id} className={`tl-row ${on ? 'on' : ''}`} title={`${n} item${n === 1 ? '' : 's'}`}>
            <button className="tl-pick" onClick={() => { setActiveTimeline(t.id); onClose() }}>
              <span className="tl-check">{on && <Check width={13} height={13} />}</span>
              <span className="tl-name">{t.name}</span>
              <span className="count">{n}</span>
            </button>
            {canEdit && (
              <span className="tl-acts">
                <button className="ghost-btn" title="Rename" onClick={() => { ops.rename(t.id); onClose() }}><Pencil width={12} height={12} /></button>
                <button className="ghost-btn" title="Move left" disabled={i === 0} onClick={() => moveTimeline(t.id, -1)}><ChevronUp width={12} height={12} /></button>
                <button className="ghost-btn" title="Move right" disabled={i === whole.timelines.length - 1} onClick={() => moveTimeline(t.id, 1)}><ChevronDown width={12} height={12} /></button>
                <button className="ghost-btn" title="Duplicate with everything on it" onClick={() => { ops.duplicate(t.id); onClose() }}><Copy width={12} height={12} /></button>
                <button className="ghost-btn danger" title="Delete timeline" disabled={whole.timelines.length <= 1} onClick={() => { ops.remove(t.id); onClose() }}><Trash2 width={12} height={12} /></button>
              </span>
            )}
          </div>
        )
      })}
      {canEdit && (
        <>
          <div className="menu-sep" />
          <button onClick={() => { onClose(); ops.create() }}><Plus width={13} height={13} /> New timeline…</button>
        </>
      )}
    </div>
  )
}

/**
 * The active timeline's name plus a chevron, shown inside the active project
 * tab once the project has more than one timeline. Clicking it opens the menu.
 */
export function TimelineTabControl() {
  const whole = useActiveWhole()
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const [open, setOpen] = useState(false)
  if (whole.timelines.length < 2) return null
  const name = timelineName(whole, whole.activeTimelineId)
  return (
    <>
      <button
        className={`tab-tl ${open ? 'on' : ''}`}
        title="Switch timeline"
        onClick={e => { e.stopPropagation(); setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect()); setOpen(v => !v) }}
        onDoubleClick={e => e.stopPropagation()}
        onPointerDown={e => e.stopPropagation()}
      >
        <span className="tab-tl-sep">›</span>
        <span className="tab-tl-name">{name}</span>
        <ChevronDown width={12} height={12} />
      </button>
      {open && <TimelineMenu anchor={anchor} onClose={() => setOpen(false)} />}
    </>
  )
}

/** Viewer page: "name ▾" button with the switch-only menu. */
export function TimelineSwitcher() {
  const whole = useActiveWhole()
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const [open, setOpen] = useState(false)
  if (whole.timelines.length < 2) return null
  return (
    <>
      <button
        className={`ghost-btn tl-switch ${open ? 'on' : ''}`}
        title="Switch timeline"
        onClick={e => { setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect()); setOpen(v => !v) }}
      >
        {timelineName(whole, whole.activeTimelineId)} <ChevronDown width={12} height={12} />
      </button>
      {open && <TimelineMenu anchor={anchor} onClose={() => setOpen(false)} />}
    </>
  )
}

export interface TabMenuState { projectId: Id; x: number; y: number }

/** Context menu of a project tab: rename, new timeline, close. */
export function TabContextMenu({ state, onClose, onRename, onClose_ }: {
  state: TabMenuState
  onClose: () => void
  onRename: (projectId: Id) => void
  /** Close (or delete) the project tab. */
  onClose_: (projectId: Id) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, onClose)
  const activeId = useStore(s => s.activeId)
  const setActive = useStore(s => s.setActive)
  const projects = useStore(s => s.projects)
  const canEdit = useStore(s => {
    if (s.ui.readOnly) return false
    const share = s.shares[state.projectId]
    return !share || share.role !== 'view'
  })
  const ops = useTimelineOps()
  const left = Math.max(8, Math.min(state.x, window.innerWidth - 220))
  const top = Math.max(8, Math.min(state.y, window.innerHeight - 160))
  return (
    <div ref={ref} className="menu tab-menu" style={{ left, top }} onContextMenu={e => e.preventDefault()}>
      <button onClick={() => { onClose(); onRename(state.projectId) }}><Pencil width={13} height={13} /> Rename project…</button>
      {canEdit && (
        <button onClick={() => {
          onClose()
          // Timelines are created on the tab the menu belongs to.
          if (state.projectId !== activeId) setActive(state.projectId)
          setTimeout(() => ops.create(), 0)
        }}><Plus width={13} height={13} /> New timeline…</button>
      )}
      {projects.length > 1 && (
        <button className="danger" onClick={() => { onClose(); onClose_(state.projectId) }}><X width={13} height={13} /> Close project</button>
      )}
    </div>
  )
}

/**
 * Long-press (touch) or right-click on a tab opens its context menu. Returns
 * the handlers to spread onto the tab element.
 */
export function useTabPress(open: (x: number, y: number) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const start = useRef<{ x: number; y: number } | null>(null)
  const cancel = () => { clearTimeout(timer.current); start.current = null }
  return {
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); open(e.clientX, e.clientY) },
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType !== 'touch') return
      start.current = { x: e.clientX, y: e.clientY }
      clearTimeout(timer.current)
      timer.current = setTimeout(() => { if (start.current) open(start.current.x, start.current.y); start.current = null }, 480)
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 8) cancel()
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
  }
}
