import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { AgentEvent } from '../agent-loop'
import { applyEvent, fromMessages, type Item } from '../chat-view'
import { describeChanges, excluded, mirrorFolder, publish } from './index'

let dir: string, repo: string, remote: string, app: string
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim()
const write = (root: string, p: string, t: string) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), t) }

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pub-')))
  remote = path.join(dir, 'remote.git'); repo = path.join(dir, 'repo'); app = path.join(dir, 'app')
  execFileSync('git', ['init', '-q', '--bare', remote])
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T')
  git('remote', 'add', 'origin', remote)
  write(repo, 'workspace/ui/a.tsx', 'a'); write(repo, 'workspace/old.md', 'old'); write(repo, 'README.md', 'r')
  git('add', '-A'); git('commit', '-qm', 'init'); git('push', '-q', '-u', 'origin', 'main')
  write(app, 'ui/a.tsx', 'a2'); write(app, 'skills/s/SKILL.md', 's'); write(app, 'records/data/x.json', '{}'); write(app, 'records/README.md', 'keep')
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('git-publish', () => {
  it('copies the app workspace in, commits, pushes and shows each step as a chat row', async () => {
    const events: AgentEvent[] = []
    const r = await publish({ repo, mirror: { from: app, to: path.join(repo, 'workspace'), exclude: ['records/**', '!records/README.md'] }, onEvent: (e) => events.push(e) })
    expect(r.status).toBe('published')
    expect(fs.readFileSync(path.join(repo, 'workspace/ui/a.tsx'), 'utf8')).toBe('a2')
    expect(fs.existsSync(path.join(repo, 'workspace/old.md'))).toBe(false)
    expect(fs.existsSync(path.join(repo, 'workspace/records/data/x.json'))).toBe(false)
    expect(fs.existsSync(path.join(repo, 'workspace/records/README.md'))).toBe(true)
    expect(execFileSync('git', ['--git-dir', remote, 'log', '-1', '--format=%s', 'main'], { encoding: 'utf8' }).trim()).toMatch(/^Codify: update /)
    expect(r.text).toContain(`commit ${r.commit}`)

    let items: Item[] = []
    for (const e of events) items = applyEvent(items, e)
    const steps = items.filter((i) => i.kind === 'tool')
    expect(steps.map((s) => JSON.parse((s as { args: string }).args).intent)).toEqual([
      'Find the repository', "Copy the app's changes into the repository", 'Look for changes', 'Save the changes as a commit', 'Push to the remote repository'
    ])
    expect(steps.every((s) => (s as { ok?: boolean }).ok)).toBe(true)
    expect(items.at(-1)).toMatchObject({ kind: 'assistant', text: r.text })
    expect(fromMessages(r.messages)).toEqual(items)
  })

  it('says there is nothing to publish when the repo already matches', async () => {
    const r = await publish({ repo })
    expect(r.status).toBe('nothing')
  })

  it('pushes waiting commits even with no new changes', async () => {
    write(repo, 'b.md', 'b'); git('add', '-A'); git('commit', '-qm', 'local')
    const r = await publish({ repo })
    expect(r.status).toBe('published')
    expect(execFileSync('git', ['--git-dir', remote, 'log', '-1', '--format=%s', 'main'], { encoding: 'utf8' }).trim()).toBe('local')
  })

  it('keeps the commit and reports a failed push', async () => {
    git('remote', 'set-url', 'origin', path.join(dir, 'missing.git'))
    write(repo, 'c.md', 'c')
    const events: AgentEvent[] = []
    const r = await publish({ repo, onEvent: (e) => events.push(e) })
    expect(r.status).toBe('failed')
    expect(r.commit).toBeTruthy()
    expect(git('status', '--porcelain')).toBe('')
    expect(events.at(-1)).toMatchObject({ kind: 'agent_end', status: 'failed' })
  })

  it('fails cleanly when the folder is not a repository', async () => {
    const r = await publish({ repo: app })
    expect(r.status).toBe('failed')
    expect(r.messages[0]).toMatchObject({ role: 'assistant' })
  })

  it('matches exclude globs and names changed areas', () => {
    expect(excluded('records/data/x.json', ['records/**'])).toBe(true)
    expect(excluded('records/README.md', ['records/**', '!records/README.md'])).toBe(false)
    expect(excluded('.vite/deps/a.js', ['.vite/**'])).toBe(true)
    expect(excluded('ui/a.tsx', ['*.json'])).toBe(false)
    expect(describeChanges([' M workspace/ui/a.tsx', '?? workspace/skills/s/SKILL.md', ' D workspace/old.md'], 'workspace')).toBe('update ui, skills, old.md (3 files)')
    expect(mirrorFolder({ from: app, to: app }).copied).toEqual([])
  })
})
