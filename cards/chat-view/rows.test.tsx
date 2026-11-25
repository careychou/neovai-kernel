import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Composer, MessageList, QueueChips, SubAgentBody, ToolBody, queuedLabel, stepInput } from './react'

const t = { kind: 'tool', callId: 'c1', name: 'read_file', args: '{"path":"a.txt","intent":"Read the notes"}', ok: true, output: 'hello\n' } as any

describe('tool rows', () => {
  it('a step reads in plain words and opens to its details', () => {
    const html = renderToStaticMarkup(createElement(MessageList, { items: [t] }))
    expect(html).toContain('Read the notes')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('read_file')
  })
  it('technical mode labels the step with the raw tool name', () => {
    expect(renderToStaticMarkup(createElement(MessageList, { items: [t], technical: true }))).toContain('read_file')
  })
  it('the third level shows the input without the intent, then the output', () => {
    const html = renderToStaticMarkup(createElement(ToolBody, { t }))
    expect(html).toContain('path: a.txt')
    expect(html).toContain('hello')
    expect(html).not.toContain('Read the notes')
  })
  it('shell commands read as $ command; empty or running steps say so', () => {
    expect(stepInput('{"command":"ls -la","intent":"x"}')).toBe('$ ls -la')
    expect(stepInput('{"intent":"x"}')).toBe('')
    expect(stepInput('{"a":1,"b":2}')).toContain('"a": 1')
    expect(renderToStaticMarkup(createElement(ToolBody, { t: { ...t, output: undefined, ok: undefined } }))).toContain('Running')
  })
  it('a task step opens to its sub-agent\'s own steps and answer', () => {
    const task = { kind: 'tool', callId: 't', name: 'task', args: '{"description":"Check prices","prompt":"p"}', agent: { id: 'a', name: 'general-purpose', mode: 'background', status: 'running', items: [t, { kind: 'assistant', text: 'AAPL is up' }] } } as any
    const row = renderToStaticMarkup(createElement(MessageList, { items: [task] }))
    expect(row).toContain('Check prices')
    expect(row).toContain('in the background')
    expect(row).toContain('cv-spin')
    const body = renderToStaticMarkup(createElement(SubAgentBody, { t: task }))
    expect(body).toContain('Read the notes')
    expect(body).toContain('AAPL is up')
  })

  it('shows a publish button next to attach only when the app gives onPublish', () => {
    const base = { value: '', onChange() {}, onSend() {} }
    expect(renderToStaticMarkup(createElement(Composer, base))).not.toContain('cv-publish')
    const html = renderToStaticMarkup(createElement(Composer, { ...base, onPublish() {} }))
    expect(html.indexOf('Attach files')).toBeLessThan(html.indexOf('cv-publish'))
    expect(renderToStaticMarkup(createElement(Composer, { ...base, onPublish() {}, publishing: true }))).toMatch(/cv-publish busy"[^>]*disabled/)
  })
})

describe('prompt queue', () => {
  const base = { value: 'next thing', onChange() {}, onSend() {} }
  const queue = [{ qid: 'a', text: 'also  check\n2025' }, { qid: 'b', text: '', files: ['plan.pdf'], images: ['data:x', 'data:y'] }]
  it('without a queue the composer only offers Stop while the agent works', () => {
    const html = renderToStaticMarkup(createElement(Composer, { ...base, running: true }))
    expect(html).toContain('>Stop<')
    expect(html).not.toContain('>Queue<')
    expect(html).not.toContain('cv-queue')
  })
  it('with a queue it offers Queue next to Stop and draws the waiting prompts in order', () => {
    const html = renderToStaticMarkup(createElement(Composer, { ...base, running: true, queue, onUnqueue() {} }))
    expect(html.indexOf('>Queue<')).toBeLessThan(html.indexOf('>Stop<'))
    expect(html).not.toMatch(/<button class="primary" disabled/)
    expect(html.indexOf('>Next<')).toBeLessThan(html.indexOf('>+1<'))
    expect(html).toContain('also check 2025')
    expect(html).toContain('plan.pdf, 2 images')
    expect(html).toContain('Remove from the queue')
    expect(html).toContain('It joins at the agent&#x27;s next step.')
  })
  it('an idle composer with queueing on still reads Send, and empty text cannot be queued', () => {
    expect(renderToStaticMarkup(createElement(Composer, { ...base, queue: [] }))).toContain('>Send<')
    expect(renderToStaticMarkup(createElement(Composer, { ...base, value: ' ', running: true, queue: [] }))).toMatch(/<button class="primary" disabled[^>]*>Queue</)
  })
  it('chips draw nothing when the queue is empty and have no × without onUnqueue', () => {
    expect(renderToStaticMarkup(createElement(QueueChips, { queue: [] }))).toBe('')
    expect(renderToStaticMarkup(createElement(QueueChips, { queue }))).not.toContain('<button')
    expect(queuedLabel({ qid: 'x', text: '' })).toBe('Attachment')
  })
})

describe('session list', () => {
  it('shows each session with rename and delete, and an untitled one by its placeholder', async () => {
    const { SessionList } = await import('./react')
    const html = renderToStaticMarkup(createElement(SessionList, { sessions: [{ id: 'a', title: 'Scan tech' }, { id: 'b', title: 'New chat', busy: true }], active: 'a', onSelect: () => {}, onRename: () => {}, onDelete: () => {}, onNew: () => {} }))
    expect(html).toContain('Scan tech')
    expect(html).toContain('New request')
    expect(html).toContain('aria-label="Rename session"')
    expect(html).toContain('cv-session active')
    expect(html).toContain('cv-session busy')
    expect(renderToStaticMarkup(createElement(SessionList, { sessions: [{ id: 'a', title: 'x' }], onSelect: () => {} }))).not.toContain('Rename')
  })
})

describe('links and turns', () => {
  const rule = { pattern: /\bT-\d+\b/, href: (k: string) => `https://t.example/${k}` }
  it('user text links URLs and app rules, and carries its turn for the rail', () => {
    const html = renderToStaticMarkup(createElement(MessageList, { links: [rule], items: [
      { kind: 'user', text: 'look at T-7 and https://a.example' }, { kind: 'assistant', text: 'ok' }, { kind: 'user', text: 'second' }
    ] as any }))
    expect(html).toContain('href="https://t.example/T-7"')
    expect(html).toContain('href="https://a.example"')
    expect(html).toContain('data-turn="2"')
    expect(html).toContain('data-peek="second"')
  })
  it('assistant markdown gets app rules as markdown links', () => {
    const Md = ({ text }: { text: string }) => createElement('pre', null, text)
    const html = renderToStaticMarkup(createElement(MessageList, { links: [rule], Markdown: Md, items: [{ kind: 'assistant', text: 'see T-9' }] as any }))
    expect(html).toContain('[T-9](https://t.example/T-9)')
  })
})
