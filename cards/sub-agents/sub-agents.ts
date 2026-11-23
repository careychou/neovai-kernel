import type { Hooks, Message, ModelAdapter, AgentStatus } from '../agent-loop/types'
import type { Gate, ToolContext, ToolDef } from '../agent-loop/tool'
import { runLoop, AbortedError } from '../agent-loop/loop'
import { Semaphore } from '../agent-loop/semaphore'
import type { Reasoning, Session } from '../agent-loop/session'

type Lazy<T> = T | (() => T)
const read = <T,>(v: Lazy<T>): T => (typeof v === 'function' ? (v as () => T)() : v)

/** A named sub-agent role: its own instruction and, optionally, the only tools it may use. */
export interface SubAgentDef {
  name: string
  description: string
  /** The role's instruction. It replaces the general instruction for this sub-agent. */
  system: string
  /** Tool names it may use; omitted = every tool the parent offers sub-agents. */
  tools?: string[]
}

export interface SubAgentInfo {
  id: string
  name: string
  parentId: string
  mode: 'sync' | 'background'
  status: AgentStatus
  description: string
  /** The final answer, or the error once it failed. */
  finalText: string
}

export interface SubAgentOptions {
  adapter: ModelAdapter
  hooks: Hooks
  gate: Gate
  cwd: string
  /** Re-read for every sub-agent, so a model change in settings applies to the next one. */
  model: Lazy<string>
  /** Tools a sub-agent may use, before its role's `tools` filter. The delegation tools are added by this card. */
  tools: Lazy<ToolDef[]>
  /** Instruction for a general-purpose sub-agent. */
  system?: Lazy<string>
  /** Named roles the parent can pick with `task(agent: ...)`. */
  agents?: Lazy<SubAgentDef[]>
  services?: Record<string, unknown>
  /** How deep delegation may go: the main agent is depth 0. Default 2 (a sub-agent may start its own sub-agents once). */
  maxDepth?: number
  maxTurns?: Lazy<number>
  maxOutputTokens?: Lazy<number>
  reasoning?: Lazy<Reasoning>
  /** Set false for a one-shot run that ends with its answer: every sub-agent then runs sync, and `read_agent` is not offered. */
  background?: boolean
  /** Model-call limiter shared with the main agent. `attach(session)` sets it to the session's. */
  sem?: Semaphore
  /** Delivers a notice to the main agent. `attach(session)` sets it to `session.notify`. */
  notify?: (text: string) => void
}

/** Added to a sub-agent's instruction. */
export const SUB_AGENT_RULES = `# You are a sub-agent
Another agent gave you this task. It sees only your final answer, not your steps, so make the answer complete and self-contained: the result, the facts it rests on, and anything left undone. Do the work with your tools; you cannot ask the user questions.`

const GENERAL = 'You are a capable general-purpose assistant. Complete the task with the tools you have.'

/** Names of the tools this card adds. */
export const DELEGATION_TOOLS = ['task', 'read_agent', 'list_agents']

interface Entry {
  info: SubAgentInfo
  depth: number
  controller: AbortController
  done: Promise<void>
  notes: string[]
}

const fmt = (a: SubAgentInfo) =>
  `agent_id: ${a.id}\nname: ${a.name}\nstatus: ${a.status}` + (a.status === 'running' ? '' : `\nresult:\n${a.finalText}`)

/**
 * The agent tree of one conversation. Gives the main agent `task`, `read_agent` and `list_agents`:
 * - `task` starts a sub-agent with only the prompt it is given; the parent gets only its final answer.
 * - Several `task` calls in one reply run in parallel (the loop runs tool calls together), bounded by the shared semaphore,
 *   which is held only while a model streams, so nested agents never deadlock.
 * - `mode: "background"` returns an id at once; when the sub-agent ends its parent gets a <system_notification>,
 *   and an idle main agent wakes up to handle it.
 * - Stopping the parent stops its sub-agents; `attach(session)` also stops background ones when the user presses Stop.
 */
export class SubAgents {
  private entries = new Map<string, Entry>()
  private seq = 0
  private detach: (() => void) | null = null

  constructor(private o: SubAgentOptions) {}

  /** Binds the tree to the main agent's session: shared semaphore, notices into its queue, cancel on Stop. */
  attach(session: Session): this {
    this.detach?.()
    this.o.sem = session.semaphore
    this.o.notify = (t) => session.notify(t)
    this.detach = session.onStop(() => this.cancelAll())
    return this
  }

