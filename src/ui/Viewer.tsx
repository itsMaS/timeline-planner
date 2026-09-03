import React, { useEffect } from 'react'
import { Eye, ExternalLink, Maximize2, Minus, Moon, Search, Sun, X, ZoomIn } from 'lucide-react'
import { useActiveProject, useActiveShare, useActiveSync, useStore } from '../model/store'
import { CanvasView } from './Canvas'
import { nav } from './nav'
import { PresenceBar } from './Share'

/** Lightweight read-only page for view links: canvas, tooltips, filter box, nothing editable. */
export function Viewer() {
  const proj = useActiveProject()
  const share = useActiveShare()
  const sync = useActiveSync()
  const ui = useStore(s => s.ui)
  const setUI = useStore(s => s.setUI)
  const tweak = useStore(s => s.tweak)
  const select = useStore(s => s.select)

  useEffect(() => { document.documentElement.dataset.theme = ui.theme }, [ui.theme])
  useEffect(() => { document.title = `${proj.name} — Timeline Planner` }, [proj.name])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') {
        if (e.key === 'Escape') t.blur()
        return
      }
      if (e.key === 'Escape') select([])
      if (e.key === '0') nav.current?.fitAll()
      if (e.key === '=' || e.key === '+') nav.current?.zoomBy(1.35)
      if (e.key === '-') nav.current?.zoomBy(0.74)
      if (e.key === '/') { e.preventDefault(); document.querySelector<HTMLInputElement>('.search-input')?.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const status = sync?.status ?? 'connecting'
  const appUrl = `${location.origin}${location.pathname}${location.search}`

  return (
    <div className="app viewer">
      <header className="toolbar viewer-bar">
        <div className="brand" title="Timeline Planner">⧗</div>
        <strong className="viewer-title" title={proj.name}>{proj.name}</strong>
        <span className="badge"><Eye width={11} height={11} /> View only</span>
        <span className={`sync-line compact ${status}`} title={status === 'live' ? 'Live' : status}>
          <span className="status-dot" />
        </span>
        <PresenceBar />
        <span className="grow" />
        <div className="search-box">
          <Search width={13} height={13} />
          <input
            className="search-input" placeholder="Filter items…  ( / )" value={proj.filters.text}
            onChange={e => tweak(p => { p.filters.text = e.target.value; p.activeViewId = null })}
          />
          {proj.filters.text && (
            <button className="ghost-btn" onClick={() => tweak(p => { p.filters.text = '' })}><X width={12} height={12} /></button>
          )}
        </div>
        <div className="tools">
          <button className="ghost-btn" title="Zoom out (-)" onClick={() => nav.current?.zoomBy(0.74)}><Minus width={15} height={15} /></button>
          <button className="ghost-btn" title="Zoom in (+)" onClick={() => nav.current?.zoomBy(1.35)}><ZoomIn width={15} height={15} /></button>
          <button className="ghost-btn" title="Fit everything (0)" onClick={() => nav.current?.fitAll()}><Maximize2 width={15} height={15} /></button>
          <span className="sep" />
          <button className="ghost-btn" title="Theme" onClick={() => setUI({ theme: ui.theme === 'dark' ? 'light' : 'dark' })}>
            {ui.theme === 'dark' ? <Sun width={15} height={15} /> : <Moon width={15} height={15} />}
          </button>
          <a className="ghost-btn" title="Open Timeline Planner" href={appUrl} target="_blank" rel="noreferrer">
            <ExternalLink width={15} height={15} />
          </a>
        </div>
      </header>
      {status === 'gone' && <div className="viewer-banner">This link has been revoked — what you see may be out of date.</div>}
      {status === 'offline' && <div className="viewer-banner muted">Offline — showing the last version received.</div>}
      <div className="main">
        <CanvasView />
      </div>
      {share?.viewToken && null}
    </div>
  )
}
