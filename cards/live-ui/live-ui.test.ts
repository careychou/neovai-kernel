import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compilePanel, createLiveUi, dataDate, direction, HOST_GLOBAL, makeCheckUiTool, parseScreen, recKey, resolveData, show } from './index'

let ws: string
const write = (p: string, text: string) => { fs.mkdirSync(path.dirname(path.join(ws, p)), { recursive: true }); fs.writeFileSync(path.join(ws, p), text) }
const load = async (code: string) => (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)).default

beforeEach(() => { ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lu-'))) })
afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }); delete (globalThis as any)[HOST_GLOBAL] })

describe('screen descriptions', () => {
  it('accepts every block type, nested rows included', () => {
    const { screen, errors } = parseScreen(JSON.stringify({
      title: 'Today', order: 1, skills: ['market-scan'],
      blocks: [
        { type: 'heading', text: 'Hi' }, { type: 'markdown', data: 'today.summary' }, { type: 'metrics', data: 'today.metrics' },
        { type: 'table', rows: [{ a: 1 }] }, { type: 'list', items: ['x'] }, { type: 'alerts', data: 'today.alerts' },
        { type: 'recommendations', data: 'today.picks' }, { type: 'run', job: 'daily' }, { type: 'report', job: 'daily' },
        { type: 'skill', name: 'market-scan' },
        { type: 'row', blocks: [{ type: 'panel', file: 'ui/panels/Chart.tsx' }] }
      ]
    }))
    expect(errors).toEqual([])
    expect(screen?.blocks).toHaveLength(11)
    expect(parseScreen('{"skills":"x","blocks":[{"type":"skill"}]}').errors).toEqual(['"skills" must be a list of skill names', 'blocks[0]: skill needs "name", a folder in skills/'])
  })
  it('lists every problem, with where it is', () => {
    expect(parseScreen('{').errors[0]).toMatch(/^not valid JSON/)
    expect(parseScreen(JSON.stringify({ blocks: [{ type: 'chart' }, { type: 'run' }, { type: 'row', blocks: [{ type: 'panel', file: '../x.tsx' }] }, { type: 'table' }] })).errors).toEqual([
      'blocks[0]: unknown block type "chart" (use heading, markdown, metrics, table, list, alerts, recommendations, run, report, panel, skill, row)',
      'blocks[1]: run needs "job"',
      'blocks[2].blocks[0]: panel needs "file", a .tsx path inside the workspace',
      'blocks[3]: table needs "data" or inline items'
    ])
  })
  it('accepts run options as text or an object', () => {
    expect(parseScreen(JSON.stringify({ blocks: [{ type: 'run', job: 'recommend', input: { mode: 'reuse-scan' } }, { type: 'run', job: 'scan', input: 'only tech' }] })).errors).toEqual([])
    expect(parseScreen(JSON.stringify({ blocks: [{ type: 'run', job: 'recommend', input: 3 }] })).errors).toEqual(['blocks[0]: run "input" must be text or an object'])
  })
  it('reads data by path and formats values', () => {
    expect(resolveData({ today: { picks: [{ t: 'A' }] } }, 'today.picks.0.t')).toBe('A')
    expect(resolveData({}, 'today.x')).toBeUndefined()
    expect(show(1234.567)).toBe('1,234.57')
    expect(show(null)).toBe('—')
    expect([direction('+1.2%'), direction(-3), direction('-0.4%'), direction('n/a')]).toEqual(['up', 'down', 'down', 'flat'])
  })
})

describe('code panels', () => {
  it('compiles a panel and its relative imports into one module that uses the host React', async () => {
    write('logic/index.ts', 'export const double = (n: number): number => n * 2\nexport type X = { a: number }')
    write('ui/data.json', '{"n": 21}')
    write('ui/Panel.tsx', "import type { X } from '../logic'\nimport { double } from '../logic'\nimport d from './data.json'\nimport { useState } from 'react'\nexport default function Panel() { const [n] = useState(double(d.n)); return <b>{n}</b> }")
    const r = compilePanel(ws, 'ui/Panel.tsx')
    expect(r.files.sort()).toEqual(['logic/index.ts', 'ui/Panel.tsx', 'ui/data.json'])
    const calls: string[] = []
    ;(globalThis as any)[HOST_GLOBAL] = (name: string) => {
      calls.push(name)
      if (name === 'react') return { useState: (v: unknown) => [v] }
      if (name === 'react/jsx-runtime') return { jsx: (t: string, p: any) => ({ t, v: p.children }) }
      throw new Error(name)
    }
    const Panel = await load(r.code)
    expect(Panel()).toEqual({ t: 'b', v: 42 })
    expect(calls.sort()).toEqual(['react', 'react/jsx-runtime'])
  })
  it('explains what to fix: syntax errors, packages, missing files, escapes', () => {
    write('ui/Bad.tsx', 'export default () => <div>')
    expect(() => compilePanel(ws, 'ui/Bad.tsx')).toThrow(/ui\/Bad.tsx:/)
    write('ui/Pkg.tsx', "import x from 'lodash'\nimport y from './nope'\nexport default () => [x, y]")
    expect(() => compilePanel(ws, 'ui/Pkg.tsx')).toThrow('ui/Pkg.tsx: cannot import "lodash". Panels may import react, react/jsx-runtime, react-dom, @neovai/panel or relative workspace files.\nui/Pkg.tsx: cannot find "./nope"')
    expect(() => compilePanel(ws, '../out.tsx')).toThrow('outside the workspace')
  })
})

