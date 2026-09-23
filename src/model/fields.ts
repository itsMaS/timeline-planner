import type {
  FieldAttachment, FieldDef, FieldKind, FieldValue, Folder, HierarchyLevel, Id, Item, ItemType, Project, Section, TimelineSettings, TypeFolder,
} from './types'
import { folderChain, groupedMembers, orderedMembers } from './folders'
import { evalOn } from './scope'
import type { Value } from './expr'
import { wholeOf } from './timelines'
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
  { kind: 'toggle', label: 'Toggle', glyph: '✓' },
  { kind: 'select', label: 'Dropdown', glyph: '▾' },
  { kind: 'ref', label: 'Reference', glyph: '→' },
  { kind: 'group', label: 'Composite', glyph: '{}' },
]

export const kindLabel = (k: FieldKind) => FIELD_KINDS.find(x => x.kind === k)?.label ?? k
export const kindGlyph = (k: FieldKind) => FIELD_KINDS.find(x => x.kind === k)?.glyph ?? '?'
export const isNumberKind = (k: FieldKind) => k === 'int' || k === 'float'
/** A derived field computes its value from a formula instead of storing one. */
export const isDerived = (f: FieldDef) => !!f.formula?.trim() && f.kind !== 'group'

export function newFieldDef(id: Id, name: string, kind: FieldKind = 'text'): FieldDef {
  return {
    id, name, kind, help: '', required: false, showInTooltip: false, showName: true, defaultValue: null,
    maxLength: null, min: null, max: null, decimals: null, unit: '',
    options: [], selectMultiple: false,
    refTargets: [], refMultiple: false, refShowLinks: false,
    folderId: null, badge: false, children: [], template: '', parentId: null, formula: '',
  }
}

/** Types whose items carry `fieldId` (own attachment or inherited from a folder, or through its group). */
export function typesWithField(p: Project, fieldId: Id): ItemType[] {
  return p.types.filter(t => typeAttachments(p, t).some(a => a.field.id === fieldId))
}

/** Fill in anything missing from a field saved by an older build. */
export function normalizeFieldDef(raw: Partial<FieldDef> & { id: Id }): FieldDef {
  const base = newFieldDef(raw.id, raw.name ?? 'Field', (FIELD_KINDS.map(k => k.kind)).includes(raw.kind as FieldKind) ? raw.kind as FieldKind : 'text')
  const f: FieldDef = { ...base, ...raw, kind: base.kind }
  f.refTargets = Array.isArray(f.refTargets) ? f.refTargets : []
  f.options = Array.isArray(f.options) ? f.options.filter(o => typeof o === 'string') : []
  f.children = Array.isArray(f.children) ? f.children.filter(c => typeof c === 'string') : []
  f.template = typeof f.template === 'string' ? f.template : ''
  f.formula = typeof f.formula === 'string' ? f.formula : ''
  f.parentId ??= null
  f.defaultValue = coerceValue(f, f.defaultValue)
  return f
}

/** Name to show next to a value; '' when the field hides it. */
export const fieldLabel = (f: FieldDef) => (f.showName ? f.name : '')

// ---------------------------------------------------------------- composites

/** The group a field sits in, if any. */
export const parentOf = (p: Project, f: FieldDef): FieldDef | undefined => (f.parentId ? p.fields.find(x => x.id === f.parentId && x.kind === 'group') : undefined)

/** Direct children of a group, in its declared order (only fields that still exist and point back). */
export function childrenOf(p: Project, group: FieldDef): FieldDef[] {
  if (group.kind !== 'group') return []
  return (group.children ?? []).map(id => p.fields.find(f => f.id === id)).filter((f): f is FieldDef => !!f && f.parentId === group.id)
}

/** Every field below a group, depth-first. */
export function descendantsOf(p: Project, group: FieldDef): FieldDef[] {
  const out: FieldDef[] = []
  const walk = (g: FieldDef, depth: number) => {
    if (depth > 16) return
    for (const c of childrenOf(p, g)) { out.push(c); if (c.kind === 'group') walk(c, depth + 1) }
  }
  walk(group, 0)
  return out
}

