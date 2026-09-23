import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { iconByName } from '../model/icons'
import { displayEntries, groupAttachments, type DisplayEntry } from '../model/fields'
import { typeOf } from '../model/layout'
import { shownProcessorResults } from '../model/processors'
import { timelineView } from '../model/timelines'
import type { Id, Item, Project, Section } from '../model/types'
import { formatUnit, unitSuffix } from '../model/util'
import { isItemVisible } from './exportScope'
import { Markdown } from './Markdown'

/**
 * Document export: the timeline as a formatted, printable outline.
 *
 * Sections become headings (the outermost exported level is H1, the next H2,
 * …) and items are sub-headings one level below their section, with the
 * type's icon and name next to the title. Descriptions render as body text
 * (same minimal markdown as the inspector), followed by custom fields, tags,
 * link and images. Everything is real text so the result reads well for both
 * people and AI agents.
 *
 * Only items currently visible on the canvas are included: items on a layer
 * hidden with the eye toggle and items filtered out (types, layers, tags,
 * text — i.e. ghosted or hidden) are skipped. Sections are always kept.
 *
 * A project with several timelines (subtabs) exports one of them, or all of
 * them one after the other, each under its own top-level heading.
 *
 * The PDF itself comes from the browser: the document opens in a new tab with
 * the print dialog already up, where "Save as PDF" is the destination.
 */

export { isItemVisible }

interface SectionNode {
  section: Section
  children: SectionNode[]
  items: Item[]
}

const EPS = 1e-9
const contains = (sc: Section, pos: number) => pos >= sc.start - EPS && pos <= sc.end + EPS
const encloses = (outer: Section, inner: Section) =>
  outer.depth < inner.depth && inner.start >= outer.start - EPS && inner.end <= outer.end + EPS

/**
 * Build the containment tree of the given root sections. A section's parent is
 * the deepest enclosing section with a smaller depth; an item belongs to the
 * deepest section whose range covers its position. Roots default to every
 * section that has no parent; passing explicit roots exports only those
 * sub-trees.
 */
function buildTree(proj: Project, rootIds: string[] | null): { roots: SectionNode[]; loose: Item[] } {
  const nodes = new Map<string, SectionNode>()
  for (const sc of proj.sections) nodes.set(sc.id, { section: sc, children: [], items: [] })
  const parentOf = new Map<string, string | null>()
  for (const sc of proj.sections) {
    let best: Section | null = null
    for (const other of proj.sections) {
      if (other.id === sc.id || !encloses(other, sc)) continue
      if (!best || other.depth > best.depth || (other.depth === best.depth && other.end - other.start < best.end - best.start)) best = other
    }
    parentOf.set(sc.id, best?.id ?? null)
    if (best) nodes.get(best.id)!.children.push(nodes.get(sc.id)!)
  }
  const loose: Item[] = []
  for (const it of proj.items) {
    if (!isItemVisible(proj, it)) continue
    let best: Section | null = null
    for (const sc of proj.sections) {
      if (!contains(sc, it.pos)) continue
      if (!best || sc.depth > best.depth || (sc.depth === best.depth && sc.end - sc.start < best.end - best.start)) best = sc
    }
    if (best) nodes.get(best.id)!.items.push(it)
    else loose.push(it)
  }
  const byPos = (a: Item, b: Item) => a.pos - b.pos || a.title.localeCompare(b.title)
  for (const n of nodes.values()) {
    n.items.sort(byPos)
    n.children.sort((a, b) => a.section.start - b.section.start || a.section.depth - b.section.depth)
  }
  loose.sort(byPos)
  const roots = rootIds
    ? rootIds.map(id => nodes.get(id)).filter((n): n is SectionNode => !!n)
    : proj.sections.filter(sc => parentOf.get(sc.id) === null)
      .sort((a, b) => a.start - b.start || a.depth - b.depth)
      .map(sc => nodes.get(sc.id)!)
  return { roots, loose: rootIds ? [] : loose }
}

function countItems(n: SectionNode): number {
  return n.items.length + n.children.reduce((s, c) => s + countItems(c), 0)
}

function Heading({ level, className, children }: { level: number; className?: string; children: React.ReactNode }) {
  const Tag = `h${Math.min(6, Math.max(1, level))}` as keyof JSX.IntrinsicElements
  return <Tag className={className}>{children}</Tag>
}

