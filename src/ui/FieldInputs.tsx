import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Crosshair, RotateCcw, X } from 'lucide-react'
import {
  backlinks, clampValue, coerceValue, defaultFor, derivedValue, effectiveValue, entityTitle, formatToggle, formatValue, isDerived, kindGlyph,
  levelOf, locationOf, ownerOf, parseInput, refCandidates, type Owner,
} from '../model/fields'
import { iconByName } from '../model/icons'
import { useActiveWhole, useStore } from '../model/store'
import type { FieldAttachment, FieldDef, FieldValue, Id, Project } from '../model/types'
import { formatUnit, unitSuffix } from '../model/util'
import { Markdown } from './Markdown'
import { nav } from './nav'
import { Select } from './Select'

/** Fly the camera to an item or section and select it. */
export function jumpTo(p: Project, id: Id) {
  const o = ownerOf(p, id)
  if (!o) return
  if (o.kind === 'item') nav.current?.flyToItem(id)
  else { nav.current?.flyToSection(id); useStore.getState().select([`S:${id}`]) }
}

/** Icon + color describing an entity (item type or section level). */
export function entityLook(p: Project, o: Owner): { icon: string; color: string; typeName: string } {
  if (o.kind === 'item') {
    const t = p.types.find(x => x.id === o.entity.typeId)
    return { icon: t?.icon ?? 'Circle', color: t?.color ?? '#888', typeName: t?.name ?? 'Item' }
  }
  return { icon: 'RectangleHorizontal', color: '#8b91a0', typeName: levelOf(p, o.entity)?.name ?? 'Section' }
}

// ------------------------------------------------------------------ field rows (edit mode)

/** Label + input for one attached field on an item or section. */
export function FieldRow(props: {
  field: FieldDef
  att: FieldAttachment | null
  ownerId: Id
  raw: unknown
  onChange: (v: FieldValue | null) => void
}) {
  const { field, att } = props
  const proj = useActiveWhole()
  const explicit = coerceValue(field, props.raw)
  const eff = effectiveValue(field, att, props.raw)
  if (isDerived(field)) {
    // Derived: computed from the formula, shown read-only with the formula as the hint.
    const owner = ownerOf(proj, props.ownerId)
    const v = owner ? derivedValue(proj, owner, field) : null
    return (
      <div className={`field fdef derived ${field.showName ? '' : 'noname'}`} title={`${field.name} = ${field.formula}`}>
        {field.showName && (
          <label title={`= ${field.formula}`}>
            <span className="kind-glyph">ƒ</span>
            {field.name}
          </label>
        )}
        <div className="read-value derived-value">
          {v === null ? <span className="muted">—</span> : <ReadFieldValue field={field} value={v} />}
          <span className="derived-formula muted" title={field.formula}>= {field.formula}</span>
        </div>
        {field.help && <div className="field-help">{field.help}</div>}
      </div>
    )
  }
  const invalid = field.required && eff === null
  const canReset = explicit !== null && defaultFor(field, att) !== null
  // A field that hides its name gets no label row unless something has to go
  // there (the required mark or the reset link); the name stays in the tooltip.
  const showLabel = field.showName || field.required || canReset
  return (
    <div className={`field fdef ${invalid ? 'invalid' : ''} ${field.showName ? '' : 'noname'}`} title={field.showName ? undefined : `${field.name} · ${field.kind}`}>
      {showLabel && (
        <label title={`${field.name} · ${field.kind}`}>
          <span className="kind-glyph">{kindGlyph(field.kind)}</span>
          {field.showName && field.name}
          {field.required && <span className="req" title="Required"> *</span>}
          {canReset && (
            <button
              className="ghost-btn reset-btn right"
              title={`Reset to default: ${formatValue(proj, field, defaultFor(field, att))}`}
              onClick={() => props.onChange(null)}
            ><RotateCcw width={12} height={12} /></button>
          )}
        </label>
      )}
      <FieldValueInput field={field} att={att} value={explicit} ownerId={props.ownerId} onChange={props.onChange} />
      {field.help && <div className="field-help">{field.help}</div>}
    </div>
  )
}