describe('live ui', () => {
  it('keeps the last valid screen and the last good panel, and reports both problems', async () => {
    write('ui/screens/today.json', JSON.stringify({ title: 'Today', blocks: [{ type: 'panel', file: 'ui/P.tsx' }] }))
    write('ui/P.tsx', 'export default () => "v1"')
    write('records/data/today.json', '{"mood":"mixed"}')
    const ui = createLiveUi({ workspace: ws })
    expect(ui.screens()[0]).toMatchObject({ name: 'today', title: 'Today', errors: [] })
    expect(ui.data()).toEqual({ today: { mood: 'mixed' } })
    const v1 = ui.panel('ui/P.tsx')
    expect(v1.error).toBeNull()
    expect(ui.panel('ui/P.tsx')).toBe(v1)
    const check = makeCheckUiTool(ui)
    expect(await check.run({}, {} as any)).toBe('OK: today load without errors.')

    write('ui/screens/today.json', '{"blocks": [')
    write('ui/P.tsx', 'export default () => <')
    fs.utimesSync(path.join(ws, 'ui/P.tsx'), new Date(), new Date(Date.now() + 5000))
    const s = ui.screens()[0]
    expect(s.screen?.title).toBe('Today')
    expect(s.errors[0]).toMatch(/^not valid JSON/)
    const p = ui.panel('ui/P.tsx')
    expect(p.code).toBe(v1.code)
    expect(p.version).toBe(v1.version)
    expect(p.error).toMatch(/ui\/P.tsx/)
    ui.reportError('ui/P.tsx', 'boom')
    const out = await check.run({}, {} as any)
    expect(out).toContain('ui/screens/today.json: not valid JSON')
    expect(out).toContain('ui/P.tsx: ui/P.tsx:')
    expect(out).toContain('ui/P.tsx (while drawing): boom')
  })
  it('uses the fallback screens until the folder has its own', () => {
    const ui = createLiveUi({ workspace: ws, fallback: { home: { title: 'Home', blocks: [] } } })
    expect(ui.screens()).toEqual([{ name: 'home', title: 'Home', order: Infinity, file: '', screen: { title: 'Home', blocks: [] }, errors: [] }])
  })
})

describe('decisions', () => {
  it('keys a recommendation by its date, ticker and action, taking the date from the data it came from', () => {
    const data = { today: { date: '2026-11-22', picks: [{ ticker: 'XLP', action: 'Buy' }] } }
    expect(dataDate(data, 'today.picks')).toBe('2026-11-22')
    expect(recKey({ ticker: 'XLP', action: 'Buy' }, '2026-11-22')).toBe('2026-11-22|XLP|Buy')
    expect(recKey({ ticker: 'XLP', id: 'x1' }, '2026-11-22')).toBe('x1')
  })
  it('records, replaces and undoes a choice in decisions.json', () => {
    const ui = createLiveUi({ workspace: ws })
    const rec = { ticker: 'XLP', action: 'Buy', date: '2026-11-22', entry: 90 }
    ui.decide(rec, 'accepted')
    ui.decide({ ticker: 'CLX', action: 'Buy', date: '2026-11-22' }, 'declined')
    ui.decide(rec, 'declined')
    const items = (ui.data().decisions as any).items
    expect(items.map((d: any) => [d.ticker, d.decision])).toEqual([['CLX', 'declined'], ['XLP', 'declined']])
    expect(items[1]).toMatchObject({ id: '2026-11-22|XLP|Buy', entry: 90 })
    ui.decide(rec, null)
    expect((ui.data().decisions as any).items).toHaveLength(1)
  })
})