/** Field values as a definition list, grouped under their sidebar folder (a caption row per folder). */
function FieldList({ proj, fields }: { proj: Project; fields: DisplayEntry[] }) {
  if (!fields.length) return null
  return (
    <dl className="fields">
      {groupAttachments(proj, fields).map(g => (
        <React.Fragment key={g.folder?.id ?? 'root'}>
          {g.folder && <div className="group"><dt style={{ color: g.folder.color }}>{g.folder.name}</dt><dd /></div>}
          {g.entries.map(f => (
            <div key={f.field.id} className={f.label ? '' : 'noname'}>
              {f.label && <dt>{f.label}</dt>}
              <dd title={f.label ? undefined : f.field.name}>{f.field.kind === 'text' ? <Markdown text={f.text} /> : f.text}</dd>
            </div>
          ))}
        </React.Fragment>
      ))}
    </dl>
  )
}

function DocBody({ proj, roots, loose, base = 1 }: { proj: Project; roots: SectionNode[]; loose: Item[]; base?: number }) {
  const st = proj.settings
  const suffix = unitSuffix(st.unit.preset, st.unit.custom)
  const fmt = (v: number) => formatUnit(v, 0.05, suffix, st.unit.preset)

  const renderItem = (it: Item, level: number) => {
    const t = typeOf(proj, it)
    const Icon = iconByName(t?.icon ?? 'Circle')
    const layer = proj.layers.find(l => l.id === (it.layerId ?? t?.defaultLayerId))
    const fields = displayEntries(proj, { kind: 'item', entity: it }, { skip: f => (proj.filters.offFields ?? []).includes(f.id) })
    const meta: string[] = [
      it.duration > 0 ? `${fmt(it.pos)} → ${fmt(it.pos + it.duration)} (${fmt(it.duration)})` : fmt(it.pos),
    ]
    if (layer) meta.push(`Layer: ${layer.name}`)
    if (it.tags.length) meta.push(`Tags: ${it.tags.join(', ')}`)
    if (it.createdBy?.name) meta.push(`Created by: ${it.createdBy.name}`)
    return (
      <article className="item" key={it.id} style={{ '--c': t?.color ?? '#888' } as React.CSSProperties}>
        <Heading level={level} className="item-h">
          <span className="icon"><Icon width="1em" height="1em" color={t?.color} strokeWidth={2} /></span>
          <span className="title">{it.title || 'Untitled'}</span>
          <span className="type">{t?.name ?? 'Unknown type'}</span>
        </Heading>
        <p className="meta">{meta.join(' · ')}</p>
        {it.description.trim() && <Markdown text={it.description} />}
        <FieldList proj={proj} fields={fields} />
        {it.link && <p className="link">Link: <a href={it.link}>{it.link}</a></p>}
        {it.images.length > 0 && (
          <div className="images">{it.images.map((src, i) => <img key={i} src={src} alt="" />)}</div>
        )}
      </article>
    )
  }

  const renderSection = (n: SectionNode, level: number): React.ReactNode => {
    const sc = n.section
    // Direct items and sub-sections interleaved in timeline order.
    const entries: { pos: number; node: React.ReactNode }[] = [
      ...n.items.map(it => ({ pos: it.pos, node: renderItem(it, level + 1) })),
      ...n.children.map(c => ({ pos: c.section.start, node: renderSection(c, level + 1) })),
    ].sort((a, b) => a.pos - b.pos)
    // The section's own field values and its processor results (the same
    // numbers the inspector shows), so a reader gets the totals too.
    const secFields = displayEntries(proj, { kind: 'section', entity: sc }, { skip: f => (proj.filters.offFields ?? []).includes(f.id) })
    const procs = shownProcessorResults(proj, sc)
    return (
      <section key={sc.id} className={`sec l${level}`}>
        <Heading level={level} className="sec-h">
          <span className="title">{sc.name || 'Untitled'}</span>
          <span className="type">{proj.hierarchyLevels[sc.depth]?.name ?? `Level ${sc.depth + 1}`}</span>
        </Heading>
        <p className="meta">{fmt(sc.start)} → {fmt(sc.end)} ({fmt(sc.end - sc.start)}) · {countItems(n)} item{countItems(n) === 1 ? '' : 's'}</p>
        {procs.length > 0 && (
          <p className="procs">
            {procs.map((r, i) => (
              <span key={r.proc.id} className="proc">
                {i > 0 && <span className="sep"> · </span>}
                <span className="proc-name">{r.proc.name}</span> <span className="proc-value">{r.text}</span>
              </span>
            ))}
          </p>
        )}
        <FieldList proj={proj} fields={secFields} />
        {sc.description?.trim() && <Markdown text={sc.description} />}
        {entries.map((e, i) => <React.Fragment key={i}>{e.node}</React.Fragment>)}
      </section>
    )
  }

  return (
    <>
      {roots.map(r => renderSection(r, base))}
      {loose.length > 0 && (
        <section className={`sec l${base}`}>
          {roots.length > 0 && <Heading level={base} className="sec-h"><span className="title">Outside any section</span></Heading>}
          {loose.map(it => renderItem(it, roots.length > 0 ? base + 1 : base))}
        </section>
      )}
    </>
  )
}

