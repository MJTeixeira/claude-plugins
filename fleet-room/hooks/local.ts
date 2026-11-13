import type { EngineInterface, Timer } from 'claude-code'
import { chatList, codexCommand, codexHome, footer, introText, isPickedUp, isWindowsPath, joined, linesWith, listChats, powershell, rollouts, UUID } from './codex'
import { MAX_WAKE_CHARS } from './room'
import { restore, slot, submitNext } from './wake'

export const INBOX_POLL_MS = 5_000
export const PICKUP_MS = 2 * 60 * 1000
const MAX_SEND_CHARS = 8_000
const EXCLUDE_LINE = '.fleet-room/'

type Pair = { thread: string, title: string, rollout: string }
type Sent = { marker: string, at: number, isLate: boolean }
type Waiting = { name: string, size: number, mtimeMs: number }
/** A wake of the local Codex room: the inbox files it delivers and the unanswered sends it reports. */
export type CodexWake = { marker: string, files: readonly string[], late: readonly string[] }
type Saved = { v: 1, pair: Pair, sent: Sent[], count: number, wake?: { kind: 'submitted' | 'running', wake: CodexWake, turnId?: string } }
type Local = {
  sessionId: string, root: string, isWindows: boolean, inbox: string, archive: string, cap: number, pair: Pair, sent: Sent[], count: number,
  seen: Map<string, Waiting>, ready: string[], timer: Timer | undefined, isCapLogged: boolean, checkedAt: number,
}
let local: Local | undefined
let polling: Promise<void> | undefined
const keyOf = (sessionId: string): string => 'codex/' + sessionId

const savedOf = (value: unknown): Saved | undefined => {
  const saved = value as Saved | undefined
  return saved?.v === 1 && typeof saved.pair?.thread === 'string' && UUID.test(saved.pair.thread) && typeof saved.pair.rollout === 'string'
    && Array.isArray(saved.sent) && Number.isInteger(saved.count) ? saved : undefined
}
async function save($: EngineInterface, l: Local): Promise<void> {
  const current = slot()
  const wake = (current.kind === 'submitted' || current.kind === 'running') && current.source === 'codex'
    ? {kind: current.kind, wake: current.wake as CodexWake, ...(current.kind === 'running' ? {turnId: current.turnId} : {})} : undefined
  const saved: Saved = {v: 1, pair: l.pair, sent: l.sent, count: l.count, ...(wake ? {wake} : {})}
  await $.store.set(keyOf(l.sessionId), saved)
}
export async function isCodexAvailable($: EngineInterface): Promise<boolean> {
  const home = await codexHome($)
  return home !== undefined && await $.fs.exists(home).catch(() => false)
}
/**
 * Resumes local mode after a reload or restart of a session that has a pair; a session with none is left alone.
 * `ended` names the session a /clear or an in-process /resume ended: its pair moves to this one, as the inbox and the process stay the same.
 */
