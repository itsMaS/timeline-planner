/**
 * Timeline Planner agent CLI — lets an agent (or a script) work on a shared
 * timeline through its edit link, the same way a person does, but with the
 * option to *propose* changes for review instead of applying them.
 *
 *   npx tsx agent/timeline.ts <command> [options]
 *
 * The edit link (or bare token) comes from --link or $TIMELINE_LINK.
 *
 * Commands
 *   read     [--out doc.json]                     download the timeline (wrapper: {version, timelineId, name, doc})
 *   outline  [--in doc.json]                      human-readable outline: sections → items, with ids
 *   propose  --base doc.json --edited edited.json --title "…" [--summary "…"] [--notes notes.json] [--author "…"]
 *                                                 diff base → edited into a proposal for review in the app
 *   apply    --base doc.json --edited edited.json [--force]
 *                                                 save the edited document directly (fails if someone saved since)
 *   status   [--all]                              list open (or all) proposals
 *   withdraw <proposal-id>                        delete a proposal
 *   export   --out file.pdf [--html file.html] [--sections a,b] [--types a,b] [--layers a,b] [--tags a,b] [--text q]
 *                                                 the app's document export (sections as headings, items with
 *                                                 descriptions/fields/tags) printed to PDF with headless Chromium
 *
 * Everything is talked to through the same token-checked Supabase RPCs the app
 * uses, so nothing here can do more than a person holding the edit link.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { diffToChanges, type Proposal, type ProposalChange } from '../src/model/proposal'
import { itemMatchesFilters, typeOf } from '../src/model/layout'
import type { Project } from '../src/model/types'
import { buildDocHTML } from '../src/ui/exportDoc'
import { SUPABASE_KEY, SUPABASE_URL } from '../src/sync/client'

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2)
const cmd = argv[0]
const opts: Record<string, string | boolean> = {}
const positional: string[] = []
for (let i = 1; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const k = a.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) { opts[k] = next; i++ } else opts[k] = true
  } else positional.push(a)
}
const opt = (k: string): string | undefined => (typeof opts[k] === 'string' ? (opts[k] as string) : undefined)
const flag = (k: string): boolean => opts[k] === true

function fail(msg: string, code = 1): never {
  console.error(`error: ${msg}`)
  process.exit(code)
}

function tokenFromLink(link: string | undefined): string {
  if (!link) fail('no edit link: pass --link <url-or-token> or set TIMELINE_LINK')
  const m = link.match(/#\/s\/([A-Za-z0-9_-]{8,})/)
  const tok = m ? m[1] : link.trim()
  if (!/^[A-Za-z0-9_-]{8,}$/.test(tok)) fail('that does not look like a share link or token')
  return tok
}
const TOKEN = () => tokenFromLink(opt('link') ?? process.env.TIMELINE_LINK ?? process.env.TIMELINE_EDIT_LINK)

// ---------------------------------------------------------------- rpc

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  const text = await res.text()
  if (!res.ok) {
    let msg = text
    try { msg = (JSON.parse(text) as { message?: string }).message ?? text } catch { /* raw */ }
    throw new Error(`${fn}: ${res.status} ${msg}`)
  }
  return (text ? JSON.parse(text) : null) as T
}

interface Wrapper { version: number; timelineId: string; name: string; role: 'edit' | 'view'; doc: Project }
interface OpenResult { id: string; name: string; doc: Project; version: number; role: 'edit' | 'view' }

async function open(token: string): Promise<Wrapper> {
  const r = await rpc<OpenResult | null>('share_open', { p_token: token })
  if (!r) fail('this link is not valid (revoked or mistyped)')
  return { version: r.version, timelineId: r.id, name: r.name, role: r.role, doc: r.doc }
}

