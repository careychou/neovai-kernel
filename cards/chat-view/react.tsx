import { createContext, useCallback, useContext, useEffect, useRef, useState, type ComponentType, type ReactNode, type Ref, type RefObject } from 'react'
import { linkMarkdown, linkSegments, type LinkRule } from '../agent-loop/links'
import { groupRows, groupState, isRunning, peek, stepFailed, technicalLabel, toolLabel, type Item, type ToolItem } from './items'
import { ATTACH_LIMITS, classify, clipText, fitSize, type Attachment } from './attach'

/** Renders markdown text. The app passes its own so links and sanitizing follow its rules. */
export type MarkdownView = ComponentType<{ text: string }>

const Plain: MarkdownView = ({ text }) => <div className="cv-plain">{text}</div>

/** The model's reasoning: open while it streams, then folded to a one-line peek. */
export function ThoughtBlock({ text, live, Markdown = Plain }: { text: string; live?: boolean; Markdown?: MarkdownView }) {
  const [manual, setManual] = useState<boolean | null>(null)
  const open = manual ?? !!live
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open && live && body.current) body.current.scrollTop = body.current.scrollHeight
  }, [text, open, live])
  if (!text.trim()) return null
  return (
    <div className="cv-thought">
      <button className="cv-thought-head" onClick={() => setManual(!open)} aria-expanded={open}>
        <span className="cv-chev">{open ? '▾' : '▸'}</span>
        {live
          ? <span className="cv-thinking">Thinking<span className="cv-dots"><i /><i /><i /></span></span>
          : <span>Thought</span>}
        {!open && <span className="cv-peek">{peek(text)}</span>}
      </button>
      {open && <div className="cv-thought-body" ref={body}><Markdown text={text} /></div>}
    </div>
  )
}

/** Whether tool rows show plain-language labels (default) or the raw tool name and argument. */
const Technical = createContext(false)
/** The app's markdown renderer, so nested sub-agent messages draw like the main ones. */
const MarkdownCtx = createContext<MarkdownView>(Plain)
const labelOf = (t: ToolItem, technical: boolean) => (technical ? technicalLabel(t) : toolLabel(t))

/** What a step was given, minus its plain-language `intent`: a shell command reads as `$ command`. */
export function stepInput(args: string): string {
  let a: unknown
  try { a = JSON.parse(args) } catch { return args.trim() }
  if (!a || typeof a !== 'object' || Array.isArray(a)) return args.trim()
  const { intent: _intent, description: _d, ...rest } = a as Record<string, unknown>
  if (typeof rest.command === 'string') return `$ ${rest.command}`
  const keys = Object.keys(rest)
  if (keys.length === 0) return ''
  if (keys.length === 1 && typeof rest[keys[0]] === 'string') return `${keys[0]}: ${rest[keys[0]]}`
  return JSON.stringify(rest, null, 2)
}

/** Level three: the step's input and its output in one panel, each part scrolling on its own. */
export function ToolBody({ t }: { t: ToolItem }) {
  const input = stepInput(t.args)
  const output = t.output?.replace(/\s+$/, '')
  return (
    <div className="cv-detail">
      {input && <pre className="cv-detail-in">{input}</pre>}
      {output ? <pre className="cv-detail-out">{output}</pre>
        : t.ok === undefined ? <div className="cv-detail-note">Running…</div>
        : <div className="cv-detail-note">No output</div>}
    </div>
  )
}

const mark = (t: ToolItem) =>
  isRunning(t) ? <span className="cv-spin" /> : stepFailed(t) ? <span className="cv-bad">✗</span> : <span className="cv-ok">✓</span>

/** A sub-agent's work under its `task` step: its own steps and answer, drawn like the main chat. */
export function SubAgentBody({ t }: { t: ToolItem }) {
  const a = t.agent!
  const Markdown = useContext(MarkdownCtx)
  const technical = useContext(Technical)
  return (
    <div className="cv-agent">
      {a.items.length === 0 && a.status === 'running' && <div className="cv-detail-note">Starting…</div>}
      <MessageList items={a.items} Markdown={Markdown} technical={technical} />
      {a.status === 'cancelled' && <div className="cv-detail-note">Stopped</div>}
      {a.status === 'failed' && t.output && <div className="cv-error">{t.output.replace(/^Sub-agent failed: /, '')}</div>}
    </div>
  )
}

