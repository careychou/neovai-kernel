import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentEvent, ChatRequest, Delta, Message, ModelAdapter } from '../agent-loop'
import { createRuntime, loadJobs, type Runtime } from './index'

const say = (text: string): Delta[] => [{ type: 'text', text }, { type: 'finish', reason: 'stop' }]
const call = (...calls: Array<[string, object]>): Delta[] => [
  ...calls.map(([name, args], i): Delta => ({ type: 'tool_call', index: i, id: `c${i}`, name, args: JSON.stringify(args) })),
  { type: 'finish', reason: 'tool_calls' }
]

let ws: string
let rt: Runtime
let requests: Message[][]
let events: AgentEvent[]

function start(steps: Delta[][]) {
  requests = []
  events = []
  const adapter: ModelAdapter = {
    async *stream(req: ChatRequest) {
      requests.push(structuredClone(req.messages))
      const s = steps.shift()
      if (!s) throw new Error('no more steps')
      yield* s
    }
  }
  rt = createRuntime({ workspace: ws, adapter, settings: () => ({ model: 'm' }), onEvent: (_r, _j, e) => events.push(e) })
}

const write = (p: string, text: string) => { fs.mkdirSync(path.dirname(path.join(ws, p)), { recursive: true }); fs.writeFileSync(path.join(ws, p), text) }
const toolOutputs = (msgs: Message[]) => msgs.flatMap((m) => (m.role === 'tool' ? [m.content] : []))

beforeEach(() => {
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rt-')))
  write('instructions/system.md', 'Stay inside the goals. MARKER-RULES')
  write('goals.json', '{"budget":1}')
  write('skills/scan/SKILL.md', '---\ndescription: Scan.\norder: 1\n---\nFetch the market. MARKER-SCAN')
  write('skills/pick/SKILL.md', '---\ndescription: Pick.\norder: 2\n---\nPick three. MARKER-PICK')
  write('jobs/daily.md', '---\ntitle: Daily picks\ndescription: Scan and pick.\n---\nRun scan, then pick. Save data as "today".')
})
afterEach(() => { rt?.dispose(); fs.rmSync(ws, { recursive: true, force: true }) })

describe('runtime agent', () => {
  it('lists jobs from their files', () => {
    expect(loadJobs(path.join(ws, 'jobs'))).toEqual([
      { name: 'daily', title: 'Daily picks', description: 'Scan and pick.', body: 'Run scan, then pick. Save data as "today".', file: path.join(ws, 'jobs/daily.md') }
    ])
  })

  it('appends every skill in full, in order, plus instructions, goals and the job to the instruction', async () => {
    start([say('Report')])
    const r = await rt.run('daily')
    const sys = requests[0][0].content as string
    for (const m of ['MARKER-RULES', 'MARKER-SCAN', 'MARKER-PICK', '{"budget":1}', '# Job: Daily picks', 'Writable: records']) expect(sys).toContain(m)
    expect(sys.indexOf('MARKER-SCAN')).toBeLessThan(sys.indexOf('MARKER-PICK'))
    expect(r.status).toBe('completed')
    expect(fs.readFileSync(r.file, 'utf8')).toContain('status: completed')
    expect(rt.lastRun('daily')).toMatchObject({ runId: r.runId, status: 'completed', text: 'Report' })
    expect(events.some((e) => e.kind === 'agent_end')).toBe(true)
  })

  it('picks up an edited skill on the next run without a restart', async () => {
    start([say('one'), say('two')])
    await rt.run('daily')
    write('skills/pick/SKILL.md', '---\norder: 2\n---\nPick two. MARKER-EDITED')
    await rt.run('daily')
    expect(requests[0][0].content).not.toContain('MARKER-EDITED')
    expect(requests[1][0].content).toContain('MARKER-EDITED')
  })

  it('saves structured data, and may write only under records', async () => {
    start([call(['save_data', { name: 'today', data: { mood: 'mixed' } }], ['write_file', { path: 'skills/pick/SKILL.md', content: 'x' }], ['write_file', { path: 'records/note.md', content: 'ok' }]), say('done')])
    await rt.run('daily')
    expect(JSON.parse(fs.readFileSync(path.join(ws, 'records/data/today.json'), 'utf8'))).toEqual({ mood: 'mixed' })
    expect(fs.readFileSync(path.join(ws, 'skills/pick/SKILL.md'), 'utf8')).toContain('MARKER-PICK')
    expect(fs.readFileSync(path.join(ws, 'records/note.md'), 'utf8')).toBe('ok')
    expect(toolOutputs(requests[1])[1]).toContain('read-only')
  })

  it('keeps read-only data files out of save_data', async () => {
    const { makeSaveDataTool } = await import('./index')
    const tool = makeSaveDataTool({ dir: path.join(ws, 'records/data'), locked: ['decisions'] })
    await expect(tool.run({ name: 'decisions', data: {} }, {} as never)).rejects.toThrow('read-only')
    await expect(tool.run({ name: 'today', data: {} }, {} as never)).resolves.toContain('today.json')
  })

  it('refuses unknown jobs and a missing model', async () => {
    start([])
    await expect(rt.run('nope')).rejects.toThrow('No job named "nope". Available: daily.')
    rt = createRuntime({ workspace: ws, adapter: { async *stream() {} }, settings: () => ({ model: '' }) })
    await expect(rt.run('daily')).rejects.toThrow('Choose a model in Settings first.')
  })
})
