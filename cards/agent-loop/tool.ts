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

export function toSchemas(tools: ToolDef[]): ToolSchema[] {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
}
