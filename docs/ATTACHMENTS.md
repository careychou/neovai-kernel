# Attachments: how an app sends files to the model

**The kernel sends images and text files with no setup. For PDFs, Office files and file paths, the app gives the composer one function, `prepareAttachment`.**

This guide describes kernel 0.18.0. The kernel has no PDF library and cannot see the disk from a window, so the app supplies the file reading. The kernel decides what each model receives.

A runnable version of everything below is in [`tests/regression/attachments.test.ts`](../tests/regression/attachments.test.ts).

## 1. What works without any code

```tsx
import { Composer } from 'neovai-kernel/cards/chat-view/react'

<Composer value={text} onChange={setText} onSend={(prompt, attachments) => api.send(chatId, prompt, attachments)} />
```

```ts
// main process
await session.send(prompt, attachments)
```

| The user attaches | Result |
|---|---|
| An image (PNG, JPEG, GIF, WebP) | Downscaled to 1568 px on the long side and sent as an image |
| A text file (txt, md, csv, json, code) | Read and sent as text, cut at 200,000 characters |
| A PDF | Skipped. The composer shows "this file type can't be attached (images and text files only)" |
| A Word, Excel or PowerPoint file | Skipped, same message |

Files can be picked with the paperclip, pasted, or dropped. The limit is 8 files per message and 25 MB per file.

## 2. The four attachment kinds

`Attachment` is exported from `neovai-kernel/cards/agent-loop` and `neovai-kernel/cards/chat-view`.

| Kind | Fields | Use it for |
|---|---|---|
| `image` | `name`, `dataUrl`, `width`, `height`, `path?` | A picture |
| `text` | `name`, `text`, `note?`, `path?` | Any file the app turned into text (CSV, Word, Excel, a long PDF) |
| `pdf` | `name`, `data` (base64), `text`, `pages`, `note?`, `path?` | A PDF with a text layer. Build it with `pdfAttachment`, not by hand |
| `pages` | `name`, `pages: [{dataUrl, width, height}]`, `total`, `path?` | A scanned PDF, one image per page |

`path` is optional on every kind. When it is set, the model is told where the file is on disk. If the attached text was cut, the model can read the rest with the app's file tools.

## 3. What each model receives

The app builds the same attachment for every model. The provider adapter converts it when the request is sent.

| Attachment | Claude (Anthropic API, or `anthropic/…` on Vertex) | Every other model |
|---|---|---|
| `image` | Image block | `image_url` part |
| `text` | Text | Text |
| `pdf` | The PDF file as a `document` block. Claude reads the text and sees each page, so charts and tables work | The extracted text only |
| `pages` | One image block per page | One `image_url` part per page |

A Vertex model marked `describe` (text-only) gets a PDF as text, and its images are transcribed by the vision model first.

## 4. Add PDF support

### Step 1: write `prepareAttachment`

The function gets each `File` before the built-in reader. Return an attachment (or an array) to handle the file. Return nothing to let the built-in reader handle it.

