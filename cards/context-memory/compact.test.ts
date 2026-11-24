import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { autoCompactDecision, applyCompaction, clusterLexical, keepLastPlan, liveTurnMap, normalizeClusters, planTurns, priorSummary, splitHistoryTurns, clusterTurns, removedCount, COMPACT_TAG } from './compact'
import { ContextMemory } from './memory'
import { Session, type SessionOptions } from '../agent-loop/session'
import { Store } from '../session-store/store'
import type { ChatRequest, Delta, Message, ModelAdapter } from '../agent-loop/types'

const turn = (q: string, a: string): Message[] => [{ role: 'user', content: q }, { role: 'assistant', content: a }]
const hist: Message[] = [
  ...turn('analyze beef pricing elasticity for ground beef', 'beef elasticity is -1.2'),
  ...turn('write a poem about the ocean', 'waves...'),
  { role: 'user', content: '<system_notification>bg done</system_notification>' }, { role: 'assistant', content: 'noted' },
  ...turn('compare ground beef pricing elasticity with chicken', 'chicken -0.8'),
  ...turn('what is next', 'next steps')
]

class Fake implements ModelAdapter {
  calls: ChatRequest[] = []
  constructor(private reply: (r: ChatRequest) => string) {}
  async *stream(req: ChatRequest): AsyncIterable<Delta> { this.calls.push(req); yield { type: 'text', text: this.reply(req) }; yield { type: 'finish', reason: 'stop' } }
}

/** A saved chat 'a' with `hist`, its live session and the memory over it. */
function setup(adapter: ModelAdapter, over: Partial<SessionOptions> = {}, compactModel?: () => string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-'))
  const store = new Store(dir)
  store.createSession({ id: 'a', title: 'a', cwd: '/w', model: 'm', created_at: 1, updated_at: 1 })
  store.saveMessages('a', hist)
  const s = new Session({ adapter, model: 'm', cwd: '/w', system: 'You are a test.', tools: [], history: hist, gate: { check: async () => true }, hooks: { onEvent() {}, requestPermission: async () => 'allow', askUser: async () => '' }, ...over })
  const mem = new ContextMemory({ store, session: () => s, compactModel })
  return { store, s, mem }
}

