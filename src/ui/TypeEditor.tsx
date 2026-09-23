import { useState } from 'react'
import { Settings2, Trash2, X } from 'lucide-react'
import { formatValue, kindGlyph, kindLabel, typeAttachments } from '../model/fields'
import { folderTree } from '../model/folders'
import { iconByName } from '../model/icons'
import { useActiveProject, useStore } from '../model/store'
import type { ItemType } from '../model/types'
import { PALETTE } from '../model/util'
import { IconPicker } from './IconPicker'
import { Select } from './Select'
import { FieldAttachList } from './SchemaEditors'

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
  const inherited = typeAttachments(proj, type).filter(a => a.from && !a.group)

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
          <Select
            value={type.defaultLayerId ?? ''}
            options={[{ value: '', label: '(none)' }, ...proj.layers.map(l => ({ value: l.id, label: l.name }))]}
            searchPlaceholder="Search layers…"
            onChange={v => edit(t => { t.defaultLayerId = v || null })}
          />
        </div>

        {proj.typeFolders.length > 0 && (
          <div className="field">
            <label>Folder</label>
            <Select
              value={type.folderId ?? ''}
              options={[
                { value: '', label: '(none)' },
                ...folderTree(proj).map(({ folder, depth }) => ({ value: folder.id, label: folder.name, depth })),
              ]}
              searchPlaceholder="Search folders…"
              onChange={v => edit(t => { t.folderId = v || null })}
            />
          </div>
        )}

        {inherited.length > 0 && (
          <div className="field">
            <label>Inherited fields <span className="muted">(from the type's folders · edit there)</span></label>
            <div className="attach-list">
              {inherited.map(({ att, field, from }) => (
                <div key={field.id} className="attach-row inherited">
                  <span className="kind-glyph" title={kindLabel(field.kind)}>{kindGlyph(field.kind)}</span>
                  <span className="attach-name" title={field.name}>{field.name}</span>
                  <span className="attach-sub muted">
                    from {from!.name}{att.defaultValue !== null ? ` · default ${formatValue(proj, field, att.defaultValue)}` : ''}
                  </span>
                  <button className="ghost-btn" title="Field settings" onClick={() => setUI({ editFieldId: field.id })}><Settings2 width={13} height={13} /></button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="field">
          <label>{inherited.length ? 'Own fields' : 'Fields'}</label>
          <FieldAttachList list={type.fields} onChange={list => edit(t => { t.fields = list })} />
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
