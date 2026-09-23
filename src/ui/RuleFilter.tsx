import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Filter, Plus, X } from 'lucide-react'
import { compile, namesIn, quoteName, quoteValue, toText, tryParse, type Ast } from '../model/expr'
import { fieldDisplayName, kindGlyph, parentOf } from '../model/fields'
import { builtinNames } from '../model/scope'
import { useActiveProject, useStore } from '../model/store'
import type { FieldDef, Project } from '../model/types'
import { Select } from './Select'

/**
 * Rule editor: a list of simple rows (field · operator · value, matched all
 * or any) that round-trips to the expression text, plus a text mode for
 * anything the rows cannot say. `value` is always the text; rows are derived
 * from it whenever the text has the flat shape the rows can represent.
 */

type RowOp = '=' | '!=' | '<' | '<=' | '>' | '>=' | 'contains' | 'has' | 'in' | 'is set' | 'is empty'
interface Row { field: string; op: RowOp; value: string }
interface Rows { all: boolean; rows: Row[] }

const OPS: { op: RowOp; label: string; kinds: 'any' | 'number' | 'text' | 'list' | 'toggle' }[] = [
  { op: '=', label: 'is', kinds: 'any' },
  { op: '!=', label: 'is not', kinds: 'any' },
  { op: '<', label: '<', kinds: 'number' },
  { op: '<=', label: '≤', kinds: 'number' },
  { op: '>', label: '>', kinds: 'number' },
  { op: '>=', label: '≥', kinds: 'number' },
  { op: 'contains', label: 'contains', kinds: 'text' },
  { op: 'has', label: 'has', kinds: 'list' },
  { op: 'in', label: 'one of', kinds: 'any' },
  { op: 'is set', label: 'is set', kinds: 'any' },
  { op: 'is empty', label: 'is empty', kinds: 'any' },
]

/** Rows from an AST when it is a flat and/or of simple comparisons; null otherwise. */
function rowsFrom(ast: Ast | null): Rows | null {
  if (!ast) return { all: true, rows: [] }
  const rows: Row[] = []
  let all: boolean | null = null
  const lit = (n: Ast): string | null => {
    if (n.t === 'num') return String(n.v)
    if (n.t === 'str') return n.v
    if (n.t === 'bool') return n.v ? 'yes' : 'no'
    if (n.t === 'null') return ''
    if (n.t === 'name' && !n.bracketed) return n.name
    if (n.t === 'list') { const parts = n.items.map(lit); return parts.every(p => p !== null) ? parts.join(', ') : null }
    return null
  }
  const simple = (n: Ast): Row | null => {
    if (n.t === 'isset' && n.a.t === 'name') return { field: n.a.name, op: n.set ? 'is set' : 'is empty', value: '' }
    if (n.t !== 'bin' || n.a.t !== 'name') return null
    if (!['=', '!=', '<', '<=', '>', '>=', 'contains', 'has', 'in'].includes(n.op)) return null
    const v = lit(n.b)
    if (v === null) return null
    return { field: n.a.name, op: n.op as RowOp, value: v }
  }
  const walk = (n: Ast): boolean => {
    if (n.t === 'bin' && (n.op === 'and' || n.op === 'or')) {
      const isAll = n.op === 'and'
      if (all === null) all = isAll
      else if (all !== isAll) return false
      return walk(n.a) && walk(n.b)
    }
    const r = simple(n)
    if (!r) return false
    rows.push(r)
    return true
  }
  if (!walk(ast)) return null
  return { all: all ?? true, rows }
}

function textFrom(r: Rows): string {
  const parts = r.rows.map(row => {
    const f = quoteName(row.field)
    if (row.op === 'is set' || row.op === 'is empty') return `${f} ${row.op}`
    if (row.op === 'in') {
      const items = row.value.split(',').map(s => s.trim()).filter(Boolean)
      return `${f} one of (${items.map(quoteValue).join(', ')})`
    }
    return `${f} ${row.op} ${quoteValue(row.value)}`
  }).filter(Boolean)
  return parts.join(r.all ? ' and ' : ' or ')
}

