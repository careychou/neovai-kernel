import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SkillList } from './react'

describe('skill list', () => {
  it('groups skills by source and marks shared ones read-only', () => {
    const html = renderToStaticMarkup(createElement(SkillList, {
      skills: [{ name: 'scan', description: 'd', source: 'app', editable: true }, { name: 'helper', description: 'h', source: '.github/skills', editable: false }],
      sourceTitles: { app: 'Workspace' }, onOpen: () => {}
    }))
    expect(html.indexOf('Workspace')).toBeLessThan(html.indexOf('.github/skills'))
    expect(html).toContain('read-only')
    expect(html.match(/read-only/g)?.length).toBe(2)
  })
})