export async function resumeLocal($: EngineInterface, cap: number, ended?: string): Promise<void> {
  local?.timer?.cancel()
  local = undefined
  const sessionId = await $.session.id()
  let saved = savedOf(await $.store.get(keyOf(sessionId)))
  if (!saved && ended !== undefined) {
    saved = savedOf(await $.store.get(keyOf(ended)))
    if (saved) {
      await $.store.set(keyOf(sessionId), saved)
      await $.store.delete(keyOf(ended))
    }
  }
  if (!saved) return
  const l = await activate($, sessionId, cap, saved.pair)
  l.sent = saved.sent
  l.count = saved.count
  if (saved.wake) {
    restore(saved.wake.kind === 'running' && saved.wake.turnId !== undefined
      ? {kind: 'running', source: 'codex', wake: saved.wake.wake, turnId: saved.wake.turnId}
      : {kind: 'submitted', source: 'codex', wake: saved.wake.wake})
  }
}
async function activate($: EngineInterface, sessionId: string, cap: number, pair: Pair): Promise<Local> {
  const root = await $.session.root()
  const isWindows = isWindowsPath(root)
  const base = joined(isWindows, root, '.fleet-room')
  const l: Local = {sessionId, root, isWindows, inbox: joined(isWindows, base, 'inbox'), archive: joined(isWindows, base, 'archive'), cap, pair,
    sent: [], count: 0, seen: new Map(), ready: [], timer: undefined, isCapLogged: false, checkedAt: 0}
  // $.fs.write makes the folders; Codex's command writes into the inbox, so it must exist first.
  if (!await $.fs.exists(l.inbox)) await $.fs.write(joined(isWindows, l.inbox, '.keep'), '')
  await excludeFolder($, root)
  local = l
  l.timer = $.clock.every(INBOX_POLL_MS, () => { void pollLocal($) })
  return l
}
/** Keeps `.fleet-room/` out of git without touching the project's .gitignore. */
export async function excludeFolder($: EngineInterface, root: string): Promise<void> {
  const found = await $.process.run(['git', 'rev-parse', '--git-path', 'info/exclude'], {cwd: root}).catch(() => undefined)
  const relative = found?.exitCode === 0 ? found.stdout.trim() : ''
  if (!relative) return
  const isWindows = isWindowsPath(root)
  const file = isWindowsPath(relative) || relative.startsWith('/') ? relative : joined(isWindows, root, relative)
  const text = await $.fs.read(file).catch(() => '')
  if (text.split(/\r?\n/).some(line => ['.fleet-room/', '/.fleet-room/', '.fleet-room', '/.fleet-room'].includes(line.trim()))) return
  await $.fs.write(file, text + (text && !text.endsWith('\n') ? '\n' : '') + EXCLUDE_LINE + '\n')
}
export async function pairTool($: EngineInterface, cap: number, raw: Record<string, unknown>): Promise<{result: string} | {deny: string}> {
  const thread = typeof raw.thread === 'string' ? raw.thread.trim().toLowerCase() : ''
  if (!UUID.test(thread)) return {deny: 'Give thread: the Codex chat\'s UUID, as the chats tool lists it. Titles do not resolve.'}
  const home = await codexHome($)
  if (!home) return {deny: 'No Codex home folder on this machine.'}
  const isWindows = isWindowsPath(home)
  const chats = await listChats($, home, isWindows)
  const chat = chats.find(item => item.id === thread)
  const rollout = chat?.rollout ?? (await rollouts($, home)).find(item => item.id === thread)?.path
  if (!rollout) return {deny: 'No Codex chat with that UUID on this machine.'}
  local?.timer?.cancel()
  const sessionId = await $.session.id()
  const l = await activate($, sessionId, cap, {thread, title: chat?.title ?? '(untitled)', rollout})
  const sent = await send($, l, introText(l.root))
  if ('deny' in sent) { await save($, l); return {deny: 'Paired, but the intro did not reach Codex: ' + sent.deny} }
  return {result: 'Paired with Codex chat ' + thread + ' ("' + l.pair.title + '"). The intro is queued; Codex writes to ' + l.inbox
    + ' and each message wakes this session.' + (chat?.cwd && chat.cwd !== l.root ? ' Note: that chat works in ' + chat.cwd + ', and its sandbox may refuse writes to this folder.' : '')
    + ' fleet-room checks for ' + PICKUP_MS / 60_000 + ' minutes that Codex picked it up.'}
}
export async function chatsTool($: EngineInterface, raw: Record<string, unknown>): Promise<{result: string} | {deny: string}> {
  const home = await codexHome($)
  if (!home) return {deny: 'No Codex home folder on this machine.'}
  const isWindows = isWindowsPath(home)
  return {result: chatList(await listChats($, home, isWindows), await $.session.root(), isWindows, raw.all === true)}
}
export async function sendTool($: EngineInterface, raw: Record<string, unknown>): Promise<{result: string} | {deny: string}> {
  const l = local
  if (!l) return {deny: 'No Codex chat is paired with this session. List the chats, propose one to the owner, and pair it once they confirm.'}
  if (typeof raw.text !== 'string' || !raw.text.trim() || raw.text.length > MAX_SEND_CHARS) return {deny: 'Give text of 1 to ' + MAX_SEND_CHARS + ' characters.'}
  const sent = await send($, l, raw.text)
  return 'deny' in sent ? sent : {result: 'Queued for Codex chat ' + l.pair.thread + ' as ' + sent.marker + '. If Codex has not picked it up in '
    + PICKUP_MS / 60_000 + ' minutes, fleet-room tells you. Its answer arrives as a wake of its own.'}
}
async function send($: EngineInterface, l: Local, text: string): Promise<{marker: string} | {deny: string}> {
  const command = await codexCommand($, l.isWindows)
  if ('refused' in command) return {deny: command.refused}
  const marker = 'm-' + crypto.randomUUID().slice(0, 8)
  const message = text + footer(l.root, l.inbox, l.isWindows, marker)
  const run = await $.process.run([...command.argv, 'queue', '--thread', l.pair.thread, '--message', message], {cwd: l.root, timeoutMs: 60_000})
    .catch((error: unknown) => ({exitCode: -1, stdout: '', stderr: error instanceof Error ? error.message : 'codex did not start'}))
  if (run.exitCode !== 0) return {deny: 'codex queue failed: ' + (run.stderr || run.stdout).trim().slice(0, 500)}
  l.sent.push({marker, at: await $.clock.now(), isLate: false})
  await save($, l)
  return {marker}
}
export function pollLocal($: EngineInterface): Promise<void> {
  polling ??= scan($).catch(() => { $.ui.log('fleet-room: Codex inbox poll failed; the next poll retries.', {to: 'debug'}) })
    .finally(() => { polling = undefined })
  return polling
}
async function scan($: EngineInterface): Promise<void> {
  const l = local
  if (!l) return
  const entries = await $.fs.list(l.inbox).catch(() => [])
  const seen = new Map<string, Waiting>()
  const ready: string[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.md')) continue
    const prior = l.seen.get(entry.name)
    // A file counts once its size and time held still across two polls, so a write in progress is never read.
    if (prior && entry.size > 0 && prior.size === entry.size && prior.mtimeMs === entry.mtimeMs) ready.push(entry.name)
    seen.set(entry.name, {name: entry.name, size: entry.size, mtimeMs: entry.mtimeMs})
  }
  l.seen = seen
  l.ready = ready.sort()
  await checkPickup($, l)
  if (local === l) await submitNext($)
}
async function checkPickup($: EngineInterface, l: Local): Promise<void> {
  const pending = l.sent.filter(sent => !sent.isLate)
  if (!pending.length) return
  const now = await $.clock.now()
  const stat = await $.fs.stat(l.pair.rollout).catch(() => undefined)
  let changed = false
  if (stat && stat.mtimeMs > l.checkedAt && pending.some(sent => stat.mtimeMs >= sent.at)) {
    const found = await linesWith($, l.pair.rollout, pending.map(sent => sent.marker), l.isWindows)
    if (found) {
      l.checkedAt = stat.mtimeMs
      const taken = new Set(pending.filter(sent => isPickedUp(found, sent.marker)).map(sent => sent.marker))
      if (taken.size) { l.sent = l.sent.filter(sent => !taken.has(sent.marker)); changed = true }
    }
  }
  for (const sent of l.sent) {
    if (sent.isLate || now - sent.at < PICKUP_MS) continue
    sent.isLate = true
    changed = true
    $.ui.log('fleet-room: Codex has not picked up ' + sent.marker + ' after ' + PICKUP_MS / 60_000 + ' minutes.')
  }
  if (changed) await save($, l)
}
const MESSAGE_RULE = 'Codex reads only what you send with mcp__fleet-room__codex_send; your answer in this session does not reach it. '
  + 'Send only when a message asks something of you or Codex needs what you have. When it is a notice that needs nothing, end the turn without sending. '
  + 'Never send acknowledgements or thanks. You may do the work first and answer later.'
