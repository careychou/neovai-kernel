import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { compilePanel, HOST_GLOBAL } from './index'
import { PanelScope, registerHostModules, useApp, type PanelApp, type ScreenHost } from './react'

let ws: string
const write = (p: string, text: string) => { fs.mkdirSync(path.dirname(path.join(ws, p)), { recursive: true }); fs.writeFileSync(path.join(ws, p), text) }
const load = async (code: string) => (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)).default

beforeEach(() => { ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-'))); registerHostModules() })
afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }); delete (globalThis as any)[HOST_GLOBAL] })

const host = (over: Partial<ScreenHost> = {}): ScreenHost => ({
  data: { picks: { buys: [{ ticker: 'KO', action: 'buy' }] }, decisions: { items: [{ id: '|KO|buy', ticker: 'KO', action: 'buy', decision: 'accepted', at: '2026-11-22' }] } },
  loadPanel: async () => ({ code: null, error: null, version: 0 } as never),
  running: ['recommend'], runStep: { recommend: 'Reading picks' }, ...over
})

describe('panel API', () => {
  it('gives a compiled panel the app: data, run state, decisions, saved state and built-in blocks', async () => {
    write('ui/Refresh.tsx', `import { useApp, usePanelState, Blocks } from '@neovai/panel'
export default function Refresh() {
  const app = useApp()
  const [mode] = usePanelState('mode', 'reuse-scan')
  const buys = app.get('picks.buys') as { ticker: string; action: string }[]
  return <div>
    <i>{mode}</i><s>{app.isRunning('recommend') ? app.step('recommend') : 'idle'}</s>
    <u>{buys.map((b) => b.ticker + ':' + (app.decisionOf(b)?.decision ?? 'open')).join(',')}</u>
    <Blocks blocks={[{ type: 'heading', text: 'From blocks' }]} />
  </div>
}`)
    const Comp = await load(compilePanel(ws, 'ui/Refresh.tsx').code)
    const html = renderToStaticMarkup(<PanelScope host={host()} file="ui/Refresh.tsx"><Comp /></PanelScope>)
    expect(html).toContain('<i>reuse-scan</i>')
    expect(html).toContain('<s>Reading picks</s>')
    expect(html).toContain('<u>KO:accepted</u>')
    expect(html).toContain('From blocks')
  })

  it('starts jobs with options and opens Codify about the screen it is on', () => {
    const calls: unknown[] = []
    let app!: PanelApp
    const Grab = () => { app = useApp(); return null }
    renderToStaticMarkup(<PanelScope host={host({ runJob: (j, i) => calls.push(['run', j, i]), codify: (r) => calls.push(['codify', r]) })} file="ui/R.tsx" screen="recommendations" title="Recommendations"><Grab /></PanelScope>)
    app.run('recommend', { mode: 'reuse-scan' })
    app.codify?.('make it one panel')
    expect(calls).toEqual([['run', 'recommend', { mode: 'reuse-scan' }], ['codify', { screen: 'recommendations', title: 'Recommendations', text: 'make it one panel' }]])
    expect(app.lastRun('recommend')).toBeNull()
  })

  it('reads and saves the user preferences', async () => {
    const saved: unknown[] = []
    let app!: PanelApp
    const Grab = () => { app = useApp(); return null }
    renderToStaticMarkup(<PanelScope host={host({ prefs: { budget: 10000 }, savePrefs: (p) => { saved.push(p) } })} file="ui/P.tsx"><Grab /></PanelScope>)
    expect(app.prefs).toEqual({ budget: 10000 })
    await app.savePrefs!({ ...app.prefs, maxShares: 1000 })
    expect(saved).toEqual([{ budget: 10000, maxShares: 1000 }])
    renderToStaticMarkup(<PanelScope host={host()} file="ui/P.tsx"><Grab /></PanelScope>)
    expect(app.prefs).toEqual({})
    expect(app.savePrefs).toBeUndefined()
  })

  it('fetches JSON through the app and draws charts from a compiled panel', async () => {
    let app!: PanelApp
    const Grab = () => { app = useApp(); return null }
    const urls: string[] = []
    const fetch = async (url: string) => { urls.push(url); return url.includes('bad') ? { ok: false, status: 404, text: '' } : { ok: true, status: 200, text: '{"p":[1,2]}' } }
    renderToStaticMarkup(<PanelScope host={host({ fetch })} file="ui/P.tsx"><Grab /></PanelScope>)
    expect(await app.fetchJson!('https://x.test/q')).toEqual({ p: [1, 2] })
    await expect(app.fetchJson!('https://x.test/bad')).rejects.toThrow('answered 404')
    expect(urls).toEqual(['https://x.test/q', 'https://x.test/bad'])
    write('ui/C.tsx', "import { Chart } from '@neovai/panel'\nexport default () => <Chart kind=\"candlestick\" rows={[{date:'2026-01-02',open:1,high:3,low:1,close:2,volume:5}]} />")
    const C = await load(compilePanel(ws, 'ui/C.tsx').code)
    const html = renderToStaticMarkup(<PanelScope host={host()} file="ui/C.tsx"><C /></PanelScope>)
    expect(html).toContain('<svg')
    expect(html).toContain('<rect')
  })

  it('refuses outside a panel', () => {
    const Bad = () => { useApp(); return null }
    expect(() => renderToStaticMarkup(<Bad />)).toThrow('only work inside a panel')
  })
})
