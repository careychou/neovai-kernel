import type { Attachment } from '../agent-loop/content'
import type { ContentPart } from '../agent-loop/types'

export type { Attachment }

/** Limits the composer applies before anything reaches the engine. */
export const ATTACH_LIMITS = {
  maxFiles: 8,
  /** Longest image side after downscaling; larger models downscale beyond this anyway. */
  maxImageSide: 1568,
  /** Images under this many bytes that already fit are sent as they are. */
  keepImageBytes: 1_500_000,
  /** Largest file the composer will read at all. */
  maxFileBytes: 25_000_000,
  /** Text files are cut to this many characters. */
  maxTextChars: 200_000,
  /** A PDF with more pages than this is sent as text only; a scanned PDF sends at most this many page images. */
  pdfMaxPages: 20,
  /** A PDF larger than this is sent as text only (base64 adds a third, and providers cap the request body). */
  pdfNativeMaxMB: 8
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|xml|html?|css|scss|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|sh|bash|zsh|sql|log|ini|cfg|conf|env\.example)$/i

/** Whether a file is attached as an image, as text, as a PDF (the host prepares it, see `pdfAttachment`), or not at all. */
export function classify(name: string, mime = ''): 'image' | 'text' | 'pdf' | null {
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf'
  // SVG is markup, so the model reads it as text.
  if (mime.includes('svg') || /\.svg$/i.test(name)) return 'text'
  if (mime.startsWith('image/') && !mime.includes('svg')) return 'image'
  if (IMAGE_EXT.test(name)) return 'image'
  if (mime.startsWith('text/') || /json|xml|yaml|javascript|typescript|csv/.test(mime)) return 'text'
  if (TEXT_EXT.test(name)) return 'text'
  return null
}

/** Size that fits inside a max×max box, keeping the aspect ratio and never upscaling. */
export function fitSize(width: number, height: number, max = ATTACH_LIMITS.maxImageSide): { width: number; height: number } {
  const s = Math.min(1, max / Math.max(width, height, 1))
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) }
}

/** Cuts long text and says so in a note the model sees. */
export function clipText(text: string, max = ATTACH_LIMITS.maxTextChars): { text: string; note?: string } {
  if (text.length <= max) return { text }
  return { text: text.slice(0, max), note: `cut to the first ${max} of ${text.length} characters` }
}

/** A PDF the host has read: the base64 file, its size in bytes and the text of each page. */
export interface PdfInput { name: string; data: string; size: number; pageTexts: string[]; path?: string }

/** True when a PDF has almost no text layer (under 20 characters a page): its pages must go as images. */
export const isScannedPdf = (pageTexts: string[]) => pageTexts.reduce((n, t) => n + t.trim().length, 0) < 20 * Math.max(1, pageTexts.length)

/**
 * Builds the attachment for a PDF the host has extracted. A small PDF goes as the file itself (models that read
 * PDFs get it, the others get its text); a large one goes as text only. Returns null for a scanned PDF:
 * the host then renders its first `pdfMaxPages` pages and sends a `pages` attachment.
 */
export function pdfAttachment(p: PdfInput, limits = ATTACH_LIMITS): Attachment | null {
  if (isScannedPdf(p.pageTexts)) return null
  const total = p.pageTexts.length
  const t = clipText(p.pageTexts.map((s, i) => `--- page ${i + 1} ---\n${s.trim()}`).join('\n\n'), limits.maxTextChars)
  const path = p.path ? { path: p.path } : {}
  if (limits.pdfNativeMaxMB <= 0 || p.size > limits.pdfNativeMaxMB * 1024 * 1024 || total > limits.pdfMaxPages) {
    const note = [`${total} page${total === 1 ? '' : 's'}`, t.note].filter(Boolean).join('; ')
    return { kind: 'text', name: p.name, text: t.text, note, ...path }
  }
  return { kind: 'pdf', name: p.name, data: p.data, text: t.text, pages: total, ...(t.note ? { note: t.note } : {}), ...path }
}

/** What a user message shows: its own words, image thumbnails and attached file names. */
export interface UserView { text: string; images: string[]; files: string[] }

const CAPTION = /^Attached image: .* \(\d+×\d+\)(; file on disk: .*)?$/
const SCAN = /^Attached scanned PDF: (.*) \((?:pages 1-\d+ of \d+|\d+ pages?), one image per page\)(; file on disk: .*)?$/
const DOC = /\n*<attachment name="([^"]*)"[^>]*>[\s\S]*?<\/attachment>/g
const FALLBACK = 'Please take a look at the attached file(s).'

/** Splits saved user content (as built by buildUserContent) back into text, images and file names. */
export function userView(content: string | ContentPart[] | null | undefined): UserView {
  const out: UserView = { text: '', images: [], files: [] }
  if (content == null) return out
  const parts: ContentPart[] = typeof content === 'string' ? [{ type: 'text', text: content }] : content
  const texts: string[] = []
  // the page images of a scanned PDF are not thumbnails: the PDF shows as one file
  let scan = false
  for (const p of parts) {
    if (p.type === 'image_url') { if (!scan) out.images.push(p.image_url.url); continue }
    scan = false
    if (p.type === 'file') { out.files.push(p.file.name); continue }
    if (CAPTION.test(p.text)) continue
    const s = SCAN.exec(p.text)
    if (s) { out.files.push(s[1]); scan = true; continue }
    texts.push(p.text.replace(DOC, (_m, name: string) => { out.files.push(name.replace(/'/g, '"')); return '' }))
  }
  out.text = texts.join('\n').trim()
  if (out.text === FALLBACK && (out.images.length || out.files.length)) out.text = ''
  return out
}
