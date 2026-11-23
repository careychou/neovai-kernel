import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { SubAgents } from '../sub-agents'
import { PLAIN_LANGUAGE_RULES, Session, type AgentEvent, type Hooks, type ModelAdapter, type Reasoning, type ToolDef } from '../agent-loop'
import { makeFileTools } from '../file-tools'
import { loadSkills, makeSkillTool, parseFrontMatter, skillsInstructions } from '../skills'
import { PermissionGate } from '../approval'

/** A Main App function: a prompt the runtime agent runs on demand, declared as `<jobsDir>/<name>.md`. */
export interface Job {
  name: string
  title: string
  description: string
  /** The prompt, without the header. */
  body: string
  file: string
}

export interface RunRecord {
  runId: string
  job: string
  status: 'completed' | 'failed' | 'cancelled'
  started: string
  finished: string
  text: string
  file: string
  /** The options the run was started with, as text. */
  input?: string
}

const NAME = /^[a-z0-9][a-z0-9-]*$/

/** Reads one job. Returns null when it is missing or the name is not a plain file name. */
export function readJob(dir: string, name: string): Job | null {
  if (!NAME.test(name)) return null
  const file = path.join(dir, `${name}.md`)
  let text: string
  try { text = fs.readFileSync(file, 'utf8') } catch { return null }
  const { meta, body } = parseFrontMatter(text)
  return { name, title: meta.title || name, description: meta.description ?? '', body, file }
}

/** Every job under `dir`, by name, read fresh. */
export function loadJobs(dir: string): Job[] {
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { return [] }
  return names.filter((n) => n.endsWith('.md')).map((n) => readJob(dir, n.slice(0, -3))).filter((j): j is Job => j !== null).sort((a, b) => a.name.localeCompare(b.name))
}

/** The `save_data` tool: stores structured results as `<dataDir>/<name>.json` for the app's screens to show. */
export function makeSaveDataTool(o: { dir: string; locked?: string[] }): ToolDef {
  return {
    name: 'save_data',
    description: 'Save structured results (JSON) under a name so the app screens can show them. Replaces the previous data with that name.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Data name, lowercase letters, digits and dashes, for example "today".' },
        data: { type: 'object', description: 'The JSON value to save.' }
      },
      required: ['name', 'data']
    },
    summarize: (a) => String(a?.name ?? ''),
    async run(a) {
      const name = String(a?.name ?? '')
      if (!NAME.test(name)) throw new Error(`"${name}" is not a valid data name`)
      if (o.locked?.includes(name)) throw new Error(`"${name}" is read-only: only the user changes it`)
      fs.mkdirSync(o.dir, { recursive: true })
      const file = path.join(o.dir, `${name}.json`)
      fs.writeFileSync(file, JSON.stringify(a.data ?? null, null, 2))
      return `Saved ${path.basename(o.dir)}/${name}.json`
    }
  }
}

export const RUNTIME_BASE = `You are the runtime agent of this app. You do the app's work for its user by following the instructions and skills below. They are read from disk before every run, so always follow them as written here.

# How to work
- Follow the skills in the order the job asks. Do the work with your tools; never invent data you did not fetch or read in this run.
- You may read anything in the workspace. You may only write under the folders listed as writable in the environment.
- Use save_data to store structured results the screens show. Use the shapes the job describes.
- Finish with a short report in markdown. It is saved and shown in the app.
- You do not change the app itself: skills, instructions, screens and code are changed by the user in Codify.
- Your progress is shown live to a non-technical user: keep notes to one short plain sentence, and give every tool call a plain "intent" (no file names, code or commands).

${PLAIN_LANGUAGE_RULES}`

