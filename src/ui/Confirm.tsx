import { useEffect } from 'react'
import { useStore } from '../model/store'

/** Modal confirmation driven by `ui.confirm` (see `ConfirmRequest`). */
export function ConfirmDialog() {
  const req = useStore(s => s.ui.confirm)
  const setUI = useStore(s => s.setUI)
  useEffect(() => {
    if (!req) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); setUI({ confirm: null }); req.onOk() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [req])
  if (!req) return null
  const close = () => setUI({ confirm: null })
  const list = req.list ?? []
  const shown = list.slice(0, 14)
  return (
    <div className="modal-scrim confirm-scrim" onPointerDown={e => { if (e.target === e.currentTarget) close() }}>
      <div className="modal confirm">
        <h2>{req.title}</h2>
        <p>{req.message}</p>
        {shown.length > 0 && (
          <ul className="confirm-list">
            {shown.map((s, i) => <li key={i}>{s}</li>)}
            {list.length > shown.length && <li className="muted">…and {list.length - shown.length} more</li>}
          </ul>
        )}
        <div className="modal-foot gap">
          <button className="ghost-btn add" onClick={close}>Cancel</button>
          <button
            className={req.danger === false ? 'primary-btn' : 'danger-btn'}
            autoFocus
            onClick={() => { close(); req.onOk() }}
          >{req.okLabel ?? 'OK'}</button>
        </div>
      </div>
    </div>
  )
}