  /** The delegation tools for an agent at `depth` (0 = main). Empty once `maxDepth` is reached. */
  tools(depth = 0): ToolDef[] {
    if (depth >= (this.o.maxDepth ?? 2)) return []
    return this.o.background === false ? [this.taskTool()] : [this.taskTool(), this.readTool(), this.listTool()]
  }

  /** Lines for the parent's instruction listing the named roles. */
  agentsPrompt(): string {
    const defs = read(this.o.agents ?? [])
    return defs.length ? defs.map((d) => `- ${d.name}: ${d.description}`).join('\n') : '(only the general-purpose agent)'
  }

  list(): SubAgentInfo[] { return [...this.entries.values()].map((e) => ({ ...e.info })) }

  running(): number { return [...this.entries.values()].filter((e) => e.info.status === 'running').length }

  cancelAll() { for (const e of this.entries.values()) if (e.info.status === 'running') e.controller.abort() }

  /** Status of a sub-agent; with `wait`, blocks until it ends or `timeoutMs` passes. */
  async read(id: string, wait = false, timeoutMs = 60_000, signal?: AbortSignal): Promise<SubAgentInfo | null> {
    const e = this.entries.get(id)
    if (!e) return null
    if (wait && e.info.status === 'running') {
      let timer: ReturnType<typeof setTimeout> | undefined
      let onAbort: (() => void) | undefined
      await Promise.race([
        e.done,
        new Promise<void>((r) => { timer = setTimeout(r, timeoutMs) }),
        new Promise<void>((r) => { onAbort = () => r(); signal?.addEventListener('abort', onAbort, { once: true }) })
      ])
      clearTimeout(timer)
      if (onAbort) signal?.removeEventListener('abort', onAbort)
    }
    return { ...e.info }
  }

  /** Starts a sub-agent. `sync` resolves when it ends; `background` resolves at once. */
  async spawn(a: { prompt: string; agent?: string; description?: string; mode?: 'sync' | 'background' }, ctx: ToolContext): Promise<SubAgentInfo> {
    const defs = read(this.o.agents ?? [])
    const def = a.agent ? defs.find((d) => d.name === a.agent) : undefined
    if (a.agent && !def && a.agent !== 'general-purpose') throw new Error(`unknown agent "${a.agent}". Available: general-purpose${defs.map((d) => `, ${d.name}`).join('')}`)
    const name = def?.name ?? 'general-purpose'
    const mode = a.mode === 'background' && this.o.background !== false ? 'background' : 'sync'
    const depth = ctx.depth + 1
    const id = `${name.replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 24)}-${(++this.seq).toString(36)}`
    const controller = new AbortController()
    // Stopping the parent's run stops the child; a run that ends normally leaves background children going.
    const onParentAbort = () => controller.abort()
    if (ctx.signal.aborted) controller.abort()
    else ctx.signal.addEventListener('abort', onParentAbort, { once: true })
    const info: SubAgentInfo = { id, name, parentId: ctx.agentId, mode, status: 'running', description: a.description ?? '', finalText: '' }
    const entry: Entry = { info, depth, controller, done: Promise.resolve(), notes: [] }
    this.entries.set(id, entry)

    const base = read(this.o.tools)
    const allowed = def?.tools ? new Set(def.tools) : null
    const own = this.tools(depth).filter((t) => !allowed || allowed.has(t.name) || allowed.has('agent'))
    const tools = [...base.filter((t) => !DELEGATION_TOOLS.includes(t.name) && (!allowed || allowed.has(t.name))), ...own]
    const system = [def?.system ?? (this.o.system ? read(this.o.system) : GENERAL), SUB_AGENT_RULES].join('\n\n')
    const messages: Message[] = [{ role: 'system', content: system }, { role: 'user', content: a.prompt }]
    const { hooks } = this.o
    hooks.onEvent({ kind: 'agent_start', agentId: id, parentId: ctx.agentId, name, mode, prompt: a.prompt, ...(ctx.callId ? { callId: ctx.callId } : {}), ...(a.description ? { description: a.description } : {}) })

    const sem = this.o.sem ?? (this.o.sem = new Semaphore(4))
    entry.done = (async () => {
      try {
        info.finalText = await runLoop({
          agentId: id, model: read(this.o.model), adapter: this.o.adapter, sem, hooks, tools,
          signal: controller.signal,
          maxTurns: () => read(this.o.maxTurns ?? 30), maxTokens: () => read(this.o.maxOutputTokens ?? 0), reasoning: read(this.o.reasoning ?? 'off'),
          ctx: { cwd: this.o.cwd, depth, hooks, gate: this.o.gate, services: this.o.services ?? ctx.services },
          drainNotifications: () => entry.notes.splice(0)
        }, messages)
        info.status = 'completed'
      } catch (e: any) {
        info.status = e instanceof AbortedError || controller.signal.aborted ? 'cancelled' : 'failed'
        info.finalText = info.status === 'cancelled' ? 'cancelled' : (e?.message ?? String(e))
      } finally {
        ctx.signal.removeEventListener('abort', onParentAbort)
        hooks.onEvent({ kind: 'agent_end', agentId: id, status: info.status, finalText: info.finalText })
        if (mode === 'background' && info.status !== 'cancelled') this.deliver(info)
      }
    })()

    if (mode === 'sync') await entry.done
    return { ...info }
  }

