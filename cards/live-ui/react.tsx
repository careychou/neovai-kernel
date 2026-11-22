import * as React from 'react'
import * as JsxRuntime from 'react/jsx-runtime'
import { Component, createContext, useCallback, useContext, useEffect, useState, type ComponentType, type ReactNode } from 'react'
import { HOST_GLOBAL, PANEL_MODULE, dataDate, direction, recKey, resolveData, show, type Alert, type Block, type Decision, type DecisionRecord, type Metric, type Recommendation, type RunInput, type Screen } from './screen'
import type { PanelResult } from './live'

export type MarkdownView = ComponentType<{ text: string }>

/** What a screen needs from the app. */
export interface ScreenHost {
  data: Record<string, unknown>
  /** Compiled panel code from the main process. */
  loadPanel: (file: string) => Promise<PanelResult>
  onPanelError?: (file: string, message: string) => void
  /** Starts a job; `input` reaches the runtime agent with the run. */
  runJob?: (job: string, input?: RunInput) => void
  stopJob?: (job: string) => void
  running?: string[]
  /** One line on what a running job is doing now, for example the tool it is calling. */
  runStep?: Record<string, string>
  /** When each running job started (ms since epoch), for the elapsed time. */
  runStarted?: Record<string, number>
  /** The live activity of a running job, drawn under its run button. */
  renderActivity?: (job: string) => ReactNode
  /** Records accepting or declining a recommendation; null undoes it. Enables `decide` on recommendation blocks. */
  decide?: (rec: Recommendation, decision: Decision | null) => void
  /** Latest report per job. */
  reports?: Record<string, { text: string; finished: string; status: string } | null>
  /** Extra props every code panel receives, for example the user's goals. */
  panelProps?: Record<string, unknown>
  Markdown?: MarkdownView
  /** Text of each skill by name, for `skill` blocks. */
  skillText?: Record<string, string>
  /** Opens the coding agent to change this screen, or one of its skills. Shows a bar on every screen. */
  codify?: (req: { screen: string; title: string; skill?: string; text?: string }) => void
}

/** What a code panel can see and do, from `useApp()` in `@neovai/panel`. */
export interface PanelApp {
  /** All saved data, by name (records/data/<name>.json). */
  data: Record<string, unknown>
  /** Reads saved data by path, for example `get('picks.buys')`. */
  get: (ref: string) => unknown
  /** Extra values the app passes to every panel, for example goals. */
  props: Record<string, unknown>
  /** Starts a job. `input` (text or named options) reaches the runtime agent with the run. */
  run: (job: string, input?: RunInput) => void
  stop: (job: string) => void
  isRunning: (job: string) => boolean
  /** What a running job is doing now, and when it started (ms since epoch). */
  step: (job: string) => string | undefined
  started: (job: string) => number | undefined
  /** The latest report of a job. */
  lastRun: (job: string) => { text: string; finished: string; status: string } | null
  /** Records accepting or declining a recommendation; null undoes it. Undefined when the app does not allow it. */
  decide?: (rec: Recommendation, decision: Decision | null) => void
  /** The recorded choice on a recommendation, if any. */
  decisionOf: (rec: Recommendation) => DecisionRecord | undefined
  /** Opens the coding agent about this screen, optionally with text to start the request. */
  codify?: (text?: string) => void
  /** The screen and panel file this panel is on. */
  screen: string
  file: string
}

interface PanelCtx { host: ScreenHost; screen: string; title: string; file: string; tick?: unknown }
const PanelContext = createContext<PanelCtx | null>(null)

function useCtx(): PanelCtx {
  const c = useContext(PanelContext)
  if (!c) throw new Error('useApp and Blocks only work inside a panel')
  return c
}

function makeApp({ host, screen, title, file }: PanelCtx): PanelApp {
  const decisions = ((resolveData(host.data, 'decisions.items') as DecisionRecord[] | undefined) ?? [])
  return {
    data: host.data,
    get: (ref) => resolveData(host.data, ref),
    props: host.panelProps ?? {},
    run: (job, input) => host.runJob?.(job, input),
    stop: (job) => host.stopJob?.(job),
    isRunning: (job) => !!host.running?.includes(job),
    step: (job) => host.runStep?.[job],
    started: (job) => host.runStarted?.[job],
    lastRun: (job) => host.reports?.[job] ?? null,
    decide: host.decide,
    decisionOf: (rec) => decisions.find((d) => d.id === recKey(rec, rec.date)),
    codify: host.codify && ((text?: string) => host.codify!({ screen, title, text })),
    screen, file
  }
}

