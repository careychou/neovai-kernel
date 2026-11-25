import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Session } from '../../cards/agent-loop'
import type { Attachment } from '../../cards/agent-loop'
import { VertexAdapter } from '../../cards/model-providers'
import { ATTACH_LIMITS, pdfAttachment, userView } from '../../cards/chat-view'
import { readFiles, type PrepareAttachment } from '../../cards/chat-view/react'

/**
 * End to end, as an app uses it (docs/ATTACHMENTS.md): the host's `prepareAttachment` reads a PDF, `readFiles`
 * collects the attachments, `Session.send` builds the message and the provider puts it on the wire.
 */

const CLAUDE = 'anthropic/claude-sonnet-5'
const GEMINI = 'google/gemini-2.5-pro'
const PX = 'data:image/png;base64,iVBORw0KGgo='

/** Stands in for the app's PDF library: page texts are the lines after the header; "SCAN n" is n pages without text. */
function fakeExtract(bytes: Buffer): string[] {
  const [, ...lines] = bytes.toString('utf8').split('\n')
  const scan = /^SCAN (\d+)$/.exec(lines[0] ?? '')
  return scan ? Array.from({ length: Number(scan[1]) }, () => '') : lines
}

/** The documented host hook. */
const prepare: PrepareAttachment = async (file) => {
  if (!/\.pdf$/i.test(file.name)) return
  const bytes = Buffer.from(await file.arrayBuffer())
  if (bytes.toString('ascii', 0, 4) !== '%PDF') throw new Error('not a PDF')
  const pageTexts = fakeExtract(bytes)
  const filePath = `/docs/${file.name}`
  const att = pdfAttachment({ name: file.name, data: bytes.toString('base64'), size: bytes.length, pageTexts, path: filePath })
  if (att) return att
  const n = Math.min(pageTexts.length, ATTACH_LIMITS.pdfMaxPages)
  return { kind: 'pages', name: file.name, total: pageTexts.length, path: filePath, pages: Array.from({ length: n }, () => ({ dataUrl: PX, width: 800, height: 1000 })) }
}

const pdf = (name: string, body: string) => new File([`%PDF-1.7\n${body}`], name, { type: 'application/pdf' })
const TEXT_PAGE = 'Revenue grew twelve percent in the third quarter.'

interface Hit { url: string; body: any; raw: string }
let server: http.Server, host = '', keyDir = ''
const hits: Hit[] = []

