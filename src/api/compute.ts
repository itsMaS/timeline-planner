import { attachmentsFor, isDerived, readValue, type Owner } from '../model/fields'
import { compile, evaluate, truthy } from '../model/expr'
import { processorResults } from '../model/processors'
import { entityScope } from '../model/scope'
import { normalizeProject } from '../model/normalize'
import { timelineView } from '../model/timelines'
import type { FieldValue, Id, Project } from '../model/types'

/**
 * Read-side helpers over a whole stored document, shared by the `api-query`
 * Edge Function and the agent CLI: evaluate a rule expression against every
 * item, and compute what is never stored (derived fields, processor results).
 * Pure: the document is normalised on a copy and never written back.
 */

export interface ComputedDoc {
  /** item id → derived field id → value (only derived fields the item carries, only non-null values). */
  items: Record<Id, Record<Id, FieldValue>>
  /** section id → { fields: derived values, processors: processor id → { text, value } } */
  sections: Record<Id, { fields: Record<Id, FieldValue>; processors: Record<Id, { text: string; value: number | null; matched: Id[]; contributions: Record<Id, FieldValue> }> }>
}

/** A normalised working copy of a raw stored document. */
export function prepare(raw: unknown): Project {
  return normalizeProject(structuredClone(raw) as Project)
}

/** Ids of the items (on every timeline, or the given ones) that satisfy the rule; throws on a parse error. */
export function queryItems(p: Project, rules: string, timelineIds?: Id[]): Id[] {
  const src = rules.trim()
  const { ast, error } = compile(src)
  if (error) throw new Error(`Bad query: ${error}`)
  const tl = timelineIds?.length ? new Set(timelineIds) : null
  const out: Id[] = []
  for (const it of p.items) {
    if (tl && !tl.has(it.timelineId)) continue
    if (!ast) { out.push(it.id); continue }
    const view = timelineView(p, it.timelineId)
    if (truthy(evaluate(ast, entityScope(view, { kind: 'item', entity: it })))) out.push(it.id)
  }
  return out
}

/** Derived field values and processor results for the whole document. */
export function computeDoc(p: Project): ComputedDoc {
  const out: ComputedDoc = { items: {}, sections: {} }
  const derivedOn = (view: Project, owner: Owner): Record<Id, FieldValue> => {
    const vals: Record<Id, FieldValue> = {}
    for (const { att, field } of attachmentsFor(view, owner)) {
      if (!isDerived(field)) continue
      const v = readValue(view, owner, field, att)
      if (v !== null) vals[field.id] = v
    }
    return vals
  }
  for (const it of p.items) {
    const view = timelineView(p, it.timelineId)
    const vals = derivedOn(view, { kind: 'item', entity: it })
    if (Object.keys(vals).length) out.items[it.id] = vals
  }
  for (const sc of p.sections) {
    const view = timelineView(p, sc.timelineId)
    const fields = derivedOn(view, { kind: 'section', entity: sc })
    const processors: ComputedDoc['sections'][Id]['processors'] = {}
    for (const r of processorResults(view, sc)) {
      if (r.error) continue
      const n = Number(String(r.text).replace(/[^\d.,-].*$/, '').replace(',', '.'))
      const contributions: Record<Id, FieldValue> = {}
      r.matched.forEach((o, i) => { const v = r.values[i]; if (v !== null && v !== undefined) contributions[o.entity.id] = v })
      processors[r.proc.id] = { text: r.text, value: Number.isFinite(n) ? n : null, matched: r.matched.map(o => o.entity.id), contributions }
    }
    if (Object.keys(fields).length || Object.keys(processors).length) out.sections[sc.id] = { fields, processors }
  }
  return out
}
