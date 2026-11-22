import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MessageList, ToolBody, stepInput } from './react'

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
})