/** One tool call: a one-line row (plain words by default) that opens to its input and output. */
export function ToolRow({ t }: { t: ToolItem }) {
  const [open, setOpen] = useState(false)
  const technical = useContext(Technical)
  return (
    <div className={`cv-tool${isRunning(t) ? ' running' : ''}${t.agent ? ' agent' : ''}`}>
      <button className="cv-tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="cv-chev">{open ? '▾' : '›'}</span>
        <span className="cv-label">{labelOf(t, technical)}</span>
        {t.agent?.mode === 'background' && isRunning(t) && <span className="cv-dim cv-tag">in the background</span>}
        {mark(t)}
      </button>
      {open && (t.agent ? <SubAgentBody t={t} /> : <ToolBody t={t} />)}
    </div>
  )
}

/** Consecutive tool calls folded into one row: "<lead> and N other tool calls". */
export function ToolGroup({ items }: { items: ToolItem[] }) {
  const [open, setOpen] = useState(false)
  const { running, failed, lead } = groupState(items)
  const technical = useContext(Technical)
  const n = items.length - 1
  return (
    <div className={`cv-tool${running ? ' running' : ''}`}>
      <button className="cv-tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="cv-chev">{open ? '▾' : '›'}</span>
        <span className="cv-label">
          {labelOf(lead, technical)} <span className="cv-dim">and {n} other step{n === 1 ? '' : 's'}</span>
        </span>
        {running ? <span className="cv-spin" /> : failed > 0 ? <span className="cv-bad">✗ {failed}</span> : <span className="cv-ok">✓</span>}
      </button>
      {open && <div className="cv-group-body">{items.map((t) => <ToolRow key={t.callId} t={t} />)}</div>}
    </div>
  )
}

/**
 * The whole conversation: user and assistant messages, thoughts, tool rows and errors.
 * Tool rows have three levels: a summary row ("<step> and N other steps") opens to its steps in plain words,
 * and each step opens to what it was given and what came back. A step that handed work to a sub-agent opens to that
 * sub-agent's own steps and answer instead, nested the same way. Set `technical` to label steps with raw tool names.
 */
export function MessageList({ items, Markdown = Plain, technical = false, links }: { items: Item[]; Markdown?: MarkdownView; technical?: boolean; links?: LinkRule[] }) {
  let turn = 0
  return (
    <Technical.Provider value={technical}>
     <MarkdownCtx.Provider value={Markdown}>
      {groupRows(items).map((r, i) => {
        switch (r.kind) {
          case 'user': return <UserMessage key={i} item={r} turn={++turn} links={links} />
          case 'assistant': return <div key={i} className="cv-msg assistant"><Markdown text={linkMarkdown(r.text, links)} /></div>
          case 'reasoning': return <ThoughtBlock key={i} text={r.text} live={r.live} Markdown={Markdown} />
          case 'tool': return <ToolRow key={r.callId} t={r} />
          case 'tools': return <ToolGroup key={r.items[0].callId} items={r.items} />
          case 'error': return <div key={i} className="cv-error">{r.text}</div>
        }
      })}
     </MarkdownCtx.Provider>
    </Technical.Provider>
  )
}

/** Text with bare http(s) URLs and app link rules turned into links that open in a new window. */
export function Linked({ text, links }: { text: string; links?: LinkRule[] }) {
  return <>{linkSegments(text, links).map((p, i) => p.href
    ? <a key={i} className="cv-link" href={p.href} title={p.title} target="_blank" rel="noopener noreferrer">{p.text}</a>
    : p.text)}</>
}

/**
 * A breadcrumb rail of the user's turns along the right edge of a scrolling chat. Each tick shows "Turn N · prompt"
 * on hover and jumps to that turn on click; the turn in view is highlighted. Place it inside a positioned parent of
 * the scroll element; `deps` (usually the items) re-measures the ticks when the chat changes.
 */
