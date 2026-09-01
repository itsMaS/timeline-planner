import { useMemo, useState } from 'react'
import { ALL_ICON_NAMES, ICON_CATEGORIES, iconByName, searchIcons } from '../model/icons'

export function IconPicker(props: { value: string; onPick: (name: string) => void }) {
  const [query, setQuery] = useState('')
  const [cat, setCat] = useState<string>('Story')
  const cats = Object.keys(ICON_CATEGORIES)

  const names = useMemo(() => {
    if (query.trim()) return searchIcons(query)
    if (cat === 'All') return ALL_ICON_NAMES.slice(0, 240)
    return ICON_CATEGORIES[cat] ?? []
  }, [query, cat])

  return (
    <div className="icon-picker">
      <input
        className="input"
        placeholder={`Search ${ALL_ICON_NAMES.length} icons…`}
        value={query}
        onChange={e => setQuery(e.target.value)}
        autoFocus
      />
      {!query.trim() && (
        <div className="icon-cats">
          {[...cats, 'All'].map(c => (
            <button key={c} className={`chip ${cat === c ? 'on' : ''}`} onClick={() => setCat(c)}>{c}</button>
          ))}
        </div>
      )}
      <div className="icon-grid">
        {names.map(n => {
          const Icon = iconByName(n)
          return (
            <button
              key={n}
              title={n}
              className={`icon-cell ${props.value === n ? 'on' : ''}`}
              onClick={() => props.onPick(n)}
            >
              <Icon width={18} height={18} />
            </button>
          )
        })}
        {names.length === 0 && <div className="muted pad">No icons match.</div>}
      </div>
    </div>
  )
}