describe('compaction', () => {
  it('splits turns, ignoring notifications as turn starts', () => {
    const t = splitHistoryTurns(hist)
    expect(t.map((x) => x.user.slice(0, 7))).toEqual(['analyze', 'write a', 'compare', 'what is'])
    expect(t[1].messages).toHaveLength(4)
  })

  it('lexical clustering groups non-adjacent turns on the same topic', () => {
    const c = normalizeClusters(clusterLexical(splitHistoryTurns(hist)), [0, 1, 2, 3])
    expect(c.find((x) => x.turns.includes(0))!.turns).toEqual([0, 2])
    expect(c.flatMap((x) => x.turns).sort()).toEqual([0, 1, 2, 3])
  })

  it('normalizes model clusters: dedupes, drops bad indexes, adds missing turns', () => {
    const c = normalizeClusters([{ label: 'a', turns: [0, 2, 9] }, { label: 'b', turns: [2] }], [0, 1, 2])
    expect(c).toEqual([{ label: 'a', turns: [0, 2] }, { label: 'Turn 2', turns: [1] }])
  })

  it('uses model clusters when the reply is valid JSON, else falls back', async () => {
    const t = splitHistoryTurns(hist)
    const ok = await clusterTurns(new Fake(() => 'Sure: {"clusters":[{"label":"Beef","turns":[1,3]},{"label":"Misc","turns":[2,4]}]}'), 'm', t)
    expect(ok.method).toBe('model')
    expect(ok.clusters.map((c) => c.turns)).toEqual([[0, 2], [1, 3]])
    const bad = await clusterTurns(new Fake(() => 'nope'), 'm', t)
    expect(bad.method).toBe('lexical')
  })

  it('applies a plan: summary head, recent turns verbatim, chained summaries', () => {
    const t = splitHistoryTurns(hist)
    expect(keepLastPlan(4, 1)).toEqual({ keep: [3], summarize: [0, 1, 2] })
    const p = planTurns(t, { keep: [3], summarize: [0, 2, 3] })
    expect(p.summarized.map((x) => x.index)).toEqual([0, 2])
    expect(p.dropped.map((x) => x.index)).toEqual([1])
    const next = applyCompaction(hist, 'SUMMARY', [3])
    expect((next[0].content as string).startsWith(COMPACT_TAG)).toBe(true)
    expect(next.slice(2)).toEqual(turn('what is next', 'next steps'))
    expect(priorSummary(next)).toContain('SUMMARY')
    expect(splitHistoryTurns(next)).toHaveLength(1)
    expect(liveTurnMap(3, [1, 5])).toEqual([1, 5, 6])
    expect(liveTurnMap(2, null)).toEqual([0, 1])
  })

  it('compact summarizes only chosen turns, rewrites and saves the history, and refuses a busy session', async () => {
    const fake = new Fake((r) => `SUM(${(r.messages[1].content as string).includes('poem') ? 'poem' : 'nopoem'})`)
    const { s, mem, store } = setup(fake)
    const r = await mem.compact('a', s, { keep: [3], summarize: [0, 2] })
    expect(r).toMatchObject({ summarized: 2, dropped: 1, summary: 'SUM(nopoem)', keptTurns: [3], compactedTurns: [0, 2, 1] })
    expect(r.after).toBeLessThan(r.before)
    expect(s.history).toHaveLength(4)
    expect(s.messages[0].role).toBe('system')
    expect(store.loadMessages('a')).toEqual(s.history)
    expect(await mem.compact('a', s, { keep: [0], summarize: [] })).toMatchObject({ summarized: 0, dropped: 0, model: '' })
    await expect(s.exclusive(() => mem.compact('a', s, { keep: [], summarize: [0] }))).rejects.toThrow('busy')
    expect(s.isBusy).toBe(false)
  })

  it('the summary notes how many turns were removed, across repeated compactions; removed turns stay searchable and are hinted after the prompt', async () => {
    const { s, mem } = setup(new Fake(() => 'SUM'))
    await mem.compact('a', s, { keep: [3], summarize: [0, 2] })
    expect(removedCount(s.history)).toBe(3)
    await mem.send('a', s, 'what was the poem about the ocean')
    const sent = s.history.at(-2)!.content as string
    expect(sent.startsWith('what was the poem about the ocean\n\n<recall_hints>')).toBe(true)
    expect(sent).toContain('turn 2 (removed by compaction')
    expect(splitHistoryTurns(s.history).at(-1)!.user).toBe('what was the poem about the ocean')
    const r = await mem.compact('a', s, { keep: [1], summarize: [0] })
    expect(r).toMatchObject({ keptTurns: [4], compactedTurns: [3] })
    expect(removedCount(s.history)).toBe(4)
    expect((s.history[0].content as string).match(/recall_note>/g)).toHaveLength(2)
    expect((mem.search('a', 'beef elasticity', 'session', 5) as any[]).map((h) => [h.turn, h.inContext])).toEqual([[0, false], [2, false]])
  })

  it('send compacts first when auto-compaction says so, and reports it', async () => {
    const { s, mem } = setup(new Fake(() => 'SUM'))
    const done: number[] = []
    const auto = { mode: 'auto' as const, threshold: 1, hardLimit: 2, idleMinutes: 5, keepRecent: 1, minGain: 1 }
    await mem.send('a', s, 'continue', { auto, onCompact: (r) => done.push(r.summarized) })
    expect(done).toEqual([3])
    expect(splitHistoryTurns(s.history)).toHaveLength(2)
  })

  it('keeps arbitrary (non-recent) turns verbatim in original order', async () => {
    const next = applyCompaction(hist, 'S', [0, 2])
    expect(splitHistoryTurns(next).map((t) => t.user.slice(0, 7))).toEqual(['analyze', 'compare'])
    expect(next[0].role).toBe('user')
  })
})

