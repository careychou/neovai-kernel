import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSettings, DEFAULT_SETTINGS, type SecretBox } from './index'

const fakeBox = (key = 'k1', on = true): SecretBox => ({
  available: () => on,
  seal: (p) => Buffer.from(`${key}|${p}`).toString('base64'),
  open: (s) => {
    const [k, ...rest] = Buffer.from(s, 'base64').toString().split('|')
    if (k !== key) throw new Error('cannot decrypt')
    return rest.join('|')
  }
})

let dir: string
const file = () => path.join(dir, 'settings.json')
const raw = () => JSON.parse(fs.readFileSync(file(), 'utf8'))
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-')) })

describe('settings', () => {
  it('returns the defaults when no file exists', () => {
    const s = createSettings({ dir, box: fakeBox() }).load()
    expect(s.providers).toHaveLength(1)
    expect(s.maxTurnsMain).toBe(DEFAULT_SETTINGS.maxTurnsMain)
  })
  it('merges app defaults over the kernel defaults', () => {
    const s = createSettings({ dir, box: fakeBox(), defaults: { ...DEFAULT_SETTINGS, maxTurnsMain: 7, runAt: '08:30' } }).load()
    expect(s.maxTurnsMain).toBe(7)
    expect(s.runAt).toBe('08:30')
  })
  it('round-trips an API key without writing it in plain text', () => {
    const st = createSettings({ dir, box: fakeBox() })
    const s = st.load()
    s.providers[0].apiKey = 'sk-secret'
    s.defaultModel = 'gpt-x'
    st.save(s)
    expect(fs.readFileSync(file(), 'utf8')).not.toContain('sk-secret')
    expect(raw().providers[0].apiKeyEnc).toBeTruthy()
    const again = createSettings({ dir, box: fakeBox() }).load()
    expect(again.providers[0].apiKey).toBe('sk-secret')
    expect(again.defaultModel).toBe('gpt-x')
  })
  it('stores the key in plain text only when the box is unavailable', () => {
    const st = createSettings({ dir, box: fakeBox('k1', false) })
    const s = st.load()
    s.providers[0].apiKey = 'sk-plain'
    st.save(s)
    expect(raw().providers[0].apiKey).toBe('sk-plain')
    expect(st.load().providers[0].apiKey).toBe('sk-plain')
  })
  it('keeps a secret it could not open instead of erasing it', () => {
    const a = createSettings({ dir, box: fakeBox('k1') })
    const s = a.load()
    s.providers[0].apiKey = 'sk-secret'
    a.save(s)
    const sealed = raw().providers[0].apiKeyEnc
    const b = createSettings({ dir, box: fakeBox('other') })
    const loaded = b.load()
    expect(loaded.providers[0].apiKey).toBe('')
    b.save({ ...loaded, defaultModel: 'changed' })
    expect(raw().providers[0].apiKeyEnc).toBe(sealed)
    expect(createSettings({ dir, box: fakeBox('k1') }).load().providers[0].apiKey).toBe('sk-secret')
  })
  it('lets a newly typed key replace an unreadable one', () => {
    const a = createSettings({ dir, box: fakeBox('k1') })
    const s = a.load(); s.providers[0].apiKey = 'old'; a.save(s)
    const b = createSettings({ dir, box: fakeBox('other') })
    const l = b.load(); l.providers[0].apiKey = 'new'; b.save(l)
    expect(b.load().providers[0].apiKey).toBe('new')
  })
  it('survives a corrupt file', () => {
    fs.writeFileSync(file(), '{not json')
    expect(createSettings({ dir, box: fakeBox() }).load().providers).toHaveLength(1)
  })
})
