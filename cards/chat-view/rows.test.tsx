import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Composer, MessageList, SubAgentBody, ToolBody, stepInput } from './react'

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
