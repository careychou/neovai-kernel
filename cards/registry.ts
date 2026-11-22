import agentLoop from './agent-loop/card.json' with { type: 'json' }
import modelProviders from './model-providers/card.json' with { type: 'json' }
import fileTools from './file-tools/card.json' with { type: 'json' }
import shell from './shell/card.json' with { type: 'json' }
import webFetch from './web-fetch/card.json' with { type: 'json' }
import approval from './approval/card.json' with { type: 'json' }
import sessionStore from './session-store/card.json' with { type: 'json' }
import settings from './settings/card.json' with { type: 'json' }
import skills from './skills/card.json' with { type: 'json' }
import chatView from './chat-view/card.json' with { type: 'json' }
import runtimeAgent from './runtime-agent/card.json' with { type: 'json' }
import liveUi from './live-ui/card.json' with { type: 'json' }

export interface CardInfo { name: string; description: string; dependencies: string[] }

/** Every card in the kernel, in inventory order. */
export const REGISTRY: CardInfo[] = [agentLoop, modelProviders, fileTools, shell, webFetch, approval, sessionStore, settings, skills, chatView, runtimeAgent, liveUi]
