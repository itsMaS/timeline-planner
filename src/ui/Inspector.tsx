import React, { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Copy, Trash2, X } from 'lucide-react'
import { iconByName } from '../model/icons'
import { typeOf } from '../model/layout'
import { useActiveProject, useStore } from '../model/store'
import type { Branch, Item, Section } from '../model/types'
import { formatUnit, uid, unitSuffix } from '../model/util'
import { Markdown } from './Markdown'
import { nav } from './nav'

export function Inspector() {
  const proj = useActiveProject()
  const ui = useStore(s => s.ui)
  const sel = ui.selection
  if (sel.length === 0) return null
  const branchId = sel.length === 1 && sel[0].startsWith('B:') ? sel[0].slice(2) : null
  const sectionId = sel.length === 1 && sel[0].startsWith('S:') ? sel[0].slice(2) : null
  const itemIds = sel.filter(s => !s.includes(':'))
  const branch = branchId ? proj.branches.find(b => b.id === branchId) : null
  const section = sectionId ? proj.sections.find(s => s.id === sectionId) : null
  return (
    <aside className="inspector">
      {branch && <BranchPanel branch={branch} />}
      {section && <SectionPanel section={section} />}
      {itemIds.length === 1 && <ItemPanel id={itemIds[0]} />}
      {itemIds.length > 1 && <BulkPanel ids={itemIds} />}
    </aside>
  )
}

function Head(props: { title: string; children?: React.ReactNode }) {
  const select = useStore(s => s.select)
  return (
    <div className="insp-head">
      <strong>{props.title}</strong>
      <span className="grow" />
      {props.children}
      <button className="ghost-btn" onClick={() => select([])}><X width={15} height={15} /></button>
    </div>
  )
}

// ------------------------------------------------------------------ item

