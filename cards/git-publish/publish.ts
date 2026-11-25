import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import type { AgentEvent, Message, ModelAdapter, ToolCall } from '../agent-loop'

export interface RunResult { code: number; out: string }
/** Runs a command without a shell. Replaceable in tests. */
export type Runner = (cmd: string, args: string[], cwd: string) => Promise<RunResult>

export interface Mirror {
  /** The folder the app edits (e.g. its workspace in the user's data folder). */
  from: string
  /** Where it lives in the repo; a relative path is inside the repository (needed with `url`, e.g. 'workspace'). */
  to: string
  /** Globs relative to `from` to leave out; `**` spans folders, `*` stays in one, a leading `!` keeps a path back. */
  exclude?: string[]
}

export interface PublishOptions {
  /** A local git repository folder. Not needed with `url`. */
  repo?: string
  /** A remote repository (e.g. git@github.com:me/app.git). It is downloaded into a temporary folder, updated,
   * pushed back, and the temporary folder is deleted, so no local working copy is kept. */
  url?: string
  /** The branch to update with `url`; the remote's default branch when omitted. */
  branch?: string
  /** Copy an edited folder into the repo first: new and changed files are copied, removed ones deleted. */
  mirror?: Mirror
  /** Commit message; a short one naming the changed folders is made when omitted. */
  message?: string
  /** Writes the commit message from the staged changes (e.g. `commitMessageWriter`). Used when `message` is not set;
   * an empty answer or an error falls back to the short one. */
  describe?: Describe
  remote?: string
  /** Set false to commit without pushing. */
  push?: boolean
  /** Receives the steps as agent events, so a chat-view list shows them live. */
  onEvent?(e: AgentEvent): void
  agentId?: string
  run?: Runner
}

/** What a `describe` hook gets: the staged changes and when the repository was last committed to. */
export interface ChangeInfo {
  /** `git status --porcelain` lines. */
  files: string[]
  /** `git diff --cached --stat`. */
  stat: string
  /** `git diff --cached`, cut to `maxPatch` characters. */
  patch: string
  /** The mirrored folder inside the repository ('' without a mirror). */
  base: string
  /** Time of the repository's last commit before this one (ms since epoch), e.g. to collect the requests made since. */
  since: number
}
export type Describe = (info: ChangeInfo) => Promise<string | null | undefined>

export interface PublishResult {
  status: 'published' | 'committed' | 'nothing' | 'failed'
  text: string
  commit?: string
  /** The steps as chat messages (one assistant turn with `shell` calls and their results, then the summary), to keep in the chat history. */
  messages: Message[]
}

const PATH = ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', process.env.PATH ?? ''].filter(Boolean).join(path.delimiter)

export const runCommand: Runner = (cmd, args, cwd) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, env: { ...process.env, PATH, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 8 << 20, timeout: 120_000 }, (err, stdout, stderr) => {
      const out = `${stdout ?? ''}${stderr ?? ''}`.trimEnd()
      resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, out: out || (err ? String(err.message) : '') })
    })
  })

function globRe(g: string): RegExp {
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*' && g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++ }
    else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

/** True when `rel` (posix, relative) is left out by the globs. A folder glob like `a/**` also covers `a`. */
export function excluded(rel: string, globs: string[] = []): boolean {
  const hit = (g: string) => globRe(g).test(rel) || (g.endsWith('/**') && rel === g.slice(0, -3))
  return globs.some((g) => !g.startsWith('!') && hit(g)) && !globs.some((g) => g.startsWith('!') && hit(g.slice(1)))
}

function files(root: string, globs: string[], rel = ''): string[] {
  let entries: fs.Dirent[] = []
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }) } catch { return [] }
  const out: string[] = []
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...files(root, globs, p))
    else if (e.isFile() && !excluded(p, globs)) out.push(p)
  }
  return out
}

