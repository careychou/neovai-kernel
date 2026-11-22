import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_TOOL_LIMITS, type ToolLimits } from '../agent-loop/tool-limits'
import { migrateProviders, type ProviderEntry } from '../model-providers/providers'

export interface Settings extends ToolLimits {
  /** Model providers; the first one's models appear unprefixed, others as `<id>::<model>`. */
  providers: ProviderEntry[]
  defaultModel: string
  maxConcurrency: number
  maxTurnsMain: number
  /** Output-token cap per model call; 0 = each model's maximum. */
  maxOutputTokens: number
  reasoning: 'off' | 'low' | 'medium' | 'high'
  /** Request body cap in MB. */
  requestMaxMB: number
}

/** Encrypts secrets at rest. The host app supplies one (Electron's safeStorage, for example). */
export interface SecretBox {
  available(): boolean
  /** Returns base64 text. */
  seal(plain: string): string
  /** Throws when the value cannot be decrypted. */
  open(sealed: string): string
}

export const DEFAULT_SETTINGS: Settings = {
  providers: [{ id: 'default', name: 'Custom endpoint', kind: 'openai', baseUrl: 'http://localhost:4000/v1', apiKey: '' }],
  defaultModel: '',
  maxConcurrency: 20,
  maxTurnsMain: 500,
  maxOutputTokens: 0,
  ...DEFAULT_TOOL_LIMITS,
  reasoning: 'medium',
  requestMaxMB: 20
}

export interface SettingsOptions<T extends Settings = Settings> {
  /** Folder that holds settings.json. */
  dir: string
  box: SecretBox
  /** Extra or overriding defaults; an app may add its own fields here. */
  defaults?: Partial<T>
}

/** Settings stored as `<dir>/settings.json`, with provider keys sealed by `box`. */
export function createSettings<T extends Settings = Settings>(o: SettingsOptions<T>): { load(): T; save(s: T): void } {
  const file = path.join(o.dir, 'settings.json')
  // Sealed secrets that couldn't be opened at load; saving writes them back unchanged instead of blanking them
  const unreadable = new Map<string, { apiKeyEnc?: string; clientSecretEnc?: string }>()
  const defaults = { ...DEFAULT_SETTINGS, ...o.defaults } as T

  const open = (enc?: string): string | undefined => {
    if (!enc || !o.box.available()) return undefined
    try { return o.box.open(enc) } catch { return undefined }
  }

  return {
    load() {
      let raw: any
      try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return structuredClone(defaults) }
      unreadable.clear()
      for (const p of Array.isArray(raw.providers) ? raw.providers : []) {
        const keep = {
          ...(p.apiKeyEnc && open(p.apiKeyEnc) === undefined ? { apiKeyEnc: p.apiKeyEnc } : {}),
          ...(p.clientSecretEnc && open(p.clientSecretEnc) === undefined ? { clientSecretEnc: p.clientSecretEnc } : {})
        }
        if (keep.apiKeyEnc || keep.clientSecretEnc) unreadable.set(p.id, keep)
      }
      return { ...structuredClone(defaults), ...migrateProviders(raw, defaults.providers[0], open) }
    },
    save(s) {
      const enc = o.box.available()
      const out = {
        ...s,
        providers: s.providers.map(({ apiKey, clientSecret, ...p }) => {
          const kept = unreadable.get(p.id) ?? {}
          const key = apiKey ? (enc ? { apiKeyEnc: o.box.seal(apiKey) } : { apiKey }) : kept.apiKeyEnc ? { apiKeyEnc: kept.apiKeyEnc } : { apiKey: '' }
          const secret = clientSecret ? (enc ? { clientSecretEnc: o.box.seal(clientSecret) } : { clientSecret }) : kept.clientSecretEnc ? { clientSecretEnc: kept.clientSecretEnc } : {}
          return { ...p, ...key, ...secret }
        })
      }
      fs.mkdirSync(o.dir, { recursive: true })
      fs.writeFileSync(file, JSON.stringify(out, null, 2))
    }
  }
}
