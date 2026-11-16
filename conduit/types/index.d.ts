/** What a pairing is doing: `off` is not paired. */
export type Mode = 'off' | 'on-call' | 'watch' | 'autopilot'

/** Why autopilot stopped, as the tab says it. */
export type StopReason = 'off' | 'mode' | 'stop' | 'typing' | 'prompt' | 'done' | 'cap' | 'permission'

export type CardKind = 'suggest' | 'note' | 'ask' | 'prompt'

/**
 * `new` until the person acts on it (an autopilot prompt: until the turn ends);
 * `sent` a suggestion or prompt submitted, `answered` an ask, `dismissed` gone
 * from view, `dropped` an autopilot prompt autopilot stopped before it was sent.
 */
export type CardStatus = 'new' | 'sent' | 'answered' | 'dismissed' | 'dropped'

export type Card = {
  id: string
  kind: CardKind
  text: string
  at: number
  status: CardStatus
  answer?: 'yes' | 'no'
}

/**
 * The companion: its name in the peer list, which every send goes to; the
 * token every card line carries; and the sender address its first card fixed,
 * used only to match its replies.
 */
export type Pairing = {
  peer: string
  token: string
  from?: string
}

export type Autopilot = {
  sent: number
  stop?: StopReason
}

/** The companion's autopilot prompt, held until the turn ends; sent only while the pairing that gave it is in autopilot. */
export type Pending = {
  text: string
  cardId: string
  token: string
}

/**
 * The main loop's turn: `starting` from conduit's own submission until its
 * `turn.start`, `running` with the id that aborts it.
 */
export type Turn = { kind: 'idle' } | { kind: 'starting' } | { kind: 'running', id: string }

export type Conduit = {
  mode: Mode
  /** The live pairing; after `off`, the last one, its token retired. */
  pairing?: Pairing
  /** Tokens of this session's earlier pairings, newest last: a card carrying one is dropped. */
  retired: string[]
  pending?: Pending
  cards: Card[]
  unread: number
  autopilot: Autopilot
  /** A digest went out and no card has come back since: the lens thinks. */
  isAwaiting: boolean
  lastSentAt?: number
  flareAt?: number
  /** When the companion's latest reply had no card line and went to the session as it came; cleared by cards. */
  plainAt?: number
  turn: Turn
}

/** One line of what happened in the session, before it is cut into a digest. */
export type Row = {
  kind: 'prompt' | 'reply' | 'tool' | 'error'
  text: string
}

/**
 * Rows not yet sent, and how many were dropped past the cap since the last
 * send. `base` numbers the first row (each row after it one more, never reused);
 * `epoch` changes when a pairing starts or ends, so a send of the old buffer
 * acknowledges nothing in the new one.
 */
export type Kept = {
  rows: Row[]
  dropped: number
  base: number
  epoch: number
}

/** What one digest carried: rows numbered below `through`, and `dropped` of the count. */
export type Batch = {
  through: number
  dropped: number
  epoch: number
}

declare module 'claude-code' {
  interface PluginState {
    conduit: {
      conduit: Shaped<Conduit>
      kept: Shaped<Kept>
      tick: number
    }
  }
}
