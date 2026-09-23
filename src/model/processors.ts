import { attachmentsFor, effectiveValue, entityTitle, fieldById, formatNumber, formatToggle, isNumberKind, levelOf, type Owner } from './fields'
import type { FieldValue, Id, ProcessorAttachment, ProcessorDef, ProcessorOp, Project, Section } from './types'

/**
 * Processors aggregate the entities inside a section: every item whose
 * position lies in the section's range plus every section nested inside it.
 * Pure functions, evaluated on read.
 */

export const PROCESSOR_OPS: { op: ProcessorOp; label: string; needsField: 'number' | 'any' | 'none' }[] = [
  { op: 'sum', label: 'Sum', needsField: 'number' }, // toggles sum too: the number switched on
  { op: 'count', label: 'Count', needsField: 'none' },
  { op: 'avg', label: 'Average', needsField: 'number' },
  { op: 'min', label: 'Minimum', needsField: 'number' },
  { op: 'max', label: 'Maximum', needsField: 'number' },
  { op: 'distinct', label: 'Distinct values', needsField: 'any' },
]

export const opLabel = (op: ProcessorOp) => PROCESSOR_OPS.find(o => o.op === op)?.label ?? op

export interface ProcessorResult {
  proc: ProcessorDef
  att: ProcessorAttachment | null
  /** Short display text, e.g. "27 coins" or "3". */
  text: string
  /** Entities that contributed. */
  matched: Owner[]
  error?: string
}

/** Items and nested sections inside `section` (item start inside the range), on the section's own timeline. */
export function entitiesInside(p: Project, section: Section): Owner[] {
  const eps = 1e-9
  const out: Owner[] = []
  for (const it of p.items) {
    if (it.timelineId !== section.timelineId) continue
    if (it.pos >= section.start - eps && it.pos <= section.end + eps) out.push({ kind: 'item', entity: it })
  }
  for (const sc of p.sections) {
    if (sc.id === section.id || sc.timelineId !== section.timelineId) continue
    if (sc.depth > section.depth && sc.start >= section.start - eps && sc.end <= section.end + eps) out.push({ kind: 'section', entity: sc })
  }
  return out
}

export function evalProcessor(p: Project, section: Section, proc: ProcessorDef, att: ProcessorAttachment | null = null): ProcessorResult {
  const field = fieldById(p, proc.fieldId)
  const spec = PROCESSOR_OPS.find(o => o.op === proc.op)!
  if (spec.needsField !== 'none' && !field) return { proc, att, text: '—', matched: [], error: 'needs a field' }
  if (spec.needsField === 'number' && field && !isNumberKind(field.kind) && !(proc.op === 'sum' && field.kind === 'toggle')) {
    return { proc, att, text: '—', matched: [], error: 'needs a number field' }
  }

  const targets = new Set(proc.targets)
  const inside = entitiesInside(p, section)
  const matched: Owner[] = []
  const values: FieldValue[] = []
  for (const o of inside) {
    const key = o.kind === 'item' ? o.entity.typeId : levelOf(p, o.entity)?.id
    if (targets.size) { if (!key || !targets.has(key)) continue }
    else if (proc.op === 'count' && o.kind === 'section') continue // bare count = items only
    if (field) {
      const a = attachmentsFor(p, o).find(x => x.field.id === field.id)
      if (!a) continue
      const v = effectiveValue(field, a.att, o.entity.fieldValues?.[field.id])
      if (v === null) continue
      values.push(v)
    }
    matched.push(o)
  }

  let text: string
  switch (proc.op) {
    case 'count': text = String(matched.length); break
    case 'distinct': {
      const set = new Set<string>()
      for (const v of values) {
        if (Array.isArray(v)) for (const x of v) set.add(field?.kind === 'ref' ? entityTitle(p, x) : x)
        else if (field?.kind === 'toggle') set.add(formatToggle(v === true))
        else set.add(field && isNumberKind(field.kind) ? formatNumber(field, Number(v)) : String(v))
      }
      const list = [...set]
      text = list.length ? `${list.length}: ${list.join(', ')}` : '0'
      break
    }
    default: {
      if (field?.kind === 'toggle') { text = String(values.filter(v => v === true).length); break }
      const nums = values.map(Number).filter(Number.isFinite)
      if (!nums.length) { text = field ? formatNumber(field, 0) : '0'; break }
      let n: number
      if (proc.op === 'sum') n = nums.reduce((a, b) => a + b, 0)
      else if (proc.op === 'avg') n = nums.reduce((a, b) => a + b, 0) / nums.length
      else if (proc.op === 'min') n = Math.min(...nums)
      else n = Math.max(...nums)
      const f = field!
      // Averages of whole numbers may be fractional — show up to 2 decimals.
      text = proc.op === 'avg' && f.kind === 'int'
        ? `${Number(n.toFixed(2))}${f.unit ? ' ' + f.unit : ''}`
        : formatNumber(f, n)
    }
  }
  return { proc, att, text, matched }
}

/** Results of every processor attached to the section's level, in attachment order. */
export function processorResults(p: Project, section: Section): ProcessorResult[] {
  const level = levelOf(p, section)
  if (!level) return []
  const out: ProcessorResult[] = []
  for (const att of level.processors) {
    const proc = p.processors.find(x => x.id === att.processorId)
    if (proc) out.push(evalProcessor(p, section, proc, att))
  }
  return out
}

/** "Coins 27 · Enemies 3" for band labels — only attachments flagged showOnBand. */
export function bandBadge(p: Project, section: Section): string {
  return processorResults(p, section)
    .filter(r => r.att?.showOnBand && !r.error)
    .map(r => `${r.proc.name} ${r.text}`)
    .join(' · ')
}

/** Levels a processor is attached to. */
export function processorUsage(p: Project, id: Id) {
  return p.hierarchyLevels.filter(l => l.processors.some(a => a.processorId === id))
}
