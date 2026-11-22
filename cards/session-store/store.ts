import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Message } from '../agent-loop/types'

export interface UsageRec { ts: number; session_id: string; agent_id: string; model: string; prompt: number; cached: number; cache_write: number; completion: number }
export interface SessionRow { id: string; title: string; cwd: string; model: string; created_at: number; updated_at: number; reasoning?: string | null }

/** SQLite persistence for chats: the session list, each chat's message history, its UI log, and token usage. */
export class Store {
  private db: DatabaseSync
  constructor(dir: string, file = 'neovai.db') {
    fs.mkdirSync(dir, { recursive: true })
    this.db = new DatabaseSync(path.join(dir, file))
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, model TEXT, created_at INTEGER, updated_at INTEGER, reasoning TEXT);
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, seq INTEGER, content_json TEXT);
      CREATE TABLE IF NOT EXISTS ui_items (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, item_json TEXT);
      CREATE INDEX IF NOT EXISTS ix_msg ON messages(session_id, seq);
      CREATE INDEX IF NOT EXISTS ix_ui ON ui_items(session_id, id);
      CREATE TABLE IF NOT EXISTS usage (ts INTEGER, session_id TEXT, agent_id TEXT, model TEXT, prompt INTEGER, cached INTEGER, cache_write INTEGER, completion INTEGER);
      CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);
    `)
  }

  close() { this.db.close() }

  addUsage(u: UsageRec) {
    this.db.prepare('INSERT INTO usage (ts, session_id, agent_id, model, prompt, cached, cache_write, completion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(u.ts, u.session_id, u.agent_id, u.model, u.prompt, u.cached, u.cache_write, u.completion)
  }
  /** Usage records since `ts`, with the chat title (null once the chat is deleted). */
  usageSince(ts: number): Array<UsageRec & { title: string | null }> {
    return this.db.prepare('SELECT u.*, s.title AS title FROM usage u LEFT JOIN sessions s ON s.id = u.session_id WHERE u.ts >= ? ORDER BY u.ts').all(ts) as any
  }

  /** Most recently used first. */
  listSessions(): SessionRow[] {
    return this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 1000').all() as unknown as SessionRow[]
  }
  getSession(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as SessionRow | undefined
  }
  createSession(r: SessionRow) {
    this.db.prepare('INSERT INTO sessions (id, title, cwd, model, created_at, updated_at, reasoning) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(r.id, r.title, r.cwd, r.model, r.created_at, r.updated_at, r.reasoning ?? null)
  }
  /** Changes chat settings; does not move `updated_at`, which tracks the last turn (see touchSession). */
  updateSession(id: string, patch: Partial<Pick<SessionRow, 'title' | 'model' | 'cwd' | 'reasoning'>>) {
    const cur = this.getSession(id)
    if (!cur) return
    const n = { ...cur, ...patch }
    this.db.prepare('UPDATE sessions SET title = ?, model = ?, cwd = ?, reasoning = ? WHERE id = ?').run(n.title, n.model, n.cwd, n.reasoning ?? null, id)
  }
  /** Records that a turn finished now. */
  touchSession(id: string, at = Date.now()) { this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(at, id) }
  /** Deletes a chat with its messages and UI log. Usage records are kept. */
  deleteSession(id: string) {
    for (const t of ['messages', 'ui_items']) this.db.prepare(`DELETE FROM ${t} WHERE session_id = ?`).run(id)
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  /** Replaces the stored message history (system message excluded). */
  saveMessages(sessionId: string, msgs: Message[]) {
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId)
      const ins = this.db.prepare('INSERT INTO messages (session_id, seq, content_json) VALUES (?, ?, ?)')
      msgs.forEach((m, i) => ins.run(sessionId, i, JSON.stringify(m)))
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }
  loadMessages(sessionId: string): Message[] {
    return (this.db.prepare('SELECT content_json FROM messages WHERE session_id = ? ORDER BY seq').all(sessionId) as any[]).map((r) => JSON.parse(r.content_json))
  }

  saveUiItems(sessionId: string, items: unknown[]) {
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM ui_items WHERE session_id = ?').run(sessionId)
      const ins = this.db.prepare('INSERT INTO ui_items (session_id, item_json) VALUES (?, ?)')
      for (const it of items) ins.run(sessionId, JSON.stringify(it))
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }
  loadUiItems(sessionId: string): unknown[] {
    return (this.db.prepare('SELECT item_json FROM ui_items WHERE session_id = ? ORDER BY id').all(sessionId) as any[]).map((r) => JSON.parse(r.item_json))
  }
}
