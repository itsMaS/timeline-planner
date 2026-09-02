import { renderToStaticMarkup } from 'react-dom/server'
import { ListChecks, Shuffle } from 'lucide-react'
import { iconByName } from '../model/icons'
import { contentExtent, displayLabel, layoutTimeline, rowY, typeOf } from '../model/layout'
import type { Camera, Project } from '../model/types'
import { clamp, download, sectionHue } from '../model/util'

interface Colors { bg: string; text: string; line: string; muted: string }
const DARK: Colors = { bg: '#111318', text: '#e6e8ee', line: '#3a3f4d', muted: '#8b91a0' }
const LIGHT: Colors = { bg: '#f6f7f9', text: '#23262e', line: '#c3c8d4', muted: '#6b7180' }

/** Pure, style-free SVG scene used for PNG/SVG export. */
function ExportScene(props: { proj: Project; cam: Camera; w: number; h: number; density: number; theme: 'dark' | 'light' }) {
  const { proj, cam, w, h, density, theme } = props
  const C = theme === 'dark' ? DARK : LIGHT
  const layout = layoutTimeline(proj, cam, w, proj.filters, density, false, new Set())
  const spineY = Math.round(h * 0.42)
  const toX = (pos: number) => (pos - cam.x) * cam.s
  const font = 'ui-sans-serif, system-ui, sans-serif'

  const depthCounters = new Map<number, number>()
  const sorted = [...proj.sections].sort((a, b) => a.depth - b.depth || a.start - b.start)

  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <rect width={w} height={h} fill={C.bg} />
      <g transform={`translate(0, ${spineY})`}>
        {sorted.map(sc => {
          const i = depthCounters.get(sc.depth) ?? 0
          depthCounters.set(sc.depth, i + 1)
          const x1 = toX(sc.start)
          const x2 = toX(sc.end)
          if (x2 < 0 || x1 > w || x2 - x1 < 20) return null
          const hue = sectionHue(i)
          return (
            <g key={sc.id}>
              <rect x={x1} y={-spineY} width={x2 - x1} height={h}
                fill={`hsl(${hue} 60% 55% / ${0.024 + sc.depth * 0.013})`} />
              <line x1={x1} y1={-spineY} x2={x1} y2={h - spineY} stroke={`hsl(${hue} 55% 55% / 0.2)`} />
              <line x1={x2} y1={-spineY} x2={x2} y2={h - spineY} stroke={`hsl(${hue} 55% 55% / 0.2)`} />
              <text x={Math.max(x1, 0) + 10} y={-spineY + 20 + sc.depth * 19} fontFamily={font} fontSize={11} fontWeight={600}
                fill={`hsl(${hue} 50% ${theme === 'dark' ? '70%' : '38%'})`}>{sc.name}</text>
            </g>
          )
        })}
        <line x1={0} y1={0} x2={w} y2={0} stroke={C.line} strokeWidth={2} />
        {layout.branches.map(bl => {
          const { branch } = bl
          const dash = branch.mode === 'any' ? '7 5' : undefined
          const GateIcon = branch.mode === 'any' ? Shuffle : ListChecks
          return (
            <g key={branch.id}>
              {branch.paths.map((path, i) => {
                const yOff = bl.pathYs[i]
                const endX = path.terminal ? bl.joinX - 74 : bl.joinX
                const d = `M ${bl.forkX} 0 C ${bl.forkX + 30} 0, ${bl.forkX + 26} ${yOff}, ${bl.forkX + 58} ${yOff}` +
                  ` L ${Math.max(bl.forkX + 58, endX - 58)} ${yOff}` +
                  (path.terminal ? '' : ` C ${endX - 26} ${yOff}, ${endX - 30} 0, ${endX} 0`)
                return (
                  <g key={path.id}>
                    <path d={d} fill="none" stroke={C.line} strokeWidth={2} strokeDasharray={dash} />
                    {path.label && (
                      <text x={bl.forkX + 68} y={yOff - 10} fontFamily={font} fontSize={10} fontStyle="italic" fill={C.muted}>
                        {path.label}
                      </text>
                    )}
                    {bl.items[i].map(pi => {
                      const t = typeOf(proj, pi.item)
                      const Icon = iconByName(t?.icon ?? 'Circle')
                      return (
                        <g key={pi.item.id} transform={`translate(${pi.x}, ${pi.y})`} opacity={pi.ghost ? 0.2 : 1}>
                          <circle r={11} fill={C.bg} stroke={t?.color} strokeWidth={1.5} />
                          <Icon x={-6.5} y={-6.5} width={13} height={13} color={t?.color} strokeWidth={2} />
                          {pi.labelShown && (
                            <text x={16} y={21} fontFamily={font} fontSize={10} fill={C.muted}>{pi.item.title}</text>
                          )}
                        </g>
                      )
                    })}
                  </g>
                )
              })}
              <circle cx={bl.forkX} r={12} fill={C.bg} stroke={C.line} strokeWidth={1.5} />
              <GateIcon x={bl.forkX - 7} y={-7} width={14} height={14} color={C.text} strokeWidth={2} />
              <circle cx={bl.joinX} r={5} fill={C.line} />
            </g>
          )
        })}
        {layout.placed.map(pl => {
          const t = typeOf(proj, pl.item)
          const y = rowY(pl.row)
          return (
            <line key={`stem-${pl.item.id}`} x1={pl.x} y1={y + (y < 0 ? 14 : -14)} x2={pl.x} y2={0}
              stroke={t?.color} strokeWidth={1} opacity={pl.ghost ? 0.1 : 0.35} />
          )
        })}
        {layout.placed.map(pl => {
          const t = typeOf(proj, pl.item)
          const Icon = iconByName(t?.icon ?? 'Circle')
          const y = rowY(pl.row)
          return (
            <g key={pl.item.id} transform={`translate(${pl.x}, ${y})`} opacity={pl.ghost ? 0.18 : 1}>
              {pl.spanW > 0 && (
                <rect x={0} y={17} width={pl.spanW} height={6} rx={3} fill={`${t?.color}55`} stroke={`${t?.color}88`} />
              )}
              <circle r={14} fill={C.bg} stroke={t?.color} strokeWidth={1.5} />
              <Icon x={-8} y={-8} width={16} height={16} color={t?.color} strokeWidth={2} />
              {pl.labelShown && (
                <text x={20} y={4} fontFamily={font} fontSize={11.5} fill={C.text}>{displayLabel(pl.item.title)}</text>
              )}
            </g>
          )
        })}
        {layout.clusters.map(cl => (
          <g key={cl.key} transform={`translate(${cl.x}, 0)`}>
            {cl.count === 1
              ? <circle r={4.5} fill={cl.color} />
              : (
                <>
                  <rect x={-15} y={-10} width={30} height={20} rx={10} fill={C.bg} stroke={cl.color} />
                  <text y={4} textAnchor="middle" fontFamily={font} fontSize={10.5} fontWeight={700} fill={cl.color}>
                    +{cl.count}
                  </text>
                </>
              )}
          </g>
        ))}
      </g>
      <text x={12} y={h - 12} fontFamily={font} fontSize={11} fill={C.muted}>{proj.name}</text>
    </svg>
  )
}

