import type { Card, CardStatus, Conduit, Mode, StopReason, Turn } from '../types/index'

export const IDLE: Conduit = { mode: 'off', retired: [], cards: [], unread: 0, autopilot: { sent: 0 }, isAwaiting: false, turn: { kind: 'idle' } }

export const CARDS_KEPT = 50

/** Tokens of earlier pairings kept to recognise their late cards. */
export const RETIRED_KEPT = 20

/** Where a pairing goes when autopilot stops on its own: the companion keeps watching. */
export const AFTER_AUTOPILOT: Mode = 'watch'

export type Event =
  | { type: 'pair', peer: string, token: string, mode: 'on-call' | 'watch' }
  | { type: 'unpair' }
  | { type: 'mode', mode: 'on-call' | 'watch' | 'autopilot' }
  | { type: 'stop', reason: Exclude<StopReason, 'off' | 'mode' | 'cap'> }
  | { type: 'sent', at: number }
  | { type: 'cards', cards: Card[], from: string, at: number }
  | { type: 'release', cap: number }
  | { type: 'card', id: string, status: CardStatus, answer?: 'yes' | 'no' }
  | { type: 'read' }
  | { type: 'plain', at: number }
  | { type: 'turn', turn: Turn }

type Of<T extends Event['type']> = Extract<Event, { type: T }>

const leaving = (s: Conduit, reason: StopReason): Conduit['autopilot'] =>
  s.mode === 'autopilot' ? { ...s.autopilot, stop: reason } : s.autopilot

const retire = (s: Conduit): string[] => {
  const token = s.pairing?.token
  if (token === undefined || s.retired.includes(token)) return s.retired
  return [...s.retired, token].slice(-RETIRED_KEPT)
}

const setStatus = (cards: readonly Card[], id: string, status: CardStatus): Card[] =>
  cards.map(card => card.id === id ? { ...card, status } : card)

/** The held prompt let go unsent: its card says so. */
const drop = (s: Conduit): Conduit => {
  if (!s.pending) return s
  const { pending, ...rest } = s
  return { ...rest, cards: setStatus(s.cards, pending.cardId, 'dropped') }
}

const TRANSITIONS: { [T in Event['type']]: (s: Conduit, e: Of<T>) => Conduit } = {
  pair: (s, e) => ({
    ...IDLE,
    retired: retire(s),
    turn: s.turn,
    mode: e.mode,
    pairing: { peer: e.peer, token: e.token },
  }),
  unpair: s => ({ ...drop(s), mode: 'off', retired: retire(s), autopilot: leaving(s, 'off'), isAwaiting: false }),
  mode: (s, e) => {
    if (s.mode === 'off' || s.mode === e.mode) return s
    if (e.mode === 'autopilot') return { ...drop(s), mode: 'autopilot', autopilot: { sent: 0 } }
    return { ...drop(s), mode: e.mode, autopilot: leaving(s, 'mode') }
  },
  stop: (s, e) => s.mode === 'autopilot'
    ? { ...drop(s), mode: AFTER_AUTOPILOT, autopilot: { ...s.autopilot, stop: e.reason } }
    : s,
  sent: (s, e) => s.mode === 'off' ? s : { ...s, isAwaiting: true, lastSentAt: e.at },
  cards: (s, e) => {
    if (s.mode === 'off' || !s.pairing) return s
    const unread = e.cards.filter(card => card.kind !== 'prompt').length
    const prompts = s.mode === 'autopilot' ? e.cards.filter(card => card.kind === 'prompt') : []
    const held = prompts.at(-1)
    const base = held ? drop(s) : s
    const superseded = new Set(prompts.slice(0, -1).map(card => card.id))
    const arrived = e.cards.map(card => superseded.has(card.id) ? { ...card, status: 'dropped' as const } : card)
    const { plainAt, ...rest } = base
    return {
      ...rest,
      pairing: { ...s.pairing, from: s.pairing.from ?? e.from },
      cards: [...base.cards, ...arrived].slice(-CARDS_KEPT),
      unread: s.unread + unread,
      isAwaiting: false,
      flareAt: e.cards.length > 0 ? e.at : s.flareAt,
      ...(held ? { pending: { text: held.text, cardId: held.id, token: s.pairing.token } } : {}),
    }
  },
  release: (s, e) => {
    if (!s.pending) return s
    if (s.mode !== 'autopilot' || s.pending.token !== s.pairing?.token) return drop(s)
    const { pending, ...rest } = s
    const sent = s.autopilot.sent + 1
    const isCapped = e.cap > 0 && sent >= e.cap
    return {
      ...rest,
      cards: setStatus(s.cards, pending.cardId, 'sent'),
      turn: { kind: 'starting' } as const,
      ...(isCapped ? { mode: AFTER_AUTOPILOT, autopilot: { sent, stop: 'cap' as const } } : { autopilot: { sent } }),
    }
  },
  card: (s, e) => ({
    ...s,
    cards: s.cards.map(card => card.id === e.id ? { ...card, status: e.status, ...(e.answer ? { answer: e.answer } : {}) } : card),
  }),
  read: s => s.unread === 0 ? s : { ...s, unread: 0 },
  plain: (s, e) => s.mode === 'off' ? s : { ...s, plainAt: e.at },
  turn: (s, e) => ({ ...s, turn: e.turn }),
}

export const transition = (s: Conduit, e: Event): Conduit =>
  (TRANSITIONS[e.type] as (s: Conduit, e: Event) => Conduit)(s, e)

/** The prompt a `release` let out of `before`, if it sent one. */
export const released = (before: Conduit, after: Conduit): string | undefined =>
  before.pending && after.autopilot.sent === before.autopilot.sent + 1 && before.mode === 'autopilot'
    ? before.pending.text
    : undefined

/** What the tab says about autopilot. */
export const STOP_WORDS: Record<StopReason, string> = {
  off: 'you turned conduit off',
  mode: 'you chose another mode',
  stop: 'you pressed Stop',
  typing: 'you started typing',
  prompt: 'you sent a prompt of your own',
  done: 'the companion said done',
  cap: 'it reached its prompt cap',
  permission: 'a permission dialog needs you',
}

export const sendsOnTurns = (mode: Mode): boolean => mode === 'watch' || mode === 'autopilot'
