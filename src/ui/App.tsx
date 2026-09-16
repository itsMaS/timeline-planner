import React, { useEffect, useRef, useState } from 'react'
import {
  Download, Eye, EyeOff, FileText, GitBranch, Grid3x3, HelpCircle, Lightbulb, Link, Magnet, Maximize2, Minus, Moon, Pencil,
  Plus, Redo2, RotateCcw, Save, Search, Settings2, Share2, Sun, TableProperties, Type, Undo2, Upload, Volume2, VolumeX, X, ZoomIn,
} from 'lucide-react'
import { iconByName } from '../model/icons'
import { itemMatchesFilters } from '../model/layout'
import { blankProject, emptyFilters, useActiveProject, useActiveShare, useStore, useSuggesting } from '../model/store'
import { TEMPLATES } from '../model/templates'
import type { TimelineSettings, UnitPreset } from '../model/types'
import { uid } from '../model/util'
import { activeView, filtersEqual, isUnfiltered, viewDirty } from '../model/views'
import { exportCSV, exportFullSVG, exportJSON, exportPNG } from './export'
import { exportDocPDF } from './exportDoc'
import { exportScope } from './exportScope'
import { CanvasView } from './Canvas'
import { creatorStamp } from '../sync/client'
import { getClipboard, setClipboard } from './clipboard'
import { ConfirmDialog } from './Confirm'
import { requestDelete } from './deletion'
import { Inspector } from './Inspector'
import { PanelDivider } from './Panels'
import { FieldEditor, LevelEditor, ProcessorEditor } from './SchemaEditors'
import { PresenceBar, ShareModal, TabSyncIcon } from './Share'
import { ApiHelpModal } from './ApiHelp'
import { Sidebar } from './Sidebar'
import { SuggestBar, SuggestModal, exitSuggestSafely } from './Suggest'
import { TypeEditor } from './TypeEditor'
import { nav } from './nav'

