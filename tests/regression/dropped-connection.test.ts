// A model server that closes the connection mid-reply ("terminated") or before answering ("fetch failed"),
// through the real OpenAI adapter and Node's fetch: the run retries and finishes with the complete reply.
import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Session } from '../../cards/agent-loop/session'
import type { AgentEvent } from '../../cards/agent-loop/types'
import { OpenAIAdapter } from '../../cards/model-providers/openai'

const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`

let server: http.Server | null = null
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())))

/** Serves one behaviour per request, in order. */
function serve(plan: Array<'drop-mid-reply' | 'drop-before-reply' | 'answer'>): Promise<{ url: string; hits: () => number }> {
  let hits = 0
  server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      const step = plan[Math.min(hits++, plan.length - 1)]
      if (step === 'drop-before-reply') { req.socket.destroy(); return }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (step === 'drop-mid-reply') {
        res.write(chunk({ role: 'assistant', content: 'Half an ans' }))
        setTimeout(() => req.socket.destroy(), 30)
        return
      }
      res.write(chunk({ role: 'assistant', content: 'The full answer.' }))
      res.end(chunk({}, 'stop') + 'data: [DONE]\n\n')
    })
  })
  return new Promise((r) => server!.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`, hits: () => hits })))
}

function session(url: string, events: AgentEvent[]) {
  return new Session({
    adapter: new OpenAIAdapter({ baseUrl: url, apiKey: 'k' }), model: 'm', cwd: '/w', system: 's', tools: [],
    hooks: { onEvent: (e) => events.push(e), requestPermission: async () => 'allow', askUser: async () => '' },
    gate: { check: async () => true }, retryDelaysMs: [10, 10, 10]
  })
}

describe('dropped connections to the model', () => {
  it('a reply cut off mid-stream and a request that got no response are both tried again', async () => {
    const { url, hits } = await serve(['drop-mid-reply', 'drop-before-reply', 'answer'])
    const events: AgentEvent[] = []
    const s = session(url, events)
    expect(await s.send('hi')).toEqual({ status: 'completed', text: 'The full answer.' })
    expect(hits()).toBe(3)
    expect(s.history).toEqual([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'The full answer.' }])
    const retries = events.filter((e) => e.kind === 'retry') as Extract<AgentEvent, { kind: 'retry' }>[]
    expect(retries.map((e) => [e.attempt, e.discarded])).toEqual([[2, true], [3, false]])
    expect(retries[0].reason).toMatch(/^terminated \(.+\)$/)
    expect(retries[1].reason).toMatch(/^fetch failed \(.+\)$/)
  })

  it('gives up after four tries and says why', async () => {
    const { url, hits } = await serve(['drop-mid-reply'])
    const r = await session(url, []).send('hi')
    expect(r.status).toBe('failed')
    expect(r.text).toMatch(/^Lost the connection to the model 4 times in a row\. Last error: terminated \(.+\)$/)
    expect(hits()).toBe(4)
  })
})
