declare const SNOWFLAKE: unique symbol
export type Snowflake = string & { readonly [SNOWFLAKE]: true }
export const asSnowflake = (text: string): Snowflake | undefined => /^\d{15,21}$/.test(text) ? text as Snowflake : undefined
export const isNewer = (a: Snowflake, b: Snowflake): boolean => BigInt(a) > BigInt(b)
export const justBefore = (id: Snowflake): Snowflake => String(BigInt(id) - 1n) as Snowflake
export const mintedAt = (id: Snowflake): number => Number(BigInt(id) >> 22n) + 1_420_070_400_000

export type Room = {
  channel: Snowflake
  operator: Snowflake | undefined
  fleet: ReadonlySet<Snowflake>
  guests: ReadonlySet<Snowflake>
  wakeRole: Snowflake | undefined
  /** The home channel: the operator's messages there, and in the operator's direct messages, wake without a mention. */
  home: Snowflake | undefined
  cap: number
  idleMs: number
}
export type TokenSource = { file: string | undefined, inline: string | undefined }
export type Setup =
  | { kind: 'ready', room: Room, token: TokenSource, problems: readonly string[] }
  | { kind: 'idle', why: string }
/** The loop cap both rooms count against: Discord bot messages since a human post, Codex messages since a human prompt. */
export const capOf = (options: Record<string, unknown>): number => typeof options.loopCap === 'number' && Number.isInteger(options.loopCap)
  && options.loopCap >= 1 && options.loopCap <= 1000 ? options.loopCap : 50
const textOf = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
export const setupOf = (options: Record<string, unknown>): Setup => {
  const channel = asSnowflake(textOf(options.channel))
  if (!channel) return { kind: 'idle', why: 'no valid room channel' }
  const file = textOf(options.tokenFile) || undefined
  const inline = textOf(options.token) || undefined
  if (!file && !inline) return { kind: 'idle', why: 'no bot token source' }
  const problems: string[] = []
  const idOf = (value: string, label: string): Snowflake | undefined => {
    const id = asSnowflake(value)
    if (value && !id) problems.push(label + ' contains an invalid Discord id.')
    return id
  }
  const idsOf = (value: unknown, label: string): Set<Snowflake> => new Set(textOf(value).split(',')
    .map(value => idOf(value.trim(), label)).filter((id): id is Snowflake => id !== undefined))
  const fleet = idsOf(options.fleet, 'Fleet list')
  const guests = idsOf(options.guests, 'Guest list')
  for (const id of guests) if (fleet.delete(id)) problems.push('An id in both lists remains a guest.')
  let home = idOf(textOf(options.homeChannel), 'Home channel')
  if (home === channel) { problems.push('The home channel is the room channel; it stays the room.'); home = undefined }
  const cap = capOf(options)
  const idle = typeof options.conversationIdleMinutes === 'number' && Number.isInteger(options.conversationIdleMinutes)
    && options.conversationIdleMinutes >= 1 && options.conversationIdleMinutes <= 10_080 ? options.conversationIdleMinutes : 120
  return { kind: 'ready', token: { file, inline }, problems, room: {
    channel, operator: idOf(textOf(options.operator), 'Operator'), fleet, guests,
    wakeRole: idOf(textOf(options.wakeRole), 'Wake role'), home, cap, idleMs: idle * 60 * 1000,
  } }
}

export const tokenIn = (fileText: string): string | undefined => {
  for (const line of fileText.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?DISCORD_BOT_TOKEN\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s#]+))\s*(?:#.*)?$/.exec(line)
    const token = match && (match[1] ?? match[2] ?? match[3])?.trim()
    if (token) return token
  }
  return undefined
}
export type Me = { id: Snowflake, name: string }
export type Author = { id: Snowflake, name: string, isBot: boolean }
export type Message = { id: Snowflake, author: Author, content: string, mentions: readonly Snowflake[], mentionedBots: readonly Me[], roles: readonly Snowflake[], attachments: number,
  /** A notice Discord posts itself (a thread created, a pin): never a wake, a join, a cap count or a human post. */
  isSystem: boolean }
