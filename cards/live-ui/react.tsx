import * as React from 'react'
import * as JsxRuntime from 'react/jsx-runtime'
import { Component, useEffect, useState, type ComponentType, type ReactNode } from 'react'
import { HOST_GLOBAL, direction, resolveData, show, type Alert, type Block, type Metric, type Recommendation, type Screen } from './screen'
import type { PanelResult } from './live'

export type MarkdownView = ComponentType<{ text: string }>

/** What a screen needs from the app. */
export interface ScreenHost {
  data: Record<string, unknown>
  /** Compiled panel code from the main process. */
  loadPanel: (file: string) => Promise<PanelResult>
  onPanelError?: (file: string, message: string) => void
  runJob?: (job: string) => void
  stopJob?: (job: string) => void
  running?: string[]
  /** Latest report per job. */
  reports?: Record<string, { text: string; finished: string; status: string } | null>
  /** Extra props every code panel receives, for example the user's goals. */
  panelProps?: Record<string, unknown>
  Markdown?: MarkdownView
}

/** Lets compiled panels import the app's React. Call once in the renderer; pass any other modules panels may import. */
export function registerHostModules(extra: Record<string, unknown> = {}) {
  const mods: Record<string, unknown> = { react: React, 'react/jsx-runtime': JsxRuntime, ...extra }
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
export function CodePanel({ file, host, tick }: { file: string; host: ScreenHost; tick?: unknown }) {
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
          <Comp data={host.data} {...host.panelProps} />
        </Boundary>
      )}
    </>
  )
}

const pick = <T,>(b: { data?: string; items?: T[] }, data: Record<string, unknown>): T[] => {
  const v = b.data ? resolveData(data, b.data) : b.items
  return Array.isArray(v) ? (v as T[]) : []
}

function Section({ title, children }: { title?: string; children: ReactNode }) {
  return <section className="lu-block">{title && <h3 className="lu-title">{title}</h3>}{children}</section>
}

const Empty = () => <p className="lu-empty">No data yet. Run the job that fills it.</p>

function BlockView({ b, host, tick }: { b: Block; host: ScreenHost; tick?: unknown }) {
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
      return (
        <Section title={b.title}>
          {items.length ? (
            <div className="lu-recs">
              {items.map((r, i) => (
                <div className="lu-rec" key={i}>
                  <div className="lu-rechead"><b>{r.ticker}</b>{r.action && <span className="lu-action">{r.action}</span>}{r.confidence !== undefined && <span className="lu-conf">{show(r.confidence)}</span>}</div>
                  {r.reason && <p>{r.reason}</p>}
                  {(r.target !== undefined || r.stop !== undefined) && <small>Target {show(r.target)} · Stop {show(r.stop)}</small>}
                </div>
              ))}
            </div>
          ) : <Empty />}
        </Section>
      )
    }
    case 'run': {
      const busy = host.running?.includes(b.job)
      const last = host.reports?.[b.job]
      return (
        <div className="lu-run">
          {busy
            ? <button className="danger" onClick={() => host.stopJob?.(b.job)}>Stop</button>
            : <button className="primary" onClick={() => host.runJob?.(b.job)} disabled={!host.runJob}>{b.label ?? `Run ${b.job}`}</button>}
          <span className="lu-runstate">{busy ? 'Running…' : last ? `Last run ${new Date(last.finished).toLocaleString()}${last.status !== 'completed' ? ` (${last.status})` : ''}` : 'Not run yet'}</span>
        </div>
      )
    }
    case 'report': {
      const last = host.reports?.[b.job]
      return <Section title={b.title}>{last?.text ? <Markdown text={last.text} /> : <Empty />}</Section>
    }
    case 'panel':
      return <Section title={b.title}><CodePanel file={b.file} host={host} tick={tick} /></Section>
    case 'row':
      return <div className="lu-row">{b.blocks.map((c, i) => <BlockView key={i} b={c} host={host} tick={tick} />)}</div>
  }
}

/**
 * Draws a screen description with the built-in blocks. `errors` are problems with the file as it is now;
 * the screen shown is the last valid one. `tick` changes whenever the workspace does, so panels recheck.
 */
export function ScreenView({ screen, errors = [], host, tick }: { screen: Screen | null; errors?: string[]; host: ScreenHost; tick?: unknown }) {
  return (
    <div className="lu-screen">
      {errors.length > 0 && (
        <div className="lu-error">
          {screen ? 'Showing the last version that worked. ' : ''}This screen's description has problems:
          <ul>{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      )}
      {screen?.blocks.map((b, i) => (
        <Boundary key={i} resetKey={tick}><BlockView b={b} host={host} tick={tick} /></Boundary>
      ))}
    </div>
  )
}