/** The top-level field a child ultimately belongs to (itself when top-level). */
export function rootOf(p: Project, f: FieldDef): FieldDef {
  let cur = f
  const seen = new Set<Id>()
  while (cur.parentId && !seen.has(cur.id)) {
    seen.add(cur.id)
    const par = parentOf(p, cur)
    if (!par) break
    cur = par
  }
  return cur
}

/** "Scope · done" for a child field, the plain name otherwise. */
export function fieldDisplayName(p: Project, f: FieldDef): string {
  const chain: string[] = [f.name]
  let cur = f
  const seen = new Set<Id>()
  while (cur.parentId && !seen.has(cur.id)) {
    seen.add(cur.id)
    const par = parentOf(p, cur)
    if (!par) break
    chain.unshift(par.name)
    cur = par
  }
  return chain.join(' · ')
}

/** Top-level fields only (children are reached through their group). */
export const rootFields = (p: Project): FieldDef[] => p.fields.filter(f => !parentOf(p, f))

/**
 * Attachments with every group expanded in place: the group entry, then one
 * entry per child (recursively) whose attachment carries the child default
 * from the group attachment's `childDefaults`. `group` names the child's
 * parent so display code can box children under it.
 */
export function expandAttachments<T extends { att: FieldAttachment; field: FieldDef }>(p: Project, list: T[]): (T & { group: FieldDef | null })[] {
  const out: (T & { group: FieldDef | null })[] = []
  const push = (entry: T, group: FieldDef | null, depth: number) => {
    out.push({ ...entry, group })
    if (entry.field.kind !== 'group' || depth > 16) return
    for (const child of childrenOf(p, entry.field)) {
      const childAtt: FieldAttachment = { fieldId: child.id, defaultValue: entry.att.childDefaults?.[child.id] ?? null }
      push({ ...entry, att: childAtt, field: child }, entry.field, depth + 1)
    }
  }
  for (const e of list) push(e, null, 0)
  return out
}

export const fieldById = (p: Project, id: Id | null | undefined) => (id ? p.fields.find(f => f.id === id) : undefined)
export const processorById = (p: Project, id: Id | null | undefined) => (id ? p.processors.find(f => f.id === id) : undefined)
export const levelOf = (p: Project, s: Section): HierarchyLevel | undefined => p.hierarchyLevels[s.depth]
export const levelById = (p: Project, id: Id) => p.hierarchyLevels.find(l => l.id === id)

export type Owner = { kind: 'item'; entity: Item } | { kind: 'section'; entity: Section }

/** The item or section with this id; on a timeline view, entries of the other timelines resolve too. */
export function ownerOf(p: Project, id: Id): Owner | null {
  const it = p.items.find(i => i.id === id)
  if (it) return { kind: 'item', entity: it }
  const sc = p.sections.find(s => s.id === id)
  if (sc) return { kind: 'section', entity: sc }
  const whole = wholeOf(p)
  return whole === p ? null : ownerOf(whole, id)
}

/** An attachment resolved for a type: `from` is the folder it is inherited from, null for the type's own. */
export interface TypeAttachment {
  att: FieldAttachment
  field: FieldDef
  from: TypeFolder | null
}

/**
 * Every field an item of `type` carries: the attachments of each ancestor
 * folder (outermost first) followed by the type's own. When the same field is
 * attached more than once along that chain the nearest attachment wins (so a
 * type or sub-folder can override an inherited default) but the field keeps
 * the position where it first appeared.
 */
export function typeAttachments(p: Project, type: ItemType | undefined): (TypeAttachment & { group: FieldDef | null })[] {
  if (!type) return []
  const out: TypeAttachment[] = []
  const index = new Map<Id, number>()
  const add = (list: FieldAttachment[] | undefined, from: TypeFolder | null) => {
    for (const att of list ?? []) {
      const field = fieldById(p, att.fieldId)
      if (!field || parentOf(p, field)) continue
      const i = index.get(att.fieldId)
      if (i === undefined) { index.set(att.fieldId, out.length); out.push({ att, field, from }) }
      else out[i] = { att, field, from }
    }
  }
  for (const f of folderChain(p, type.folderId ?? null)) add(f.fields, f)
  add(type.fields, null)
  return expandAttachments(p, out)
}