export function TurnRail({ scrollRef, deps }: { scrollRef: RefObject<HTMLElement | null>; deps?: unknown }) {
  const [turns, setTurns] = useState<{ n: number; peek: string; top: number }[]>([])
  const [active, setActive] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  const nodes = () => Array.from(scrollRef.current?.querySelectorAll<HTMLElement>('[data-turn]') ?? [])
  const measure = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const h = Math.max(el.scrollHeight, 1)
    setTurns(nodes().map((n) => ({ n: Number(n.dataset.turn), peek: n.dataset.peek ?? '', top: offsetIn(n, el) / h })))
  }, [scrollRef])
  const track = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    let cur = 0
    for (const n of nodes()) if (offsetIn(n, el) <= el.scrollTop + 48) cur = Number(n.dataset.turn)
    setActive(cur || (nodes().length ? 1 : 0))
  }, [scrollRef])
  useEffect(() => { measure(); track() }, [deps, measure, track])
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => track()
    el.addEventListener('scroll', onScroll, { passive: true })
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { measure(); track() })
    ro?.observe(el)
    if (el.firstElementChild) ro?.observe(el.firstElementChild)
    return () => { el.removeEventListener('scroll', onScroll); ro?.disconnect() }
  }, [scrollRef, measure, track])
  if (turns.length < 2) return null
  const jump = (n: number) => {
    const el = scrollRef.current
    const t = nodes().find((x) => Number(x.dataset.turn) === n)
    if (el && t) el.scrollTo({ top: offsetIn(t, el) - 12, behavior: 'smooth' })
  }
  return (
    <nav className="cv-rail" aria-label="Conversation turns">
      {turns.map((t) => (
        <button key={t.n} type="button" className={`cv-tick${t.n === active ? ' on' : ''}`} style={{ top: `${(t.top * 100).toFixed(2)}%` }}
          aria-label={`Turn ${t.n}: ${t.peek}`} onClick={() => jump(t.n)} onMouseEnter={() => setHover(t.n)} onMouseLeave={() => setHover(null)}
          onFocus={() => setHover(t.n)} onBlur={() => setHover(null)}>
          {hover === t.n && <span className="cv-tip" role="tooltip"><b>Turn {t.n}</b> · {t.peek}</span>}
        </button>
      ))}
    </nav>
  )
}

function offsetIn(node: HTMLElement, container: HTMLElement): number {
  return node.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
}

/** A user message: its text, image thumbnails (click to open full size) and attached file names. */
export function UserMessage({ item, turn, links }: { item: Extract<Item, { kind: 'user' }>; turn?: number; links?: LinkRule[] }) {
  const [big, setBig] = useState<string | null>(null)
  return (
    <div className="cv-msg user" data-turn={turn} data-peek={turn ? peek(item.text || item.files?.join(', ') || 'Attachment') : undefined}>
      {(item.images?.length || item.files?.length) ? (
        <div className="cv-atts">
          {item.images?.map((u, k) => <img key={k} className="cv-thumb" src={u} alt="Attached image" onClick={() => setBig(u)} />)}
          {item.files?.map((f, k) => <span key={k} className="cv-file">📄 {f}</span>)}
        </div>
      ) : null}
      {item.text && <div><Linked text={item.text} links={links} /></div>}
      {big && <div className="cv-lightbox" onClick={() => setBig(null)}><img src={big} alt="Attached image, full size" /></div>}
    </div>
  )
}

const readAs = (f: Blob, how: 'url' | 'text') => new Promise<string>((ok, bad) => {
  const r = new FileReader()
  r.onload = () => ok(String(r.result))
  r.onerror = () => bad(r.error)
  how === 'url' ? r.readAsDataURL(f) : r.readAsText(f)
})

async function readImage(f: File): Promise<Attachment> {
  const bmp = await createImageBitmap(f)
  const { width, height } = fitSize(bmp.width, bmp.height)
  const fits = width === bmp.width && height === bmp.height
  if (fits && f.size <= ATTACH_LIMITS.keepImageBytes && /png|jpe?g|webp|gif/.test(f.type)) {
    bmp.close()
    return { kind: 'image', name: f.name, dataUrl: await readAs(f, 'url'), width, height }
  }
  const c = document.createElement('canvas')
  c.width = width; c.height = height
  c.getContext('2d')!.drawImage(bmp, 0, 0, width, height)
  bmp.close()
  const png = f.type === 'image/png' && width * height <= 1_000_000
  return { kind: 'image', name: f.name, dataUrl: c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.85), width, height }
}

/**
 * Turns picked, pasted or dropped files into attachments: images are downscaled in the window,
 * text files are read and cut to size. Files it cannot use come back in `skipped` with the reason.
 */
