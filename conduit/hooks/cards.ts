import type { CardKind, Pairing } from '../types/index'

export type Parsed =
  | { kind: 'pass' }
  | { kind: 'stale' }
  | { kind: 'cards', from: string, cards: { kind: CardKind, text: string }[], isDone: boolean }

const PASS: Parsed = { kind: 'pass' }

// The engine wraps another session's message as <cross-session-message from="…" from-mode="…">…</cross-session-message>.
const ENVELOPE = /<cross-session-message\b([^>]*)>([\s\S]*?)(?:<\/cross-session-message>|$)/
const FROM = /\bfrom="([^"]*)"/

/** Any token conduit mints: `cd` and six base-36 characters. */
export const ANY_TOKEN = 'cd[0-9a-z]{6}'

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Markup a reply may wrap the token or the kind in: bold, italics, code.
const WRAP = '(?:\\*\\*|__|\\*|_|`)?'

/**
 * A card line for a token pattern: an optional list marker (`-`, `*`, `+`,
 * `1.`), the token and the kind each optionally wrapped in bold, italics or
 * backticks, an optional colon after the token, then the kind and its text.
 */
const cardLine = (token: string): RegExp => new RegExp(
  '^\\s*(?:[-*+•]\\s+|\\d+[.)]\\s+)?(`)?' + WRAP + '(' + token + ')' + WRAP + '\\s*:?\\s*' + WRAP
    + '(suggest|note|ask|prompt|done)\\b' + WRAP + '\\s*:?' + WRAP + '\\s?(.*)$',
  'i',
)

/** The sender's address in a delivery's envelope, if it has one. */
export const envelopeFrom = (text: string): string | undefined => {
  const envelope = ENVELOPE.exec(text)
  return envelope ? FROM.exec(envelope[1] ?? '')?.[1] : undefined
}

const bodyOf = (text: string): string | undefined => ENVELOPE.exec(text)?.[2]

/** True when a peer delivery has a card line led by any conduit token. */
export const looksLikeCards = (text: string): boolean => {
  const line = cardLine(ANY_TOKEN)
  return (bodyOf(text) ?? '').split('\n').some(raw => line.test(raw))
}

/**
 * A delivery read against the pairing: cards when it comes from the paired
 * peer's `from` address (any address until one is fixed) and has lines led by
 * the token; `stale` when a line is led by a token of an earlier pairing;
 * anything else passes through unchanged.
 */
export const parseDelivery = (text: string, pairing: Pairing | undefined, retired: readonly string[] = []): Parsed => {
  const envelope = ENVELOPE.exec(text)
  if (!envelope) return PASS
  const lines = (envelope[2] ?? '').split('\n')
  if (retired.length > 0) {
    const old = cardLine(retired.map(escape).join('|'))
    if (lines.some(raw => old.test(raw))) return { kind: 'stale' }
  }
  if (!pairing) return PASS
  const from = FROM.exec(envelope[1] ?? '')?.[1]
  if (!from || (pairing.from !== undefined && pairing.from !== from)) return PASS
  const line = cardLine(escape(pairing.token))
  const cards: { kind: CardKind, text: string }[] = []
  let isDone = false
  let isCard = false
  let open: { kind: CardKind, text: string } | undefined
  for (const raw of lines) {
    const match = line.exec(raw)
    if (!match) {
      if (open) open.text += '\n' + raw
      continue
    }
    isCard = true
    const kind = (match[3] ?? '').toLowerCase()
    if (kind === 'done') {
      isDone = true
      open = undefined
      continue
    }
    const body = match[4] ?? ''
    open = { kind: kind as CardKind, text: match[1] ? body.replace(/`\s*$/, '') : body }
    cards.push(open)
  }
  if (!isCard) return PASS
  const kept = cards.map(card => ({ ...card, text: card.text.trim() })).filter(card => card.text !== '')
  return { kind: 'cards', from, cards: kept, isDone }
}