function ItemPanel({ id }: { id: string }) {
  const proj = useActiveProject()
  const mutate = useStore(s => s.mutate)
  const select = useStore(s => s.select)
  const showToast = useStore(s => s.showToast)
  const [preview, setPreview] = useState(false)
  const item = proj.items.find(i => i.id === id)
  const paths = useMemo(
    () => proj.branches.flatMap(b => b.paths.map((p, i) => ({
      id: p.id,
      name: p.label || `${b.mode.toUpperCase()} branch · path ${i + 1}`,
    }))),
    [proj.branches],
  )
  if (!item) return null
  const type = typeOf(proj, item)
  const edit = (recipe: (it: Item) => void) =>
    mutate(p => { const it = p.items.find(i => i.id === id); if (it) recipe(it) })

  return (
    <>
      <Head title={type?.name ?? 'Item'}>
        <button
          className="ghost-btn" title="Duplicate (Ctrl+D)"
          onClick={() => {
            const nid = uid()
            mutate(p => {
              const src = p.items.find(i => i.id === id)
              if (!src) return
              const cp = structuredClone(src)
              cp.id = nid
              cp.pos += Math.max(0.5, cp.duration)
              p.items.push(cp)
            })
            select([nid])
          }}
        ><Copy width={14} height={14} /></button>
        <button
          className="ghost-btn danger" title="Delete (Del)"
          onClick={() => { mutate(p => { p.items = p.items.filter(i => i.id !== id) }); select([]); showToast('Item deleted.', true) }}
        ><Trash2 width={14} height={14} /></button>
      </Head>
      <div className="insp-body">
        <input
          className="input title-input"
          value={item.title}
          placeholder="Title"
          onChange={e => edit(it => { it.title = e.target.value })}
        />
        <div className="row gap">
          <div className="field grow">
            <label>Type</label>
            <select className="input" value={item.typeId} onChange={e => edit(it => { it.typeId = e.target.value })}>
              {proj.types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div className="field grow">
            <label>Layer</label>
            <select
              className="input"
              value={item.layerId ?? ''}
              onChange={e => edit(it => { it.layerId = e.target.value || null })}
            >
              <option value="">Type default</option>
              {proj.layers.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
        </div>
        <div className="row gap">
          <div className="field grow">
            <label>Position</label>
            <input
              className="input" type="number" step="0.5" value={round2(item.pos)}
              onChange={e => edit(it => { it.pos = Number(e.target.value) })}
            />
          </div>
          <div className="field grow">
            <label>Span (0 = point)</label>
            <input
              className="input" type="number" step="0.5" min={0} value={round2(item.duration)}
              onChange={e => edit(it => { it.duration = Math.max(0, Number(e.target.value)) })}
            />
          </div>
        </div>
        {paths.length > 0 && (
          <div className="field">
            <label>On branch path</label>
            <select
              className="input"
              value={item.pathId ?? ''}
              onChange={e => edit(it => { it.pathId = e.target.value || null })}
            >
              <option value="">Main line</option>
              {paths.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        )}
        <div className="field">
          <label>Tags <span className="muted">(comma separated)</span></label>
          <input
            className="input"
            value={item.tags.join(', ')}
            onChange={e => edit(it => { it.tags = e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
          />
        </div>
        <div className="field">
          <label>Link</label>
          <input
            className="input" placeholder="https://…" value={item.link}
            onChange={e => edit(it => { it.link = e.target.value })}
          />
          {item.link && <a className="link-btn" href={item.link} target="_blank" rel="noreferrer noopener">open ↗</a>}
        </div>
        {type?.fields.map(f => (
          <div key={f.id} className="field">
            <label>{f.name}</label>
            <input
              className="input"
              value={item.fieldValues[f.id] ?? ''}
              onChange={e => edit(it => { it.fieldValues[f.id] = e.target.value })}
            />
          </div>
        ))}
        <div className="field">
          <label>
            Description <span className="muted">(markdown · paste images)</span>
            <button className="link-btn right" onClick={() => setPreview(v => !v)}>{preview ? 'edit' : 'preview'}</button>
          </label>
          {preview ? (
            <div className="md-preview"><Markdown text={item.description || '*nothing yet*'} /></div>
          ) : (
            <textarea
              className="input desc"
              value={item.description}
              onChange={e => edit(it => { it.description = e.target.value })}
              onPaste={e => {
                const files = [...e.clipboardData.files].filter(f => f.type.startsWith('image/'))
                if (!files.length) return
                e.preventDefault()
                for (const f of files) {
                  const reader = new FileReader()
                  reader.onload = () => edit(it => { it.images = [...it.images, String(reader.result)] })
                  reader.readAsDataURL(f)
                }
              }}
            />
          )}
        </div>
        {item.images.length > 0 && (
          <div className="img-strip">
            {item.images.map((src, i) => (
              <div key={i} className="img-thumb">
                <img src={src} alt="" />
                <button className="ghost-btn danger" onClick={() => edit(it => { it.images = it.images.filter((_, j) => j !== i) })}>
                  <X width={12} height={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

// ------------------------------------------------------------------ bulk

function BulkPanel({ ids }: { ids: string[] }) {
  const proj = useActiveProject()
  const mutate = useStore(s => s.mutate)
  const select = useStore(s => s.select)
  const showToast = useStore(s => s.showToast)
  return (
    <>
      <Head title={`${ids.length} items`}>
        <button
          className="ghost-btn danger" title="Delete all"
          onClick={() => { mutate(p => { p.items = p.items.filter(i => !ids.includes(i.id)) }); select([]); showToast(`${ids.length} items deleted.`, true) }}
        ><Trash2 width={14} height={14} /></button>
      </Head>
      <div className="insp-body">
        <div className="field">
          <label>Set type</label>
          <select className="input" value="" onChange={e => {
            if (!e.target.value) return
            mutate(p => { for (const it of p.items) if (ids.includes(it.id)) it.typeId = e.target.value })
          }}>
            <option value="">—</option>
            {proj.types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Set layer</label>
          <select className="input" value="" onChange={e => {
            mutate(p => { for (const it of p.items) if (ids.includes(it.id)) it.layerId = e.target.value || null })
          }}>
            <option value="">Type default</option>
            {proj.layers.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Add tag</label>
          <input className="input" placeholder="press Enter" onKeyDown={e => {
            if (e.key !== 'Enter') return
            const tag = (e.target as HTMLInputElement).value.trim()
            if (!tag) return
            mutate(p => { for (const it of p.items) if (ids.includes(it.id) && !it.tags.includes(tag)) it.tags.push(tag) })
            ;(e.target as HTMLInputElement).value = ''
          }} />
        </div>
      </div>
    </>
  )
}

// ------------------------------------------------------------------ branch

function BranchPanel({ branch }: { branch: Branch }) {
  const proj = useActiveProject()
  const mutate = useStore(s => s.mutate)
  const select = useStore(s => s.select)
  const showToast = useStore(s => s.showToast)
  const edit = (recipe: (b: Branch) => void) =>
    mutate(p => { const b = p.branches.find(x => x.id === branch.id); if (b) recipe(b) })
  return (
    <>
      <Head title="Branch">
        <button
          className="ghost-btn danger" title="Delete branch"
          onClick={() => {
            const pathIds = branch.paths.map(p => p.id)
            mutate(p => {
              p.branches = p.branches.filter(b => b.id !== branch.id)
              for (const it of p.items) if (it.pathId && pathIds.includes(it.pathId)) it.pathId = null
            })
            select([])
            showToast('Branch deleted — its items moved to the main line.', true)
          }}
        ><Trash2 width={14} height={14} /></button>
      </Head>
      <div className="insp-body">
        <div className="field">
          <label>Mode</label>
          <div className="seg">
            <button className={branch.mode === 'any' ? 'on' : ''} onClick={() => edit(b => { b.mode = 'any' })}>
              ANY — pick one path
            </button>
            <button className={branch.mode === 'all' ? 'on' : ''} onClick={() => edit(b => { b.mode = 'all' })}>
              ALL — every path, any order
            </button>
          </div>
        </div>
        <div className="row gap">
          <div className="field grow">
            <label>Fork at</label>
            <input className="input" type="number" step="0.5" value={round2(branch.forkPos)}
              onChange={e => edit(b => { b.forkPos = Math.min(Number(e.target.value), b.joinPos - 0.5) })} />
          </div>
          <div className="field grow">
            <label>Join at</label>
            <input className="input" type="number" step="0.5" value={round2(branch.joinPos)}
              onChange={e => edit(b => { b.joinPos = Math.max(Number(e.target.value), b.forkPos + 0.5) })} />
          </div>
        </div>
        <div className="field">
          <label>Paths</label>
          {branch.paths.map((path, i) => (
            <div key={path.id} className="row gap path-row">
              <input
                className="input grow" placeholder={`Path ${i + 1} label`}
                value={path.label}
                onChange={e => edit(b => { const pp = b.paths.find(x => x.id === path.id); if (pp) pp.label = e.target.value })}
              />
              <button
                className={`ghost-btn ${path.terminal ? 'on' : ''}`} title="Dead end (never rejoins)"
                onClick={() => edit(b => { const pp = b.paths.find(x => x.id === path.id); if (pp) pp.terminal = !pp.terminal })}
              >⏹</button>
              <button className="ghost-btn" disabled={i === 0} title="Move up"
                onClick={() => edit(b => { [b.paths[i - 1], b.paths[i]] = [b.paths[i], b.paths[i - 1]] })}
              ><ArrowUp width={13} height={13} /></button>
              <button className="ghost-btn" disabled={i === branch.paths.length - 1} title="Move down"
                onClick={() => edit(b => { [b.paths[i + 1], b.paths[i]] = [b.paths[i], b.paths[i + 1]] })}
              ><ArrowDown width={13} height={13} /></button>
              <button
                className="ghost-btn danger" disabled={branch.paths.length <= 2} title="Remove path"
                onClick={() => mutate(p => {
                  const b = p.branches.find(x => x.id === branch.id)
                  if (!b) return
                  b.paths = b.paths.filter(x => x.id !== path.id)
                  for (const it of p.items) if (it.pathId === path.id) it.pathId = null
                })}
              ><Trash2 width={13} height={13} /></button>
            </div>
          ))}
          {branch.paths.length < 4 && (
            <button className="ghost-btn add" onClick={() => edit(b => b.paths.push({ id: uid(), label: '', terminal: false }))}>
              + Add path
            </button>
          )}
        </div>
        <div className="sb-hint">drag a type from the sidebar onto a path line to place items on it</div>
      </div>
    </>
  )
}

// ------------------------------------------------------------------ section

function SectionPanel({ section }: { section: Section }) {
  const proj = useActiveProject()
  const mutate = useStore(s => s.mutate)
  const select = useStore(s => s.select)
  const showToast = useStore(s => s.showToast)
  const [preview, setPreview] = useState(false)
  const edit = (recipe: (s: Section) => void) =>
    mutate(p => { const s = p.sections.find(x => x.id === section.id); if (s) recipe(s) })
  // Items inside the section, in the order the timeline presents them.
  const contained = useMemo(
    () => proj.items
      .filter(it => it.pos >= section.start - 1e-9 && it.pos <= section.end + 1e-9)
      .sort((a, b) => a.pos - b.pos || a.title.localeCompare(b.title)),
    [proj.items, section.start, section.end],
  )
  const suffix = unitSuffix(proj.settings.unit.preset, proj.settings.unit.custom)
  return (
    <>
      <Head title={proj.hierarchyLevels[section.depth] ?? 'Section'}>
        <button
          className="ghost-btn danger" title="Delete section"
          onClick={() => { mutate(p => { p.sections = p.sections.filter(s => s.id !== section.id) }); select([]); showToast('Section deleted.', true) }}
        ><Trash2 width={14} height={14} /></button>
      </Head>
      <div className="insp-body">
        <input className="input title-input" value={section.name} onChange={e => edit(s => { s.name = e.target.value })} />
        <div className="row gap">
          <div className="field grow">
            <label>Starts</label>
            <input className="input" type="number" step="0.5" value={round2(section.start)}
              onChange={e => edit(s => { s.start = Math.min(Number(e.target.value), s.end - 0.25) })} />
          </div>
          <div className="field grow">
            <label>Ends</label>
            <input className="input" type="number" step="0.5" value={round2(section.end)}
              onChange={e => edit(s => { s.end = Math.max(Number(e.target.value), s.start + 0.25) })} />
          </div>
        </div>
        <div className="field">
          <label>Level</label>
          <select className="input" value={section.depth} onChange={e => edit(s => { s.depth = Number(e.target.value) })}>
            {proj.hierarchyLevels.map((n, d) => <option key={d} value={d}>{n}</option>)}
          </select>
        </div>
        <div className="field">
          <label>
            Description <span className="muted">(markdown)</span>
            <button className="link-btn right" onClick={() => setPreview(v => !v)}>{preview ? 'edit' : 'preview'}</button>
          </label>
          {preview ? (
            <div className="md-preview"><Markdown text={section.description || '*nothing yet*'} /></div>
          ) : (
            <textarea
              className="input desc"
              value={section.description ?? ''}
              onChange={e => edit(s => { s.description = e.target.value })}
            />
          )}
        </div>
        <div className="field">
          <label>Items inside <span className="muted">({contained.length})</span></label>
          {contained.length === 0 && <div className="sb-hint">no items inside this section</div>}
          <div className="insp-items">
            {contained.map(it => {
              const t = typeOf(proj, it)
              const Icon = iconByName(t?.icon ?? 'Circle')
              return (
                <button
                  key={it.id}
                  className="insp-item-row"
                  title="Jump to item"
                  onClick={() => nav.current?.flyToItem(it.id)}
                >
                  <Icon width={13} height={13} color={t?.color} strokeWidth={2} />
                  <span className="insp-item-title">{it.title || '…'}</span>
                  <span className="insp-item-pos">
                    {formatUnit(it.pos, Math.max(Math.abs(it.pos), 0.01), suffix, proj.settings.unit.preset)}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </>
  )
}

const round2 = (n: number) => Math.round(n * 100) / 100
