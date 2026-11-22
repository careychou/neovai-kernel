import { createContext, useContext, useEffect, useRef, useState, type ComponentType, type ReactNode, type Ref } from 'react'
import { groupRows, groupState, peek, prettyArgs, technicalLabel, toolLabel, type Item, type ToolItem } from './items'
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
const labelOf = (t: ToolItem, technical: boolean) => (technical ? technicalLabel(t) : toolLabel(t))

function ToolBody({ t }: { t: ToolItem }) {
  return (
    <div className="cv-tool-body">
      <pre className="cv-code">{prettyArgs(t.args)}</pre>
      {t.output !== undefined && <pre className="cv-code cv-out">{t.output}</pre>}
    </div>
  )
}

const mark = (t: ToolItem) =>
  t.ok === undefined ? <span className="cv-spin" /> : t.ok ? <span className="cv-ok">✓</span> : <span className="cv-bad">✗</span>

/** One tool call: a quiet one-line row. Plain rows stop here; technical rows expand to arguments and output. */
export function ToolRow({ t }: { t: ToolItem }) {
  const [open, setOpen] = useState(false)
  const technical = useContext(Technical)
  if (!technical) {
    return (
      <div className={`cv-tool${t.ok === undefined ? ' running' : ''}`}>
        <div className="cv-tool-head cv-plainhead">
          <span className="cv-label">{toolLabel(t)}</span>
          {mark(t)}
        </div>
      </div>
    )
  }
  return (
    <div className={`cv-tool${t.ok === undefined ? ' running' : ''}`}>
      <button className="cv-tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="cv-chev">{open ? '▾' : '›'}</span>
        <span className="cv-label">{technicalLabel(t)}</span>
        {mark(t)}
      </button>
      {open && <ToolBody t={t} />}
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
 * Tool rows read in plain words by default, two levels at most: a group row opens to its steps, and steps do not open.
 * Set `technical` for developer views: raw tool names, and each row expands to its arguments and output.
 */
export function MessageList({ items, Markdown = Plain, technical = false }: { items: Item[]; Markdown?: MarkdownView; technical?: boolean }) {
  return (
    <Technical.Provider value={technical}>
      {groupRows(items).map((r, i) => {
        switch (r.kind) {
          case 'user': return <UserMessage key={i} item={r} />
          case 'assistant': return <div key={i} className="cv-msg assistant"><Markdown text={r.text} /></div>
          case 'reasoning': return <ThoughtBlock key={i} text={r.text} live={r.live} Markdown={Markdown} />
          case 'tool': return <ToolRow key={r.callId} t={r} />
          case 'tools': return <ToolGroup key={r.items[0].callId} items={r.items} />
          case 'error': return <div key={i} className="cv-error">{r.text}</div>
        }
      })}
    </Technical.Provider>
  )
}

/** A user message: its text, image thumbnails (click to open full size) and attached file names. */
export function UserMessage({ item }: { item: Extract<Item, { kind: 'user' }> }) {
  const [big, setBig] = useState<string | null>(null)
  return (
    <div className="cv-msg user">
      {(item.images?.length || item.files?.length) ? (
        <div className="cv-atts">
          {item.images?.map((u, k) => <img key={k} className="cv-thumb" src={u} alt="Attached image" onClick={() => setBig(u)} />)}
          {item.files?.map((f, k) => <span key={k} className="cv-file">📄 {f}</span>)}
        </div>
      ) : null}
      {item.text && <div>{item.text}</div>}
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
}

/** The standard chat input: text box, attach button, paste and drag-and-drop of images and files, Send/Stop. */
export function Composer({ value, onChange, onSend, running, onStop, placeholder, inputRef, allowAttachments = true, extra }: ComposerProps) {
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
            <button className="cv-attach" title="Attach images or files (or paste / drop them here)" aria-label="Attach files" onClick={() => picker.current?.click()} disabled={atts.length >= ATTACH_LIMITS.maxFiles}>＋</button>
            <input ref={picker} type="file" multiple hidden onChange={(e) => { void add([...(e.target.files ?? [])]); e.target.value = '' }} />
          </>
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
