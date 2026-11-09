import type { EngineInterface, Register, SessionAppendInput, ToolCallInput } from 'claude-code'
import { activeThreads, capHistory, DiscordFailure, need, newest, openLink, roomOf, send, startThread, threadOf, whoAmI } from './discord'
import type { Link } from './discord'
import { asSnowflake, capVerdict, setupOf, tailBots, tokenIn } from './room'
import type { Conversation, Room, TokenSource } from './room'
import { answered, guard, postScope, startWatch, turnEnded, turnStarted } from './watch'

const TOOL = 'mcp__fleet-room__post'
const SCRUB_NOTICE = '[fleet-room removed an unreadable transcript row to protect credentials]'
const POST_SCHEMA = {
  type: 'object', properties: {
    text: {type: 'string', minLength: 1, maxLength: 8_000, description: 'What to say. <@id> mentions a participant; <@&id> mentions a role.'},
    thread: {type: 'string', minLength: 1, maxLength: 100, description: 'A room thread id, room channel id, or exact active thread name.'},
    topic: {type: 'string', minLength: 1, maxLength: 100, description: 'Start a public topic thread. Give thread or topic, not both.'},
  }, required: ['text'], additionalProperties: false,
} as const

type Configured = {link: Link, room: Room, tokenPaths: readonly string[]}
let configured: Configured | undefined
const tokenOf = async ($: EngineInterface, source: TokenSource): Promise<{token?: string, paths: string[]}> => {
  const paths: string[] = []
  if (source.file) {
    const home = await $.env.get('HOME') || await $.env.get('USERPROFILE')
    const expanded = source.file.replace(/^~(?=[/\\]|$)/, home || '~')
    const normalized = expanded.replaceAll('\\', '/')
    paths.push(source.file, expanded)
    if (home && normalized.startsWith(home.replaceAll('\\', '/') + '/')) {
      const relative = normalized.slice(home.length)
      paths.push('~' + relative, '$HOME' + relative, '${HOME}' + relative)
    }
    try {
      const token = tokenIn(await $.fs.read(expanded))
      if (token) return {token, paths}
    } catch { /* Missing or unreadable token files fall back to the sensitive option. */ }
  }
  return {token: source.inline, paths}
}
const targetOf = async ($: EngineInterface, config: Configured, thread: string): Promise<Conversation | {refused: string}> => {
  const {link, room} = config
  const id = asSnowflake(thread)
  const meta = need(await roomOf($, link, room.channel))
  if (id === room.channel) return meta.conversation
  if (id) return need(await threadOf($, link, id, room.channel))?.conversation ?? {refused: 'That id is not a thread of the room.'}
  const active = need(await activeThreads($, link, meta.guild, room.channel))
  const matches = active.filter(item => item.conversation.name === thread)
  return matches.length === 1 ? matches[0]!.conversation : {refused: matches.length > 1 ? 'More than one thread has that name; use its id.'
    : 'No active room thread by that name. Active: ' + (active.map(item => item.conversation.name).join(', ') || 'none')}
}
const post = async ($: EngineInterface, config: Configured, raw: Record<string, unknown>): Promise<{result: string} | {deny: string}> => {
  const {link, room} = config
  if (typeof raw.text !== 'string' || !raw.text.trim() || raw.text.length > 8_000
    || (raw.thread === undefined) === (raw.topic === undefined)) return {deny: 'Give text and exactly one of thread or topic.'}
  const topic = raw.topic
  const thread = raw.thread
  if ((topic !== undefined && (typeof topic !== 'string' || !topic.trim() || topic.length > 100))
    || (thread !== undefined && (typeof thread !== 'string' || !thread.trim() || thread.length > 100))) return {deny: 'Thread or topic must be a nonempty string of at most 100 characters.'}
  const early = topic !== undefined ? postScope('new topic') : undefined
  if (early) return {deny: early}
  if (raw.text.includes(link.token) || (typeof topic === 'string' && topic.includes(link.token))) return {deny: 'Refused credential-bearing text.'}
  try {
    const me = need(await whoAmI($, link))
    let target: Conversation | {refused: string}
    if (typeof topic === 'string') {
      need(await roomOf($, link, room.channel))
      target = need(await startThread($, link, room.channel, topic.trim()))
    } else target = await targetOf($, config, (thread as string).trim())
    if ('refused' in target) return {deny: target.refused.replaceAll(link.token, '[redacted]')}
    const scope = postScope(target.id)
    if (scope) return {deny: scope}
    const recent = need(await newest($, link, target.id, messages => capHistory(room.cap, messages)))
    const verdict = capVerdict(room, me, recent)
    if (!verdict.ok) return {deny: verdict.why}
    const posted = need(await send($, link, target.id, raw.text, room.cap - tailBots(recent)))
    await answered($, target.id)
    return {result: ((topic ? 'Started' : 'Posted to') + ' "' + target.name + '" (' + target.id + ') as ' + me.name
      + (posted.length > 1 ? ' in ' + posted.length + ' messages.' : '.')).replaceAll(link.token, '[redacted]')}
  } catch (error) {
    return {deny: error instanceof DiscordFailure ? error.outcome.why : 'fleet-room failed while posting; text may already be posted. Tell the operator before repeating it.'}
  }
}
export const scrubbed = (e: SessionAppendInput, token: string): SessionAppendInput => {
  try {
    const replace = (value: unknown): unknown => typeof value === 'string' ? value.replaceAll(token, '[redacted]')
      : Array.isArray(value) ? value.map(replace) : value !== null && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([key, value]) => [key, replace(value)])) : value
    return {...e, message: replace(e.message) as SessionAppendInput['message']}
  } catch {
    return closedRow(e)
  }
}
export const closedRow = (e: SessionAppendInput): SessionAppendInput => ({...e, message: {...e.message,
  content: e.message.content.map(block => block.type === 'tool_result' ? {...block, content: SCRUB_NOTICE} : {type: 'text', text: SCRUB_NOTICE}),
}})
const GUARDED_TOOLS = ['Read', 'Bash', 'PowerShell', 'Glob', 'Grep']
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const stringsIn = (value: unknown): string[] => typeof value === 'string' ? [value]
  : Array.isArray(value) ? value.flatMap(stringsIn) : value !== null && typeof value === 'object' ? Object.values(value).flatMap(stringsIn) : []
