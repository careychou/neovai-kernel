import type { Message, ModelAdapter } from '../agent-loop/types'
import type { ToolDef } from '../agent-loop/tool'
import type { Session, SendResult } from '../agent-loop/session'
import type { Attachment } from '../agent-loop/content'
import { servedModel } from '../agent-loop/model-id'
import type { Store } from '../session-store/store'
import {
  applyCompaction, autoCompactDecision, clusterTurns, estimateTokens, keepLastPlan, planTurns, priorSummary, removedCount, splitHistoryTurns, summarizeTurns,
  type AutoCompactDecision, type AutoCompactInput, type Cluster, type CompactPlan
} from './compact'
import { formatHints, pickHints, recallTool, type RecallHit, type RecallScope } from './recall'
import { TurnIndex } from './turn-index'

/** Agent id that compaction model calls report their token usage under. */
export const COMPACT_ID = 'compact'
/** The automatic hint search skips this many of the newest turns of the current chat: the model can already see them. */
export const HINT_SKIP_RECENT = 20

export interface CompactResult {
  /** Estimated context tokens before and after. */
  before: number; after: number
  summarized: number; dropped: number
  summary: string
  /** Model that wrote the summary; '' when nothing changed. */
  model: string
  /** Original (0-based) turn numbers that stayed, and that were summarized or dropped. */
  keptTurns: number[]; compactedTurns: number[]
}

export interface TurnAnalysis {
  turns: Array<{ index: number; user: string; answer: string; tools: string[]; tokens: number }>
  clusters: Cluster[]
  method: 'model' | 'lexical'
  model: string
  hasPriorSummary: boolean
  tokens: number
}

/** Auto-compaction settings; see autoCompactDecision. */
export type AutoCompactSettings = Pick<AutoCompactInput, 'mode' | 'threshold' | 'hardLimit' | 'idleMinutes' | 'keepRecent' | 'minGain'>

export interface ContextMemoryOptions {
  store: Store
  /** The live session of a chat, if it is open. Used to search turns not saved yet. */
  session?: (id: string) => Session | undefined
  /** Whether to attach recall hints to new prompts. Default: on. */
  hints?: () => boolean
  /** A cheaper model for summaries and topic grouping. Falls back to the chat's model when empty or failing. */
  compactModel?: () => string
}

/**
 * Just-in-time recall plus compaction for chats kept in a session store.
 * Recall: every turn is indexed; the model can search it with the `recall` tool, and strong matches
 * for a new prompt are attached after the prompt as one-line hints.
 * Compaction: older turns are replaced by a summary; they stay searchable.
 */
export class ContextMemory {
  readonly index: TurnIndex

  constructor(private o: ContextMemoryOptions) { this.index = new TurnIndex(o.store) }

  private history(id: string): Message[] { return this.o.session?.(id)?.history ?? this.o.store.loadMessages(id) }

  /** Indexes a chat's turns. Best effort: never throws. */
  indexTurns(id: string, msgs?: Message[]): number {
    try { return this.index.indexSession(id, msgs ?? this.history(id)) } catch { return 0 }
  }

  /**
   * Searches earlier turns. With `chat`, searches chats with that name in any folder and ignores the scope;
   * returns a message naming recent chats when none matches. `skipRecent` leaves out the newest turns of the current chat.
   */
  search(id: string, query: string, scope: RecallScope, limit: number, skipRecent = 0, chat?: string): RecallHit[] | string {
    const msgs = this.history(id)
    this.indexTurns(id, msgs)
    const inCtx = this.index.liveTurns(id, msgs)
    const recent = new Set(skipRecent ? inCtx.slice(-skipRecent) : [])
    let only: string[] | undefined
    if (chat?.trim()) {
      const all = this.index.sessionsNamed(chat)
      const others = all.filter((r) => r.id !== id)
      const named = others.length ? others : all
      if (!named.length) {
        const recentChats = this.o.store.listSessions().slice(0, 30).map((r) => `"${r.title}"`).join(', ')
        return `No chat is named "${chat}". Recent chats: ${recentChats}. Retry with one of these names, or search with scope "all".`
      }
      only = named.slice(0, 20).map((r) => r.id)
      for (const sid of only) if (sid !== id) this.indexTurns(sid)
    }
    return this.index.search(query, scope, id, limit + recent.size, only)
      .filter((h) => !(h.current && recent.has(h.turn)))
      .map((h) => (h.current ? { ...h, inContext: inCtx.includes(h.turn) } : h))
      .slice(0, limit)
  }

  /** The `recall` tool for one chat. Add it to the session's tools, and RECALL_PROMPT to its system prompt. */
  tool(id: string): ToolDef { return recallTool((q, scope, limit, chat) => this.search(id, q, scope, limit, 0, chat)) }

  /** Hints for a new prompt: pointers to strongly matching earlier turns, or '' when there are none or hints are off. */
  hints(id: string, prompt: string): string {
    if (this.o.hints?.() === false || !prompt.trim()) return ''
    try {
      const hits = this.search(id, prompt, 'folder', 12, HINT_SKIP_RECENT)
      return typeof hits === 'string' ? '' : formatHints(pickHints(prompt, hits))
    } catch { return '' }
  }

  /** Estimated tokens of the session's context. */
  tokens(session: Session): number { return estimateTokens(session.messages) }

  private compactAdapter(session: Session, adapter: ModelAdapter, model: string, onEvent: (e: any) => void): ModelAdapter {
    return {
      stream: async function* (req, signal) {
        for await (const d of adapter.stream(req, signal)) {
          if (d.type === 'usage') onEvent({ kind: 'usage', agentId: COMPACT_ID, model: servedModel(model, d.model), prompt: d.prompt, completion: d.completion, cached: d.cached, cacheWrite: d.cacheWrite })
          yield d
        }
      }
    }
  }

