import { atom, read, update } from 'claude-code'
import type { AgentSpawnInput, AgentSpawnResult, AgentStatus, EngineInterface, TurnUsage } from 'claude-code'
import type { NativeAgent } from '../types/index'
import { toolAction, usageTokens } from '../bin/vendors/index.mjs'
import type { Card } from './art'
import { boundDone } from './delivery'

// Built from events, not $.agent.list(): the list drops an agent seconds after it ends and never lists workflow agents.
// While the list holds an agent its status there outranks the record: a turn that ends on background work leaves the
// agent waiting, and it steps again once that work finishes.
const agentsState = atom({ plugin: 'seat-router', key: 'agents' } as const, [], { shape: 'native-agents-1' })

const bound = (agents: readonly NativeAgent[]): NativeAgent[] => boundDone(agents, agent => agent.status === 'done')

const running = (agent: NativeAgent): NativeAgent => ({ ...agent, status: 'running' })

export const LISTED_RUNNING: ReadonlySet<AgentStatus> = new Set(['pending', 'running', 'waiting'])

async function change($: EngineInterface, id: string, edit: (agent: NativeAgent) => NativeAgent): Promise<void> {
  if (!(await read($, agentsState)).some(agent => agent.id === id)) return
  await update($, agentsState, agents => agents.some(agent => agent.id === id)
    ? bound(agents.map(agent => agent.id === id ? edit(agent) : agent)) : agents)
}

export async function agentSpawned($: EngineInterface, spawn: AgentSpawnInput, started: AgentSpawnResult): Promise<boolean> {
  const id = 'agentId' in started ? started.agentId : undefined
  if (id === undefined) return false
  const now = await $.clock.now()
  const origin = spawn.workflow !== undefined || spawn.subagentType === 'workflow-subagent' ? 'workflow' : 'subagent'
  await update($, agentsState, agents => {
    const prior = agents.find(agent => agent.id === id)
    const agent: NativeAgent = prior
      ? running(prior)
      : { id, origin, description: spawn.description, model: started.model ?? '', status: 'running', startedAt: now, tokens: 0, steps: 0 }
    return bound([...agents.filter(other => other.id !== id), agent])
  })
  return true
}

export async function agentStepped($: EngineInterface, id: string, step: { model: string, effort?: string | number }, usage: TurnUsage | null): Promise<void> {
  const tokens = usageTokens(usage)
  await change($, id, agent => ({
    ...running(agent),
    model: agent.model || step.model,
    ...(step.effort === undefined ? {} : { effort: String(step.effort) }),
    tokens: agent.tokens + tokens,
  }))
}

export async function agentActed($: EngineInterface, id: string, tool: string, input: Record<string, unknown>): Promise<void> {
  const lastAction = toolAction(tool, input)
  await change($, id, agent => ({ ...agent, lastAction }))
}

// A step is a finished tool call, as a seat counts it from its transcript.
export async function agentToolDone($: EngineInterface, id: string): Promise<void> {
  await change($, id, agent => ({ ...agent, steps: agent.steps + 1 }))
}

export async function agentEnded($: EngineInterface, id: string): Promise<void> {
  const now = await $.clock.now()
  await change($, id, agent => ({ ...agent, status: 'done', endedAt: now }))
}

/** Each recorded agent with the status it shows: the engine's while it lists the agent, else the recorded one. */
export async function nativeAgents($: EngineInterface): Promise<NativeAgent[]> {
  const agents = await read($, agentsState)
  if (agents.length === 0) return []
  const listed = await $.agent.list()
  const statuses = new Map(listed.map(agent => [agent.id, agent.status]))
  return agents.map(agent => {
    const listedAs = statuses.get(agent.id)
    if (listedAs === undefined) return agent
    return LISTED_RUNNING.has(listedAs) ? running(agent) : { ...agent, status: 'done' }
  })
}

export const agentCard = (agent: NativeAgent): Card => ({
  id: agent.id,
  origin: agent.origin,
  vendor: 'claude',
  description: agent.description,
  model: agent.model,
  effort: agent.effort ?? '',
  status: agent.status,
  startedAt: agent.startedAt,
  endedAt: agent.status === 'done' ? agent.endedAt : undefined,
  tokens: agent.tokens,
  steps: agent.steps,
  lastAction: agent.lastAction,
})