/** Gives children the panel API, the same as a panel block does. For apps drawing a panel component themselves, and tests. */
export function PanelScope({ host, file, screen = '', title = '', tick, children }: { host: ScreenHost; file: string; screen?: string; title?: string; tick?: unknown; children: ReactNode }) {
  return <PanelContext.Provider value={{ host, screen, title, file, tick }}>{children}</PanelContext.Provider>
}

/** The app API for a code panel. */
export function useApp(): PanelApp {
  return makeApp(useCtx())
}

const STATE_PREFIX = 'neovai-panel:'

/** Like useState, but kept across reloads and restarts for this panel. Use it for choices such as a selected option or tab. */
export function usePanelState<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const { file } = useCtx()
  const id = `${STATE_PREFIX}${file}:${key}`
  const [v, setV] = useState<T>(() => {
    try { const raw = localStorage.getItem(id); return raw == null ? initial : (JSON.parse(raw) as T) } catch { return initial }
  })
  const set = useCallback((next: T | ((p: T) => T)) => {
    setV((p) => {
      const val = typeof next === 'function' ? (next as (p: T) => T)(p) : next
      try { localStorage.setItem(id, JSON.stringify(val)) } catch { /* storage full or off: keep it in memory */ }
      return val
    })
  }, [id])
  return [v, set]
}

/** Draws built-in blocks (tables, metrics, recommendations with Accept and Decline, run buttons…) inside a panel. */
export function Blocks({ blocks }: { blocks: Block[] }) {
  const { host, tick, screen, title } = useCtx()
  return <>{blocks.map((b, i) => <Boundary key={i} resetKey={tick}><BlockView b={b} host={host} tick={tick} screen={screen} title={title} /></Boundary>)}</>
}

/** A run button with live progress, the same as the run block. */
export function RunButton({ job, label, input }: { job: string; label?: string; input?: RunInput }) {
  return <Blocks blocks={[{ type: 'run', job, label, input }]} />
}

/** Markdown drawn the way the app draws it elsewhere. */
export function PanelMarkdown({ text }: { text: string }) {
  const { host } = useCtx()
  const M = host.Markdown ?? Plain
  return <M text={text} />
}

/** What `import ... from '@neovai/panel'` gives a panel. */
export const panelModule = { useApp, usePanelState, Blocks, RunButton, Markdown: PanelMarkdown, show, direction, resolveData, recKey }

/** Lets compiled panels import the app's React and the panel API. Call once in the renderer; pass any other modules panels may import. */
export function registerHostModules(extra: Record<string, unknown> = {}) {
  const mods: Record<string, unknown> = { react: React, 'react/jsx-runtime': JsxRuntime, [PANEL_MODULE]: panelModule, ...extra }
  ;(globalThis as any)[HOST_GLOBAL] = (name: string) => {
    if (name in mods) return mods[name]
    throw new Error(`Panels cannot import "${name}"`)
  }
}

const Plain: MarkdownView = ({ text }) => <div style={{ whiteSpace: 'pre-wrap' }}>{text}</div>

class Boundary extends Component<{ onError?: (m: string) => void; children: ReactNode; resetKey: unknown }, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(e: unknown) { return { error: String((e as Error)?.message ?? e) } }
  componentDidCatch(e: unknown) { this.props.onError?.(String((e as Error)?.message ?? e)) }
  componentDidUpdate(prev: { resetKey: unknown }) { if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null }) }
  render() { return this.state.error ? <div className="lu-error">This panel failed while drawing: {this.state.error}</div> : this.props.children }
}

const cache = new Map<string, { version: number; Comp: ComponentType<any> }>()

