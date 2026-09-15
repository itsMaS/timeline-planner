import React, { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Copy, Trash2, X } from 'lucide-react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { attachmentsFor, effectiveValue, levelOf, type Owner } from '../model/fields'
import { iconByName } from '../model/icons'
import { typeOf } from '../model/layout'
import { processorResults, type ProcessorResult } from '../model/processors'
import { useActiveProject, useCanEdit, useStore } from '../model/store'
import type { Branch, Item, Section } from '../model/types'
import { formatUnit, uid, unitSuffix } from '../model/util'
import { requestDelete } from './deletion'
import { entityLook, FieldRow, jumpTo, ReadFieldValue, ReferencedBy } from './FieldInputs'
import { Markdown } from './Markdown'
import { nav } from './nav'
import { uploadImage } from '../sync/share'

export function Inspector() {
  const proj = useActiveProject()
  const ui = useStore(s => s.ui)
  const canEdit = useCanEdit()
  const sel = ui.selection
  if (sel.length === 0) return null
  const branchId = sel.length === 1 && sel[0].startsWith('B:') ? sel[0].slice(2) : null
  const sectionId = sel.length === 1 && sel[0].startsWith('S:') ? sel[0].slice(2) : null
  const itemIds = sel.filter(s => !s.includes(':'))
  const branch = branchId ? proj.branches.find(b => b.id === branchId) : null
  const section = sectionId ? proj.sections.find(s => s.id === sectionId) : null
  if (!canEdit) {
    // View mode: everything is readable, nothing is editable.
    return (
      <aside className="inspector readonly" style={{ width: ui.inspectorW, minWidth: ui.inspectorW }}>
        {branch && <ReadBranchPanel branch={branch} />}
        {section && <ReadSectionPanel section={section} />}
        {itemIds.length === 1 && <ReadItemPanel id={itemIds[0]} />}
        {itemIds.length > 1 && <ReadBulkPanel ids={itemIds} />}
      </aside>
    )
  }
  return (
    <aside className="inspector" style={{ width: ui.inspectorW, minWidth: ui.inspectorW }}>
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

// ------------------------------------------------------------------ read-only panels

function ReadField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      <div className="read-value">{children}</div>
    </div>
  )
}

/** Compact "title · position" row that flies the camera to an item. */
function ItemJumpRow({ item }: { item: Item }) {
  const proj = useActiveProject()
  const t = typeOf(proj, item)
  const Icon = iconByName(t?.icon ?? 'Circle')
  const suffix = unitSuffix(proj.settings.unit.preset, proj.settings.unit.custom)
  return (
    <button className="insp-item-row" title="Jump to item" onClick={() => nav.current?.flyToItem(item.id)}>
      <Icon width={13} height={13} color={t?.color} strokeWidth={2} />
      <span className="insp-item-title">{item.title || '…'}</span>
      <span className="insp-item-pos">
        {formatUnit(item.pos, Math.max(Math.abs(item.pos), 0.01), suffix, proj.settings.unit.preset)}
      </span>
    </button>
  )
}

