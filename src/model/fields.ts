import type {
  FieldAttachment, FieldDef, FieldKind, FieldValue, HierarchyLevel, Id, Item, Project, Section,
} from './types'
import { formatUnit, unitSuffix } from './util'

/**
 * Project-wide fields: definitions live on `Project.fields`, item types and
 * hierarchy levels attach them (optionally with their own default), and items
 * / sections store explicit values in `fieldValues`. Everything here is pure.
 */

export const FIELD_KINDS: { kind: FieldKind; label: string; glyph: string }[] = [
  { kind: 'text', label: 'Text', glyph: 'Aa' },
  { kind: 'int', label: 'Whole number', glyph: '#' },
  { kind: 'float', label: 'Decimal number', glyph: '0.0' },
  { kind: 'select', label: 'Dropdown', glyph: '▾' },
  { kind: 'ref', label: 'Reference', glyph: '→' },
]

export const kindLabel = (k: FieldKind) => FIELD_KINDS.find(x => x.kind === k)?.label ?? k
export const kindGlyph = (k: FieldKind) => FIELD_KINDS.find(x => x.kind === k)?.glyph ?? '?'
export const isNumberKind = (k: FieldKind) => k === 'int' || k === 'float'

export function newFieldDef(id: Id, name: string, kind: FieldKind = 'text'): FieldDef {
  return {
    id, name, kind, help: '', required: false, showInTooltip: false, defaultValue: null,
    maxLength: null, min: null, max: null, decimals: null, unit: '',
    options: [], selectMultiple: false,
    refTargets: [], refMultiple: false, refShowLinks: false,
  }
}

/** Fill in anything missing from a field saved by an older build. */
export function normalizeFieldDef(raw: Partial<FieldDef> & { id: Id }): FieldDef {
  const base = newFieldDef(raw.id, raw.name ?? 'Field', (['text', 'int', 'float', 'select', 'ref'] as FieldKind[]).includes(raw.kind as FieldKind) ? raw.kind as FieldKind : 'text')
  const f: FieldDef = { ...base, ...raw, kind: base.kind }
  f.refTargets = Array.isArray(f.refTargets) ? f.refTargets : []
  f.options = Array.isArray(f.options) ? f.options.filter(o => typeof o === 'string') : []
  f.defaultValue = coerceValue(f, f.defaultValue)
  return f
}

export const fieldById = (p: Project, id: Id | null | undefined) => (id ? p.fields.find(f => f.id === id) : undefined)
export const processorById = (p: Project, id: Id | null | undefined) => (id ? p.processors.find(f => f.id === id) : undefined)
export const levelOf = (p: Project, s: Section): HierarchyLevel | undefined => p.hierarchyLevels[s.depth]
export const levelById = (p: Project, id: Id) => p.hierarchyLevels.find(l => l.id === id)

export type Owner = { kind: 'item'; entity: Item } | { kind: 'section'; entity: Section }

export function ownerOf(p: Project, id: Id): Owner | null {
  const it = p.items.find(i => i.id === id)
  if (it) return { kind: 'item', entity: it }
  const sc = p.sections.find(s => s.id === id)
  if (sc) return { kind: 'section', entity: sc }
  return null
}

/** Fields attached to an item's type or a section's level, with their definitions. */
export function attachmentsFor(p: Project, owner: Owner): { att: FieldAttachment; field: FieldDef }[] {
  const list = owner.kind === 'item'
    ? p.types.find(t => t.id === owner.entity.typeId)?.fields ?? []
    : levelOf(p, owner.entity)?.fields ?? []
  const out: { att: FieldAttachment; field: FieldDef }[] = []
  for (const att of list) {
    const field = fieldById(p, att.fieldId)
    if (field) out.push({ att, field })
  }
  return out
}

/** Default that applies to an attachment: its own override, else the field's. */
export function defaultFor(field: FieldDef, att: FieldAttachment | null | undefined): FieldValue | null {
  const v = att?.defaultValue ?? field.defaultValue
  return coerceValue(field, v)
}

/** Explicit value if set, else the attachment/field default. */
export function effectiveValue(field: FieldDef, att: FieldAttachment | null | undefined, raw: unknown): FieldValue | null {
  const v = coerceValue(field, raw)
  return v ?? defaultFor(field, att)
}

