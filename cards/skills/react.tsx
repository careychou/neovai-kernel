/** A skill as the window sees it: no body, just enough to list and open it. */
export interface SkillView { name: string; description: string; source?: string; editable?: boolean }

export interface SkillListProps {
  skills: SkillView[]
  active?: string | null
  onOpen(name: string): void
  /** Heading per source label, e.g. { app: 'This app' }. A source without one shows its label. */
  sourceTitles?: Record<string, string>
  empty?: string
}

/** Lock icon for read-only skills. */
export function LockIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  )
}

/** Every skill the app can use, grouped by where it lives; shared (read-only) folders carry a lock. */
export function SkillList({ skills, active, onOpen, sourceTitles = {}, empty = 'No skills yet.' }: SkillListProps) {
  if (!skills.length) return <div className="sk-empty">{empty}</div>
  const groups: { label: string; items: SkillView[] }[] = []
  for (const s of skills) {
    const label = s.source ?? ''
    let g = groups.find((x) => x.label === label)
    if (!g) groups.push((g = { label, items: [] }))
    g.items.push(s)
  }
  return (
    <div className="sk-list">
      {groups.map((g) => (
        <div key={g.label} className="sk-group">
          {(groups.length > 1 || g.label) && (
            <div className="sk-head">
              {sourceTitles[g.label] ?? g.label}
              {g.items[0]?.editable === false && <span className="sk-ro" title="Shared skills: this app can use them but not change them"><LockIcon /> read-only</span>}
            </div>
          )}
          {g.items.map((s) => (
            <button key={s.name} className={`sk-row${active === s.name ? ' active' : ''}`} title={`${s.description}${s.editable === false ? '\n\nShared, read-only.' : ''}`} onClick={() => onOpen(s.name)}>
              <span className="sk-name">{s.name}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
