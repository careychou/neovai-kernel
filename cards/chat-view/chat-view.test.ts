import { describe, expect, it } from 'vitest'
import type { AgentEvent, Message } from '../agent-loop/types'
import { applyEvent, fromMessages, groupRows, groupState, peek, prettyArgs, summarize, technicalLabel, toolLabel, type Item, type ToolItem } from './index'

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
      { kind: 'user', text: 'hi', images: ['data:x'] },
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
    expect(technicalLabel({ name: 'grep', args: '{"pattern":"foo"}' })).toBe('grep foo')
    expect(technicalLabel({ name: 'list', args: '{}' })).toBe('list')
    expect(prettyArgs('{"a":1}')).toBe('{\n  "a": 1\n}')
    expect(prettyArgs('{bad')).toBe('{bad')
  })
  it('labels tool rows in plain words, never the raw command', () => {
    expect(toolLabel({ name: 'shell', args: '{"command":"python3 - <<EOF","intent":"Update the  Recommendations screen"}' })).toBe('Update the Recommendations screen')
    expect(toolLabel({ name: 'shell', args: '{"command":"npm test","description":"Run unit tests"}' })).toBe('Run unit tests')
    expect(toolLabel({ name: 'shell', args: '{"command":"rm -rf x"}' })).toBe('Run a step')
    expect(toolLabel({ name: 'skill', args: '{"name":"market-scan"}' })).toBe('Use the market-scan skill')
    expect(toolLabel({ name: 'check_ui', args: '{bad' })).toBe('Check ui')
  })
  it('peeks at the first line of a thought without markdown marks', () => {
    expect(peek('  **Plan** the # scan\nsecond')).toBe('Plan the  scan')
    expect(peek('x'.repeat(200))).toHaveLength(90)
  })
})

import { buildUserContent } from '../agent-loop/content'
import { classify, clipText, fitSize, userView } from './index'

describe('attachments', () => {
  it('classifies images and text files, and refuses the rest', () => {
    expect(classify('shot.PNG')).toBe('image')
    expect(classify('', 'image/jpeg')).toBe('image')
    expect(classify('logo.svg', 'image/svg+xml')).toBe('text')
    expect(classify('notes.md')).toBe('text')
    expect(classify('data.bin', 'application/json')).toBe('text')
    expect(classify('report.pdf', 'application/pdf')).toBe(null)
  })

  it('fits large images in the box without upscaling small ones', () => {
    expect(fitSize(3136, 1568)).toEqual({ width: 1568, height: 784 })
    expect(fitSize(400, 300)).toEqual({ width: 400, height: 300 })
  })

  it('cuts long text with a note', () => {
    expect(clipText('abcdef', 3)).toEqual({ text: 'abc', note: 'cut to the first 3 of 6 characters' })
    expect(clipText('ab', 3)).toEqual({ text: 'ab' })
  })

  it('rebuilds what the user sent from saved content', () => {
    const content = buildUserContent('Make it look like this', [
      { kind: 'text', name: 'spec "v2".md', text: 'body' },
      { kind: 'image', name: 'a.png', dataUrl: 'data:image/png;base64,AA', width: 10, height: 20 }
    ])
    expect(userView(content)).toEqual({ text: 'Make it look like this', images: ['data:image/png;base64,AA'], files: ['spec "v2".md'] })
    expect(userView(buildUserContent('', [{ kind: 'image', name: 'a.png', dataUrl: 'data:x', width: 1, height: 1 }]))).toEqual({ text: '', images: ['data:x'], files: [] })
    expect(fromMessages([{ role: 'user', content }])[0]).toEqual({ kind: 'user', text: 'Make it look like this', images: ['data:image/png;base64,AA'], files: ['spec "v2".md'] })
  })
})

describe('sub-agents in the chat', () => {
  const ev = (agentId: string, e: object) => ({ agentId, ...e })
  const flow = (end: 'completed' | 'cancelled' = 'completed') => [
    ev('main', { kind: 'tool_start', callId: 't1', name: 'task', args: '{"description":"Check prices","prompt":"p"}' }),
    ev('main', { kind: 'tool_start', callId: 't2', name: 'task', args: '{"description":"Read news","prompt":"q"}' }),
    ev('a1', { kind: 'agent_start', parentId: 'main', callId: 't1', name: 'general-purpose', mode: 'sync', prompt: 'p' }),
    ev('a2', { kind: 'agent_start', parentId: 'main', callId: 't2', name: 'general-purpose', mode: 'sync', prompt: 'q' }),
    ev('a1', { kind: 'tool_start', callId: 'x1', name: 'web_fetch', args: '{}' }),
    ev('a2', { kind: 'text', text: 'news ' }),
    ev('a1', { kind: 'tool_end', callId: 'x1', name: 'web_fetch', output: 'ok', ok: true }),
    ev('a2', { kind: 'text', text: 'done' }),
    ev('a3', { kind: 'agent_start', parentId: 'a1', callId: 'x2', name: 'general-purpose', mode: 'sync', prompt: 'r' }),
    ev('a1', { kind: 'agent_end', status: end, finalText: '' }),
    ev('a2', { kind: 'agent_end', status: 'completed', finalText: 'news done' })
  ]

  it('draws each sub-agent under the task step that started it, even when they run at the same time', () => {
    const items = flow().reduce<Item[]>((s, e) => applyEvent(s, e as AgentEvent), [])
    expect(items.map((i) => i.kind)).toEqual(['tool', 'tool'])
    const [t1, t2] = items as ToolItem[]
    expect(t1.agent).toMatchObject({ id: 'a1', status: 'completed' })
    expect(t1.agent!.items).toEqual([{ kind: 'tool', callId: 'x1', name: 'web_fetch', args: '{}', output: 'ok', ok: true }])
    expect(t2.agent!.items).toEqual([{ kind: 'assistant', text: 'news done' }])
    expect(groupState(items as ToolItem[]).running).toBe(true)
  })

  it('a stopped sub-agent marks its step as failed once its tool returns', () => {
    const items = [...flow('cancelled'), ev('main', { kind: 'tool_end', callId: 't1', name: 'task', output: 'Sub-agent cancelled: cancelled', ok: true }), ev('main', { kind: 'tool_end', callId: 't2', name: 'task', output: 'news done', ok: true })]
      .reduce<Item[]>((s, e) => applyEvent(s, e as AgentEvent), [])
    expect(groupState(items as ToolItem[])).toMatchObject({ running: false, failed: 1 })
  })
})

