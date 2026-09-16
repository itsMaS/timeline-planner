import React, { useMemo, useState } from 'react'
import { Settings2, Trash2, X } from 'lucide-react'
import {
  attachedToNames, changeFieldKind, conversionLoss, FIELD_KINDS, fieldUsage, isNumberKind, kindGlyph, kindLabel,
  newFieldDef, removeField, removeProcessor, targetOptions,
} from '../model/fields'
import { iconByName } from '../model/icons'
import { opLabel, PROCESSOR_OPS, processorUsage } from '../model/processors'
import { useActiveProject, useStore } from '../model/store'
import type { FieldAttachment, FieldDef, FieldKind, HierarchyLevel, Id, ProcessorAttachment, ProcessorDef, ProcessorOp } from '../model/types'
import { uid } from '../model/util'
import { FieldValueInput } from './FieldInputs'

// ------------------------------------------------------------------ small controls

function NullableNumber(props: { value: number | null; onChange: (v: number | null) => void; placeholder?: string; step?: number | 'any'; min?: number }) {
  return (
    <input
      className="input sm"
      type="number"
      step={props.step ?? 'any'}
      min={props.min}
      value={props.value ?? ''}
      placeholder={props.placeholder ?? 'none'}
      onChange={e => {
        const t = e.target.value
        props.onChange(t === '' ? null : Number(t))
      }}
    />
  )
}

/** Checkbox list of item types + hierarchy levels. */
export function TargetPicker(props: { value: Id[]; onChange: (ids: Id[]) => void; emptyLabel: string }) {
  const proj = useActiveProject()
  const opts = targetOptions(proj)
  const set = new Set(props.value)
  const toggle = (id: Id) => {
    if (set.has(id)) set.delete(id); else set.add(id)
    props.onChange(opts.filter(o => set.has(o.id)).map(o => o.id))
  }
  return (
    <div className="target-picker">
      <div className="sb-hint">{props.value.length ? `${props.value.length} selected` : props.emptyLabel}</div>
      <div className="target-grid">
        {opts.map(o => {
          const Icon = iconByName(o.icon)
          return (
            <label key={o.id} className={`check-row ${set.has(o.id) ? 'on' : ''}`}>
              <input type="checkbox" checked={set.has(o.id)} onChange={() => toggle(o.id)} />
              <Icon width={12} height={12} color={o.color} strokeWidth={2} />
              <span className="grow">{o.name}</span>
              {o.kind === 'level' && <span className="muted">level</span>}
            </label>
          )
        })}
      </div>
    </div>
  )
}

