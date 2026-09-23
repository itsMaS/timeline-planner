import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { useStore } from './model/store'
import { bootSync, openShared, parseShareRoute, startSync } from './sync/share'
import { App } from './ui/App'
import { Viewer } from './ui/Viewer'
import './styles.css'

// Handy for debugging and automated checks.
;(window as unknown as { tp: typeof useStore }).tp = useStore

const route = parseShareRoute()
const token = route?.token ?? null
bootSync({ startExisting: !token })

/** A link's `/<timelineId>` suffix opens that timeline (when the project still has it). */
function openLinkedTimeline(projectId: string) {
  const st = useStore.getState()
  const tid = route?.timelineId
  if (!tid) return
  const proj = st.projects.find(p => p.id === projectId)
  if (proj?.timelines.some(t => t.id === tid)) {
    if (st.drafts[projectId]) st.enterSuggest(projectId)
    st.setActiveTimeline(tid)
  }
}

function Root() {
  const [mode, setMode] = useState<'boot' | 'app' | 'viewer' | { error: string }>(token ? 'boot' : 'app')

  useEffect(() => {
    if (!token) return
    let cancelled = false
    ;(async () => {
      try {
        const { project, info } = await openShared(token)
        if (cancelled) return
        const st = useStore.getState()
        if (info.role === 'view') {
          st.openViewer(project, info)
          openLinkedTimeline(project.id)
          void startSync(project.id)
          setMode('viewer')
          return
        }
        // Edit link: reuse the tab if this timeline is already open here, else add a persistent tab.
        const existing = Object.entries(st.shares).find(([pid, s]) => s.id === info.id && st.projects.some(p => p.id === pid))?.[0]
        if (existing) {
          st.setActive(existing)
        } else {
          st.addProject(project)
          st.setShare(project.id, info)
        }
        // A suggest link is always in suggest mode: edits become proposals.
        if (info.role === 'suggest') st.enterSuggest(existing ?? project.id)
        openLinkedTimeline(existing ?? project.id)
        history.replaceState(null, '', `${location.pathname}${location.search}`)
        bootSync({ startExisting: true })
        void startSync(existing ?? project.id)
        setMode('app')
      } catch (e) {
        if (!cancelled) setMode({ error: (e as Error).message })
      }
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = useStore.getState().ui.theme
  }, [])

  if (mode === 'app') return <App />
  if (mode === 'viewer') return <Viewer />
  return (
    <div className="boot">
      {mode === 'boot' ? (
        <p className="muted">Opening shared timeline…</p>
      ) : (
        <>
          <p>{mode.error}</p>
          <p className="muted">Ask the owner for a fresh link, or <a href={`${location.pathname}${location.search}`}>open Timeline Planner</a>.</p>
        </>
      )}
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
)
