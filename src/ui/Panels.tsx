import React, { useRef } from 'react'
import { clampInspectorW, clampSidebarW, INSPECTOR_W, SIDEBAR_W, useStore } from '../model/store'

/**
 * Drag handle between a side panel and the canvas. Widths live in ui state
 * and persist per browser; double-click restores the default.
 */
export function PanelDivider({ side }: { side: 'left' | 'right' }) {
  const setUI = useStore(s => s.setUI)
  const start = useRef<{ x: number; w: number } | null>(null)
  const key = side === 'left' ? 'sidebarW' : 'inspectorW'
  const clampW = side === 'left' ? clampSidebarW : clampInspectorW
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const w = useStore.getState().ui[key]
    start.current = { x: e.clientX, w }
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    document.body.classList.add('col-resizing')
  }
  const onMove = (e: React.PointerEvent) => {
    const s = start.current
    if (!s) return
    const dx = e.clientX - s.x
    setUI({ [key]: clampW(side === 'left' ? s.w + dx : s.w - dx) } as never)
  }
  const onUp = () => {
    start.current = null
    document.body.classList.remove('col-resizing')
  }
  return (
    <div
      className={`panel-divider ${side}`}
      title="Drag to resize · double-click to reset"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={() => setUI({ [key]: side === 'left' ? SIDEBAR_W : INSPECTOR_W } as never)}
    />
  )
}