export function exportJSON(proj: Project) {
  download(`${proj.name.replace(/\s+/g, '-').toLowerCase()}.timeline.json`,
    new Blob([JSON.stringify(proj, null, 2)], { type: 'application/json' }))
}

/**
 * All items in timeline order, one row per item. Each hierarchy level gets its
 * own column holding the section that contains the item at that depth.
 */
export function exportCSV(proj: Project) {
  const esc = (v: string | number) => {
    const s = String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const sectionAt = (depth: number, pos: number) =>
    proj.sections.find(sc => sc.depth === depth && sc.start <= pos && sc.end >= pos)?.name ?? ''
  const pathName = (pathId: string | null) => {
    if (!pathId) return ''
    for (const br of proj.branches) {
      const i = br.paths.findIndex(pp => pp.id === pathId)
      if (i >= 0) return br.paths[i].label || `Path ${i + 1}`
    }
    return ''
  }
  const header = [...proj.hierarchyLevels, 'Title', 'Type', 'Position', 'Duration', 'Branch path', 'Tags', 'Description', 'Link']
  const rows = [...proj.items]
    .sort((a, b) => a.pos - b.pos)
    .map(it => [
      ...proj.hierarchyLevels.map((_, d) => sectionAt(d, it.pos)),
      it.title,
      typeOf(proj, it)?.name ?? '',
      it.pos,
      it.duration,
      pathName(it.pathId),
      it.tags.join('; '),
      it.description,
      it.link,
    ].map(esc).join(','))
  const csv = '\ufeff' + [header.map(esc).join(','), ...rows].join('\r\n')
  download(`${proj.name.replace(/\s+/g, '-').toLowerCase()}.csv`,
    new Blob([csv], { type: 'text/csv;charset=utf-8' }))
}

export function exportPNG(proj: Project, w: number, h: number, density: number, theme: 'dark' | 'light') {
  const markup = renderToStaticMarkup(
    <ExportScene proj={proj} cam={proj.camera} w={w} h={h} density={density} theme={theme} />,
  )
  const svgBlob = new Blob([markup], { type: 'image/svg+xml' })
  const url = URL.createObjectURL(svgBlob)
  const img = new Image()
  img.onload = () => {
    const scale = 2
    const canvas = document.createElement('canvas')
    canvas.width = w * scale
    canvas.height = h * scale
    const ctx = canvas.getContext('2d')!
    ctx.scale(scale, scale)
    ctx.drawImage(img, 0, 0)
    canvas.toBlob(blob => {
      if (blob) download(`${proj.name.replace(/\s+/g, '-').toLowerCase()}.png`, blob)
      URL.revokeObjectURL(url)
    }, 'image/png')
  }
  img.src = url
}

export function exportFullSVG(proj: Project, density: number, theme: 'dark' | 'light') {
  const { min, max } = contentExtent(proj)
  const span = max - min
  const s = clamp(6000 / span, 12, 80)
  const w = Math.ceil(span * s)
  const h = 760
  const markup = renderToStaticMarkup(
    <ExportScene proj={proj} cam={{ x: min, s }} w={w} h={h} density={1} theme={theme} />,
  )
  download(`${proj.name.replace(/\s+/g, '-').toLowerCase()}.svg`,
    new Blob([markup], { type: 'image/svg+xml' }))
}