/** The channel a conversation belongs to: the room's, the home channel, or the operator's direct messages with the bot. */
export type Place = 'room' | 'home' | 'dm'
export const PLACES: readonly Place[] = ['room', 'home', 'dm']
export type Conversation = { id: Snowflake, name: string, place: Place, isThread: boolean }
/** Direct messages are read only with a home channel, and only those with the operator. */
export const isDmOn = (room: Room): room is Room & { operator: Snowflake, home: Snowflake } => room.home !== undefined && room.operator !== undefined
export type Standing = 'you' | 'operator' | 'fleet' | 'guest' | 'stranger'
export const standingOf = (room: Room, me: Me, author: Author): Standing => author.id === me.id ? 'you'
  : author.id === room.operator ? 'operator' : room.guests.has(author.id) ? 'guest' : room.fleet.has(author.id) ? 'fleet' : 'stranger'
export const isHuman = (author: Author): boolean => !author.isBot
/** Another bot seen in a conversation, by its newest message or mention there. */
export type Peer = { id: Snowflake, name: string, at: Snowflake }
/**
 * Where this bot stands in one conversation after the message at `cursor`. `member` is true while it participates:
 * it joined by being mentioned (itself or its wake role) or by posting, and no gap between messages has exceeded the idle time.
 * `peers` and `roleAt` (the last wake-role mention) hold only what is within the idle time of `cursor`. `said` is the newest message
 * that is not a system notice, set only while system notices follow it; the idle time runs from it.
 */
export type Checkpoint = { v: 1, cursor: Snowflake, bots: number, operatorPosted: boolean, guestPosted: boolean,
  member?: boolean, peers?: readonly Peer[], roleAt?: Snowflake, said?: Snowflake }
/** A message that wakes this bot; `isDirect` when it mentions the bot or its wake role, otherwise it is the operator's in a conversation the bot is in. */
export type Pending = { message: Message, before: Checkpoint, isDirect: boolean }
export type Folded = { head: Checkpoint, pending: readonly Pending[] }
const MAX_PEERS = 20
/**
 * Folds new messages into a conversation's checkpoint. In the room a waking id wakes this bot by mentioning it or its wake role, and the
 * operator also wakes a participant without one; at home (`isHome`: the home channel, its threads and the operator's direct messages)
 * the operator wakes without a mention, fleet ids only by mentioning the bot or its wake role, and guests and strangers never.
 */
export const fold = (room: Room, me: Me, from: Checkpoint, messages: readonly Message[], isHome = false): Folded => {
  let head = from
  const pending: Pending[] = []
  for (const message of messages) {
    if (!isNewer(message.id, head.cursor)) continue
    const before = head
    if (message.isSystem) {
      head = { ...before, cursor: message.id, said: before.said ?? before.cursor }
      continue
    }
    const standing = standingOf(room, me, message.author)
    const isFresh = (id: Snowflake): boolean => mintedAt(message.id) - mintedAt(id) <= room.idleMs
    const isMember = before.member === true && isFresh(before.said ?? before.cursor)
    const isRole = room.wakeRole !== undefined && message.roles.includes(room.wakeRole)
    const isDirect = message.mentions.includes(me.id) || isRole
    const bots = isHuman(message.author) ? 0 : before.bots + 1
    const wakes = standing !== 'you' && standing !== 'stranger' && bots < room.cap
    const peers = new Map((before.peers ?? []).filter(peer => isFresh(peer.at)).map(peer => [peer.id, peer]))
    for (const bot of [...(message.author.isBot ? [message.author] : []), ...message.mentionedBots]) {
      if (bot.id !== me.id) { peers.delete(bot.id); peers.set(bot.id, { id: bot.id, name: bot.name, at: message.id }) }
    }
    const roleAt = isRole ? message.id : before.roleAt && isFresh(before.roleAt) ? before.roleAt : undefined
    head = { v: 1, cursor: message.id, bots,
      operatorPosted: before.operatorPosted || standing === 'operator',
      guestPosted: before.guestPosted || standing === 'guest' || standing === 'stranger',
      member: standing === 'you' || (wakes && isDirect) || isMember, peers: [...peers.values()].slice(-MAX_PEERS),
      ...(roleAt ? { roleAt } : {}) }
    const isCalled = isHome ? standing === 'operator' || (standing === 'fleet' && isDirect) : isDirect || (isMember && standing === 'operator')
    if (wakes && isCalled) pending.push({ message, before, isDirect })
  }
  return { head, pending }
}
export const tailBots = (newestFirst: readonly Message[]): number => {
  const said = newestFirst.filter(message => !message.isSystem)
  const human = said.findIndex(message => isHuman(message.author))
  return human < 0 ? said.length : human
}
export const isTalkOnly = (head: Checkpoint): boolean => head.guestPosted && !head.operatorPosted
export const capVerdict = (room: Room, _me: Me, newestFirst: readonly Message[]): { ok: true } | { ok: false, why: string } => tailBots(newestFirst) < room.cap
  ? { ok: true } : { ok: false, why: 'Thread paused: ' + room.cap + ' bot messages since a human posted; a human must post in it first.' }
