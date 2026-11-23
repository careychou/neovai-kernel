import fs from 'node:fs'
import path from 'node:path'
import type { ToolDef } from '../agent-loop'

export interface Skill {
  /** Folder name, and the name the agent loads it by. */
  name: string
  description: string
  /** Position in the list. Skills without one come last, by name. */
  order: number
  /** The instructions, without the header. */
  body: string
  file: string
  /** Label of the folder it came from (see `loadSkillSources`). */
  source?: string
  /** False for skills from shared folders this app must not change. */
  editable?: boolean
}

/** A folder of skills: the app's own (editable) or a shared one such as `.github/skills` or `~/.copilot/skills` (read-only). */
export interface SkillSource { dir: string; label: string; editable: boolean }

const NAME = /^[a-z0-9][a-z0-9-]*$/

/** Splits a `---` header of `key: value` lines from the body. */
export function parseFrontMatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return { meta: {}, body: text.trim() }
  const meta: Record<string, string> = {}
  const lines = m[1].split(/\r?\n/)
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]
    if (/^\s/.test(line)) continue
    const i = line.indexOf(':')
    if (i <= 0) continue
    const value = line.slice(i + 1).trim()
    const block = /^([>|])[+-]?$/.exec(value)
    if (block) {
      // YAML block scalar: `>` folds the indented lines into one, `|` keeps the line breaks.
      const parts: string[] = []
      while (n + 1 < lines.length && (/^\s/.test(lines[n + 1]) || lines[n + 1].trim() === '')) parts.push(lines[++n].trim())
      while (parts.length && parts[parts.length - 1] === '') parts.pop()
      meta[line.slice(0, i).trim()] = block[1] === '|' ? parts.join('\n') : parts.join(' ').replace(/\s+/g, ' ').trim()
    } else meta[line.slice(0, i).trim()] = value.replace(/^(['"])(.*)\1$/, '$2')
  }
  return { meta, body: m[2].trim() }
}

/** Reads one skill from `<dir>/<name>/SKILL.md`. Returns null when it is missing or the name is not a plain folder name. */
export function readSkill(dir: string, name: string): Skill | null {
  if (!NAME.test(name)) return null
  const file = path.join(dir, name, 'SKILL.md')
  let text: string
  try { text = fs.readFileSync(file, 'utf8') } catch { return null }
  const { meta, body } = parseFrontMatter(text)
  const order = Number(meta.order)
  return { name, description: meta.description ?? '', order: Number.isFinite(order) && meta.order !== undefined ? order : Infinity, body, file }
}

/** Every skill under `dir`, read from disk each time so an edit applies to the next prompt. */
export function loadSkills(dir: string): Skill[] {
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { return [] }
  return names
    .map((n) => readSkill(dir, n))
    .filter((s): s is Skill => s !== null)
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
}

/** Skills from several folders, in folder order. A name already taken by an earlier folder is skipped, so the app's own skill wins. */
export function loadSkillSources(sources: SkillSource[]): Skill[] {
  const seen = new Set<string>()
  const out: Skill[] = []
  for (const src of sources) {
    for (const sk of loadSkills(src.dir)) {
      if (seen.has(sk.name)) continue
      seen.add(sk.name)
      out.push({ ...sk, source: src.label, editable: src.editable })
    }
  }
  return out
}

/** Writes `<dir>/<name>/SKILL.md` (an editable source only). */
export function writeSkill(dir: string, name: string, text: string): string {
  if (!NAME.test(name)) throw new Error(`"${name}" is not a valid skill name (lowercase letters, digits and dashes)`)
  const file = path.join(dir, name, 'SKILL.md')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text.endsWith('\n') ? text : text + '\n')
  return file
}

/** The short list that goes in the system prompt. Bodies stay on disk until the agent asks for one. */
export function skillsPrompt(skills: Skill[]): string {
  if (!skills.length) return '(no skills yet)'
  return skills.map((s) => `- ${s.name}: ${s.description || '(no description)'}${s.editable === false ? ` (shared, read-only${s.source ? `: ${s.source}` : ''})` : ''}`).join('\n')
}

/** Every skill in full, in order: the block a runtime agent appends to its main instruction. */
export function skillsInstructions(skills: Skill[]): string {
  if (!skills.length) return '(no skills yet)'
  return skills.map((s) => `## Skill: ${s.name}\n${s.description ? s.description + '\n' : ''}File: ${s.file}\n\n${s.body}`).join('\n\n')
}

/** The `skill` tool: returns one skill's instructions by name, from `dir` or, with `sources`, from the first folder that has it. */
export function makeSkillTool(o: { dir: string } | { sources: () => SkillSource[] }): ToolDef {
  const dirs = () => ('dir' in o ? [o.dir] : o.sources().map((x) => x.dir))
  return {
    name: 'skill',
    description: 'Load the full instructions of one skill by name. Do this before doing the work the skill covers.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Skill name from the skills list.' } },
      required: ['name']
    },
    summarize: (a) => String(a?.name ?? ''),
    async run(a) {
      const name = String(a?.name ?? '')
      for (const d of dirs()) {
        const s = readSkill(d, name)
        if (s) return `# Skill: ${s.name}\nFile: ${s.file}\n\n${s.body}`
      }
      const have = [...new Set(dirs().flatMap((d) => loadSkills(d).map((x) => x.name)))]
      throw new Error(`No skill named "${name}". Available: ${have.join(', ') || 'none'}.`)
    }
  }
}
