import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../session-store/store'
import { applyCompaction, priorSummary, removedCount, splitHistoryTurns } from './compact'
import { buildUserContent } from '../agent-loop/content'
import { coverage, entryOf, formatHints, formatResults, ftsQuery, pickHints, recallTool, stripHints, type RecallHit } from './recall'
import { TurnIndex } from './turn-index'
import { ContextMemory } from './memory'
import type { Message } from '../agent-loop/types'

const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, cwd: '/w', model: 'm', created_at: 1, updated_at: 1, ...extra })
const turn = (user: string, answer: string): Message[] => [{ role: 'user', content: user }, { role: 'assistant', content: answer }]
const hit = (over: Partial<RecallHit> = {}): RecallHit => ({ sessionId: 'a', turn: 0, user: 'pick the retry threshold', answer: 'We chose 7 attempts.', tools: '', ts: 0, title: 'Retry', cwd: '/w', current: true, ...over })

let tmp: string, store: Store, index: TurnIndex
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-')); store = new Store(tmp); index = new TurnIndex(store) })
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('recall: index entries', () => {
  it('keeps the prompt and answer, names attachments without their body, and drops hints', () => {
    const user = buildUserContent('Check the budget', [{ kind: 'text', name: 'plan.csv', text: 'SECRETBODY,1,2' }], formatHints([hit()])) as string
    const [t] = splitHistoryTurns(turn(user, 'Budget is fine.'))
    const e = entryOf(t, 4, 9)!
    expect(e).toMatchObject({ turn: 4, answer: 'Budget is fine.', ts: 9 })
    expect(e.user).toContain('Check the budget')
    expect(e.user).toContain('[attached: plan.csv]')
    expect(e.user).not.toContain('SECRETBODY')
    expect(e.user).not.toContain('recall_hints')
  })
  it('hints are attached after the prompt and attachments, and stripHints removes them', () => {
    const h = formatHints([hit({ inContext: false })])
    const c = buildUserContent('hello', [{ kind: 'text', name: 'a.txt', text: 'x' }], h) as string
    expect(c.endsWith(h)).toBe(true)
    expect(stripHints(c)).toBe(buildUserContent('hello', [{ kind: 'text', name: 'a.txt', text: 'x' }]))
    expect(buildUserContent('hello', [], '')).toBe('hello')
  })
})

describe('recall: hint gate', () => {
  it('attaches nothing when too few of the prompt terms match', () => {
    expect(pickHints('what retry threshold did we choose', [hit()])).toHaveLength(1)
    expect(pickHints('draft an email about the holiday schedule and retry', [hit()])).toHaveLength(0)
    expect(pickHints('threshold', [hit()])).toHaveLength(0)
    expect(formatHints([])).toBe('')
  })
  it('caps the number of hints and matches word forms', () => {
    const many = Array.from({ length: 9 }, (_, i) => hit({ turn: i }))
    expect(pickHints('retry threshold', many)).toHaveLength(4)
    expect(coverage('thresholds picked', hit()).matched).toBe(2)
  })
  it('says whether a turn is still in the conversation', () => {
    expect(formatHints([hit({ inContext: true, turn: 2 })])).toContain('turn 3 (still in the conversation above)')
    expect(formatHints([hit({ inContext: false })])).toContain('removed by compaction')
    expect(formatHints([hit({ current: false, title: 'Other chat' })])).toContain('chat "Other chat", turn 1')
  })
})