async function importCode(code: string): Promise<ComponentType<any>> {
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
  try {
    const mod = await import(/* @vite-ignore */ url)
    if (typeof mod.default !== 'function') throw new Error('the panel file must export a React component as default')
    return mod.default
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** A code panel from the workspace. Keeps showing the last version that worked when the file breaks. */
export function CodePanel({ file, host, tick, screen = '', title = '' }: { file: string; host: ScreenHost; tick?: unknown; screen?: string; title?: string }) {
  const [state, setState] = useState<{ Comp: ComponentType<any> | null; error: string | null; version: number }>(() => {
    const c = cache.get(file)
    return { Comp: c?.Comp ?? null, error: null, version: c?.version ?? -1 }
  })
  useEffect(() => {
    let live = true
    host.loadPanel(file).then(async (r) => {
      if (!live) return
      const c = cache.get(file)
      if (r.code && c?.version !== r.version) {
        try {
          const Comp = await importCode(r.code)
          cache.set(file, { version: r.version, Comp })
          if (live) setState({ Comp, error: r.error, version: r.version })
        } catch (e: any) {
          const msg = String(e?.message ?? e)
          host.onPanelError?.(file, msg)
          if (live) setState((s) => ({ ...s, error: msg }))
        }
      } else if (live) setState({ Comp: c?.Comp ?? null, error: r.error, version: c?.version ?? -1 })
    }).catch((e) => live && setState((s) => ({ ...s, error: String(e?.message ?? e) })))
    return () => { live = false }
  }, [file, tick])
  const { Comp, error, version } = state
  return (
    <>
      {error && <div className="lu-error">{Comp ? 'Showing the last version that worked. ' : ''}{file}: {error}</div>}
      {Comp && (
        <Boundary resetKey={version} onError={(m) => host.onPanelError?.(file, m)}>
          <PanelScope host={host} file={file} screen={screen} title={title} tick={tick}>
            <Comp data={host.data} {...host.panelProps} />
          </PanelScope>
        </Boundary>
      )}
    </>
  )
}

const pick = <T,>(b: { data?: string; items?: T[] }, data: Record<string, unknown>): T[] => {
  const v = b.data ? resolveData(data, b.data) : b.items
  return Array.isArray(v) ? (v as T[]) : []
}

/** "Running 1m 05s · <what it is doing>", ticking every second. */
function RunState({ step, started }: { step?: string; started?: number }) {
  const [, setNow] = useState(0)
  useEffect(() => { const t = setInterval(() => setNow((n) => n + 1), 1000); return () => clearInterval(t) }, [])
  const secs = started ? Math.max(0, Math.round((Date.now() - started) / 1000)) : 0
  const took = started ? ` ${secs >= 60 ? `${Math.floor(secs / 60)}m ` : ''}${String(secs % 60).padStart(secs >= 60 ? 2 : 1, '0')}s` : ''
  return <span className="lu-runstate"><span className="lu-spin" />Running{took}{step ? ` · ${step}` : '…'}</span>
}

function Section({ title, children }: { title?: string; children: ReactNode }) {
  return <section className="lu-block">{title && <h3 className="lu-title">{title}</h3>}{children}</section>
}

const Empty = () => <p className="lu-empty">No data yet. Run the job that fills it.</p>

function BlockView({ b, host, tick, screen = '', title = '' }: { b: Block; host: ScreenHost; tick?: unknown; screen?: string; title?: string }) {
  const Markdown = host.Markdown ?? Plain
  const d = host.data
  switch (b.type) {
    case 'heading': return <h2 className="lu-heading">{b.text}</h2>
    case 'markdown': {
      const text = b.data ? resolveData(d, b.data) : b.text
      return <section className="lu-block">{typeof text === 'string' && text ? <Markdown text={text} /> : <Empty />}</section>
    }
    case 'metrics': {
      const items = pick<Metric>(b, d)
      return (
        <Section title={b.title}>
          {items.length ? (
            <div className="lu-metrics">
              {items.map((m, i) => (
                <div className="lu-metric" key={i}>
                  <span>{m.label}</span>
                  <b>{show(m.value)}</b>
                  {m.change !== undefined && <em className={`lu-${direction(m.change)}`}>{show(m.change)}</em>}
                  {m.note && <small>{m.note}</small>}
                </div>
              ))}
            </div>
          ) : <Empty />}
        </Section>
      )
    }
    case 'table': {
      const rows = pick<Record<string, unknown>>({ data: b.data, items: b.rows }, d)
      const cols = b.columns ?? Object.keys(rows[0] ?? {})
      return (
        <Section title={b.title}>
          {rows.length ? (
            <div className="lu-tablewrap">
              <table className="lu-table">
                <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                <tbody>{rows.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c}>{show(r?.[c])}</td>)}</tr>)}</tbody>
              </table>
            </div>
          ) : <Empty />}
        </Section>
      )
    }
    case 'list': {
      const items = pick<unknown>(b, d)
      return <Section title={b.title}>{items.length ? <ul className="lu-list">{items.map((x, i) => <li key={i}>{show(x)}</li>)}</ul> : <Empty />}</Section>
    }
    case 'alerts': {
      const items = pick<Alert | string>(b, d)
      return (
        <Section title={b.title}>
          {items.length ? items.map((a, i) => {
            const al = typeof a === 'string' ? { text: a } : a
            return <div key={i} className={`lu-alert lu-${al.level ?? 'info'}`}>{al.text}</div>
          }) : <Empty />}
        </Section>
      )
    }
    case 'recommendations': {
      const items = pick<Recommendation>(b, d)
      const date = dataDate(d, b.data)
      const made = new Map(((resolveData(d, 'decisions.items') as DecisionRecord[] | undefined) ?? []).map((x) => [x.id, x]))
      return (
        <Section title={b.title}>
          {items.length ? (
            <div className="lu-recs">
              {items.map((r, i) => {
                const rec = { ...r, date: r.date ?? date, id: recKey(r, date) }
                const done = made.get(rec.id)
                return (
                  <div className={`lu-rec${done ? ` lu-${done.decision}` : ''}`} key={i}>
                    <div className="lu-rechead"><b>{r.ticker}</b>{r.action && <span className="lu-action">{r.action}</span>}{r.confidence !== undefined && <span className="lu-conf">{show(r.confidence)}</span>}</div>
                    {r.reason && <p>{r.reason}</p>}
                    {(r.entry !== undefined || r.target !== undefined || r.stop !== undefined) && <small>{r.entry !== undefined && `Entry ${show(r.entry)} · `}Target {show(r.target)} · Stop {show(r.stop)}</small>}
                    {b.decide && host.decide && (
                      <div className="lu-decide">
                        {done ? (
                          <>
                            <span className={`lu-verdict lu-${done.decision}`}>{done.decision === 'accepted' ? 'Accepted' : 'Declined'} {new Date(done.at).toLocaleDateString()}</span>
                            <button onClick={() => host.decide!(rec, null)}>Undo</button>
                          </>
                        ) : (
                          <>
                            <button className="primary" onClick={() => host.decide!(rec, 'accepted')}>Accept</button>
                            <button onClick={() => host.decide!(rec, 'declined')}>Decline</button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ) : <Empty />}
        </Section>
      )
    }
    case 'run': {
      const busy = host.running?.includes(b.job)
      const last = host.reports?.[b.job]
      return (
        <div className="lu-runbox">
          <div className="lu-run">
            {busy
              ? <button className="danger" onClick={() => host.stopJob?.(b.job)}>Stop</button>
              : <button className="primary" onClick={() => host.runJob?.(b.job, b.input)} disabled={!host.runJob}>{b.label ?? `Run ${b.job}`}</button>}
            {busy
              ? <RunState step={host.runStep?.[b.job]} started={host.runStarted?.[b.job]} />
              : <span className="lu-runstate">{last ? `Last run ${new Date(last.finished).toLocaleString()}${last.status !== 'completed' ? ` (${last.status})` : ''}` : 'Not run yet'}</span>}
          </div>
          {busy && host.renderActivity && <div className="lu-activity">{host.renderActivity(b.job)}</div>}
        </div>
      )
    }
    case 'report': {
      const last = host.reports?.[b.job]
      return <Section title={b.title}>{last?.text ? <Markdown text={last.text} /> : <Empty />}</Section>
    }
    case 'panel':
      return <Section title={b.title}><CodePanel file={b.file} host={host} tick={tick} screen={screen} title={title} /></Section>
    case 'skill': {
      const text = host.skillText?.[b.name]
      return <Section title={b.title}>{text ? <div className="lu-skill"><Markdown text={text.replace(/^---[\s\S]*?\n---\n/, '')} /></div> : <p className="lu-empty">No skill named {b.name}.</p>}</Section>
    }
    case 'row':
      return <div className="lu-row">{b.blocks.map((c, i) => <BlockView key={i} b={c} host={host} tick={tick} screen={screen} title={title} />)}</div>
  }
}

/**
 * Draws a screen description with the built-in blocks. `errors` are problems with the file as it is now;
 * the screen shown is the last valid one. `tick` changes whenever the workspace does, so panels recheck.
 */
export function ScreenView({ screen, name = '', errors = [], host, tick }: { screen: Screen | null; name?: string; errors?: string[]; host: ScreenHost; tick?: unknown }) {
  const title = screen?.title ?? name
  return (
    <div className="lu-screen">
      {host.codify && (
        <div className="lu-codify">
          {screen?.skills?.length ? <span className="lu-uses">Built on</span> : null}
          {screen?.skills?.map((s) => (
            <button key={s} className="lu-skillchip" title={`View or change the ${s} skill`} onClick={() => host.codify!({ screen: name, title, skill: s })}>{s}</button>
          ))}
          <span className="lu-grow" />
          <button title="Ask Codify to change how this screen looks or behaves" onClick={() => host.codify!({ screen: name, title })}>Change this screen</button>
        </div>
      )}
      {errors.length > 0 && (
        <div className="lu-error">
          {screen ? 'Showing the last version that worked. ' : ''}This screen's description has problems:
          <ul>{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      )}
      {screen?.blocks.map((b, i) => (
        <Boundary key={i} resetKey={tick}><BlockView b={b} host={host} tick={tick} screen={name} title={title} /></Boundary>
      ))}
    </div>
  )
}