/** Search-or-create combobox used to attach fields / processors. */
function AddCombo<T extends { id: Id; name: string }>(props: {
  placeholder: string
  options: T[]
  render: (o: T) => React.ReactNode
  onPick: (o: T) => void
  onCreate: (name: string) => void
  createLabel: string
}) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const needle = q.trim().toLowerCase()
  const matches = props.options.filter(o => !needle || o.name.toLowerCase().includes(needle)).slice(0, 30)
  const exact = props.options.some(o => o.name.trim().toLowerCase() === needle)
  return (
    <div className="add-combo">
      <input
        className="input sm"
        value={q}
        placeholder={props.placeholder}
        onChange={e => { setQ(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (matches.length && (exact || !needle)) props.onPick(matches[0])
            else if (needle) props.onCreate(q.trim())
            setQ(''); setOpen(false)
          }
          if (e.key === 'Escape') { setOpen(false); (e.target as HTMLInputElement).blur() }
        }}
      />
      {open && (
        <div className="ref-menu">
          {matches.map(o => (
            <div key={o.id} className="ref-row" onPointerDown={e => { e.preventDefault(); props.onPick(o); setQ(''); setOpen(false) }}>
              {props.render(o)}
            </div>
          ))}
          {needle && !exact && (
            <div className="ref-row create" onPointerDown={e => { e.preventDefault(); props.onCreate(q.trim()); setQ(''); setOpen(false) }}>
              + {props.createLabel} “{q.trim()}”
            </div>
          )}
          {!needle && !matches.length && <div className="sb-hint">type a name to create one</div>}
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ attachment lists

/** Fields attached to a type or level, each with its own default; add existing or create new. */
export function FieldAttachList(props: { list: FieldAttachment[]; onChange: (list: FieldAttachment[]) => void }) {
  const proj = useActiveProject()
  const mutate = useStore(s => s.mutate)
  const setUI = useStore(s => s.setUI)
  const { list } = props
  const available = proj.fields.filter(f => !list.some(a => a.fieldId === f.id))
  const setAtt = (fieldId: Id, recipe: (a: FieldAttachment) => void) =>
    props.onChange(list.map(a => { if (a.fieldId !== fieldId) return a; const c = { ...a }; recipe(c); return c }))
  return (
    <div className="attach-list">
      {list.map(att => {
        const f = proj.fields.find(x => x.id === att.fieldId)
        if (!f) return null
        return (
          <div key={att.fieldId} className="attach-row">
            <span className="kind-glyph" title={kindLabel(f.kind)}>{kindGlyph(f.kind)}</span>
            <span className="attach-name" title={f.name}>{f.name}</span>
            <div className="attach-default">
              <FieldValueInput
                field={f} att={att} value={att.defaultValue} asDefault compact
                onChange={v => setAtt(att.fieldId, a => { a.defaultValue = v })}
              />
            </div>
            <button className="ghost-btn" title="Field settings" onClick={() => setUI({ editFieldId: f.id })}><Settings2 width={13} height={13} /></button>
            <button className="ghost-btn danger" title="Detach (values stay on the field)" onClick={() => props.onChange(list.filter(a => a.fieldId !== att.fieldId))}>
              <X width={13} height={13} />
            </button>
          </div>
        )
      })}
      {list.length === 0 && <div className="sb-hint">no fields yet</div>}
      <AddCombo
        placeholder={available.length ? 'Add field — search or type a new name…' : 'Type a name to create a field…'}
        options={available}
        render={f => (<><span className="kind-glyph">{kindGlyph(f.kind)}</span><span className="grow">{f.name}</span><span className="muted">{attachedToNames(proj, f.id).join(', ')}</span></>)}
        onPick={f => props.onChange([...list, { fieldId: f.id, defaultValue: null }])}
        createLabel="Create field"
        onCreate={name => {
          const id = uid()
          mutate(p => p.fields.push(newFieldDef(id, name)))
          props.onChange([...list, { fieldId: id, defaultValue: null }])
          setUI({ editFieldId: id })
        }}
      />
      <div className="sb-hint">defaults here override the field's own default · items stay editable</div>
    </div>
  )
}

/** Processors attached to a hierarchy level. */
export function ProcessorAttachList(props: { list: ProcessorAttachment[]; onChange: (list: ProcessorAttachment[]) => void }) {
  const proj = useActiveProject()
  const mutate = useStore(s => s.mutate)
  const setUI = useStore(s => s.setUI)
  const { list } = props
  const available = proj.processors.filter(f => !list.some(a => a.processorId === f.id))
  return (
    <div className="attach-list">
      {list.map(att => {
        const pr = proj.processors.find(x => x.id === att.processorId)
        if (!pr) return null
        return (
          <div key={att.processorId} className="attach-row">
            <span className="kind-glyph" title={opLabel(pr.op)}>Σ</span>
            <span className="attach-name" title={pr.name}>{pr.name}</span>
            <span className="muted attach-sub">{describeProcessor(proj.fields, pr)}</span>
            <label className="check-row tight" title="Append the result to the section label on the canvas">
              <input
                type="checkbox" checked={att.showOnBand}
                onChange={e => props.onChange(list.map(a => (a.processorId === att.processorId ? { ...a, showOnBand: e.target.checked } : a)))}
              />
              band
            </label>
            <button className="ghost-btn" title="Processor settings" onClick={() => setUI({ editProcessorId: pr.id })}><Settings2 width={13} height={13} /></button>
            <button className="ghost-btn danger" title="Detach" onClick={() => props.onChange(list.filter(a => a.processorId !== att.processorId))}>
              <X width={13} height={13} />
            </button>
          </div>
        )
      })}
      {list.length === 0 && <div className="sb-hint">no processors yet</div>}
      <AddCombo
        placeholder={available.length ? 'Add processor — search or type a new name…' : 'Type a name to create a processor…'}
        options={available}
        render={pr => (<><span className="kind-glyph">Σ</span><span className="grow">{pr.name}</span><span className="muted">{describeProcessor(proj.fields, pr)}</span></>)}
        onPick={pr => props.onChange([...list, { processorId: pr.id, showOnBand: false }])}
        createLabel="Create processor"
        onCreate={name => {
          const id = uid()
          mutate(p => p.processors.push({ id, name, op: 'count', fieldId: null, targets: [] }))
          props.onChange([...list, { processorId: id, showOnBand: true }])
          setUI({ editProcessorId: id })
        }}
      />
    </div>
  )
}

export function describeProcessor(fields: FieldDef[], pr: ProcessorDef): string {
  const f = fields.find(x => x.id === pr.fieldId)
  const spec = PROCESSOR_OPS.find(o => o.op === pr.op)
  if (spec?.needsField === 'none') return 'count'
  return `${opLabel(pr.op).toLowerCase()} of ${f?.name ?? '?'}`
}

// ------------------------------------------------------------------ modal shell

function Modal(props: { title: React.ReactNode; onClose: () => void; children: React.ReactNode; className?: string; foot?: React.ReactNode }) {
  return (
    <div className="modal-scrim" onPointerDown={e => { if (e.target === e.currentTarget) props.onClose() }}>
      <div className={`modal ${props.className ?? ''}`}>
        <div className="modal-head">
          {props.title}
          <button className="ghost-btn" onClick={props.onClose}><X width={16} height={16} /></button>
        </div>
        {props.children}
        {props.foot && <div className="modal-foot">{props.foot}</div>}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ field editor

export function FieldEditor() {
  const proj = useActiveProject()
  const id = useStore(s => s.ui.editFieldId)
  const setUI = useStore(s => s.setUI)
  const mutate = useStore(s => s.mutate)
  const showToast = useStore(s => s.showToast)
  const field = proj.fields.find(f => f.id === id)
  const usage = useMemo(() => (field ? fieldUsage(proj, field.id) : null), [proj, field])
  if (!field || !usage) return null
  const edit = (recipe: (f: FieldDef) => void) => mutate(p => { const f = p.fields.find(x => x.id === field.id); if (f) recipe(f) })
  const close = () => setUI({ editFieldId: null })

  const setKind = (to: FieldKind) => {
    if (to === field.kind) return
    const lost = conversionLoss(proj, field, to)
    const apply = () => mutate(p => changeFieldKind(p, field.id, to))
    if (!lost) { apply(); return }
    setUI({
      confirm: {
        title: `Change “${field.name}” to ${kindLabel(to).toLowerCase()}?`,
        message: `${lost} stored value${lost === 1 ? '' : 's'} can't be converted and will be cleared. Everything else converts.`,
        okLabel: 'Convert',
        onOk: apply,
      },
    })
  }

  const attachedTo = [
    ...proj.types.map(t => ({ id: t.id, name: t.name, kind: 'type' as const, on: t.fields.some(a => a.fieldId === field.id), icon: t.icon, color: t.color })),
    ...proj.hierarchyLevels.map(l => ({ id: l.id, name: l.name, kind: 'level' as const, on: l.fields.some(a => a.fieldId === field.id), icon: 'RectangleHorizontal', color: '#8b91a0' })),
  ]
  const toggleAttach = (o: typeof attachedTo[number]) => mutate(p => {
    const list = o.kind === 'type' ? p.types.find(t => t.id === o.id)?.fields : p.hierarchyLevels.find(l => l.id === o.id)?.fields
    if (!list) return
    const i = list.findIndex(a => a.fieldId === field.id)
    if (i >= 0) list.splice(i, 1)
    else list.push({ fieldId: field.id, defaultValue: null })
  })

  const del = () => {
    const affected = [
      ...usage.items.map(it => `${it.title || 'Untitled'} (item)`),
      ...usage.sections.map(sc => `${sc.name || 'Untitled'} (section)`),
    ]
    const run = () => { mutate(p => removeField(p, field.id)); close(); showToast(`Field “${field.name}” deleted.`, true) }
    if (!usage.types.length && !usage.levels.length && !affected.length && !usage.processors.length) { run(); return }
    const parts = [
      usage.types.length ? `${usage.types.length} type${usage.types.length === 1 ? '' : 's'}` : '',
      usage.levels.length ? `${usage.levels.length} level${usage.levels.length === 1 ? '' : 's'}` : '',
      usage.processors.length ? `${usage.processors.length} processor${usage.processors.length === 1 ? '' : 's'}` : '',
    ].filter(Boolean)
    setUI({
      confirm: {
        title: `Delete field “${field.name}”?`,
        message: `${parts.length ? 'Detaches it from ' + parts.join(', ') + '. ' : ''}${affected.length ? `${affected.length} stored value${affected.length === 1 ? '' : 's'} will be removed:` : 'No stored values are affected.'}`,
        list: affected,
        okLabel: 'Delete field',
        onOk: run,
      },
    })
  }

  return (
    <Modal
      className="field-editor"
      onClose={close}
      title={(
        <>
          <span className="kind-glyph big">{kindGlyph(field.kind)}</span>
          <input className="input title-input" value={field.name} placeholder="Field name" onChange={e => edit(f => { f.name = e.target.value })} />
        </>
      )}
      foot={(
        <button className="danger-btn" onClick={del}><Trash2 width={14} height={14} /> Delete field</button>
      )}
    >
      <div className="field">
        <label>Kind</label>
        <div className="seg">
          {FIELD_KINDS.map(k => (
            <button key={k.kind} className={field.kind === k.kind ? 'on' : ''} onClick={() => setKind(k.kind)}>{k.label}</button>
          ))}
        </div>
      </div>

      {field.kind === 'text' && (
        <div className="row gap">
          <div className="field grow">
            <label>Max length <span className="muted">(optional)</span></label>
            <NullableNumber value={field.maxLength} min={1} step={1} onChange={v => edit(f => { f.maxLength = v === null ? null : Math.max(1, Math.round(v)) })} placeholder="unlimited" />
          </div>
        </div>
      )}
      {isNumberKind(field.kind) && (
        <>
          <div className="row gap">
            <div className="field grow">
              <label>Min <span className="muted">(optional)</span></label>
              <NullableNumber value={field.min} step={field.kind === 'int' ? 1 : 'any'} onChange={v => edit(f => { f.min = v })} />
            </div>
            <div className="field grow">
              <label>Max <span className="muted">(optional)</span></label>
              <NullableNumber value={field.max} step={field.kind === 'int' ? 1 : 'any'} onChange={v => edit(f => { f.max = v })} />
            </div>
            {field.kind === 'float' && (
              <div className="field grow">
                <label>Decimals <span className="muted">(optional)</span></label>
                <NullableNumber value={field.decimals} min={0} step={1} onChange={v => edit(f => { f.decimals = v === null ? null : Math.max(0, Math.min(10, Math.round(v))) })} placeholder="free" />
              </div>
            )}
          </div>
          <div className="field">
            <label>Unit / suffix</label>
            <input className="input" value={field.unit} placeholder="e.g. coins, s, %" onChange={e => edit(f => { f.unit = e.target.value })} />
          </div>
        </>
      )}
      {field.kind === 'select' && (
        <>
          <div className="field">
            <label>Options <span className="muted">(one per line, in display order)</span></label>
            <OptionsEditor field={field} onChange={opts => edit(f => { f.options = opts })} />
          </div>
          <label className="check-row">
            <input type="checkbox" checked={field.selectMultiple} onChange={e => edit(f => { f.selectMultiple = e.target.checked })} />
            Allow several choices
          </label>
        </>
      )}
      {field.kind === 'ref' && (
        <>
          <div className="field">
            <label>Can reference</label>
            <TargetPicker value={field.refTargets} onChange={ids => edit(f => { f.refTargets = ids })} emptyLabel="anything — pick types or levels to restrict" />
          </div>
          <label className="check-row">
            <input type="checkbox" checked={field.refMultiple} onChange={e => edit(f => { f.refMultiple = e.target.checked })} />
            Allow several targets
          </label>
          <label className="check-row">
            <input type="checkbox" checked={field.refShowLinks} onChange={e => edit(f => { f.refShowLinks = e.target.checked })} />
            Draw connector lines on the timeline while the owner is selected
          </label>
        </>
      )}

      <div className="field">
        <label>Default value <span className="muted">(types and levels can override it)</span></label>
        <FieldValueInput field={field} value={field.defaultValue} asDefault onChange={v => edit(f => { f.defaultValue = v })} />
      </div>
      <div className="field">
        <label>Help text</label>
        <input className="input" value={field.help} placeholder="shown under the input" onChange={e => edit(f => { f.help = e.target.value })} />
      </div>
      <label className="check-row">
        <input type="checkbox" checked={field.required} onChange={e => edit(f => { f.required = e.target.checked })} />
        Required — warn when left empty
      </label>
      <label className="check-row">
        <input type="checkbox" checked={field.showInTooltip} onChange={e => edit(f => { f.showInTooltip = e.target.checked })} />
        Show in the hover tooltip on the timeline
      </label>
      <label className="check-row">
        <input type="checkbox" checked={field.showName} onChange={e => edit(f => { f.showName = e.target.checked })} />
        Show the field's name next to its value
      </label>
      <div className="sb-hint" style={{ marginTop: -4 }}>
        Off when the value speaks for itself (e.g. “12 {field.unit || 'coins'}”) — the name then only identifies the field here and in the sidebar.
      </div>

      <div className="field">
        <label>Attached to <span className="muted">({usage.items.length + usage.sections.length} stored value{usage.items.length + usage.sections.length === 1 ? '' : 's'})</span></label>
        <div className="target-grid">
          {attachedTo.map(o => {
            const Icon = iconByName(o.icon)
            return (
              <label key={o.id} className={`check-row ${o.on ? 'on' : ''}`}>
                <input type="checkbox" checked={o.on} onChange={() => toggleAttach(o)} />
                <Icon width={12} height={12} color={o.color} strokeWidth={2} />
                <span className="grow">{o.name}</span>
                {o.kind === 'level' && <span className="muted">level</span>}
              </label>
            )
          })}
        </div>
        {usage.processors.length > 0 && (
          <div className="sb-hint">used by processor{usage.processors.length === 1 ? '' : 's'}: {usage.processors.map(p => p.name).join(', ')}</div>
        )}
      </div>
    </Modal>
  )
}

/**
 * Dropdown options as a plain textarea: local text while typing so blank
 * lines and duplicates can exist mid-edit; the field only ever stores the
 * cleaned list. Stored values that name a removed option are kept until
 * the item is edited (they render as "removed option").
 */
function OptionsEditor({ field, onChange }: { field: FieldDef; onChange: (opts: string[]) => void }) {
  const [text, setText] = useState(field.options.join('\n'))
  const [focused, setFocused] = useState(false)
  React.useEffect(() => { if (!focused) setText(field.options.join('\n')) }, [field.options, focused])
  const commit = (t: string) => {
    const seen = new Set<string>()
    const opts = t.split('\n').map(o => o.trim()).filter(o => o && !seen.has(o) && seen.add(o))
    if (opts.join('\n') !== field.options.join('\n')) onChange(opts)
  }
  const proj = useActiveProject()
  const used = useMemo(() => {
    const count = new Map<string, number>()
    const bump = (rec: Record<string, unknown> | undefined) => {
      const v = rec?.[field.id]
      if (Array.isArray(v)) for (const o of v) count.set(String(o), (count.get(String(o)) ?? 0) + 1)
    }
    for (const it of proj.items) bump(it.fieldValues)
    for (const sc of proj.sections) bump(sc.fieldValues)
    return count
  }, [proj, field.id])
  return (
    <div className="options-editor">
      <textarea
        className="input"
        rows={Math.min(10, Math.max(3, field.options.length + 1))}
        value={text}
        placeholder={'e.g.\nEasy\nNormal\nHard'}
        onFocus={() => setFocused(true)}
        onChange={e => { setText(e.target.value); commit(e.target.value) }}
        onBlur={e => { setFocused(false); commit(e.target.value) }}
      />
      {field.options.length > 0 && (
        <div className="select-chips">
          {field.options.map(o => (
            <span key={o} className="chip on" title={`${used.get(o) ?? 0} value(s) use this`}>
              {o}{used.get(o) ? <span className="muted"> · {used.get(o)}</span> : null}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ processor editor

export function ProcessorEditor() {
  const proj = useActiveProject()
  const id = useStore(s => s.ui.editProcessorId)
  const setUI = useStore(s => s.setUI)
  const mutate = useStore(s => s.mutate)
  const showToast = useStore(s => s.showToast)
  const proc = proj.processors.find(f => f.id === id)
  if (!proc) return null
  const edit = (recipe: (f: ProcessorDef) => void) => mutate(p => { const f = p.processors.find(x => x.id === proc.id); if (f) recipe(f) })
  const close = () => setUI({ editProcessorId: null })
  const spec = PROCESSOR_OPS.find(o => o.op === proc.op)!
  const fieldChoices = proj.fields.filter(f => (spec.needsField === 'number' ? isNumberKind(f.kind) : true))
  const levels = processorUsage(proj, proc.id)

  const del = () => {
    const run = () => { mutate(p => removeProcessor(p, proc.id)); close(); showToast(`Processor “${proc.name}” deleted.`, true) }
    if (!levels.length) { run(); return }
    setUI({
      confirm: {
        title: `Delete processor “${proc.name}”?`,
        message: `It is attached to ${levels.length} level${levels.length === 1 ? '' : 's'}; those sections will stop showing it.`,
        list: levels.map(l => l.name),
        okLabel: 'Delete processor',
        onOk: run,
      },
    })
  }

  return (
    <Modal
      className="field-editor"
      onClose={close}
      title={(
        <>
          <span className="kind-glyph big">Σ</span>
          <input className="input title-input" value={proc.name} placeholder="Processor name" onChange={e => edit(f => { f.name = e.target.value })} />
        </>
      )}
      foot={<button className="danger-btn" onClick={del}><Trash2 width={14} height={14} /> Delete processor</button>}
    >
      <div className="field">
        <label>Operation</label>
        <select className="input" value={proc.op} onChange={e => edit(f => {
          f.op = e.target.value as ProcessorOp
          const need = PROCESSOR_OPS.find(o => o.op === f.op)!.needsField
          if (need === 'none') f.fieldId = null
          else if (need === 'number') {
            const cur = proj.fields.find(x => x.id === f.fieldId)
            if (!cur || !isNumberKind(cur.kind)) f.fieldId = proj.fields.find(x => isNumberKind(x.kind))?.id ?? null
          } else if (!f.fieldId) f.fieldId = proj.fields[0]?.id ?? null
        })}>
          {PROCESSOR_OPS.map(o => <option key={o.op} value={o.op}>{o.label}</option>)}
        </select>
      </div>
      {spec.needsField !== 'none' && (
        <div className="field">
          <label>Field</label>
          <select className="input" value={proc.fieldId ?? ''} onChange={e => edit(f => { f.fieldId = e.target.value || null })}>
            <option value="">— pick a field —</option>
            {fieldChoices.map(f => <option key={f.id} value={f.id}>{f.name} ({kindLabel(f.kind).toLowerCase()})</option>)}
          </select>
          {!fieldChoices.length && <div className="sb-hint">no {spec.needsField === 'number' ? 'number ' : ''}fields exist yet — create one in a type editor</div>}
        </div>
      )}
      <div className="field">
        <label>Include</label>
        <TargetPicker
          value={proc.targets}
          onChange={ids => edit(f => { f.targets = ids })}
          emptyLabel={spec.needsField === 'none' ? 'every item inside the section (pick types/levels to narrow)' : 'everything inside the section that has the field'}
        />
      </div>
      <div className="field">
        <label>Attached to levels</label>
        <div className="target-grid">
          {proj.hierarchyLevels.map(l => {
            const att = l.processors.find(a => a.processorId === proc.id)
            return (
              <React.Fragment key={l.id}>
                <label className={`check-row ${att ? 'on' : ''}`}>
                  <input type="checkbox" checked={!!att} onChange={() => mutate(p => {
                    const lv = p.hierarchyLevels.find(x => x.id === l.id)
                    if (!lv) return
                    const i = lv.processors.findIndex(a => a.processorId === proc.id)
                    if (i >= 0) lv.processors.splice(i, 1); else lv.processors.push({ processorId: proc.id, showOnBand: true })
                  })} />
                  <span className="grow">{l.name}</span>
                  {att && (
                    <label className="check-row tight" onClick={e => e.stopPropagation()}>
                      <input type="checkbox" checked={att.showOnBand} onChange={e => mutate(p => {
                        const a = p.hierarchyLevels.find(x => x.id === l.id)?.processors.find(x => x.processorId === proc.id)
                        if (a) a.showOnBand = e.target.checked
                      })} />
                      on band
                    </label>
                  )}
                </label>
              </React.Fragment>
            )
          })}
        </div>
        <div className="sb-hint">items on branch paths count like any other · nested sections count when their level is included</div>
      </div>
    </Modal>
  )
}

// ------------------------------------------------------------------ level editor

export function LevelEditor() {
  const proj = useActiveProject()
  const id = useStore(s => s.ui.editLevelId)
  const setUI = useStore(s => s.setUI)
  const mutate = useStore(s => s.mutate)
  const level = proj.hierarchyLevels.find(l => l.id === id)
  if (!level) return null
  const edit = (recipe: (l: HierarchyLevel) => void) => mutate(p => { const l = p.hierarchyLevels.find(x => x.id === level.id); if (l) recipe(l) })
  const close = () => setUI({ editLevelId: null })
  const depth = proj.hierarchyLevels.indexOf(level)
  const count = proj.sections.filter(s => s.depth === depth).length
  return (
    <Modal
      className="type-editor"
      onClose={close}
      title={(
        <>
          <span className="muted">Level {depth + 1}</span>
          <input className="input title-input" value={level.name} onChange={e => edit(l => { l.name = e.target.value })} />
        </>
      )}
    >
      <div className="sb-hint">{count} section{count === 1 ? '' : 's'} at this level · fields and processors apply to all of them</div>
      <div className="field">
        <label>Fields</label>
        <FieldAttachList list={level.fields} onChange={list => edit(l => { l.fields = list })} />
      </div>
      <div className="field">
        <label>Processors</label>
        <ProcessorAttachList list={level.processors} onChange={list => edit(l => { l.processors = list })} />
        <div className="sb-hint">a processor sums, counts or lists what sits inside each section of this level</div>
      </div>
    </Modal>
  )
}
