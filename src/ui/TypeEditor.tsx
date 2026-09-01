import { useState } from 'react'
import { Trash2, X } from 'lucide-react'
import { iconByName } from '../model/icons'
import { useActiveProject, useStore } from '../model/store'
import type { ItemType } from '../model/types'
import { PALETTE, uid } from '../model/util'
import { IconPicker } from './IconPicker'

export function TypeEditor() {
  const proj = useActiveProject()
  const ui = useStore(s => s.ui)
  const setUI = useStore(s => s.setUI)
  const mutate = useStore(s => s.mutate)
  const showToast = useStore(s => s.showToast)
  const [pickingIcon, setPickingIcon] = useState(false)

  const type = proj.types.find(t => t.id === ui.editTypeId)
  if (!type) return null
  const Icon = iconByName(type.icon)
  const edit = (recipe: (t: ItemType) => void) =>
    mutate(p => {
      const t = p.types.find(x => x.id === type.id)
      if (t) recipe(t)
    })

  const close = () => setUI({ editTypeId: null })

  return (
    <div className="modal-scrim" onPointerDown={e => { if (e.target === e.currentTarget) close() }}>
      <div className="modal type-editor">
        <div className="modal-head">
          <span className="tt-dot" style={{ background: type.color }} />
          <input
            className="input title-input"
            value={type.name}
            onChange={e => edit(t => { t.name = e.target.value })}
          />
          <button className="ghost-btn" onClick={close}><X width={16} height={16} /></button>
        </div>

        <div className="row gap">
          <div className="field">
            <label>Icon</label>
            <button className="icon-btn big" style={{ color: type.color }} onClick={() => setPickingIcon(v => !v)}>
              <Icon width={22} height={22} />
            </button>
          </div>
          <div className="field grow">
            <label>Color</label>
            <div className="palette">
              {PALETTE.map(c => (
                <button
                  key={c}
                  className={`swatch ${type.color === c ? 'on' : ''}`}
                  style={{ background: c }}
                  onClick={() => edit(t => { t.color = c })}
                />
              ))}
              <input
                type="color"
                value={type.color}
                onChange={e => edit(t => { t.color = e.target.value })}
                title="Custom color"
              />
            </div>
          </div>
        </div>

        {pickingIcon && (
          <IconPicker value={type.icon} onPick={n => { edit(t => { t.icon = n }); setPickingIcon(false) }} />
        )}

        <div className="field">
          <label>Default layer</label>
          <select
            className="input"
            value={type.defaultLayerId ?? ''}
            onChange={e => edit(t => { t.defaultLayerId = e.target.value || null })}
          >
            <option value="">(none)</option>
            {proj.layers.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>

        <div className="field">
          <label>Custom fields</label>
          {type.fields.map(f => (
            <div key={f.id} className="row gap">
              <input
                className="input grow"
                value={f.name}
                onChange={e => edit(t => {
                  const fd = t.fields.find(x => x.id === f.id)
                  if (fd) fd.name = e.target.value
                })}
              />
              <button className="ghost-btn" onClick={() => edit(t => { t.fields = t.fields.filter(x => x.id !== f.id) })}>
                <Trash2 width={14} height={14} />
              </button>
            </div>
          ))}
          <button className="ghost-btn add" onClick={() => edit(t => t.fields.push({ id: uid(), name: 'New field' }))}>
            + Add field
          </button>
        </div>

        <div className="modal-foot">
          <button
            className="danger-btn"
            onClick={() => {
              const others = proj.types.filter(t => t.id !== type.id)
              if (!others.length) { showToast('A project needs at least one type.'); return }
              const count = proj.items.filter(i => i.typeId === type.id).length
              mutate(p => {
                p.types = p.types.filter(t => t.id !== type.id)
                for (const it of p.items) if (it.typeId === type.id) it.typeId = others[0].id
                p.filters.offTypes = p.filters.offTypes.filter(id => id !== type.id)
              })
              if (count) showToast(`Deleted type — ${count} item(s) moved to “${others[0].name}”.`)
              close()
            }}
          >
            <Trash2 width={14} height={14} /> Delete type
          </button>
        </div>
      </div>
    </div>
  )
}
