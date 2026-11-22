import { REGISTRY, type CardInfo } from './cards/registry'

export type { CardInfo } from './cards/registry'
export { REGISTRY } from './cards/registry'

export interface Composition {
  cards: CardInfo[]
  has(name: string): boolean
}

/**
 * Checks an app's card list: every name must exist and every card's dependencies must be listed too.
 * The app still imports each card from `neovai-kernel/cards/<name>`; this is the guard that the set is complete.
 */
export function compose(names: string[]): Composition {
  const picked = new Set(names)
  const cards = names.map((n) => {
    const c = REGISTRY.find((r) => r.name === n)
    if (!c) throw new Error(`unknown card "${n}"`)
    return c
  })
  for (const c of cards) for (const d of c.dependencies) if (!picked.has(d)) throw new Error(`${c.name} needs ${d}`)
  return { cards, has: (n) => picked.has(n) }
}
