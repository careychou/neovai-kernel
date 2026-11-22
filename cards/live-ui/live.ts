import fs from 'node:fs'
import path from 'node:path'
import type { ToolDef } from '../agent-loop'
import { compilePanel, DEFAULT_EXTERNALS } from './compile'
import { parseScreen, panelFiles, recKey, type Decision, type DecisionRecord, type Recommendation, type Screen } from './screen'

export interface ScreenState {
  /** File name without `.json`. */
  name: string
  title: string
  order: number
  file: string
  /** The last description that was valid. Null until one is. */
  screen: Screen | null
  /** Problems with the file as it is now. Empty when it is valid. */
  errors: string[]
}

export interface PanelResult {
  /** Code to load: the current build, or the last good one when the current file fails. Null when none ever worked. */
  code: string | null
  error: string | null
  /** Changes whenever the code does, so the renderer knows to reload. */
  version: number
}

export interface LiveUiOptions {
  workspace: string
  /** Screen descriptions, `<screensDir>/<name>.json`. Default `ui/screens`. */
  screensDir?: string
  /** Saved data the blocks show, `<dataDir>/<name>.json`. Default `records/data`. */
  dataDir?: string
  /** Shown when the screens folder has no descriptions yet. */
  fallback?: Record<string, Screen>
  externals?: string[]
  /** Called (debounced) after anything under the workspace changes. */
  onChange?: () => void
}

const readJson = (f: string): unknown => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return undefined } }

/** Main-process side of the live UI: reads screen descriptions, compiles panels, keeps the last good version of each. */
export function createLiveUi(o: LiveUiOptions) {
  const ws = o.workspace
  const screensDir = path.join(ws, o.screensDir ?? 'ui/screens')
  const dataDir = path.join(ws, o.dataDir ?? 'records/data')
  const good = new Map<string, Screen>()
  const panels = new Map<string, { files: string[]; key: string; code: string | null; error: string | null; version: number }>()
  const runtimeErrors = new Map<string, string>()
  let watcher: fs.FSWatcher | null = null
  let timer: NodeJS.Timeout | null = null
  let version = 0

  function screens(): ScreenState[] {
    let names: string[] = []
    try { names = fs.readdirSync(screensDir).filter((f) => f.endsWith('.json')) } catch { /* none yet */ }
    if (!names.length && o.fallback) {
      return Object.entries(o.fallback).map(([name, screen]) => ({ name, title: screen.title ?? name, order: screen.order ?? Infinity, file: '', screen, errors: [] }))
    }
    return names.map((f) => {
      const name = f.slice(0, -5)
      const file = path.join(screensDir, f)
      let text = ''
      try { text = fs.readFileSync(file, 'utf8') } catch { /* removed meanwhile */ }
      const { screen, errors } = parseScreen(text)
      if (screen) good.set(name, screen)
      const shown = screen ?? good.get(name) ?? null
      return { name, title: shown?.title ?? name, order: shown?.order ?? Infinity, file, screen: shown, errors }
    }).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
  }

  function data(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    let names: string[] = []
    try { names = fs.readdirSync(dataDir).filter((f) => f.endsWith('.json')) } catch { /* none yet */ }
    for (const f of names) out[f.slice(0, -5)] = readJson(path.join(dataDir, f))
    return out
  }

  /** Fingerprint of a panel's files, so a rebuild happens only when one of them changed. */
  function keyOf(files: string[]): string {
    return files.map((f) => { try { return `${f}:${fs.statSync(path.join(ws, f)).mtimeMs}` } catch { return `${f}:gone` } }).join('|')
  }

  function panel(file: string): PanelResult {
    const prev = panels.get(file)
    if (prev && prev.files.length && prev.key === keyOf(prev.files)) return prev
    try {
      const r = compilePanel(ws, file, o.externals ?? DEFAULT_EXTERNALS)
      const next = { files: r.files, key: keyOf(r.files), code: r.code, error: null, version: prev?.code === r.code ? prev.version : ++version }
      runtimeErrors.delete(file)
      panels.set(file, next)
      return next
    } catch (e: any) {
      const next = { files: [] as string[], key: '', code: prev?.code ?? null, error: String(e?.message ?? e), version: prev?.version ?? 0 }
      panels.set(file, next)
      return next
    }
  }

  /** The renderer reports a panel that compiled but failed while drawing. */
  function reportError(file: string, message: string) {
    runtimeErrors.set(file, message)
  }

  /** Every problem with the screens and panels as they are now, for the coding agent. */
  function check(): string {
    const problems: string[] = []
    const list = screens()
    for (const s of list) {
      for (const e of s.errors) problems.push(`${path.relative(ws, s.file) || s.name}: ${e}`)
      for (const f of s.screen ? panelFiles(s.screen) : []) {
        const p = panel(f)
        if (p.error) problems.push(`${f}: ${p.error}`)
        const r = runtimeErrors.get(f)
        if (r) problems.push(`${f} (while drawing): ${r}`)
      }
    }
    if (!list.length) problems.push(`no screens in ${path.relative(ws, screensDir)}`)
    return problems.length ? `Problems:\n- ${problems.join('\n- ')}` : `OK: ${list.map((s) => s.name).join(', ')} load without errors.`
  }

  /** Records accepting or declining a recommendation in `<dataDir>/decisions.json`; null clears the choice. */
  function decide(rec: Recommendation, decision: Decision | null): DecisionRecord[] {
    const file = path.join(dataDir, 'decisions.json')
    const cur = readJson(file) as { items?: DecisionRecord[] } | undefined
    const id = recKey(rec)
    const items = (Array.isArray(cur?.items) ? cur!.items : []).filter((d) => d.id !== id)
    if (decision) items.push({ ...rec, id, decision, at: new Date().toISOString() })
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ ...cur, items }, null, 2))
    return items
  }

  function watch() {
    if (watcher || !o.onChange) return
    try {
      watcher = fs.watch(ws, { recursive: true }, (_e, f) => {
        const name = String(f ?? '')
        if (name.startsWith('node_modules') || name.startsWith('.git') || name.includes(`${path.sep}runs${path.sep}`)) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => o.onChange?.(), 150)
      })
    } catch { /* watching is best effort */ }
  }

  return {
    screensDir, dataDir,
    screens, data, panel, reportError, check, watch, decide,
    dispose() { watcher?.close(); watcher = null; if (timer) clearTimeout(timer) }
  }
}

export type LiveUi = ReturnType<typeof createLiveUi>

/** The `check_ui` tool: lets the coding agent confirm its screen and panel edits load. */
export function makeCheckUiTool(ui: LiveUi): ToolDef {
  return {
    name: 'check_ui',
    description: 'Check that every screen description and code panel loads. Run it after changing anything under ui/. Lists each problem to fix.',
    parameters: { type: 'object', properties: {} },
    async run() { return ui.check() }
  }
}
