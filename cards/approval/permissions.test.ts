import { describe, it, expect } from 'vitest'
import { PermissionGate } from './index'
import type { Hooks, PermissionDecision } from '../agent-loop/types'

function hooks(answers: PermissionDecision[]) {
  const asked: string[] = []
  const h: Hooks = {
    onEvent() {},
    async requestPermission(r) { asked.push(`${r.kind}:${r.detail}`); return answers.shift() ?? 'deny' },
    async askUser() { return '' }
  }
  return { h, asked }
}

describe('PermissionGate', () => {
  it('asks each time for a plain allow and refuses on deny', async () => {
    const { h, asked } = hooks(['allow', 'deny'])
    const g = new PermissionGate(h)
    expect(await g.check('main', 'shell', 'ls')).toBe(true)
    expect(await g.check('main', 'shell', 'rm x')).toBe(false)
    expect(asked).toEqual(['shell:ls', 'shell:rm x'])
  })
  it('remembers allow-for-session per kind only', async () => {
    const { h, asked } = hooks(['allow_session', 'deny'])
    const g = new PermissionGate(h)
    expect(await g.check('main', 'shell', 'a')).toBe(true)
    expect(await g.check('main', 'shell', 'b')).toBe(true)
    expect(await g.check('main', 'write', 'f')).toBe(false)
    expect(asked).toEqual(['shell:a', 'write:f'])
  })
  it('auto-approve never asks, and can be switched off', async () => {
    const { h, asked } = hooks(['deny'])
    const g = new PermissionGate(h, true)
    expect(await g.check('main', 'url', 'https://e.com')).toBe(true)
    expect(asked).toEqual([])
    g.setAutoApprove(false)
    expect(g.isAutoApprove).toBe(false)
    expect(await g.check('main', 'url', 'https://e.com')).toBe(false)
  })
})
