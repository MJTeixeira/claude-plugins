import { atom, update } from 'claude-code'
import type { EngineInterface, SessionAppendInput } from 'claude-code'
import type { SeatDisplay } from '../types/index'
import { claimName, claimOf, deliveryFile, isSeatId, lineageFile, mailDir, seatDir } from '../bin/core/layout.mjs'
import { join, seatHome } from './layout'

type SeatDelivery = { claim: string, claimedBy: string, seatSession: string, tries: number, failures: number, state: 'submitted' | 'retry' | 'dropped', sendRefused?: string }

// The host keeps $.state for one session, which /clear ends, and all of this must outlive a /clear: module state lasts
// as long as the hooks' process (measured: its timers tick on under the new id, while an atom reads its initial again).
const delivering = new Map<string, SeatDelivery>()
const accepting = new Map<string, { dir: string, call?: string }>()
let ended: string[] = []
let known: { id: string, ids: string[] } | undefined
let interrupted = false
let self: string | undefined

const seatsState = atom({ plugin: 'seat-router', key: 'seats' } as const, [], { shape: 'seat-display-3' })

const MAX_FAILURES = 3
const DONE_KEPT = 20
const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
// What $.agent.list() says of a subagent a message still reaches without resuming it.
const LISTENING: ReadonlySet<string> = new Set(['pending', 'running', 'waiting', 'idle'])

type Claimed = { id: string, claim: string, claimedBy: string, seatSession: string, sendRefused?: string }

const claimedOf = (id: string, entry: SeatDelivery): Claimed => ({ id, claim: entry.claim, claimedBy: entry.claimedBy, seatSession: entry.seatSession,
  ...(entry.sendRefused === undefined ? {} : { sendRefused: entry.sendRefused }) })

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function readJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return undefined }
}

async function readText($: EngineInterface, path: string): Promise<string> {
  try { return await $.fs.read(path) } catch { return '' }
}

async function listNames($: EngineInterface, dir: string): Promise<string[]> {
  try { return (await $.fs.list(dir)).map(entry => entry.name) } catch { return [] }
}

// $.fs has no rename, delete or exclusive create.
function seatIo($: EngineInterface, args: string[]): ReturnType<EngineInterface['process']['run']> {
  return $.process.run(['node', join($.plugin.root, 'bin', 'seat-io.mjs'), ...args])
}

async function seatOf($: EngineInterface, dir: string): Promise<Record<string, unknown> | undefined> {
  return asObject(readJson(await readText($, join(dir, 'seat.json'))))
}

const rowText = (content: readonly { type: string, [field: string]: unknown }[]): string => content.map(block => {
  if (block.type === 'text') return String(block.text ?? '')
  if (block.type !== 'tool_result') return ''
  return typeof block.content === 'string' ? block.content
    : Array.isArray(block.content) ? block.content.map(part => String(asObject(part)?.text ?? '')).join('\n') : ''
}).join('\n')

// Keeps every running entry and the DONE_KEPT that ended last.
export function boundDone<T extends { startedAt: number, endedAt?: number }>(items: readonly T[], isDone: (item: T) => boolean): T[] {
  const done = items.filter(isDone).sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt)).slice(DONE_KEPT)
  return done.length ? items.filter(item => !done.includes(item)) : [...items]
}

export function boundSeats(seats: readonly SeatDisplay[]): SeatDisplay[] {
  return boundDone(seats, seat => seat.status !== 'running' && seat.status !== 'waiting')
}

async function markReported($: EngineInterface, id: string): Promise<void> {
  const now = await $.clock.now()
  await update($, seatsState, seats => seats.some(seat => seat.id === id)
    ? boundSeats(seats.map(seat => seat.id === id ? { ...seat, status: 'reported', endedAt: now } : seat)) : seats)
}

async function inheritsOf($: EngineInterface, home: string, sessionId: string): Promise<string[]> {
  const record = asObject(readJson(await readText($, lineageFile(home, sessionId))))
  return record?.schema === 1 && Array.isArray(record.inherits) ? record.inherits.filter((id): id is string => typeof id === 'string') : []
}

export function noteClear(endingId: string): void {
  ended = [endingId, ...ended.filter(id => id !== endingId)]
  known = undefined
}

/** This session's id first, then its ids before each /clear; the first read under a new id writes lineage/<id>.json. */
export async function lineage($: EngineInterface): Promise<string[]> {
  const id = await $.session.id()
  if (known?.id === id) return known.ids
  const home = await seatHome($)
  const before = ended.filter(old => old !== id)
  const inherits = before.length
    ? [...new Set((await Promise.all(before.map(async old => [old, ...await inheritsOf($, home, old)]))).flat())].filter(old => old !== id)
    : await inheritsOf($, home, id)
  if (before.length) await $.fs.write(lineageFile(home, id), JSON.stringify({ schema: 1, inherits }))
  ended = ended.filter(old => !before.includes(old))
  known = { id, ids: [id, ...inherits] }
  return known.ids
}

