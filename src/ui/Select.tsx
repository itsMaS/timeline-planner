import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Search } from 'lucide-react'

export type SelectOption = {
  value: string
  label: string
  /** Optional leading visual (type icon, colour dot, …). */
  icon?: React.ReactNode
  /** Extra text that is searchable but rendered muted after the label. */
  hint?: string
  /** Indentation level for tree-shaped option lists (folders). */
  depth?: number
}

type Props = {
  /** `null` selects nothing and shows the placeholder (e.g. bulk "apply to all" pickers). */
  value: string | null
  options: SelectOption[]
  onChange: (value: string) => void
  /** Shown on the trigger when `value` matches no option. */
  placeholder?: string
  searchPlaceholder?: string
  className?: string
  disabled?: boolean
  title?: string
}

const LIST_MAX = 240
const CHROME = 44 // search box + padding, used when estimating the popover height

/**
 * Drop-in replacement for a native `<select>`: a trigger styled like `.input`
 * that opens a searchable, keyboard-navigable popover. The popover is portaled
 * to `document.body` so it escapes scrolling panels and modals, and positioned
 * with fixed coordinates next to the trigger (flipping upwards when there is
 * no room below).
 */
export function Select(props: Props) {
  const { value, options, onChange, disabled } = props
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hi, setHi] = useState(0)
  const [pos, setPos] = useState<{ top: number; left: number; width: number; up: boolean; listMax: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const current = options.find(o => o.value === value)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter(o => o.label.toLowerCase().includes(q) || (o.hint ?? '').toLowerCase().includes(q))
  }, [options, query])

  const close = () => { setOpen(false); setQuery('') }
  const pick = (v: string) => { onChange(v); close(); triggerRef.current?.focus() }

  const openMenu = () => {
    if (disabled) return
    setQuery('')
    const idx = options.findIndex(o => o.value === value)
    setHi(idx >= 0 ? idx : 0)
    setOpen(true)
  }

  // Highlight follows the query: first match once filtering starts.
  useEffect(() => { if (open && query) setHi(0) }, [query, open])

  // Position the popover next to the trigger; re-measure on scroll/resize.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    const measure = () => {
      const el = triggerRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const gap = 4
      const below = window.innerHeight - r.bottom - gap - 8
      const above = r.top - gap - 8
      const want = Math.min(LIST_MAX, Math.max(filtered.length, 1) * 30) + CHROME
      const up = below < want && above > below
      const room = up ? above : below
      const listMax = Math.max(90, Math.min(LIST_MAX, room - CHROME))
      const width = Math.max(r.width, 180)
      const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8)
      setPos({
        top: up ? r.top - gap : r.bottom + gap,
        left,
        width,
        up,
        listMax,
      })
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [open, filtered.length])

  // Focus the search box as soon as the popover exists (it only mounts once positioned).
  const mounted = open && pos !== null
  useEffect(() => { if (mounted) searchRef.current?.focus() }, [mounted])

  // Click / tap outside closes.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (popRef.current?.contains(t) || triggerRef.current?.contains(t)) return
      close()
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  // Keep the highlighted row visible while arrowing through the list.
  useEffect(() => {
    if (!open) return
    const row = listRef.current?.querySelector<HTMLElement>(`[data-idx="${hi}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }, [hi, open])

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHi(h => (filtered.length ? (h + 1) % filtered.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHi(h => (filtered.length ? (h - 1 + filtered.length) % filtered.length : 0))
    } else if (e.key === 'Home') {
      e.preventDefault(); setHi(0)
    } else if (e.key === 'End') {
      e.preventDefault(); setHi(Math.max(0, filtered.length - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const o = filtered[hi]
      if (o) pick(o.value)
    } else if (e.key === 'Escape') {
      // Swallow it so the app's global Escape (deselect / close modal) does not fire.
      e.preventDefault(); e.stopPropagation()
      close(); triggerRef.current?.focus()
    } else if (e.key === 'Tab') {
      close()
    }
  }

  const onTriggerKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (open) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); openMenu()
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`input select-trigger ${open ? 'open' : ''} ${props.className ?? ''}`}
        disabled={disabled}
        title={props.title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onTriggerKey}
      >
        {current?.icon && <span className="select-ico">{current.icon}</span>}
        <span className={`select-label ${current ? '' : 'placeholder'}`}>
          {current ? current.label : (props.placeholder ?? '—')}
        </span>
        <ChevronDown className="chev" width={14} height={14} />
      </button>
      {open && pos && createPortal(
        <div
          ref={popRef}
          className={`select-pop ${pos.up ? 'up' : ''}`}
          role="listbox"
          style={{
            left: pos.left,
            width: pos.width,
            ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }),
          }}
        >
          <div className="select-search">
            <Search width={13} height={13} />
            <input
              ref={searchRef}
              value={query}
              placeholder={props.searchPlaceholder ?? 'Search…'}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={onSearchKey}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <div ref={listRef} className="select-list" style={{ maxHeight: pos.listMax }}>
            {filtered.map((o, i) => (
              <button
                key={o.value}
                type="button"
                data-idx={i}
                role="option"
                aria-selected={o.value === value}
                className={`select-opt ${i === hi ? 'hi' : ''} ${o.value === value ? 'on' : ''}`}
                style={o.depth ? { paddingLeft: 8 + o.depth * 14 } : undefined}
                onMouseDown={e => e.preventDefault()}
                onMouseMove={() => { if (hi !== i) setHi(i) }}
                onClick={() => pick(o.value)}
              >
                {o.icon && <span className="select-ico">{o.icon}</span>}
                <span className="select-opt-label">{o.label}</span>
                {o.hint && <span className="select-hint">{o.hint}</span>}
                {o.value === value && <Check className="select-check" width={13} height={13} />}
              </button>
            ))}
            {filtered.length === 0 && <div className="select-empty">No matches</div>}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
