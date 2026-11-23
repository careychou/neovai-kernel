import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadSkills, loadSkillSources, makeSkillTool, readSkill, skillsPrompt, skillsInstructions, writeSkill } from './index'

let dir: string
const put = (name: string, text: string) => {
  fs.mkdirSync(path.join(dir, name), { recursive: true })
  fs.writeFileSync(path.join(dir, name, 'SKILL.md'), text)
}
const run = (name: string) => makeSkillTool({ dir }).run({ name }, {} as never)

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('skills', () => {
  it('renders every skill in full, in order, for a runtime instruction', () => {
    put('b-second', '---\ndescription: Second job.\norder: 2\n---\nDo B.')
    put('a-first', '---\ndescription: First job.\norder: 1\n---\nDo A.')
    const text = skillsInstructions(loadSkills(dir))
    expect(text.indexOf('## Skill: a-first')).toBeLessThan(text.indexOf('## Skill: b-second'))
    expect(text).toContain('First job.')
    expect(text).toContain('Do A.')
    expect(text).toContain('Do B.')
    expect(skillsInstructions([])).toBe('(no skills yet)')
  })

  it('lists skills by order, then by name, and skips folders without a SKILL.md', () => {
    put('scan', '---\ndescription: Scan things\norder: 2\n---\nScan body')
    put('prefs', '---\ndescription: "Quoted: text"\norder: 1\n---\n\nPrefs body\n')
    put('zeta', 'No header here')
    put('alpha', '---\ndescription: A\n---\nA body')
    fs.mkdirSync(path.join(dir, 'empty'))
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x')
    const s = loadSkills(dir)
    expect(s.map((x) => x.name)).toEqual(['prefs', 'scan', 'alpha', 'zeta'])
    expect(s[0]).toMatchObject({ description: 'Quoted: text', body: 'Prefs body' })
    expect(s[3]).toMatchObject({ description: '', body: 'No header here' })
  })
  it('returns nothing for a missing folder', () => {
    expect(loadSkills(path.join(dir, 'nope'))).toEqual([])
    expect(skillsPrompt([])).toBe('(no skills yet)')
  })
  it('puts only names and descriptions in the prompt', () => {
    put('scan', '---\ndescription: Scan things\n---\nSECRET BODY')
    const p = skillsPrompt(loadSkills(dir))
    expect(p).toBe('- scan: Scan things')
  })
  it('the tool returns the body and sees edits made after it was created', async () => {
    put('scan', '---\ndescription: d\n---\nfirst')
    expect(await run('scan')).toContain('first')
    put('scan', '---\ndescription: d\n---\nsecond')
    const out = await run('scan')
    expect(out).toContain('second')
    expect(out).toContain(path.join(dir, 'scan', 'SKILL.md'))
  })
  it('the tool names what exists when asked for an unknown skill', async () => {
    put('scan', 'x')
    await expect(run('nope')).rejects.toThrow('No skill named "nope". Available: scan.')
  })
  it('refuses names that could leave the skills folder', async () => {
    fs.writeFileSync(path.join(dir, 'SKILL.md'), 'top')
    expect(readSkill(dir, '.')).toBeNull()
    expect(readSkill(dir, '../x')).toBeNull()
    await expect(run('..')).rejects.toThrow('No skill named')
  })
})

describe('skill sources', () => {
  it('merges folders in order, the app copy winning, and marks shared ones read-only', async () => {
    const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-'))
    try {
      put('scan', '---\ndescription: App scan\n---\nApp body')
      fs.mkdirSync(path.join(shared, 'scan')); fs.writeFileSync(path.join(shared, 'scan', 'SKILL.md'), '---\ndescription: Shared scan\n---\nShared body')
      fs.mkdirSync(path.join(shared, 'helper')); fs.writeFileSync(path.join(shared, 'helper', 'SKILL.md'), '---\ndescription: Helps\n---\nHelper body')
      const sources = [{ dir, label: 'app', editable: true }, { dir: shared, label: '~/.copilot/skills', editable: false }]
      const all = loadSkillSources(sources)
      expect(all.map((s) => [s.name, s.description, s.editable])).toEqual([['scan', 'App scan', true], ['helper', 'Helps', false]])
      expect(skillsPrompt(all)).toContain('helper: Helps (shared, read-only: ~/.copilot/skills)')
      const tool = makeSkillTool({ sources: () => sources })
      expect(await tool.run({ name: 'helper' }, {} as never)).toContain('Helper body')
      expect(await tool.run({ name: 'scan' }, {} as never)).toContain('App body')
      await expect(tool.run({ name: 'nope' }, {} as never)).rejects.toThrow(/scan, helper/)
    } finally { fs.rmSync(shared, { recursive: true, force: true }) }
  })

  it('writes a skill file and refuses bad names', () => {
    const f = writeSkill(dir, 'new-one', '---\ndescription: New\n---\nBody')
    expect(readSkill(dir, 'new-one')?.description).toBe('New')
    expect(fs.readFileSync(f, 'utf8').endsWith('\n')).toBe(true)
    expect(() => writeSkill(dir, '../x', 'y')).toThrow(/valid skill name/)
  })
  it('reads YAML block descriptions (> folded, | literal)', () => {
    put('folded', '---\nname: folded\ndescription: >\n  First line\n  second line.\norder: 1\n---\nBody.')
    put('literal', '---\ndescription: |\n  One\n  Two\n---\nBody.')
    expect(readSkill(dir, 'folded')).toMatchObject({ description: 'First line second line.', order: 1 })
    expect(readSkill(dir, 'literal')?.description).toBe('One\nTwo')
  })
})
