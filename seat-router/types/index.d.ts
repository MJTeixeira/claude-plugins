export type SeatVendor = 'codex' | 'agy' | 'claude'
export type SeatTier = 'reviewer' | 'owner'
export type SeatStatus = 'running' | 'waiting' | 'reporting' | 'finished' | 'reported'

export type SeatDisplay = {
  id: string
  description: string
  vendor: SeatVendor
  model: string
  effort: string
  tier: SeatTier
  status: SeatStatus
  startedAt: number
  steps: number
  lastAction?: string
  endedAt?: number
  liveTokens?: number
  lastTokens?: number
}

export type ClaudeSeatDisplay = {
  id: string
  model?: string
  effort?: string
  startedAt: number
  endedAt?: number
  tokens?: number
  steps: number
}

export type SeatQuotaWindow = {
  used: number
  resetAt?: number
}

export type SeatQuotaDisplay = {
  vendor: SeatVendor
  checkedAt: number
  known: boolean
  out: boolean
  detail?: string
  fiveHour?: SeatQuotaWindow
  weekly?: SeatQuotaWindow
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
      quotas: Shaped<Partial<Record<SeatVendor, SeatQuotaDisplay>>>
      queue: QueueDisplay | null
      claudeSeats: Shaped<ClaudeSeatDisplay[]>
      seatPaneTick: number
      seatPanel: { isDoneCollapsed: boolean }
      vendors: Shaped<Exclude<SeatVendor, 'claude'>[] | null>
      // The models each installed CLI reports; null until asked.
      models: Shaped<Partial<Record<Exclude<SeatVendor, 'claude'>, { model: string, efforts: string[], isDefault?: boolean }[]>> | null>
    }
  }

  interface McpToolInputs {
    'mcp__seat-router__queue': QueueDisplay
    'mcp__seat-router__stop': { id: string }
  }
}
