import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeFileTools, makeGuard } from './index'
import { toolLimits } from '../agent-loop/tool-limits'
import type { ToolContext, ToolDef } from '../agent-loop/tool'

let root: string, outside: string, ctx: ToolContext
let t: Record<string, ToolDef>
beforeAll(() => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ft-')))
  root = path.join(tmp, 'workspace'); outside = path.join(tmp, 'outside')
  fs.mkdirSync(`${root}/src/a`, { recursive: true }); fs.mkdirSync(outside)
  fs.writeFileSync(`${root}/src/a/x.py`, 'print("hi")\nfoo = 1\n')
  fs.writeFileSync(`${root}/src/y.ts`, 'const foo = 2\n')
  fs.writeFileSync(`${root}/dup.txt`, 'aa bb aa')
  fs.writeFileSync(`${root}/goals.json`, '{"budget":1000}')
  fs.writeFileSync(`${outside}/secret.txt`, 'top secret')
  fs.symlinkSync(outside, `${root}/link`)
  // cwd deliberately points elsewhere: the tools must use the root, not the caller's cwd
  ctx = { cwd: outside, agentId: 'a', depth: 0, signal: new AbortController().signal, services: {} } as any
  t = Object.fromEntries(makeFileTools({ root, readOnly: ['goals.json'] }).map((d) => [d.name, d]))
})

describe('file tools', () => {
  it('offers the five tools', () => {
    expect(Object.keys(t)).toEqual(['read_file', 'write_file', 'edit_file', 'glob', 'grep'])
  })
  it('reads a line range relative to the root', async () => {
    expect(await t.read_file.run({ path: 'src/a/x.py', start: 2, end: 2 }, ctx)).toBe('2. foo = 1')
  })
  it('writes, appends, then edits uniquely', async () => {
    await t.write_file.run({ path: 'new/f.txt', content: 'hello ' }, ctx)
    await t.write_file.run({ path: 'new/f.txt', content: 'world', append: true }, ctx)
    await t.edit_file.run({ path: 'new/f.txt', old_str: 'world', new_str: 'there' }, ctx)
    expect(fs.readFileSync(`${root}/new/f.txt`, 'utf8')).toBe('hello there')
  })
  it('pages a file larger than the read cap by whole lines', async () => {
    const old = toolLimits.readFileChars
    toolLimits.readFileChars = 30
    fs.writeFileSync(`${root}/long.txt`, Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'))
    const r = await t.read_file.run({ path: 'long.txt' }, ctx)
    toolLimits.readFileChars = old
    expect(r).toMatch(/^line 1\n/)
    const next = Number(r.match(/start=(\d+)/)![1])
    expect(r).toContain(`line ${next - 1}\n[...output limit`)
  })
  it('rejects non-unique edits', async () => {
    await expect(t.edit_file.run({ path: 'dup.txt', old_str: 'aa', new_str: 'z' }, ctx)).rejects.toThrow(/not unique/)
  })
  it('globs and greps from the root by default', async () => {
    expect(await t.glob.run({ pattern: '*.py' }, ctx)).toBe('src/a/x.py')
    expect(await t.grep.run({ pattern: 'foo', glob: '*.ts' }, ctx)).toBe('src/y.ts:1:const foo = 2')
  })
  it('requires a path for read, write and edit', async () => {
    await expect(t.read_file.run({}, ctx)).rejects.toThrow('missing required argument "path"')
  })
})

describe('workspace guard', () => {
  it('refuses paths outside the workspace', async () => {
    await expect(t.read_file.run({ path: '../outside/secret.txt' }, ctx)).rejects.toThrow(/outside the workspace/)
    await expect(t.read_file.run({ path: `${outside}/secret.txt` }, ctx)).rejects.toThrow(/outside the workspace/)
    await expect(t.write_file.run({ path: '../outside/new.txt', content: 'x' }, ctx)).rejects.toThrow(/outside the workspace/)
    await expect(t.grep.run({ pattern: 'secret', path: '..' }, ctx)).rejects.toThrow(/outside the workspace/)
    expect(fs.existsSync(`${outside}/new.txt`)).toBe(false)
  })
  it('refuses to escape through a symlink, for existing and new files', async () => {
    await expect(t.read_file.run({ path: 'link/secret.txt' }, ctx)).rejects.toThrow(/outside the workspace/)
    await expect(t.write_file.run({ path: 'link/deep/new.txt', content: 'x' }, ctx)).rejects.toThrow(/outside the workspace/)
    expect(fs.existsSync(`${outside}/deep`)).toBe(false)
  })
  it('does not mistake a sibling folder with the same prefix for the workspace', () => {
    fs.mkdirSync(`${root}-evil`)
    expect(() => makeGuard(root).check(`${root}-evil/x.txt`)).toThrow(/outside the workspace/)
  })
  it('lets read-only files be read but not written or edited', async () => {
    expect(await t.read_file.run({ path: 'goals.json' }, ctx)).toContain('budget')
    await expect(t.write_file.run({ path: 'goals.json', content: '{}' }, ctx)).rejects.toThrow(/read-only/)
    await expect(t.edit_file.run({ path: './src/../goals.json', old_str: '1000', new_str: '9' }, ctx)).rejects.toThrow(/read-only/)
    expect(fs.readFileSync(`${root}/goals.json`, 'utf8')).toBe('{"budget":1000}')
  })
  it('returns the absolute path for an allowed file', () => {
    expect(makeGuard(root).check('src/y.ts')).toBe(path.join(root, 'src/y.ts'))
  })
})