/** Accept either the wrapper written by `read` or a bare document. */
function loadDoc(path: string | undefined, what: string): Wrapper {
  if (!path) fail(`--${what} <file> is required`)
  if (!existsSync(path)) fail(`${path} does not exist`)
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Wrapper | Project
  if ('doc' in raw && raw.doc && typeof raw.doc === 'object') return raw as Wrapper
  const doc = raw as Project
  if (!Array.isArray(doc.items)) fail(`${path} is not a timeline document`)
  return { version: 0, timelineId: '', name: doc.name, role: 'edit', doc }
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

// ---------------------------------------------------------------- commands

async function cmdRead() {
  const w = await open(TOKEN())
  const out = opt('out') ?? 'timeline.json'
  writeFileSync(out, JSON.stringify(w, null, 2))
  const d = w.doc
  console.log(`${w.name} (${w.role} link, version ${w.version}) → ${out}`)
  console.log(`${plural(d.items.length, 'item')}, ${plural(d.types.length, 'type')}, ${plural(d.sections.length, 'section')}, ${plural(d.layers.length, 'layer')}`)
  console.log(`edit the "doc" object in ${out}, then: propose --base ${out} --edited <edited.json> --title "…"`)
}

function outlineOf(d: Project): string {
  const lines: string[] = []
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2))
  lines.push(`# ${d.name}`)
  lines.push(`hierarchy: ${d.hierarchyLevels.join(' > ')}`)
  lines.push(`types: ${d.types.map(t => `${t.name} [${t.id}]`).join(', ') || '(none)'}`)
  lines.push(`layers: ${d.layers.map(l => `${l.name} [${l.id}]`).join(', ') || '(none)'}`)
  lines.push('')
  const secs = [...d.sections].sort((a, b) => a.start - b.start || a.depth - b.depth)
  const items = [...d.items].sort((a, b) => a.pos - b.pos)
  const placed = new Set<string>()
  for (const sc of secs) {
    lines.push(`${'#'.repeat(sc.depth + 2)} ${sc.name || 'Untitled'} [${sc.id}]  (${fmt(sc.start)} → ${fmt(sc.end)})`)
    if (sc.description?.trim()) lines.push(`  ${sc.description.trim().replace(/\n/g, '\n  ')}`)
    // Items directly in this section: inside its range and not inside a deeper section.
    for (const it of items) {
      if (placed.has(it.id) || it.pos < sc.start || it.pos > sc.end) continue
      const deeper = secs.some(o => o.depth > sc.depth && it.pos >= o.start && it.pos <= o.end)
      if (deeper) continue
      placed.add(it.id)
      lines.push(itemLine(d, it, fmt))
    }
  }
  const loose = items.filter(it => !placed.has(it.id))
  if (loose.length) {
    lines.push(secs.length ? '## (outside any section)' : '')
    for (const it of loose) lines.push(itemLine(d, it, fmt))
  }
  return lines.join('\n')
}

function itemLine(d: Project, it: Project['items'][number], fmt: (n: number) => string): string {
  const t = typeOf(d, it)
  const span = it.duration > 0 ? `${fmt(it.pos)}–${fmt(it.pos + it.duration)}` : fmt(it.pos)
  const tags = it.tags.length ? ` #${it.tags.join(' #')}` : ''
  const desc = it.description.trim() ? ` — ${it.description.trim().replace(/\s+/g, ' ').slice(0, 140)}` : ''
  return `- (${t?.name ?? '?'}) ${it.title || 'Untitled'} [${it.id}] @${span}${tags}${desc}`
}

async function cmdOutline() {
  const w = opt('in') ? loadDoc(opt('in'), 'in') : await open(TOKEN())
  console.log(outlineOf(w.doc))
}

function describeChanges(d: Project, changes: ProposalChange[]): string[] {
  return changes.map(c => {
    const e = (c.after ?? c.before) as Record<string, unknown> | null
    const name = String(e?.title ?? e?.name ?? e?.label ?? c.entityId)
    const what = c.col === 'project' ? `project ${c.entityId}` : `${c.col.replace(/s$/, '')} “${name}”`
    const verb = c.kind === 'add' ? 'add' : c.kind === 'remove' ? 'remove' : 'change'
    let fields = ''
    if (c.kind === 'update') {
      const a = c.before as Record<string, unknown>
      const b = c.after as Record<string, unknown>
      fields = ` (${Object.keys({ ...a, ...b }).filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k])).join(', ')})`
    }
    return `  ${verb} ${what}${fields}${c.note ? ` — ${c.note}` : ''}`
  })
}