export function App() {
  const proj = useActiveProject()
  const ui = useStore(s => s.ui)
  const setUI = useStore(s => s.setUI)
  const store = useStore

  useEffect(() => {
    document.documentElement.dataset.theme = ui.theme
  }, [ui.theme])

  // ---------------- keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable
      const s = store.getState()
      const p = s.active()
      const mod = e.ctrlKey || e.metaKey

      if (e.key === 'Escape') {
        if (s.ui.confirm) setUI({ confirm: null })
        else if (s.ui.pickRef) setUI({ pickRef: null })
        else if (s.ui.overlay) setUI({ overlay: null })
        else if (s.ui.editFieldId) setUI({ editFieldId: null })
        else if (s.ui.editProcessorId) setUI({ editProcessorId: null })
        else if (s.ui.editLevelId) setUI({ editLevelId: null })
        else if (s.ui.editTypeId) setUI({ editTypeId: null })
        else if (s.ui.tool !== 'select') setUI({ tool: 'select' })
        else s.select([])
        ;(t as HTMLElement).blur?.()
        return
      }
      if (typing) return

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) s.redo(); else s.undo()
        return
      }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); s.redo(); return }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        const ids = s.ui.selection.filter(x => !x.includes(':'))
        if (!ids.length) return
        const nids: string[] = []
        s.mutate(pr => {
          for (const id of ids) {
            const src = pr.items.find(i => i.id === id)
            if (!src) continue
            const cp = structuredClone(src)
            cp.id = uid()
            cp.pos += Math.max(0.5, cp.duration)
            cp.createdBy = creatorStamp()
            nids.push(cp.id)
            pr.items.push(cp)
          }
        })
        s.select(nids)
        return
      }
      if (mod && e.key.toLowerCase() === 'c') {
        const ids = s.ui.selection.filter(x => !x.includes(':'))
        setClipboard(p.items.filter(i => ids.includes(i.id)))
        return
      }
      if (mod && e.key.toLowerCase() === 'v') {
        const clipboard = getClipboard()
        if (!clipboard.length) return
        e.preventDefault()
        const base = Math.min(...clipboard.map(i => i.pos))
        const center = p.camera.x + (window.innerWidth * 0.5) / p.camera.s
        const nids: string[] = []
        s.mutate(pr => {
          for (const src of clipboard) {
            const cp = structuredClone(src)
            cp.id = uid()
            cp.pos = center + (src.pos - base)
            cp.pathId = null
            cp.createdBy = creatorStamp()
            nids.push(cp.id)
            pr.items.push(cp)
          }
        })
        s.select(nids)
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        deleteSelection()
        return
      }
      if (e.key === '0') { nav.current?.fitAll(); return }
      if (e.key === '=' || e.key === '+') { nav.current?.zoomBy(1.35); return }
      if (e.key === '-') { nav.current?.zoomBy(0.74); return }
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); nav.current?.back(); return }
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); nav.current?.forward(); return }
      if (e.key === '?') { setUI({ overlay: s.ui.overlay === 'cheatsheet' ? null : 'cheatsheet' }); return }
      if (e.key === '/') {
        e.preventDefault()
        document.querySelector<HTMLInputElement>('.search-input')?.focus()
        return
      }
      if (e.key.toLowerCase() === 'b') { setUI({ tool: s.ui.tool === 'branch' ? 'select' : 'branch' }); return }
      if (e.key.toLowerCase() === 'n') {
        // lastTypeId may belong to another tab (e.g. a freshly joined shared one).
        const type = p.types.find(x => x.id === s.ui.lastTypeId) ?? p.types[0]
        if (!type) return
        const typeId = type.id
        const center = p.camera.x + (window.innerWidth * 0.5) / p.camera.s
        const id = uid()
        s.mutate(pr => pr.items.push({
          id, typeId, layerId: null, pathId: null, pos: center, duration: 0,
          title: type.name, description: '', tags: [], link: '', images: [], fieldValues: {},
          createdBy: creatorStamp(),
        }))
        s.select([id])
        return
      }
      if (/^[1-9]$/.test(e.key)) {
        const idx = Number(e.key) - 1
        const v = p.views[idx]
        if (v) applyView(v.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const deleteSelection = () => {
    const s = store.getState()
    const sel = s.ui.selection
    if (!sel.length) return
    const itemIds = sel.filter(x => !x.includes(':'))
    const branchIds = sel.filter(x => x.startsWith('B:')).map(x => x.slice(2))
    const sectionIds = sel.filter(x => x.startsWith('S:')).map(x => x.slice(2))
    requestDelete({ itemIds, branchIds, sectionIds }, () => {
      s.select([])
      s.showToast('Deleted.', true)
    })
  }

  const applyView = (viewId: string | null) => {
    const s = store.getState()
    s.tweak(p => {
      if (!viewId) { p.filters = emptyFilters(); p.activeViewId = null; return }
      const v = p.views.find(x => x.id === viewId)
      if (!v) return
      p.filters = structuredClone(v.filters)
      p.activeViewId = viewId
    })
  }

  return (
    <div className="app">
      <Toolbar applyView={applyView} />
      <SuggestBar />
      <div className="main">
        <Sidebar />
        {ui.sidebarOpen && <PanelDivider side="left" />}
        <CanvasView />
        {ui.selection.length > 0 && <PanelDivider side="right" />}
        <Inspector />
      </div>
      {ui.editTypeId && <TypeEditor />}
      {ui.editLevelId && <LevelEditor />}
      {ui.editProcessorId && <ProcessorEditor />}
      {ui.editFieldId && <FieldEditor />}
      {ui.overlay === 'templates' && <TemplateModal />}
      {ui.overlay === 'cheatsheet' && <Cheatsheet />}
      {ui.overlay === 'settings' && <SettingsModal />}
      {ui.overlay === 'share' && <ShareModal />}
      {ui.overlay === 'apihelp' && <ApiHelpModal />}
      <ConfirmDialog />
      {ui.overlay === 'suggest' && <SuggestModal />}
      <ToastView />
      <DragGhost />
    </div>
  )
}

// ------------------------------------------------------------------ toolbar

function Toolbar({ applyView }: { applyView: (id: string | null) => void }) {
  const proj = useActiveProject()
  const projects = useStore(s => s.projects)
  const activeId = useStore(s => s.activeId)
  const shares = useStore(s => s.shares)
  const share = useActiveShare()
  const ui = useStore(s => s.ui)
  const setUI = useStore(s => s.setUI)
  const setActive = useStore(s => s.setActive)
  const addProject = useStore(s => s.addProject)
  const closeProject = useStore(s => s.closeProject)
  const renameProject = useStore(s => s.renameProject)
  const importProject = useStore(s => s.importProject)
  const showToast = useStore(s => s.showToast)
  const undo = useStore(s => s.undo)
  const redo = useStore(s => s.redo)
  const mutate = useStore(s => s.mutate)
  const tweak = useStore(s => s.tweak)
  const suggesting = useSuggesting()
  const enterSuggest = useStore(s => s.enterSuggest)
  const [exportOpen, setExportOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  // Every export follows the canvas: filtered-out items are left out, and
  // selected sections narrow it to just those sub-trees.
  const scope = exportScope(proj, ui.selection)
  const scene = { density: ui.density, theme: ui.theme, showFields: ui.showFields, showTitles: ui.showTitles }
  const scopeHint = scope.sections.length
    ? `Only items inside the selected section${scope.sections.length === 1 ? '' : 's'} that are visible on the canvas.`
    : scope.filtered ? 'Items hidden by the current filters are left out.' : 'Everything is visible, so everything is included.'
  const view = activeView(proj)
  const dirty = viewDirty(proj)

  return (
    <>
      <header className="toolbar">
        <div className="brand" title="Timeline Planner">⧗</div>
        <div className="tabs">
          {projects.map(p => (
            <div
              key={p.id}
              className={`tab ${p.id === activeId ? 'on' : ''}`}
              onClick={() => setActive(p.id)}
              onDoubleClick={() => {
                const name = window.prompt('Project name', p.name)
                if (name) renameProject(p.id, name)
              }}
            >
              <TabSyncIcon projectId={p.id} />
              <span>{p.name}</span>
              {projects.length > 1 && (
                <button
                  className="tab-x"
                  onClick={e => {
                    e.stopPropagation()
                    const msg = shares[p.id]
                      ? `Close “${p.name}”? The shared timeline stays online — keep your link to reopen it here.`
                      : `Close and delete “${p.name}”? Export it first if you want to keep it.`
                    if (window.confirm(msg)) closeProject(p.id)
                  }}
                ><X width={11} height={11} /></button>
              )}
            </div>
          ))}
          <button className="ghost-btn" title="New project" onClick={() => setUI({ overlay: 'templates' })}>
            <Plus width={15} height={15} />
          </button>
        </div>
        <PresenceBar />

        <div className="search-box">
          <Search width={13} height={13} />
          <input
            className="search-input"
            placeholder="Filter items…  ( / )"
            value={proj.filters.text}
            onChange={e => tweak(p => { p.filters.text = e.target.value })}
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
          <button className={`ghost-btn ${ui.magnet ? 'on' : ''}`} title="Stick to other items and section edges while dragging (hold Alt to bypass)"
            onClick={() => setUI({ magnet: !ui.magnet })}><Magnet width={15} height={15} /></button>
          <button className={`ghost-btn ${ui.snap ? 'on' : ''}`} title="Snap to grid (hold Alt to bypass)"
            onClick={() => setUI({ snap: !ui.snap })}><Grid3x3 width={15} height={15} /></button>
          <button className={`ghost-btn ${ui.ripple ? 'on' : ''}`}
            title="Linked move — dragging one item moves every other item with it (or hold Shift while dragging)"
            onClick={() => setUI({ ripple: !ui.ripple })}><Link width={15} height={15} /></button>
          <button className={`ghost-btn ${ui.ghostHidden ? 'on' : ''}`} title="Hide filtered items completely (instead of ghosting)"
            onClick={() => setUI({ ghostHidden: !ui.ghostHidden })}>
            {ui.ghostHidden ? <EyeOff width={15} height={15} /> : <Eye width={15} height={15} />}
          </button>
          <button className={`ghost-btn ${ui.showTitles ? 'on' : ''}`} title="Show item titles on the timeline (off packs items closer together)"
            onClick={() => setUI({ showTitles: !ui.showTitles })}><Type width={15} height={15} /></button>
          <button className={`ghost-btn ${ui.showFields ? 'on' : ''}`} title="Show custom field values next to item titles"
            onClick={() => setUI({ showFields: !ui.showFields })}><TableProperties width={15} height={15} /></button>
          <button className={`ghost-btn ${ui.tool === 'branch' ? 'on' : ''}`} title="Branch tool (B) — drag along the line"
            onClick={() => setUI({ tool: ui.tool === 'branch' ? 'select' : 'branch' })}>
            <GitBranch width={15} height={15} />
          </button>
          <span className="sep" />
          <button className="ghost-btn" title="Zoom out (-)" onClick={() => nav.current?.zoomBy(0.74)}><Minus width={15} height={15} /></button>
          <button className="ghost-btn" title="Zoom in (+)" onClick={() => nav.current?.zoomBy(1.35)}><ZoomIn width={15} height={15} /></button>
          <button className="ghost-btn" title="Fit everything (0)" onClick={() => nav.current?.fitAll()}><Maximize2 width={15} height={15} /></button>
          <span className="sep" />
          <button className="ghost-btn" title="Undo (Ctrl+Z)" onClick={undo}><Undo2 width={15} height={15} /></button>
          <button className="ghost-btn" title="Redo (Ctrl+Shift+Z)" onClick={redo}><Redo2 width={15} height={15} /></button>
          <span className="sep" />
          <button className={`ghost-btn ${ui.soundOn ? 'on' : ''}`} title="Sound"
            onClick={() => setUI({ soundOn: !ui.soundOn })}>
            {ui.soundOn ? <Volume2 width={15} height={15} /> : <VolumeX width={15} height={15} />}
          </button>
          <button className="ghost-btn" title="Theme"
            onClick={() => setUI({ theme: ui.theme === 'dark' ? 'light' : 'dark' })}>
            {ui.theme === 'dark' ? <Sun width={15} height={15} /> : <Moon width={15} height={15} />}
          </button>
          {share?.role === 'edit' && (
            <button
              className={`ghost-btn ${suggesting ? 'on suggest' : ''}`}
              title={suggesting ? 'Suggest mode is on — exit to edit directly' : 'Suggest mode — collect edits into a suggestion for review instead of changing the timeline'}
              onClick={() => { if (suggesting) exitSuggestSafely(proj.id); else enterSuggest(proj.id) }}
            ><Lightbulb width={15} height={15} /></button>
          )}
          <button className={`ghost-btn ${share ? 'on' : ''}`} title={share ? 'Sharing — links, people, status' : 'Share this timeline…'}
            onClick={() => setUI({ overlay: 'share' })}>
            <Share2 width={15} height={15} />
          </button>
          <div className="export-wrap">
            <button className="ghost-btn" title="Export / import" onClick={() => setExportOpen(v => !v)}>
              <Download width={15} height={15} />
            </button>
            {exportOpen && (
              <div className="menu export-menu" onPointerLeave={() => setExportOpen(false)}>
                <button title="The complete project, for backups and re-import — never filtered." onClick={() => { exportJSON(proj); setExportOpen(false) }}>
                  <Download width={13} height={13} /> Project JSON <span className="muted">(everything)</span>
                </button>
                <div className="menu-hint">{scopeHint}</div>
                <button title={`The timeline as it is on screen now. ${scopeHint}`}
                  onClick={() => { exportPNG(proj, scope, window.innerWidth, window.innerHeight - 90, scene); setExportOpen(false) }}>
                  <Download width={13} height={13} /> {scope.describe('PNG', 'current view')}
                </button>
                <button title={`${scope.sections.length ? 'Framed on the selected sections.' : 'The whole timeline, end to end.'} ${scopeHint}`}
                  onClick={() => { exportFullSVG(proj, scope, scene); setExportOpen(false) }}>
                  <Download width={13} height={13} /> {scope.describe('SVG', 'full timeline')}
                </button>
                <button title={`One row per item, in timeline order. ${scopeHint}`} onClick={() => { exportCSV(proj, scope); setExportOpen(false) }}>
                  <Download width={13} height={13} /> {scope.describe('CSV', 'all items')}
                </button>
                <button
                  title={`Sections become headings, items sub-headings with their type and icon. ${scopeHint} Opens the print dialog — choose “Save as PDF”.`}
                  onClick={() => {
                    if (!exportDocPDF(proj, scope.sectionIds)) {
                      showToast('Pop-up blocked — allow pop-ups for this site to export the document.')
                    }
                    setExportOpen(false)
                  }}
                >
                  <FileText width={13} height={13} /> {scope.describe('Document PDF')}
                </button>
                <button onClick={() => { fileRef.current?.click(); setExportOpen(false) }}>
                  <Upload width={13} height={13} /> Import JSON…
                </button>
              </div>
            )}
            <input
              ref={fileRef} type="file" accept=".json,application/json" hidden
              onChange={async e => {
                const f = e.target.files?.[0]
                if (!f) return
                const err = importProject(await f.text())
                if (err) showToast(err)
                e.target.value = ''
              }}
            />
          </div>
          <button className="ghost-btn" title="Timeline settings" onClick={() => setUI({ overlay: 'settings' })}>
            <Settings2 width={15} height={15} />
          </button>
          <button className="ghost-btn" title="Shortcuts (?)" onClick={() => setUI({ overlay: 'cheatsheet' })}>
            <HelpCircle width={15} height={15} />
          </button>
        </div>
      </header>

      <div className="viewbar">
        <button className={`view-chip ${!view && isUnfiltered(proj.filters) ? 'on' : ''}`} onClick={() => applyView(null)}>
          All
        </button>
        {proj.views.map((v, i) => {
          const on = proj.activeViewId === v.id
          return (
            <button
              key={v.id}
              className={`view-chip ${on ? 'on' : ''} ${on && dirty ? 'dirty' : ''}`}
              title={on && dirty ? 'Filters changed since this view was applied — click to go back to the saved view' : 'Apply this view · double-click to rename'}
              onClick={() => applyView(v.id)}
              onDoubleClick={() => {
                const name = window.prompt('View name', v.name)
                if (name && name !== v.name) mutate(p => { const x = p.views.find(y => y.id === v.id); if (x) x.name = name })
              }}
            >
              <span className="view-num">{i + 1}</span>{v.name}
              {on && dirty && <span className="view-dot" title="modified" />}
              <span
                className="tab-x"
                title="Delete view"
                onClick={e => { e.stopPropagation(); mutate(p => { p.views = p.views.filter(x => x.id !== v.id); if (p.activeViewId === v.id) p.activeViewId = null }) }}
              ><X width={10} height={10} /></span>
            </button>
          )
        })}
        {view && dirty && (
          <>
            <button
              className="view-chip act"
              title={`Overwrite “${view.name}” with the current filters`}
              onClick={() => mutate(p => { const x = p.views.find(y => y.id === view.id); if (x) x.filters = structuredClone(p.filters) })}
            ><Save width={12} height={12} /> Update “{view.name}”</button>
            <button className="view-chip act" title="Discard the changes and go back to the saved view" onClick={() => applyView(view.id)}>
              <RotateCcw width={12} height={12} /> Revert
            </button>
          </>
        )}
        {view && !dirty && (
          <button
            className="ghost-btn view-edit"
            title="Rename this view"
            onClick={() => {
              const name = window.prompt('View name', view.name)
              if (name && name !== view.name) mutate(p => { const x = p.views.find(y => y.id === view.id); if (x) x.name = name })
            }}
          ><Pencil width={12} height={12} /></button>
        )}
        <button
          className="view-chip save"
          title={view && dirty ? 'Save the current filters as a new view (keeps the old one as it was)' : 'Save current filters as a view'}
          onClick={() => {
            const same = proj.views.find(v => filtersEqual(v.filters, proj.filters))
            const name = window.prompt('View name', same && !dirty ? `${same.name} copy` : 'New view')
            if (!name) return
            const id = uid()
            mutate(p => { p.views.push({ id, name, filters: structuredClone(p.filters) }); p.activeViewId = id })
          }}
        >+ {view && dirty ? 'Save as new view' : 'Save view'}</button>
      </div>
    </>
  )
}

// ------------------------------------------------------------------ overlays

function TemplateModal() {
  const setUI = useStore(s => s.setUI)
  const addProject = useStore(s => s.addProject)
  const projects = useStore(s => s.projects)
  const activeId = useStore(s => s.activeId)

  const choose = (key: string) => {
    const tpl = TEMPLATES.find(t => t.key === key)!
    const p = tpl.make()
    const cur = projects.find(x => x.id === activeId)
    const curEmpty = cur && cur.items.length === 0 && cur.sections.length === 0 && cur.name === 'Untitled'
    if (curEmpty && projects.length === 1) {
      useStore.setState(s => ({
        projects: [p],
        activeId: p.id,
        ui: { ...s.ui, overlay: null, selection: [], lastTypeId: p.types[0]?.id ?? null },
      }))
    } else {
      addProject(p)
    }
    setUI({ overlay: null })
  }

  return (
    <div className="modal-scrim" onPointerDown={e => { if (e.target === e.currentTarget) setUI({ overlay: null }) }}>
      <div className="modal templates">
        <h2>New timeline</h2>
        <p className="muted">Pick a starting point — everything in it is editable.</p>
        <div className="tpl-grid">
          {TEMPLATES.map(t => (
            <button key={t.key} className="tpl-card" onClick={() => choose(t.key)}>
              <strong>{t.name}</strong>
              <span>{t.blurb}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

const UNIT_PRESETS: { key: UnitPreset; label: string }[] = [
  { key: 'none', label: 'None (plain numbers)' },
  { key: 'minutes', label: 'Minutes' },
  { key: 'hours', label: 'Hours' },
  { key: 'days', label: 'Days' },
  { key: 'weeks', label: 'Weeks' },
  { key: 'months', label: 'Months' },
  { key: 'years', label: 'Years' },
  { key: 'custom', label: 'Custom unit…' },
]

function SettingsModal() {
  const proj = useActiveProject()
  const setUI = useStore(s => s.setUI)
  const tweak = useStore(s => s.tweak)
  const st = proj.settings

  const patch = (recipe: (s: TimelineSettings) => void) => tweak(p => recipe(p.settings))

  return (
    <div className="modal-scrim" onPointerDown={e => { if (e.target === e.currentTarget) setUI({ overlay: null }) }}>
      <div className="modal settings">
        <div className="modal-head"><strong>Timeline settings</strong>
          <span className="grow" />
          <button className="ghost-btn" onClick={() => setUI({ overlay: null })}><X width={16} height={16} /></button>
        </div>
        <p className="muted">These apply to this project and are saved with it.</p>

        <div className="field">
          <label>Marker placement</label>
          <div className="seg">
            <button className={st.placement === 'above' ? 'on' : ''} onClick={() => patch(s => { s.placement = 'above' })}>
              Above the line
            </button>
            <button className={st.placement === 'both' ? 'on' : ''} onClick={() => patch(s => { s.placement = 'both' })}>
              Both sides (compact)
            </button>
          </div>
        </div>

        <div className="field">
          <label>Time units</label>
          <div className="row gap">
            <select
              className="input"
              value={st.unit.preset}
              onChange={e => patch(s => { s.unit.preset = e.target.value as UnitPreset })}
            >
              {UNIT_PRESETS.map(u => <option key={u.key} value={u.key}>{u.label}</option>)}
            </select>
            {st.unit.preset === 'custom' && (
              <input
                className="input" placeholder="unit, e.g. beats"
                value={st.unit.custom}
                onChange={e => patch(s => { s.unit.custom = e.target.value })}
              />
            )}
          </div>
          <label className="check-row">
            <input
              type="checkbox" checked={st.unit.showRuler}
              onChange={e => patch(s => { s.unit.showRuler = e.target.checked })}
            />
            Show unit ruler along the timeline
          </label>
        </div>

        <div className="field">
          <label>Background grid</label>
          <label className="check-row">
            <input
              type="checkbox" checked={st.grid.show}
              onChange={e => patch(s => { s.grid.show = e.target.checked })}
            />
            Show vertical grid lines
          </label>
          {st.grid.show && (
            <>
              <div className="seg">
                {(['solid', 'dashed', 'dots'] as const).map(style => (
                  <button key={style} className={st.grid.style === style ? 'on' : ''}
                    onClick={() => patch(s => { s.grid.style = style })}>{style}</button>
                ))}
              </div>
              <label className="slider-row">
                <span>Intensity</span>
                <input
                  type="range" min={0.05} max={1} step={0.05} value={st.grid.opacity}
                  onChange={e => patch(s => { s.grid.opacity = Number(e.target.value) })}
                />
              </label>
            </>
          )}
        </div>

        <div className="field">
          <label>Timeline line</label>
          <label className="slider-row">
            <span>Thickness</span>
            <input
              type="range" min={1} max={6} step={0.5} value={st.spine.width}
              onChange={e => patch(s => { s.spine.width = Number(e.target.value) })}
            />
          </label>
          <label className="slider-row">
            <span>Opacity</span>
            <input
              type="range" min={0.15} max={1} step={0.05} value={st.spine.opacity}
              onChange={e => patch(s => { s.spine.opacity = Number(e.target.value) })}
            />
          </label>
        </div>

        <div className="field">
          <label>Section bands</label>
          <label className="slider-row">
            <span>Tint strength</span>
            <input
              type="range" min={0} max={2.5} step={0.1} value={st.bandStrength}
              onChange={e => patch(s => { s.bandStrength = Number(e.target.value) })}
            />
          </label>
          <label className="slider-row">
            <span>Top label size</span>
            <input
              type="range" min={10} max={22} step={1} value={st.sectionStyle.labelSize}
              onChange={e => patch(s => { s.sectionStyle.labelSize = Number(e.target.value) })}
            />
          </label>
          <label className="slider-row">
            <span>Border strength</span>
            <input
              type="range" min={0} max={1} step={0.05} value={st.sectionStyle.edgeStrength}
              onChange={e => patch(s => { s.sectionStyle.edgeStrength = Number(e.target.value) })}
            />
          </label>
          <label className="check-row">
            <input
              type="checkbox" checked={st.sectionStyle.showDuration}
              onChange={e => patch(s => { s.sectionStyle.showDuration = e.target.checked })}
            />
            Show section durations (faint, after the name)
          </label>
          <p className="muted" style={{ margin: '4px 0 0', fontSize: 11 }}>
            Top-level sections render biggest and strongest; each nesting level shrinks and fades.
            Nesting is automatic: a section inside another becomes its child.
          </p>
        </div>
      </div>
    </div>
  )
}

function Cheatsheet() {
  const setUI = useStore(s => s.setUI)
  const rows: [string, string][] = [
    ['Drag type from sidebar', 'Create an item on the line (or on a branch path)'],
    ['Double-click the line', 'Quick-create an item of the last-used type'],
    ['N', 'New item at the view center'],
    ['Space', 'Search for a type and add an item under the cursor'],
    ['Drag item', 'Move (Alt = no snap · Alt at start = clone)'],
    ['Shift+drag item', 'Move ALL items together (or toggle the link button)'],
    ['Drag span edge circles', 'Stretch an item into a span'],
    ['Drag a section edge', 'Resize — contents rescale with it (Shift = leave them in place)'],
    ['Drag a section label', 'Move the section, its items, and all selected sections'],
    ['Edge-drag multi-selected sections', 'Scale the group + contents (Shift = sections only)'],
    ['Drag empty space', 'Marquee multi-select (items and section labels)'],
    ['Shift+click item', 'Add to selection'],
    ['Right-click', 'Context menu (items or empty space)'],
    ['B, then drag on the line', 'Create a branch (fork → join)'],
    ['Drag dot on the line', 'Move every item stacked at that position'],
    ['Drag section header bar', 'Move the section (Alt = duplicate it)'],
    ['Right-click a section', 'Split it at that spot'],
    ['Click type in sidebar', 'Toggle its visibility · Alt-click = solo'],
    ['Wheel / pinch', 'Zoom toward cursor'],
    ['Right-drag / middle-drag', 'Pan'],
    ['0 / + / −', 'Fit all · zoom in · zoom out'],
    ['1–9', 'Switch saved views'],
    ['/', 'Focus the filter box (Enter jumps to first match)'],
    ['Alt+← / Alt+→', 'Camera back / forward'],
    ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo (everything)'],
    ['Ctrl+C / V / D', 'Copy · paste at view center · duplicate'],
    ['Delete', 'Delete selection'],
    ['Drag the panel edges', 'Resize the sidebar / inspector (double-click to reset)'],
    ['Esc', 'Deselect · close panels · cancel tool'],
  ]
  return (
    <div className="modal-scrim" onPointerDown={e => { if (e.target === e.currentTarget) setUI({ overlay: null }) }}>
      <div className="modal cheatsheet">
        <div className="modal-head"><strong>Shortcuts</strong>
          <span className="grow" />
          <button className="ghost-btn" onClick={() => setUI({ overlay: null })}><X width={16} height={16} /></button>
        </div>
        <table>
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}><td className="key">{k}</td><td>{v}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ToastView() {
  const toast = useStore(s => s.ui.toast)
  const setUI = useStore(s => s.setUI)
  const undo = useStore(s => s.undo)
  if (!toast) return null
  return (
    <div className="toast">
      <span>{toast.msg}</span>
      {toast.undo && (
        <button className="link-btn" onClick={() => { undo(); setUI({ toast: null }) }}>Undo</button>
      )}
      <button className="ghost-btn" onClick={() => setUI({ toast: null })}><X width={12} height={12} /></button>
    </div>
  )
}

function DragGhost() {
  const proj = useActiveProject()
  const dragTypeId = useStore(s => s.ui.dragTypeId)
  const dragFolderId = useStore(s => s.ui.dragFolderId)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const active = dragTypeId ?? dragFolderId
  useEffect(() => {
    if (!active) { setPos(null); return }
    const onMove = (e: PointerEvent) => setPos({ x: e.clientX, y: e.clientY })
    window.addEventListener('pointermove', onMove)
    return () => window.removeEventListener('pointermove', onMove)
  }, [active])
  if (!active || !pos) return null
  const what = dragTypeId
    ? proj.types.find(t => t.id === dragTypeId)
    : proj.typeFolders.find(f => f.id === dragFolderId)
  if (!what) return null
  const Icon = iconByName(what.icon)
  return (
    <div className="drag-ghost" style={{ left: pos.x + 10, top: pos.y + 8, borderColor: what.color, color: what.color }}>
      <Icon width={14} height={14} /> {what.name}
    </div>
  )
}
