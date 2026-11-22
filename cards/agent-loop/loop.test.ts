import { describe, it, expect } from 'vitest'
import { Session, type SessionOptions } from './session'
import type { AgentEvent, ChatRequest, Delta, Hooks, Message, ModelAdapter } from './types'
import type { ToolDef } from './tool'

type Step = Delta[] | Error | ((req: ChatRequest, signal: AbortSignal) => Promise<Delta[]>)
const say = (text: string): Delta[] => [{ type: 'text', text }, { type: 'usage', prompt: 5, completion: 2 }, { type: 'finish', reason: 'stop' }]
const call = (...calls: Array<[name: string, args: unknown]>): Delta[] => [
  ...calls.map(([name, args], i): Delta => ({ type: 'tool_call', index: i, id: `c${i}`, name, args: typeof args === 'string' ? args : JSON.stringify(args) })),
  { type: 'finish', reason: 'tool_calls' }
]

function fake(steps: Step[]) {
  const requests: ChatRequest[] = []
  const adapter: ModelAdapter = {
    async *stream(req, signal) {
      requests.push({ ...req, messages: structuredClone(req.messages) })
      const s = steps.shift()
      if (!s) throw Object.assign(new Error('no more steps'), { status: 400 })
      if (s instanceof Error) throw s
      for (const d of typeof s === 'function' ? await s(req, signal) : s) yield d
    }
  }
  return { adapter, requests }
}

function setup(steps: Step[], over: Partial<SessionOptions> = {}) {
  const events: AgentEvent[] = []
  const hooks: Hooks = { onEvent: (e) => events.push(e), requestPermission: async () => 'allow', askUser: async () => '' }
  const { adapter, requests } = fake(steps)
  const asked: string[] = []
  const session = new Session({
    adapter, hooks, model: 'm', cwd: '/w', system: 'You are a test.', tools: [],
    gate: { check: async (_a, kind, detail) => { asked.push(`${kind}:${detail}`); return true } },
    ...over
  })
  return { session, events, requests, asked }
}

const echo: ToolDef = {
  name: 'echo', description: 'Echo', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  run: async (a) => `echo:${a.text}`
}
const toolOutputs = (msgs: Message[]) => msgs.filter((m) => m.role === 'tool').map((m) => m.content)

