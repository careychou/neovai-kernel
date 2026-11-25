import { describe, expect, it } from 'vitest'
import type { AgentEvent, Message } from '../agent-loop/types'
import { applyChatEvent, queuedView, restoreDraft, type QueuedPrompt, applyEvent, fromMessages, groupRows, groupState, peek, prettyArgs, summarize, technicalLabel, toolLabel, type Item, type ToolItem } from './index'

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

describe('queued prompts', () => {
  const q1: QueuedPrompt = { qid: 'q1', text: 'also check 2025', files: ['plan.csv'] }
  const q2: QueuedPrompt = { qid: 'q2', text: 'and 2024' }
  const items: Item[] = [{ kind: 'user', text: 'start' }, { kind: 'assistant', text: 'working', live: true }]

  it('moves a prompt into the conversation when the model receives it', () => {
    const s = applyChatEvent({ items, queue: [q1, q2] }, { kind: 'user_input', agentId: 'main', qid: 'q1' })
    expect(s.queue).toEqual([q2])
    expect(s.items).toEqual([{ kind: 'user', text: 'start' }, { kind: 'assistant', text: 'working' }, { kind: 'user', text: 'also check 2025', files: ['plan.csv'] }])
    expect(s.restored).toEqual([])
  })
  it('ignores a prompt it never queued, such as one sent while idle', () => {
    const queue = [q1]
    const s = applyChatEvent({ items, queue }, { kind: 'user_input', agentId: 'main', qid: 'other' })
    expect(s.items).toBe(items)
    expect(s.queue).toBe(queue)
  })
  it('hands back the prompts cleared by a stop or failure', () => {
    const s = applyChatEvent({ items, queue: [q1, q2] }, { kind: 'queue_cleared', agentId: 'main', qids: ['q1', 'q2'] })
    expect(s.queue).toEqual([])
    expect(s.items).toBe(items)
    expect(s.restored).toEqual([q1, q2])
    expect(restoreDraft(' half typed ', s.restored)).toBe('half typed\n\nalso check 2025\n\nand 2024')
    expect(restoreDraft('', [{ qid: 'x', text: '' }])).toBe('')
  })
  it('passes every other event to applyEvent and keeps the queue as it is', () => {
    const queue = [q1]
    const s = applyChatEvent({ items, queue }, { kind: 'text', agentId: 'main', text: '!' })
    expect(s.items.at(-1)).toEqual({ kind: 'assistant', text: 'working!', live: true })
    expect(s.queue).toBe(queue)
    expect(applyChatEvent({ items, queue }, { kind: 'usage', agentId: 'main', prompt: 1, completion: 1 }).items).toBe(items)
  })
  it('redraws the prompts a session still holds', () => {
    const content = buildUserContent('look at this', [{ kind: 'text', name: 'notes.md', text: 'BODY' }])
    expect(queuedView([{ qid: 'q1', content: content as any }, { qid: 'q2', content: 'plain' }])).toEqual([
      { qid: 'q1', text: 'look at this', files: ['notes.md'] }, { qid: 'q2', text: 'plain' }
    ])
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
import { filesAsText, fitRequest, textOf } from '../agent-loop/content'
import { estimateTokens } from '../context-memory/compact'
import { toAnthropic } from '../model-providers/anthropic'
import { responsesBody } from '../model-providers/responses'
import { classify, clipText, fitSize, isScannedPdf, pdfAttachment, userView } from './index'

describe('attachments', () => {
  it('classifies images and text files, and refuses the rest', () => {
    expect(classify('shot.PNG')).toBe('image')
    expect(classify('', 'image/jpeg')).toBe('image')
    expect(classify('logo.svg', 'image/svg+xml')).toBe('text')
    expect(classify('notes.md')).toBe('text')
    expect(classify('data.bin', 'application/json')).toBe('text')
    expect(classify('report.pdf', 'application/pdf')).toBe('pdf')
    expect(classify('archive.zip', 'application/zip')).toBe(null)
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

describe('file on disk and PDFs', () => {
  it('tells the model where the file is, once', () => {
    const c = buildUserContent('read', [
      { kind: 'text', name: 'a.md', text: 'body', note: 'cut', path: '/d/a.md' },
      { kind: 'text', name: 'b.md', text: 'body', note: 'file on disk: /d/b.md', path: '/d/b.md' }
    ]) as string
    expect(c).toContain('<attachment name="a.md" note="cut; file on disk: /d/a.md">')
    expect(c).toContain('<attachment name="b.md" note="file on disk: /d/b.md">')
    const img = buildUserContent('x', [{ kind: 'image', name: 'shot.png', dataUrl: 'data:x', width: 10, height: 10, path: '/d/shot.png' }])
    expect(textOf(img)).toContain('Attached image: shot.png (10×10); file on disk: /d/shot.png')
    expect(userView(img)).toEqual({ text: 'x', images: ['data:x'], files: [] })
  })

  it('sends a scanned PDF as one image per page and shows it as one file', () => {
    const pg = { dataUrl: 'data:p', width: 5, height: 5 }
    const c = buildUserContent('x', [{ kind: 'pages', name: 's.pdf', pages: [pg, pg], total: 9, path: '/d/s.pdf' }, { kind: 'image', name: 'i.png', dataUrl: 'data:i', width: 1, height: 1 }])
    expect(textOf(c)).toBe('x\nAttached scanned PDF: s.pdf (pages 1-2 of 9, one image per page); file on disk: /d/s.pdf\n[image]\n[image]\nAttached image: i.png (1×1)\n[image]')
    expect(userView(c)).toEqual({ text: 'x', images: ['data:i'], files: ['s.pdf'] })
  })

  it('sends a PDF as a file to models that read it and as text to the rest', () => {
    const data = 'B'.repeat(4000)
    const content = buildUserContent('read', [{ kind: 'pdf', name: 'r.pdf', data, text: '--- page 1 ---\nhello', pages: 2, path: '/tmp/r.pdf' }])
    const ms: Message[] = [{ role: 'user', content }]
    const asText = '<attachment name="r.pdf" note="file on disk: /tmp/r.pdf">\n--- page 1 ---\nhello\n</attachment>'
    expect(filesAsText(ms)[0].content).toEqual([{ type: 'text', text: 'read' }, { type: 'text', text: asText }])
    expect((content as any)[1].type).toBe('file')
    expect(userView(content)).toEqual({ text: 'read', images: [], files: ['r.pdf'] })
    expect(estimateTokens(ms)).toBeLessThan(4000)
    expect(JSON.stringify(toAnthropic(ms, { model: 'm' }, '5m'))).toContain('"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"BBBB')
    const wire = JSON.stringify(responsesBody({ model: 'm', messages: ms } as any, ms))
    expect(wire).toContain('--- page 1 ---')
    expect(wire).not.toContain('BBBB')
    // an old or oversized PDF falls back to its text
    const later: Message[] = [...ms, { role: 'assistant', content: 'ok' }, { role: 'user', content: [{ type: 'text', text: 'next' }, { type: 'image_url', image_url: { url: 'data:i' } }] }]
    expect(textOf(fitRequest(later, { maxBytes: 1e9, imageTurns: 1 })[0].content as any)).toBe(`read\n${asText}`)
    expect(JSON.stringify(fitRequest(later, { maxBytes: 1e9, imageTurns: 1 }))).not.toContain('BBBB')
    expect(JSON.stringify(fitRequest(ms, { maxBytes: 2000, imageTurns: 0 }))).not.toContain('BBBB')
    expect(JSON.stringify(fitRequest(ms, { maxBytes: 1e9, imageTurns: 0 }))).toContain('BBBB')
  })

  it('builds the PDF attachment from what the host extracted', () => {
    const text = 'A page of ordinary text, long enough to count.'
    expect(pdfAttachment({ name: 'r.pdf', data: 'QQ', size: 1000, pageTexts: [text, text], path: '/d/r.pdf' }))
      .toEqual({ kind: 'pdf', name: 'r.pdf', data: 'QQ', text: `--- page 1 ---\n${text}\n\n--- page 2 ---\n${text}`, pages: 2, path: '/d/r.pdf' })
    // too large or too long: text only
    expect(pdfAttachment({ name: 'r.pdf', data: 'QQ', size: 9 * 1024 * 1024, pageTexts: [text] })).toEqual({ kind: 'text', name: 'r.pdf', text: `--- page 1 ---\n${text}`, note: '1 page' })
    expect(pdfAttachment({ name: 'r.pdf', data: 'QQ', size: 1000, pageTexts: Array(21).fill(text) })).toMatchObject({ kind: 'text', note: '21 pages' })
    // scanned: the host renders the pages
    expect(isScannedPdf(['', ' 3 '])).toBe(true)
    expect(pdfAttachment({ name: 's.pdf', data: 'QQ', size: 1000, pageTexts: ['', ''] })).toBe(null)
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

