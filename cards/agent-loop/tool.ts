import type { Hooks, PermissionKind, ToolSchema } from './types'

/** Decides whether a risky tool call may run. The approval card provides one. */
export interface Gate {
  check(agentId: string, kind: PermissionKind, detail: string): Promise<boolean>
}

export interface ToolContext {
  cwd: string
  agentId: string
  depth: number
  signal: AbortSignal
  /** Id of the tool call being run. */
  callId?: string
  hooks: Hooks
  gate: Gate
  /** Per-chat objects that cards hand to their own tools, keyed by card (e.g. `shells`). */
  services: Record<string, unknown>
}

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  permission?: PermissionKind
  /** Short human summary of a call, used for approval prompts. */
  summarize?(args: any): string
  run(args: any, ctx: ToolContext): Promise<string>
}

/** Extra argument every tool takes: a plain-language label the chat shows instead of the raw call. */
export const INTENT_ARG = 'intent'

const INTENT_SCHEMA = { type: 'string', description: 'Always set: what this step does, in plain words for a non-technical user, 3 to 8 words, no code, file paths or commands. Example: "Read the market scan skill", "Check today\'s prices", "Update the Recommendations screen".' }

/** Adds the `intent` argument to a tool's parameters, unless the tool already defines one. */
export function withIntent(parameters: Record<string, unknown>): Record<string, unknown> {
  const props = (parameters as any)?.properties
  if (props && typeof props === 'object' && INTENT_ARG in props) return parameters
  return { ...parameters, type: (parameters as any)?.type ?? 'object', properties: { [INTENT_ARG]: INTENT_SCHEMA, ...(props ?? {}) } }
}

/** True when the tool takes `intent` as one of its own arguments, so it must not be removed before the call. */
export const ownsIntent = (t: ToolDef) => !!(t.parameters as any)?.properties?.[INTENT_ARG]

export function toSchemas(tools: ToolDef[]): ToolSchema[] {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: withIntent(t.parameters) } }))
}

/** Rules for the progress an agent writes in chat, so a non-technical user can follow it. Append to a system prompt. */
export const PLAIN_LANGUAGE_RULES = `# Talking to the user
The user is not a developer. Whatever you write in chat, and every tool call's "intent", is for them:
- Say what you are doing and why in everyday words: "I'll add a news panel for the stocks you hold", not "I'll patch ui/MarketScan.tsx with a useApp hook".
- Leave out file names, paths, code, commands, function or variable names, JSON keys and error stack traces, unless the user asked for them. Name things the way the app shows them (screen names, button labels, skill titles).
- Keep progress notes to one short sentence. Put the detail into the work, not the chat.
- In your final answer, say what changed for the user and anything they need to decide.`