const DOC_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 40px 48px; max-width: 860px; margin-inline: auto;
  font: 12.5pt/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: #1c1f26; background: #fff;
}
.doc-bar {
  position: sticky; top: 0; display: flex; gap: 10px; align-items: center;
  margin: -40px -48px 28px; padding: 10px 48px; background: #f1f3f7; border-bottom: 1px solid #d8dce6;
  font-size: 10.5pt; color: #4b5162;
}
.doc-bar button {
  font: inherit; font-weight: 600; padding: 6px 14px; border-radius: 8px; border: 1px solid #b9c0cf;
  background: #fff; color: #1c1f26; cursor: pointer;
}
.doc-bar button:hover { background: #e9ecf3; }
header.cover { margin-bottom: 28px; padding-bottom: 14px; border-bottom: 2px solid #1c1f26; }
header.cover h1 { margin: 0 0 4px; font-size: 26pt; }
header.cover p { margin: 0; color: #5a6172; font-size: 10.5pt; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 0; page-break-after: avoid; break-after: avoid; }
.sec-h { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.sec.l1 > .sec-h { font-size: 21pt; margin-top: 30px; padding-bottom: 5px; border-bottom: 1.5px solid #c6cbd6; }
.sec.timeline + .sec.timeline { page-break-before: always; break-before: page; }
.sec.timeline > .sec-h { font-size: 24pt; border-bottom-width: 2.5px; border-bottom-color: #1c1f26; }
.sec.l2 > .sec-h { font-size: 17pt; margin-top: 24px; }
.sec.l3 > .sec-h { font-size: 14.5pt; margin-top: 18px; }
.sec.l4 > .sec-h, .sec.l5 > .sec-h, .sec.l6 > .sec-h { font-size: 13pt; margin-top: 14px; }
.sec > .sec-h + .meta { margin-top: 2px; }
.type { font-size: 0.6em; font-weight: 500; color: #6b7180; white-space: nowrap; padding: 1px 7px; border-radius: 999px; border: 1px solid #d8dce6; }
.item { margin: 14px 0 10px; padding-left: 12px; border-left: 3px solid var(--c, #888); page-break-inside: avoid; break-inside: avoid; }
.item-h { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5pt; }
h1.item-h { font-size: 19pt; } h2.item-h { font-size: 15.5pt; } h3.item-h { font-size: 13.5pt; }
.item-h .icon { display: inline-flex; color: var(--c); flex: none; }
.item-h .icon svg { width: 1em; height: 1em; }
.item-h .type { color: var(--c); border-color: color-mix(in srgb, var(--c) 45%, #fff); }
.meta { margin: 1px 0 6px; font-size: 9.5pt; color: #6b7180; }
.procs { margin: 0 0 6px; font-size: 10.5pt; color: #4b5162; }
.procs .proc-name { font-weight: 600; }
.procs .proc-value { font-variant-numeric: tabular-nums; color: #1c1f26; }
.procs .sep { color: #b0b5c2; }
.md p { margin: 0 0 6px; } .md ul { margin: 0 0 6px; padding-left: 20px; }
.md code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; background: #eef0f4; border-radius: 4px; padding: 0 4px; }
.md a, .link a { color: #2563eb; text-decoration: none; }
.fields { margin: 4px 0 6px; display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; font-size: 11pt; }
.fields > div { display: contents; }
.fields dt { font-weight: 600; color: #4b5162; }
.fields dd { margin: 0; }
.fields > div.noname dd { grid-column: 1 / -1; }
.fields > div.group dt { grid-column: 1 / -1; font-size: 9pt; text-transform: uppercase; letter-spacing: .04em; margin-top: 3px; }
.fields > div.group dd { display: none; }
.link { margin: 0 0 6px; font-size: 10.5pt; word-break: break-all; }
.images { display: flex; flex-wrap: wrap; gap: 8px; margin: 6px 0 8px; }
.images img { max-width: 240px; max-height: 180px; border-radius: 6px; border: 1px solid #d8dce6; }
.empty { color: #6b7180; font-style: italic; }
@page { margin: 18mm 16mm; }
@media print {
  body { padding: 0; max-width: none; font-size: 11pt; }
  .doc-bar { display: none; }
  .images img { max-width: 200px; max-height: 150px; }
}
`

/**
 * Full standalone HTML for the outline document. `proj` is the whole project;
 * `timelineIds` picks the timelines to export (default: every one, in tab
 * order). One timeline renders as before; several render one after the
 * other, each under a heading with its name. `sectionIds` limits a
 * single-timeline export to those sections (and everything inside them).
 */
export function buildDocHTML(proj: Project, sectionIds: string[] | null, timelineIds: Id[] | null = null): { html: string; title: string } {
  const wanted = timelineIds ?? proj.timelines.map(t => t.id)
  const timelines = proj.timelines.filter(t => wanted.includes(t.id))
  const single = timelines.length === 1
  const parts = timelines.map(t => {
    const view = timelineView(proj, t.id)
    const { roots, loose } = buildTree(view, single ? sectionIds : null)
    return { t, view, roots, loose, total: roots.reduce((s, r) => s + countItems(r), 0) + loose.length }
  })
  const first = parts[0]
  const rootNames = single ? first.roots.map(r => r.section.name || 'Untitled') : []
  const named = proj.timelines.length > 1 && single ? `${proj.name} — ${first.t.name}` : proj.name
  const title = single && sectionIds && rootNames.length ? `${named} — ${rootNames.join(', ')}` : named
  const total = parts.reduce((s, p) => s + p.total, 0)
  const hidden = parts.reduce((s, p) => s + p.view.items.filter(it => !isItemVisible(p.view, it)).length, 0)
  const f = proj.filters
  const activeFilters = [
    f.offTypes.length && 'types', f.offLayers.length && 'layers', f.tags.length && 'tags',
    f.text.trim() && `text “${f.text.trim()}”`, (f.rules ?? '').trim() && `rules “${f.rules.trim()}”`, proj.layers.some(l => l.eye) && 'hidden layers',
    (f.offFields ?? []).length && 'hidden fields', (f.offProcessors ?? []).length && 'hidden processors',
  ].filter(Boolean)
  const visibility = hidden > 0
    ? `${total} visible item${total === 1 ? '' : 's'} (${hidden} hidden by ${activeFilters.join(', ') || 'filters'})`
    : `${total} item${total === 1 ? '' : 's'}`
  const scope = single && sectionIds
    ? `${rootNames.length === 1 ? (proj.hierarchyLevels[first.roots[0]?.section.depth]?.name ?? 'Section') : 'Sections'}: ${rootNames.join(', ')}`
    : single ? 'Whole timeline' : `${parts.length} timelines`
  const empty = parts.every(p => p.roots.length === 0 && p.loose.length === 0)
  const body = renderToStaticMarkup(
    <>
      <div className="doc-bar">
        <span>Use your browser's print dialog and choose <b>Save as PDF</b>.</span>
        <button id="print-btn">Print / Save as PDF</button>
      </div>
      <header className="cover">
        <h1>{title}</h1>
        <p>{scope} · {visibility} · Timeline Planner export, {new Date().toISOString().slice(0, 10)}</p>
      </header>
      {empty
        ? <p className="empty">{hidden > 0 ? 'Nothing visible to export — every item is hidden by the current filters.' : 'Nothing to export.'}</p>
        : single
          ? <DocBody proj={first.view} roots={first.roots} loose={first.loose} />
          : parts.map(p => (
            <section key={p.t.id} className="sec l1 timeline">
              <Heading level={1} className="sec-h">
                <span className="title">{p.t.name}</span>
                <span className="type">Timeline</span>
              </Heading>
              <p className="meta">{p.total} item{p.total === 1 ? '' : 's'}</p>
              {p.roots.length === 0 && p.loose.length === 0
                ? <p className="empty">Nothing on this timeline.</p>
                : <DocBody proj={p.view} roots={p.roots} loose={p.loose} base={2} />}
            </section>
          ))}
    </>,
  )
  const esc = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${DOC_CSS}</style>
</head>
<body>
${body}
<script>
document.getElementById('print-btn').addEventListener('click', function () { window.print() });
window.addEventListener('load', function () { setTimeout(function () { window.print() }, 250) });
</script>
</body>
</html>`
  return { html, title }
}

/**
 * Open the outline document in a new tab with the print dialog up, so the user
 * can save it as a PDF. `sectionIds` limits the export to those sections (and
 * everything inside them); null exports the whole timeline. `timelineIds`
 * picks the timelines (default: all of them).
 */
export function exportDocPDF(proj: Project, sectionIds: string[] | null, timelineIds: Id[] | null = null) {
  const { html } = buildDocHTML(proj, sectionIds, timelineIds)
  const win = window.open('', '_blank')
  if (!win) return false
  win.document.open()
  win.document.write(html)
  win.document.close()
  return true
}
