/** Caps on what tools hand back to the model. App-wide; apply settings with setToolLimits. */

export interface ToolLimits {
  /** Shell output kept per call (tail), in chars. */
  shellOutputChars: number
  /** Upper bound for a sync shell command's timeout, in seconds. */
  shellTimeoutMaxSec: number
  /** read_file result cap, in chars. */
  readFileChars: number
  /** Largest max_length web_fetch accepts, in chars. */
  webFetchMaxChars: number
}

export const DEFAULT_TOOL_LIMITS: ToolLimits = {
  shellOutputChars: 30_000,
  shellTimeoutMaxSec: 600,
  readFileChars: 50_000,
  webFetchMaxChars: 20_000
}

export const toolLimits: ToolLimits = { ...DEFAULT_TOOL_LIMITS }

export function setToolLimits(l: Partial<ToolLimits>): void {
  for (const k of Object.keys(DEFAULT_TOOL_LIMITS) as (keyof ToolLimits)[]) {
    const v = Number(l[k])
    toolLimits[k] = Number.isFinite(v) && v > 0 ? v : DEFAULT_TOOL_LIMITS[k]
  }
}
