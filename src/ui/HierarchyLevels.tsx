import React, { useRef, useState } from 'react'
import { GripVertical, Plus, Settings2, Trash2 } from 'lucide-react'
import { newLevel, useActiveProject, useActiveWhole, useCanEdit, useStore } from '../model/store'
import { uid } from '../model/util'

type Drop = { id: string; side: 'before' | 'after' }

/**
 * The hierarchy levels list in the sidebar's Structure section. Levels name
 * the nesting depths (index 0 is the outermost), so dragging a level to a
 * new position moves its name, fields and processors to that depth; the
 * sections themselves keep their geometric nesting.
 */
export function HierarchyLevels() {
  const proj = useActiveProject()
  const whole = useActiveWhole()
  const canEdit = useCanEdit()
  const mutate = useStore(s => s.mutate)
  const setUI = useStore(s => s.setUI)
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null)
  const [drop, setDrop] = useState<Drop | null>(null)
  const dragRef = useRef<{ id: string; started: boolean; x0: number; y0: number } | null>(null)
  const dropRef = useRef<Drop | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const levels = proj.hierarchyLevels

  const targetAt = (x: number, y: number): Drop | null => {
    const el = document.elementFromPoint(x, y)
    if (!el || !rootRef.current?.contains(el)) return null
    const row = el.closest<HTMLElement>('[data-level-row]')
    if (!row) return null
    const r = row.getBoundingClientRect()
    return { id: row.dataset.levelRow!, side: y < r.top + r.height / 2 ? 'before' : 'after' }
  }

  const startDrag = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || !canEdit) return
    e.preventDefault()
    dragRef.current = { id, started: false, x0: e.clientX, y0: e.clientY }
    const onMove = (ev: PointerEvent) => {
      const cur = dragRef.current
      if (!cur) return
      if (!cur.started && Math.hypot(ev.clientX - cur.x0, ev.clientY - cur.y0) > 4) cur.started = true
      if (!cur.started) return
      setDrag({ id: cur.id, x: ev.clientX, y: ev.clientY })
      const at = targetAt(ev.clientX, ev.clientY)
      dropRef.current = at
      setDrop(at)
    }
    const finish = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', finish)
      dragRef.current = null
      dropRef.current = null
      setDrag(null)
      setDrop(null)
    }
    const onUp = () => {
      const cur = dragRef.current
      const at = dropRef.current
      finish()
      if (!cur?.started || !at || at.id === cur.id) return
      mutate(p => {
        const list = p.hierarchyLevels
        const from = list.findIndex(l => l.id === cur.id)
        if (from < 0) return
        const [lv] = list.splice(from, 1)
        let to = list.findIndex(l => l.id === at.id)
        if (to < 0) { list.splice(from, 0, lv); return }
        if (at.side === 'after') to++
        list.splice(to, 0, lv)
      })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', finish)
  }

  const dropClass = (id: string) => (drop && drop.id === id ? (drop.side === 'before' ? 'drop-before' : 'drop-after') : '')
  const dragged = drag ? levels.find(l => l.id === drag.id) : null

  return (
    <div ref={rootRef} className={`level-list ${drag ? 'dragging' : ''}`}>
      {levels.map((level, d) => (
        <div
          key={level.id}
          className={`row gap level-row ${dropClass(level.id)} ${drag?.id === level.id ? 'lifting' : ''}`}
          data-level-row={level.id}
        >
          {canEdit && (
            <span
              className="grip" title="Drag to reorder: the level's name, fields and processors move to the new depth; sections keep their nesting"
              onPointerDown={e => startDrag(e, level.id)}
            ><GripVertical width={12} height={12} /></span>
          )}
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
                  id: uid(), name: `New ${level.name.toLowerCase()}`, timelineId: p.activeTimelineId ?? p.timelines[0].id, depth: d,
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
          {canEdit && d === levels.length - 1 && d > 0 && (
            <button
              className="ghost-btn" title="Remove level" disabled={whole.sections.some(s => s.depth === d)}
              onClick={() => mutate(p => { p.hierarchyLevels.pop() })}
            ><Trash2 width={13} height={13} /></button>
          )}
        </div>
      ))}
      {canEdit && levels.length < 5 && (
        <button className="ghost-btn add" onClick={() => mutate(p => p.hierarchyLevels.push(newLevel('Sub-level')))}>
          + Add hierarchy level
        </button>
      )}
      {dragged && drag && (
        <div className="drag-ghost" style={{ left: drag.x + 10, top: drag.y + 8, borderColor: 'var(--accent)' }}>
          {dragged.name}
        </div>
      )}
    </div>
  )
}
