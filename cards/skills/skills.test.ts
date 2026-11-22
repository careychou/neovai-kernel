import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadSkills, makeSkillTool, readSkill, skillsPrompt } from './index'

let dir: string
const put = (name: string, text: string) => {
  fs.mkdirSync(path.join(dir, name), { recursive: true })
  fs.writeFileSync(path.join(dir, name, 'SKILL.md'), text)
}
const run = (name: string) => makeSkillTool({ dir }).run({ name }, {} as never)

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('skills', () => {
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
