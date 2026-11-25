import type { AgentEvent, AgentStatus, Message } from '../agent-loop/types'
import { userView, type Attachment } from './attach'

/** One thing the chat draws. */
export type Item =
  | { kind: 'user'; text: string; images?: string[]; files?: string[] }
  | { kind: 'reasoning'; text: string; live?: boolean }
  | { kind: 'assistant'; text: string; live?: boolean }
  | { kind: 'tool'; callId: string; name: string; args: string; output?: string; ok?: boolean; agent?: SubAgentView }
  | { kind: 'error'; text: string }

export type ToolItem = Extract<Item, { kind: 'tool' }>

/** A sub-agent started by a `task` call, drawn under that step with its own steps. */
export interface SubAgentView {
  id: string
  name: string
  description?: string
  mode: 'main' | 'sync' | 'background'
  status: AgentStatus
  items: Item[]
}

/** What a message list renders: single items, with runs of two or more tool calls folded into a group. */
export type Row = Item | { kind: 'tools'; items: ToolItem[] }

/** Turns a saved conversation into chat items. System messages are skipped; tool results are paired with their calls. */
export function fromMessages(messages: Message[]): Item[] {
  const results = new Map<string, string>()
  for (const m of messages) if (m.role === 'tool') results.set(m.tool_call_id, m.content)
  const out: Item[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      const v = userView(m.content)
      out.push({ kind: 'user', text: v.text, ...(v.images.length ? { images: v.images } : {}), ...(v.files.length ? { files: v.files } : {}) })
    }
    if (m.role !== 'assistant') continue
    if (m.reasoning?.trim()) out.push({ kind: 'reasoning', text: m.reasoning })
    if (m.content) out.push({ kind: 'assistant', text: m.content })
    for (const c of m.tool_calls ?? []) {
      const output = results.get(c.id)
      out.push(output === undefined
        ? { kind: 'tool', callId: c.id, name: c.function.name, args: c.function.arguments, output: 'No result was saved.', ok: false }
        : { kind: 'tool', callId: c.id, name: c.function.name, args: c.function.arguments, output, ok: !output.startsWith('Error:') })
    }
  }
  return out
}

/** Ends any live reasoning or text. */
function settle(items: Item[]): Item[] {
  if (!items.some((i) => (i.kind === 'reasoning' || i.kind === 'assistant') && i.live)) return items
  return items.map((i) => ((i.kind === 'reasoning' || i.kind === 'assistant') && i.live ? { kind: i.kind, text: i.text } : i))
}

const endThinking = (items: Item[]): Item[] =>
  items.some((i) => i.kind === 'reasoning' && i.live)
    ? items.map((i) => (i.kind === 'reasoning' && i.live ? { kind: 'reasoning', text: i.text } : i))
    : items

/** Applies `fn` to the tool item that matches `hit`, at any depth. Returns null when none matches. */
function updateTool(items: Item[], hit: (t: ToolItem) => boolean, fn: (t: ToolItem) => ToolItem): Item[] | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.kind !== 'tool') continue
    let next: ToolItem | null = null
    if (hit(it)) next = fn(it)
    else if (it.agent) {
      const inner = updateTool(it.agent.items, hit, fn)
      if (inner) next = { ...it, agent: { ...it.agent, items: inner } }
    }
    if (next) return [...items.slice(0, i), next, ...items.slice(i + 1)]
  }
  return null
}

/**
 * Folds one live agent event into the list. Returns the same array when nothing changes.
 * Events from sub-agents go into the `task` step that started them (`agent_start.callId`), at any depth.
 */
