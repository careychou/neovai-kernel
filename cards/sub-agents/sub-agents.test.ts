import { describe, it, expect } from 'vitest'
import { Session } from '../agent-loop/session'
import type { AgentEvent, ChatRequest, Delta, Hooks, Message, ModelAdapter } from '../agent-loop/types'
import type { ToolDef } from '../agent-loop/tool'
import { SubAgents } from './sub-agents'

const say = (text: string): Delta[] => [{ type: 'text', text }, { type: 'finish', reason: 'stop' }]
const call = (...calls: Array<[string, unknown]>): Delta[] => [
  ...calls.map(([name, args], i): Delta => ({ type: 'tool_call', index: i, id: `c${i}-${Math.random().toString(36).slice(2, 6)}`, name, args: JSON.stringify(args) })),
  { type: 'finish', reason: 'tool_calls' }
]
const text = (m: Message) => (typeof m.content === 'string' ? m.content : '')
const lastUser = (req: ChatRequest) => text([...req.messages].reverse().find((m) => m.role === 'user')!)
const toolResults = (req: ChatRequest) => req.messages.filter((m) => m.role === 'tool').map(text)

/** A model that answers by script: `brain` sees each request and returns what to stream. */
function setup(brain: (req: ChatRequest, signal: AbortSignal) => Promise<Delta[]> | Delta[], over: Partial<ConstructorParameters<typeof SubAgents>[0]> = {}) {
  const events: AgentEvent[] = []
  const requests: ChatRequest[] = []
  const adapter: ModelAdapter = {
    async *stream(req, signal) {
      requests.push({ ...req, messages: structuredClone(req.messages) })
      for (const d of await brain(req, signal)) yield d
    }
  }
  const hooks: Hooks = { onEvent: (e) => events.push(e), requestPermission: async () => 'allow', askUser: async () => '' }
  const gate = { check: async () => true }
  const echo: ToolDef = { name: 'echo', description: 'Echo', parameters: { type: 'object', properties: { t: { type: 'string' } } }, run: async (a) => `echo:${a.t}` }
  const subs = new SubAgents({ adapter, hooks, gate, cwd: '/w', model: 'm', tools: [echo], ...over })
  const session = new Session({ adapter, hooks, gate, model: 'm', cwd: '/w', system: 'main', tools: () => [echo, ...subs.tools(0)] })
  subs.attach(session)
  return { session, subs, events, requests }
}

const isMain = (req: ChatRequest) => text(req.messages[0]) === 'main'

