/** Name of the global a compiled panel reads its external modules (React) from. */
export const HOST_GLOBAL = '__liveUiRequire'

/**
 * A screen description: a JSON file listing blocks the app draws with built-in components.
 * Blocks that show data name it with `data: "<name>.<path>"`, read from the runtime agent's saved data.
 */
export type Block =
  | { type: 'heading'; text: string }
  | { type: 'markdown'; text?: string; data?: string }
  | { type: 'metrics'; title?: string; data?: string; items?: Metric[] }
  | { type: 'table'; title?: string; data?: string; columns?: string[]; rows?: Record<string, unknown>[] }
  | { type: 'list'; title?: string; data?: string; items?: unknown[] }
  | { type: 'alerts'; title?: string; data?: string; items?: Alert[] }
  | { type: 'recommendations'; title?: string; data?: string; items?: Recommendation[]; decide?: boolean }
  | { type: 'run'; job: string; label?: string }
  | { type: 'report'; job: string; title?: string }
  | { type: 'panel'; file: string; title?: string }
  | { type: 'row'; blocks: Block[] }

export interface Metric { label: string; value: unknown; change?: unknown; note?: string }
export interface Alert { level?: 'info' | 'warn' | 'bad' | 'good'; text: string }
export interface Recommendation { ticker: string; action?: string; reason?: string; confidence?: unknown; entry?: unknown; target?: unknown; stop?: unknown; date?: string; id?: string }

export type Decision = 'accepted' | 'declined'
/** One recorded choice on a recommendation, kept in the `decisions` data as `{ items: DecisionRecord[] }`. */
export interface DecisionRecord extends Recommendation { id: string; decision: Decision; at: string }

/** Stable key of a recommendation: its own id, else date, ticker and action. */
export function recKey(r: Recommendation, date?: string): string {
  return r.id ?? [r.date ?? date ?? '', r.ticker, r.action ?? ''].join('|')
}

/** The date of the data a block reads, from the parent object of its path (for example today.date for today.picks). */
export function dataDate(data: Record<string, unknown>, ref: string | undefined): string | undefined {
  if (!ref || !ref.includes('.')) return undefined
  const parent = resolveData(data, ref.split('.').slice(0, -1).join('.')) as Record<string, unknown> | undefined
  return typeof parent?.date === 'string' ? parent.date : undefined
}

/** `title` names the tab; screens sort by `order`, then file name. */
export interface Screen { title?: string; order?: number; blocks: Block[] }

export const BLOCK_TYPES = ['heading', 'markdown', 'metrics', 'table', 'list', 'alerts', 'recommendations', 'run', 'report', 'panel', 'row'] as const

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown) => typeof v === 'string' && v.trim() !== ''

function checkBlock(b: unknown, at: string, errors: string[]) {
  if (!isObj(b)) return errors.push(`${at}: a block must be an object`)
  const t = b.type
  if (!BLOCK_TYPES.includes(t as never)) return errors.push(`${at}: unknown block type ${JSON.stringify(t)} (use ${BLOCK_TYPES.join(', ')})`)
  if (b.data !== undefined && !str(b.data)) errors.push(`${at}: "data" must be a name like "today.metrics"`)
  switch (t) {
    case 'heading': if (!str(b.text)) errors.push(`${at}: heading needs "text"`); break
    case 'markdown': if (!str(b.text) && !str(b.data)) errors.push(`${at}: markdown needs "text" or "data"`); break
    case 'run': case 'report': if (!str(b.job)) errors.push(`${at}: ${t} needs "job"`); break
    case 'panel':
      if (!str(b.file) || !/\.(tsx|ts|jsx|js)$/.test(String(b.file)) || String(b.file).includes('..')) errors.push(`${at}: panel needs "file", a .tsx path inside the workspace`)
      break
    case 'row':
      if (!Array.isArray(b.blocks)) errors.push(`${at}: row needs "blocks"`)
      else b.blocks.forEach((c, i) => checkBlock(c, `${at}.blocks[${i}]`, errors))
      break
    default:
      if (b.data === undefined && !Array.isArray(b.items) && !Array.isArray(b.rows)) errors.push(`${at}: ${t} needs "data" or inline items`)
  }
}

/** Checks a parsed description. Returns the screen when valid, else every problem found. */
export function validateScreen(raw: unknown): { screen: Screen | null; errors: string[] } {
  const errors: string[] = []
  if (!isObj(raw)) return { screen: null, errors: ['the screen must be a JSON object with "blocks"'] }
  if (raw.title !== undefined && typeof raw.title !== 'string') errors.push('"title" must be text')
  if (raw.order !== undefined && typeof raw.order !== 'number') errors.push('"order" must be a number')
  if (!Array.isArray(raw.blocks)) errors.push('"blocks" must be a list')
  else raw.blocks.forEach((b, i) => checkBlock(b, `blocks[${i}]`, errors))
  return errors.length ? { screen: null, errors } : { screen: raw as unknown as Screen, errors }
}

/** Parses and checks description text. */
export function parseScreen(text: string): { screen: Screen | null; errors: string[] } {
  let raw: unknown
  try { raw = JSON.parse(text) } catch (e: any) { return { screen: null, errors: [`not valid JSON: ${e.message}`] } }
  return validateScreen(raw)
}

/** Looks up `"<name>.<path>"` in saved data, for example `today.metrics` or `today.picks.0`. */
export function resolveData(data: Record<string, unknown>, ref: string | undefined): unknown {
  if (!ref) return undefined
  return ref.split('.').reduce<unknown>((v, k) => (v == null ? undefined : (v as any)[k]), data)
}

/** Panel files a screen uses, nested rows included. */
export function panelFiles(screen: Screen): string[] {
  const out: string[] = []
  const walk = (bs: Block[]) => bs.forEach((b) => (b.type === 'panel' ? out.push(b.file) : b.type === 'row' ? walk(b.blocks) : undefined))
  walk(screen.blocks)
  return out
}

/** Short text for any value a block shows. */
export function show(v: unknown): string {
  if (v == null || v === '') return '—'
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}

/** Direction of a change value: "+1.2%", -3 and "down" all work. */
export function direction(v: unknown): 'up' | 'down' | 'flat' {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[,%$+]/g, ''))
  if (typeof v === 'string' && /^\s*-/.test(v)) return 'down'
  if (!Number.isFinite(n) || n === 0) return 'flat'
  return n > 0 ? 'up' : 'down'
}