export function applyEvent(items: Item[], e: AgentEvent): Item[] {
  if (e.kind === 'agent_start') {
    if (!e.parentId || !e.callId) return items
    const view: SubAgentView = { id: e.agentId, name: e.name, mode: e.mode, status: 'running', items: [], ...(e.description ? { description: e.description } : {}) }
    return updateTool(items, (t) => t.callId === e.callId, (t) => ({ ...t, agent: view })) ?? items
  }
  const nested = updateTool(items, (t) => t.agent?.id === e.agentId, (t) => {
    const a = t.agent!
    const inner = applyEvent(a.items, e)
    return e.kind === 'agent_end' ? { ...t, agent: { ...a, status: e.status, items: inner } } : inner === a.items ? t : { ...t, agent: { ...a, items: inner } }
  })
  if (nested) return nested
  const last = items[items.length - 1]
  switch (e.kind) {
    case 'reasoning':
      return last?.kind === 'reasoning' && last.live
        ? [...items.slice(0, -1), { ...last, text: last.text + e.text }]
        : [...settle(items), { kind: 'reasoning', text: e.text, live: true }]
    case 'text': {
      if (last?.kind === 'assistant' && last.live) return [...items.slice(0, -1), { ...last, text: last.text + e.text }]
      return [...endThinking(items), { kind: 'assistant', text: e.text, live: true }]
    }
    case 'assistant_done':
    case 'agent_end':
      return settle(items)
    case 'tool_start':
      return [...settle(items), { kind: 'tool', callId: e.callId, name: e.name, args: e.args }]
    case 'tool_end':
      return items.map((it) => (it.kind === 'tool' && it.callId === e.callId ? { ...it, output: e.output, ok: e.ok } : it))
    case 'error':
      return [...settle(items), { kind: 'error', text: e.message }]
    default:
      return items
  }
}

/** A prompt sent while the agent was working, waiting to join the conversation at its next step. */
export interface QueuedPrompt {
  qid: string
  text: string
  images?: string[]
  files?: string[]
  /** The files as attached, kept by the window that queued the prompt so they can go back to the composer. */
  attachments?: Attachment[]
}

/** What a chat draws: the conversation and the prompts still waiting to join it. */
export interface ChatState { items: Item[]; queue: QueuedPrompt[] }

/** Turns `Session.queued` into the prompts a chat draws as chips, e.g. when a working chat is reopened. */
export function queuedView(queued: Array<{ qid: string; content: Message['content'] }>): QueuedPrompt[] {
  return queued.map((q) => {
    const v = userView(q.content)
    return { qid: q.qid, text: v.text, ...(v.images.length ? { images: v.images } : {}), ...(v.files.length ? { files: v.files } : {}) }
  })
}

const userItem = (q: QueuedPrompt): Item => ({ kind: 'user', text: q.text, ...(q.images?.length ? { images: q.images } : {}), ...(q.files?.length ? { files: q.files } : {}) })

/**
 * `applyEvent` for a chat that queues prompts. `user_input` moves a queued prompt into the conversation at the
 * point the model received it; `queue_cleared` (stop or failure) takes prompts out of the queue and returns
 * them in `restored`, for the app to put back in the message box. `items` and `queue` keep their identity
 * when they do not change.
 */
export function applyChatEvent(s: ChatState, e: AgentEvent): ChatState & { restored: QueuedPrompt[] } {
  if (e.kind === 'user_input') {
    const hit = s.queue.find((q) => q.qid === e.qid)
    if (!hit) return { items: s.items, queue: s.queue, restored: [] }
    return { items: [...settle(s.items), userItem(hit)], queue: s.queue.filter((q) => q !== hit), restored: [] }
  }
  if (e.kind === 'queue_cleared') {
    const restored = s.queue.filter((q) => e.qids.includes(q.qid))
    return { items: s.items, queue: restored.length ? s.queue.filter((q) => !restored.includes(q)) : s.queue, restored }
  }
  return { items: applyEvent(s.items, e), queue: s.queue, restored: [] }
}

/** The message box text after queued prompts come back to it: what was typed, then each prompt, blank lines between. */
export function restoreDraft(draft: string, restored: QueuedPrompt[]): string {
  return [draft, ...restored.map((q) => q.text)].map((t) => t.trim()).filter(Boolean).join('\n\n')
}