/** Effective value of `field` on an owner (looks up the attachment for the default). */
export function valueOn(p: Project, owner: Owner, field: FieldDef): FieldValue | null {
  const att = attachmentsFor(p, owner).find(a => a.field.id === field.id)?.att ?? null
  return effectiveValue(field, att, owner.entity.fieldValues?.[field.id])
}

/** Shape-check a stored value against the field's kind; anything else is treated as unset. */
export function coerceValue(field: FieldDef, v: unknown): FieldValue | null {
  if (v === null || v === undefined) return null
  switch (field.kind) {
    case 'text': {
      const s = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null
      return s === null || s === '' ? null : s
    }
    case 'int':
    case 'float': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
      return Number.isFinite(n) ? n : null
    }
    case 'select':
    case 'ref': {
      if (Array.isArray(v)) { const ids = v.filter(x => typeof x === 'string'); return ids.length ? ids : null }
      return typeof v === 'string' && v ? [v] : null
    }
  }
}

/** Snap a value into the field's limits (min/max, max length, decimals, integer). */
export function clampValue(field: FieldDef, v: FieldValue | null): FieldValue | null {
  if (v === null) return null
  switch (field.kind) {
    case 'text': {
      const s = String(v)
      return field.maxLength !== null && s.length > field.maxLength ? s.slice(0, field.maxLength) : s
    }
    case 'int':
    case 'float': {
      let n = Number(v)
      if (!Number.isFinite(n)) return null
      if (field.kind === 'int') n = Math.round(n)
      else if (field.decimals !== null) n = Number(n.toFixed(Math.max(0, Math.min(10, field.decimals))))
      if (field.min !== null) n = Math.max(field.min, n)
      if (field.max !== null) n = Math.min(field.max, n)
      if (field.kind === 'int') n = Math.round(n)
      return n
    }
    case 'select': {
      // Only known options survive, in the field's option order; single-choice keeps the first.
      const chosen = new Set(Array.isArray(v) ? v : [String(v)])
      const out = field.options.filter(o => chosen.has(o))
      const kept = field.selectMultiple ? out : out.slice(0, 1)
      return kept.length ? kept : null
    }
    case 'ref': {
      const ids = Array.isArray(v) ? v : [String(v)]
      const out = field.refMultiple ? [...new Set(ids)] : ids.slice(0, 1)
      return out.length ? out : null
    }
  }
}

/** Parse what a user typed for a field; null when empty/unparseable. */
export function parseInput(field: FieldDef, text: string): FieldValue | null {
  const t = text.trim()
  if (!t) return null
  if (field.kind === 'text') return text
  if (isNumberKind(field.kind)) { const n = Number(t.replace(',', '.')); return Number.isFinite(n) ? n : null }
  return [t]
}

export function formatNumber(field: FieldDef, n: number): string {
  const s = field.kind === 'int' ? String(Math.round(n))
    : field.decimals !== null ? n.toFixed(field.decimals)
    : String(Number(n.toFixed(6)))
  return field.unit ? `${s} ${field.unit}` : s
}

/** Human-readable value: numbers with units, references by name. */
export function formatValue(p: Project, field: FieldDef, v: FieldValue | null): string {
  if (v === null) return ''
  switch (field.kind) {
    case 'text': return String(v)
    case 'int':
    case 'float': return formatNumber(field, Number(v))
    case 'select': return (Array.isArray(v) ? v : [String(v)]).join(', ')
    case 'ref': return (Array.isArray(v) ? v : [String(v)]).map(id => entityTitle(p, id)).join(', ')
  }
}

export function entityTitle(p: Project, id: Id): string {
  const o = ownerOf(p, id)
  if (!o) return '(missing)'
  return o.kind === 'item' ? (o.entity.title || 'Untitled') : (o.entity.name || 'Untitled section')
}

