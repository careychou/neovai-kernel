import type { ToolDef } from '../agent-loop/tool'
import { readFile, writeFile, editFile, glob } from './fs-tools'
import { grep } from './grep'
import { makeGuard, type GuardOptions } from './guard'

export { makeGuard, type Guard, type GuardOptions } from './guard'
export { walk } from './fs-tools'

export interface FileToolsOptions extends GuardOptions {
  /** The only folder these tools may touch. */
  root: string
}

/** File tools that refuse any path outside `root`, and any write to a `readOnly` path. */
export function makeFileTools(o: FileToolsOptions): ToolDef[] {
  const guard = makeGuard(o.root, o)
  const wrap = (t: ToolDef, write: boolean, optional = false): ToolDef => ({
    ...t,
    async run(a, ctx) {
      if (a.path == null && !optional) throw new Error('missing required argument "path"')
      const p = guard.check(a.path ?? '.', write)
      return t.run({ ...a, path: p }, { ...ctx, cwd: guard.root })
    }
  })
  return [wrap(readFile, false), wrap(writeFile, true), wrap(editFile, true), wrap(glob, false, true), wrap(grep, false, true)]
}
