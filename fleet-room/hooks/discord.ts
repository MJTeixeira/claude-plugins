import type { EngineInterface } from 'claude-code'
import { asSnowflake, isHuman, isNewer, nameLabel } from './room'
import type { Conversation, Me, Message, Place, Snowflake } from './room'

const API = 'https://discord.com/api/v10'
const USER_AGENT = 'DiscordBot (https://github.com/MJTeixeira/claude-plugins, 0.2.1)'
const PAGE = 100
export const MAX_PAGES = 10
const MAX_POST_CHARS = 2_000
export type Failure =
  | { kind: 'halt', scope: 'room' | 'conversation', why: string }
  | { kind: 'wait', until: number, why: string }
  | { kind: 'error', why: string, status?: number }
export type Outcome<T> = { kind: 'ok', value: T } | Failure
/** `channel` is the room channel, whose read refusal stops the link; `channels` holds every channel that is not a thread, for naming a post refusal. */
export type Link = { readonly token: string, health: { kind: 'ok' } | Failure, denied: Map<string, {until: number, attempts: number}>, channel?: Snowflake,
  channels: Set<string> }
export const openLink = (token: string): Link => ({ token, health: { kind: 'ok' }, denied: new Map(), channels: new Set() })
export class DiscordFailure extends Error {
  constructor(readonly outcome: Failure) { super(outcome.why) }
}
export const need = <T>(outcome: Outcome<T>): T => {
  if (outcome.kind === 'ok') return outcome.value
  throw new DiscordFailure(outcome)
}
export type ThreadInfo = { conversation: Conversation, parent: Snowflake, lastMessage: Snowflake | undefined }
const objectOf = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Discord object')
  return value as Record<string, unknown>
}
const arrayOf = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error('Invalid Discord array')
  return value
}
const idOf = (value: unknown): Snowflake => {
  const id = typeof value === 'string' ? asSnowflake(value) : undefined
  if (!id) throw new Error('Invalid Discord id')
  return id
}
const nameOf = (value: unknown): string => typeof value === 'string' ? value : 'unnamed'
const meOf = (value: unknown): Me => {
  const wire = objectOf(value)
  return { id: idOf(wire.id), name: nameOf(wire.global_name ?? wire.username) }
}
const parseMessage = (value: unknown): Message => {
  const wire = objectOf(value)
  const author = objectOf(wire.author)
  const mentions = arrayOf(wire.mentions).map(meOf)
  const bots = new Set(arrayOf(wire.mentions).filter(value => objectOf(value).bot === true).map(value => objectOf(value).id))
  const names = new Map(mentions.map(me => [me.id as string, me.name]))
  return { id: idOf(wire.id), author: { ...meOf(author), isBot: author.bot === true || wire.webhook_id !== undefined },
    content: nameOf(wire.content).replace(/<@!?(\d+)>/g, (match, id: string) => names.has(id) ? '<@' + id + '|' + nameLabel(names.get(id)!, 80) + '>' : match),
    mentions: mentions.map(me => me.id), mentionedBots: mentions.filter(me => bots.has(me.id)), roles: arrayOf(wire.mention_roles).map(idOf),
    attachments: wire.attachments === undefined ? 0 : arrayOf(wire.attachments).length }
}
const threadInfo = (value: unknown, place: Place): ThreadInfo => {
  const wire = objectOf(value)
  return { conversation: { id: idOf(wire.id), name: nameOf(wire.name), place, isThread: true }, parent: idOf(wire.parent_id),
    lastMessage: typeof wire.last_message_id === 'string' ? asSnowflake(wire.last_message_id) : undefined }
}
async function call<T>($: EngineInterface, link: Link, scope: 'room' | 'conversation', method: 'GET' | 'POST', path: string,
  parse: (value: unknown) => T, body?: unknown): Promise<Outcome<T>> {
  const now = await $.clock.now()
  if (link.health.kind === 'halt') return link.health
  if (link.health.kind === 'wait' && link.health.until > now) return link.health
  const resource = /^\/channels\/(\d+)/.exec(path)?.[1]
  const denied = resource && method === 'GET' ? link.denied.get(resource) : undefined
  if (denied && denied.until > now) return { kind: 'halt', scope: 'conversation', why: 'Discord thread read denied; check View Channel and Read Message History. Retrying after backoff.' }
  try {
    const response = await $.http.fetch(API + path, { method, headers: { Authorization: 'Bot ' + link.token, 'User-Agent': USER_AGENT,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    if (response.status === 401 || response.status === 403) {
      const isRead = method === 'GET'
      const stopsLink = response.status === 401 || (isRead && (resource === link.channel || scope === 'room'))
      const permission = isRead ? 'View Channel and Read Message History'
        : path.endsWith('/threads') ? 'Create Public Threads'
        : resource !== undefined && link.channels.has(resource) ? 'Send Messages' : 'Send Messages in Threads'
      const failure: Failure = stopsLink
        ? {kind: 'halt', scope: 'room', why: response.status === 401 ? 'Discord refused the bot token' : 'Discord room read denied; check ' + permission}
        : isRead ? {kind: 'halt', scope: 'conversation', why: 'Discord thread read denied; check ' + permission + '. Retrying after backoff.'}
        : {kind: 'error', why: 'Discord post denied; check ' + permission + '.'}
      if (stopsLink) link.health = failure
      else if (isRead && resource) {
        const attempts = (denied ? denied.attempts : 0) + 1
        link.denied.set(resource, {attempts, until: now + Math.min(15 * 60 * 1000, 60_000 * 2 ** Math.min(attempts - 1, 4))})
      }
      return failure
    }
    if (response.status === 429) {
      let retry = Number(response.headers['retry-after'])
      try { retry = Math.max(retry || 0, Number(objectOf(JSON.parse(response.text)).retry_after) || 0) } catch { /* A missing JSON body still has Retry-After. */ }
      const until = await $.clock.now() + Math.max(1, Number.isFinite(retry) ? retry : 1) * 1000
      const failure: Failure = { kind: 'wait', until, why: 'Discord rate limit; wait ' + Math.ceil((until - now) / 1000) + ' seconds.' }
      link.health = failure
      return failure
    }
    if (!response.ok) return { kind: 'error', status: response.status, why: 'Discord request failed (HTTP ' + response.status + ').' }
    const value = parse(JSON.parse(response.text))
    if (resource && method === 'GET') link.denied.delete(resource)
    link.health = { kind: 'ok' }
    return { kind: 'ok', value }
  } catch {
    return { kind: 'error', why: 'Discord request or response could not be read.' }
  }
}
export function whoAmI($: EngineInterface, link: Link): Promise<Outcome<Me>> {
  return call($, link, 'room', 'GET', '/users/@me', meOf)
}

export type ChannelInfo = { guild: Snowflake, conversation: Conversation }
const channelInfo = (link: Link, channel: Snowflake, place: Place) => (value: unknown): ChannelInfo => {
  const wire = objectOf(value)
  if (idOf(wire.id) !== channel) throw new Error('Wrong channel')
  link.channels.add(channel)
  return { guild: idOf(wire.guild_id), conversation: { id: channel, name: nameOf(wire.name), place, isThread: false } }
}
export function roomOf($: EngineInterface, link: Link, channel: Snowflake): Promise<Outcome<ChannelInfo>> {
  return call($, Object.assign(link, {channel}), 'room', 'GET', '/channels/' + channel, channelInfo(link, channel, 'room'))
}
/** The home channel. A refusal to read it is the home's alone: it never stops the room. */
export function homeOf($: EngineInterface, link: Link, channel: Snowflake): Promise<Outcome<ChannelInfo>> {
  return call($, link, 'conversation', 'GET', '/channels/' + channel, channelInfo(link, channel, 'home'))
}
/** The bot's direct-message channel with `user`; Discord returns the one that exists rather than opening another. */
export function dmWith($: EngineInterface, link: Link, user: Snowflake): Promise<Outcome<Conversation>> {
  return call($, link, 'conversation', 'POST', '/users/@me/channels', value => {
    const wire = objectOf(value)
    if (Number(wire.type) !== 1) throw new Error('Not a direct-message channel')
    const id = idOf(wire.id)
    link.channels.add(id)
    return { id, name: 'direct messages', place: 'dm', isThread: false }
  }, { recipient_id: user })
}

/** The server's active threads whose parent is one of `parents`; `scope` 'conversation' keeps a refusal from stopping the room. */
export function activeThreads($: EngineInterface, link: Link, guild: Snowflake, parents: ReadonlyMap<string, Place>,
  scope: 'room' | 'conversation' = 'room'): Promise<Outcome<ThreadInfo[]>> {
  return call($, link, scope, 'GET', '/guilds/' + guild + '/threads/active', value => arrayOf(objectOf(value).threads).flatMap(value => {
    const parent = objectOf(value).parent_id
    const place = typeof parent === 'string' ? parents.get(parent) : undefined
    return place ? [threadInfo(value, place)] : []
  }))
}

/** A thread whose parent is one of `parents`, each mapped to the place its threads belong to. */
export function threadOf($: EngineInterface, link: Link, id: Snowflake, parents: ReadonlyMap<string, Place>): Promise<Outcome<ThreadInfo | undefined>> {
  return call($, link, 'conversation', 'GET', '/channels/' + id, value => {
    const wire = objectOf(value)
    const place = typeof wire.parent_id === 'string' ? parents.get(wire.parent_id) : undefined
    if (!place || ![10, 11, 12].includes(Number(wire.type))) return undefined
    const thread = threadInfo(wire, place)
    if (thread.conversation.id !== id) throw new Error('Wrong thread')
    return thread
  })
}

function pageOf($: EngineInterface, link: Link, conversation: Snowflake, query = ''): Promise<Outcome<Message[]>> {
 return call($, link, 'conversation', 'GET', '/channels/' + conversation + '/messages?limit=' + PAGE + query,
    value => arrayOf(value).map(parseMessage).sort((a, b) => isNewer(a.id, b.id) ? -1 : 1))
}

export async function messagesAfter($: EngineInterface, link: Link, conversation: Snowflake, after: Snowflake): Promise<Outcome<{ messages: Message[], gap: boolean }>> {
  const first = await pageOf($, link, conversation, '&after=' + after)
  if (first.kind !== 'ok') return first
  if (first.value.length < PAGE) return { kind: 'ok', value: { messages: first.value.filter(message => isNewer(message.id, after)).reverse(), gap: false } }
  const messages = new Map<Snowflake, Message>()
  let before = ''
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await pageOf($, link, conversation, before ? '&before=' + before : '')
    if (result.kind !== 'ok') return result
    for (const message of result.value) if (isNewer(message.id, after)) messages.set(message.id, message)
    const oldest = result.value.at(-1)
    const done = result.value.length < PAGE || (oldest !== undefined && !isNewer(oldest.id, after))
    if (done || page === MAX_PAGES - 1) return { kind: 'ok', value: {
      messages: [...messages.values()].sort((a, b) => isNewer(a.id, b.id) ? 1 : -1), gap: !done } }
    if (!oldest || before === oldest.id) return { kind: 'error', why: 'Discord pagination did not advance.' }
    before = oldest.id
  }
  return { kind: 'error', why: 'Discord history could not be read.' }
}
export async function newest($: EngineInterface, link: Link, conversation: Snowflake,
  enough: (messages: readonly Message[]) => boolean): Promise<Outcome<Message[]>> {
  const messages: Message[] = []
  let before = ''
  for (let page = 0; page < MAX_PAGES + 1; page++) {
    const result = await pageOf($, link, conversation, before ? '&before=' + before : '')
    if (result.kind !== 'ok') return result
    messages.push(...result.value)
    if (enough(messages) || result.value.length < PAGE) return { kind: 'ok', value: messages }
    const oldest = result.value.at(-1)
    if (!oldest || before === oldest.id) break
    before = oldest.id
  }
  return { kind: 'error', why: 'Discord cap history exceeded its bound.' }
}
export const capHistory = (cap: number, messages: readonly Message[]): boolean => messages.length >= cap + 1 || messages.some(message => isHuman(message.author))
export const chunks = (text: string): string[] => {
  const parts: string[] = []
  let rest = text
  while (rest.length > MAX_POST_CHARS) {
    const newline = rest.lastIndexOf('\n', MAX_POST_CHARS - 1)
    let end = newline >= 0 && rest.slice(0, newline + 1).trim() ? newline + 1 : MAX_POST_CHARS
    if (end === MAX_POST_CHARS && /[\uD800-\uDBFF]/.test(rest[end - 1]!)) end--
    const part = rest.slice(0, end)
    if (part.trim()) parts.push(part)
    rest = rest.slice(end)
  }
  if (rest.trim()) parts.push(rest)
  return parts
}
export async function send($: EngineInterface, link: Link, conversation: Snowflake, text: string, maxMessages = Infinity): Promise<Outcome<Snowflake[]>> {
  const ids: Snowflake[] = []
  const parts = chunks(text)
  if (parts.length > maxMessages) return {kind: 'error', why: 'This reply exceeds the remaining bot message cap; shorten it or wait for a human post.'}
  for (const content of parts) {
    const result = await call($, link, 'conversation', 'POST', '/channels/' + conversation + '/messages', value => idOf(objectOf(value).id),
      { content, allowed_mentions: { parse: ['users', 'roles'] } })
    if (result.kind !== 'ok') return { ...result, why: result.why + (ids.length ? ' Some chunks were posted; do not repeat the whole message.' : '') }
    ids.push(result.value)
  }
  return { kind: 'ok', value: ids }
}
export function startThread($: EngineInterface, link: Link, channel: Snowflake, name: string): Promise<Outcome<Conversation>> {
  return call($, link, 'room', 'POST', '/channels/' + channel + '/threads', value => ({ id: idOf(objectOf(value).id), name, place: 'room' as const, isThread: true }), { name, type: 11 })
}
/** Shows the bot typing in `conversation` for about ten seconds. Best-effort: it never changes the link's health and reports only whether Discord took it. */
export async function typing($: EngineInterface, link: Link, conversation: Snowflake): Promise<boolean> {
  if (link.health.kind !== 'ok') return false
  try {
    const response = await $.http.fetch(API + '/channels/' + conversation + '/typing', { method: 'POST', headers: { Authorization: 'Bot ' + link.token, 'User-Agent': USER_AGENT } })
    return response.ok
  } catch {
    return false
  }
}