describe('recall: store index and search', () => {
  it('finds a turn by keyword, with stemming, and scopes by chat and folder', () => {
    store.createSession(row('a')); store.createSession(row('b')); store.createSession(row('c', { cwd: '/other' }))
    store.saveMessages('a', [...turn('Pick the retry threshold for job 552', 'We chose 7 attempts.'), ...turn('Now plot weekly sales', 'Done.')])
    store.saveMessages('b', turn('Summarise the vendor meeting', 'The vendor agreed to new thresholds in March.'))
    store.saveMessages('c', turn('Threshold tuning for the alert job', 'Set to 40.'))
    for (const id of ['a', 'b', 'c']) index.indexSession(id)
    expect(index.search('thresholds', 'session', 'a').map((h) => [h.sessionId, h.turn])).toEqual([['a', 0]])
    expect(index.search('threshold', 'folder', 'a').map((h) => h.sessionId).sort()).toEqual(['a', 'b'])
    expect(index.search('threshold', 'all', 'a').map((h) => h.sessionId).sort()).toEqual(['a', 'b', 'c'])
    expect(index.search('threshold', 'all', 'a').find((h) => h.sessionId === 'a')!.current).toBe(true)
    expect(index.search('the and of', 'all', 'a')).toEqual([])
    expect(index.search('"quoted" (threshold) AND -x:*', 'all', 'a').length).toBe(3)
  })
  it('searches a chat picked by name, in any folder, and says so when no chat has that name', async () => {
    store.createSession(row('a')); store.createSession(row('v', { title: 'desktop - Vertex Model', cwd: '/other' })); store.createSession(row('x', { title: 'Pricing review', cwd: '/other' }))
    store.saveMessages('v', turn('Which credentials for the provider?', 'Use the service account file.'))
    store.saveMessages('x', turn('Provider credentials for pricing', 'Use the vault.'))
    for (const id of ['v', 'x']) index.indexSession(id)
    expect(index.sessionsNamed('vertex model').map((r) => r.id)).toEqual(['v'])
    const search = (q: string, scope: any, limit: number, chat?: string) => {
      if (!chat) return index.search(q, scope, 'a', limit)
      const named = index.sessionsNamed(chat)
      return named.length ? index.search(q, scope, 'a', limit, named.map((r) => r.id)) : `No chat is named "${chat}".`
    }
    const tool = recallTool(search)
    expect(await tool.run({ query: 'credentials' }, {} as any)).toContain('No earlier turns')
    const out = await tool.run({ query: 'credentials', chat: 'Vertex Model' }, {} as any)
    expect(out).toContain('service account file'); expect(out).not.toContain('vault')
    expect(await tool.run({ query: 'credentials', chat: 'nope' }, {} as any)).toBe('No chat is named "nope".')
    expect(await tool.run({ query: 'zebra', chat: 'Vertex' }, {} as any)).toContain('No turns in chats named "Vertex"')
  })
  it('keeps compacted turns searchable under their original turn number', () => {
    store.createSession(row('a'))
    const hist = [...turn('Decide the cutoff: use 17 days', 'Cutoff set to 17 days.'), ...turn('Build the chart', 'Built.'), ...turn('Export it', 'Exported.')]
    store.saveMessages('a', hist); index.indexSession('a')
    const next = applyCompaction(hist, 'They set a cutoff and built a chart.', [2], 2)
    index.setTurnMap('a', [2]); store.saveMessages('a', next)
    store.saveMessages('a', [...next, ...turn('Add a legend', 'Legend added.')])
    expect(index.indexSession('a')).toBe(1)
    expect(index.search('cutoff days', 'session', 'a')[0]).toMatchObject({ turn: 0, answer: 'Cutoff set to 17 days.' })
    expect(index.search('legend', 'session', 'a')[0].turn).toBe(3)
    expect(index.search('summary compacted', 'session', 'a')).toEqual([])
  })
  it('re-indexing an unchanged chat writes nothing; a changed answer replaces the row', () => {
    store.createSession(row('a'))
    store.saveMessages('a', turn('Find zebra counts', 'Working'))
    expect(index.indexSession('a')).toBe(1)
    expect(index.indexSession('a')).toBe(0)
    store.saveMessages('a', turn('Find zebra counts', 'There are 12 zebras.'))
    expect(index.indexSession('a')).toBe(1)
    expect(index.search('zebra', 'session', 'a')).toHaveLength(1)
    expect(index.search('working', 'session', 'a')).toHaveLength(0)
  })
  it('lists unindexed chats, backfills them, and drops a deleted chat', async () => {
    store.createSession(row('a')); store.createSession(row('b')); store.createSession(row('empty'))
    store.saveMessages('a', [...turn('alpha topic', 'one'), ...turn('beta topic', 'two')])
    store.saveMessages('b', turn('alpha again', 'three'))
    expect(index.unindexed().map((r) => r.id).sort()).toEqual(['a', 'b'])
    const mem = new ContextMemory({ store })
    expect(await mem.backfill()).toBe(2)
    expect(index.unindexed()).toEqual([])
    expect(index.search('alpha', 'all', 'b').map((h) => h.sessionId).sort()).toEqual(['a', 'b'])
    store.deleteSession('a')
    expect(index.search('alpha', 'all', 'b').map((h) => h.sessionId)).toEqual(['b'])
    expect(index.prune()).toBe(2)
    index.forget('b')
    expect(index.search('alpha', 'all', 'b')).toEqual([])
  })
  it('memory search: a chat name leaves out the current chat, an unknown name lists recent chats, and hints skip weak matches', () => {
    store.createSession(row('a', { title: 'Vertex setup' })); store.createSession(row('v', { title: 'desktop - Vertex Model', cwd: '/other' }))
    store.saveMessages('a', turn('Which provider credentials?', 'Use the vault.'))
    store.saveMessages('v', turn('Which credentials for the provider?', 'Use the service account file.'))
    let on = true
    const mem = new ContextMemory({ store, hints: () => on })
    expect((mem.search('a', 'credentials', 'session', 5, 0, 'vertex') as RecallHit[]).map((h) => h.sessionId)).toEqual(['v'])
    expect((mem.search('a', 'credentials', 'session', 5) as RecallHit[])[0]).toMatchObject({ sessionId: 'a', inContext: true })
    expect(mem.search('a', 'credentials', 'session', 5, 1)).toEqual([])
    expect(mem.search('a', 'credentials', 'all', 5, 0, 'nope')).toContain('No chat is named "nope". Recent chats: ')
    store.createSession(row('c')); store.saveMessages('c', turn('unrelated', 'x'))
    const near = mem.hints('c', 'which provider credentials do we use')
    expect(near).toContain('chat "Vertex setup", turn 1')
    expect(near).not.toContain('desktop - Vertex Model')
    store.updateSession('v', { cwd: '/w' })
    expect(mem.hints('c', 'which provider credentials do we use')).toContain('chat "desktop - Vertex Model", turn 1')
    expect(mem.hints('c', 'draft an email about the holiday schedule')).toBe('')
    on = false
    expect(mem.hints('c', 'which provider credentials do we use')).toBe('')
  })
})

