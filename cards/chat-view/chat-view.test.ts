import { describe, expect, it } from 'vitest'
import type { AgentEvent, Message } from '../agent-loop/types'
import { applyEvent, fromMessages, groupRows, groupState, peek, prettyArgs, summarize, toolLabel, type Item, type ToolItem } from './index'

const call = (id: string, name: string, args: object) =>
  ({ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } })

const run = (events: object[], start: Item[] = [{ kind: 'user', text: 'q' }]) =>
  events.reduce<Item[]>((s, e) => applyEvent(s, { agentId: 'm', ...e } as AgentEvent), start)

describe('fromMessages', () => {
  it('rebuilds a saved chat: no system message, reasoning kept, tool results paired with their calls', () => {
    const saved: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:x' } }] },
      { role: 'assistant', content: null, reasoning: 'Look first.', tool_calls: [call('a', 'read_file', { path: 'x.ts' }), call('b', 'shell', { command: 'ls' })] },
      { role: 'tool', tool_call_id: 'b', content: 'Error: boom' },
      { role: 'tool', tool_call_id: 'a', content: 'body' },
      { role: 'assistant', content: 'done', tool_calls: [call('c', 'grep', { pattern: 'x' })] }
    ]
    expect(fromMessages(saved)).toEqual([
      { kind: 'user', text: 'hi\n[image]' },
      { kind: 'reasoning', text: 'Look first.' },
      { kind: 'tool', callId: 'a', name: 'read_file', args: '{"path":"x.ts"}', output: 'body', ok: true },
      { kind: 'tool', callId: 'b', name: 'shell', args: '{"command":"ls"}', output: 'Error: boom', ok: false },
      { kind: 'assistant', text: 'done' },
      { kind: 'tool', callId: 'c', name: 'grep', args: '{"pattern":"x"}', output: 'No result was saved.', ok: false }
    ])
  })
})

describe('applyEvent', () => {
  it('joins streamed text, and starts a new bubble after a tool call', () => {
    expect(run([
      { kind: 'text', text: 'Hel' }, { kind: 'text', text: 'lo' },
      { kind: 'assistant_done', message: { role: 'assistant', content: 'Hello' } },
      { kind: 'tool_start', callId: 'a', name: 'shell', args: '{"command":"pwd"}' },
      { kind: 'tool_end', callId: 'a', name: 'shell', output: '/w', ok: true },
      { kind: 'text', text: 'Bye' }
    ])).toEqual([
      { kind: 'user', text: 'q' },
      { kind: 'assistant', text: 'Hello' },
      { kind: 'tool', callId: 'a', name: 'shell', args: '{"command":"pwd"}', output: '/w', ok: true },
      { kind: 'assistant', text: 'Bye', live: true }
    ])
  })

  it('streams reasoning live, and ends it once text or a tool call follows', () => {
    const thinking = run([{ kind: 'reasoning', text: 'Let me ' }, { kind: 'reasoning', text: 'check.' }])
    expect(thinking.at(-1)).toEqual({ kind: 'reasoning', text: 'Let me check.', live: true })
    expect(run([{ kind: 'text', text: 'Ok' }], thinking).slice(1)).toEqual([
      { kind: 'reasoning', text: 'Let me check.' },
      { kind: 'assistant', text: 'Ok', live: true }
    ])
    expect(run([{ kind: 'tool_start', callId: 't', name: 'glob', args: '{}' }], thinking)[1]).toEqual({ kind: 'reasoning', text: 'Let me check.' })
  })

  it('settles everything when the agent ends, shows errors, and ignores events it does not draw', () => {
    expect(run([{ kind: 'reasoning', text: 'x' }, { kind: 'agent_end', status: 'cancelled', finalText: '' }]).at(-1))
      .toEqual({ kind: 'reasoning', text: 'x' })
    const before: Item[] = [{ kind: 'user', text: 'q' }]
    expect(applyEvent(before, { kind: 'usage', agentId: 'm', prompt: 1, completion: 1 } as AgentEvent)).toBe(before)
    expect(run([{ kind: 'error', message: 'no key' }]).at(-1)).toEqual({ kind: 'error', text: 'no key' })
  })
})

describe('groupRows', () => {
  const tool = (id: string, ok?: boolean): ToolItem => ({ kind: 'tool', callId: id, name: 'read_file', args: `{"path":"${id}"}`, ok })
  it('folds runs of two or more tool calls, and leaves a lone call alone', () => {
    const rows = groupRows([{ kind: 'user', text: 'q' }, tool('a', true), { kind: 'assistant', text: 'x' }, tool('b', true), tool('c', false), tool('d')])
    expect(rows.map((r) => r.kind)).toEqual(['user', 'tool', 'assistant', 'tools'])
    const g = rows[3] as { kind: 'tools'; items: ToolItem[] }
    expect(g.items.map((t) => t.callId)).toEqual(['b', 'c', 'd'])
    expect(groupState(g.items)).toEqual({ running: true, failed: 1, lead: g.items[2] })
    expect(groupState(g.items.slice(0, 2)).lead.callId).toBe('b')
  })
})

describe('labels', () => {
  it('picks the most useful argument and survives bad JSON', () => {
    expect(summarize('shell', '{"command":"npm test","description":"x"}')).toBe('npm test')
    expect(summarize('write_file', '{"path":"a.ts","content":"…"}')).toBe('a.ts')
    expect(summarize('web_fetch', '{"url":"https://example.com"}')).toBe('https://example.com')
    expect(summarize('skill', '{"name":"market-scan"}')).toBe('market-scan')
    expect(summarize('shell', '{"comm')).toBe('')
    expect(toolLabel({ name: 'grep', args: '{"pattern":"foo"}' })).toBe('grep foo')
    expect(toolLabel({ name: 'list', args: '{}' })).toBe('list')
    expect(prettyArgs('{"a":1}')).toBe('{\n  "a": 1\n}')
    expect(prettyArgs('{bad')).toBe('{bad')
  })
  it('peeks at the first line of a thought without markdown marks', () => {
    expect(peek('  **Plan** the # scan\nsecond')).toBe('Plan the  scan')
    expect(peek('x'.repeat(200))).toHaveLength(90)
  })
})