/** Fields attached to a section's level, with their definitions (groups expanded). */
export function levelAttachments(p: Project, level: HierarchyLevel | undefined): { att: FieldAttachment; field: FieldDef; group: FieldDef | null }[] {
  const out: { att: FieldAttachment; field: FieldDef }[] = []
  for (const att of level?.fields ?? []) {
    const field = fieldById(p, att.fieldId)
    if (field && !parentOf(p, field)) out.push({ att, field })
  }
  return expandAttachments(p, out)
}

/**
 * Fields attached to an item's type (including its folders) or a section's
 * level, with their definitions. Groups come expanded: the group entry is
 * followed by its children (`group` = the parent), so a plain walk sees every
 * field that can hold a value.
 */
export function attachmentsFor(p: Project, owner: Owner): { att: FieldAttachment; field: FieldDef; group: FieldDef | null }[] {
  if (owner.kind === 'item') return typeAttachments(p, p.types.find(t => t.id === owner.entity.typeId))
  return levelAttachments(p, levelOf(p, owner.entity))
}

/**
 * A composite's one-line text for an entity: its template with `{child}`
 * placeholders filled from the children's values, or, without a template,
 * "done 3 · total 10". Empty when no child has a value.
 */
export function groupText(p: Project, owner: Owner, group: FieldDef, read: (field: FieldDef) => FieldValue | null = f => valueOn(p, owner, f)): string {
  const kids = childrenOf(p, group)
  const texts = kids.map(c => ({ c, text: c.kind === 'group' ? groupText(p, owner, c, read) : formatValue(p, c, read(c)) }))
  if (texts.every(x => !x.text.trim())) return ''
  const tpl = group.template?.trim() ?? ''
  if (tpl) {
    return tpl.replace(/\{([^}]+)\}/g, (_, raw: string) => {
      const key = raw.trim().toLowerCase()
      const hit = texts.find(x => x.c.name.trim().toLowerCase() === key || x.c.id === raw.trim())
      return hit ? hit.text : ''
    })
  }
  return texts.filter(x => x.text.trim()).map(x => (x.c.showName ? `${x.c.name} ${x.text}` : x.text)).join(' · ')
}

/** Project fields in sidebar order: root fields, then each field folder's fields depth-first. */
export const orderedFields = (p: Project): FieldDef[] => orderedMembers(p, 'fields', p.fields)

/**
 * Attachments grouped by the field's sidebar folder, in sidebar order: the
 * root group (folder null) first, then one group per folder that has any of
 * the fields. Display code (inspector, exports) renders a heading per group.
 */
export function groupAttachments<T extends { field: FieldDef }>(p: Project, list: T[]): { folder: Folder | null; entries: T[] }[] {
  const byId = new Map(list.map(x => [x.field.id, x]))
  // Children sit in their root field's folder.
  const members = list.map(x => ({ id: x.field.id, name: x.field.name, folderId: rootOf(p, x.field).folderId ?? null }))
  return groupedMembers(p, 'fields', members)
    .map(g => ({ folder: g.folder, entries: g.members.map(f => byId.get(f.id)!) }))
}

/** One line of display text per field for labels, tooltips and documents. */
export interface DisplayEntry {
  field: FieldDef
  /** The composite this entry belongs to, when it is a child shown on its own. */
  group: FieldDef | null
  /** Name to print (empty when the field hides its name). */
  label: string
  text: string
}

/**
 * What an entity's fields read as, in attachment order: a composite with a
 * template becomes one entry, one without lists its children individually
 * (labelled "Group · child"); hidden fields (`skip`) are left out along with
 * their children.
 */