/** Kind-aware input. `value` is the explicit value (null = unset, default shows as placeholder). */
export function FieldValueInput(props: {
  field: FieldDef
  att?: FieldAttachment | null
  value: FieldValue | null
  onChange: (v: FieldValue | null) => void
  ownerId?: Id
  /** Editing a default (in a type/level editor): the placeholder says so. */
  asDefault?: boolean
  compact?: boolean
}) {
  const { field, value } = props
  const proj = useActiveWhole()
  const fallback = props.asDefault ? null : defaultFor(field, props.att)
  const placeholder = props.asDefault
    ? (props.att && field.defaultValue !== null ? `field default: ${formatValue(proj, field, field.defaultValue)}` : 'no default')
    : fallback !== null ? `default: ${formatValue(proj, field, fallback)}` : ''

  if (field.kind === 'group') return null // composites have no value of their own; the inspector boxes their children
  if (field.kind === 'ref') {
    return (
      <RefPicker
        field={field}
        value={Array.isArray(value) ? value : []}
        onChange={ids => props.onChange(ids.length ? ids : null)}
        ownerId={props.ownerId}
        placeholder={placeholder || (field.refMultiple ? 'search items & sections…' : 'search an item or section…')}
        compact={props.compact}
      />
    )
  }
  if (field.kind === 'select') {
    const chosen = Array.isArray(value) ? value : []
    const known = new Set(field.options)
    const stale = chosen.filter(o => !known.has(o))
    if (!field.selectMultiple) {
      return (
        <div className="fv-select">
          <Select
            className={props.compact ? 'sm' : ''}
            value={chosen[0] ?? ''}
            options={[
              { value: '', label: placeholder ? `— ${placeholder} —` : '—' },
              ...field.options.map(o => ({ value: o, label: o })),
              ...stale.map(o => ({ value: o, label: o, hint: 'removed option' })),
            ]}
            searchPlaceholder="Search options…"
            onChange={v => props.onChange(v ? [v] : null)}
          />
          {field.options.length === 0 && <div className="sb-hint">no options yet — add some in the field settings</div>}
        </div>
      )
    }
    const toggle = (o: string) => {
      const next = chosen.includes(o) ? chosen.filter(x => x !== o) : field.options.filter(x => x === o || chosen.includes(x))
      props.onChange(next.length ? next : null)
    }
    return (
      <div className="fv-select">
        <div className="select-chips">
          {field.options.map(o => (
            <button key={o} className={`chip ${chosen.includes(o) ? 'on' : ''}`} onClick={() => toggle(o)}>{o}</button>
          ))}
          {stale.map(o => (
            <button key={`stale-${o}`} className="chip on stale" title="No longer an option — click to remove" onClick={() => toggle(o)}>{o}</button>
          ))}
          {field.options.length === 0 && <div className="sb-hint">no options yet — add some in the field settings</div>}
        </div>
        {chosen.length === 0 && placeholder && <div className="sb-hint">{placeholder}</div>}
      </div>
    )
  }
  if (field.kind === 'toggle') {
    const explicit = typeof value === 'boolean' ? value : null
    if (props.asDefault) {
      // Defaults are tri-state: none, on or off.
      return (
        <div className={`seg fv-toggle-default ${props.compact ? 'sm' : ''}`}>
          <button className={explicit === null ? 'on' : ''} onClick={() => props.onChange(null)}>{placeholder || 'no default'}</button>
          <button className={explicit === true ? 'on' : ''} onClick={() => props.onChange(true)}>Yes</button>
          <button className={explicit === false ? 'on' : ''} onClick={() => props.onChange(false)}>No</button>
        </div>
      )
    }
    // Yes / No buttons: only an explicit value lights one up, so an inherited
    // default can never be mistaken for a value the user set. The default (if
    // any) is named in a hint instead; clicking the lit button clears it again.
    const inherited = typeof fallback === 'boolean' ? fallback : null
    return (
      <div className={`fv-toggle-row ${props.compact ? 'sm' : ''}`}>
        <div className={`seg fv-toggle ${props.compact ? 'sm' : ''} ${explicit === null ? 'inherit' : ''}`}>
          <button
            className={explicit === true ? 'on' : ''}
            title={explicit === true ? 'Click again to clear' : 'Set to yes'}
            onClick={() => props.onChange(explicit === true ? null : true)}
          >Yes</button>
          <button
            className={explicit === false ? 'on' : ''}
            title={explicit === false ? 'Click again to clear' : 'Set to no'}
            onClick={() => props.onChange(explicit === false ? null : false)}
          >No</button>
        </div>
        {explicit === null && !props.compact && (
          <span className="muted fv-toggle-hint">{inherited === null ? 'not set' : `default: ${formatToggle(inherited)}`}</span>
        )}
      </div>
    )
  }
  if (field.kind === 'text') {
    const s = value === null ? '' : String(value)
    const over = field.maxLength !== null && s.length > field.maxLength
    return (
      <div className="fv-text">
        <input
          className={`input ${props.compact ? 'sm' : ''}`}
          value={s}
          placeholder={placeholder}
          onChange={e => props.onChange(e.target.value === '' ? null : e.target.value)}
          onBlur={() => { if (over) props.onChange(clampValue(field, s)) }}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        />
        {field.maxLength !== null && s.length > 0 && (
          <span className={`fv-count ${over ? 'over' : ''}`}>{s.length}/{field.maxLength}</span>
        )}
      </div>
    )
  }
  return <NumberInput field={field} value={value === null ? null : Number(value)} placeholder={placeholder} compact={props.compact} onChange={props.onChange} />
}