export const savedTarget = (head: Checkpoint, pending: readonly Pending[]): Checkpoint => pending[0]?.before ?? head
export const seed = (conversationId: Snowflake, since: Snowflake, newestFirst: readonly Message[], room: Room, me: Me, pruneFloor = since): Checkpoint => {
  const cursor = [conversationId, since, pruneFloor].reduce((a, b) => isNewer(a, b) ? a : b)
  const history = newestFirst.filter(message => !isNewer(message.id, cursor))
  return { v: 1, cursor, bots: tailBots(history), guestPosted: cursor !== conversationId,
    operatorPosted: history.some(message => !message.isSystem && standingOf(room, me, message.author) === 'operator') }
}

export type Mode = 'act' | 'talk'
/** `unread` is the read-back: what was posted in the conversation since this bot's last wake there, oldest first. */
export type Candidate = { conversation: Conversation, head: Checkpoint, pending: readonly Pending[], unread: readonly Message[] }
/** One conversation of a wake: `wakes` the pending messages it answers, `direct` those that mention the bot or its role, `peers` the other bots seen there. */
export type BatchItem = { conversation: Conversation, shown: readonly Message[], omitted: number, wakes: ReadonlySet<Snowflake>,
  direct: ReadonlySet<Snowflake>, answered: Checkpoint, peers: readonly Peer[], isRoleCalled: boolean }
export type Batch = { marker: string, mode: Mode, items: readonly BatchItem[] }
export const MAX_PER_THREAD = 25
export const MAX_MESSAGE_CHARS = 1_500
export const MAX_WAKE_CHARS = 20_000
export const WAKE_FORMAT = 2
// A message line's header, marker and attachments note.
const ROW_HEADER = 250
// A thread's heading, its omitted-messages line and up to MAX_SHOWN_PEERS names.
const ITEM_BUDGET = 750
const MAX_SHOWN_PEERS = 5
const rowCost = (message: Message): number => ROW_HEADER + bodyOf(message.content).length
export const compose = (candidates: readonly Candidate[], marker: string): Batch | undefined => {
  const pending = candidates.filter(candidate => candidate.pending.length > 0)
  if (!pending.length) return undefined
  const mode: Mode = pending.some(candidate => !isTalkOnly(candidate.head)) ? 'act' : 'talk'
  let budget = MAX_WAKE_CHARS - 2_000
  const items: BatchItem[] = []
  for (const candidate of pending.filter(candidate => isTalkOnly(candidate.head) === (mode === 'talk'))) {
    let left = budget - ITEM_BUDGET
    const fits = (message: Message, count: number): boolean => count < MAX_PER_THREAD && rowCost(message) <= left
    const selected: Pending[] = []
    for (const next of candidate.pending) {
      if (!fits(next.message, selected.length)) break
      selected.push(next)
      left -= rowCost(next.message)
    }
    if (!selected.length) break
    const answered = candidate.pending[selected.length]?.before ?? candidate.head
    const wakes = new Set(selected.map(pending => pending.message.id))
    const direct = new Set(selected.filter(pending => pending.isDirect).map(pending => pending.message.id))
    const context: Message[] = []
    if (selected.length === candidate.pending.length) {
      for (const message of candidate.unread.filter(message => !message.isSystem && !isNewer(message.id, answered.cursor) && !wakes.has(message.id)).reverse()) {
        if (!fits(message, selected.length + context.length)) break
        context.push(message)
        left -= rowCost(message)
      }
    }
    const shown = [...selected.map(pending => pending.message), ...context].sort((a, b) => isNewer(a.id, b.id) ? 1 : -1)
    const shownIds = new Set(shown.map(message => message.id))
    const omitted = candidate.unread.filter(message => !message.isSystem && !shownIds.has(message.id)).length
    items.push({ conversation: candidate.conversation, shown, omitted, wakes, direct, answered,
      peers: candidate.head.peers ?? [], isRoleCalled: candidate.head.roleAt !== undefined })
    budget = left
  }
  return { marker, mode, items }
}
const CONVERSATION_RULE = 'You are a participant in each conversation below. '
  + '▶ marks a message that mentions you or your wake role; ▷ marks an operator message without a mention in a conversation you joined; unmarked lines are earlier context. '
  + 'Other bots wake only when mentioned or on such operator messages: mention one to bring it in. '
  + 'Post only when a message is for you or you add something new. When another participant is the right one to answer, end the turn without posting: that is correct. '
  + 'Never post acknowledgements, thanks, agreement or "nothing to add".'