export interface RuntimeOptions {
  workspace: string
  adapter: ModelAdapter
  /** Read before every run. */
  settings: () => { model: string; reasoning?: Reasoning; maxTurns?: number; maxOutputTokens?: number; maxConcurrency?: number }
  onEvent?: (runId: string, job: string, e: AgentEvent) => void
  base?: string
  jobsDir?: string
  skillsDir?: string
  instructionsFile?: string
  goalsFile?: string
  /** Heading the goals file appears under in the instruction. Default "Goals". */
  goalsTitle?: string
  /** Folder for run reports and saved data. The only place the agent may write unless `writable` says otherwise. */
  recordsDir?: string
  writable?: string[]
  readOnly?: string[]
  /** Extra tools, for example web fetch or a shell for scripts that skills carry. */
  tools?: ToolDef[]
  services?: Record<string, unknown>
  /** Lets a run hand parts of a job to parallel sub-agents (`task`), e.g. one per item. They share the run's tools and write limits. */
  subAgents?: boolean | { maxDepth?: number }
}

/** Options a screen passes with a run: text, or named values sent as JSON. */
export type RunInput = string | Record<string, unknown>

/** The input as one line of text, or '' when there is none. */
export function inputText(input: RunInput | undefined): string {
  if (input == null) return ''
  if (typeof input === 'string') return input.trim()
  return Object.keys(input).length ? JSON.stringify(input) : ''
}

/** The first message of a run: the job, plus any options the user picked on the screen. */
export function runMessage(job: { title: string }, input?: RunInput): string {
  const text = inputText(input)
  const head = `Run the "${job.title}" job now.`
  if (!text) return head
  return typeof input === 'string'
    ? `${head}\n\nThe user added: ${text}`
    : `${head}\n\nOptions the user picked on the screen (follow the job's instructions for each; if the job does not mention one, use it sensibly and say how in the report):\n${JSON.stringify(input, null, 2)}`
}

const stamp = (d: Date) => d.toISOString().replace(/[:.]/g, '-').slice(0, 19)
const readText = (f: string) => { try { return fs.readFileSync(f, 'utf8').trim() } catch { return '' } }

