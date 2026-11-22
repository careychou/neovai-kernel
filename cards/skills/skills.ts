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
}

const NAME = /^[a-z0-9][a-z0-9-]*$/

function parse(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return { meta: {}, body: text.trim() }
  const meta: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return { meta, body: m[2].trim() }
}

/** Reads one skill from `<dir>/<name>/SKILL.md`. Returns null when it is missing or the name is not a plain folder name. */
export function readSkill(dir: string, name: string): Skill | null {
  if (!NAME.test(name)) return null
  const file = path.join(dir, name, 'SKILL.md')
  let text: string
  try { text = fs.readFileSync(file, 'utf8') } catch { return null }
  const { meta, body } = parse(text)
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

/** The short list that goes in the system prompt. Bodies stay on disk until the agent asks for one. */
export function skillsPrompt(skills: Skill[]): string {
  if (!skills.length) return '(no skills yet)'
  return skills.map((s) => `- ${s.name}: ${s.description || '(no description)'}`).join('\n')
}

/** The `skill` tool: returns one skill's instructions by name. */
export function makeSkillTool(o: { dir: string }): ToolDef {
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
      const s = readSkill(o.dir, name)
      if (s) return `# Skill: ${s.name}\nFile: ${s.file}\n\n${s.body}`
      const have = loadSkills(o.dir).map((x) => x.name)
      throw new Error(`No skill named "${name}". Available: ${have.join(', ') || 'none'}.`)
    }
  }
}
