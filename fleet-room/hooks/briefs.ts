import type { EngineInterface, Timer } from 'claude-code'
import { isWindowsPath, joined } from './codex'
import { archiveFiles } from './local'
import { MAX_WAKE_CHARS } from './room'
import { restore, slot, submitNext } from './wake'

export const BRIEF_POLL_MS = 5_000
/** A lease another session stopped renewing (a crash, a closed terminal) frees after three polls. */
const LEASE_MS = 3 * BRIEF_POLL_MS
/** The most of one brief's text a wake carries; the rest stays readable in the archive. */
export const MAX_BRIEF_CHARS = MAX_WAKE_CHARS - 2_000

type Waiting = { size: number, mtimeMs: number }
/** A wake of the brief folder: the one brief file it delivers. */
export type BriefWake = { marker: string, file: string }
type Saved = { v: 1, count: number, wake?: { kind: 'submitted' | 'running', wake: BriefWake, turnId?: string } }
type Briefs = {
  sessionId: string, key: string, isWindows: boolean, base: string, folder: string, archive: string, cap: number, count: number,
  seen: Map<string, Waiting>, ready: string[], timer: Timer | undefined, isCapLogged: boolean, leaseTicks: number, refused: string | undefined,
}
let briefs: Briefs | undefined
let polling: Promise<void> | undefined
const keyOf = (sessionId: string): string => 'briefs/' + sessionId
const leaseKeyOf = (key: string): string => 'briefs-lease/' + key
/** The longest slug a folder key keeps, so the key stays well inside a file name's 255 bytes. */
const MAX_SLUG = 64
/**
 * The name of a project's brief folder: the slug of its real path's last part, a dash, and the first 16 hex digits of
 * the SHA-256 of the real path's UTF-8 bytes. The hash keeps two paths from sharing a folder; the slug only reads.
 * The slug keeps `[A-Za-z0-9._-]` of the last part, at most 64 of them; an empty slug leaves the hash alone.
 */
export async function briefKey(realRoot: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(realRoot))
  const hash = [...new Uint8Array(digest)].slice(0, 8).map(byte => byte.toString(16).padStart(2, '0')).join('')
  const slug = (realRoot.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) ?? '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, MAX_SLUG)
  return slug ? slug + '-' + hash : hash
}
/** A brief is a visible `.md` file; a dot-name or any other ending is a write in progress and is never read. */
export const isBriefName = (name: string): boolean => name.endsWith('.md') && !name.startsWith('.')

const savedOf = (value: unknown): Saved | undefined => {
  const saved = value as Saved | undefined
  return saved?.v === 1 && Number.isInteger(saved.count) ? saved : undefined
}
async function save($: EngineInterface, b: Briefs): Promise<void> {
  const current = slot()
  const wake = (current.kind === 'submitted' || current.kind === 'running') && current.source === 'briefs'
    ? {kind: current.kind, wake: current.wake as BriefWake, ...(current.kind === 'running' ? {turnId: current.turnId} : {})} : undefined
  const saved: Saved = {v: 1, count: b.count, ...(wake ? {wake} : {})}
  await $.store.set(keyOf(b.sessionId), saved)
}
/**
 * Starts the brief folder for this session, or resumes it after a hot reload with its saved wake and loop count.
 * `ended` names the session a /clear or an in-process /resume ended: its count, wake and folder lease move to this one.
 */