  /** Tells a background agent's parent it ended: into a running sub-agent's next turn, else to the main agent. */
  private deliver(info: SubAgentInfo) {
    const text = `Background agent ${info.id} (${info.description || info.name}) ${info.status}. Use read_agent with agent_id "${info.id}" to get its result.`
    const parent = this.entries.get(info.parentId)
    if (parent && parent.info.status === 'running') parent.notes.push(text)
    else this.o.notify?.(text)
  }

  private taskTool(): ToolDef {
    const roles = () => read(this.o.agents ?? [])
    const self = this
    const props: Record<string, unknown> = {
      description: { type: 'string', description: '3 to 6 plain words naming the task, shown to the user' },
      prompt: { type: 'string', description: 'Everything the sub-agent needs to do the task' },
      agent: { type: 'string', description: 'Role name; omit for a general-purpose agent' },
      ...(this.o.background !== false ? { mode: { type: 'string', enum: ['sync', 'background'] } } : {})
    }
    return {
      name: 'task',
      get description() {
        const r = roles()
        const bg = self.o.background !== false
        return 'Hand a task to a sub-agent with its own fresh context. It sees only your prompt, so make the prompt complete and self-contained; you get back only its final answer. '
          + 'To run sub-agents IN PARALLEL, call task several times in the same reply. '
          + (bg ? 'mode "sync" (default) waits for the answer; "background" returns an agent_id at once and you are notified when it ends (then use read_agent). ' : '')
          + (r.length ? `Optional "agent" picks a role: ${r.map((d) => `${d.name} (${d.description})`).join('; ')}.` : 'Every sub-agent is general-purpose.')
      },
      parameters: { type: 'object', properties: props, required: ['prompt'] },
      run: async (a, ctx) => {
        const info = await this.spawn(a, ctx)
        if (info.mode === 'background') return `Background agent started.\nagent_id: ${info.id}\nYou will get a notice when it ends; use read_agent to get its result.`
        return info.status === 'completed' ? info.finalText : `Sub-agent ${info.status}: ${info.finalText}`
      }
    }
  }

  private readTool(): ToolDef {
    return {
      name: 'read_agent',
      description: 'Status and result of a sub-agent by agent_id. wait=true blocks until it ends (timeout in seconds, default 60, max 600).',
      parameters: { type: 'object', properties: { agent_id: { type: 'string' }, wait: { type: 'boolean' }, timeout: { type: 'integer' } }, required: ['agent_id'] },
      run: async (a, ctx) => {
        const t = Math.min(Math.max(Number(a.timeout) || 60, 1), 600)
        const info = await this.read(String(a.agent_id), !!a.wait, t * 1000, ctx.signal)
        if (!info) throw new Error(`unknown agent_id "${a.agent_id}"`)
        return fmt(info)
      }
    }
  }

  private listTool(): ToolDef {
    return {
      name: 'list_agents',
      description: 'List the sub-agents of this conversation with their status.',
      parameters: { type: 'object', properties: {} },
      run: async () => {
        const all = this.list()
        return all.length ? all.map((x) => `${x.id}  ${x.description || x.name}  ${x.mode}  ${x.status}`).join('\n') : 'no sub-agents'
      }
    }
  }
}