/** The Main App's runtime agent: runs jobs headlessly with every skill appended to its instruction. */
export function createRuntime(o: RuntimeOptions) {
  const ws = o.workspace
  const at = (p: string) => path.join(ws, p)
  const jobsDir = at(o.jobsDir ?? 'jobs')
  const skillsDir = at(o.skillsDir ?? 'skills')
  const records = o.recordsDir ?? 'records'
  const runsDir = at(path.join(records, 'runs'))
  const dataDir = at(path.join(records, 'data'))
  const writable = o.writable ?? [records]
  const runs = new Map<string, { job: string; session: Session }>()
  // Read-only files in the data folder may not be replaced through save_data either.
  const lockedData = (o.readOnly ?? []).map((r) => path.relative(dataDir, at(r))).filter((r) => !r.includes(path.sep) && r.endsWith('.json')).map((r) => r.slice(0, -5))

  const tools = (): ToolDef[] => [
    ...makeFileTools({ root: ws, writable, readOnly: o.readOnly }),
    makeSkillTool({ dir: skillsDir }),
    makeSaveDataTool({ dir: dataDir, locked: lockedData }),
    ...(o.tools ?? [])
  ]

  /** The full instruction for a run, read fresh from disk. */
  function systemPrompt(job?: Job): string {
    const parts = [
      o.base ?? RUNTIME_BASE,
      `# Instructions\n${readText(at(o.instructionsFile ?? 'instructions/system.md')) || '(none yet)'}`,
      `# Skills\n${skillsInstructions(loadSkills(skillsDir))}`,
      `# ${o.goalsTitle ?? 'Goals'} (read-only)\n${readText(at(o.goalsFile ?? 'goals.json')) || '(not set)'}`,
      `# Environment\n- Workspace: ${ws}\n- Writable: ${writable.join(', ')}\n- Saved data: ${path.relative(ws, dataDir)}\n- Platform: ${os.platform()} ${os.arch()}\n- Date: ${new Date().toISOString().slice(0, 10)}`
    ]
    if (job) parts.push(`# Job: ${job.title}\n${job.body}`)
    return parts.join('\n\n')
  }

  function lastRun(job: string): RunRecord | null {
    const dir = path.join(runsDir, job)
    let files: string[]
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort() } catch { return null }
    const f = files.at(-1)
    if (!f) return null
    const { meta, body } = parseFrontMatter(fs.readFileSync(path.join(dir, f), 'utf8'))
    return { runId: meta.run ?? '', job, status: (meta.status as RunRecord['status']) ?? 'completed', started: meta.started ?? '', finished: meta.finished ?? '', text: body, file: path.join(dir, f), ...(meta.input ? { input: meta.input } : {}) }
  }

  /** Runs one job to the end and saves its report under `<records>/runs/<job>/`. */
  async function run(name: string, input: RunInput = ''): Promise<RunRecord> {
    const job = readJob(jobsDir, name)
    if (!job) throw new Error(`No job named "${name}". Available: ${loadJobs(jobsDir).map((j) => j.name).join(', ') || 'none'}.`)
    if ([...runs.values()].some((r) => r.job === name)) throw new Error(`"${name}" is already running`)
    const s = o.settings()
    if (!s.model) throw new Error('Choose a model in Settings first.')
    const runId = randomUUID()
    const started = new Date()
    const hooks: Hooks = {
      onEvent: (e) => o.onEvent?.(runId, name, e),
      requestPermission: async () => 'allow',
      askUser: async () => ''
    }
    const gate = new PermissionGate(hooks, true)
    const subs = o.subAgents
      ? new SubAgents({
          adapter: o.adapter, hooks, gate, cwd: ws, model: () => o.settings().model, tools, services: o.services,
          system: () => `${systemPrompt(job)}\n\n# Your part\nThe runtime agent running this job gave you one part of it. Do only that part and report back; it saves the results.`,
          background: false,
          maxDepth: typeof o.subAgents === 'object' ? o.subAgents.maxDepth ?? 1 : 1,
          maxTurns: () => o.settings().maxTurns ?? 30, maxOutputTokens: () => o.settings().maxOutputTokens ?? 0, reasoning: () => o.settings().reasoning ?? 'off'
        })
      : null
    const session = new Session({
      adapter: o.adapter, hooks, gate, model: s.model, cwd: ws,
      system: () => systemPrompt(job) + (subs ? `\n\n# Helpers\nFor work with independent parts (for example one per stock), hand each part to a helper with the task tool, several in the same reply so they run at the same time. Give each a complete prompt. Combine their answers yourself, then save and report.` : ''),
      tools: () => [...tools(), ...(subs?.tools(0) ?? [])], services: o.services,
      maxConcurrency: s.maxConcurrency, maxTurns: s.maxTurns, maxOutputTokens: s.maxOutputTokens, reasoning: s.reasoning ?? 'off'
    })
    if (subs) subs.attach(session)
    runs.set(runId, { job: name, session })
    try {
      const r = await session.send(runMessage(job, input))
      const status = r.status === 'queued' ? 'failed' : r.status
      const finished = new Date()
      fs.mkdirSync(path.join(runsDir, name), { recursive: true })
      const file = path.join(runsDir, name, `${stamp(started)}.md`)
      const opts = inputText(input)
      fs.writeFileSync(file, `---\nrun: ${runId}\nstatus: ${status}\nstarted: ${started.toISOString()}\nfinished: ${finished.toISOString()}\n${opts ? `input: ${opts.replace(/\s*\n\s*/g, ' ')}\n` : ''}---\n${r.text}\n`)
      return { runId, job: name, status, started: started.toISOString(), finished: finished.toISOString(), text: r.text, file, ...(opts ? { input: opts } : {}) }
    } finally {
      runs.delete(runId)
    }
  }

  return {
    jobsDir, skillsDir, dataDir, runsDir,
    jobs: () => loadJobs(jobsDir),
    systemPrompt,
    run,
    lastRun,
    /** Names of jobs running now. */
    running: () => [...runs.values()].map((r) => r.job),
    /** Stops a job by name. */
    stop(job: string) { for (const r of runs.values()) if (r.job === job) r.session.stop() },
    dispose() { for (const r of runs.values()) r.session.stop(); runs.clear() }
  }
}

export type Runtime = ReturnType<typeof createRuntime>