export async function readFiles(files: File[]): Promise<{ attachments: Attachment[]; skipped: string[] }> {
  const attachments: Attachment[] = []
  const skipped: string[] = []
  for (const f of files) {
    const name = f.name || (f.type.startsWith('image/') ? `pasted-image.${f.type.split('/')[1] || 'png'}` : 'pasted.txt')
    const kind = classify(name, f.type)
    if (!kind) { skipped.push(`${name}: this file type can't be attached (images and text files only)`); continue }
    if (f.size > ATTACH_LIMITS.maxFileBytes) { skipped.push(`${name}: larger than ${Math.round(ATTACH_LIMITS.maxFileBytes / 1e6)} MB`); continue }
    try {
      if (kind === 'image') attachments.push(await readImage(new File([f], name, { type: f.type })))
      else { const t = clipText(await readAs(f, 'text')); attachments.push({ kind: 'text', name, text: t.text, ...(t.note ? { note: t.note } : {}) }) }
    } catch (e) {
      skipped.push(`${name}: could not be read (${(e as Error)?.message ?? e})`)
    }
  }
  return { attachments, skipped }
}

export interface ComposerProps {
  value: string
  onChange(v: string): void
  /** Called with the trimmed text and the attachments; the composer clears its attachments after. */
  onSend(text: string, attachments: Attachment[]): void
  running?: boolean
  onStop?(): void
  placeholder?: string
  inputRef?: Ref<HTMLTextAreaElement>
  /** Set false for a chat whose agent cannot take files. */
  allowAttachments?: boolean
  /** Extra controls drawn left of Send. */
  extra?: ReactNode
  /** Shows a publish button next to attach (pair with the git-publish card); its steps should stream into the chat. */
  onPublish?(): void
  /** True while a publish runs: the button spins and is disabled. */
  publishing?: boolean
  publishTitle?: string
}

/** Paperclip icon for the attach button; draws in the current text colour. */
export function PaperclipIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  )
}

/** Publish icon for the publish button: a branch with an upload arrow. */
export function PublishIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="6" cy="6" r="2.5" />
      <path d="M6 8.5v7" />
      <path d="M6 15.5c0-4 3-5.5 7-5.5" />
      <path d="M18 21V11" />
      <path d="M14.5 14.5 18 11l3.5 3.5" />
    </svg>
  )
}

/** The standard chat input: text box, attach button, paste and drag-and-drop of images and files, Send/Stop. */
export function Composer({ value, onChange, onSend, running, onStop, placeholder, inputRef, allowAttachments = true, extra, onPublish, publishing, publishTitle }: ComposerProps) {
  const [atts, setAtts] = useState<Attachment[]>([])
  const [notes, setNotes] = useState<string[]>([])
  const [drag, setDrag] = useState(false)
  const picker = useRef<HTMLInputElement>(null)

  const add = async (files: File[]) => {
    if (!allowAttachments || !files.length) return
    const room = ATTACH_LIMITS.maxFiles - atts.length
    const { attachments, skipped } = await readFiles(files.slice(0, Math.max(0, room)))
    if (files.length > room) skipped.push(`Only ${ATTACH_LIMITS.maxFiles} files can be attached to one message.`)
    setAtts((a) => [...a, ...attachments].slice(0, ATTACH_LIMITS.maxFiles))
    setNotes(skipped)
  }
  const canSend = !running && (!!value.trim() || atts.length > 0)
  const send = () => {
    if (!canSend) return
    onSend(value.trim(), atts)
    setAtts([]); setNotes([])
  }

  return (
    <div
      className={`cv-composer${drag ? ' drag' : ''}`}
      onDragOver={(e) => { if (allowAttachments && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true) } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(false) }}
      onDrop={(e) => { if (!allowAttachments) return; e.preventDefault(); setDrag(false); void add([...e.dataTransfer.files]) }}
    >
      {atts.length > 0 && (
        <div className="cv-chips">
          {atts.map((a, k) => (
            <span key={k} className="cv-chip" title={a.kind === 'image' ? `${a.name} (${a.width}×${a.height})` : a.note ? `${a.name}: ${a.note}` : a.name}>
              {a.kind === 'image' ? <img src={a.dataUrl} alt="" /> : <span className="cv-chip-icon">📄</span>}
              <span className="cv-chip-name">{a.name}</span>
              <button aria-label={`Remove ${a.name}`} onClick={() => setAtts((x) => x.filter((_, i) => i !== k))}>×</button>
            </span>
          ))}
        </div>
      )}
      {notes.length > 0 && <div className="cv-attnote">{notes.join(' · ')}</div>}
      <div className="cv-row">
        {allowAttachments && (
          <>
            <button className="cv-attach" title="Attach images or files (or paste / drop them here)" aria-label="Attach files" onClick={() => picker.current?.click()} disabled={atts.length >= ATTACH_LIMITS.maxFiles}><PaperclipIcon /></button>
            <input ref={picker} type="file" multiple hidden onChange={(e) => { void add([...(e.target.files ?? [])]); e.target.value = '' }} />
          </>
        )}
        {onPublish && (
          <button className={`cv-attach cv-publish${publishing ? ' busy' : ''}`} title={publishing ? 'Publishing…' : publishTitle ?? 'Publish: commit and push all changes to the repository'} aria-label="Publish changes to the repository" onClick={onPublish} disabled={publishing || running}>
            {publishing ? <span className="cv-spin" /> : <PublishIcon />}
          </button>
        )}
        <textarea
          ref={inputRef}
          value={value}
          placeholder={placeholder}
          rows={3}
          onChange={(e) => onChange(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files]
            if (allowAttachments && files.length) { e.preventDefault(); void add(files) }
          }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() } }}
        />
        {extra}
        {running
          ? <button className="danger" onClick={onStop}>Stop</button>
          : <button className="primary" disabled={!canSend} onClick={send}>Send</button>}
      </div>
      {drag && <div className="cv-dropzone">Drop images or files to attach</div>}
    </div>
  )
}