const startedBeforeClear = (report: string): string => {
  const end = report.indexOf('\n')
  const head = end === -1 ? report : report.slice(0, end)
  return head.replace(/\.$/, '') + ' (started before /clear).' + (end === -1 ? '' : report.slice(end))
}

async function reportOf($: EngineInterface, home: string, ids: readonly string[], claimed: Claimed): Promise<string> {
  const report = await readText($, join(seatDir(home, claimed.id), 'report.md'))
  return report && claimed.seatSession !== ids[0] ? startedBeforeClear(report) : report
}

async function record($: EngineInterface, home: string, claimed: Claimed, fields: { deliveredTo: string, result: 'entered' | 'sent' | 'dropped', tries: number }): Promise<void> {
  await $.fs.write(deliveryFile(home, claimed.id), JSON.stringify({
    schema: 1, seat: claimed.id, sessionId: claimed.seatSession, deliveredTo: fields.deliveredTo, claimedBy: claimed.claimedBy,
    at: await $.clock.now(), result: fields.result, tries: fields.tries,
    ...(claimed.sendRefused === undefined ? {} : { sendRefused: claimed.sendRefused }),
  }, null, 2))
}

async function delivered($: EngineInterface, home: string, claimed: Claimed, fields: { deliveredTo: string, result: 'entered' | 'sent', tries: number }): Promise<void> {
  await record($, home, claimed, fields)
  await seatIo($, ['delivered', claimed.claim])
  delivering.delete(claimed.id)
  await markReported($, claimed.id)
}

async function failed($: EngineInterface, home: string, id: string, tries: number): Promise<void> {
  const entry = delivering.get(id)
  if (entry?.tries !== tries || entry.state !== 'submitted') return
  const failures = entry.failures + (interrupted ? 0 : 1)
  const next: SeatDelivery = { ...entry, failures, state: failures >= MAX_FAILURES ? 'dropped' : 'retry' }
  delivering.set(id, next)
  if (next.state === 'dropped') await record($, home, claimedOf(id, next), { deliveredTo: 'main', result: 'dropped', tries: next.tries })
}

async function submit($: EngineInterface, home: string, claimed: Claimed, text: string): Promise<void> {
  const prior = delivering.get(claimed.id)
  const tries = (prior?.tries ?? 0) + 1
  const { id: _id, ...where } = claimed
  delivering.set(claimed.id, { ...where, tries, failures: prior?.failures ?? 0, state: 'submitted' })
  // Never awaited: a submit settles once its prompt enters, which can wait behind a long turn.
  void $.prompt.submit({ text })
    .then(result => result.drop === undefined ? undefined : failed($, home, claimed.id, tries), () => failed($, home, claimed.id, tries))
    // A failure here leaves the report submitted in this process only: a resumed session delivers its claim again.
    .catch(() => undefined)
}

async function listening($: EngineInterface, agentId: string): Promise<boolean> {
  return (await $.agent.list()).some(agent => agent.id === agentId && LISTENING.has(agent.status))
}

async function deliver($: EngineInterface, home: string, ids: readonly string[], claimed: Claimed): Promise<void> {
  const text = await reportOf($, home, ids, claimed)
  if (!text) return
  const agentId = (await seatOf($, seatDir(home, claimed.id)))?.agentId
  if (typeof agentId === 'string' && await listening($, agentId)) {
    const sent = await $.session.send({ to: { agentId }, text })
    if (sent.isDelivered) return delivered($, home, claimed, { deliveredTo: agentId, result: 'sent', tries: 1 })
    return submit($, home, { ...claimed, sendRefused: sent.reason }, text)
  }
  await submit($, home, claimed, text)
}

// A `node` on PATH that runs node as its child has exited by the time the call returns; a claim naming it would read as gone.
async function sessionPid($: EngineInterface): Promise<string | undefined> {
  if (self) return self
  for (const pid of (await seatIo($, ['ancestors'])).stdout.split('\n').filter(line => /^\d+$/.test(line))) {
    if (!await gone($, pid)) return self = pid
  }
  return undefined
}

async function gone($: EngineInterface, pid: string): Promise<boolean> {
  return (await seatIo($, ['alive', pid])).exitCode === 1
}

export async function deliverMail($: EngineInterface, ids: readonly string[]): Promise<void> {
  const home = await seatHome($)
  const [current = ''] = ids
  const take = async (box: string, name: string, id: string, seatSession: string): Promise<void> => {
    const pid = await sessionPid($)
    if (pid === undefined) return
    const path = join(box, claimName(id, current, pid))
    if ((await seatIo($, ['claim', join(box, name), path])).exitCode !== 0) return
    await deliver($, home, ids, { id, claim: path, claimedBy: current, seatSession })
  }
  for (const seatSession of ids) {
    const box = mailDir(home, seatSession)
    for (const name of await listNames($, box)) {
      const claim = claimOf(name)
      if (isSeatId(name)) await take(box, name, name, seatSession)
      else if (claim && ids.includes(claim.claimedBy) && !delivering.has(claim.id)) {
        if (claim.pid === await sessionPid($)) await deliver($, home, ids, { id: claim.id, claim: join(box, name), claimedBy: claim.claimedBy, seatSession })
        else if (await gone($, claim.pid)) await take(box, name, claim.id, seatSession)
      }
    }
  }
}

