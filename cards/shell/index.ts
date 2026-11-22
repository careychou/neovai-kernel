import type { ToolDef } from '../agent-loop/tool'
import { shell, readShell, writeShell, stopShell, listShells } from './shell'

export { runShell, ShellManager, shell, readShell, writeShell, stopShell, listShells } from './shell'

/** All shell tools. Put a `ShellManager` in `services.shells` to enable the async ones. */
export const shellTools: ToolDef[] = [shell, readShell, writeShell, stopShell, listShells]
