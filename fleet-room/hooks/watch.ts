import type { EngineInterface, Timer, ToolCallInput } from 'claude-code'
import { activeThreads, capHistory, DiscordFailure, messagesAfter, need, newest, roomOf, threadOf, typing, whoAmI } from './discord'
import type { Link } from './discord'
import { asSnowflake, compose, fold, isNewer, isTalkOnly, mintedAt, savedTarget, seed, stoppedText, wakeText } from './room'
import type { Batch, Checkpoint, Conversation, Me, Message, Pending, Room, Snowflake } from './room'
import { holdPresence } from './presence'
import type { GatewayEvent, Presence } from './presence'
import { restore, slot, submitNext } from './wake'

export const POLL_MS = 20_000
// Discord shows a typing indicator for about ten seconds.
export const TYPING_MS = 8_000
const LEASE_MS = 3 * POLL_MS
const SWEEP_MS = 7 * 24 * 60 * 60 * 1000
const FORGET_MS = 30 * 24 * 60 * 60 * 1000
const UNREAD_KEPT = 100
const TOOL = 'mcp__fleet-room__post'
const TALK_DENY = 'fleet-room talk-only wake: only its post tool may run, including in subagents. The operator must post in the Discord thread to unlock other tools; phone input does not unlock them.'

type Conv = { conversation: Conversation, head: Checkpoint, pending: Pending[], unread: Message[] }
type Slot = { kind: 'submitted', batch: Batch } | { kind: 'running', batch: Batch, turnId: string }
type Phase = { kind: 'starting' } | { kind: 'watching', me: Me, guild: Snowflake, roomChannel: Conversation, since: Snowflake, isSwept: boolean } | { kind: 'stopped' }
type Watch = {
  room: Room, link: Link, timer: Timer | undefined, phase: Phase, convs: Map<Snowflake, Conv>,
  restoring: boolean, wakeKey: string | undefined, leaseTicks: number, sessionId: string,
  typing: Set<Snowflake>, typingTimer: Timer | undefined, presence: Presence | undefined,
}
let watch: Watch | undefined
let ticking: Promise<void> | undefined
let isNudged = false
const SOURCE = 'discord'
/** The Discord wake in the session's slot, if the slot holds one. */
const roomSlot = (): Slot | undefined => {
  const current = slot()
  if (current.kind === 'submitted' && current.source === SOURCE) return {kind: 'submitted', batch: current.wake as Batch}
  if (current.kind === 'running' && current.source === SOURCE) return {kind: 'running', batch: current.wake as Batch, turnId: current.turnId}
  return undefined
}
const prefix = (w: Watch, me: Snowflake): string => me + '/' + w.room.channel
const pruneKey = (w: Watch, me: Snowflake): string => 'prune/' + prefix(w, me)
const timeSnowflake = (now: number): Snowflake => String(BigInt(Math.max(0, now - 1_420_070_400_000)) << 22n) as Snowflake
const checkpointKey = (w: Watch, me: Snowflake, id: Snowflake): string => 'cp/' + prefix(w, me) + '/' + id
const checkpointOf = (value: unknown): (Checkpoint & { name: string }) | undefined => {
  if (value === null || typeof value !== 'object') return undefined
  const cp = value as Record<string, unknown>
  if (cp.v !== 1 || typeof cp.cursor !== 'string' || !asSnowflake(cp.cursor) || !Number.isInteger(cp.bots) || Number(cp.bots) < 0
    || typeof cp.operatorPosted !== 'boolean' || typeof cp.guestPosted !== 'boolean' || typeof cp.name !== 'string'
    || (cp.member !== undefined && typeof cp.member !== 'boolean') || (cp.roleAt !== undefined && (typeof cp.roleAt !== 'string' || !asSnowflake(cp.roleAt)))
    || (cp.peers !== undefined && (!Array.isArray(cp.peers) || !cp.peers.every(peer => peer !== null && typeof peer === 'object'
      && typeof peer.id === 'string' && asSnowflake(peer.id) && typeof peer.name === 'string' && typeof peer.at === 'string' && asSnowflake(peer.at))))) return undefined
  return cp as Checkpoint & { name: string }
}
export async function startWatch($: EngineInterface, room: Room, link: Link): Promise<void> {
  watch?.timer?.cancel()
  watch?.typingTimer?.cancel()
  watch?.presence?.stop()
  await ticking
  const w: Watch = { room, link, timer: undefined, phase: {kind: 'starting'}, convs: new Map(),
    restoring: true, wakeKey: undefined, leaseTicks: 0, sessionId: await $.session.id(),
    typing: new Set(), typingTimer: undefined, presence: undefined }
  watch = w
  if (roomSlot()) restore({kind: 'free'})
  const suffix = '/' + room.channel
  for (const key of await $.store.keys()) {
    if (!key.startsWith('wake/') || !key.endsWith(suffix) || !asSnowflake(key.slice(5, -suffix.length))) continue
    await restoreWake($, w, key)
  }
  w.restoring = false
  w.timer = $.clock.every(POLL_MS, () => { void tick($) })
  await tick($)
}
export async function roomChanged($: EngineInterface): Promise<void> {
  if (watch) await saveWake($, watch)
}
export async function roomSettle($: EngineInterface, batch: Batch): Promise<void> {
  if (watch) await settle($, watch, batch)
}
export function roomSubmitted($: EngineInterface, batch: Batch): void {
  if (watch) startTyping($, watch, batch.items.map(item => item.conversation.id))
}
export function roomReleased(): void {
  if (watch) stopTyping(watch)
}
const wakeKey = (w: Watch): string | undefined => w.phase.kind === 'watching' ? 'wake/' + prefix(w, w.phase.me.id) : w.wakeKey
async function saveWake($: EngineInterface, w: Watch): Promise<void> {
  const key = wakeKey(w)
  if (!key || w !== watch) return
  const slot = roomSlot()
  const saved = await $.store.get(key) as {session?: string} | undefined
  if (!slot) {
    if (saved?.session === w.sessionId) await $.store.delete(key)
    return
  }
  if (saved && saved.session !== w.sessionId) {
    const lease = await $.store.get('lease/' + key.slice(5)) as {session?: string} | undefined
    if (lease?.session !== w.sessionId) return
  }
  await $.store.set(key, {session: w.sessionId, slot: {...slot, batch: {marker: slot.batch.marker, mode: slot.batch.mode,
    items: slot.batch.items.map(item => ({conversation: item.conversation, answered: item.answered}))}}})
}
async function restoreWake($: EngineInterface, w: Watch, key: string): Promise<void> {
  const saved = await $.store.get(key) as {session?: string, slot?: Slot} | undefined
  const slot = saved?.slot
  if (saved?.session !== w.sessionId) return
  if (!slot || (slot.kind !== 'submitted' && slot.kind !== 'running') || !slot.batch
    || typeof slot.batch.marker !== 'string' || !['act', 'talk'].includes(slot.batch.mode) || !Array.isArray(slot.batch.items)
    || (slot.kind === 'running' && typeof slot.turnId !== 'string')) throw new Error('Invalid saved wake')
  const items = slot.batch.items.map(item => {
    if (!item.conversation || !asSnowflake(item.conversation.id) || typeof item.conversation.name !== 'string'
      || !checkpointOf({...item.answered, name: item.conversation.name})) throw new Error('Invalid saved wake thread')
    return {...item, shown: [], omitted: 0, wakes: new Set<Snowflake>(), direct: new Set<Snowflake>(), peers: [], isRoleCalled: false}
  })
  w.wakeKey = key
  const batch = {...slot.batch, items}
  restore(slot.kind === 'running' ? {kind: 'running', source: SOURCE, wake: batch, turnId: slot.turnId} : {kind: 'submitted', source: SOURCE, wake: batch})
}
// A scheduled tick counts toward holding the lease; a nudge from the gateway only reads sooner. A nudge during a poll runs one more poll after it.
function tick($: EngineInterface, isScheduled = true): Promise<void> {
  if (ticking) {
    if (!isScheduled) isNudged = true
    return ticking
  }
  ticking = poll($, isScheduled).catch(() => { $.ui.log('fleet-room: poll failed; the next tick retries.', {to: 'debug'}) })
    .finally(() => {
      ticking = undefined
      if (isNudged) { isNudged = false; void tick($, false) }
    })
  return ticking
}
async function onGateway($: EngineInterface, event: GatewayEvent): Promise<void> {
  const w = watch
  if (!w || w.phase.kind !== 'watching') return
  if (event.event === 'ready') $.ui.log('fleet-room: online on the Discord gateway.', {to: 'debug'})
  else if (event.event === 'message') {
    const id = asSnowflake(event.channel)
    if (id && (id === w.room.channel || w.convs.has(id))) void tick($, false)
  } else if (event.event === 'thread') {
    if (event.parent === w.room.channel) void tick($, false)
  } else if (event.event === 'fatal') {
    if (event.code === 4004) {
      w.link.health = {kind: 'halt', scope: 'room', why: 'Discord refused the bot token'}
      stop($, w, w.link.health.why)
    } else $.ui.log('fleet-room: Discord closed the gateway (code ' + event.code + '); the bot shows offline until the session restarts.')
  } else if (event.event === 'unsupported') $.ui.log('fleet-room: ' + event.why + '; the bot shows offline, the room still works.')
}
function stop($: EngineInterface, w: Watch, why: string): void {
  w.phase = {kind: 'stopped'}
  w.timer?.cancel()
  w.presence?.stop()
  stopTyping(w)
  $.ui.log('fleet-room: ' + why)
  void $.prompt.submit({text: stoppedText(why)}).catch(() => undefined)
}
function startTyping($: EngineInterface, w: Watch, ids: readonly Snowflake[]): void {
  const beat = (id: Snowflake): void => {
    void typing($, w.link, id).then(ok => { if (!ok) $.ui.log('fleet-room: typing indicator failed in ' + id + '.', {to: 'debug'}) })
  }
  for (const id of ids) { w.typing.add(id); beat(id) }
  w.typingTimer ??= $.clock.every(TYPING_MS, () => { for (const id of w.typing) beat(id) })
}
function stopTyping(w: Watch, id?: Snowflake): void {
  if (id === undefined) w.typing.clear()
  else w.typing.delete(id)
  if (w.typing.size > 0) return
  w.typingTimer?.cancel()
  w.typingTimer = undefined
}
async function holdLease($: EngineInterface, w: Watch, me: Me): Promise<boolean> {
  const key = 'lease/' + prefix(w, me.id)
  const now = await $.clock.now()
  const value = await $.store.get(key) as {session?: string, until?: number} | undefined
  if (value && value.session !== w.sessionId && typeof value.until === 'number' && value.until > now) return false
  await $.store.set(key, {session: w.sessionId, until: now + LEASE_MS})
  const held = await $.store.get(key) as {session?: string} | undefined
  return held?.session === w.sessionId
}
async function load($: EngineInterface, w: Watch, conversation: Conversation): Promise<Conv> {
  if (w.phase.kind !== 'watching') throw new Error('Watch not ready')
  const cp = checkpointOf(await $.store.get(checkpointKey(w, w.phase.me.id, conversation.id)))
  const storedFloor = await $.store.get(pruneKey(w, w.phase.me.id))
  const floor = typeof storedFloor === 'string' ? asSnowflake(storedFloor) : undefined
  const head = cp ?? seed(conversation.id, w.phase.since,
    need(await newest($, w.link, conversation.id, messages => capHistory(w.room.cap, messages))), w.room, w.phase.me, floor)
  const conv: Conv = {conversation, head, pending: [], unread: []}
  w.convs.set(conversation.id, conv)
  if (!cp) await $.store.set(checkpointKey(w, w.phase.me.id, conversation.id), {...head, name: conversation.name})
  return conv
}
const absorb = (w: Watch, conv: Conv, messages: readonly Message[], gap: boolean): void => {
  if (w.phase.kind !== 'watching') return
  const from = gap ? {...conv.head, guestPosted: true} : conv.head
  const folded = fold(w.room, w.phase.me, from, messages)
  conv.head = folded.head
  conv.pending.push(...folded.pending)
  conv.unread = [...conv.unread, ...messages].slice(-UNREAD_KEPT)
}
async function persist($: EngineInterface, w: Watch, conv: Conv): Promise<void> {
  if (w.phase.kind !== 'watching') return
  const target = savedTarget(conv.head, conv.pending)
  const key = checkpointKey(w, w.phase.me.id, conv.conversation.id)
  const current = checkpointOf(await $.store.get(key))
  if (!current || isNewer(target.cursor, current.cursor)) await $.store.set(key, {...target, name: conv.conversation.name})
  conv.unread = conv.unread.filter(message => isNewer(message.id, target.cursor))
}
async function poll($: EngineInterface, isScheduled: boolean): Promise<void> {
  const w = watch
  if (!w || w.phase.kind === 'stopped') return
  try {
    if (w.link.health.kind === 'halt') throw new DiscordFailure(w.link.health)
    if (w.link.health.kind === 'wait' && w.link.health.until > await $.clock.now()) return
    if (w.phase.kind === 'starting') {
      const me = need(await whoAmI($, w.link))
      const {guild, conversation} = need(await roomOf($, w.link, w.room.channel))
      const key = 'since/' + prefix(w, me.id)
      const stored = await $.store.get(key)
      const since = typeof stored === 'string' ? asSnowflake(stored) : undefined
      const start = since ?? timeSnowflake(await $.clock.now())
      if (!since) await $.store.set(key, start)
      w.phase = {kind: 'watching', me, guild, roomChannel: conversation, since: start, isSwept: false}
    }
    if (!await holdLease($, w, w.phase.me)) {
      w.leaseTicks = 0
      w.presence?.stop()
      w.presence = undefined
      return
    }
    if (isScheduled) w.leaseTicks++
    if (w.leaseTicks >= 2 && !w.presence) w.presence = holdPresence($, w.link.token, event => onGateway($, event))
    const active = need(await activeThreads($, w.link, w.phase.guild, w.room.channel))
    const conversations = [...new Map([w.phase.roomChannel, ...active.map(thread => thread.conversation), ...[...w.convs.values()].map(conv => conv.conversation)].map(conv => [conv.id, conv])).values()]
    const held = roomSlot()
    if (held) {
      for (const item of held.batch.items) if (!conversations.some(conv => conv.id === item.conversation.id)) conversations.push(item.conversation)
    }
    if (!w.phase.isSwept) {
      const root = 'cp/' + prefix(w, w.phase.me.id) + '/'
      const now = await $.clock.now()
      for (const key of await $.store.keys()) {
        if (!key.startsWith(root)) continue
        const cp = checkpointOf(await $.store.get(key))
        if (!cp) continue
        const age = now - mintedAt(cp.cursor)
        if (age > FORGET_MS) {
          const floorKey = pruneKey(w, w.phase.me.id)
          const prior = await $.store.get(floorKey)
          const floor = timeSnowflake(now)
          if (typeof prior !== 'string' || !asSnowflake(prior) || isNewer(floor, prior as Snowflake)) await $.store.set(floorKey, floor)
          await $.store.delete(key)
          continue
        }
        const id = asSnowflake(key.slice(root.length))
        if (!id || age > SWEEP_MS || conversations.some(conversation => conversation.id === id)) continue
        const result = await threadOf($, w.link, id, w.room.channel)
        if (result.kind === 'halt' && result.scope === 'conversation') {
          conversations.push({id, name: cp.name, isRoomChannel: false})
          continue
        }
        if (result.kind === 'error') {
          if (result.status === 404) {
            await $.store.delete(key)
            $.ui.log('fleet-room: deleted thread ' + id + '; checkpoint dropped.')
          } else $.ui.log('fleet-room: could not read thread ' + id + '; continuing other threads.')
          continue
        }
        const thread = need(result)
        if (thread) conversations.push(thread.conversation)
      }
      w.phase.isSwept = true
    }
    for (const conversation of conversations) {
      let conv = w.convs.get(conversation.id)
      try {
        conv ??= await load($, w, conversation)
        const result = need(await messagesAfter($, w.link, conversation.id, conv.head.cursor))
        absorb(w, conv, result.messages, result.gap)
        if (result.gap) $.ui.log('fleet-room: history gap in thread ' + conversation.id + '; older mentions omitted'
          + (isTalkOnly(conv.head) ? ', thread is talk-only.' : '.'))
        await persist($, w, conv)
      } catch (error) {
        if (!(error instanceof DiscordFailure)) throw error
        if (error.outcome.kind === 'error') {
          if (error.outcome.status === 404 && !conversation.isRoomChannel) {
            const key = checkpointKey(w, w.phase.me.id, conversation.id)
            if (await $.store.get(key) !== undefined) {
              await $.store.delete(key)
              $.ui.log('fleet-room: deleted thread ' + conversation.id + '; checkpoint dropped.')
            }
            w.convs.delete(conversation.id)
          } else $.ui.log('fleet-room: could not read thread ' + conversation.id + '; continuing other threads.')
          continue
        }
        if (error.outcome.kind !== 'halt' || error.outcome.scope !== 'conversation') throw error
      }
    }
    await submitNext($)
  } catch (error) {
    if (error instanceof DiscordFailure) {
      if (error.outcome.kind === 'halt' && error.outcome.scope === 'room') stop($, w, error.outcome.why)
      return
    }
    throw error
  }
}
export function roomCompose(): { wake: Batch, text: string } | undefined {
  const w = watch
  if (!w || w.phase.kind !== 'watching' || w.leaseTicks < 2) return undefined
  const batch = compose([...w.convs.values()], 'w-' + crypto.randomUUID())
  return batch && {wake: batch, text: wakeText(w.room, w.phase.me, batch).replaceAll(w.link.token, '[redacted]')}
}
async function settle($: EngineInterface, w: Watch, batch: Batch, only?: Snowflake): Promise<void> {
  for (const item of batch.items) {
    if (only !== undefined && item.conversation.id !== only) continue
    const conv = w.convs.get(item.conversation.id)
    if (!conv) continue
    const remaining = conv.pending.filter(pending => isNewer(pending.message.id, item.answered.cursor))
    const prior = conv.pending
    conv.pending = remaining
    try { await persist($, w, conv) } catch (error) { conv.pending = prior; throw error }
  }
}
export async function answered($: EngineInterface, conversation: Snowflake): Promise<void> {
  const w = watch
  if (w) stopTyping(w, conversation)
  const held = roomSlot()
  if (w && held?.kind === 'running') await settle($, w, held.batch, conversation)
}
const talkBatch = (): Batch | undefined => {
  const w = watch
  const held = roomSlot()
  if (!w || !held || held.batch.mode !== 'talk') return undefined
  return held.batch.items.some(item => {
    const conv = w.convs.get(item.conversation.id)
    return !conv?.head.operatorPosted
  }) ? held.batch : undefined
}
export const isTalkTurn = (): boolean => talkBatch() !== undefined
export const guard = (e: ToolCallInput): string | undefined => (watch?.restoring || isTalkTurn()) && (e.agentId !== undefined || e.tool !== TOOL) ? TALK_DENY : undefined
export const postScope = (target: Snowflake | 'new topic'): string | undefined => {
  if (watch?.restoring) return 'fleet-room is restoring its wake scope; retry after session start succeeds.'
  const batch = talkBatch()
  return batch && (target === 'new topic' || !batch.items.some(item => item.conversation.id === target))
    ? 'A talk-only wake may post only in its own threads and cannot start a topic; the operator must post there first.' : undefined
}
