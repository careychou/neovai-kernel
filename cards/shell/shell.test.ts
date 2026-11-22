import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { shell, ShellManager, readShell, writeShell, stopShell, listShells } from './index'
import { toolLimits } from '../agent-loop/tool-limits'
import type { ToolContext } from '../agent-loop/tool'

let ctx: ToolContext
beforeAll(() => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-'))
  fs.writeFileSync(`${cwd}/x.py`, 'print("hi")\n')
  ctx = { cwd, agentId: 'a', depth: 0, signal: new AbortController().signal, services: {} } as any
})

describe('shell', () => {
  it('runs code and reports exit code', async () => {
    const r = await shell.run({ command: 'python3 x.py; exit 3' }, ctx)
    expect(r).toContain('hi')
    expect(r).toContain('<exit code 3>')
  })
  it('times out', async () => {
    const r = await shell.run({ command: 'sleep 5', timeout: 1 }, ctx)
    expect(r).toContain('timed out after 1s')
  })
  it('truncates long output keeping the tail', async () => {
    const r = await shell.run({ command: `python3 -c "print('x'*${toolLimits.shellOutputChars * 2}); print('END')"` }, ctx)
    expect(r).toContain('truncated')
    expect(r).toContain('END')
    expect(r.length).toBeLessThan(toolLimits.shellOutputChars + 200)
  })
  it('aborts', async () => {
    const ac = new AbortController()
    const p = shell.run({ command: 'sleep 10' }, { ...ctx, signal: ac.signal })
    setTimeout(() => ac.abort(), 200)
    const t = Date.now()
    await p
    expect(Date.now() - t).toBeLessThan(4000)
  })
})

describe('async shells', () => {
  it('starts, reads, writes and stops a background shell', async () => {
    const shells = new ShellManager()
    const c = { ...ctx, services: { shells } }
    const first = await shell.run({ command: 'echo ready; while read l; do echo "got $l"; done', description: 'Echo loop', mode: 'async', initial_wait: 1 }, c)
    expect(first).toContain('shellId: shell-1')
    expect(first).toContain('ready')
    expect(first).toContain('still running')
    expect(await writeShell.run({ shellId: 'shell-1', input: 'ping\n', delay: 1 }, c)).toContain('got ping')
    expect(await listShells.run({}, c)).toContain('running  Echo loop')
    await stopShell.run({ shellId: 'shell-1' }, c)
    expect(await readShell.run({ shellId: 'shell-1', delay: 3 }, c)).toMatch(/exited/)
    shells.dispose()
  })
  it('refuses async mode without a shell manager', async () => {
    await expect((async () => shell.run({ command: 'echo hi', description: 'x', mode: 'async' }, ctx))()).rejects.toThrow(/async shells are not available/)
  })
})