/**
 * Numbers commit on blur / Enter so typing is free and the snap happens once.
 * Selecting another entry on the canvas swaps the inspector before the input
 * blurs, so a pending edit is also flushed when the input unmounts; the row is
 * keyed by owner + field, which makes every owner change an unmount and keeps
 * the typed text from ever landing on the newly selected entry.
 */
function NumberInput(props: {
  field: FieldDef
  value: number | null
  placeholder: string
  compact?: boolean
  onChange: (v: FieldValue | null) => void
}) {
  const { field, value } = props
  const show = (n: number | null) => (n === null ? '' : String(n))
  const [text, setText] = useState(show(value))
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setText(show(value)) }, [value])
  // Latest props/text for the unmount flush (effects only see the values they closed over).
  const latest = useRef({ field, value, text, onChange: props.onChange })
  latest.current = { field, value, text, onChange: props.onChange }
  useEffect(() => () => {
    if (!focused.current) return
    const l = latest.current
    const v = clampValue(l.field, parseInput(l.field, l.text))
    if (v !== l.value) l.onChange(v)
  }, [])
  const commit = () => {
    const v = clampValue(field, parseInput(field, text))
    setText(show(v === null ? null : Number(v)))
    if (v !== value) props.onChange(v)
  }
  const step = field.kind === 'int' ? 1 : field.decimals !== null ? Math.pow(10, -field.decimals) : 'any'
  const hint = [
    field.min !== null || field.max !== null ? `${field.min ?? '−∞'} … ${field.max ?? '∞'}` : '',
    field.kind === 'float' && field.decimals !== null ? `${field.decimals} dp` : '',
  ].filter(Boolean).join(' · ')
  return (
    <div className="fv-num">
      <input
        className={`input ${props.compact ? 'sm' : ''}`}
        type="number"
        inputMode="decimal"
        step={step}
        min={field.min ?? undefined}
        max={field.max ?? undefined}
        value={text}
        placeholder={props.placeholder}
        title={hint}
        onFocus={() => { focused.current = true }}
        onChange={e => setText(e.target.value)}
        onBlur={() => { focused.current = false; commit() }}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      />
      {field.unit && <span className="fv-unit">{field.unit}</span>}
    </div>
  )
}

// ------------------------------------------------------------------ references

