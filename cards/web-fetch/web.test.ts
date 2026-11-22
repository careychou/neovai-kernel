import { describe, it, expect } from 'vitest'
import { htmlToMarkdown, webFetch } from './index'

describe('web_fetch', () => {
  it('converts html to markdown', () => {
    const md = htmlToMarkdown('<html><head><title>T</title><script>x()</script></head><body><h2>Hi &amp; bye</h2><p>See <a href="/a">link</a></p><ul><li>one</li></ul></body></html>', 'https://e.com/x')
    expect(md).toContain('# T')
    expect(md).toContain('## Hi & bye')
    expect(md).toContain('[link](https://e.com/a)')
    expect(md).toContain('- one')
    expect(md).not.toContain('x()')
  })
  it('asks for url permission', () => {
    expect(webFetch.name).toBe('web_fetch')
    expect(webFetch.permission).toBe('url')
  })
})
