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
| `skills` | App-embedded skills: `<dir>/<name>/SKILL.md` files, listed in the prompt and loaded on demand with the `skill` tool |

Each card lives in `cards/<name>/` with `index.ts` (the only import point), `card.json` and tests.

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