/** Fields (attached anywhere) plus built-ins, as name choices for a rule row. */
function nameOptions(proj: Project, on: 'item' | 'section' | 'any'): { value: string; label: string; hint?: string; field?: FieldDef }[] {
  const seen = new Set<string>()
  const out: { value: string; label: string; hint?: string; field?: FieldDef }[] = []
  const counts = new Map<string, number>()
  for (const f of proj.fields) counts.set(f.name.trim().toLowerCase(), (counts.get(f.name.trim().toLowerCase()) ?? 0) + 1)
  for (const f of proj.fields) {
    if (f.kind === 'group' && !f.template?.trim()) continue
    const parent = parentOf(proj, f)
    // A child whose bare name is unique goes by it; otherwise "Group.child".
    const value = parent && (counts.get(f.name.trim().toLowerCase()) ?? 0) > 1 ? `${parent.name}.${f.name}` : f.name
    const key = value.trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push({ value, label: fieldDisplayName(proj, f), hint: kindGlyph(f.kind), field: f })
  }
  const builtins = on === 'any' ? [...new Set([...builtinNames('item'), ...builtinNames('section')])] : builtinNames(on)
  for (const b of builtins) if (!seen.has(b)) out.push({ value: b, label: b, hint: 'built-in' })
  return out
}

export function RuleEditor(props: {
  value: string
  onChange: (text: string) => void
  /** Which built-ins to offer. */
  on: 'item' | 'section' | 'any'
  /** Smaller, for modals. */
  compact?: boolean
}) {
  const proj = useActiveProject()
  const parsed = useMemo(() => tryParse(props.value.trim()), [props.value])
  const rows = useMemo(() => (parsed.error ? null : rowsFrom(props.value.trim() ? parsed.ast : null)), [parsed, props.value])
  const [mode, setMode] = useState<'rows' | 'text'>(rows ? 'rows' : 'text')
  const [text, setText] = useState(props.value)
  useEffect(() => { setText(props.value) }, [props.value])
  useEffect(() => { if (!rows) setMode('text') }, [rows])
  const names = nameOptions(proj, props.on)
  const unknown = parsed.ast
    ? namesIn(parsed.ast).filter(n => !names.some(o => o.value.trim().toLowerCase() === n.trim().toLowerCase()))
    : []

  const setRows = (r: Rows) => props.onChange(textFrom(r))
  const fieldFor = (name: string) => names.find(o => o.value.trim().toLowerCase() === name.trim().toLowerCase())?.field
  const opsFor = (name: string) => {
    const f = fieldFor(name)
    const kind = !f ? 'any' : f.kind === 'int' || f.kind === 'float' ? 'number' : f.kind === 'text' ? 'text' : f.kind === 'select' || f.kind === 'ref' ? 'list' : f.kind === 'toggle' ? 'toggle' : 'any'
    return OPS.filter(o => o.kinds === 'any' || o.kinds === kind || (kind === 'any' && o.kinds !== 'toggle') || (o.kinds === 'text' && kind === 'any'))
  }

  return (
    <div className={`rule-editor ${props.compact ? 'compact' : ''}`}>
      <div className="rule-tabs">
        <button className={mode === 'rows' ? 'on' : ''} disabled={!rows} title={rows ? undefined : 'This expression is more than a list of rules; edit it as text'} onClick={() => setMode('rows')}>Rules</button>
        <button className={mode === 'text' ? 'on' : ''} onClick={() => setMode('text')}>Text</button>
        <span className="grow" />
        {props.value.trim() && <button className="link-btn" onClick={() => props.onChange('')}>clear</button>}
      </div>
      {mode === 'rows' && rows ? (
        <div className="rule-rows">
          {rows.rows.length > 1 && (
            <div className="rule-match">
              Match
              <div className="seg sm">
                <button className={rows.all ? 'on' : ''} onClick={() => setRows({ ...rows, all: true })}>all</button>
                <button className={!rows.all ? 'on' : ''} onClick={() => setRows({ ...rows, all: false })}>any</button>
              </div>
              of these
            </div>
          )}
          {rows.rows.map((row, i) => {
            const f = fieldFor(row.field)
            const ops = opsFor(row.field)
            const update = (patch: Partial<Row>) => setRows({ ...rows, rows: rows.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
            const noValue = row.op === 'is set' || row.op === 'is empty'
            return (
              <div key={i} className="rule-row">
                <Select
                  className="sm rule-field"
                  value={names.find(o => o.value.trim().toLowerCase() === row.field.trim().toLowerCase())?.value ?? row.field}
                  options={[...names.map(o => ({ value: o.value, label: o.label, hint: o.hint })), ...(names.some(o => o.value.trim().toLowerCase() === row.field.trim().toLowerCase()) ? [] : [{ value: row.field, label: row.field, hint: 'unknown' }])]}
                  searchPlaceholder="Search fields…"
                  onChange={v => update({ field: v, op: opsFor(v).some(o => o.op === row.op) ? row.op : '=' })}
                />
                <Select
                  className="sm rule-op"
                  value={row.op}
                  options={ops.map(o => ({ value: o.op, label: o.label }))}
                  onChange={v => update({ op: v as RowOp })}
                />
                {!noValue && (f?.kind === 'toggle' ? (
                  <Select className="sm rule-value" value={row.value.toLowerCase() === 'yes' || row.value === 'true' ? 'yes' : 'no'} options={[{ value: 'yes', label: 'yes' }, { value: 'no', label: 'no' }]} onChange={v => update({ value: v })} />
                ) : f?.kind === 'select' && row.op !== 'in' && row.op !== 'contains' ? (
                  <Select className="sm rule-value" value={row.value} placeholder="option…" options={f.options.map(o => ({ value: o, label: o }))} searchPlaceholder="Search options…" onChange={v => update({ value: v })} />
                ) : (
                  <input
                    className="input sm rule-value"
                    value={row.value}
                    placeholder={row.op === 'in' ? 'a, b, c' : f?.kind === 'int' || f?.kind === 'float' ? 'number' : 'value'}
                    onChange={e => update({ value: e.target.value })}
                  />
                ))}
                <button className="ghost-btn" title="Remove rule" onClick={() => setRows({ ...rows, rows: rows.rows.filter((_, j) => j !== i) })}><X width={12} height={12} /></button>
              </div>
            )
          })}
          <button
            className="ghost-btn add"
            onClick={() => setRows({ ...rows, rows: [...rows.rows, { field: names[0]?.value ?? 'title', op: '=', value: '' }] })}
          ><Plus width={12} height={12} /> add rule</button>
        </div>
      ) : (
        <div className="rule-text">
          <textarea
            className="input"
            rows={props.compact ? 2 : 3}
            value={text}
            placeholder="e.g. Implemented = no and [VFX Scope] >= 10"
            spellCheck={false}
            onChange={e => setText(e.target.value)}
            onBlur={() => { if (text.trim() !== props.value.trim()) props.onChange(text) }}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); props.onChange(text) } }}
          />
          {parsed.error && text.trim() === props.value.trim() && <div className="rule-error">{parsed.error.message} (at {parsed.error.pos + 1})</div>}
          {!parsed.error && unknown.length > 0 && <div className="rule-warn">unknown: {unknown.join(', ')} (read as text)</div>}
          <div className="sb-hint">
            fields by name ([brackets] when they have spaces) · and / or / not · = != &lt; &lt;= &gt; &gt;= · contains · has · one of (a, b) · is set / is empty · + - * / · if(), min(), max(), round(), len(), coalesce()
          </div>
        </div>
      )}
    </div>
  )
}

