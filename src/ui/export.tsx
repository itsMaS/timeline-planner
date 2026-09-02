import { renderToStaticMarkup } from 'react-dom/server'
import { ListChecks, Shuffle } from 'lucide-react'
import { iconByName } from '../model/icons'
import { contentExtent, layoutTimeline, rowY, typeOf } from '../model/layout'
import type { Camera, Project } from '../model/types'
import { clamp, download, formatUnit, rulerStepFor, sectionHue, unitSuffix } from '../model/util'

interface Colors { bg: string; text: string; line: string; muted: string }
const DARK: Colors = { bg: '#111318', text: '#e6e8ee', line: '#3a3f4d', muted: '#8b91a0' }
const LIGHT: Colors = { bg: '#f6f7f9', text: '#23262e', line: '#c3c8d4', muted: '#6b7180' }

/** Pure, style-free SVG scene used for PNG/SVG export. */
function ExportScene(props: { proj: Project; cam: Camera; w: number; h: number; density: number; theme: 'dark' | 'light' }) {
  const { proj, cam, w, h, density, theme } = props
  const C = theme === 'dark' ? DARK : LIGHT
  const st = proj.settings
  const spineY = Math.round(h * 0.42)
  const sizeAt = (d0: number) => Math.max(10, st.sectionStyle.labelSize - 2.5 * d0)
  const barTopFor = (depth: number) => {
    let y = 0
    for (let d0 = 0; d0 < depth; d0++) y += sizeAt(d0) + 10
    return y
  }
  const maxDepth = proj.sections.length ? Math.max(...proj.sections.map(s => s.depth)) : -1
  const headerH = maxDepth >= 0 ? barTopFor(maxDepth + 1) : 0
  const maxUpRows = Math.max(1, Math.floor((spineY - headerH - 76) / 46) + 1)
  const layout = layoutTimeline(proj, cam, w, proj.filters, density, false, new Set(), new Set(), st.placement, maxUpRows)
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
          const edgeAlpha = clamp(st.sectionStyle.edgeStrength * Math.max(1 - 0.3 * sc.depth, 0.25), 0, 1)
          return (
            <g key={sc.id}>
              <rect x={x1} y={-spineY} width={x2 - x1} height={h}
                fill={`hsl(${hue} 60% 55% / ${(0.024 + sc.depth * 0.013) * st.bandStrength})`} />
              <line x1={x1} y1={-spineY} x2={x1} y2={h - spineY} stroke={`hsl(${hue} 55% 55% / ${edgeAlpha})`} strokeWidth={sc.depth === 0 ? 1.6 : 1} />
              <line x1={x2} y1={-spineY} x2={x2} y2={h - spineY} stroke={`hsl(${hue} 55% 55% / ${edgeAlpha})`} strokeWidth={sc.depth === 0 ? 1.6 : 1} />
            </g>
          )
        })}
        {/* header bars above the band edges so nothing cuts through them */}
        {(() => {
          const hueIdx = new Map<number, number>()
          return sorted.map(sc => {
            const i = hueIdx.get(sc.depth) ?? 0
            hueIdx.set(sc.depth, i + 1)
            const x1 = toX(sc.start)
            const x2 = toX(sc.end)
            if (x2 < 0 || x1 > w || x2 - x1 < 2) return null
            const hue = sectionHue(i)
            const labelPx = sizeAt(sc.depth)
            const barTop = -spineY + barTopFor(sc.depth)
            const showText = x2 - (Math.max(x1, 0) + 8) >= sc.name.length * labelPx * 0.62 + 8
            return (
              <g key={`hdr-${sc.id}`}>
                <rect x={x1} y={barTop} width={x2 - x1} height={labelPx + 10}
                  fill={C.bg} stroke={`hsl(${hue} 55% 55% / 0.45)`} />
                {showText && (
                  <text x={Math.max(x1, 0) + 8} y={barTop + labelPx + 3} fontFamily={font} fontSize={labelPx}
                    fontWeight={sc.depth === 0 ? 700 : 600}
                    fill={`hsl(${hue} 50% ${theme === 'dark' ? '70%' : '38%'})`}>{sc.name}</text>
                )}
              </g>
            )
          })
        })()}
        {(st.grid.show || st.unit.showRuler) && (() => {
          const step = rulerStepFor(cam.s, st.unit.preset)
          const n0 = Math.floor(cam.x / step)
          const n1 = Math.ceil((cam.x + w / cam.s) / step)
          const suffix = unitSuffix(st.unit.preset, st.unit.custom)
          const dash = st.grid.style === 'dashed' ? '5 7' : st.grid.style === 'dots' ? '0.5 9' : undefined
          const ticks = []
          for (let n = n0; n <= n1; n++) {
            const v = n * step
            const x = toX(v)
            ticks.push(
              <g key={n}>
                {st.grid.show && (
                  <line x1={x} y1={-spineY} x2={x} y2={h - spineY} stroke={C.line} opacity={st.grid.opacity * 0.6}
                    strokeDasharray={dash} strokeLinecap={st.grid.style === 'dots' ? 'round' : undefined} />
                )}
                {st.unit.showRuler && (
                  <>
                    <line x1={x} y1={-5} x2={x} y2={5} stroke={C.line} strokeWidth={1.5} />
                    <text x={x + 5} y={16} fontFamily={font} fontSize={10} fill={C.muted}>{formatUnit(v, step, suffix, st.unit.preset)}</text>
                  </>
                )}
              </g>,
            )
          }
          return <g>{ticks}</g>
        })()}
        <line x1={0} y1={0} x2={w} y2={0} stroke={C.line} strokeWidth={st.spine.width} opacity={st.spine.opacity} />
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
        {layout.dots.map(dot => (
          <circle key={dot.item.id} cx={dot.x} r={3.5} fill={dot.color} opacity={dot.ghost ? 0.2 : 1} />
        ))}
        {layout.placed.map(pl => {
          const t = typeOf(proj, pl.item)
          const Icon = iconByName(t?.icon ?? 'Circle')
          const y = rowY(pl.row)
          const z = pl.size || 1
          return (
            <g key={pl.item.id} transform={`translate(${pl.x}, ${y})`} opacity={pl.ghost ? 0.18 : 1}>
              <line x1={0} y1={y < 0 ? 14 * z : -14 * z} x2={0} y2={-y} stroke={t?.color} strokeWidth={1} opacity={0.35} />
              {pl.spanW > 0 && (
                <rect x={0} y={3 + 14 * z} width={pl.spanW} height={6} rx={3} fill={`${t?.color}55`} stroke={`${t?.color}88`} />
              )}
              <circle r={14 * z} fill={C.bg} stroke={t?.color} strokeWidth={1.5} />
              <Icon x={-8 * z} y={-8 * z} width={16 * z} height={16 * z} color={t?.color} strokeWidth={2} />
              {pl.labelShown && (
                <text x={20 * z} y={4 * z} fontFamily={font} fontSize={11.5 * clamp(z, 0.8, 1.35)} fill={C.text}>{pl.item.title}</text>
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