describe('agent loop', () => {
  it('answers a prompt and records the conversation', async () => {
    const { session, events, requests } = setup([say('hello')])
    expect(await session.send('hi')).toEqual({ status: 'completed', text: 'hello' })
    expect(requests[0].messages).toEqual([{ role: 'system', content: 'You are a test.' }, { role: 'user', content: 'hi' }])
    expect(session.history.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(events.map((e) => e.kind)).toEqual(['text', 'usage', 'assistant_done', 'agent_end'])
    expect(events.at(-1)).toMatchObject({ status: 'completed', finalText: 'hello' })
  })

  it('runs tool calls in parallel and feeds the results back', async () => {
    const { session, requests, events } = setup([call(['echo', { text: 'a' }], ['echo', { text: 'b' }]), say('done')], { tools: [echo] })
    expect((await session.send('go')).text).toBe('done')
    expect(requests[0].tools?.map((t) => t.function.name)).toEqual(['echo'])
    expect(toolOutputs(requests[1].messages)).toEqual(['echo:a', 'echo:b'])
    expect(events.filter((e) => e.kind === 'tool_end').every((e: any) => e.ok)).toBe(true)
  })

  it('turns tool failures into error output the model can read', async () => {
    const boom: ToolDef = { name: 'boom', description: '', parameters: { type: 'object', properties: {} }, run: async () => { throw new Error('kaput') } }
    const { session, requests, events } = setup(
      [call(['nope', {}], ['echo', '{bad'], ['echo', {}], ['boom', {}]), say('ok')], { tools: [echo, boom] })
    expect((await session.send('go')).status).toBe('completed')
    const out = toolOutputs(requests[1].messages)
    expect(out[0]).toContain('unknown tool "nope"')
    expect(out[1]).toMatch(/^Error: /)
    expect(out[2]).toContain('missing required argument')
    expect(out[3]).toBe('Error: kaput')
    expect(events.filter((e) => e.kind === 'tool_end').some((e: any) => e.ok)).toBe(false)
  })

  it('asks the gate before a tool that needs permission, and blocks it on refusal', async () => {
    let ran = 0
    const risky: ToolDef = { name: 'risky', description: '', permission: 'shell', parameters: { type: 'object', properties: {} }, summarize: () => 'rm -rf x', run: async () => { ran++; return 'did it' } }
    const a = setup([call(['risky', {}]), say('ok')], { tools: [risky] })
    await a.session.send('go')
    expect(a.asked).toEqual(['shell:rm -rf x'])
    expect(ran).toBe(1)
    const b = setup([call(['risky', {}]), say('ok')], { tools: [risky], gate: { check: async () => false } })
    await b.session.send('go')
    expect(ran).toBe(1)
    expect(toolOutputs(b.requests[1].messages)[0]).toContain('the user denied permission')
  })

  it('passes cwd and services to tools', async () => {
    let seen: any
    const peek: ToolDef = { name: 'peek', description: '', parameters: { type: 'object', properties: {} }, run: async (_a, ctx) => { seen = ctx; return 'ok' } }
    const { session } = setup([call(['peek', {}]), say('ok')], { tools: [peek], services: { ledger: 42 } })
    await session.send('go')
    expect(seen).toMatchObject({ cwd: '/w', agentId: 'main', depth: 0, services: { ledger: 42 } })
  })

  it('stops at the turn limit', async () => {
    const loopForever = Array.from({ length: 5 }, () => call(['echo', { text: 'x' }]))
    const { session, events, requests } = setup(loopForever, { tools: [echo], maxTurns: 2 })
    const r = await session.send('go')
    expect(r.status).toBe('failed')
    expect(r.text).toContain('max of 2 turns')
    expect(requests).toHaveLength(2)
    expect(events.some((e) => e.kind === 'error')).toBe(true)
  })

  it('retries once when the model fails before streaming anything', async () => {
    const { session, requests } = setup([Object.assign(new Error('bad gateway'), { status: 502 }), say('recovered')])
    expect(await session.send('hi')).toEqual({ status: 'completed', text: 'recovered' })
    expect(requests).toHaveLength(2)
  })

  it('does not retry a request the provider rejected', async () => {
    const { session, requests } = setup([Object.assign(new Error('bad request'), { status: 400 }), say('never')])
    expect(await session.send('hi')).toEqual({ status: 'failed', text: 'bad request' })
    expect(requests).toHaveLength(1)
  })
})

describe('session', () => {
  it('re-reads the system prompt and tools before each run', async () => {
    let sys = 'v1'
    let tools: ToolDef[] = []
    const { session, requests } = setup([say('a'), say('b')], { system: () => sys, tools: () => tools })
    await session.send('one')
    sys = 'v2'; tools = [echo]
    await session.send('two')
    expect(requests[0].messages[0].content).toBe('v1')
    expect(requests[0].tools ?? []).toEqual([])
    expect(requests[1].messages[0].content).toBe('v2')
    expect(requests[1].tools?.[0].function.name).toBe('echo')
  })

  it('resumes from saved history', async () => {
    const history: Message[] = [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'reply' }]
    const { session, requests } = setup([say('next')], { history })
    await session.send('again')
    expect(requests[0].messages.map((m) => m.content)).toEqual(['You are a test.', 'earlier', 'reply', 'again'])
  })

  it('queues a prompt sent while busy and delivers it before the next model call', async () => {
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const slow: ToolDef = { name: 'slow', description: '', parameters: { type: 'object', properties: {} }, run: async () => { await held; return 'slow done' } }
    const { session, requests, events } = setup([call(['slow', {}]), say('finished')], { tools: [slow] })
    const first = session.send('start')
    await new Promise((r) => setTimeout(r, 20))
    expect(session.isBusy).toBe(true)
    expect(await session.send('also this', [], 'q1')).toEqual({ status: 'queued', text: '' })
    release()
    expect((await first).text).toBe('finished')
    expect(requests[1].messages.at(-1)).toEqual({ role: 'user', content: 'also this' })
    expect(events.some((e) => e.kind === 'user_input' && e.qid === 'q1')).toBe(true)
    expect(session.isBusy).toBe(false)
  })

  it('can remove a queued prompt before it is sent', async () => {
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const slow: ToolDef = { name: 'slow', description: '', parameters: { type: 'object', properties: {} }, run: async () => { await held; return 'ok' } }
    const { session, requests } = setup([call(['slow', {}]), say('finished')], { tools: [slow] })
    const first = session.send('start')
    await new Promise((r) => setTimeout(r, 20))
    await session.send('drop me', [], 'q1')
    expect(session.unqueue('q1')).toBe(true)
    expect(session.unqueue('q1')).toBe(false)
    release()
    await first
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[1].messages)).not.toContain('drop me')
  })

  it('stop cancels the run, clears the queue and leaves a valid history', async () => {
    const hang: ToolDef = {
      name: 'hang', description: '', parameters: { type: 'object', properties: {} },
      run: (_a, ctx) => new Promise((_r, rej) => ctx.signal.addEventListener('abort', () => rej(new Error('aborted'))))
    }
    const { session, events } = setup([call(['hang', {}]), say('never')], { tools: [hang] })
    const first = session.send('start')
    await new Promise((r) => setTimeout(r, 20))
    await session.send('queued', [], 'q9')
    session.stop()
    expect(await first).toEqual({ status: 'cancelled', text: 'cancelled' })
    expect(events.find((e) => e.kind === 'queue_cleared')).toMatchObject({ qids: ['q9'] })
    expect(events.at(-1)).toMatchObject({ kind: 'agent_end', status: 'cancelled' })
    const calls = session.history.flatMap((m) => (m.role === 'assistant' ? m.tool_calls ?? [] : [])).map((c) => c.id)
    const results = session.history.flatMap((m) => (m.role === 'tool' ? [m.tool_call_id] : []))
    expect(results).toEqual(calls)
    expect(session.isBusy).toBe(false)
  })

  it('can run again after a failure', async () => {
    const { session } = setup([Object.assign(new Error('bad request'), { status: 400 }), say('fine')])
    expect((await session.send('one')).status).toBe('failed')
    expect(await session.send('two')).toEqual({ status: 'completed', text: 'fine' })
  })
})
