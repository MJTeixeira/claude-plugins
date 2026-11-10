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
  const cap = capOf(options)
  const idle = typeof options.conversationIdleMinutes === 'number' && Number.isInteger(options.conversationIdleMinutes)
    && options.conversationIdleMinutes >= 1 && options.conversationIdleMinutes <= 10_080 ? options.conversationIdleMinutes : 120
  return { kind: 'ready', token: { file, inline }, problems, room: {
    channel, operator: idOf(textOf(options.operator), 'Operator'), fleet, guests,
    wakeRole: idOf(textOf(options.wakeRole), 'Wake role'), cap, idleMs: idle * 60 * 1000,
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
export type Message = { id: Snowflake, author: Author, content: string, mentions: readonly Snowflake[], mentionedBots: readonly Me[], roles: readonly Snowflake[], attachments: number }
export type Conversation = { id: Snowflake, name: string, isRoomChannel: boolean }
export type Standing = 'you' | 'operator' | 'fleet' | 'guest' | 'stranger'
export const standingOf = (room: Room, me: Me, author: Author): Standing => author.id === me.id ? 'you'
  : author.id === room.operator ? 'operator' : room.guests.has(author.id) ? 'guest' : room.fleet.has(author.id) ? 'fleet' : 'stranger'
export const isHuman = (author: Author): boolean => !author.isBot
/** Another bot seen in a conversation, by its newest message or mention there. */
export type Peer = { id: Snowflake, name: string, at: Snowflake }
/**
 * Where this bot stands in one conversation after the message at `cursor`. `member` is true while it participates:
 * it joined by being mentioned (itself or its wake role) or by posting, and no gap between messages has exceeded the idle time.
 * `peers` and `roleAt` (the last wake-role mention) hold only what is within the idle time of `cursor`.
 */
export type Checkpoint = { v: 1, cursor: Snowflake, bots: number, operatorPosted: boolean, guestPosted: boolean,
  member?: boolean, peers?: readonly Peer[], roleAt?: Snowflake }
/** A message that wakes this bot; `isDirect` when it mentions the bot or its wake role, otherwise it arrived in a conversation the bot is in. */
export type Pending = { message: Message, before: Checkpoint, isDirect: boolean }
export type Folded = { head: Checkpoint, pending: readonly Pending[] }
const MAX_PEERS = 20
export const fold = (room: Room, me: Me, from: Checkpoint, messages: readonly Message[]): Folded => {
  let head = from
  const pending: Pending[] = []
  for (const message of messages) {
    if (!isNewer(message.id, head.cursor)) continue
    const before = head
    const standing = standingOf(room, me, message.author)
    const isFresh = (id: Snowflake): boolean => mintedAt(message.id) - mintedAt(id) <= room.idleMs
    const isMember = before.member === true && isFresh(before.cursor)
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
    if (wakes && (isDirect || isMember)) pending.push({ message, before, isDirect })
  }
  return { head, pending }
}
export const tailBots = (newestFirst: readonly Message[]): number => {
  const human = newestFirst.findIndex(message => isHuman(message.author))
  return human < 0 ? newestFirst.length : human
}
export const isTalkOnly = (head: Checkpoint): boolean => head.guestPosted && !head.operatorPosted
export const capVerdict = (room: Room, _me: Me, newestFirst: readonly Message[]): { ok: true } | { ok: false, why: string } => tailBots(newestFirst) < room.cap
  ? { ok: true } : { ok: false, why: 'Thread paused: ' + room.cap + ' bot messages since a human posted; a human must post in it first.' }
export const savedTarget = (head: Checkpoint, pending: readonly Pending[]): Checkpoint => pending[0]?.before ?? head
export const seed = (conversationId: Snowflake, since: Snowflake, newestFirst: readonly Message[], room: Room, me: Me, pruneFloor = since): Checkpoint => {
  const cursor = [conversationId, since, pruneFloor].reduce((a, b) => isNewer(a, b) ? a : b)
  const history = newestFirst.filter(message => !isNewer(message.id, cursor))
  return { v: 1, cursor, bots: tailBots(history), guestPosted: cursor !== conversationId,
    operatorPosted: history.some(message => standingOf(room, me, message.author) === 'operator') }
}

export type Mode = 'act' | 'talk'
export type Candidate = { conversation: Conversation, head: Checkpoint, pending: readonly Pending[], unread: readonly Message[] }
/** One conversation of a wake: `wakes` the pending messages it answers, `direct` those that mention the bot or its role, `peers` the other bots seen there. */
export type BatchItem = { conversation: Conversation, shown: readonly Message[], omitted: number, wakes: ReadonlySet<Snowflake>,
  direct: ReadonlySet<Snowflake>, answered: Checkpoint, peers: readonly Peer[], isRoleCalled: boolean }
export type Batch = { marker: string, mode: Mode, items: readonly BatchItem[] }
export const MAX_PER_THREAD = 25
export const MAX_MESSAGE_CHARS = 1_500
export const MAX_WAKE_CHARS = 20_000
const ROW_BUDGET = MAX_MESSAGE_CHARS + 250
// A thread's heading, its omitted-messages line and up to MAX_SHOWN_PEERS names.
const ITEM_BUDGET = 750
const MAX_SHOWN_PEERS = 5
export const compose = (candidates: readonly Candidate[], marker: string): Batch | undefined => {
  const pending = candidates.filter(candidate => candidate.pending.length > 0)
  if (!pending.length) return undefined
  const mode: Mode = pending.some(candidate => !isTalkOnly(candidate.head)) ? 'act' : 'talk'
  let budget = MAX_WAKE_CHARS - 2_000
  const items: BatchItem[] = []
  for (const candidate of pending.filter(candidate => isTalkOnly(candidate.head) === (mode === 'talk'))) {
    const count = Math.min(MAX_PER_THREAD, Math.floor((budget - ITEM_BUDGET) / ROW_BUDGET))
    if (count < 1) break
    const selected = candidate.pending.slice(0, count)
    const answered = candidate.pending[selected.length]?.before ?? candidate.head
    const wakes = new Set(selected.map(pending => pending.message.id))
    const direct = new Set(selected.filter(pending => pending.isDirect).map(pending => pending.message.id))
    const context = candidate.unread.filter(message => !isNewer(message.id, answered.cursor) && !wakes.has(message.id)).slice(-(count - selected.length || 0))
    const shown = [...selected.map(pending => pending.message), ...(selected.length < count ? context : [])]
      .sort((a, b) => isNewer(a.id, b.id) ? 1 : -1)
    const shownIds = new Set(shown.map(message => message.id))
    const omitted = candidate.unread.filter(message => !shownIds.has(message.id)).length
    items.push({ conversation: candidate.conversation, shown, omitted, wakes, direct, answered,
      peers: candidate.head.peers ?? [], isRoleCalled: candidate.head.roleAt !== undefined })
    budget -= ITEM_BUDGET + shown.length * ROW_BUDGET
  }
  return { marker, mode, items }
}
const CONVERSATION_RULE = 'You are a participant in each conversation below, and the other bots listed there read the same messages. '
  + '▶ marks a message that mentions you or your wake role; ▷ marks a new message in a conversation you joined; unmarked lines are earlier context. '
  + 'Post only when a message is for you or you add something new. When another participant is the right one to answer, end the turn without posting: that is correct. '
  + 'Never post acknowledgements, thanks, agreement or "nothing to add".'
const label = (text: string, max: number): string => text.replace(/[\r\n]/g, ' ').slice(0, max)
export const wakeText = (room: Room, me: Me, batch: Batch): string => {
  const rule = batch.mode === 'talk'
    ? 'TALK ONLY: a guest or unknown history leads these threads. Only mcp__fleet-room__post may run, only here. The operator must post in each thread to allow other tools; phone input does not unlock them.'
    : 'Reply with mcp__fleet-room__post; your answer in this session is not posted.'
  const lines = ['Room wake ' + batch.marker + ' · you are ' + label(me.name, 80) + ' (<@' + me.id + '>) · ' + rule, CONVERSATION_RULE]
  for (const item of batch.items) {
    const others = item.peers.slice(-MAX_SHOWN_PEERS).reverse()
      .map(peer => label(peer.name, 40) + ' (' + standingOf(room, me, { ...peer, isBot: true }) + ', <@' + peer.id + '>)')
    const more = item.peers.length - others.length
    lines.push('\nThread "' + label(item.conversation.name, 100) + '" · thread ' + item.conversation.id
      + ' · other bots here: ' + (others.join(', ') || 'none seen') + (more > 0 ? ' and ' + more + ' more' : '')
      + (item.isRoleCalled ? ' · your wake role was called here, so every bot holding it is a participant' : ''))
    for (const message of item.shown) {
      lines.push('  ' + label(message.author.name, 80) + ' (' + standingOf(room, me, message.author) + ', <@' + message.author.id + '>): '
        + (item.direct.has(message.id) ? '▶ ' : item.wakes.has(message.id) ? '▷ ' : '') + message.content.slice(0, MAX_MESSAGE_CHARS)
        + (message.attachments ? ' [' + message.attachments + ' attachments]' : ''))
    }
    if (item.omitted > 0) lines.push('  [' + item.omitted + ' messages omitted; more mentions remain queued when outside this batch.]')
  }
  return lines.join('\n')
}
export const stoppedText = (why: string): string => 'fleet-room stopped: ' + why + '. Check the bot configuration and restart the session.'