describe('compaction model', () => {
  const hooks = (events: any[]) => ({ onEvent: (e: any) => events.push(e), requestPermission: async () => 'allow' as const, askUser: async () => '' })

  it('summarizes with the compaction model and reports its usage under the compact agent', async () => {
    const calls: string[] = []
    const ad: ModelAdapter = { async *stream(r) { calls.push(r.model); yield { type: 'text', text: 'SUM' }; yield { type: 'usage', prompt: 900, completion: 40 }; yield { type: 'finish', reason: 'stop' } } }
    const events: any[] = []
    const { s, mem } = setup(ad, { model: 'big', hooks: hooks(events) }, () => 'cheap')
    const r = await mem.compact('a', s, { keep: [3], summarize: [0, 1, 2] })
    expect(calls).toEqual(['cheap'])
    expect(r.model).toBe('cheap')
    expect(events).toContainEqual(expect.objectContaining({ kind: 'usage', agentId: 'compact', model: 'cheap', prompt: 900 }))
  })

  it("falls back to the chat's model when the compaction model fails", async () => {
    const calls: string[] = []
    const ad: ModelAdapter = { async *stream(r) { calls.push(r.model); if (r.model === 'gone') throw new Error('404 model not found'); yield { type: 'text', text: 'SUM' }; yield { type: 'finish', reason: 'stop' } } }
    const { s, mem } = setup(ad, { model: 'big', hooks: hooks([]) }, () => 'gone')
    const r = await mem.compact('a', s, { keep: [3], summarize: [0, 1, 2] })
    expect(calls).toEqual(['gone', 'big'])
    expect(r).toMatchObject({ model: 'big', summary: 'SUM' })
  })

  it("groups turns with the chat's model when the compaction model fails", async () => {
    const calls: string[] = []
    const ad: ModelAdapter = { async *stream(r) { calls.push(r.model); if (r.model === 'gone') throw new Error('404'); yield { type: 'text', text: '{"clusters":[{"label":"Beef","turns":[1,3]},{"label":"Misc","turns":[2,4]}]}' }; yield { type: 'finish', reason: 'stop' } } }
    const { s, mem } = setup(ad, { model: 'big', hooks: hooks([]) }, () => 'gone')
    const r = await mem.analyze(s)
    expect(calls).toEqual(['gone', 'big'])
    expect(r).toMatchObject({ method: 'model', model: 'big' })
  })
})

describe('autoCompactDecision (cache-aware)', () => {
  const big = (n: number, chars: number) => Array.from({ length: n }, (_, i) => ({ index: i, messages: [{ role: 'user' as const, content: 'x'.repeat(chars) }], user: '', answer: '', tools: [] }))
  const base = { mode: 'auto' as const, tokens: 100_000, threshold: 80_000, hardLimit: 120_000, idleMinutes: 5, idleMs: 0, turns: big(10, 40_000), keepRecent: 2, minGain: 20_000 }

  it('waits while the prompt cache is warm, compacts once idle', () => {
    expect(autoCompactDecision(base)).toMatchObject({ compact: false, reason: 'cache-warm' })
    expect(autoCompactDecision({ ...base, idleMs: 6 * 60_000 })).toMatchObject({ compact: true, reason: 'idle' })
  })
  it('compacts at the hard limit even when the cache is warm', () => {
    expect(autoCompactDecision({ ...base, tokens: 130_000 })).toMatchObject({ compact: true, reason: 'hard-limit' })
  })
  it('skips small gains, short chats, under-threshold, and non-auto modes', () => {
    expect(autoCompactDecision({ ...base, idleMs: 1e9, turns: big(10, 400) })).toMatchObject({ compact: false, reason: 'small-gain' })
    expect(autoCompactDecision({ ...base, idleMs: 1e9, turns: big(2, 400_000) })).toMatchObject({ compact: false, reason: 'too-few-turns' })
    expect(autoCompactDecision({ ...base, idleMs: 1e9, tokens: 50_000 })).toMatchObject({ compact: false, reason: 'under-threshold' })
    expect(autoCompactDecision({ ...base, idleMs: 1e9, mode: 'suggest' })).toMatchObject({ compact: false, reason: 'off' })
  })
  it('idle wait 0 compacts immediately', () => {
    expect(autoCompactDecision({ ...base, idleMinutes: 0 })).toMatchObject({ compact: true, reason: 'no-wait' })
  })
})
