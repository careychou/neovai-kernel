import { useEffect, useRef, useState, type ComponentType } from 'react'
import { groupRows, groupState, peek, prettyArgs, toolLabel, type Item, type ToolItem } from './items'

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

/** One tool call: a quiet one-line row that expands to its arguments and output. */
export function ToolRow({ t }: { t: ToolItem }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`cv-tool${t.ok === undefined ? ' running' : ''}`}>
      <button className="cv-tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="cv-chev">{open ? '▾' : '›'}</span>
        <span className="cv-label">{toolLabel(t)}</span>
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
  const n = items.length - 1
  return (
    <div className={`cv-tool${running ? ' running' : ''}`}>
      <button className="cv-tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="cv-chev">{open ? '▾' : '›'}</span>
        <span className="cv-label">
          {toolLabel(lead)} <span className="cv-dim">and {n} other tool call{n === 1 ? '' : 's'}</span>
        </span>
        {running ? <span className="cv-spin" /> : failed > 0 ? <span className="cv-bad">✗ {failed}</span> : <span className="cv-ok">✓</span>}
      </button>
      {open && <div className="cv-group-body">{items.map((t) => <ToolRow key={t.callId} t={t} />)}</div>}
    </div>
  )
}

/** The whole conversation: user and assistant messages, thoughts, tool rows and errors. */
export function MessageList({ items, Markdown = Plain }: { items: Item[]; Markdown?: MarkdownView }) {
  return (
    <>
      {groupRows(items).map((r, i) => {
        switch (r.kind) {
          case 'user': return <div key={i} className="cv-msg user">{r.text}</div>
          case 'assistant': return <div key={i} className="cv-msg assistant"><Markdown text={r.text} /></div>
          case 'reasoning': return <ThoughtBlock key={i} text={r.text} live={r.live} Markdown={Markdown} />
          case 'tool': return <ToolRow key={r.callId} t={r} />
          case 'tools': return <ToolGroup key={r.items[0].callId} items={r.items} />
          case 'error': return <div key={i} className="cv-error">{r.text}</div>
        }
      })}
    </>
  )
}