/** Makes `to` match `from` for every file the globs keep. Returns the paths copied and removed. */
export function mirrorFolder(m: Mirror): { copied: string[]; removed: string[] } {
  const ex = m.exclude ?? []
  const src = files(m.from, ex)
  const have = new Set(src)
  const copied: string[] = []
  for (const f of src) {
    const a = path.join(m.from, f)
    const b = path.join(m.to, f)
    const same = fs.existsSync(b) && fs.readFileSync(a).equals(fs.readFileSync(b))
    if (same) continue
    fs.mkdirSync(path.dirname(b), { recursive: true })
    fs.copyFileSync(a, b)
    copied.push(f)
  }
  const removed = files(m.to, ex).filter((f) => !have.has(f))
  for (const f of removed) fs.rmSync(path.join(m.to, f))
  return { copied, removed }
}

/** "update ui, skills (3 files)" from `git status --porcelain` lines, naming the top folders under `base`. */
export function describeChanges(lines: string[], base = ''): string {
  const areas = new Set<string>()
  for (const l of lines) {
    // The status code is 1-2 letters plus a space; a trimmed first line may have lost its leading space.
    let p = l.replace(/^[ MADRCTU?!]{1,2} /, '').replace(/^"|"$/g, '')
    if (p.includes(' -> ')) p = p.split(' -> ')[1]
    if (base && p.startsWith(base + '/')) p = p.slice(base.length + 1)
    areas.add(p.includes('/') ? p.split('/')[0] : p)
  }
  const names = [...areas].slice(0, 4).join(', ') + (areas.size > 4 ? ', …' : '')
  return `update ${names} (${lines.length} file${lines.length === 1 ? '' : 's'})`
}

/** Strips code fences and quotes a model may wrap a message in, and trims each line's trailing space. */
export function cleanMessage(t: string): string {
  return t.replace(/^\s*```[a-z]*\n?/i, '').replace(/\n?```\s*$/, '').split('\n').map((l) => l.trimEnd()).join('\n').trim().replace(/^"([\s\S]*)"$/, '$1').trim()
}

export interface CommitWriterOptions {
  adapter: ModelAdapter
  model: string
  /** What led to the changes, e.g. the user's requests and the agent's answers since `info.since`. */
  context?: (info: ChangeInfo) => string | Promise<string>
  /** Most diff characters sent to the model (default 24000). */
  maxPatch?: number
  signal?: AbortSignal
}

const WRITER_PROMPT = `You write git commit messages for an app whose screens, agent instructions, skills and logic were changed by a coding agent at a user's request. Write one message for the staged changes below.

Format:
- First line: what changed, in plain words, at most 72 characters, no trailing period, no prefix.
- A blank line.
- "Why:" then one to three sentences on the reason: what the user asked for or what problem it fixes. Take the reason from the requests; if they don't say, say what the change does for the user and don't invent one.
- A blank line.
- "What changed:" then short bullets ("- ") grouped by kind where it applies: screens and panels, agent instructions and skills, jobs, logic and data shape, docs. Name the files or rules that matter and the behavior that is different now.

Use only facts from the requests and the diff. No hype, no emoji. Reply with the message only.`

/** A `describe` hook that asks a model for a commit message with the reason for the change and what changed. */
export function commitMessageWriter(w: CommitWriterOptions): Describe {
  return async (info) => {
    const max = w.maxPatch ?? 24_000
    const context = (await w.context?.(info))?.trim()
    const patch = info.patch.length > max ? info.patch.slice(0, max) + '\n… (diff cut)' : info.patch
    const user = [
      context ? `# What led to these changes\n${context}` : '# What led to these changes\n(no requests recorded)',
      `# Files\n${info.stat}`,
      `# Diff\n${patch}`
    ].join('\n\n')
    let text = ''
    const signal = w.signal ?? AbortSignal.timeout(90_000)
    for await (const d of w.adapter.stream({ model: w.model, maxTokens: 1200, messages: [{ role: 'system', content: WRITER_PROMPT }, { role: 'user', content: user }] }, signal)) {
      if (d.type === 'text') text += d.text
    }
    return cleanMessage(text)
  }
}