export async function codexCompose($: EngineInterface): Promise<{ wake: CodexWake, text: string } | undefined> {
  const l = local
  if (!l) return undefined
  const late = l.sent.filter(sent => sent.isLate).map(sent => sent.marker)
  const room = Math.max(0, l.cap - l.count)
  if (l.ready.length > room && !l.isCapLogged) {
    l.isCapLogged = true
    $.ui.log('fleet-room: Codex wakes paused after ' + l.cap + ' Codex messages since your last prompt; send a prompt to resume.')
  }
  const lines: string[] = []
  const files: string[] = []
  let budget = MAX_WAKE_CHARS - 2_000
  for (const name of l.ready.slice(0, room)) {
    const text = (await $.fs.read(joined(l.isWindows, l.inbox, name)).catch(() => undefined))?.replace(/^﻿/, '').trimEnd()
    if (text === undefined) continue
    if (files.length && text.length > budget) break
    const shown = text.length > budget ? text.slice(0, budget) + '\n[cut here; the whole message is at ' + joined(l.isWindows, l.archive, name) + ']' : text
    files.push(name)
    lines.push('\nMessage ' + name + ':\n' + shown)
    budget -= shown.length + 100
  }
  if (!files.length && !late.length) return undefined
  const marker = 'c-' + crypto.randomUUID().slice(0, 8)
  const head = ['Codex wake ' + marker + ' · from the Codex chat paired with this session, "' + l.pair.title + '" (' + l.pair.thread + ')', MESSAGE_RULE]
  for (const sent of late) {
    head.push('Your message ' + sent + ' has not been picked up by Codex after ' + PICKUP_MS / 60_000 + ' minutes: an idle Codex app chat can stop taking queued messages. '
      + 'Ask the owner to open or poke the Codex chat "' + l.pair.title + '" in the Codex app.')
  }
  return {wake: {marker, files, late}, text: [...head, ...lines].join('\n')}
}
/** Copies each file still in `from` into `archive`, then removes the originals; a file already gone is skipped. */
export async function archiveFiles($: EngineInterface, isWindows: boolean, from: string, archive: string, names: readonly string[]): Promise<void> {
  const archived: string[] = []
  for (const name of names) {
    const path = joined(isWindows, from, name)
    const text = await $.fs.read(path).catch(() => undefined)
    if (text === undefined) continue
    await $.fs.write(joined(isWindows, archive, name), text)
    archived.push(path)
  }
  if (!archived.length) return
  const run = isWindows
    ? await $.process.run(powershell("foreach ($p in ($env:FLEET_ROOM_FILES -split \"`n\")) { Remove-Item -LiteralPath $p -Force }"), {env: {FLEET_ROOM_FILES: archived.join('\n')}})
    : await $.process.run(['rm', '-f', '--', ...archived])
  if (run.exitCode !== 0) throw new Error('could not remove archived files')
}
export async function codexSettle($: EngineInterface, wake: CodexWake): Promise<void> {
  const l = local
  if (!l) return
  await archiveFiles($, l.isWindows, l.inbox, l.archive, wake.files)
  const files = new Set(wake.files)
  l.ready = l.ready.filter(name => !files.has(name))
  for (const name of files) l.seen.delete(name)
  l.count += wake.files.length
  const late = new Set(wake.late)
  l.sent = l.sent.filter(sent => !late.has(sent.marker))
  await save($, l)
}
export async function codexChanged($: EngineInterface): Promise<void> {
  if (local) await save($, local)
}
/** A prompt the person sent resets the loop cap. */
export async function humanPrompted($: EngineInterface): Promise<void> {
  const l = local
  if (!l || (l.count === 0 && !l.isCapLogged)) return
  l.count = 0
  l.isCapLogged = false
  await save($, l)
}