export function displayEntries(
  p: Project,
  owner: Owner,
  opts: { skip?: (field: FieldDef) => boolean; read?: (field: FieldDef, att: FieldAttachment) => FieldValue | null } = {},
): DisplayEntry[] {
  const out: DisplayEntry[] = []
  const read = opts.read ?? ((field, att) => readValue(p, owner, field, att))
  const hiddenGroups = new Set<Id>()
  for (const e of attachmentsFor(p, owner)) {
    if (e.group && hiddenGroups.has(e.group.id)) { if (e.field.kind === 'group') hiddenGroups.add(e.field.id); continue }
    if (opts.skip?.(e.field)) { if (e.field.kind === 'group') hiddenGroups.add(e.field.id); continue }
    if (e.field.kind === 'group') {
      if (!e.field.template?.trim()) continue
      hiddenGroups.add(e.field.id)
      const text = groupText(p, owner, e.field, f => {
        const att = attachmentsFor(p, owner).find(a => a.field.id === f.id)?.att ?? null
        return att ? read(f, att) : null
      })
      if (text.trim()) out.push({ field: e.field, group: e.group, label: fieldLabel(e.field), text })
      continue
    }
    const text = formatValue(p, e.field, read(e.field, e.att))
    if (!text.trim()) continue
    const label = e.field.showName ? (e.group ? `${e.group.name} · ${e.field.name}` : e.field.name) : ''
    out.push({ field: e.field, group: e.group, label, text })
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

/**
 * What a field reads as on an owner: a derived field's formula result
 * (computed on read, coerced to the field's kind), else the explicit value or
 * the attachment / field default.
 */
export function readValue(p: Project, owner: Owner, field: FieldDef, att: FieldAttachment | null | undefined): FieldValue | null {
  if (isDerived(field)) return derivedValue(p, owner, field)
  return effectiveValue(field, att, owner.entity.fieldValues?.[field.id])
}

/** Effective value of `field` on an owner (looks up the attachment for the default; derived fields compute). */
export function valueOn(p: Project, owner: Owner, field: FieldDef): FieldValue | null {
  const att = attachmentsFor(p, owner).find(a => a.field.id === field.id)?.att ?? null
  return readValue(p, owner, field, att)
}

/** Derived-field evaluations in flight, so a formula that (indirectly) reads itself yields null instead of looping. */
const evaluating = new Set<string>()

/** A derived field's value on an owner: its formula evaluated against the owner's other fields, coerced to its kind. */
export function derivedValue(p: Project, owner: Owner, field: FieldDef): FieldValue | null {
  const key = `${owner.entity.id}:${field.id}`
  if (evaluating.has(key)) return null
  evaluating.add(key)
  try {
    const parent = parentOf(p, field)
    const siblings = parent ? childrenOf(p, parent).filter(c => c.id !== field.id) : []
    const raw = evalOn(p, owner, field.formula ?? '', f => valueOn(p, owner, f) as Value, siblings)
    if (raw === null || raw === undefined) return null
    if (field.kind === 'toggle') return parseToggle(raw)
    if (isNumberKind(field.kind)) {
      const n = typeof raw === 'number' ? raw : typeof raw === 'boolean' ? (raw ? 1 : 0) : Number(String(raw).trim().replace(',', '.'))
      return Number.isFinite(n) ? clampValue(field, n) : null
    }
    if (field.kind === 'text') {
      const s = Array.isArray(raw) ? raw.join(', ') : typeof raw === 'boolean' ? formatToggle(raw) : typeof raw === 'number' ? String(Number(raw.toFixed(6))) : String(raw)
      return s === '' ? null : clampValue(field, s)
    }
    // select / ref: a derived value must name existing options / ids.
    return clampValue(field, coerceValue(field, Array.isArray(raw) ? raw : String(raw)))
  } finally {
    evaluating.delete(key)
  }
}

/** Glyph for a field row: ƒ for derived fields, else the kind's glyph. */
export const glyphFor = (f: FieldDef) => (isDerived(f) ? 'ƒ' : kindGlyph(f.kind))

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
    case 'toggle': return parseToggle(v)
    case 'select':
    case 'ref': {
      if (Array.isArray(v)) { const ids = v.filter(x => typeof x === 'string'); return ids.length ? ids : null }
      return typeof v === 'string' && v ? [v] : null
    }
    case 'group': return null
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
    case 'toggle': return parseToggle(v)
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
    case 'group': return null
  }
}