const HOME_RULE = 'In your home channel and the operator\'s direct messages, every operator message is for you, mention or not; other bots wake you there only by mentioning you or your wake role.'
/** Line breaks as any common line splitter reads them (JavaScript, Python `splitlines`, Unicode). */
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/
const label = (text: string, max: number): string => text.split(LINE_BREAK).join(' ').slice(0, max)
/**
 * A participant's name as a wake shows it: without the characters of a message header or a mention, so a chosen name cannot
 * pass for another participant's header or for words around a mention.
 */
export const nameLabel = (name: string, max: number): string =>
  label(name.replace(/[()<>|@]/g, '').trim(), max).trim() || 'unnamed'
/** Continuation lines start deeper than any message header, which starts with two spaces and a non-space. */
const CONTINUATION = '\n    | '
const bodyOf = (content: string): string => {
  const [first = '', ...rest] = content.split(LINE_BREAK)
  let body = first.slice(0, MAX_MESSAGE_CHARS)
  for (const line of rest) {
    if (body.length + CONTINUATION.length > MAX_MESSAGE_CHARS) break
    body = (body + CONTINUATION + line).slice(0, MAX_MESSAGE_CHARS)
  }
  return body
}
const headingOf = (conversation: Conversation): string => conversation.place === 'dm' ? 'Direct messages from the operator'
  : (conversation.place === 'home' ? (conversation.isThread ? 'Home thread "' : 'Home channel "') : 'Thread "') + label(conversation.name, 100) + '"'
export const wakeText = (room: Room, me: Me, batch: Batch): string => {
  const rule = batch.mode === 'talk'
    ? 'TALK ONLY: a guest or unknown history leads these threads. Only mcp__fleet-room__post may run, only here. The operator must post in each thread to allow other tools; phone input does not unlock them.'
    : 'Reply with mcp__fleet-room__post; your answer in this session is not posted.'
  const lines = ['Room wake ' + batch.marker + ' · wake format ' + WAKE_FORMAT + ' · you are ' + nameLabel(me.name, 80) + ' (<@' + me.id + '>) · ' + rule, CONVERSATION_RULE]
  if (batch.items.some(item => item.conversation.place !== 'room')) lines.push(HOME_RULE)
  for (const item of batch.items) {
    const others = item.peers.slice(-MAX_SHOWN_PEERS).reverse()
      .map(peer => nameLabel(peer.name, 40) + ' (' + standingOf(room, me, { ...peer, isBot: true }) + ', <@' + peer.id + '>)')
    const more = item.peers.length - others.length
    lines.push('\n' + headingOf(item.conversation) + ' · thread ' + item.conversation.id
      + ' · other bots here: ' + (others.join(', ') || 'none seen') + (more > 0 ? ' and ' + more + ' more' : '')
      + (item.isRoleCalled ? ' · your wake role was called here, so every bot holding it is a participant' : ''))
    for (const message of item.shown) {
      lines.push('  ' + nameLabel(message.author.name, 80) + ' (' + standingOf(room, me, message.author) + ', <@' + message.author.id + '>): '
        + (item.direct.has(message.id) ? '▶ ' : item.wakes.has(message.id) ? '▷ ' : '') + bodyOf(message.content)
        + (message.attachments ? ' [' + message.attachments + ' attachments]' : ''))
    }
    if (item.omitted > 0) lines.push('  [' + item.omitted + ' messages omitted; more mentions remain queued when outside this batch.]')
  }
  return lines.join('\n')
}
export const stoppedText = (why: string): string => 'fleet-room stopped: ' + why + '. Check the bot configuration and restart the session.'