/** Folds consecutive tool calls into one group row. A lone call stays a plain row. */
export function groupRows(items: Item[]): Row[] {
  const out: Row[] = []
  let run: ToolItem[] = []
  const flush = () => {
    if (run.length === 1) out.push(run[0])
    else if (run.length > 1) out.push({ kind: 'tools', items: run })
    run = []
  }
  for (const it of items) {
    if (it.kind === 'tool') { run.push(it); continue }
    flush()
    out.push(it)
  }
  flush()
  return out
}

/** One short line describing a tool call, taken from its arguments. */
export function summarize(_name: string, args: string): string {
  try {
    const a = JSON.parse(args)
    const v = a.command ?? a.path ?? a.url ?? a.pattern ?? a.name ?? a.query ?? ''
    return typeof v === 'string' ? v : ''
  } catch {
    return ''
  }
}

/** The technical label: the tool name and its most useful argument, e.g. "shell npm test". */
export function technicalLabel(t: { name: string; args: string }): string {
  const s = summarize(t.name, t.args)
  return s ? `${t.name} ${s}` : t.name
}

const parse = (args: string): Record<string, unknown> => {
  try { const a = JSON.parse(args); return a && typeof a === 'object' ? a : {} } catch { return {} }
}
const clean = (v: unknown, max = 80) => {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s
}
const words = (name: string) => { const w = name.replace(/[_-]+/g, ' ').trim(); return w ? w[0].toUpperCase() + w.slice(1) : 'Step' }

/** Plain wording for calls that carry no intent (older chats, or a model that skipped it). */
const FALLBACK: Record<string, (a: Record<string, unknown>) => string> = {
  read_file: () => 'Read a file',
  write_file: () => 'Save a file',
  edit_file: () => 'Edit a file',
  glob: () => 'Look for files',
  grep: () => 'Search the files',
  shell: () => 'Run a step',
  read_shell: () => 'Check on a running step',
  write_shell: () => 'Send input to a running step',
  stop_shell: () => 'Stop a running step',
  list_shells: () => 'List running steps',
  web_fetch: () => 'Look something up online',
  skill: (a) => (clean(a.name) ? `Use the ${clean(a.name)} skill` : 'Use a skill'),
  save_data: (a) => (clean(a.name) ? `Save the ${clean(a.name)} results` : 'Save results'),
  task: () => 'Hand off a task',
  read_agent: () => 'Check on a helper',
  list_agents: () => 'List helpers',
  ask_user: () => 'Ask you a question'
}

/**
 * The label a tool row shows, in plain words: the call's `intent`, else its `description`,
 * else a generic phrase for the tool. Never a raw command or path.
 */
export function toolLabel(t: { name: string; args: string }): string {
  const a = parse(t.args)
  return clean(a.intent) || clean(a.description) || (FALLBACK[t.name]?.(a) ?? words(t.name))
}

/** First line of a thought, without markdown marks, cut to 90 characters. */
export function peek(text: string, max = 90): string {
  const line = (text.trim().split('\n')[0] ?? '').replace(/[*#]/g, '').trim()
  return line.length > max ? line.slice(0, max - 1).trimEnd() + '…' : line
}

/** Status of a group: still running, how many failed, and which call leads the label. */
export function groupState(items: ToolItem[]): { running: boolean; failed: number; lead: ToolItem } {
  const running = items.find(isRunning)
  return { running: !!running, failed: items.filter((t) => !isRunning(t) && stepFailed(t)).length, lead: running ?? items[0] }
}

/** A step is running until its tool returns and, for a `task`, until its sub-agent ends. */
export const isRunning = (t: ToolItem) => t.ok === undefined || t.agent?.status === 'running'
/** The tool failed, or its sub-agent failed. A stopped sub-agent counts as failed too. */
export const stepFailed = (t: ToolItem) => t.ok === false || (!!t.agent && t.agent.status !== 'running' && t.agent.status !== 'completed')

/** Arguments as indented JSON, or the raw text when they do not parse. */
export function prettyArgs(args: string): string {
  try { return JSON.stringify(JSON.parse(args), null, 2) } catch { return args }
}
