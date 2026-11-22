import type { AgentEvent, Message } from '../agent-loop/types'
import { textOf } from '../agent-loop/content'

/** One thing the chat draws. */
export type Item =
  | { kind: 'user'; text: string }
  | { kind: 'reasoning'; text: string; live?: boolean }
  | { kind: 'assistant'; text: string; live?: boolean }
  | { kind: 'tool'; callId: string; name: string; args: string; output?: string; ok?: boolean }
  | { kind: 'error'; text: string }

export type ToolItem = Extract<Item, { kind: 'tool' }>

/** What a message list renders: single items, with runs of two or more tool calls folded into a group. */
export type Row = Item | { kind: 'tools'; items: ToolItem[] }

/** Turns a saved conversation into chat items. System messages are skipped; tool results are paired with their calls. */
export function fromMessages(messages: Message[]): Item[] {
  const results = new Map<string, string>()
  for (const m of messages) if (m.role === 'tool') results.set(m.tool_call_id, m.content)
  const out: Item[] = []
  for (const m of messages) {
    if (m.role === 'user') out.push({ kind: 'user', text: textOf(m.content) })
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

/** Folds one live agent event into the list. Returns the same array when nothing changes. */
export function applyEvent(items: Item[], e: AgentEvent): Item[] {
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

/** The label a tool row shows: the tool name and its most useful argument. */
export function toolLabel(t: { name: string; args: string }): string {
  const s = summarize(t.name, t.args)
  return s ? `${t.name} ${s}` : t.name
}

/** First line of a thought, without markdown marks, cut to 90 characters. */
export function peek(text: string, max = 90): string {
  const line = (text.trim().split('\n')[0] ?? '').replace(/[*#]/g, '').trim()
  return line.length > max ? line.slice(0, max - 1).trimEnd() + '…' : line
}

/** Status of a group: still running, how many failed, and which call leads the label. */
export function groupState(items: ToolItem[]): { running: boolean; failed: number; lead: ToolItem } {
  const running = items.find((t) => t.ok === undefined)
  return { running: !!running, failed: items.filter((t) => t.ok === false).length, lead: running ?? items[0] }
}

/** Arguments as indented JSON, or the raw text when they do not parse. */
export function prettyArgs(args: string): string {
  try { return JSON.stringify(JSON.parse(args), null, 2) } catch { return args }
}