/** Parse what a user typed for a field; null when empty/unparseable. */
export function parseInput(field: FieldDef, text: string): FieldValue | null {
  const t = text.trim()
  if (!t) return null
  if (field.kind === 'text') return text
  if (isNumberKind(field.kind)) { const n = Number(t.replace(',', '.')); return Number.isFinite(n) ? n : null }
  if (field.kind === 'toggle') return parseToggle(t)
  if (field.kind === 'group') return null
  return [t]
}

const TOGGLE_ON = new Set(['true', 'yes', 'y', 'on', '1', 'x', '✓'])
const TOGGLE_OFF = new Set(['false', 'no', 'n', 'off', '0'])

/** Read a toggle from a boolean, a number (non-zero = on) or a yes/no-ish word; null when unreadable. */
export function parseToggle(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isFinite(v) ? v !== 0 : null
  if (typeof v !== 'string') return null
  const t = v.trim().toLowerCase()
  if (TOGGLE_ON.has(t)) return true
  if (TOGGLE_OFF.has(t)) return false
  return null
}

export const formatToggle = (on: boolean) => (on ? 'Yes' : 'No')

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
    case 'toggle': return formatToggle(v === true)
    case 'select': return (Array.isArray(v) ? v : [String(v)]).join(', ')
    case 'ref': return (Array.isArray(v) ? v : [String(v)]).map(id => entityTitle(p, id)).join(', ')
    case 'group': return ''
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
  if (to === 'ref' || from === 'ref' || to === 'group' || from === 'group') return null
  // Toggle: yes/no words and non-zero numbers read as on; it writes back as Yes/No text or 1/0.
  if (to === 'toggle') return from === 'select' ? null : parseToggle(v)
  if (from === 'toggle') {
    const on = v === true
    if (to === 'text') return formatToggle(on)
    if (to === 'select') return null
    return on ? 1 : 0
  }
  // Dropdown ↔ text: choices become a comma list and back (unknown choices are dropped by clampValue).
  if (from === 'select') { const s = (Array.isArray(v) ? v : [String(v)]).join(', '); return to === 'text' ? s : null }
  if (to === 'select') return typeof v === 'string' ? v.split(',').map(x => x.trim()).filter(Boolean) : null
  if (to === 'text') return String(v)
  const n = typeof v === 'number' ? v : Number(String(v).trim().replace(',', '.'))
  if (!Number.isFinite(n)) return null
  return to === 'int' ? Math.round(n) : n
}

/** Everything a field touches: attachments (through its root group for children), explicit values and processors. */
export function fieldUsage(p: Project, fieldId: Id) {
  const field = fieldById(p, fieldId)
  const rootId = field ? rootOf(p, field).id : fieldId
  const types = p.types.filter(t => t.fields.some(a => a.fieldId === rootId))
  const folders = p.typeFolders.filter(f => (f.fields ?? []).some(a => a.fieldId === rootId))
  const levels = p.hierarchyLevels.filter(l => l.fields.some(a => a.fieldId === rootId))
  // A group's stored values are its descendants'.
  const ids = new Set([fieldId, ...(field && field.kind === 'group' ? descendantsOf(p, field).map(f => f.id) : [])])
  const has = (rec: Record<Id, FieldValue> | undefined) => !!rec && [...ids].some(id => rec[id] !== undefined)
  const items = p.items.filter(it => has(it.fieldValues))
  const sections = p.sections.filter(sc => has(sc.fieldValues))
  const processors = p.processors.filter(pr => pr.fieldId !== null && ids.has(pr.fieldId))
  return { types, folders, levels, items, sections, processors }
}

/** Detach a field everywhere and drop its values (a group takes its children along); processors using it lose their field. */
export function removeField(p: Project, fieldId: Id) {
  const field = fieldById(p, fieldId)
  const ids = [fieldId, ...(field && field.kind === 'group' ? descendantsOf(p, field).map(f => f.id) : [])]
  const gone = new Set(ids)
  p.fields = p.fields.filter(f => !gone.has(f.id))
  for (const f of p.fields) if (f.kind === 'group' && f.children) f.children = f.children.filter(id => !gone.has(id))
  for (const t of p.types) t.fields = t.fields.filter(a => !gone.has(a.fieldId))
  for (const f of p.typeFolders) if (f.fields) f.fields = f.fields.filter(a => !gone.has(a.fieldId))
  for (const l of p.hierarchyLevels) l.fields = l.fields.filter(a => !gone.has(a.fieldId))
  for (const it of p.items) for (const id of ids) delete it.fieldValues[id]
  for (const sc of p.sections) for (const id of ids) delete sc.fieldValues[id]
  for (const pr of p.processors) if (pr.fieldId && gone.has(pr.fieldId)) pr.fieldId = null
}

