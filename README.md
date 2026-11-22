# neovai-kernel

A small agent kernel made of reusable **cards**. An app picks the cards it needs and builds its own agent from them. Neovai = neo-evolution-ai: apps that improve their own instructions, logic and UI from feedback.

TypeScript source package, no build step. Needs Node 22.5+ (`node:sqlite`).

## Cards

| Card | What it gives you |
|---|---|
| `agent-loop` | Model/tool loop, `Session`, tool and event types |
| `model-providers` | OpenAI-compatible, Azure and Vertex adapters behind one router |
| `file-tools` | read / write / edit / glob / grep, locked to one root folder |
| `shell` | Shell command tools, sync and background |
| `web-fetch` | Read-only web page fetch as markdown |
| `approval` | Permission gate (ask, allow for session, auto-approve) |
| `session-store` | SQLite store for chats, messages and usage |
| `settings` | Settings file with sealed API keys |
| `skills` | App-embedded skills: `<dir>/<name>/SKILL.md` files, listed in the prompt and loaded on demand with the `skill` tool, or inlined in full for a runtime agent (`skillsInstructions`) |
| `chat-view` | The chat experience: messages, a folding thoughts block, collapsed tool-call rows, and the standard `Composer` that attaches images and text files by button, paste or drag and drop (images downscaled in the window, shown as thumbnails in the conversation; send them with `session.send(prompt, attachments)`). View model in `index.ts`; React components from `neovai-kernel/cards/chat-view/react`; styles from `neovai-kernel/cards/chat-view/styles.css` |
| `runtime-agent` | Runs an app's own functions (jobs, `jobs/<name>.md`) headlessly with every skill appended to the instruction, read fresh each run; writes only under `records/`; `save_data` stores JSON for screens; `run(job, input)` passes options picked on a screen and keeps them with the report |
| `live-ui` | Screens that change while the app runs: JSON descriptions (`ui/screens/<name>.json`) drawn with built-in blocks, and `.tsx` code panels compiled at runtime with the last good version kept; `check_ui` tool for the coding agent; Accept/Decline on recommendation blocks (`decide: true`, saved by `decide()` to `decisions.json`); run blocks show elapsed time, the current step and live activity. A screen may list the `skills` it is built on; a `skill` block shows a skill's text; with `host.codify` every screen gets a bar to change it or open its skills. Panels are interactive through `@neovai/panel` (`useApp`: data, `run(job, input)`, stop, progress, last report, `decide`, `codify`; `usePanelState`; `Blocks`, `RunButton`, `Markdown`); apps add allowed libraries with `registerHostModules(extra)` and `externals`. `run` blocks take `input`. React side from `neovai-kernel/cards/live-ui/react`; styles from `.../styles.css` |

Each card lives in `cards/<name>/` with `index.ts` (the only import point for headless code), `card.json` and tests. Cards with UI also ship `react.tsx` and `styles.css`, imported by their own subpaths so `index.ts` stays loadable in Node.

## Use in an app

```json
{ "dependencies": { "neovai-kernel": "file:../neovai-kernel" } }
```

```ts
import { compose } from 'neovai-kernel/compose'
import { Session } from 'neovai-kernel/cards/agent-loop'
import { makeFileTools } from 'neovai-kernel/cards/file-tools'

compose(['agent-loop', 'file-tools']) // throws on an unknown card or a missing dependency
```

Apps pin a tagged release of this repo.

## Checks

```bash
npm test                 # card unit tests
npm run test:regression  # run by hand before each tag
npm run typecheck
```