/** Copies, commits and pushes, one visible step at a time. Never throws: a failed step ends the run with its output. */
export async function publish(o: PublishOptions): Promise<PublishResult> {
  const agentId = o.agentId ?? 'main'
  const emit = (e: AgentEvent) => o.onEvent?.(e)
  const run = o.run ?? runCommand
  const remote = o.remote ?? 'origin'
  const calls: ToolCall[] = []
  const results: Message[] = []
  let n = 0
  const step = async (intent: string, command: string, fn: () => Promise<{ ok: boolean; output: string }>) => {
    const id = `publish-${Date.now().toString(36)}-${n++}`
    const args = JSON.stringify({ intent, command })
    emit({ kind: 'tool_start', agentId, callId: id, name: 'shell', args })
    let r: { ok: boolean; output: string }
    try { r = await fn() } catch (e) { r = { ok: false, output: String((e as Error)?.message ?? e) } }
    const output = r.ok ? r.output || 'Done.' : `Error: ${r.output || 'failed'}`
    emit({ kind: 'tool_end', agentId, callId: id, name: 'shell', output, ok: r.ok })
    calls.push({ id, type: 'function', function: { name: 'shell', arguments: args } })
    results.push({ role: 'tool', tool_call_id: id, content: output })
    return r
  }
  const finish = (status: PublishResult['status'], text: string, commit?: string): PublishResult => {
    emit({ kind: 'text', agentId, text })
    const messages: Message[] = calls.length ? [{ role: 'assistant', content: null, tool_calls: calls }, ...results] : []
    const done: Message = { role: 'assistant', content: text }
    messages.push(done)
    emit({ kind: 'assistant_done', agentId, message: done })
    emit({ kind: 'agent_end', agentId, status: status === 'failed' ? 'failed' : 'completed', finalText: text })
    return { status, text, commit, messages }
  }
  if (!o.url) return publishIn(o.repo ?? '', o, step, finish, run, remote)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-'))
  try {
    const args = ['clone', '-q', '--depth', '1', ...(o.branch ? ['--branch', o.branch] : []), o.url, tmp]
    const c = await step('Download the repository', `git clone --depth 1 ${o.branch ? `--branch ${o.branch} ` : ''}${o.url}`, async () => {
      const r = await run('git', args, os.tmpdir())
      return { ok: r.code === 0, output: r.out || `Downloaded into a temporary folder.` }
    })
    if (!c.ok) return finish('failed', "I couldn't download the repository. Open the step for git's reason (address, access or network).")
    return await publishIn(tmp, o, step, finish, run, remote)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

type Step = (intent: string, command: string, fn: () => Promise<{ ok: boolean; output: string }>) => Promise<{ ok: boolean; output: string }>
type Finish = (status: PublishResult['status'], text: string, commit?: string) => PublishResult

async function publishIn(repo: string, o: PublishOptions, step: Step, finish: Finish, run: Runner, remote: string): Promise<PublishResult> {
  const git = (...args: string[]) => run('git', args, repo)

  const top = o.url ? { ok: true, output: repo } : await step('Find the repository', 'git rev-parse --show-toplevel', async () => {
    if (!repo || !fs.existsSync(repo)) return { ok: false, output: `Repository folder not found: ${repo || '(not set)'}` }
    const r = await git('rev-parse', '--show-toplevel')
    return { ok: r.code === 0, output: r.out }
  })
  if (!top.ok) return finish('failed', `I couldn't publish: ${repo ? 'that folder is not a git repository' : 'no repository is set'}.`)

  const m = o.mirror && { ...o.mirror, to: path.resolve(repo, o.mirror.to) }
  if (m && path.resolve(m.from) !== path.resolve(m.to)) {
    const r = await step("Copy the app's changes into the repository", `copy ${m.from} → ${m.to}`, async () => {
      const { copied, removed } = mirrorFolder(m)
      const lines = [...copied.map((f) => `copied  ${f}`), ...removed.map((f) => `removed ${f}`)]
      return { ok: true, output: lines.length ? lines.join('\n') : 'Already up to date.' }
    })
    if (!r.ok) return finish('failed', "I couldn't copy the app's changes into the repository.")
  }

  let changes: string[] = []
  const st = await step('Look for changes', 'git status --porcelain', async () => {
    const r = await git('status', '--porcelain')
    changes = r.out.split('\n').filter((l) => l.trim())
    return { ok: r.code === 0, output: r.code === 0 ? (changes.length ? r.out : 'No changes.') : r.out }
  })
  if (!st.ok) return finish('failed', "I couldn't read the repository's changes.")

  let commit = ''
  if (changes.length) {
    const base = m ? path.relative(top.output.trim(), path.resolve(m.to)).split(path.sep).join('/') : ''
    const a = await git('add', '-A')
    if (a.code !== 0) return finish('failed', "I couldn't stage the changes: " + a.out)
    let message = o.message?.trim() ?? ''
    if (!message && o.describe) {
      await step('Write the commit message', 'git diff --cached', async () => {
        const since = Number((await git('log', '-1', '--format=%ct')).out.trim()) * 1000 || 0
        const stat = (await git('diff', '--cached', '--stat')).out
        const patch = (await git('diff', '--cached')).out
        try { message = cleanMessage((await o.describe!({ files: changes, stat, patch, base, since })) ?? '') } catch (e) {
          return { ok: true, output: `Couldn't write a message (${String((e as Error)?.message ?? e)}); using a short one.` }
        }
        return { ok: true, output: message || 'No message came back; using a short one.' }
      })
    }
    if (!message) message = `Codify: ${describeChanges(changes, base)}`
    const subject = message.split('\n')[0]
    const c = await step('Save the changes as a commit', `git add -A && git commit -m "${subject}"`, async () => {
      // A fresh download has no author unless git is set up globally; fall back to a named one.
      const who = (await git('config', 'user.email')).out.trim() ? [] : ['-c', 'user.name=Codify', '-c', 'user.email=codify@localhost']
      const r = await git(...who, 'commit', '-q', '-m', message)
      if (r.code !== 0) return { ok: false, output: r.out }
      commit = (await git('rev-parse', '--short', 'HEAD')).out.trim()
      return { ok: true, output: `${commit} ${subject}` }
    })
    if (!c.ok) return finish('failed', "I couldn't save the changes as a commit.")
  }

  if (o.push === false) return changes.length ? finish('committed', `Saved ${changes.length} changed file${changes.length === 1 ? '' : 's'} as commit ${commit}.`, commit) : finish('nothing', 'Nothing to publish: everything is already committed.')

  let ahead = changes.length > 0
  if (!ahead) {
    const s = await git('status', '-sb')
    ahead = /\[ahead \d+/.test(s.out.split('\n')[0] ?? '') || !/\.\.\./.test(s.out.split('\n')[0] ?? '')
    if (!ahead) return finish('nothing', 'Nothing to publish: the repository already matches the app.')
  }
  const p = await step('Push to the remote repository', `git push ${remote} HEAD`, async () => {
    const r = await git('push', remote, 'HEAD')
    return { ok: r.code === 0, output: r.out }
  })
  if (!p.ok) return finish('failed', o.url
    ? 'Pushing failed, so nothing was changed on the remote. Open the last step for the reason, then publish again.'
    : 'The commit is saved on this computer, but pushing it failed. Open the last step for the reason.', o.url ? undefined : commit || undefined)
  const url = (await git('remote', 'get-url', remote)).out.trim().replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, '')
  return finish('published', changes.length
    ? `Published ${changes.length} changed file${changes.length === 1 ? '' : 's'} to ${url} (commit ${commit}).`
    : `Pushed the waiting commits to ${url}.`, commit || undefined)
}