describe('recall: compaction note and tool', () => {
  it('the summary message notes removed turns; the note is not merged into the next summary', () => {
    const hist = [...turn('one', 'a'), ...turn('two', 'b'), ...turn('three', 'c')]
    const next = applyCompaction(hist, 'SUMMARY', [2], 2)
    expect(next[0].content as string).toContain('2 earlier turns were removed')
    expect(priorSummary(next)).toBe('Summary of the earlier conversation (older turns were compacted):\n\nSUMMARY')
    expect(removedCount(next)).toBe(2)
    expect(removedCount(applyCompaction(hist, 'SUMMARY', [2]))).toBe(0)
    expect(splitHistoryTurns(next)).toHaveLength(1)
  })
  it('the tool validates input, defaults to this chat and formats results', async () => {
    const calls: unknown[] = []
    const t = recallTool((q, scope, limit) => { calls.push([q, scope, limit]); return [hit({ inContext: false }), hit({ turn: 5, inContext: true })] })
    expect(t.permission).toBeUndefined()
    expect(await t.run({ query: ' a ' }, {} as any)).toContain('at least one keyword')
    const out = await t.run({ query: 'retry threshold', limit: 99 }, {} as any)
    expect(calls).toEqual([['retry threshold', 'session', 10]])
    expect(out).toContain('ASSISTANT: We chose 7 attempts.')
    expect(out).toContain('turn 6 (still in the conversation above)')
    expect(formatResults('x', [])).toContain('No earlier turns match')
    expect(ftsQuery('job-552 "x" OR')).toBe('"job" OR "552"')
  })
})
