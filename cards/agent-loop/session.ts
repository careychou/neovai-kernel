import type { Hooks, Message, ModelAdapter } from './types'
import type { Gate, ToolDef } from './tool'
import { runLoop, AbortedError } from './loop'
import { Semaphore } from './semaphore'
import { buildUserContent, type Attachment } from './content'

export const MAIN_ID = 'main'
export type Reasoning = 'off' | 'low' | 'medium' | 'high'
type Lazy<T> = T | (() => T)
const read = <T,>(v: Lazy<T>): T => (typeof v === 'function' ? (v as () => T)() : v)

export interface SessionOptions {
  adapter: ModelAdapter
  hooks: Hooks
  gate: Gate
  model: string
  cwd: string
  /** A function is re-read before every run, so edited instructions reach the next prompt. */
  system: Lazy<string>
  tools: Lazy<ToolDef[]>
  services?: Record<string, unknown>
  maxConcurrency?: number
  maxTurns?: number
  /** 0/undefined = the model's maximum. */
  maxOutputTokens?: number
  reasoning?: Reasoning
  history?: Message[]
}

export interface SendResult { status: 'completed' | 'failed' | 'cancelled' | 'queued'; text: string }

/** One conversation with one agent: a prompt queue around runLoop. */
/** What Session.exclusive hands to its callback. */
export interface SessionAccess { adapter: ModelAdapter; model: string; hooks: Hooks; history: Message[]; replace(next: Message[]): void }

export class Session {
  readonly messages: Message[]
  private busy = false
  private controller: AbortController | null = null
  private sem: Semaphore
  private queue: Array<{ qid?: string; content: Message['content'] }> = []
  private notes: string[] = []
  private stopListeners = new Set<() => void>()

  constructor(private o: SessionOptions) {
    this.sem = new Semaphore(o.maxConcurrency ?? 4)
    this.messages = [{ role: 'system', content: read(o.system) }, ...(o.history ?? [])]
  }

  get isBusy() { return this.busy }
  /** The model-call limiter. Sub-agents share it so the whole agent tree stays within `maxConcurrency`. */
  get semaphore() { return this.sem }
  get history(): Message[] { return this.messages.slice(1) }
  setModel(model: string) { this.o.model = model }
  setReasoning(r: Reasoning) { this.o.reasoning = r }

  /**
   * Runs `fn` while the session is held busy, with the adapter and a way to replace the history.
   * For work that rewrites the conversation between runs (e.g. compaction). Throws if a run is in progress.
   */
  async exclusive<T>(fn: (a: SessionAccess) => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('session is busy')
    this.busy = true
    try {
      return await fn({ adapter: this.o.adapter, model: this.o.model, hooks: this.o.hooks, history: this.history, replace: (next) => { this.messages.splice(1, this.messages.length - 1, ...next) } })
    } finally { this.busy = false }
  }

  /**
   * Sends a user prompt and runs the loop. While a run is in progress the prompt is queued instead:
   * it joins the conversation before the next model call, or starts the next run.
   * `hints` is harness-added context placed after the prompt (see buildUserContent).
   */
  async send(prompt?: string, attachments: Attachment[] = [], qid?: string, hints = ''): Promise<SendResult> {
    if (prompt || attachments.length) this.queue.push({ qid, content: buildUserContent(prompt ?? '', attachments, hints) as Message['content'] })
    if (this.busy) return { status: 'queued', text: '' }
    this.busy = true
    const controller = (this.controller = new AbortController())
    const { hooks } = this.o
    let status: 'completed' | 'failed' | 'cancelled' = 'completed'
    let text = ''
    try {
      do {
        this.messages[0] = { role: 'system', content: read(this.o.system) }
        text = await runLoop({
          agentId: MAIN_ID, model: this.o.model, adapter: this.o.adapter, sem: this.sem, hooks,
          tools: read(this.o.tools), signal: controller.signal,
          maxTurns: () => this.o.maxTurns ?? 50, maxTokens: () => this.o.maxOutputTokens ?? 0, reasoning: this.o.reasoning ?? 'medium',
          ctx: { cwd: this.o.cwd, depth: 0, hooks, gate: this.o.gate, services: this.o.services ?? {} },
          drainInput: () => this.drainQueue(),
          drainNotifications: () => this.notes.splice(0)
        }, this.messages)
      } while (this.queue.length || this.notes.length)
    } catch (e: any) {
      status = e instanceof AbortedError || controller.signal.aborted ? 'cancelled' : 'failed'
      text = status === 'cancelled' ? 'cancelled' : (e?.message ?? String(e))
      if (status === 'failed') hooks.onEvent({ kind: 'error', agentId: MAIN_ID, message: text })
      this.repairHistory()
      this.notes = []
      const dropped = this.queue.splice(0).flatMap((q) => (q.qid ? [q.qid] : []))
      if (dropped.length) hooks.onEvent({ kind: 'queue_cleared', agentId: MAIN_ID, qids: dropped })
    } finally {
      this.busy = false
      this.controller = null
      hooks.onEvent({ kind: 'agent_end', agentId: MAIN_ID, status, finalText: text })
    }
    return { status, text }
  }

  /** Removes a queued prompt before it reaches the model. Returns false if it was already sent. */
  unqueue(qid: string) {
    const i = this.queue.findIndex((q) => q.qid === qid)
    if (i >= 0) this.queue.splice(i, 1)
    return i >= 0
  }

  stop() {
    this.controller?.abort()
    for (const fn of this.stopListeners) fn()
  }

  /** Runs `fn` whenever the user stops this conversation, e.g. to cancel background sub-agents. Returns an unsubscribe. */
  onStop(fn: () => void): () => void {
    this.stopListeners.add(fn)
    return () => this.stopListeners.delete(fn)
  }

  /**
   * Tells the agent something happened (a background sub-agent finished). It reaches the model as a
   * <system_notification> before its next call; an idle session starts a run to handle it.
   */
  notify(text: string) {
    this.notes.push(text)
    if (!this.busy) void this.send()
  }

  private drainQueue(): Message[] {
    return this.queue.splice(0).map((q) => {
      if (q.qid) this.o.hooks.onEvent({ kind: 'user_input', agentId: MAIN_ID, qid: q.qid })
      return { role: 'user', content: q.content } as Message
    })
  }

  /** After an interruption, make sure every assistant tool_call has a matching tool result. */
  private repairHistory() {
    const last = [...this.messages].reverse().find((m) => m.role === 'assistant') as Extract<Message, { role: 'assistant' }> | undefined
    if (!last?.tool_calls) return
    const have = new Set(this.messages.filter((m) => m.role === 'tool').map((m) => (m as any).tool_call_id))
    for (const c of last.tool_calls) if (!have.has(c.id)) this.messages.push({ role: 'tool', tool_call_id: c.id, content: 'Error: cancelled' })
  }
}
