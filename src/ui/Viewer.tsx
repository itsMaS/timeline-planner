import React, { useEffect } from 'react'
import {
  Eye, EyeOff, ExternalLink, Maximize2, Minus, Moon, PanelLeft, Search, Sun, X, ZoomIn,
} from 'lucide-react'
import { itemMatchesFilters } from '../model/layout'
import { useActiveProject, useActiveShare, useActiveSync, useStore } from '../model/store'
import { CanvasView } from './Canvas'
import { Inspector } from './Inspector'
import { nav } from './nav'
import { PanelDivider } from './Panels'
import { PresenceBar } from './Share'
import { Sidebar } from './Sidebar'

/**
 * Read-only page for view links: the full canvas plus the sidebar (types,
 * layers, structure, tags — for filtering and navigation) and the inspector
 * (descriptions, images, fields). Nothing here writes to the document.
 */
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
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') {
        if (e.key === 'Escape') t.blur()
        return
      }
      if (e.key === 'Escape') select([])
      if (e.key === '0') nav.current?.fitAll()
      if (e.key === '=' || e.key === '+') nav.current?.zoomBy(1.35)
      if (e.key === '-') nav.current?.zoomBy(0.74)
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); nav.current?.back() }
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); nav.current?.forward() }
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
        <button
          className={`ghost-btn ${ui.sidebarOpen ? 'on' : ''}`}
          title={ui.sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          onClick={() => setUI({ sidebarOpen: !ui.sidebarOpen })}
        ><PanelLeft width={15} height={15} /></button>
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
            onKeyDown={e => {
              if (e.key === 'Enter') {
                const first = proj.items.find(i => itemMatchesFilters(proj, i, proj.filters))
                if (first) nav.current?.flyToItem(first.id)
              }
              if (e.key === 'Escape') {
                tweak(p => { p.filters.text = '' })
                ;(e.target as HTMLInputElement).blur()
              }
            }}
          />
          {proj.filters.text && (
            <button className="ghost-btn" onClick={() => tweak(p => { p.filters.text = '' })}><X width={12} height={12} /></button>
          )}
        </div>
        <div className="tools">
          <label className="density" title="Detail density — how eagerly items appear">
            <span>detail</span>
            <input
              type="range" min={0} max={1} step={0.05} value={ui.density}
              onChange={e => setUI({ density: Number(e.target.value) })}
            />
          </label>
          <button className={`ghost-btn ${ui.ghostHidden ? 'on' : ''}`} title="Hide filtered items completely (instead of ghosting)"
            onClick={() => setUI({ ghostHidden: !ui.ghostHidden })}>
            {ui.ghostHidden ? <EyeOff width={15} height={15} /> : <Eye width={15} height={15} />}
          </button>
          <span className="sep" />
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
        <Sidebar />
        {ui.sidebarOpen && <PanelDivider side="left" />}
        <CanvasView />
        {ui.selection.length > 0 && <PanelDivider side="right" />}
        <Inspector />
      </div>
      {share?.viewToken && null}
    </div>
  )
}