/** Best-effort conversion when a field changes kind; null = value lost. */
export function convertValue(from: FieldKind, to: FieldKind, v: FieldValue | null): FieldValue | null {
  if (v === null || from === to) return v
  if (to === 'ref' || from === 'ref') return null
  // Dropdown ↔ text: choices become a comma list and back (unknown choices are dropped by clampValue).
  if (from === 'select') { const s = (Array.isArray(v) ? v : [String(v)]).join(', '); return to === 'text' ? s : null }
  if (to === 'select') return typeof v === 'string' ? v.split(',').map(x => x.trim()).filter(Boolean) : null
  if (to === 'text') return String(v)
  const n = typeof v === 'number' ? v : Number(String(v).trim().replace(',', '.'))
  if (!Number.isFinite(n)) return null
  return to === 'int' ? Math.round(n) : n
}

/** Everything a field touches: attachments, explicit values and processors. */
export function fieldUsage(p: Project, fieldId: Id) {
  const types = p.types.filter(t => t.fields.some(a => a.fieldId === fieldId))
  const levels = p.hierarchyLevels.filter(l => l.fields.some(a => a.fieldId === fieldId))
  const items = p.items.filter(it => it.fieldValues?.[fieldId] !== undefined)
  const sections = p.sections.filter(sc => sc.fieldValues?.[fieldId] !== undefined)
  const processors = p.processors.filter(pr => pr.fieldId === fieldId)
  return { types, levels, items, sections, processors }
}

/** Detach a field everywhere and drop its values; processors using it lose their field. */
export function removeField(p: Project, fieldId: Id) {
  p.fields = p.fields.filter(f => f.id !== fieldId)
  for (const t of p.types) t.fields = t.fields.filter(a => a.fieldId !== fieldId)
  for (const l of p.hierarchyLevels) l.fields = l.fields.filter(a => a.fieldId !== fieldId)
  for (const it of p.items) delete it.fieldValues[fieldId]
  for (const sc of p.sections) delete sc.fieldValues[fieldId]
  for (const pr of p.processors) if (pr.fieldId === fieldId) pr.fieldId = null
}

/** Change a field's kind, converting stored values and defaults best-effort. */
export function changeFieldKind(p: Project, fieldId: Id, to: FieldKind) {
  const f = p.fields.find(x => x.id === fieldId)
  if (!f || f.kind === to) return
  const from = f.kind
  f.kind = to
  f.defaultValue = convertValue(from, to, f.defaultValue)
  const conv = (rec: Record<Id, FieldValue>) => {
    if (rec[fieldId] === undefined) return
    const v = convertValue(from, to, rec[fieldId])
    if (v === null) delete rec[fieldId]
    else rec[fieldId] = v
  }
  for (const t of p.types) for (const a of t.fields) if (a.fieldId === fieldId) a.defaultValue = convertValue(from, to, a.defaultValue)
  for (const l of p.hierarchyLevels) for (const a of l.fields) if (a.fieldId === fieldId) a.defaultValue = convertValue(from, to, a.defaultValue)
  for (const it of p.items) conv(it.fieldValues)
  for (const sc of p.sections) conv(sc.fieldValues)
  if (to === 'ref') f.refTargets = []
}

/** How many stored values would be lost converting a field to `to`. */
export function conversionLoss(p: Project, field: FieldDef, to: FieldKind): number {
  let n = 0
  const check = (rec: Record<Id, FieldValue>) => {
    const v = coerceValue(field, rec[field.id])
    if (v !== null && convertValue(field.kind, to, v) === null) n++
  }
  for (const it of p.items) check(it.fieldValues)
  for (const sc of p.sections) check(sc.fieldValues)
  return n
}

export function removeProcessor(p: Project, id: Id) {
  p.processors = p.processors.filter(x => x.id !== id)
  for (const l of p.hierarchyLevels) l.processors = l.processors.filter(a => a.processorId !== id)
}

/** Selectable "types" for reference filters and processor targets: item types + hierarchy levels. */
export interface TargetOption { id: Id; name: string; kind: 'type' | 'level'; color: string; icon: string }

export function targetOptions(p: Project): TargetOption[] {
  return [
    ...p.types.map(t => ({ id: t.id, name: t.name, kind: 'type' as const, color: t.color, icon: t.icon })),
    ...p.hierarchyLevels.map(l => ({ id: l.id, name: l.name, kind: 'level' as const, color: '#8b91a0', icon: 'RectangleHorizontal' })),
  ]
}

/** The "type id" of an entity for filters: its item type or its level id. */
export function targetKeyOf(p: Project, o: Owner): Id | null {
  return o.kind === 'item' ? o.entity.typeId : (levelOf(p, o.entity)?.id ?? null)
}

