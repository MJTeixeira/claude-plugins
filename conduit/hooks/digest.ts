import type { Batch, Kept, Mode, Row, Turn } from '../types/index'

/** Characters one row keeps, by kind. */
export const ROW_CAP: Record<Row['kind'], number> = { prompt: 1200, reply: 1600, tool: 140, error: 240 }

/** Characters of rows one digest carries; past it the oldest rows go. */
export const DIGEST_CAP = 8000

/** Rows on-call keeps between sends; past it the oldest go. */
export const KEPT_CAP = 300

const ARG_KEYS = ['command', 'file_path', 'notebook_path', 'path', 'pattern', 'url', 'query', 'skill', 'description', 'prompt', 'to']

const cut = (text: string, max: number): string => text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + '…'

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** A tool call's name and its one telling argument, on one short line; never its output. */
export const toolLine = (tool: string, input: unknown): string => {
  const fields = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const key = ARG_KEYS.find(name => typeof fields[name] === 'string' && fields[name] !== '')
  const arg = key ? oneLine(String(fields[key])) : ''
  return cut(arg ? tool + ': ' + arg : tool, ROW_CAP.tool)
}

export const row = (kind: Row['kind'], text: string): Row => ({
  kind,
  text: cut(kind === 'tool' || kind === 'error' ? oneLine(text) : text.trim(), ROW_CAP[kind]),
})

export const EMPTY: Kept = { rows: [], dropped: 0, base: 0, epoch: 0 }

/** Adds rows to what on-call keeps, the oldest going past `cap`, counted as dropped. */
export const keep = (kept: Kept, rows: readonly Row[], cap = KEPT_CAP): Kept => {
  const all = [...kept.rows, ...rows.filter(one => one.text !== '')]
  const over = Math.max(0, all.length - cap)
  return { ...kept, rows: all.slice(over), dropped: kept.dropped + over, base: kept.base + over }
}

/** What a digest of `kept` as it stands carries. */
export const batchOf = (kept: Kept): Batch => ({ through: kept.base + kept.rows.length, dropped: kept.dropped, epoch: kept.epoch })

/** Removes what a delivered batch carried, keeping rows and drops that came after it. */
export const ack = (kept: Kept, batch: Batch): Kept => {
  if (batch.epoch !== kept.epoch) return kept
  const sent = Math.max(0, Math.min(kept.rows.length, batch.through - kept.base))
  return { ...kept, rows: kept.rows.slice(sent), base: kept.base + sent, dropped: Math.max(0, kept.dropped - batch.dropped) }
}

/** An empty buffer for a pairing that starts or ends; a late batch of the old one acknowledges nothing here. */
export const reset = (kept: Kept): Kept => ({ rows: [], dropped: 0, base: kept.base + kept.rows.length, epoch: kept.epoch + 1 })

const MARK: Record<Row['kind'], string> = { prompt: 'USER', reply: 'ASSISTANT', tool: 'TOOL', error: 'ERROR' }

const render = (one: Row): string => MARK[one.kind] + ': ' + one.text

/**
 * Why a digest goes out. `handoff`: a turn ended and the companion's held
 * autopilot prompt started the next. `asked-*`: Ask, `/conduit ask` or
 * entering autopilot, while a turn runs or none does.
 */
export type DigestKind = 'prompt' | 'turn-end' | 'handoff' | 'asked-running' | 'asked-idle'

const KINDS: Record<DigestKind, { says: string, isTurnRunning: boolean }> = {
  prompt: {
    says: 'This is the user\'s prompt; the session is working on it now. Reply only if the prompt is wrong or will mislead the session (a misread word, a missing detail); otherwise stay quiet, the turn-end digest follows.',
    isTurnRunning: true,
  },
  'turn-end': { says: 'The turn ended: this is what the session did and answered. Any card fits.', isTurnRunning: false },
  handoff: { says: 'The turn ended: this is what the session did and answered. Your prompt was submitted as the next one and is running now.', isTurnRunning: true },
  'asked-running': { says: 'The user asked for this digest while a turn is still running.', isTurnRunning: true },
  'asked-idle': { says: 'The user asked for this digest; no turn is running.', isTurnRunning: false },
}

/** What a send on request is, by the turn it meets. */
export const askedKind = (turn: Turn): DigestKind => turn.kind === 'idle' ? 'asked-idle' : 'asked-running'

/** The closing lines: how the companion answers, with the pairing token. */
export const instructions = (token: string, mode: Mode, kind: DigestKind): string[] => [
  '---',
  'Your turn\'s plain text never reaches the user. To answer, send a message back to the sender of this digest, with the send tool this message\'s envelope tells you to use. Sending nothing is how you stay quiet.',
  'A card is a line that starts with the token ' + token + ', then its kind and a colon, as here:',
  token + ' suggest: <a better next prompt; the user can send it with one press>',
  token + ' note: <context the user should know>',
  token + ' ask: <a yes or no question for the user>',
  ...(mode === 'autopilot' && KINDS[kind].isTurnRunning
    ? ['Autopilot is on and a turn is running: send no prompt line until the digest that ends it.']
    : mode === 'autopilot'
    ? [
      'Autopilot is on: you act as the user. Send the next prompt as',
      token + ' prompt: <the prompt, submitted as the user\'s when the turn ends>',
      'or, when the work is finished, the line ' + token + ' done',
    ]
    : []),
  'Lines after a card line, up to the next one, belong to that card. Send nothing when there is nothing useful to say.',
]

export type Digest = { text: string, rows: number, dropped: number }

/**
 * One message for the companion: the rows, newest kept within `cap`, a line
 * saying how many were dropped, the question if any, then the card format.
 */
export const buildDigest = (args: {
  rows: readonly Row[]
  dropped: number
  token: string
  mode: Mode
  question?: string
  kind: DigestKind
  cap?: number
}): Digest => {
  const cap = args.cap ?? DIGEST_CAP
  const lines: string[] = []
  let used = 0
  for (const one of [...args.rows].reverse()) {
    const line = render(one)
    if (used + line.length + 1 > cap) break
    lines.unshift(line)
    used += line.length + 1
  }
  const dropped = args.dropped + args.rows.length - lines.length
  const question = args.question?.trim()
  const text = [
    'conduit digest from the user\'s session (mode ' + args.mode + '). You are their companion: read, then correct, suggest or stay quiet.',
    KINDS[args.kind].says,
    ...(dropped > 0 ? ['(' + dropped + ' earlier ' + (dropped === 1 ? 'row was' : 'rows were') + ' dropped to keep this short)'] : []),
    ...(lines.length === 0 ? ['(nothing new since the last digest)'] : lines),
    ...(question ? ['QUESTION: ' + cut(question, ROW_CAP.prompt)] : []),
    ...instructions(args.token, args.mode, args.kind),
  ].join('\n')
  return { text, rows: lines.length, dropped }
}