  /** Runs `fn` with the compaction model, then with the chat's model if that fails. */
  private async withCompactModel<T>(session: Session, a: { adapter: ModelAdapter; model: string; hooks: { onEvent(e: any): void } }, fn: (adapter: ModelAdapter, model: string) => Promise<T>): Promise<{ value: T; model: string }> {
    const first = this.o.compactModel?.().trim() || a.model
    const run = async (m: string) => ({ value: await fn(this.compactAdapter(session, a.adapter, m, (e) => a.hooks.onEvent(e)), m), model: m })
    try { return await run(first) } catch (e) {
      if (first === a.model) throw e
      return run(a.model)
    }
  }

  /** Groups the chat's turns by topic, for a UI that lets the user pick what to keep, summarize or drop. */
  async analyze(session: Session, signal?: AbortSignal): Promise<TurnAnalysis> {
    return session.exclusive(async (a) => {
      const turns = splitHistoryTurns(a.history)
      let model = this.o.compactModel?.().trim() || a.model
      let r = await clusterTurns(this.compactAdapter(session, a.adapter, model, (e) => a.hooks.onEvent(e)), model, turns, signal)
      if (r.method === 'lexical' && turns.length > 2 && model !== a.model) {
        model = a.model
        r = await clusterTurns(this.compactAdapter(session, a.adapter, model, (e) => a.hooks.onEvent(e)), model, turns, signal)
      }
      return {
        turns: turns.map((t) => ({ index: t.index, user: t.user, answer: t.answer, tools: t.tools, tokens: estimateTokens(t.messages) })),
        clusters: r.clusters, method: r.method, model, hasPriorSummary: !!priorSummary(a.history), tokens: estimateTokens(session.messages)
      }
    })
  }

  /**
   * Compacts a chat: turns in `plan.summarize` become one summary, turns in neither list are dropped,
   * turns in `plan.keep` stay as they are. Saves the new history. Removed turns stay searchable.
   * Throws when the session is busy.
   */
  async compact(id: string, session: Session, plan: CompactPlan, signal?: AbortSignal): Promise<CompactResult> {
    const map = this.index.liveTurns(id, session.history)
    this.indexTurns(id, session.history)
    const before = this.tokens(session)
    const r = await session.exclusive(async (a) => {
      const turns = splitHistoryTurns(a.history)
      const { kept, summarized, dropped } = planTurns(turns, plan)
      const keptIdx = kept.map((t) => t.index)
      if (!summarized.length && !dropped.length) return null
      const s = await this.withCompactModel(session, a, (ad, m) => summarizeTurns(ad, m, summarized, priorSummary(a.history), signal))
      a.replace(applyCompaction(a.history, s.value, keptIdx, removedCount(a.history) + summarized.length + dropped.length))
      return { summary: s.value, model: s.model, kept: keptIdx, summarized: summarized.map((t) => t.index), dropped: dropped.map((t) => t.index) }
    })
    if (!r) return { before, after: before, summarized: 0, dropped: 0, summary: '', model: '', keptTurns: map, compactedTurns: [] }
    this.index.setTurnMap(id, r.kept.map((i) => map[i]))
    this.o.store.saveMessages(id, session.history)
    return {
      before, after: this.tokens(session), summarized: r.summarized.length, dropped: r.dropped.length, summary: r.summary, model: r.model,
      keptTurns: r.kept.map((i) => map[i]), compactedTurns: [...r.summarized, ...r.dropped].map((i) => map[i])
    }
  }

  /** Whether to compact now. Waits while the provider's prompt cache is likely warm, unless the context is at the hard limit. */
  shouldCompact(session: Session, settings: AutoCompactSettings, idleMs: number): AutoCompactDecision {
    return autoCompactDecision({ ...settings, tokens: this.tokens(session), idleMs, turns: splitHistoryTurns(session.history) })
  }

  /**
   * Sends a prompt with memory applied: compacts first when `auto` says so, attaches recall hints after
   * the prompt, then saves and indexes the chat. A prompt sent while the session is busy is queued without hints.
   */
  async send(id: string, session: Session, prompt: string, o: { attachments?: Attachment[]; qid?: string; auto?: AutoCompactSettings; onCompact?: (r: CompactResult) => void; onError?: (e: unknown) => void } = {}): Promise<SendResult> {
    if (session.isBusy) return session.send(prompt, o.attachments ?? [], o.qid)
    if (o.auto && prompt) {
      try {
        const idleMs = Date.now() - (this.o.store.getSession(id)?.updated_at ?? Date.now())
        const d = this.shouldCompact(session, o.auto, idleMs)
        if (d.compact) {
          const r = await this.compact(id, session, keepLastPlan(splitHistoryTurns(session.history).length, o.auto.keepRecent))
          if (r.model) o.onCompact?.(r)
        }
      } catch (e) { o.onError?.(e) }
    }
    try {
      return await session.send(prompt, o.attachments ?? [], o.qid, this.hints(id, prompt))
    } finally {
      this.o.store.saveMessages(id, session.history)
      this.indexTurns(id, session.history)
      this.o.store.touchSession(id)
    }
  }

  /** Indexes chats saved before this card was in use, a few at a time. Returns the number of chats indexed. */
  async backfill(batch = 20, pauseMs = 50): Promise<number> {
    this.index.prune()
    const rows = this.index.unindexed()
    for (let i = 0; i < rows.length; i++) {
      try { this.index.indexSession(rows[i].id, undefined, rows[i].updated_at) } catch { /* skip a chat that cannot be read */ }
      if ((i + 1) % batch === 0) await new Promise((r) => setTimeout(r, pauseMs))
    }
    return rows.length
  }
}