/** File `fieldId` into `groupId` (null = make it top-level) at the end of the group's children. */
export function moveIntoGroup(p: Project, fieldId: Id, groupId: Id | null) {
  const f = fieldById(p, fieldId)
  if (!f) return
  if (groupId) {
    const g = fieldById(p, groupId)
    if (!g || g.kind !== 'group' || g.id === f.id) return
    // Never nest a group inside its own descendant.
    if (f.kind === 'group' && descendantsOf(p, f).some(d => d.id === g.id)) return
  }
  for (const g of p.fields) if (g.kind === 'group' && g.children) g.children = g.children.filter(id => id !== fieldId)
  f.parentId = groupId
  if (groupId) {
    const g = fieldById(p, groupId)!
    g.children = [...(g.children ?? []), fieldId]
    // A child lives in its group's folder; attachments of its own are dropped (it is attached through the group now).
    f.folderId = null
    for (const t of p.types) t.fields = t.fields.filter(a => a.fieldId !== fieldId)
    for (const fo of p.typeFolders) if (fo.fields) fo.fields = fo.fields.filter(a => a.fieldId !== fieldId)
    for (const l of p.hierarchyLevels) l.fields = l.fields.filter(a => a.fieldId !== fieldId)
  }
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
  for (const fo of p.typeFolders) for (const a of fo.fields ?? []) if (a.fieldId === fieldId) a.defaultValue = convertValue(from, to, a.defaultValue)
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

/** Sections enclosing a position on one timeline, outermost first. */
export function sectionsAt(p: Project, pos: number, exclude?: Id, timelineId?: Id): Section[] {
  const eps = 1e-9
  return p.sections
    .filter(s => s.id !== exclude && (!timelineId || s.timelineId === timelineId) && s.start <= pos + eps && s.end >= pos - eps)
    .sort((a, b) => a.depth - b.depth)
}

/** Settings of the timeline an entity lives on (falls back to the project's view). */
function settingsFor(p: Project, timelineId: Id): TimelineSettings {
  return p.timelines?.find(t => t.id === timelineId)?.settings ?? p.settings
}

/**
 * Enclosing-section breadcrumb + position, e.g. "Chapter 1 › The drop · 12".
 * With several timelines the entity's timeline leads: "Level 2 › Chapter 1 · 12".
 */
export function locationOf(p: Project, o: Owner): string {
  const tid = o.entity.timelineId
  const st = settingsFor(p, tid)
  const suffix = unitSuffix(st.unit.preset, st.unit.custom)
  const fmt = (v: number) => formatUnit(v, Math.max(Math.abs(v), 0.01), suffix, st.unit.preset)
  const tl = (p.timelines?.length ?? 0) > 1 ? [p.timelines.find(t => t.id === tid)?.name ?? 'Timeline'] : []
  if (o.kind === 'item') {
    const chain = [...tl, ...sectionsAt(p, o.entity.pos, undefined, tid).map(s => s.name || '…')]
    return `${chain.length ? chain.join(' › ') + ' · ' : ''}${fmt(o.entity.pos)}`
  }
  const s = o.entity
  const eps = 1e-9
  const parents = p.sections
    .filter(t => t.id !== s.id && t.timelineId === tid && t.depth < s.depth && t.start <= s.start + eps && t.end >= s.end - eps)
    .sort((a, b) => a.depth - b.depth)
    .map(t => t.name || '…')
  const where = [...tl, ...parents]
  const level = levelOf(p, s)?.name ?? 'Section'
  return `${level}${where.length ? ' in ' + where.join(' › ') : ''} · ${fmt(s.start)} – ${fmt(s.end)}`
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

/**
 * Everything a reference field may point at, across every timeline of the
 * project: the active timeline's entries first (in timeline order), then the
 * other timelines in tab order.
 */
export function refCandidates(p: Project, field: FieldDef, excludeId?: Id): RefCandidate[] {
  const out: RefCandidate[] = []
  const order = new Map<Id, number>()
  const active = p.activeTimelineId ?? p.timelines?.[0]?.id
  ;(p.timelines ?? []).forEach((t, i) => order.set(t.id, t.id === active ? -1 : i))
  const rank = (tid: Id) => (order.get(tid) ?? p.timelines.length) * 1e9
  for (const it of p.items) {
    if (it.id === excludeId) continue
    const o: Owner = { kind: 'item', entity: it }
    if (!allowsTarget(p, field, o)) continue
    const t = p.types.find(x => x.id === it.typeId)
    out.push({
      id: it.id, owner: o, title: it.title || 'Untitled', typeName: t?.name ?? 'Item',
      color: t?.color ?? '#888', icon: t?.icon ?? 'Circle', location: locationOf(p, o),
      description: it.description, sortKey: rank(it.timelineId) + it.pos,
    })
  }
  for (const sc of p.sections) {
    if (sc.id === excludeId) continue
    const o: Owner = { kind: 'section', entity: sc }
    if (!allowsTarget(p, field, o)) continue
    out.push({
      id: sc.id, owner: o, title: sc.name || 'Untitled section', typeName: levelOf(p, sc)?.name ?? 'Section',
      color: '#8b91a0', icon: 'RectangleHorizontal', location: locationOf(p, o),
      description: sc.description ?? '', sortKey: rank(sc.timelineId) + sc.start - 1e-6,
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
  for (const fo of p.typeFolders) for (const a of fo.fields ?? []) if (refIds.has(a.fieldId)) a.defaultValue = cleanDefault(a.defaultValue)
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
  // Composites: children lists hold only existing fields that point back, a
  // field belongs to at most one group, groups never contain an ancestor.
  const byId = new Map(p.fields.map(f => [f.id, f]))
  const owned = new Set<Id>()
  for (const g of p.fields) {
    if (g.kind !== 'group') { if (g.children?.length) g.children = []; continue }
    const kids: Id[] = []
    for (const id of g.children ?? []) {
      const c = byId.get(id)
      if (!c || c.id === g.id || owned.has(id) || kids.includes(id)) continue
      // Cycle check: g must not sit below c.
      let cur: FieldDef | undefined = g
      let cyc = false
      const seen = new Set<Id>()
      while (cur?.parentId && !seen.has(cur.id)) { seen.add(cur.id); if (cur.parentId === c.id) { cyc = true; break } cur = byId.get(cur.parentId) }
      if (cyc) continue
      kids.push(id)
      owned.add(id)
    }
    if (kids.join('\n') !== (g.children ?? []).join('\n')) g.children = kids
  }
  for (const f of p.fields) {
    const want = [...p.fields].find(g => g.kind === 'group' && g.children?.includes(f.id))?.id ?? null
    if ((f.parentId ?? null) !== want) f.parentId = want
  }
  const dedupeFields = (list: FieldAttachment[]) => {
    const seen = new Set<Id>()
    return list.filter(a => fieldIds.has(a.fieldId) && !seen.has(a.fieldId) && seen.add(a.fieldId))
  }
  for (const t of p.types) t.fields = dedupeFields(t.fields)
  for (const f of p.typeFolders) f.fields = dedupeFields(f.fields ?? [])
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

/** Types/levels that carry a field (children count through their root group), for display. */
export function attachedToNames(p: Project, fieldId: Id): string[] {
  const field = fieldById(p, fieldId)
  const id = field ? rootOf(p, field).id : fieldId
  return [
    ...p.types.filter(t => t.fields.some(a => a.fieldId === id)).map(t => t.name),
    ...p.typeFolders.filter(f => (f.fields ?? []).some(a => a.fieldId === id)).map(f => `${f.name}/`),
    ...p.hierarchyLevels.filter(l => l.fields.some(a => a.fieldId === id)).map(l => l.name),
  ]
}
