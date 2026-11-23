/** An app-supplied link: text matching `pattern` becomes a link to `href(match)`. Example: ticket keys to a tracker. */
export interface LinkRule {
  pattern: RegExp
  href: (match: string) => string
  /** Tooltip for the link; defaults to the href. */
  title?: (match: string) => string
}

/** A piece of text, either plain or a link. */
export type LinkSegment = { text: string; href?: string; title?: string }

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}]/g

function allMatches(text: string, re: RegExp): { start: number; end: number }[] {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
  const out: { start: number; end: number }[] = []
  for (const m of text.matchAll(g)) if (m[0]) out.push({ start: m.index!, end: m.index! + m[0].length })
  return out
}

/** Splits text into plain and linked pieces: bare http(s) URLs always, plus each app rule. Earlier, longer matches win. */
export function linkSegments(text: string, rules: LinkRule[] = []): LinkSegment[] {
  type Hit = { start: number; end: number; href: string; title?: string }
  const hits: Hit[] = allMatches(text, URL_RE).map((m) => ({ ...m, href: text.slice(m.start, m.end) }))
  for (const r of rules) for (const m of allMatches(text, r.pattern)) {
    const s = text.slice(m.start, m.end)
    hits.push({ ...m, href: r.href(s), title: r.title?.(s) })
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end)
  const out: LinkSegment[] = []
  let at = 0
  for (const h of hits) {
    if (h.start < at) continue
    if (h.start > at) out.push({ text: text.slice(at, h.start) })
    out.push({ text: text.slice(h.start, h.end), href: h.href, title: h.title ?? h.href })
    at = h.end
  }
  if (at < text.length || !out.length) out.push({ text: text.slice(at) })
  return out
}

/**
 * Turns app-rule matches in markdown into markdown links, leaving code, existing links and bare URLs alone
 * (markdown renderers already link bare URLs).
 */
export function linkMarkdown(md: string, rules: LinkRule[] = []): string {
  if (!rules.length) return md
  // Fenced code, inline code, existing [text](url) links, <autolinks> and bare URLs are kept as they are.
  const keep = /```[\s\S]*?(?:```|$)|`[^`\n]*`|!?\[[^\]\n]*\]\([^)\n]*\)|<https?:[^>\s]*>|\bhttps?:\/\/[^\s<>)]+/g
  let out = ''
  let at = 0
  const linkPart = (s: string) => linkSegments(s, rules).map((p) => (p.href && !/^https?:\/\//.test(p.text) ? `[${p.text}](${p.href})` : p.text)).join('')
  for (const m of md.matchAll(keep)) {
    out += linkPart(md.slice(at, m.index!)) + m[0]
    at = m.index! + m[0].length
  }
  return out + linkPart(md.slice(at))
}
