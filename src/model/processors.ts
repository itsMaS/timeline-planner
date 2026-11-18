import { attachmentsFor, entityTitle, fieldById, formatNumber, formatToggle, isNumberKind, levelOf, readValue, type Owner } from './fields'
import { matchesRule } from './scope'
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
  /** What each matched entity contributed (aligned with `matched`); null for a bare count. */
  values: (FieldValue | null)[]
  error?: string
}

interface PosIndex { keys: number[]; idx: number[] }

// Entries of one timeline sorted by start, cached on the source array (arrays
// are replaced, never edited, when the document changes), so every section
// finds what lies inside it by binary search instead of scanning everything:
// band badges evaluate this for each section on every document change.
const posIndexCache = new WeakMap<readonly unknown[], Map<string, PosIndex>>()
function posIndex<T extends { timelineId?: Id }>(all: T[], timelineId: Id | undefined, keyOf: (x: T) => number): PosIndex {
  let per = posIndexCache.get(all)
  if (!per) { per = new Map(); posIndexCache.set(all, per) }
  const tk = timelineId ?? ''
  let hit = per.get(tk)
  if (!hit) {
    const idx: number[] = []
    all.forEach((x, i) => { if (x.timelineId === timelineId && !Number.isNaN(keyOf(x))) idx.push(i) })
    idx.sort((a, b) => keyOf(all[a]) - keyOf(all[b]) || a - b)
    hit = { keys: idx.map(i => keyOf(all[i])), idx }
    per.set(tk, hit)
  }
  return hit
}

/** Source indices whose key lies in [lo, hi], in source order. */
function indicesIn(ix: PosIndex, lo: number, hi: number): number[] {
  let a = 0
  let b = ix.keys.length
  while (a < b) { const m = (a + b) >> 1; if (ix.keys[m] < lo) a = m + 1; else b = m }
  const out: number[] = []
  for (let k = a; k < ix.keys.length && ix.keys[k] <= hi; k++) out.push(ix.idx[k])
  return out.sort((x, y) => x - y)
}

/** Items and nested sections inside `section` (item start inside the range), on the section's own timeline. */
export function entitiesInside(p: Project, section: Section): Owner[] {
  // Every processor of the section's level asks; work it out once per
  // section object and document arrays.
  const hit = insideCache.get(section)
  if (hit && hit.items === p.items && hit.sections === p.sections) return hit.out
  const out = findInside(p, section)
  insideCache.set(section, { items: p.items, sections: p.sections, out })
  return out
}

const insideCache = new WeakMap<Section, { items: unknown; sections: unknown; out: Owner[] }>()

function findInside(p: Project, section: Section): Owner[] {
  const eps = 1e-9
  const lo = section.start - eps
  const hi = section.end + eps
  const out: Owner[] = []
  for (const i of indicesIn(posIndex(p.items, section.timelineId, it => it.pos), lo, hi)) {
    out.push({ kind: 'item', entity: p.items[i] })
  }
  for (const i of indicesIn(posIndex(p.sections, section.timelineId, sc => sc.start), lo, hi)) {
    const sc = p.sections[i]
    if (sc.id !== section.id && sc.depth > section.depth && sc.end <= hi) out.push({ kind: 'section', entity: sc })
  }
  return out
}

export function evalProcessor(p: Project, section: Section, proc: ProcessorDef, att: ProcessorAttachment | null = null): ProcessorResult {
  const field = fieldById(p, proc.fieldId)
  const spec = PROCESSOR_OPS.find(o => o.op === proc.op)!
  if (spec.needsField !== 'none' && !field) return { proc, att, text: '—', matched: [], values: [], error: 'needs a field' }
  if (spec.needsField === 'number' && field && !isNumberKind(field.kind) && !(proc.op === 'sum' && field.kind === 'toggle')) {
    return { proc, att, text: '—', matched: [], values: [], error: 'needs a number field' }
  }

  const targets = new Set(proc.targets)
  const exclude = new Set(targets.size ? [] : proc.exclude ?? [])
  const inside = entitiesInside(p, section)
  const matched: Owner[] = []
  const values: FieldValue[] = []
  const contributed: (FieldValue | null)[] = []
  const where = proc.where?.trim() ?? ''
  for (const o of inside) {
    const key = o.kind === 'item' ? o.entity.typeId : levelOf(p, o.entity)?.id
    if (targets.size) { if (!key || !targets.has(key)) continue }
    else if (key && exclude.has(key)) continue
    else if (proc.op === 'count' && o.kind === 'section') continue // bare count = items only
    if (where && !matchesRule(p, o, where)) continue
    let v: FieldValue | null = null
    if (field) {
      const a = attachmentsFor(p, o).find(x => x.field.id === field.id)
      if (!a) continue
      v = readValue(p, o, field, a.att)
      if (v === null) continue
      values.push(v)
    }
    matched.push(o)
    contributed.push(v)
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
  return { proc, att, text, matched, values: contributed }
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

/** "Coins 27 · Enemies 3" for band labels — only attachments flagged showOnBand and not hidden by the filters. */
export function bandBadge(p: Project, section: Section): string {
  const off = p.filters?.offProcessors ?? []
  return processorResults(p, section)
    .filter(r => r.att?.showOnBand && !r.error && !off.includes(r.proc.id))
    .map(r => `${r.proc.name} ${r.text}`)
    .join(' · ')
}

/** Processor results for exports: everything on the level except what the filters hide. */
export function shownProcessorResults(p: Project, section: Section): ProcessorResult[] {
  const off = p.filters?.offProcessors ?? []
  return processorResults(p, section).filter(r => !r.error && !off.includes(r.proc.id))
}

/** Levels a processor is attached to. */
export function processorUsage(p: Project, id: Id) {
  return p.hierarchyLevels.filter(l => l.processors.some(a => a.processorId === id))
}
