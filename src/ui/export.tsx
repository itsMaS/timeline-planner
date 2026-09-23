import { renderToStaticMarkup } from 'react-dom/server'
import { iconByName } from '../model/icons'
import { contentExtent, isFieldShown, layoutTimeline, rowY, spineYFor, splitLabel, toggleBadges, typeOf } from '../model/layout'
import type { Camera, Project } from '../model/types'
import { clamp, download, formatUnit, rulerStepFor, sectionHue, unitSuffix } from '../model/util'
import { attachmentsFor, effectiveValue, formatValue, levelOf, orderedFields } from '../model/fields'
import { bandBadge, shownProcessorResults } from '../model/processors'
import { ToggleBadges } from './Canvas'
import { scopedProject, type ExportScope } from './exportScope'

interface Colors { bg: string; text: string; line: string; muted: string }
const DARK: Colors = { bg: '#111318', text: '#e6e8ee', line: '#3a3f4d', muted: '#8b91a0' }
const LIGHT: Colors = { bg: '#f6f7f9', text: '#23262e', line: '#c3c8d4', muted: '#6b7180' }

export interface SceneOptions {
  density: number
  theme: 'dark' | 'light'
  showFields: boolean
  showTitles: boolean
}

/** Pure, style-free SVG scene used for PNG/SVG export. `proj` holds only the items in scope. */
function ExportScene(props: { proj: Project; cam: Camera; w: number; h: number } & SceneOptions) {
  const { proj, cam, w, h, density, theme, showFields, showTitles } = props
  const C = theme === 'dark' ? DARK : LIGHT
  const st = proj.settings
  const spineY = spineYFor(proj, h)
  const sizeAt = (d0: number) => Math.max(10, st.sectionStyle.labelSize - 2.5 * d0)
  const barTopFor = (depth: number) => {
    let y = 0
    for (let d0 = 0; d0 < depth; d0++) y += sizeAt(d0) + 10
    return y
  }
  const maxDepth = proj.sections.length ? Math.max(...proj.sections.map(s => s.depth)) : -1
  const headerH = maxDepth >= 0 ? barTopFor(maxDepth + 1) : 0
  const maxUpRows = Math.max(1, Math.floor((spineY - headerH - 76) / 46) + 1)
  const layout = layoutTimeline(proj, cam, w, proj.filters, density, true, new Set(), new Set(), st.placement, maxUpRows, showFields, showTitles)
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
            const avail = x2 - (Math.max(x1, 0) + 8)
            const marks = toggleBadges(proj, { kind: 'section', entity: sc }).filter(b => b.on).map(() => ' ✓').join('')
            const nameW = (sc.name.length + marks.length) * labelPx * 0.62
            const showText = avail >= nameW + 8
            const dur = sc.end - sc.start
            const durText = st.sectionStyle.showDuration
              ? formatUnit(dur, dur, unitSuffix(st.unit.preset, st.unit.custom), st.unit.preset)
              : ''
            const durPx = Math.max(labelPx - 2.5, 9)
            const showDur = !!durText && avail >= nameW + 8 + durText.length * durPx * 0.62 + 10
            const badge = bandBadge(proj, sc)
            const textEnd = Math.max(x1, 0) + 8 + nameW + (showDur ? 8 + durText.length * durPx * 0.62 : 0)
            const badgeX = Math.min(x2, w) - 8
            const showBadge = !!badge && showText && badgeX - badge.length * durPx * 0.62 >= textEnd + 14
            return (
              <g key={`hdr-${sc.id}`}>
                <rect x={x1} y={barTop} width={x2 - x1} height={labelPx + 10}
                  fill={C.bg} stroke={`hsl(${hue} 55% 55% / 0.45)`} />
                {showText && (
                  <text x={Math.max(x1, 0) + 8} y={barTop + labelPx + 3} fontFamily={font} fontSize={labelPx}
                    fontWeight={sc.depth === 0 ? 700 : 600}
                    fill={`hsl(${hue} 50% ${theme === 'dark' ? '70%' : '38%'})`}>{sc.name}{marks && <tspan fill="#22c55e">{marks}</tspan>}</text>
                )}
                {showDur && (
                  <text x={Math.max(x1, 0) + 8 + nameW + 8} y={barTop + labelPx + 3} fontFamily={font} fontSize={durPx}
                    fill={`hsl(${hue} 45% ${theme === 'dark' ? '70%' : '38%'} / 0.55)`}>{durText}</text>
                )}
                {showBadge && (
                  <text x={badgeX} y={barTop + labelPx + 3} textAnchor="end" fontFamily={font} fontSize={durPx} fontWeight={600}
                    fill={`hsl(${hue} 50% ${theme === 'dark' ? '70%' : '38%'} / 0.85)`}>{badge}</text>
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
        {layout.dots.map(dot => (
          <circle key={dot.item.id} cx={dot.x} cy={0} r={3.5} fill={dot.color} opacity={dot.ghost ? 0.2 : 1} />
        ))}
        {layout.placed.map(pl => {
          const t = typeOf(proj, pl.item)
          const z = pl.size || 1
          return (
            <line key={`stem-${pl.item.id}`} x1={pl.x} y1={pl.ny + (pl.ny < 0 ? 14 * z : -14 * z)} x2={pl.x} y2={0}
              stroke={t?.color} strokeWidth={1} opacity={pl.ghost ? 0.1 : 0.35} />
          )
        })}
        {layout.placed.map(pl => {
          const t = typeOf(proj, pl.item)
          const Icon = iconByName(t?.icon ?? 'Circle')
          const z = pl.size || 1
          return (
            <g key={pl.item.id} transform={`translate(${pl.x}, ${pl.ny})`} opacity={pl.ghost ? 0.18 : 1}>
              {pl.spanW > 0 && (
                <rect x={0} y={3 + 14 * z} width={pl.spanW} height={6} rx={3} fill={`${t?.color}55`} stroke={`${t?.color}88`} />
              )}
              <circle r={14 * z} fill={C.bg} stroke={t?.color} strokeWidth={1.5} />
              <Icon x={-8 * z} y={-8 * z} width={16 * z} height={16 * z} color={t?.color} strokeWidth={2} />
              <ToggleBadges badges={toggleBadges(proj, { kind: 'item', entity: pl.item })} z={z} plain />
              {pl.labelShown && (() => {
                const label = splitLabel(proj, pl.item, showFields, showTitles)
                return (
                  <text x={20 * z} y={4 * z} fontFamily={font} fontSize={11.5 * clamp(z, 0.8, 1.35)} fill={C.text}>
                    {label.title}
                    {label.fields && <tspan fill={C.muted} fontSize={10.5 * clamp(z, 0.8, 1.35)}>{label.title ? ` · ${label.fields}` : label.fields}</tspan>}
                  </text>
                )
              })()}
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

/**
 * The items in scope in timeline order, one row per item. Each hierarchy
 * level gets its own column holding the name of the section containing the
 * item at that depth (e.g. a Chapter column and a Level column).
 */
export function exportCSV(proj: Project, scope: ExportScope) {
  const esc = (v: string | number) => {
    const s = String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const sectionAt = (depth: number, pos: number) =>
    proj.sections.find(sc => sc.depth === depth && sc.start <= pos && sc.end >= pos)?.name ?? ''
  const maxDepth = proj.sections.reduce((n, sc) => Math.max(n, sc.depth), -1)
  const levels = Array.from(
    { length: maxDepth + 1 },
    (_, d) => proj.hierarchyLevels[d]?.name ?? `Level ${d + 1}`,
  )
  // Field columns follow the sidebar order (root fields, then folder by folder); hidden fields and processors stay out.
  const fields = orderedFields(proj).filter(f => !(proj.filters.offFields ?? []).includes(f.id))
  const processors = proj.processors.filter(pr => !(proj.filters.offProcessors ?? []).includes(pr.id))
  const header = [...levels, 'Title', 'Type', 'Position', 'Duration', 'Tags', 'Description', 'Link', 'Created by', ...fields.map(f => f.name)]
  const rows = scope.items
    .map(it => {
      const atts = attachmentsFor(proj, { kind: 'item', entity: it })
      return [
        ...levels.map((_, d) => sectionAt(d, it.pos)),
        it.title,
        typeOf(proj, it)?.name ?? '',
        it.pos,
        it.duration,
        it.tags.join('; '),
        it.description,
        it.link,
        it.createdBy?.name ?? '',
        ...fields.map(f => {
          const a = atts.find(x => x.field.id === f.id)
          return a ? formatValue(proj, f, effectiveValue(f, a.att, it.fieldValues[f.id])) : ''
        }),
      ].map(esc).join(',')
    })
  // Second table: the sections in scope with their own field values and every
  // processor result (blank where the processor is not on the section's level).
  const inScope = (sc: { start: number; end: number }) =>
    !scope.sections.length || scope.sections.some(s => sc.start >= s.start - 1e-9 && sc.end <= s.end + 1e-9)
  const sections = [...proj.sections].filter(inScope).sort((a, b) => a.start - b.start || a.depth - b.depth)
  const secHeader = ['Level', 'Section', 'Start', 'End', 'Length', 'Description', ...fields.map(f => f.name), ...processors.map(p => p.name)]
  const secRows = sections.map(sc => {
    const atts = attachmentsFor(proj, { kind: 'section', entity: sc })
    const results = new Map(shownProcessorResults(proj, sc).map(r => [r.proc.id, r]))
    return [
      levelOf(proj, sc)?.name ?? `Level ${sc.depth + 1}`,
      sc.name,
      sc.start,
      sc.end,
      sc.end - sc.start,
      sc.description ?? '',
      ...fields.map(f => {
        const a = atts.find(x => x.field.id === f.id)
        return a ? formatValue(proj, f, effectiveValue(f, a.att, sc.fieldValues?.[f.id])) : ''
      }),
      ...processors.map(p => { const r = results.get(p.id); return r && !r.error ? r.text : '' }),
    ].map(esc).join(',')
  })
  const parts = [header.map(esc).join(','), ...rows]
  if (sections.length) parts.push('', secHeader.map(esc).join(','), ...secRows)
  const csv = '\ufeff' + parts.join('\r\n')
  download(`${proj.name.replace(/\s+/g, '-').toLowerCase()}.csv`,
    new Blob([csv], { type: 'text/csv;charset=utf-8' }))
}

export function exportJSON(proj: Project) {
  download(`${proj.name.replace(/\s+/g, '-').toLowerCase()}.timeline.json`,
    new Blob([JSON.stringify(proj, null, 2)], { type: 'application/json' }))
}

/** The current view (camera as on screen) with only the items in scope. */
export function exportPNG(proj: Project, scope: ExportScope, w: number, h: number, opts: SceneOptions) {
  const markup = renderToStaticMarkup(
    <ExportScene proj={scopedProject(proj, scope)} cam={proj.camera} w={w} h={h} {...opts} />,
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

/** The whole timeline — or just the selected sections' range — with only the items in scope. */
export function exportFullSVG(proj: Project, scope: ExportScope, opts: Omit<SceneOptions, 'density'>) {
  const scoped = scopedProject(proj, scope)
  const { min, max } = scope.range
    ? (() => { const pad = Math.max((scope.range.max - scope.range.min) * 0.04, 0.5); return { min: scope.range.min - pad, max: scope.range.max + pad } })()
    : contentExtent(scoped)
  const span = max - min
  const s = clamp(6000 / span, 12, 80)
  const w = Math.ceil(span * s)
  const h = 760
  const markup = renderToStaticMarkup(
    <ExportScene proj={scoped} cam={{ x: min, s }} w={w} h={h} density={1} {...opts} />,
  )
  download(`${proj.name.replace(/\s+/g, '-').toLowerCase()}.svg`,
    new Blob([markup], { type: 'image/svg+xml' }))
}