export async function turnEnded($: EngineInterface, e: { agentId?: string, isAborted: boolean }): Promise<void> {
  if (e.agentId !== undefined) return
  interrupted = e.isAborted
  const waiting = [...delivering].filter(([, entry]) => entry.state === 'retry')
  if (!waiting.length) return
  const home = await seatHome($)
  const ids = await lineage($)
  for (const [id, entry] of waiting) {
    const claimed = claimedOf(id, entry)
    const text = await reportOf($, home, ids, claimed)
    if (text) await submit($, home, claimed, text)
  }
}

export async function sighted($: EngineInterface, e: SessionAppendInput): Promise<void> {
  if (e.door === 'queue' || e.agentId !== undefined || e.origin.kind !== 'plugin' || e.origin.name !== $.plugin.name) return
  const text = rowText(e.message.content)
  const seen = [...delivering].filter(([id]) => text.includes('Seat ' + id + ' ('))
  if (!seen.length) return
  const home = await seatHome($)
  for (const [id, entry] of seen) {
    await delivered($, home, claimedOf(id, entry), { deliveredTo: 'main', result: 'entered', tries: entry.tries })
  }
}

/** A seat's id, picked before accept.mjs runs, so every way the Agent call ends without answering can refuse it. */
export async function pickSeat($: EngineInterface, call: string | undefined): Promise<{ id: string, dir: string }> {
  const id = 'seat-' + Array.from(crypto.getRandomValues(new Uint8Array(6)), byte => ID_CHARS[byte % ID_CHARS.length] ?? '0').join('')
  const dir = seatDir(await seatHome($), id)
  accepting.set(id, { dir, ...(call === undefined ? {} : { call }) })
  return { id, dir }
}

/** accept.mjs exited refusing the seat: a folder it made before failing is refused, else the seat is forgotten. */
export async function acceptRefused($: EngineInterface, seat: { id: string, dir: string }): Promise<void> {
  if (await $.fs.exists(seat.dir)) return unanswered($, undefined, seat.id)
  accepting.delete(seat.id)
}

async function settle($: EngineInterface, ids: readonly string[], marker: 'accepted' | 'refused'): Promise<void> {
  for (const id of ids) {
    const dir = accepting.get(id)?.dir
    accepting.delete(id)
    if (dir !== undefined) await $.fs.write(join(dir, marker), '')
  }
}

export async function answered($: EngineInterface, e: SessionAppendInput): Promise<void> {
  if (e.door !== 'tool-result' || e.origin.kind !== 'tool' || e.origin.tool !== 'Agent') return
  const pending = [...accepting.keys()]
  if (!pending.length) return
  const text = rowText(e.message.content)
  const named = pending.filter(id => text.includes(id))
  if (named.length) await settle($, named, 'accepted')
}

/** Writing `refused` makes the seat's folder, so an accept.mjs still running finds it taken and makes nothing. */
export async function unanswered($: EngineInterface, call: string | undefined, seat?: string): Promise<void> {
  const ids = [...accepting].filter(([id, entry]) => id === seat || (call !== undefined && entry.call === call)).map(([id]) => id)
  if (ids.length) await settle($, ids, 'refused')
}

export async function stopTask($: EngineInterface, taskId: string | undefined): Promise<{ message: string, task_id: string, task_type: string, command: string } | undefined> {
  if (taskId === undefined || !isSeatId(taskId)) return undefined
  const dir = seatDir(await seatHome($), taskId)
  const seat = await seatOf($, dir)
  if (typeof seat?.sessionId !== 'string' || !(await lineage($)).includes(seat.sessionId)) return undefined
  const command = String(seat.description ?? '')
  if (await $.fs.exists(join(dir, 'report.md'))) {
    return { message: 'Seat ' + taskId + ' has already finished; its report is ' + dir + '/report.md.', task_id: taskId, task_type: 'seat', command }
  }
  await $.fs.write(join(dir, 'stop'), '')
  return { message: 'Stopping seat ' + taskId + '; its report follows.', task_id: taskId, task_type: 'seat', command }
}

export async function undeliveredLines($: EngineInterface): Promise<string[]> {
  const home = await seatHome($)
  const lines: string[] = []
  for (const seatSession of await lineage($)) {
    for (const name of await listNames($, mailDir(home, seatSession))) {
      const claim = claimOf(name)
      const id = isSeatId(name) ? name : claim?.id
      if (id === undefined) continue
      const dir = seatDir(home, id)
      const description = (await seatOf($, dir))?.description
      lines.push('- ' + id + (typeof description === 'string' ? ' ("' + description + '")' : '') + ': ' + dir + '/report.md, '
        + (claim ? 'claimed by session ' + claim.claimedBy + ' in process ' + claim.pid + ' and not delivered' : 'waiting for session ' + seatSession))
    }
  }
  return lines.length ? ['Undelivered reports:', ...lines] : []
}