/**
 * Refuses a file tool whose own arguments (not its description) name the token file: one of its path spellings,
 * a glob in a path under the file's folder, or its basename beside that folder (`cd ~/secrets && cat room.env`).
 */
const credentialGuard = (e: ToolCallInput, paths: readonly string[]): string | undefined => {
  if (!GUARDED_TOOLS.includes(e.tool)) return undefined
  const {tool, tool_use_id, agentId, requestMeta, consent, description, ...args} = e as Record<string, unknown>
  const input = stringsIn(args).join('\n').replaceAll('\\', '/')
  return paths.some(path => {
    const normalized = path.replaceAll('\\', '/')
    const cut = normalized.lastIndexOf('/')
    if (input.includes(normalized)) return true
    if (cut <= 0) return false
    const directory = normalized.slice(0, cut)
    return new RegExp(escaped(directory + '/') + '[^/\\s\'"]*[*?]').test(input)
      || (input.includes(directory) && input.includes(normalized.slice(cut + 1)))
  }) ? 'fleet-room protects its bot token file from model tools.' : undefined
}
export const register: Register = (on, options) => {
  const setup = setupOf(options)
  on('tool.call', async ($, e, next) => {
    const reason = guard(e) ?? (configured && credentialGuard(e, configured.tokenPaths))
    return reason ? {deny: reason} : next(e)
  }).catch(($, e, next) => next.called ? next(e) : {deny: 'fleet-room could not check this tool call safely.'})

  on('tool.call', {tool: TOOL}, async ($, e) => configured ? post($, configured, e) : {deny: 'fleet-room is not configured.'})
    .catch(() => ({deny: 'fleet-room failed while posting; text may already be posted. Tell the operator before repeating it.'}))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if (setup.kind === 'idle') { $.ui.log('fleet-room: idle (' + setup.why + ').', {to: 'debug'}); return started }
    const {token, paths} = await tokenOf($, setup.token)
    if (!token) { $.ui.log('fleet-room: idle (no bot token).', {to: 'debug'}); return started }
    for (const problem of setup.problems) $.ui.log('fleet-room: ' + problem)
    configured = {link: openLink(token), room: setup.room, tokenPaths: paths}
    await $.tool.register({name: 'post', description: 'Post in the fleet-room Discord room as this machine\'s bot. Reply in a wake\'s thread, use an existing room thread id or exact name, or start a topic. Only this tool posts your reply.', inputSchema: POST_SCHEMA, isDeferred: false})
    if (await $.env.get('FLEET_ROOM') === '1') await startWatch($, setup.room, configured.link)
    return started
  }).catch(($, e, next) => next(e))
  on('turn.start', async ($, e, next) => { await turnStarted($, e); return next(e) }).catch(($, e, next) => next(e))
  on('turn.complete', async ($, e, next) => { const ended = await next(e); await turnEnded($, e); return ended }).catch(($, e, next) => next(e))
  on('session.append', ($, e, next) => {
    if (!configured) return next(e)
    return next(scrubbed(e, configured.link.token))
  }).catch(($, e, next) => next.called ? next(e) : next(closedRow(e)))
}
