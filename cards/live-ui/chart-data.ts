import { show } from './screen'

export type ChartKind = 'line' | 'area' | 'bar' | 'candlestick'

/** What a chart draws. Rows are objects; candlesticks read open, high, low, close (and volume) from each row. */
export interface ChartSpec {
  kind?: ChartKind
  rows: Record<string, unknown>[]
  /** Field for the x axis. Default: the first of date, time, t, x, label found in the rows. */
  x?: string
  /** Field or fields to plot for line, area and bar. Default: close, else value, else the first numeric field. */
  y?: string | string[]
  /** Draws volume bars under the price (candlestick, line, area) when rows have `volume`. Default true. */
  volume?: boolean
  height?: number
}

export interface ChartPoint { x: unknown; o: number; h: number; l: number; c: number; v?: number; ys: number[] }

const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN)
const X_FIELDS = ['date', 'time', 't', 'x', 'label', 'timestamp']

/** Turns rows into points with the fields the chart needs, dropping rows it cannot draw. */
export function chartPoints(spec: ChartSpec): { points: ChartPoint[]; x: string; ys: string[] } {
  const rows = (spec.rows ?? []).filter((r) => r && typeof r === 'object')
  const first = rows[0] ?? {}
  const x = spec.x ?? X_FIELDS.find((f) => f in first) ?? ''
  let ys = Array.isArray(spec.y) ? spec.y : spec.y ? [spec.y] : []
  if (!ys.length) {
    const auto = ['close', 'value', 'price'].find((f) => f in first) ?? Object.keys(first).find((k) => k !== x && Number.isFinite(num(first[k])))
    ys = auto ? [auto] : []
  }
  const candle = (spec.kind ?? 'line') === 'candlestick'
  const points: ChartPoint[] = []
  for (const r of rows) {
    const c = num(r.close ?? r[ys[0]])
    const o = num(r.open), h = num(r.high), l = num(r.low)
    const vals = ys.map((k) => num(r[k]))
    if (candle ? ![o, h, l, c].every(Number.isFinite) : !vals.some(Number.isFinite)) continue
    const v = num(r.volume)
    points.push({ x: x ? r[x] : points.length, o, h, l, c, v: Number.isFinite(v) ? v : undefined, ys: vals })
  }
  return { points, x, ys }
}

/** About `count` round tick values covering min..max. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return []
  if (min === max) { min -= 1; max += 1 }
  const raw = (max - min) / Math.max(1, count)
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag
  const out: number[] = []
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toFixed(10)))
  return out
}

/** Short label for an x value: dates as "Jan 5" or "10:30", everything else as text. */
export function xLabel(v: unknown, span = 0): string {
  let d: Date | null = null
  if (typeof v === 'number' && v > 1e8) d = new Date(v < 1e11 ? v * 1000 : v)
  else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) d = new Date(v.length === 10 ? `${v}T12:00:00` : v)
  if (!d || isNaN(+d)) return show(v)
  if (span > 0 && span < 2 * 86400e3) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(span > 400 * 86400e3 ? { year: '2-digit' } : {}) })
}

export const timeOf = (v: unknown) => (typeof v === 'number' ? (v < 1e11 ? v * 1000 : v) : typeof v === 'string' ? Date.parse(v) : NaN)
