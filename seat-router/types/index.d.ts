export type SeatVendor = 'codex' | 'agy' | 'claude'
export type SeatTier = 'reviewer' | 'owner'
export type SeatStatus = 'running' | 'waiting' | 'reporting' | 'finished' | 'reported'

export type SeatDisplay = {
  id: string
  description: string
  vendor: SeatVendor
  model: string
  effort: string
  // The other Claude account a claude seat ran on.
  account?: string
  tier: SeatTier
  status: SeatStatus
  startedAt: number
  steps: number
  lastAction?: string
  endedAt?: number
  liveTokens?: number
  lastTokens?: number
}

/** A subagent or workflow agent the engine ran for this session, kept from its spawn, steps, tool calls and turn ends. */
export type NativeAgent = {
  id: string
  origin: 'subagent' | 'workflow'
  description: string
  model: string
  effort?: string
  status: 'running' | 'done'
  startedAt: number
  endedAt?: number
  tokens: number
  steps: number
  lastAction?: string
}

export type SeatQuotaState = 'free' | 'unknown' | 'busy' | 'out'

/** One window of a vendor's reading; `used` is a percentage. */
export type SeatQuotaWindow = {
  id: string
  used: number
  state: SeatQuotaState
}

/** How a vendor's quota stands in the merged ledger over its band scopes; for Claude, the state delegate mode reads. */
export type SeatQuotaDisplay = {
  vendor: SeatVendor
  state: SeatQuotaState
  /** When an out vendor is back: a time of day, with its date when more than a day away. */
  back?: string
  windows: SeatQuotaWindow[]
}

export type QueueDisplay = {
  done: number
  running: number
  pending: number
  label?: string
  now?: string
}

declare module 'claude-code' {
  interface PluginState {
    'seat-router': {
      seats: Shaped<SeatDisplay[]>
      agents: Shaped<NativeAgent[]>
      quotas: Shaped<Partial<Record<SeatVendor, SeatQuotaDisplay>>>
      queue: QueueDisplay | null
      protection: string
      seatPaneTick: number
      seatPanel: { isDoneCollapsed: boolean }
      delegateShown: string | null
      vendors: Shaped<Exclude<SeatVendor, 'claude'>[] | null>
      // The models each installed CLI reports; null until asked.
      models: Shaped<Partial<Record<Exclude<SeatVendor, 'claude'>, { model: string, efforts: string[], isDefault?: boolean }[]>> | null>
    }
  }

  interface McpToolInputs {
    'mcp__seat-router__queue': QueueDisplay
  }
}