async function cmdPropose() {
  const token = TOKEN()
  const base = loadDoc(opt('base'), 'base')
  const edited = loadDoc(opt('edited'), 'edited')
  const title = opt('title') ?? fail('--title is required')
  const notes = opt('notes') ? (JSON.parse(readFileSync(opt('notes')!, 'utf8')) as Record<string, string>) : {}
  const changes = diffToChanges(base.doc, edited.doc, notes)
  if (!changes.length) fail('the edited document is identical to the base — nothing to propose')
  const p = await rpc<Proposal | null>('proposal_create', {
    p_edit_token: token, p_title: title, p_summary: opt('summary') ?? '', p_author: opt('author') ?? 'Claude',
    p_base_version: base.version || null, p_changes: changes,
  })
  if (!p) fail('this link is not valid (revoked or mistyped)')
  console.log(`proposal ${p.id} created: “${p.title}” with ${plural(changes.length, 'change')}`)
  console.log(describeChanges(edited.doc, changes).join('\n'))
  console.log('review it in the app under Sidebar → Proposals.')
}

async function cmdApply() {
  const token = TOKEN()
  const base = loadDoc(opt('base'), 'base')
  const edited = loadDoc(opt('edited'), 'edited')
  const changes = diffToChanges(base.doc, edited.doc)
  if (!changes.length) fail('the edited document is identical to the base — nothing to apply')
  const doc = edited.doc
  if (flag('force') || !base.version) {
    const r = await rpc<{ gone?: true; version?: number }>('share_save', { p_token: token, p_name: doc.name, p_doc: doc })
    if (r.gone) fail('this link is not valid (revoked or mistyped)')
    console.log(`saved directly (version ${r.version}) with ${plural(changes.length, 'change')}`)
  } else {
    const r = await rpc<{ gone?: true; conflict?: true; version?: number }>('share_save_if', {
      p_token: token, p_expected_version: base.version, p_name: doc.name, p_doc: doc,
    })
    if (r.gone) fail('this link is not valid (revoked or mistyped)')
    if (r.conflict) fail(`the timeline changed since you read it (server is at version ${r.version}, base was ${base.version}). Re-read, redo the edit, or --force to overwrite.`, 2)
    console.log(`saved (version ${r.version}) with ${plural(changes.length, 'change')}`)
  }
  console.log(describeChanges(doc, changes).join('\n'))
}

async function cmdStatus() {
  const r = await rpc<{ version: number; rows: Proposal[] } | null>('proposal_list', { p_edit_token: TOKEN(), p_since: null })
  if (!r) fail('this link is not valid (revoked or mistyped)')
  const rows = flag('all') ? r.rows : r.rows.filter(p => p.status === 'open')
  if (!rows.length) { console.log(flag('all') ? 'no proposals' : 'no open proposals'); return }
  for (const p of rows) {
    let applied = 0
    let rejected = 0
    for (const c of p.changes) {
      if (p.decisions[c.id] === 'applied') applied++
      else if (p.decisions[c.id] === 'rejected') rejected++
    }
    const pending = p.changes.length - applied - rejected
    console.log(`${p.id}  [${p.status}]  “${p.title}” by ${p.author} — ${plural(p.changes.length, 'change')}: ${applied} applied, ${rejected} rejected, ${pending} pending`)
  }
}

async function cmdWithdraw() {
  const id = positional[0] ?? fail('usage: withdraw <proposal-id>')
  const ok = await rpc<boolean>('proposal_delete', { p_edit_token: TOKEN(), p_id: id })
  console.log(ok ? `proposal ${id} deleted` : `proposal ${id} not found`)
}

// ---------------------------------------------------------------- export

const listOpt = (k: string) => (opt(k) ?? '').split(',').map(s => s.trim()).filter(Boolean)