function RefPicker(props: {
  field: FieldDef
  value: Id[]
  onChange: (ids: Id[]) => void
  ownerId?: Id
  placeholder: string
  compact?: boolean
}) {
  const { field, value } = props
  const proj = useActiveWhole()
  const setUI = useStore(s => s.setUI)
  const pickRef = useStore(s => s.ui.pickRef)
  const readOnly = useStore(s => s.ui.readOnly)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(0)
  const candidates = useMemo(() => refCandidates(proj, field, props.ownerId), [proj, field, props.ownerId])
  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const chosen = new Set(value)
    const list = candidates.filter(c => !chosen.has(c.id))
    if (!needle) return list.slice(0, 40)
    const words = needle.split(/\s+/)
    return list
      .filter(c => {
        const hay = `${c.title} ${c.typeName} ${c.location} ${c.description}`.toLowerCase()
        return words.every(w => hay.includes(w))
      })
      .slice(0, 40)
  }, [candidates, q, value])
  useEffect(() => { setCursor(0) }, [q, open])
  // Never leave a stale glow behind when the list closes / unmounts.
  useEffect(() => () => { if (useStore.getState().ui.highlightId) setUI({ highlightId: null }) }, [])

  const picking = !!props.ownerId && pickRef?.ownerId === props.ownerId && pickRef?.fieldId === field.id
  const add = (id: Id) => {
    props.onChange(field.refMultiple ? [...value.filter(x => x !== id), id] : [id])
    setQ('')
    setOpen(false)
    setUI({ highlightId: null })
  }
  const remove = (id: Id) => props.onChange(value.filter(x => x !== id))

  return (
    <div className={`ref-picker ${props.compact ? 'compact' : ''}`}>
      {value.length > 0 && (
        <div className="ref-list">
          {value.map(id => <RefEntry key={id} id={id} onRemove={readOnly ? undefined : () => remove(id)} />)}
        </div>
      )}
      {!readOnly && (field.refMultiple || value.length === 0 || true) && (
        <div className="ref-search">
          <input
            className={`input ${props.compact ? 'sm' : ''}`}
            value={q}
            placeholder={value.length && !field.refMultiple ? 'replace with…' : props.placeholder}
            onChange={e => { setQ(e.target.value); setOpen(true) }}
            onFocus={() => setOpen(true)}
            onBlur={() => { setOpen(false); setUI({ highlightId: null }) }}
            onKeyDown={e => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(c + 1, matches.length - 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => Math.max(c - 1, 0)) }
              else if (e.key === 'Enter') { const m = matches[cursor]; if (m) { e.preventDefault(); add(m.id) } }
              else if (e.key === 'Escape') { setOpen(false); (e.target as HTMLInputElement).blur() }
            }}
          />
          {props.ownerId && (
            <button
              className={`ghost-btn ${picking ? 'on' : ''}`}
              title={picking ? 'Cancel picking (Esc)' : 'Pick on the timeline — click an item or section'}
              onClick={() => setUI({ pickRef: picking ? null : { ownerId: props.ownerId!, fieldId: field.id } })}
            ><Crosshair width={14} height={14} /></button>
          )}
          {open && (
            <div className="ref-menu">
              {matches.length === 0 && <div className="sb-hint">{candidates.length ? 'no matches' : 'nothing to reference yet'}</div>}
              {matches.map((c, i) => {
                const Icon = iconByName(c.icon)
                return (
                  <div
                    key={c.id}
                    className={`ref-row ${i === cursor ? 'cur' : ''}`}
                    onPointerDown={e => { e.preventDefault(); add(c.id) }}
                    onPointerEnter={() => { setCursor(i); setUI({ highlightId: c.id }) }}
                    onPointerLeave={() => setUI({ highlightId: null })}
                  >
                    <Icon width={13} height={13} color={c.color} strokeWidth={2} />
                    <div className="ref-row-main">
                      <div className="ref-row-title">{c.title}</div>
                      <div className="ref-row-sub">{c.typeName} · {c.location}</div>
                      {c.description && <div className="ref-row-desc">{c.description.slice(0, 90)}</div>}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
      {picking && <div className="sb-hint">click an item or section on the timeline · Esc cancels</div>}
    </div>
  )
}

/**
 * One referenced entity as a list row: icon, title (click jumps to it), type
 * and location, span, tags, and its description (click the text to expand).
 */
export function RefEntry({ id, onRemove }: { id: Id; onRemove?: () => void }) {
  const proj = useActiveWhole()
  const setUI = useStore(s => s.setUI)
  const [expanded, setExpanded] = useState(false)
  const o = ownerOf(proj, id)
  if (!o) {
    return (
      <div className="ref-entry missing">
        <span className="ref-entry-title muted">missing entry</span>
        {onRemove && <button className="ghost-btn ref-entry-x" title="Remove" onClick={onRemove}><X width={11} height={11} /></button>}
      </div>
    )
  }
  const look = entityLook(proj, o)
  const Icon = iconByName(look.icon)
  const desc = (o.kind === 'item' ? o.entity.description : o.entity.description ?? '').trim()
  const tags = o.kind === 'item' ? o.entity.tags : []
  const suffix = unitSuffix(proj.settings.unit.preset, proj.settings.unit.custom)
  const fmt = (v: number) => formatUnit(v, Math.max(Math.abs(v), 0.01), suffix, proj.settings.unit.preset)
  const span = o.kind === 'item'
    ? (o.entity.duration > 0 ? `spans ${fmt(o.entity.duration)}` : '')
    : `${fmt(o.entity.end - o.entity.start)} long`
  return (
    <div
      className="ref-entry"
      style={{ '--c': look.color } as React.CSSProperties}
      onPointerEnter={() => setUI({ highlightId: id })}
      onPointerLeave={() => setUI({ highlightId: null })}
    >
      <Icon width={14} height={14} color={look.color} strokeWidth={2} />
      <div className="ref-entry-main">
        <div className="ref-entry-head">
          <button className="ref-entry-title" title="Jump to it on the timeline" onClick={() => jumpTo(proj, id)}>{entityTitle(proj, id)}</button>
          <span className="ref-entry-type">{look.typeName}</span>
        </div>
        <div className="ref-row-sub">{locationOf(proj, o)}{span && ` · ${span}`}</div>
        {tags.length > 0 && <div className="tt-tags">{tags.map(t => <span key={t} className="tag">{t}</span>)}</div>}
        {desc && (
          <div
            className={`ref-entry-desc md ${expanded ? 'open' : ''}`}
            title={expanded ? 'Click to collapse' : 'Click to expand'}
            onClick={() => setExpanded(v => !v)}
          ><Markdown text={desc} /></div>
        )}
      </div>
      {onRemove && <button className="ghost-btn ref-entry-x" title="Remove" onClick={onRemove}><X width={11} height={11} /></button>}
    </div>
  )
}

/** Chip for one referenced entity; click jumps to it. */
export function RefChip({ id, onRemove, via }: { id: Id; onRemove?: () => void; via?: string }) {
  const proj = useActiveWhole()
  const setUI = useStore(s => s.setUI)
  const o = ownerOf(proj, id)
  if (!o) return <span className="ref-chip missing">missing</span>
  const look = entityLook(proj, o)
  const Icon = iconByName(look.icon)
  return (
    <span
      className="ref-chip"
      title={`${look.typeName} · click to jump`}
      onPointerEnter={() => setUI({ highlightId: id })}
      onPointerLeave={() => setUI({ highlightId: null })}
    >
      <button className="ref-chip-main" onClick={() => jumpTo(proj, id)}>
        <Icon width={12} height={12} color={look.color} strokeWidth={2} />
        <span>{entityTitle(proj, id)}</span>
        {via && <span className="muted"> · {via}</span>}
      </button>
      {onRemove && <button className="ref-chip-x" title="Remove" onClick={onRemove}><X width={10} height={10} /></button>}
    </span>
  )
}

// ------------------------------------------------------------------ read-only

/** Formatted value for the read-only inspector / viewer. */
export function ReadFieldValue({ field, value }: { field: FieldDef; value: FieldValue | null }) {
  const proj = useActiveWhole()
  if (value === null) return <span className="muted">—</span>
  if (field.kind === 'ref' && Array.isArray(value)) {
    return <div className="ref-list">{value.map(id => <RefEntry key={id} id={id} />)}</div>
  }
  if (field.kind === 'select' && Array.isArray(value)) {
    return <div className="select-chips read">{value.map(o => <span key={o} className="chip on">{o}</span>)}</div>
  }
  return <>{formatValue(proj, field, value)}</>
}

/** "Referenced by" list for an item or section. */
export function ReferencedBy({ id }: { id: Id }) {
  const proj = useActiveWhole()
  const links = useMemo(() => backlinks(proj, id), [proj, id])
  if (!links.length) return null
  return (
    <div className="field">
      <label>Referenced by <span className="muted">({links.length})</span></label>
      <div className="ref-chips">
        {links.map((l, i) => <RefChip key={`${l.owner.entity.id}-${l.field.id}-${i}`} id={l.owner.entity.id} via={l.field.name} />)}
      </div>
    </div>
  )
}

export const Fragment = React.Fragment
