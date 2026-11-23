# neovai-kernel

A small agent kernel made of reusable **cards**. An app picks the cards it needs and builds its own agent from them. Neovai = neo-evolution-ai: apps that improve their own instructions, logic and UI from feedback.

TypeScript source package, no build step. Needs Node 22.5+ (`node:sqlite`).

## Cards

| Card | What it gives you |
|---|---|
| `agent-loop` | Model/tool loop, `Session`, tool and event types. Every tool takes an extra plain-language `intent` (added to its schema, removed before it runs) so chats can say what a step does; `PLAIN_LANGUAGE_RULES` tells an agent to talk to a non-technical user |
| `model-providers` | OpenAI-compatible, Azure and Vertex adapters behind one router |
| `file-tools` | read / write / edit / glob / grep, locked to one root folder |
| `shell` | Shell command tools, sync and background |
| `web-fetch` | Read-only web page fetch as markdown |
| `approval` | Permission gate (ask, allow for session, auto-approve) |
| `session-store` | SQLite store for chats, messages and usage |
| `settings` | Settings file with sealed API keys |
| `skills` | App-embedded skills: `<dir>/<name>/SKILL.md` files, listed in the prompt and loaded on demand with the `skill` tool, or inlined in full for a runtime agent (`skillsInstructions`). Since 0.14.0, several folders at once (0.14.1 reads YAML `>` and `|` block descriptions): `loadSkillSources([{dir, label, editable}])` merges them in order (the app's own copy of a name wins), shared folders (such as `.github/skills`, `~/.copilot/skills`) are marked read-only in the prompt, `makeSkillTool({sources})` loads from any of them, and `writeSkill` saves an editable one. `SkillList` (from `neovai-kernel/cards/skills/react`, styles from `.../styles.css`) lists skills grouped by folder with a read-only lock |
| `chat-view` | The chat experience: messages, a folding thoughts block, collapsed tool-call rows, and the standard `Composer` that attaches images and text files by a paperclip button, paste or drag and drop, and (with `onPublish`) a publish button next to it (images downscaled in the window, shown as thumbnails in the conversation; send them with `session.send(prompt, attachments)`). Tool rows have three levels: a one-line summary ("<step> and N other steps"), which opens to its steps in plain words (the call's `intent`), each of which opens to a detail panel with what it was given (`$ command` for shell calls, the intent removed) and its output; `MessageList technical` labels steps with raw tool names. Since 0.14.0, `SessionList` is the session history column: new, select, rename (pencil or double-click; Enter saves, Escape cancels) and delete. View model in `index.ts`; React components from `neovai-kernel/cards/chat-view/react`; styles from `neovai-kernel/cards/chat-view/styles.css` |
| `runtime-agent` | Runs an app's own functions (jobs, `jobs/<name>.md`) headlessly with every skill appended to the instruction, read fresh each run; writes only under `records/`; `save_data` stores JSON for screens; `run(job, input)` passes options picked on a screen and keeps them with the report; follows `PLAIN_LANGUAGE_RULES`; `goalsTitle` names the user's settings file in its instruction; `subAgents: true` (0.11.0) lets a run hand independent parts of a job (e.g. one per stock) to parallel helpers that share its tools and write limits; `sharedSkills` (0.14.0) lists read-only shared skill folders by name, loaded on demand with the `skill` tool |
| `live-ui` | Screens that change while the app runs: JSON descriptions (`ui/screens/<name>.json`) drawn with built-in blocks, and `.tsx` code panels compiled at runtime with the last good version kept; `check_ui` tool for the coding agent; Accept/Decline on recommendation blocks (`decide: true`, saved by `decide()` to `decisions.json`); run blocks show elapsed time, the current step and live activity. A screen may list the `skills` it is built on; a `skill` block shows a skill's text; with `host.codify` every screen gets a bar to change it or open its skills. Panels are interactive through `@neovai/panel` (`useApp`: data, `run(job, input)`, stop, progress, last report, `decide`, `codify`; `usePanelState`; `Blocks`, `RunButton`, `Markdown`); apps add allowed libraries with `registerHostModules(extra)` and `externals`. `run` blocks take `input`. Panels read the user's preferences (`prefs`) and save them (`savePrefs`) when the host passes `prefs`/`savePrefs`. Since 0.9.0: a `chart` block and `<Chart>` component (trading-style SVG candlesticks, line, area, bar, volume pane, last-price tag, hover O/H/L/C); live data in panels through `host.fetch` (main-process `panelFetch`: GET, http/https, size and time caps) as `useFetch(url, refreshSecs)` and `useApp().fetchJson/fetchText`; panels may import plain `.css` files (injected as style tags) and split into many relative files. React side from `neovai-kernel/cards/live-ui/react`; styles from `.../styles.css` |
| `sub-agents` | Since 0.11.0. `SubAgents` gives an agent `task`, `read_agent` and `list_agents`: a sub-agent starts with fresh context (only the prompt it is given) and hands back only its final answer. Several `task` calls in one reply run **in parallel**, bounded by the session's shared semaphore (held only while a model streams, so nested agents never deadlock). `mode: "background"` returns an id at once; when the sub-agent ends, the parent gets a `<system_notification>` and an idle main agent wakes up (`Session.notify`). Named roles (`agents: [{name, description, system, tools?}]`), a depth limit (`maxDepth`, default 2), and Stop cancels the whole tree (`attach(session)`). `agent_start` carries the `callId` of its `task` step, so `chat-view` draws each sub-agent's own steps and answer under that step, at any depth |
| `git-publish` | Since 0.12.0. One-click publish: `publish({url | repo, mirror?, onEvent})`. With `url` (since 0.13.0) it downloads the remote repository into a temporary folder, updates and pushes it, then deletes the folder, so no local working copy is needed; with `repo` it uses a local one. It copies the folder the app edits into the repository (`mirror: {from, to, exclude}`, `to` relative to the repository: new and changed files copied, removed ones deleted, globs such as `records/**` left out), then commits (a message naming the changed folders) and pushes. Every step is emitted as a plain-language `shell` step through `onEvent`, so a `chat-view` list shows the progress live, and the result's `messages` can be saved to the chat. A failed push keeps the commit and shows git's reason. `Composer onPublish` draws the publish button next to attach |

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

Sub-agents (parallel or background helpers with fresh context):

```ts
import { SubAgents } from 'neovai-kernel/cards/sub-agents'

const subs = new SubAgents({ adapter, hooks, gate, cwd, model: () => settings.model, tools: () => tools })
const session = new Session({ adapter, hooks, gate, model, cwd, system, tools: () => [...tools, ...subs.tools()] })
subs.attach(session) // shared concurrency limit, background notices, Stop cancels every sub-agent
```

Publish button (commit and push the app's edits, progress in the chat):

```tsx
import { publish } from 'neovai-kernel/cards/git-publish'

// main process
const r = await publish({ url: 'git@github.com:me/app.git', mirror: { from: workspace, to: 'workspace', exclude: ['records/**'] }, onEvent: (e) => send(chatId, e) })
store.saveMessages(chatId, [...history, ...r.messages])

// window
<Composer onPublish={() => api.publish(chatId)} publishing={busy} ... />
```

Session history and skills (the app frame):

```tsx
import { SessionList } from 'neovai-kernel/cards/chat-view/react'
import { SkillList } from 'neovai-kernel/cards/skills/react'

<SessionList sessions={chats} active={id} onSelect={open} onRename={(id, t) => api.renameChat(id, t)} onDelete={remove} onNew={newChat} />
<SkillList skills={skills} active={name} onOpen={show} sourceTitles={{ Workspace: 'This app' }} />

// main process: the app's skills first, then shared read-only folders
const sources = [{ dir: 'workspace/skills', label: 'Workspace', editable: true }, { dir: '~/.copilot/skills', label: '~/.copilot/skills', editable: false }]
createRuntime({ ..., sharedSkills: () => sources.slice(1) })
```

Apps pin a tagged release of this repo.

## Use as a template

Neovai Investor (`careychou/neovai-investor`) is the reference app built on these cards. To start a new
app, copy it, rename it, keep only the cards you need, and replace its `workspace/` (instructions,
skills, jobs, screens, panels). Add a new card here when a feature should be shared by every app;
tag the kernel and pin the tag in the app's `kernel.json`.

## Checks

```bash
npm test                 # card unit tests
npm run test:regression  # run by hand before each tag
npm run typecheck
```
