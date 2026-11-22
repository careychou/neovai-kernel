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
  maxTextChars: 200_000
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|xml|html?|css|scss|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|sh|bash|zsh|sql|log|ini|cfg|conf|env\.example)$/i

/** Whether a file is attached as an image, as text, or not at all. */
export function classify(name: string, mime = ''): 'image' | 'text' | null {
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

/** What a user message shows: its own words, image thumbnails and attached file names. */
export interface UserView { text: string; images: string[]; files: string[] }

const CAPTION = /^Attached image: .* \(\d+×\d+\)$/
const DOC = /\n*<attachment name="([^"]*)"[^>]*>[\s\S]*?<\/attachment>/g
const FALLBACK = 'Please take a look at the attached file(s).'

/** Splits saved user content (as built by buildUserContent) back into text, images and file names. */
export function userView(content: string | ContentPart[] | null | undefined): UserView {
  const out: UserView = { text: '', images: [], files: [] }
  if (content == null) return out
  const parts: ContentPart[] = typeof content === 'string' ? [{ type: 'text', text: content }] : content
  const texts: string[] = []
  for (const p of parts) {
    if (p.type === 'image_url') { out.images.push(p.image_url.url); continue }
    if (CAPTION.test(p.text)) continue
    texts.push(p.text.replace(DOC, (_m, name: string) => { out.files.push(name.replace(/'/g, '"')); return '' }))
  }
  out.text = texts.join('\n').trim()
  if (out.text === FALLBACK && (out.images.length || out.files.length)) out.text = ''
  return out
}
