import { compile, evaluate, truthy, type Scope, type Value } from './expr'
import { attachmentsFor, entityTitle, groupText, levelOf, sectionsAt, valueOn, type Owner } from './fields'
import type { FieldDef, FieldValue, Item, Project, Section } from './types'

/**
 * What an expression sees when evaluated against an item or a section: the
 * entity's attached fields by name (case-insensitive), then a few built-ins.
 * Field names win over built-ins, so a field called "Type" shadows the item
 * type name; use [brackets] or the built-in's alias (`$type`) to disambiguate.
 */

const ITEM_BUILTINS = ['title', 'type', 'tags', 'layer', 'pos', 'duration', 'end', 'description', 'link', 'id', 'section', 'sections', 'created by'] as const
const SECTION_BUILTINS = ['name', 'title', 'level', 'start', 'end', 'length', 'description', 'id', 'parent', 'sections'] as const

/** Names an expression may use on items / sections besides the fields, for pickers and docs. */
export const builtinNames = (kind: 'item' | 'section'): readonly string[] => (kind === 'item' ? ITEM_BUILTINS : SECTION_BUILTINS)

function itemBuiltin(p: Project, it: Item, name: string): { found: boolean; value: Value } {
  switch (name) {
    case 'title': return { found: true, value: it.title }
    case 'type': return { found: true, value: p.types.find(t => t.id === it.typeId)?.name ?? null }
    case 'tags': return { found: true, value: it.tags }
    case 'layer': { const lid = it.layerId ?? p.types.find(t => t.id === it.typeId)?.defaultLayerId; return { found: true, value: p.layers.find(l => l.id === lid)?.name ?? null } }
    case 'pos': return { found: true, value: it.pos }
    case 'duration': return { found: true, value: it.duration }
    case 'end': return { found: true, value: it.pos + it.duration }
    case 'description': return { found: true, value: it.description }
    case 'link': return { found: true, value: it.link }
    case 'id': return { found: true, value: it.id }
    case 'section': { const chain = sectionsAt(p, it.pos); return { found: true, value: chain.length ? chain[chain.length - 1].name : null } }
    case 'sections': return { found: true, value: sectionsAt(p, it.pos).map(s => s.name) }
    case 'created by': return { found: true, value: it.createdBy?.name ?? null }
  }
  return { found: false, value: null }
}

function sectionBuiltin(p: Project, sc: Section, name: string): { found: boolean; value: Value } {
  switch (name) {
    case 'name':
    case 'title': return { found: true, value: sc.name }
    case 'level': return { found: true, value: levelOf(p, sc)?.name ?? null }
    case 'start': return { found: true, value: sc.start }
    case 'end': return { found: true, value: sc.end }
    case 'length': return { found: true, value: sc.end - sc.start }
    case 'description': return { found: true, value: sc.description ?? '' }
    case 'id': return { found: true, value: sc.id }
    case 'parent': {
      const parents = p.sections.filter(t => t.id !== sc.id && t.depth < sc.depth && t.start <= sc.start + 1e-9 && t.end >= sc.end - 1e-9).sort((a, b) => b.depth - a.depth)
      return { found: true, value: parents[0]?.name ?? null }
    }
    case 'sections': {
      const parents = p.sections.filter(t => t.id !== sc.id && t.depth < sc.depth && t.start <= sc.start + 1e-9 && t.end >= sc.end - 1e-9).sort((a, b) => a.depth - b.depth)
      return { found: true, value: parents.map(t => t.name) }
    }
  }
  return { found: false, value: null }
}

/** Reference values read as the titles of what they point at, so `Blocked by contains "Boss"` works. */
function fieldValueFor(p: Project, field: FieldDef, v: Value): Value {
  if (field.kind === 'ref' && Array.isArray(v)) return v.map(id => entityTitle(p, id))
  return v
}

/**
 * Resolver for one entity. `read` overrides how a field's value is produced
 * (derived fields plug in there); by default it is the effective stored value.
 */
export function entityScope(
  p: Project,
  owner: Owner,
  read: (field: FieldDef) => Value = field => valueOn(p, owner, field) as Value,
  /** Names to resolve first (a derived field's siblings inside its composite). */
  prefer: FieldDef[] = [],
): Scope {
  const atts = attachmentsFor(p, owner)
  const byName = new Map<string, FieldDef>()
  const key = (s: string) => s.trim().toLowerCase()
  for (const f of prefer) if (!byName.has(key(f.name))) byName.set(key(f.name), f)
  for (const { field, group } of atts) {
    if (!byName.has(key(field.name))) byName.set(key(field.name), field)
    // Children also answer to "Group.child" and "Group · child".
    if (group) {
      const dotted = `${key(group.name)}.${key(field.name)}`
      if (!byName.has(dotted)) byName.set(dotted, field)
      byName.set(`${key(group.name)} · ${key(field.name)}`, field)
    }
  }
  const valueOf = (f: FieldDef): Value => {
    if (f.kind === 'group') { const t = groupText(p, owner, f, c => read(c) as FieldValue | null); return t || null }
    return fieldValueFor(p, f, read(f))
  }
  return {
    get: raw => {
      const name = key(raw)
      const alias = name.startsWith('$') ? name.slice(1) : null
      if (!alias) {
        const f = byName.get(name)
        if (f) return { found: true, value: valueOf(f) }
        // A field that exists in the project but is not attached here reads as unset (not as text).
        if (p.fields.some(x => key(x.name) === name)) return { found: true, value: null }
      }
      const k = alias ?? name
      return owner.kind === 'item' ? itemBuiltin(p, owner.entity, k) : sectionBuiltin(p, owner.entity, k)
    },
  }
}

/** True when the rule text is empty, fails to parse, or evaluates truthy for the entity. */
export function matchesRule(p: Project, owner: Owner, rules: string | undefined): boolean {
  if (!rules?.trim()) return true
  const { ast } = compile(rules)
  if (!ast) return true
  try { return truthy(evaluate(ast, entityScope(p, owner))) } catch { return true }
}

/** Evaluate an expression against an entity; null on parse or runtime error. */
export function evalOn(p: Project, owner: Owner, src: string, read?: (field: FieldDef) => Value, prefer?: FieldDef[]): Value {
  const { ast } = compile(src)
  if (!ast) return null
  try { return evaluate(ast, entityScope(p, owner, read, prefer)) } catch { return null }
}
