import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MessageList } from './react'

const t = { kind: 'tool', callId: 'c1', name: 'read_file', args: '{"path":"a.txt","intent":"Read the notes"}', ok: true, output: 'secret' } as any

describe('plain tool rows', () => {
  it('a plain step is one level: no expander, no technical details', () => {
    const html = renderToStaticMarkup(createElement(MessageList, { items: [t] }))
    expect(html).toContain('Read the notes')
    expect(html).not.toContain('<button')
    expect(html).not.toMatch(/technical details|read_file/i)
  })
  it('technical mode keeps an expandable raw row', () => {
    const html = renderToStaticMarkup(createElement(MessageList, { items: [t], technical: true }))
    expect(html).toContain('read_file')
    expect(html).toContain('aria-expanded')
  })
})