/** Match a list of names/ids against entities: exact id, exact name (case-insensitive), then substring. */
function resolve<T extends { id: string; name: string }>(wanted: string[], pool: T[], what: string): T[] {
  const out: T[] = []
  for (const w of wanted) {
    const lw = w.toLowerCase()
    const hit = pool.find(e => e.id === w) ?? pool.find(e => e.name.toLowerCase() === lw) ?? pool.find(e => e.name.toLowerCase().includes(lw))
    if (!hit) fail(`no ${what} matches “${w}” (have: ${pool.map(e => e.name).join(', ')})`)
    if (!out.includes(hit)) out.push(hit)
  }
  return out
}

async function cmdExport() {
  const w = opt('in') ? loadDoc(opt('in'), 'in') : await open(TOKEN())
  const d = structuredClone(w.doc)
  d.filters = { offTypes: [], offLayers: [], tags: [], text: '' }
  const types = listOpt('types')
  if (types.length) {
    const keep = new Set(resolve(types, d.types, 'type').map(t => t.id))
    d.filters.offTypes = d.types.filter(t => !keep.has(t.id)).map(t => t.id)
  }
  const layers = listOpt('layers')
  if (layers.length) {
    const keep = new Set(resolve(layers, d.layers, 'layer').map(l => l.id))
    d.filters.offLayers = d.layers.filter(l => !keep.has(l.id)).map(l => l.id)
  }
  d.filters.tags = listOpt('tags')
  d.filters.text = opt('text') ?? ''
  const sections = listOpt('sections')
  const sectionIds = sections.length ? resolve(sections, d.sections, 'section').map(s => s.id) : null

  const inScope = (pos: number) => !sectionIds || d.sections.some(sc => sectionIds.includes(sc.id) && pos >= sc.start && pos <= sc.end)
  const visible = d.items.filter(it => itemMatchesFilters(d, it, d.filters) && inScope(it.pos)).length
  const { html: raw, title } = buildDocHTML(d, sectionIds)
  // The in-app page opens the print dialog itself; here Chromium prints it.
  const html = raw.replace(/<script>[\s\S]*?<\/script>/, '').replace(/<div class="doc-bar">[\s\S]*?<\/div>/, '')
  if (opt('html')) { writeFileSync(opt('html')!, html); console.log(`html → ${opt('html')}`) }
  const out = opt('out') ?? (opt('html') ? '' : 'timeline.pdf')
  if (out) {
    const { chromium } = await import('playwright-core')
    let executablePath = process.env.CHROMIUM_PATH
    if (!executablePath) {
      try { executablePath = chromium.executablePath() } catch { /* fall through */ }
      if (!executablePath || !existsSync(executablePath)) {
        for (const cand of ['/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
          if (existsSync(cand)) { executablePath = cand; break }
        }
      }
    }
    if (!executablePath || !existsSync(executablePath)) fail('no Chromium found: set CHROMIUM_PATH or run `npx playwright-core install chromium`')
    const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] })
    try {
      const page = await browser.newPage()
      await page.setContent(html, { waitUntil: 'load' })
      await page.pdf({ path: out, format: 'A4', printBackground: true, margin: { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' } })
    } finally {
      await browser.close()
    }
    console.log(`pdf → ${out}`)
  }
  console.log(`“${title}”: ${plural(visible, 'visible item')}${sectionIds ? ` in ${plural(sectionIds.length, 'section')}` : ''}`)
}

// ---------------------------------------------------------------- main

const commands: Record<string, () => Promise<void>> = {
  read: cmdRead, outline: cmdOutline, propose: cmdPropose, apply: cmdApply,
  status: cmdStatus, withdraw: cmdWithdraw, export: cmdExport,
}

if (!cmd || !commands[cmd]) {
  console.log(readFileSync(new URL(import.meta.url)).toString().split('*/')[0].split('\n').slice(1).map(l => l.replace(/^ \* ?/, '')).join('\n'))
  process.exit(cmd ? 1 : 0)
}
commands[cmd]().catch(e => fail((e as Error).message))
