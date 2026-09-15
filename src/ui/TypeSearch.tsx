import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Search } from 'lucide-react'
import { folderPath } from '../model/folders'
import { iconByName } from '../model/icons'
import type { ItemType, Project } from '../model/types'

/** Types matching a query: prefix matches first, then substrings, folder-path hits last. */
export function searchTypes(p: Project, query: string): ItemType[] {
  const q = query.trim().toLowerCase()
  if (!q) return p.types
  const rank = (t: ItemType): number => {
    const name = t.name.toLowerCase()
    if (name.startsWith(q)) return 0
    if (name.includes(q)) return 1
    if (folderPath(p, t.folderId ?? null).toLowerCase().includes(q)) return 2
    return -1
  }
  return p.types
    .map(t => ({ t, r: rank(t) }))
    .filter(x => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.t.name.localeCompare(b.t.name))
    .map(x => x.t)
}

/**
 * A type picker driven by typing: filters the project's item types as you
 * type, arrow keys move the highlight, Enter picks (the highlighted or first
 * match), Escape closes. With no match at all it offers to create a new type
 * under the typed name.
 */
export function TypeSearch(props: {
  proj: Project
  placeholder?: string
  autoFocus?: boolean
  /** Show every type while the query is empty (a picker) instead of nothing (a filter). */
  listWhenEmpty?: boolean
  /** Cap on listed matches. */
  limit?: number
  /** Called with the chosen type; the query clears and the input keeps focus for another pick. */
  onPick: (typeId: string) => void
  /** Offer "new type" when nothing matches; receives the typed name. */
  onCreateType?: (name: string) => void
  onClose?: () => void
}) {
  const { proj, limit = 8 } = props
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const [focused, setFocused] = useState(!!props.autoFocus)
  const inputRef = useRef<HTMLInputElement>(null)

  const matches = useMemo(() => {
    const list = q.trim() || props.listWhenEmpty ? searchTypes(proj, q) : []
    return list.slice(0, limit)
  }, [proj, q, limit, props.listWhenEmpty])
  const canCreate = !!props.onCreateType && q.trim().length > 0 &&
    !proj.types.some(t => t.name.toLowerCase() === q.trim().toLowerCase())
  // Rows = matches, then (optionally) the "new type" row.
  const rows = matches.length + (canCreate ? 1 : 0)
  useEffect(() => { setHi(0) }, [q])

  const pickRow = (i: number) => {
    if (i < matches.length) {
      props.onPick(matches[i].id)
    } else if (canCreate) {
      props.onCreateType!(q.trim())
    } else return
    setQ('')
    inputRef.current?.focus()
  }

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (rows) setHi(h => (h + 1) % rows) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (rows) setHi(h => (h - 1 + rows) % rows) }
    else if (e.key === 'Enter') { e.preventDefault(); if (rows) pickRow(Math.min(hi, rows - 1)) }
    else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (q) setQ('')
      else { inputRef.current?.blur(); props.onClose?.() }
    }
  }

  const open = focused && rows > 0
  return (
    <div className="type-search">
      <div className="search-box type-search-box">
        <Search width={13} height={13} />
        <input
          ref={inputRef}
          className="search-input"
          placeholder={props.placeholder ?? 'Add item…'}
          value={q}
          autoFocus={props.autoFocus}
          onChange={e => setQ(e.target.value)}
          onKeyDown={onKey}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
      </div>
      {open && (
        <div className="type-search-list" onPointerDown={e => e.preventDefault()}>
          {matches.map((t, i) => {
            const Icon = iconByName(t.icon)
            const path = folderPath(proj, t.folderId ?? null)
            return (
              <button
                key={t.id}
                className={`type-search-row ${i === hi ? 'hi' : ''}`}
                onMouseEnter={() => setHi(i)}
                onClick={() => pickRow(i)}
              >
                <span className="type-swatch sm" style={{ background: `${t.color}26`, color: t.color }}>
                  <Icon width={12} height={12} />
                </span>
                <span className="type-name">{t.name}</span>
                {path && <span className="type-search-path">{path}</span>}
              </button>
            )
          })}
          {canCreate && (
            <button
              className={`type-search-row new ${hi === matches.length ? 'hi' : ''}`}
              onMouseEnter={() => setHi(matches.length)}
              onClick={() => pickRow(matches.length)}
            >
              <span className="type-swatch sm"><Plus width={12} height={12} /></span>
              <span className="type-name">New type “{q.trim()}”</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
