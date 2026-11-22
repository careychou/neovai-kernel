import fs from 'node:fs'
import path from 'node:path'

export interface GuardOptions {
  /** Paths relative to the root that may be read but never written. */
  readOnly?: string[]
  /** When set, only these paths (relative to the root) may be written; everything else is read-only. */
  writable?: string[]
}

export interface Guard {
  root: string
  /** Returns the real absolute path, or throws when it is outside the root (or read-only and `write` is set). */
  check(p: string, write?: boolean): string
}

/** Real path of `p`, following symlinks in the part of it that already exists. */
function real(p: string): string {
  const rest: string[] = []
  let cur = path.resolve(p)
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest) } catch { /* not there yet */ }
    const up = path.dirname(cur)
    if (up === cur) return path.join(cur, ...rest)
    rest.unshift(path.basename(cur))
    cur = up
  }
}

const inside = (root: string, p: string) => p === root || p.startsWith(root + path.sep)

export function makeGuard(root: string, opts: GuardOptions = {}): Guard {
  const base = real(root)
  const locked = (opts.readOnly ?? []).map((r) => real(path.join(base, r)))
  const open = opts.writable?.map((r) => real(path.join(base, r)))
  return {
    root: base,
    check(p, write = false) {
      const abs = real(path.isAbsolute(p) ? p : path.join(base, p))
      if (!inside(base, abs)) throw new Error(`${p} is outside the workspace`)
      if (write && locked.some((l) => inside(l, abs))) throw new Error(`${p} is read-only`)
      if (write && open && !open.some((w) => inside(w, abs))) throw new Error(`${p} is read-only`)
      return abs
    }
  }
}
