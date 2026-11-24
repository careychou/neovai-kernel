import type { DatabaseSync } from 'node:sqlite'
import type { Message } from '../agent-loop/types'
import type { Store, SessionRow } from '../session-store/store'
import { liveTurnMap, splitHistoryTurns } from './compact'
import { entryOf, ftsQuery, type RecallHit, type RecallScope } from './recall'

/**
 * Keyword index of every chat turn, kept in the session store's database in tables this card owns.
 * A turn keeps its original number after compaction removes it from the history, so it stays searchable.
 */
export class TurnIndex {
  private db: DatabaseSync

  constructor(private store: Store) {
    this.db = store.database
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS turn_index (id INTEGER PRIMARY KEY, session_id TEXT, turn INTEGER, user_text TEXT, answer_text TEXT, tools TEXT, ts INTEGER, UNIQUE (session_id, turn));
      CREATE VIRTUAL TABLE IF NOT EXISTS turn_fts USING fts5(user_text, answer_text, tools, content='turn_index', content_rowid='id', tokenize='porter unicode61');
      CREATE TRIGGER IF NOT EXISTS turn_index_ai AFTER INSERT ON turn_index BEGIN
        INSERT INTO turn_fts (rowid, user_text, answer_text, tools) VALUES (new.id, new.user_text, new.answer_text, new.tools);
      END;
      CREATE TRIGGER IF NOT EXISTS turn_index_ad AFTER DELETE ON turn_index BEGIN
        INSERT INTO turn_fts (turn_fts, rowid, user_text, answer_text, tools) VALUES ('delete', old.id, old.user_text, old.answer_text, old.tools);
      END;
      CREATE TABLE IF NOT EXISTS turn_maps (session_id TEXT PRIMARY KEY, map TEXT);
    `)
  }

  /** Original turn numbers of the turns the last compaction kept, or null if the chat was never compacted. */
  turnMap(id: string): number[] | null {
    const r = this.db.prepare('SELECT map FROM turn_maps WHERE session_id = ?').get(id) as { map: string } | undefined
    try { return r ? JSON.parse(r.map) : null } catch { return null }
  }
  setTurnMap(id: string, map: number[]) {
    this.db.prepare('INSERT INTO turn_maps (session_id, map) VALUES (?, ?) ON CONFLICT (session_id) DO UPDATE SET map = excluded.map').run(id, JSON.stringify(map))
  }
  /** Original turn number of each turn in `msgs`. */
  liveTurns(id: string, msgs: Message[]): number[] { return liveTurnMap(splitHistoryTurns(msgs).length, this.turnMap(id)) }

  /** Indexes new and changed turns of a chat. Rows of turns no longer in the history are kept. Returns rows written. */
  indexSession(id: string, msgs: Message[] = this.store.loadMessages(id), ts = Date.now()): number {
    if (!this.store.getSession(id)) return 0
    const turns = splitHistoryTurns(msgs)
    const ui = liveTurnMap(turns.length, this.turnMap(id))
    const have = new Map((this.db.prepare('SELECT id, turn, user_text, answer_text, tools FROM turn_index WHERE session_id = ?').all(id) as any[]).map((r) => [r.turn as number, r]))
    let n = 0
    for (const t of turns) {
      const e = entryOf(t, ui[t.index], ts)
      if (!e) continue
      const old = have.get(e.turn)
      if (old && old.user_text === e.user && old.answer_text === e.answer && old.tools === e.tools) continue
      if (old) this.db.prepare('DELETE FROM turn_index WHERE id = ?').run(old.id)
      this.db.prepare('INSERT INTO turn_index (session_id, turn, user_text, answer_text, tools, ts) VALUES (?, ?, ?, ?, ?, ?)').run(id, e.turn, e.user, e.answer, e.tools, e.ts)
      n++
    }
    return n
  }

  /** Removes a chat from the index. Call when the chat is deleted. */
  forget(id: string) {
    this.db.prepare('DELETE FROM turn_index WHERE session_id = ?').run(id)
    this.db.prepare('DELETE FROM turn_maps WHERE session_id = ?').run(id)
  }
  /** Removes index rows of chats that no longer exist. Returns rows removed. */
  prune(): number {
    this.db.prepare('DELETE FROM turn_maps WHERE session_id NOT IN (SELECT id FROM sessions)').run()
    return Number(this.db.prepare('DELETE FROM turn_index WHERE session_id NOT IN (SELECT id FROM sessions)').run().changes)
  }
  /** Chats that have messages but no index rows yet. */
  unindexed(): Array<{ id: string; updated_at: number }> {
    return this.db.prepare('SELECT id, updated_at FROM sessions WHERE id IN (SELECT DISTINCT session_id FROM messages) AND id NOT IN (SELECT DISTINCT session_id FROM turn_index)').all() as any
  }

  /** Chats whose title contains `name` (case-insensitive), newest first. Exact title matches win when there are any. */
  sessionsNamed(name: string): SessionRow[] {
    const q = name.trim().toLowerCase()
    if (!q) return []
    const rows = this.store.listSessions().filter((r) => (r.title ?? '').toLowerCase().includes(q))
    const exact = rows.filter((r) => (r.title ?? '').trim().toLowerCase() === q)
    return exact.length ? exact : rows
  }

  /**
   * Best matching turns for a keyword query. Scope: this chat, chats of the same folder, or all chats.
   * `only` limits the search to the given chats and ignores the scope.
   */
  search(query: string, scope: RecallScope, sessionId: string, limit = 5, only?: string[]): RecallHit[] {
    const match = ftsQuery(query)
    if (!match || (only && !only.length)) return []
    const args: Array<string | number> = [match]
    let cond = ''
    if (only) { cond = `AND t.session_id IN (${only.map(() => '?').join(',')})`; args.push(...only) }
    else if (scope === 'session') { cond = 'AND t.session_id = ?'; args.push(sessionId) }
    else if (scope === 'folder') { cond = 'AND s.cwd = ?'; args.push(this.store.getSession(sessionId)?.cwd ?? '') }
    args.push(Math.min(50, Math.max(1, Math.floor(limit))))
    const rows = this.db.prepare(`SELECT t.session_id, t.turn, t.user_text, t.answer_text, t.tools, t.ts, s.title, s.cwd
      FROM turn_fts JOIN turn_index t ON t.id = turn_fts.rowid JOIN sessions s ON s.id = t.session_id
      WHERE turn_fts MATCH ? ${cond} ORDER BY bm25(turn_fts, 2.0, 1.0, 0.5), t.ts DESC LIMIT ?`).all(...args) as any[]
    return rows.map((r) => ({ sessionId: r.session_id, turn: r.turn, user: r.user_text, answer: r.answer_text, tools: r.tools, ts: r.ts, title: r.title, cwd: r.cwd, current: r.session_id === sessionId }))
  }
}
