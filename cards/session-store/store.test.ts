import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from './index'
import type { Message } from '../agent-loop/types'

let dir: string, s: Store
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-')); s = new Store(dir) })
afterEach(() => { s.close(); fs.rmSync(dir, { recursive: true, force: true }) })
const row = (id: string, at: number) => ({ id, title: `T-${id}`, cwd: '/w', model: 'm', created_at: at, updated_at: at })

describe('Store', () => {
  it('creates the database file in the given folder', () => {
    expect(fs.existsSync(path.join(dir, 'neovai.db'))).toBe(true)
  })
  it('lists sessions newest first and updates them', () => {
    s.createSession(row('a', 1)); s.createSession(row('b', 2))
    expect(s.listSessions().map((r) => r.id)).toEqual(['b', 'a'])
    s.touchSession('a', 10)
    s.updateSession('a', { title: 'Renamed', reasoning: 'high' })
    expect(s.listSessions().map((r) => r.id)).toEqual(['a', 'b'])
    expect(s.getSession('a')).toMatchObject({ title: 'Renamed', reasoning: 'high', updated_at: 10 })
    expect(s.getSession('zzz')).toBeUndefined()
  })
  it('saves and reloads messages in order, replacing the previous save', () => {
    s.createSession(row('a', 1))
    const msgs: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' }
    ]
    s.saveMessages('a', msgs)
    expect(s.loadMessages('a')).toEqual(msgs)
    s.saveMessages('a', msgs.slice(0, 1))
    expect(s.loadMessages('a')).toEqual(msgs.slice(0, 1))
  })
  it('saves and reloads ui items', () => {
    s.createSession(row('a', 1))
    s.saveUiItems('a', [{ kind: 'user', text: 'hi' }, { kind: 'note', n: 2 }])
    expect(s.loadUiItems('a')).toEqual([{ kind: 'user', text: 'hi' }, { kind: 'note', n: 2 }])
  })
  it('deletes a session with its messages but keeps its usage', () => {
    s.createSession(row('a', 1))
    s.saveMessages('a', [{ role: 'user', content: 'hi' }])
    s.addUsage({ ts: 5, session_id: 'a', agent_id: 'main', model: 'm', prompt: 10, cached: 1, cache_write: 0, completion: 3 })
    expect(s.usageSince(0)[0]).toMatchObject({ title: 'T-a', prompt: 10, completion: 3 })
    s.deleteSession('a')
    expect(s.loadMessages('a')).toEqual([])
    expect(s.usageSince(0)).toHaveLength(1)
    expect(s.usageSince(0)[0].title).toBeNull()
    expect(s.usageSince(6)).toEqual([])
  })
  it('keeps data across reopen', () => {
    s.createSession(row('a', 1)); s.saveMessages('a', [{ role: 'user', content: 'hi' }])
    s.close(); s = new Store(dir)
    expect(s.loadMessages('a')).toEqual([{ role: 'user', content: 'hi' }])
  })
})