function ReadItemPanel({ id }: { id: string }) {
  const proj = useActiveProject()
  const item = proj.items.find(i => i.id === id)
  if (!item) return null
  const type = typeOf(proj, item)
  const Icon = iconByName(type?.icon ?? 'Circle')
  const layer = proj.layers.find(l => l.id === (item.layerId ?? type?.defaultLayerId))
  const path = item.pathId
    ? proj.branches.flatMap(b => b.paths.map((p, i) => ({ p, b, i }))).find(x => x.p.id === item.pathId)
    : null
  const suffix = unitSuffix(proj.settings.unit.preset, proj.settings.unit.custom)
  const fmt = (v: number) => formatUnit(v, Math.max(Math.abs(v), 0.01), suffix, proj.settings.unit.preset)
  const owner: Owner = { kind: 'item', entity: item }
  const fields = attachmentsFor(proj, owner)
    .map(a => ({ ...a, value: effectiveValue(a.field, a.att, item.fieldValues[a.field.id]) }))
    .filter(a => a.value !== null)
  return (
    <>
      <Head title={type?.name ?? 'Item'} />
      <div className="insp-body">
        <div className="read-title">
          <span className="type-swatch" style={{ background: `${type?.color ?? '#888'}26`, color: type?.color }}>
            <Icon width={15} height={15} />
          </span>
          <h3>{item.title || <span className="muted">Untitled</span>}</h3>
        </div>
        <div className="row gap">
          <ReadField label="Position">{fmt(item.pos)}</ReadField>
          <ReadField label="Span">{item.duration > 0 ? `${fmt(item.duration)} → ${fmt(item.pos + item.duration)}` : 'point'}</ReadField>
        </div>
        <div className="row gap">
          <ReadField label="Layer">{layer?.name ?? <span className="muted">none</span>}</ReadField>
          {path && (
            <ReadField label="Branch path">{path.p.label || `${path.b.mode.toUpperCase()} branch · path ${path.i + 1}`}</ReadField>
          )}
        </div>
        {item.tags.length > 0 && (
          <div className="field">
            <label>Tags</label>
            <div className="tt-tags">{item.tags.map(t => <span key={t} className="tag">{t}</span>)}</div>
          </div>
        )}
        {item.link && (
          <ReadField label="Link">
            <a className="link-btn" href={item.link} target="_blank" rel="noreferrer noopener">{item.link} ↗</a>
          </ReadField>
        )}
        {fields.map(f => (
          <ReadField key={f.field.id} label={f.field.name}><ReadFieldValue field={f.field} value={f.value} /></ReadField>
        ))}
        <ReferencedBy id={item.id} />
        <div className="field">
          <label>Description</label>
          <div className="md-preview"><Markdown text={item.description || '*no description*'} /></div>
        </div>
        {item.images.length > 0 && (
          <div className="img-strip read">
            {item.images.map((src, i) => (
              <a key={i} className="img-thumb" href={src} target="_blank" rel="noreferrer noopener" title="Open full size">
                <img src={src} alt="" />
              </a>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

function ReadBulkPanel({ ids }: { ids: string[] }) {
  const proj = useActiveProject()
  const items = useMemo(
    () => proj.items.filter(it => ids.includes(it.id)).sort((a, b) => a.pos - b.pos || a.title.localeCompare(b.title)),
    [proj.items, ids],
  )
  return (
    <>
      <Head title={`${items.length} items`} />
      <div className="insp-body">
        <div className="sb-hint">click one on the timeline to read its details</div>
        <div className="insp-items">
          {items.map(it => <ItemJumpRow key={it.id} item={it} />)}
        </div>
      </div>
    </>
  )
}

function ReadBranchPanel({ branch }: { branch: Branch }) {
  const proj = useActiveProject()
  const suffix = unitSuffix(proj.settings.unit.preset, proj.settings.unit.custom)
  const fmt = (v: number) => formatUnit(v, Math.max(Math.abs(v), 0.01), suffix, proj.settings.unit.preset)
  return (
    <>
      <Head title="Branch" />
      <div className="insp-body">
        <ReadField label="Mode">
          {branch.mode === 'any' ? 'ANY — pick one path' : 'ALL — every path, any order'}
        </ReadField>
        <div className="row gap">
          <ReadField label="Forks at">{fmt(branch.forkPos)}</ReadField>
          <ReadField label="Joins at">{fmt(branch.joinPos)}</ReadField>
        </div>
        <div className="field">
          <label>Paths</label>
          {branch.paths.map((path, i) => {
            const inside = proj.items
              .filter(it => it.pathId === path.id)
              .sort((a, b) => a.pos - b.pos || a.title.localeCompare(b.title))
            return (
              <div key={path.id} className="read-path">
                <div className="read-path-head">
                  <span>{path.label || <span className="muted">Path {i + 1}</span>}</span>
                  {path.terminal && <span className="tag">dead end</span>}
                  <span className="grow" />
                  <span className="count">{inside.length}</span>
                </div>
                {inside.length > 0 && (
                  <div className="insp-items">
                    {inside.map(it => <ItemJumpRow key={it.id} item={it} />)}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}

function ReadSectionPanel({ section }: { section: Section }) {
  const proj = useActiveProject()
  const contained = useMemo(
    () => proj.items
      .filter(it => it.pos >= section.start - 1e-9 && it.pos <= section.end + 1e-9)
      .sort((a, b) => a.pos - b.pos || a.title.localeCompare(b.title)),
    [proj.items, section.start, section.end],
  )
  const suffix = unitSuffix(proj.settings.unit.preset, proj.settings.unit.custom)
  const fmt = (v: number) => formatUnit(v, Math.max(Math.abs(v), 0.01), suffix, proj.settings.unit.preset)
  const owner: Owner = { kind: 'section', entity: section }
  const fields = attachmentsFor(proj, owner)
    .map(a => ({ ...a, value: effectiveValue(a.field, a.att, section.fieldValues?.[a.field.id]) }))
    .filter(a => a.value !== null)
  return (
    <>
      <Head title={levelOf(proj, section)?.name ?? 'Section'} />
      <div className="insp-body">
        <div className="read-title"><h3>{section.name || <span className="muted">Untitled</span>}</h3></div>
        <div className="row gap">
          <ReadField label="Starts">{fmt(section.start)}</ReadField>
          <ReadField label="Ends">{fmt(section.end)}</ReadField>
          <ReadField label="Length">{fmt(section.end - section.start)}</ReadField>
        </div>
        {fields.map(f => (
          <ReadField key={f.field.id} label={f.field.name}><ReadFieldValue field={f.field} value={f.value} /></ReadField>
        ))}
        <ProcessorPanel section={section} />
        <ReferencedBy id={section.id} />
        <div className="field">
          <label>Description</label>
          <div className="md-preview"><Markdown text={section.description || '*no description*'} /></div>
        </div>
        <div className="field">
          <label>Items inside <span className="muted">({contained.length})</span></label>
          {contained.length === 0 && <div className="sb-hint">no items inside this section</div>}
          <div className="insp-items">
            {contained.map(it => <ItemJumpRow key={it.id} item={it} />)}
          </div>
        </div>
      </div>
    </>
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
          onClick={() => requestDelete({ itemIds: [id] }, () => { select([]); showToast('Item deleted.', true) })}
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
        {attachmentsFor(proj, { kind: 'item', entity: item }).map(({ att, field }) => (
          <FieldRow
            key={field.id} field={field} att={att} ownerId={item.id}
            raw={item.fieldValues[field.id]}
            onChange={v => edit(it => { if (v === null) delete it.fieldValues[field.id]; else it.fieldValues[field.id] = v })}
          />
        ))}
        <ReferencedBy id={item.id} />
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
                  reader.onload = async () => {
                    let src = String(reader.result)
                    // Shared tabs keep images in Storage so patches stay small.
                    const share = useStore.getState().shares[proj.id]
                    if (share) {
                      try { src = await uploadImage(share.id, src) } catch { showToast('Image upload failed — kept inline (it may be too large to sync).') }
                    }
                    edit(it => { it.images = [...it.images, src] })
                  }
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
          onClick={() => requestDelete({ itemIds: ids }, () => { select([]); showToast(`${ids.length} items deleted.`, true) })}
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
          onClick={() => requestDelete({ branchIds: [branch.id] }, () => {
            select([])
            showToast('Branch deleted — its items moved to the main line.', true)
          })}
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
      <Head title={levelOf(proj, section)?.name ?? 'Section'}>
        <button
          className="ghost-btn danger" title="Delete section"
          onClick={() => requestDelete({ sectionIds: [section.id] }, () => { select([]); showToast('Section deleted.', true) })}
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
            {proj.hierarchyLevels.map((l, d) => <option key={l.id} value={d}>{l.name}</option>)}
          </select>
          <div className="sb-hint">nesting is geometric — a section inside another sits one level deeper</div>
        </div>
        {attachmentsFor(proj, { kind: 'section', entity: section }).map(({ att, field }) => (
          <FieldRow
            key={field.id} field={field} att={att} ownerId={section.id}
            raw={section.fieldValues?.[field.id]}
            onChange={v => edit(sc => { sc.fieldValues ??= {}; if (v === null) delete sc.fieldValues[field.id]; else sc.fieldValues[field.id] = v })}
          />
        ))}
        <ProcessorPanel section={section} />
        <ReferencedBy id={section.id} />
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

// ------------------------------------------------------------------ processors

/** Results of the processors attached to the section's level, each expandable to its matches. */
function ProcessorPanel({ section }: { section: Section }) {
  const proj = useActiveProject()
  const canEdit = useCanEdit()
  const setUI = useStore(s => s.setUI)
  const results = useMemo(() => processorResults(proj, section), [proj, section])
  const [openId, setOpenId] = useState<string | null>(null)
  const level = levelOf(proj, section)
  if (!results.length) {
    if (!canEdit || !level) return null
    return (
      <div className="field">
        <label>Processors</label>
        <div className="sb-hint">
          none on this level yet — <button className="link-btn" onClick={() => setUI({ editLevelId: level.id })}>edit “{level.name}”</button>
        </div>
      </div>
    )
  }
  return (
    <div className="field">
      <label>
        Processors
        {canEdit && level && (
          <button className="link-btn right" onClick={() => setUI({ editLevelId: level.id })}>edit level</button>
        )}
      </label>
      <div className="proc-list">
        {results.map(r => <ProcessorRow key={r.proc.id} r={r} open={openId === r.proc.id} toggle={() => setOpenId(o => (o === r.proc.id ? null : r.proc.id))} />)}
      </div>
    </div>
  )
}

function ProcessorRow({ r, open, toggle }: { r: ProcessorResult; open: boolean; toggle: () => void }) {
  const proj = useActiveProject()
  const Chev = open ? ChevronDown : ChevronRight
  return (
    <div className={`proc-row ${r.error ? 'err' : ''}`}>
      <button className="proc-head" onClick={toggle} title={r.error ?? `${r.matched.length} matched`}>
        <Chev width={12} height={12} />
        <span className="proc-name">{r.proc.name}</span>
        <span className="grow" />
        <span className="proc-value">{r.error ? r.error : r.text}</span>
        <span className="count">{r.matched.length}</span>
      </button>
      {open && (
        <div className="insp-items">
          {r.matched.length === 0 && <div className="sb-hint">nothing inside matches</div>}
          {r.matched.map(o => {
            const look = entityLook(proj, o)
            const Icon = iconByName(look.icon)
            const title = o.kind === 'item' ? o.entity.title : o.entity.name
            return (
              <button key={o.entity.id} className="insp-item-row" title="Jump" onClick={() => jumpTo(proj, o.entity.id)}>
                <Icon width={13} height={13} color={look.color} strokeWidth={2} />
                <span className="insp-item-title">{title || '…'}</span>
                <span className="insp-item-pos">{look.typeName}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