export async function resumeBriefs($: EngineInterface, cap: number, ended?: string): Promise<void> {
  briefs?.timer?.cancel()
  briefs = undefined
  const sessionId = await $.session.id()
  const root = await $.session.root()
  const realRoot = (await $.fs.stat(root, {resolve: true})).realPath
  if (!realRoot) throw new Error('the project folder has no real path')
  const isWindows = isWindowsPath(realRoot)
  const home = isWindows ? await $.env.get('USERPROFILE') || await $.env.get('HOME') : await $.env.get('HOME')
  if (!home) throw new Error('no home folder')
  const key = await briefKey(realRoot)
  const base = joined(isWindows, home, '.fleet-room', 'briefs')
  const folder = joined(isWindows, base, key)
  let saved = savedOf(await $.store.get(keyOf(sessionId)))
  if (ended !== undefined && ended !== sessionId) {
    const prior = savedOf(await $.store.get(keyOf(ended)))
    if (!saved && prior) {
      saved = prior
      await $.store.set(keyOf(sessionId), saved)
    }
    if (prior) await $.store.delete(keyOf(ended))
    const lease = await $.store.get(leaseKeyOf(key)) as {session?: string, until?: number} | undefined
    if (lease?.session === ended) await $.store.set(leaseKeyOf(key), {...lease, session: sessionId})
  }
  const b: Briefs = {sessionId, key, isWindows, base, folder, archive: joined(isWindows, folder, 'archive'), cap, count: saved?.count ?? 0,
    seen: new Map(), ready: [], timer: undefined, isCapLogged: false, leaseTicks: 0, refused: undefined}
  await makeFolder($, b)
  await isFolderSafe($, b)
  briefs = b
  if (saved?.wake) {
    restore(saved.wake.kind === 'running' && saved.wake.turnId !== undefined
      ? {kind: 'running', source: 'briefs', wake: saved.wake.wake, turnId: saved.wake.turnId}
      : {kind: 'submitted', source: 'briefs', wake: saved.wake.wake})
  }
  b.timer = $.clock.every(BRIEF_POLL_MS, () => { void pollBriefs($) })
}
/** Makes the shared brief folder and this project's, each private to the box user, where they are missing. */
async function makeFolder($: EngineInterface, b: Briefs): Promise<void> {
  if (b.isWindows) {
    // Windows has no mode bits; a folder under the user's profile takes the profile's own access list.
    if (!await $.fs.exists(b.folder)) await $.fs.write(joined(true, b.folder, '.keep'), '')
    return
  }
  const run = await $.process.run(['mkdir', '-p', '-m', '700', '--', b.base, b.folder])
  if (run.exitCode !== 0) throw new Error('could not make the brief folder')
}
/** Why a folder another writer could have planted or opened is refused, or undefined when it is safe to read. */
async function refusalOf($: EngineInterface, b: Briefs, uid: string | undefined, path: string): Promise<string | undefined> {
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (!stat) return path + ' is missing'
  if (stat.isLink) return path + ' is a symbolic link'
  if (stat.kind !== 'dir') return path + ' is not a directory'
  if (b.isWindows) return undefined
  const listed = await $.process.run(['ls', '-ldn', '--', path])
  const [mode = '', , owner = ''] = listed.exitCode === 0 ? listed.stdout.trim().split(/\s+/) : []
  if (!mode.startsWith('d')) return path + ' is not a directory'
  if (owner !== uid) return path + ' is owned by uid ' + (owner || '?') + ', not this session\'s ' + uid
  if (mode[5] !== '-' || mode[8] !== '-') return path + ' is writable by its group or by others (mode ' + mode.slice(0, 10) + ')'
  return undefined
}
/**
 * True when both levels of the brief folder are real directories this session's user owns and no one else can write.
 * A refused folder delivers nothing; the session logs each new reason once.
 */