/** Toolbar funnel: opens the rule editor for the live filters; a badge shows how many rules are active. */
export function RuleFilterButton() {
  const proj = useActiveProject()
  const tweak = useStore(s => s.tweak)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const rules = proj.filters.rules ?? ''
  const { ast, error } = compile(rules)
  const count = ast ? Math.max(1, (rowsFrom(ast)?.rows.length ?? 1)) : rules.trim() ? 1 : 0
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element
      if (ref.current?.contains(t) || t.closest('.select-pop')) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey) }
  }, [open])
  return (
    <div className="rule-filter-wrap" ref={ref}>
      <button
        className={`ghost-btn ${rules.trim() ? 'on' : ''} ${error ? 'err' : ''} ${open ? 'open' : ''}`}
        title={rules.trim() ? `Rules: ${toText(ast ?? { t: 'str', v: rules })}` : 'Filter items by rules (field values, tags, type…)'}
        onClick={() => setOpen(v => !v)}
      >
        <Filter width={14} height={14} />
        {count > 0 && <span className="rule-badge">{count}</span>}
      </button>
      {open && (
        <div className="rule-pop">
          <div className="rule-pop-head">
            <strong>Show only items where</strong>
            <span className="muted small">saved with views · ANDed with types, layers, tags and text</span>
          </div>
          <RuleEditor value={rules} on="item" onChange={t => tweak(p => { p.filters.rules = t })} />
        </div>
      )}
    </div>
  )
}