describe('sub-agents', () => {
  it('runs a sync sub-agent with fresh context and returns only its final answer', async () => {
    const { session, events, requests } = setup((req) => {
      if (isMain(req)) return toolResults(req).length ? say(`got ${toolResults(req)[0]}`) : call(['task', { prompt: 'count to 3', description: 'Count' }])
      return say('1 2 3')
    })
    expect((await session.send('go')).text).toBe('got 1 2 3')
    const child = requests.find((r) => !isMain(r))!
    expect(child.messages.map((m) => m.role)).toEqual(['system', 'user'])
    expect(lastUser(child)).toBe('count to 3')
    const start = events.find((e) => e.kind === 'agent_start') as any
    expect(start).toMatchObject({ parentId: 'main', name: 'general-purpose', mode: 'sync', description: 'Count' })
    expect(start.callId).toBeTruthy()
    expect(events.find((e) => e.kind === 'agent_end' && e.agentId === start.agentId)).toMatchObject({ status: 'completed', finalText: '1 2 3' })
  })

  it('runs several task calls in one reply in parallel', async () => {
    let live = 0, peak = 0
    const { session } = setup(async (req) => {
      if (isMain(req)) return toolResults(req).length ? say(toolResults(req).join(',')) : call(['task', { prompt: 'a' }], ['task', { prompt: 'b' }], ['task', { prompt: 'c' }])
      live++; peak = Math.max(peak, live)
      await new Promise((r) => setTimeout(r, 20))
      live--
      return say(lastUser(req).toUpperCase())
    })
    expect((await session.send('go')).text).toBe('A,B,C')
    expect(peak).toBe(3)
  })

  it('keeps all model calls within the shared concurrency limit', async () => {
    let live = 0, peak = 0
    const { session } = setup(async (req) => {
      if (isMain(req)) return toolResults(req).length ? say('ok') : call(...['a', 'b', 'c', 'd', 'e', 'f'].map((p): [string, unknown] => ['task', { prompt: p }]))
      live++; peak = Math.max(peak, live)
      await new Promise((r) => setTimeout(r, 10))
      live--
      return say('x')
    })
    session.semaphore.setMax(2)
    await session.send('go')
    expect(peak).toBe(2)
  })

  it('runs at most maxConcurrency sub-agents at once, tools included, and queues the rest', async () => {
    let live = 0, peak = 0, done = 0
    const slow: ToolDef = { name: 'slow', description: 'Slow work', parameters: { type: 'object', properties: {} }, run: async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 15)); live--; done++; return 'ok' } }
    const { session } = setup((req) => {
      if (isMain(req)) return toolResults(req).length ? say(`all ${toolResults(req).length}`) : call(...Array.from({ length: 10 }, (_, i): [string, unknown] => ['task', { prompt: `s${i}` }]))
      return toolResults(req).length ? say('x') : call(['slow', {}])
    }, { tools: [slow] })
    session.semaphore.setMax(4)
    expect((await session.send('go')).text).toBe('all 10')
    expect(peak).toBe(4)
    expect(done).toBe(10)
  })

  it('cancels sub-agents still queued for a place when the user stops', async () => {
    // The running sub-agent waits in a tool (not a model call), so the main agent can still answer.
    const hang: ToolDef = { name: 'hang', description: 'Waits', parameters: { type: 'object', properties: {} }, run: (_a, ctx) => new Promise((_r, j) => { ctx.signal.addEventListener('abort', () => j(new Error('aborted')), { once: true }) }) }
    const { session, subs } = setup((req) => {
      if (isMain(req)) return toolResults(req).length ? say('ok') : call(...['a', 'b', 'c'].map((p): [string, unknown] => ['task', { prompt: p, mode: 'background' }]))
      return call(['hang', {}])
    }, { tools: [hang] })
    session.semaphore.setMax(1)
    await session.send('go')
    expect(subs.running()).toBe(3)
    subs.cancelAll()
    await new Promise((r) => setTimeout(r, 20))
    expect(subs.list().map((a) => a.status)).toEqual(['cancelled', 'cancelled', 'cancelled'])
  })

  it('runs a background sub-agent, then wakes the idle main agent with a notice', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const { session, subs } = setup(async (req) => {
      if (isMain(req)) {
        const u = lastUser(req)
        if (u.includes('<system_notification>')) return say('noticed')
        return toolResults(req).length ? say('started') : call(['task', { prompt: 'slow', mode: 'background' }])
      }
      await gate
      return say('slow done')
    })
    expect((await session.send('go')).text).toBe('started')
    expect(subs.running()).toBe(1)
    const ended = new Promise<string>((r) => { const h = setInterval(() => { const last = session.history.at(-1); if (!session.isBusy && last && text(last) === 'noticed') { clearInterval(h); r(text(last)) } }, 5) })
    release()
    expect(await ended).toBe('noticed')
    const note = session.history.find((m) => m.role === 'user' && text(m).includes('<system_notification>'))!
    expect(text(note)).toMatch(/Background agent general-purpose-1 \(general-purpose\) completed/)
    const id = subs.list()[0].id
    expect((await subs.read(id))?.finalText).toBe('slow done')
  })

  it('read_agent waits for a background result', async () => {
    const { session } = setup(async (req) => {
      if (isMain(req)) {
        const r = toolResults(req)
        if (r.length === 0) return call(['task', { prompt: 'p', mode: 'background' }])
        if (r.length === 1) return call(['read_agent', { agent_id: /agent_id: (\S+)/.exec(r[0])![1], wait: true }])
        return say(r[1])
      }
      await new Promise((r) => setTimeout(r, 20))
      return say('bg result')
    })
    const r = await session.send('go')
    expect(r.text).toContain('status: completed')
    expect(r.text).toContain('bg result')
  })

  it('stops delegating at the depth limit', async () => {
    const { session, requests } = setup((req) => {
      if (isMain(req)) return toolResults(req).length ? say('done') : call(['task', { prompt: 'level1' }])
      if (lastUser(req) === 'level1') return toolResults(req).length ? say('l1 done') : call(['task', { prompt: 'level2' }])
      return say('l2 done')
    }, { maxDepth: 2 })
    await session.send('go')
    const tools = (p: string) => requests.find((r) => !isMain(r) && lastUser(r) === p)!.tools?.map((t) => t.function.name) ?? []
    expect(tools('level1')).toContain('task')
    expect(tools('level2')).not.toContain('task')
    expect(tools('level2')).toContain('echo')
  })

  it('uses a named role: its instruction and only its tools', async () => {
    const { session, requests } = setup((req) => {
      if (isMain(req)) return toolResults(req).length ? say('done') : call(['task', { prompt: 'look', agent: 'researcher' }])
      return say('found')
    }, { agents: [{ name: 'researcher', description: 'Finds facts', system: 'You research.', tools: [] }] })
    await session.send('go')
    const child = requests.find((r) => !isMain(r))!
    expect(text(child.messages[0])).toMatch(/^You research\./)
    expect(child.tools ?? []).toEqual([])
    expect(requests[0].tools?.find((t) => t.function.name === 'task')?.function.description).toContain('researcher (Finds facts)')
  })

  it('reports an unknown role as a tool error', async () => {
    const { session, requests } = setup((req) => (toolResults(req).length ? say('ok') : call(['task', { prompt: 'x', agent: 'nope' }])))
    await session.send('go')
    expect(toolResults(requests[1])[0]).toMatch(/^Error: unknown agent "nope"/)
  })

  it('Stop cancels running sync and background sub-agents', async () => {
    const { session, subs, events } = setup(async (req, signal) => {
      if (isMain(req)) {
        if (toolResults(req).length) return say('?')
        return call(['task', { prompt: 'bg', mode: 'background' }], ['task', { prompt: 'fg' }])
      }
      await new Promise((_r, bad) => signal.addEventListener('abort', () => bad(new Error('aborted'))))
      return []
    })
    const run = session.send('go')
    await new Promise((r) => setTimeout(r, 20))
    expect(subs.running()).toBe(2)
    session.stop()
    expect((await run).status).toBe('cancelled')
    await new Promise((r) => setTimeout(r, 5))
    expect(subs.list().map((a) => a.status)).toEqual(['cancelled', 'cancelled'])
    expect(events.filter((e) => e.kind === 'agent_end' && e.agentId !== 'main').length).toBe(2)
  })

  it('with background off, offers only task and runs every sub-agent sync', async () => {
    const { session, requests, subs } = setup((req) => {
      if (isMain(req)) return toolResults(req).length ? say(toolResults(req)[0]) : call(['task', { prompt: 'p', mode: 'background' }])
      return say('inline')
    }, { background: false })
    expect((await session.send('go')).text).toBe('inline')
    expect(requests[0].tools?.map((t) => t.function.name)).toEqual(['echo', 'task'])
    expect(JSON.stringify(requests[0].tools)).not.toContain('"background"')
    expect(subs.list()[0].mode).toBe('sync')
  })
})
