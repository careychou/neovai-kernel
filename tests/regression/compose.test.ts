import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { compose, REGISTRY } from '../../compose'

const ALL = ['agent-loop', 'model-providers', 'file-tools', 'shell', 'web-fetch', 'approval', 'session-store', 'settings', 'skills']
const cardsDir = path.join(__dirname, '../../cards')

describe('compose', () => {
  it('composes all the cards together', () => {
    const k = compose(ALL)
    expect(k.cards.map((c) => c.name)).toEqual(ALL)
    expect(k.has('shell')).toBe(true)
    expect(k.has('ledger')).toBe(false)
  })
  it('rejects an unknown card', () => {
    expect(() => compose(['agent-loop', 'nope'])).toThrow('unknown card "nope"')
  })
  it('rejects a card whose dependency was left out', () => {
    expect(() => compose(['shell'])).toThrow('shell needs agent-loop')
    expect(() => compose(['agent-loop', 'settings'])).toThrow('settings needs model-providers')
  })
})

describe('card inventory', () => {
  const folders = fs.readdirSync(cardsDir).filter((f) => fs.statSync(path.join(cardsDir, f)).isDirectory()).sort()
  it('registers every card folder', () => {
    expect(REGISTRY.map((r) => r.name).sort()).toEqual(folders)
  })
  it.each(folders)('%s has an index, a manifest named after its folder, and tests', (name) => {
    const dir = path.join(cardsDir, name)
    expect(fs.existsSync(path.join(dir, 'index.ts'))).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'card.json'), 'utf8')).name).toBe(name)
    expect(fs.readdirSync(dir).some((f) => f.endsWith('.test.ts'))).toBe(true)
  })
  it.each(folders)('%s loads through its index', async (name) => {
    expect(Object.keys(await import(`../../cards/${name}/index.ts`)).length).toBeGreaterThan(0)
  })
})