export function allowsTarget(p: Project, field: FieldDef, o: Owner): boolean {
  if (!field.refTargets.length) return true
  const key = targetKeyOf(p, o)
  return !!key && field.refTargets.includes(key)
}

/** Sections enclosing a position, outermost first. */
export function sectionsAt(p: Project, pos: number, exclude?: Id): Section[] {
  const eps = 1e-9
  return p.sections
    .filter(s => s.id !== exclude && s.start <= pos + eps && s.end >= pos - eps)
    .sort((a, b) => a.depth - b.depth)
}

/** Enclosing-section breadcrumb + position, e.g. "Chapter 1 › The drop · 12". */
export function locationOf(p: Project, o: Owner): string {
  const suffix = unitSuffix(p.settings.unit.preset, p.settings.unit.custom)
  const fmt = (v: number) => formatUnit(v, Math.max(Math.abs(v), 0.01), suffix, p.settings.unit.preset)
  if (o.kind === 'item') {
    const chain = sectionsAt(p, o.entity.pos).map(s => s.name || '…')
    return `${chain.length ? chain.join(' › ') + ' · ' : ''}${fmt(o.entity.pos)}`
  }
  const s = o.entity
  const eps = 1e-9
  const parents = p.sections
    .filter(t => t.id !== s.id && t.depth < s.depth && t.start <= s.start + eps && t.end >= s.end - eps)
    .sort((a, b) => a.depth - b.depth)
    .map(t => t.name || '…')
  const level = levelOf(p, s)?.name ?? 'Section'
  return `${level}${parents.length ? ' in ' + parents.join(' › ') : ''} · ${fmt(s.start)} – ${fmt(s.end)}`
}

export interface RefCandidate {
  id: Id
  owner: Owner
  title: string
  typeName: string
  color: string
  icon: string
  location: string
  description: string
  sortKey: number
}

/** Everything a reference field may point at, in timeline order. */
export function refCandidates(p: Project, field: FieldDef, excludeId?: Id): RefCandidate[] {
  const out: RefCandidate[] = []
  for (const it of p.items) {
    if (it.id === excludeId) continue
    const o: Owner = { kind: 'item', entity: it }
    if (!allowsTarget(p, field, o)) continue
    const t = p.types.find(x => x.id === it.typeId)
    out.push({
      id: it.id, owner: o, title: it.title || 'Untitled', typeName: t?.name ?? 'Item',
      color: t?.color ?? '#888', icon: t?.icon ?? 'Circle', location: locationOf(p, o),
      description: it.description, sortKey: it.pos,
    })
  }
  for (const sc of p.sections) {
    if (sc.id === excludeId) continue
    const o: Owner = { kind: 'section', entity: sc }
    if (!allowsTarget(p, field, o)) continue
    out.push({
      id: sc.id, owner: o, title: sc.name || 'Untitled section', typeName: levelOf(p, sc)?.name ?? 'Section',
      color: '#8b91a0', icon: 'RectangleHorizontal', location: locationOf(p, o),
      description: sc.description ?? '', sortKey: sc.start - 1e-6,
    })
  }
  return out.sort((a, b) => a.sortKey - b.sortKey || a.title.localeCompare(b.title))
}

export interface Backlink { owner: Owner; field: FieldDef }

/** Everything that references `targetId` through a ref field (explicit values and defaults). */
export function backlinks(p: Project, targetId: Id): Backlink[] {
  const out: Backlink[] = []
  const refFields = p.fields.filter(f => f.kind === 'ref')
  if (!refFields.length) return out
  const scan = (o: Owner) => {
    for (const { att, field } of attachmentsFor(p, o)) {
      if (field.kind !== 'ref') continue
      const v = effectiveValue(field, att, o.entity.fieldValues?.[field.id])
      if (Array.isArray(v) && v.includes(targetId)) out.push({ owner: o, field })
    }
  }
  for (const it of p.items) scan({ kind: 'item', entity: it })
  for (const sc of p.sections) scan({ kind: 'section', entity: sc })
  return out
}

