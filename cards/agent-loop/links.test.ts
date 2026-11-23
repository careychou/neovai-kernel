import { describe, it, expect } from 'vitest'
import { linkMarkdown, linkSegments } from './links'

const jira = { pattern: /\b[A-Z][A-Z0-9]+-\d+\b/, href: (k: string) => `https://tracker.example/browse/${k}` }

describe('links', () => {
  it('links bare URLs without trailing punctuation', () => {
    expect(linkSegments('see https://a.example/x?y=1.')).toEqual([
      { text: 'see ' }, { text: 'https://a.example/x?y=1', href: 'https://a.example/x?y=1', title: 'https://a.example/x?y=1' }, { text: '.' }
    ])
  })
  it('applies app rules, and a URL containing a match stays one link', () => {
    const s = linkSegments('ABC-12 and https://t.example/ABC-34', [jira])
    expect(s.filter((p) => p.href).map((p) => p.href)).toEqual(['https://tracker.example/browse/ABC-12', 'https://t.example/ABC-34'])
  })
  it('plain text passes through', () => {
    expect(linkSegments('nothing here', [jira])).toEqual([{ text: 'nothing here' }])
  })
  it('markdown: rules become links, but code, links and URLs are left alone', () => {
    const md = 'Fix ABC-1, `ABC-2`, [ABC-3](https://x.example) https://y.example/ABC-4'
    expect(linkMarkdown(md, [jira])).toBe('Fix [ABC-1](https://tracker.example/browse/ABC-1), `ABC-2`, [ABC-3](https://x.example) https://y.example/ABC-4')
    expect(linkMarkdown(md)).toBe(md)
  })
})