This example uses [`unpdf`](https://github.com/unjs/unpdf). Any library that returns the text of each page will do.

```ts
import { extractText, getDocumentProxy } from 'unpdf'
import { ATTACH_LIMITS, pdfAttachment } from 'neovai-kernel/cards/chat-view'
import type { PrepareAttachment } from 'neovai-kernel/cards/chat-view/react'

export const prepareAttachment: PrepareAttachment = async (file) => {
  if (!/\.pdf$/i.test(file.name)) return            // not ours: the built-in reader takes it

  const bytes = new Uint8Array(await file.arrayBuffer())
  const path = await api.saveAttachment(file.name, bytes)   // optional: the app's own call that writes the file and returns its path

  const doc = await getDocumentProxy(bytes.slice())  // the library may take ownership of the buffer, so give it a copy
  const { text } = await extractText(doc, { mergePages: false })   // string[]: one entry per page

  const pdf = pdfAttachment({ name: file.name, data: toBase64(bytes), size: bytes.length, pageTexts: text, path })
  if (pdf) return pdf                               // a `pdf` attachment, or `text` when the file is over a limit

  // null means scanned (no text layer): send the pages as images
  const count = Math.min(doc.numPages, ATTACH_LIMITS.pdfMaxPages)
  const pages = []
  for (let n = 1; n <= count; n++) pages.push(await renderPage(doc, n, ATTACH_LIMITS.maxImageSide))  // the app's renderer: {dataUrl, width, height}
  return { kind: 'pages', name: file.name, pages, total: doc.numPages, path }
}
```

`toBase64`, `renderPage` and `api.saveAttachment` are the app's own code. In an Electron app the reading usually runs in the main process, and `prepareAttachment` is a thin call over IPC.

`pdfAttachment` returns one of three things:

| It returns | When | The app does |
|---|---|---|
| A `pdf` attachment | The PDF has text, is no larger than `pdfNativeMaxMB` and has no more than `pdfMaxPages` pages | Return it |
| A `text` attachment | The PDF has text but is over one of those limits, or `pdfNativeMaxMB` is 0 | Return it |
| `null` | The PDF is scanned (under 20 characters of text per page on average) | Render pages and return a `pages` attachment |

### Step 2: give it to the composer

```tsx
<Composer value={text} onChange={setText} onSend={send} prepareAttachment={prepareAttachment} />
```

Without React, call the same reader directly:

```ts
import { readFiles } from 'neovai-kernel/cards/chat-view/react'

const { attachments, skipped } = await readFiles(files, prepareAttachment)
```

### Step 3: send

```ts
await session.send(prompt, attachments)
store.saveMessages(chatId, session.history)
```

Nothing else changes. The saved history keeps the PDF, and `userView(message.content)` shows it as one file name in the conversation.

## 5. Other file types

Use the same function for any type the app can read. Return a `text` attachment:

```ts
if (/\.docx$/i.test(file.name)) {
  const { text, path } = await api.readWord(file)   // the app's own converter
  return { kind: 'text', name: file.name, text, note: 'converted from Word', path }
}
```

To add a path to a plain text file or an image, return the attachment yourself with `path` set.

## 6. Limits

`ATTACH_LIMITS` is exported from `neovai-kernel/cards/chat-view`.

| Field | Default | Meaning |
|---|---|---|
| `maxFiles` | 8 | Files per message |
| `maxFileBytes` | 25,000,000 | A larger file is skipped before `prepareAttachment` runs |
| `maxImageSide` | 1568 | Long side of an image, in pixels |
| `maxTextChars` | 200,000 | Text is cut here, with a note saying so |
| `pdfMaxPages` | 20 | Most pages sent as a PDF file, or as images for a scanned PDF |
| `pdfNativeMaxMB` | 8 | Largest PDF sent as a file. 0 sends every PDF as text |

To change a limit for the whole app, set the field once at startup: `ATTACH_LIMITS.pdfMaxPages = 40`. To change it for one call, pass a second argument: `pdfAttachment(input, { ...ATTACH_LIMITS, pdfNativeMaxMB: 0 })`.

A provider adapter with a `budget` (`{ maxBytes, imageTurns }`) re-sends images and PDF files only for the last `imageTurns` user messages. After that an image becomes a short note and a PDF becomes its text.

## 7. What the model sees

A text attachment, after the prompt:

```
<attachment name="sales.csv" note="file on disk: /Users/me/data/sales.csv">
region,revenue
...
</attachment>
```

An image: `Attached image: chart.png (1200×800); file on disk: /Users/me/chart.png`, then the image.

A scanned PDF: `Attached scanned PDF: scan.pdf (pages 1-20 of 34, one image per page); file on disk: /Users/me/scan.pdf`, then one image per page.

A PDF sent to Claude is a `document` block. For another model it is the same `<attachment>` text block as above, with `--- page N ---` before each page.

## 8. Messages for skipped files

`readFiles` returns these in `skipped`. The composer shows them under the input.

| Message | Cause |
|---|---|
| `<name>: larger than 25 MB` | Over `maxFileBytes` |
| `<name>: this file type can't be attached (images and text files only)` | No `prepareAttachment`, or it returned nothing for a type the kernel cannot read |
| `<name>: could not be read (<error>)` | `prepareAttachment` or the built-in reader threw |

## 9. Checklist

- A PDF is skipped: `prepareAttachment` is not passed to `Composer`, or it returns nothing for PDFs.
- Claude gets text, not the file: the PDF is over `pdfNativeMaxMB` or `pdfMaxPages`, the Vertex model id does not start with `anthropic/`, or the message is older than the adapter's `imageTurns`.
- A scanned PDF arrives empty: the app returned the `null` from `pdfAttachment` and did not build a `pages` attachment.
- The model does not know where the file is: `path` is not set. A pasted file has no path until the app saves it.
- The model cannot open the path: the session needs a file-reading tool (`file-tools` card) that is allowed to read that folder.