async function isFolderSafe($: EngineInterface, b: Briefs): Promise<boolean> {
  const id = b.isWindows ? undefined : await $.process.run(['id', '-u'])
  const uid = id?.exitCode === 0 ? id.stdout.trim() : undefined
  const refused = !b.isWindows && !uid ? 'this session\'s uid is unknown'
    : await refusalOf($, b, uid, b.base) ?? await refusalOf($, b, uid, b.folder)
  if (refused && refused !== b.refused) $.ui.log('fleet-room: brief folder refused, no brief delivered: ' + refused + '.')
  b.refused = refused
  return refused === undefined
}
/** One session per project folder reads its briefs: two sessions in one folder would both deliver each file. */
async function holdLease($: EngineInterface, b: Briefs): Promise<boolean> {
  const lease = leaseKeyOf(b.key)
  const now = await $.clock.now()
  const value = await $.store.get(lease) as {session?: string, until?: number} | undefined
  if (value && value.session !== b.sessionId && typeof value.until === 'number' && value.until > now) return false
  await $.store.set(lease, {session: b.sessionId, until: now + LEASE_MS})
  const held = await $.store.get(lease) as {session?: string} | undefined
  return held?.session === b.sessionId
}
export function pollBriefs($: EngineInterface): Promise<void> {
  polling ??= scan($).catch(() => { $.ui.log('fleet-room: brief folder poll failed; the next poll retries.', {to: 'debug'}) })
    .finally(() => { polling = undefined })
  return polling
}
async function scan($: EngineInterface): Promise<void> {
  const b = briefs
  if (!b) return
  if (!await holdLease($, b)) {
    b.leaseTicks = 0
    b.ready = []
    return
  }
  b.leaseTicks++
  const entries = await $.fs.list(b.folder).catch(() => [])
  const seen = new Map<string, Waiting>()
  const ready: string[] = []
  for (const entry of entries) {
    // A symbolic link lists as `other`, so a link dropped in the folder is never read.
    if (entry.kind !== 'file' || entry.isLink || !isBriefName(entry.name)) continue
    const prior = b.seen.get(entry.name)
    // Renamed in whole, a brief also holds still across two polls; this keeps a writer that skipped the rename from being read half-done.
    if (prior && entry.size > 0 && prior.size === entry.size && prior.mtimeMs === entry.mtimeMs) ready.push(entry.name)
    seen.set(entry.name, {size: entry.size, mtimeMs: entry.mtimeMs})
  }
  b.seen = seen
  b.ready = ready.sort()
  if (briefs === b) await submitNext($)
}
export async function briefsCompose($: EngineInterface): Promise<{ wake: BriefWake, text: string } | undefined> {
  const b = briefs
  // A second held poll before the first wake keeps two sessions that both just started from delivering the same brief.
  if (!b || b.leaseTicks < 2 || !b.ready.length) return undefined
  if (!await isFolderSafe($, b)) return undefined
  if (b.count >= b.cap) {
    if (!b.isCapLogged) {
      b.isCapLogged = true
      $.ui.log('fleet-room: brief wakes paused after ' + b.cap + ' briefs since your last prompt; send a prompt to resume.')
    }
    return undefined
  }
  for (const name of [...b.ready]) {
    const text = (await $.fs.read(joined(b.isWindows, b.folder, name)).catch(() => undefined))?.replace(/^﻿/, '').trimEnd()
    if (text === undefined) {
      b.ready = b.ready.filter(item => item !== name)
      continue
    }
    const shown = text.length > MAX_BRIEF_CHARS
      ? text.slice(0, MAX_BRIEF_CHARS) + '\n[cut here; the whole brief is at ' + joined(b.isWindows, b.archive, name) + ']' : text
    const marker = 'b-' + crypto.randomUUID().slice(0, 8)
    const head = 'Brief ' + marker + ' · from the brief folder of this project, file ' + name + ' (' + joined(b.isWindows, b.folder, name) + ').'
      + ' This machine\'s user put it there as a prompt for this session; its text follows as written.'
    return {wake: {marker, file: name}, text: head + '\n\n' + shown}
  }
  return undefined
}
export async function briefsSettle($: EngineInterface, wake: BriefWake): Promise<void> {
  const b = briefs
  if (!b) return
  await archiveFiles($, b.isWindows, b.folder, b.archive, [wake.file])
  b.ready = b.ready.filter(name => name !== wake.file)
  b.seen.delete(wake.file)
  b.count += 1
  await save($, b)
}
export async function briefsChanged($: EngineInterface): Promise<void> {
  if (briefs) await save($, briefs)
}
/** A prompt the person sent resets the loop cap. */
export async function briefsPrompted($: EngineInterface): Promise<void> {
  const b = briefs
  if (!b || (b.count === 0 && !b.isCapLogged)) return
  b.count = 0
  b.isCapLogged = false
  await save($, b)
}
