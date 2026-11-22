import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { show } from './screen'
import { chartPoints, niceTicks, timeOf, xLabel, type ChartPoint, type ChartSpec } from './chart-data'

export type { ChartKind, ChartPoint, ChartSpec } from './chart-data'

const COLORS = ['var(--accent, #4f8cff)', '#e0a84f', '#b07cf0', '#3fc1c9', '#f07c9a']
const UP = 'var(--ok, #3fb97c)', DOWN = 'var(--bad, #e5605c)', LINE = 'var(--line, #272c37)', MUTED = 'var(--muted, #8b93a4)'

/** A price or value chart drawn in SVG: candlesticks, lines, areas or bars, with a volume pane and a hover crosshair. */
export function Chart({ kind = 'line', rows, x, y, volume = true, height = 280 }: ChartSpec) {
  const box = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(640)
  const [hover, setHover] = useState<number | null>(null)
  useEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((e) => setW(Math.max(200, Math.floor(e[0].contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const { points, ys } = chartPoints({ kind, rows, x, y })
  if (!points.length) return <div ref={box} className="lu-empty">No chart data yet.</div>

  const candle = kind === 'candlestick'
  const hasVol = volume && kind !== 'bar' && points.some((p) => p.v !== undefined)
  const L = 8, R = 58, T = 10, B = 24
  const plotW = w - L - R
  const volH = hasVol ? Math.round((height - T - B) * 0.2) : 0
  const priceH = height - T - B - volH - (hasVol ? 6 : 0)
  const lows = points.flatMap((p) => (candle ? [p.l] : p.ys.filter(Number.isFinite)))
  const highs = points.flatMap((p) => (candle ? [p.h] : p.ys.filter(Number.isFinite)))
  let lo = Math.min(...lows), hi = Math.max(...highs)
  if (kind === 'bar' || kind === 'area') lo = Math.min(0, lo)
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.06
  if (kind !== 'bar') lo -= pad
  hi += pad
  const yOf = (v: number) => T + priceH - ((v - lo) / (hi - lo)) * priceH
  const step = plotW / points.length
  const cx = (i: number) => L + (i + 0.5) * step
  const ticks = niceTicks(lo, hi, Math.max(3, Math.round(priceH / 55)))
  const vMax = hasVol ? Math.max(...points.map((p) => p.v ?? 0)) || 1 : 1
  const volTop = T + priceH + 6
  const t0 = timeOf(points[0].x), t1 = timeOf(points[points.length - 1].x)
  const span = Number.isFinite(t0) && Number.isFinite(t1) ? Math.abs(t1 - t0) : 0
  const nLabels = Math.max(2, Math.floor(plotW / 90))
  const every = Math.max(1, Math.ceil(points.length / nLabels))
  const bw = Math.max(1, Math.min(14, step * 0.65))
  const last = points[points.length - 1]
  const lastVal = candle ? last.c : last.ys[0]
  const up = (p: ChartPoint) => p.c >= p.o

  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const i = Math.floor((e.clientX - r.left - L) / step)
    setHover(i >= 0 && i < points.length ? i : null)
  }
  const hp = hover == null ? null : points[hover]

  return (
    <div ref={box} className="lu-chart" style={{ position: 'relative' }}>
      <svg width={w} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)} style={{ display: 'block' }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={L + plotW} y1={yOf(t)} y2={yOf(t)} stroke={LINE} strokeDasharray="2 4" />
            <text x={L + plotW + 6} y={yOf(t) + 4} fill={MUTED} fontSize={11}>{show(t)}</text>
          </g>
        ))}
        {points.map((p, i) => (i % every === 0 && (i > 0 || cx(i) > 28) ? <text key={`x${i}`} x={cx(i)} y={height - 6} fill={MUTED} fontSize={11} textAnchor="middle">{xLabel(p.x, span)}</text> : null))}
        {hasVol && points.map((p, i) => p.v !== undefined && (
          <rect key={`v${i}`} x={cx(i) - bw / 2} width={bw} y={volTop + volH - (p.v / vMax) * volH} height={(p.v / vMax) * volH}
            fill={candle ? (up(p) ? UP : DOWN) : MUTED} opacity={0.35} />
        ))}
        {candle && points.map((p, i) => (
          <g key={i} stroke={up(p) ? UP : DOWN} fill={up(p) ? UP : DOWN}>
            <line x1={cx(i)} x2={cx(i)} y1={yOf(p.h)} y2={yOf(p.l)} />
            <rect x={cx(i) - bw / 2} width={bw} y={yOf(Math.max(p.o, p.c))} height={Math.max(1, Math.abs(yOf(p.o) - yOf(p.c)))} />
          </g>
        ))}
        {kind === 'bar' && ys.map((_, k) => points.map((p, i) => {
          const v = p.ys[k]
          if (!Number.isFinite(v)) return null
          const gw = bw / ys.length
          return <rect key={`b${k}-${i}`} x={cx(i) - bw / 2 + k * gw} width={Math.max(1, gw - 1)} y={Math.min(yOf(v), yOf(0))} height={Math.abs(yOf(v) - yOf(0))} fill={ys.length > 1 ? COLORS[k % COLORS.length] : v >= 0 ? UP : DOWN} />
        }))}
        {(kind === 'line' || kind === 'area') && ys.map((_, k) => {
          const pts = points.map((p, i) => [cx(i), p.ys[k]] as const).filter(([, v]) => Number.isFinite(v))
          if (!pts.length) return null
          const d = pts.map(([px, v], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${yOf(v).toFixed(1)}`).join('')
          const color = COLORS[k % COLORS.length]
          return (
            <g key={`l${k}`}>
              {kind === 'area' && <path d={`${d}L${pts[pts.length - 1][0].toFixed(1)},${yOf(lo)}L${pts[0][0].toFixed(1)},${yOf(lo)}Z`} fill={color} opacity={0.15} />}
              <path d={d} fill="none" stroke={color} strokeWidth={1.8} />
            </g>
          )
        })}
        {Number.isFinite(lastVal) && kind !== 'bar' && (
          <g>
            <line x1={L} x2={L + plotW} y1={yOf(lastVal)} y2={yOf(lastVal)} stroke={candle ? (up(last) ? UP : DOWN) : COLORS[0]} strokeDasharray="3 3" opacity={0.6} />
            <rect x={L + plotW + 2} y={yOf(lastVal) - 9} width={R - 4} height={18} rx={3} fill={candle ? (up(last) ? UP : DOWN) : COLORS[0]} />
            <text x={L + plotW + 6} y={yOf(lastVal) + 4} fill="#fff" fontSize={11} fontWeight={600}>{show(lastVal)}</text>
          </g>
        )}
        {hp && hover != null && <line x1={cx(hover)} x2={cx(hover)} y1={T} y2={height - B} stroke={MUTED} strokeDasharray="3 3" />}
      </svg>
      {hp && (
        <div className="lu-charttip">
          <b>{xLabel(hp.x, span || 1)}</b>
          {candle
            ? <span>O {show(hp.o)} H {show(hp.h)} L {show(hp.l)} C <em className={up(hp) ? 'lu-up' : 'lu-down'}>{show(hp.c)}</em></span>
            : ys.map((k, j) => <span key={k}>{ys.length > 1 ? `${k} ` : ''}{show(hp.ys[j])}</span>)}
          {hp.v !== undefined && hasVol && <span>Vol {show(hp.v)}</span>}
        </div>
      )}
    </div>
  )
}