/** References (explicit values only) that would break if `ids` were deleted. */
export function referencesTo(p: Project, ids: Set<Id>): Backlink[] {
  const out: Backlink[] = []
  const refIds = new Set(p.fields.filter(f => f.kind === 'ref').map(f => f.id))
  if (!refIds.size) return out
  const scan = (o: Owner) => {
    if (ids.has(o.entity.id)) return
    for (const [fid, v] of Object.entries(o.entity.fieldValues ?? {})) {
      if (!refIds.has(fid) || !Array.isArray(v)) continue
      if (v.some(id => ids.has(id))) { const field = fieldById(p, fid); if (field) out.push({ owner: o, field }) }
    }
  }
  for (const it of p.items) scan({ kind: 'item', entity: it })
  for (const sc of p.sections) scan({ kind: 'section', entity: sc })
  return out
}

/** Drop `ids` from every stored reference value (and every default). */
export function stripRefs(p: Project, ids: Set<Id>) {
  const refIds = new Set(p.fields.filter(f => f.kind === 'ref').map(f => f.id))
  if (!refIds.size) return
  const clean = (rec: Record<Id, FieldValue>) => {
    for (const fid of refIds) {
      const v = rec[fid]
      if (!Array.isArray(v)) continue
      const next = v.filter(id => !ids.has(id))
      if (next.length === v.length) continue
      if (next.length) rec[fid] = next
      else delete rec[fid]
    }
  }
  for (const it of p.items) clean(it.fieldValues)
  for (const sc of p.sections) clean(sc.fieldValues)
  const cleanDefault = (v: FieldValue | null): FieldValue | null => {
    if (!Array.isArray(v)) return v
    const next = v.filter(id => !ids.has(id))
    return next.length ? next : null
  }
  for (const f of p.fields) if (f.kind === 'ref') f.defaultValue = cleanDefault(f.defaultValue)
  for (const t of p.types) for (const a of t.fields) if (refIds.has(a.fieldId)) a.defaultValue = cleanDefault(a.defaultValue)
  for (const l of p.hierarchyLevels) for (const a of l.fields) if (refIds.has(a.fieldId)) a.defaultValue = cleanDefault(a.defaultValue)
}

/**
 * Keep the schema consistent after any change (local, undo or remote):
 * attachments to missing fields/processors go, duplicate attachments collapse,
 * references to entities that no longer exist are dropped.
 */
export function repairSchema(p: Project) {
  const fieldIds = new Set(p.fields.map(f => f.id))
  const procIds = new Set(p.processors.map(f => f.id))
  const dedupeFields = (list: FieldAttachment[]) => {
    const seen = new Set<Id>()
    return list.filter(a => fieldIds.has(a.fieldId) && !seen.has(a.fieldId) && seen.add(a.fieldId))
  }
  for (const t of p.types) t.fields = dedupeFields(t.fields)
  for (const l of p.hierarchyLevels) {
    l.fields = dedupeFields(l.fields)
    const seen = new Set<Id>()
    l.processors = l.processors.filter(a => procIds.has(a.processorId) && !seen.has(a.processorId) && seen.add(a.processorId))
  }
  const refFields = p.fields.filter(f => f.kind === 'ref')
  if (!refFields.length) return
  const live = new Set<Id>()
  for (const it of p.items) live.add(it.id)
  for (const sc of p.sections) live.add(sc.id)
  const dead = new Set<Id>()
  const collect = (rec: Record<Id, FieldValue> | undefined) => {
    if (!rec) return
    for (const f of refFields) { const v = rec[f.id]; if (Array.isArray(v)) for (const id of v) if (!live.has(id)) dead.add(id) }
  }
  for (const it of p.items) collect(it.fieldValues)
  for (const sc of p.sections) collect(sc.fieldValues)
  for (const f of refFields) if (Array.isArray(f.defaultValue)) for (const id of f.defaultValue) if (!live.has(id)) dead.add(id)
  if (dead.size) stripRefs(p, dead)
}

/** Types/levels that carry a field, for display. */
export function attachedToNames(p: Project, fieldId: Id): string[] {
  return [
    ...p.types.filter(t => t.fields.some(a => a.fieldId === fieldId)).map(t => t.name),
    ...p.hierarchyLevels.filter(l => l.fields.some(a => a.fieldId === fieldId)).map(l => l.name),
  ]
}