beforeAll(async () => {
  // readFiles reads text files with the browser's FileReader; Node has File and Blob but not FileReader
  ;(globalThis as any).FileReader ??= class {
    result: unknown; error: unknown; onload?: () => void; onerror?: () => void
    readAsText(b: Blob) { b.text().then((t) => { this.result = t; this.onload?.() }, (e) => { this.error = e; this.onerror?.() }) }
  }
  server = http.createServer((req, rs) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const url = req.url ?? ''
      if (url === '/token') { rs.writeHead(200, { 'content-type': 'application/json' }); rs.end(JSON.stringify({ access_token: 't', expires_in: 3600 })); return }
      hits.push({ url, raw, body: JSON.parse(raw) })
      rs.writeHead(200, { 'content-type': 'text/event-stream' })
      if (url.includes(':streamRawPredict')) {
        const ev = (o: unknown) => rs.write(`event: x\ndata: ${JSON.stringify(o)}\n\n`)
        ev({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } })
        ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })
        ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })
        ev({ type: 'message_stop' })
        rs.end()
        return
      }
      rs.write('data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n')
      rs.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n')
      rs.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  host = `http://127.0.0.1:${(server.address() as any).port}`
  keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'att-'))
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  fs.writeFileSync(path.join(keyDir, 'sa.json'), JSON.stringify({ type: 'service_account', client_email: 'bot@p.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), token_uri: `${host}/token` }))
})
afterAll(() => { server.close(); fs.rmSync(keyDir, { recursive: true, force: true }) })

async function ask(model: string, attachments: Attachment[]) {
  const adapter = new VertexAdapter({ project: 'p', credentialsPath: path.join(keyDir, 'sa.json'), models: [CLAUDE, GEMINI], endpoint: host })
  const session = new Session({ adapter, model, cwd: '/w', system: 'test', tools: [], gate: { check: async () => true }, hooks: { onEvent() {}, requestPermission: async () => 'allow', askUser: async () => '' } })
  await session.send('Summarize the file', attachments)
  const user = session.history.find((m) => m.role === 'user')!
  return { hit: hits.at(-1)!, user }
}

describe('attachments, host hook to wire', () => {
  it('reads files through the host hook and falls back to the built-in reader', async () => {
    const r = await readFiles([pdf('report.pdf', TEXT_PAGE), pdf('scan.pdf', 'SCAN 3'), new File(['a,b\n1,2'], 'data.csv', { type: 'text/csv' })], prepare)
    expect(r.skipped).toEqual([])
    expect(r.attachments.map((a) => a.kind)).toEqual(['pdf', 'pages', 'text'])
    expect(r.attachments[0]).toMatchObject({ name: 'report.pdf', pages: 1, path: '/docs/report.pdf', text: `--- page 1 ---\n${TEXT_PAGE}` })
    expect(r.attachments[1]).toMatchObject({ name: 'scan.pdf', total: 3, path: '/docs/scan.pdf' })
    expect(r.attachments[2]).toMatchObject({ name: 'data.csv', text: 'a,b\n1,2' })
  })

  it('skips a PDF when the app gives no hook, and reports a hook that throws', async () => {
    const none = await readFiles([pdf('report.pdf', TEXT_PAGE)])
    expect(none.attachments).toEqual([])
    expect(none.skipped[0]).toContain("report.pdf: this file type can't be attached")
    const bad = await readFiles([new File(['plain'], 'fake.pdf', { type: 'application/pdf' })], prepare)
    expect(bad.attachments).toEqual([])
    expect(bad.skipped).toEqual(['fake.pdf: could not be read (not a PDF)'])
  })

  it('sends a PDF over the page limit as text only', async () => {
    const pages = Array.from({ length: ATTACH_LIMITS.pdfMaxPages + 1 }, (_, i) => `Page ${i + 1} has enough words to count as a text layer.`).join('\n')
    const { attachments } = await readFiles([pdf('long.pdf', pages)], prepare)
    expect(attachments[0]).toMatchObject({ kind: 'text', name: 'long.pdf', note: `${ATTACH_LIMITS.pdfMaxPages + 1} pages`, path: '/docs/long.pdf' })
  })

  it('puts the PDF itself on the wire for Claude, with the path', async () => {
    const { attachments } = await readFiles([pdf('report.pdf', TEXT_PAGE)], prepare)
    const { hit, user } = await ask(CLAUDE, attachments)
    expect(hit.url).toContain(':streamRawPredict')
    const content = hit.body.messages.at(-1).content
    const doc = content.find((p: any) => p.type === 'document')
    expect(doc.source).toMatchObject({ type: 'base64', media_type: 'application/pdf' })
    expect(Buffer.from(doc.source.data, 'base64').toString()).toBe(`%PDF-1.7\n${TEXT_PAGE}`)
    expect(hit.raw).toContain('file on disk: /docs/report.pdf')
    expect(hit.raw).toContain('Summarize the file')
    expect(userView(user.content)).toEqual({ text: 'Summarize the file', images: [], files: ['report.pdf'] })
  })

  it('puts only the text on the wire for a model that cannot read a PDF', async () => {
    const { attachments } = await readFiles([pdf('report.pdf', TEXT_PAGE)], prepare)
    const { hit } = await ask(GEMINI, attachments)
    expect(hit.url).toContain('/chat/completions')
    expect(hit.raw).toContain(TEXT_PAGE)
    expect(hit.raw).toContain('file on disk: /docs/report.pdf')
    expect(hit.raw).not.toContain(Buffer.from(`%PDF-1.7\n${TEXT_PAGE}`).toString('base64'))
    expect(JSON.stringify(hit.body.messages)).not.toContain('"type":"file"')
  })

  it('sends a scanned PDF as one image per page to either model', async () => {
    const { attachments } = await readFiles([pdf('scan.pdf', `SCAN ${ATTACH_LIMITS.pdfMaxPages + 5}`)], prepare)
    const claude = await ask(CLAUDE, attachments)
    const imgs = claude.hit.body.messages.at(-1).content.filter((p: any) => p.type === 'image')
    expect(imgs.length).toBe(ATTACH_LIMITS.pdfMaxPages)
    expect(claude.hit.raw).toContain(`Attached scanned PDF: scan.pdf (pages 1-${ATTACH_LIMITS.pdfMaxPages} of ${ATTACH_LIMITS.pdfMaxPages + 5}, one image per page); file on disk: /docs/scan.pdf`)
    expect(userView(claude.user.content)).toEqual({ text: 'Summarize the file', images: [], files: ['scan.pdf'] })
    const gemini = await ask(GEMINI, attachments)
    expect(gemini.hit.body.messages.at(-1).content.filter((p: any) => p.type === 'image_url').length).toBe(ATTACH_LIMITS.pdfMaxPages)
  })
})