export interface SessionRowView { id: string; title: string; busy?: boolean }

export interface SessionListProps {
  sessions: SessionRowView[]
  active?: string | null
  onSelect(id: string): void
  /** Called with the new, trimmed title; omit to hide renaming. */
  onRename?(id: string, title: string): void
  onDelete?(id: string): void
  onNew?(): void
  newLabel?: string
  /** Title shown for a session that has none yet. */
  untitled?: string
}

/** Pencil icon for rename. */
export function PencilIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  )
}

/** The session history column: one row per chat, with rename (double-click or the pencil; Enter saves, Escape cancels) and delete. */
export function SessionList({ sessions, active, onSelect, onRename, onDelete, onNew, newLabel = 'New request', untitled = 'New request' }: SessionListProps) {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const start = (s: SessionRowView) => { if (!onRename) return; setEditing(s.id); setDraft(s.title && s.title !== 'New chat' ? s.title : '') }
  const commit = (id: string) => {
    const t = draft.replace(/\s+/g, ' ').trim()
    const was = sessions.find((s) => s.id === id)?.title
    setEditing(null)
    if (t && t !== was) onRename?.(id, t.slice(0, 120))
  }
  return (
    <div className="cv-sessions">
      {onNew && <button className="primary cv-new" onClick={onNew}>{newLabel}</button>}
      {sessions.map((s) => (
        <div key={s.id} className={`cv-session${s.id === active ? ' active' : ''}${s.busy ? ' busy' : ''}`} onClick={() => editing !== s.id && onSelect(s.id)} onDoubleClick={() => start(s)}>
          {editing === s.id ? (
            <input
              className="cv-rename"
              autoFocus
              value={draft}
              aria-label="Session name"
              onChange={(e) => setDraft(e.target.value)}
              onFocus={(e) => e.target.select()}
              onBlur={() => commit(s.id)}
              onKeyDown={(e) => { if (e.key === 'Enter') commit(s.id); else if (e.key === 'Escape') setEditing(null) }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <>
              {s.busy && <span className="cv-spin cv-session-spin" />}
              <span className="cv-session-title" title={s.title}>{!s.title || s.title === 'New chat' ? untitled : s.title}</span>
              {onRename && <button className="cv-session-act" title="Rename" aria-label="Rename session" onClick={(e) => { e.stopPropagation(); start(s) }}><PencilIcon /></button>}
              {onDelete && <button className="cv-session-act del" title="Delete" aria-label="Delete session" onClick={(e) => { e.stopPropagation(); onDelete(s.id) }}>×</button>}
            </>
          )}
        </div>
      ))}
    </div>
  )
}
