// A seat's lifecycle as one pure transition over what its folder says. Imported by the supervisor and by the
// hooks, so it imports nothing from node: (bin/structure.test.mjs).
import { rank } from './rank.mjs'

export const SEAT_SCHEMA = 1
export const DEADLINE_MS = 6 * 60 * 60 * 1000
export const EXHAUSTION_DEFAULT_MS = 30 * 60 * 1000
export const SLOT_CHECK_MS = 60_000
export const DIED_RERUNS = 1
export const MAX_ADOPTIONS = 3
export const MAX_NOT_STARTED = 3

/**
 * seat.json, written once by accept.mjs. `candidates` is the seat line's list, of the ones that can run here; `first`
 * the index the Agent hook picked. `scopes` names each candidate's quota scopes, an account's by its config folder,
 * and `ranked` how each stood at the pick; `pinned` a line that runs its first candidate unless it is out (an explicit
 * model, or an account). `launch` is everything a launch reads from the environment, recorded so that a supervisor
 * started by another session launches as the first one would. `agentId` is the subagent whose Agent call made the
 * seat, absent for the main conversation; `version` the seat-router version that accepted it.
 * @typedef {{ vendor: 'codex'|'agy'|'claude', model: string, effort: string, account?: string }} Candidate
 * @typedef {import('./ledger.mjs').State} State
 * @typedef {{ env: Record<string, string>, clis: Record<string, string>, os: 'windows'|'posix', home: string, accounts: Record<string, string>,
 *             settings: Record<string, unknown> }} Launch
 * @typedef {{ schema: 1, id: string, sessionId: string, createdAt: number, description: string,
 *             tier: 'reviewer'|'owner', brief: string, cwd: string, isolation: 'worktree'|'folder', baseSha?: string,
 *             candidates: Candidate[], first: number, scopes?: string[][], ranked?: State[], pinned?: boolean, busyAt?: number, trail: string[],
 *             firstRanks?: number[], floor: string, launch: Launch, agentId?: string, version?: string }} Seat
 */

/**
 * How one attempt ended. `text` is the answer (done) or the output so far; `resume` a conversation the CLI can continue.
 * `left` marks an attempt that ended while a process of it may still run; `note` says so in the report.
 * @typedef {'stopped'|'deadline'|'crashed'} Kill
 * @typedef {{ kind: 'done'|'quota'|'transient'|'failed'|'unclassified'|'died'|'not-started'|Kill,
 *             detail: string, text: string, endedAt: number, until?: number, resume?: string, left?: boolean, note?: string }} Ending
 * An attempt's `state` is how it reads now. `starting`: its launcher has not claimed it yet. `answered` and `silent`:
 * its launcher holds the endpoint and did or did not answer. `left`: the launcher is gone and a process of the CLI may
 * still run. `gone`: nothing of it is left. `not-started`: no launcher of it will ever start a CLI. `unknown`: it
 * could not be read. `exited`: the launcher wrote the CLI's exit. `ended`: the supervisor wrote how it ended.
 * `kill` is the reason a kill was written for it. `leftover` is set on an ended attempt marked `left` whose release has
 * not run: `running` while a process of its CLI's group may still run, `held` once none can but a process still uses
 * a folder its release deletes, `quiet` once neither.
 * @typedef {{ n: number, index: number, startedAt: number, resume?: string, rerun?: boolean, rankedAs?: string,
 *             state: 'starting'|'answered'|'silent'|'left'|'gone'|'not-started'|'unknown'|'exited'|'ended', kill?: Kill,
 *             ending?: Ending, leftover?: 'running'|'held'|'quiet', ownerUnchanged?: boolean }} Attempt
 * @typedef {{ kind: 'done'|'owner-changed'|'stopped'|'deadline'|'exhausted'|'crashed', detail?: string }} Verdict
 * `quota` is how each candidate stands in the merged ledger now, `families` each one's model family, and `running` the
 * seats running on this machine by family, this one left out: what failover ranks by.
 * @typedef {{ state: State, until?: number }} Standing
 * @typedef {{ seat: Seat, generation: number, accepted: boolean, refused: boolean, worktree: 'none'|'absent'|'ready',
 *             attempts: Attempt[], next: number, stopRequested: boolean, slotTaken: boolean[], effectFailed?: string,
 *             quota?: Standing[], families?: string[], running?: Record<string, number>,
 *             verdict?: Verdict, released: boolean, releasePending: boolean, reported: boolean, outcome: boolean, mailed: boolean,
 *             live: boolean }} Tree
 * @typedef {{ kind: 'exit' } | { kind: 'outcome' } | { kind: 'mail' } | { kind: 'unlive' } | { kind: 'abandon' } | { kind: 'release', held: boolean } | { kind: 'report' }
 *          | { kind: 'verdict', verdict: Verdict } | { kind: 'worktree' } | { kind: 'probe-owner', n: number }
 *          | { kind: 'launch', n: number, index: number, resume?: string, rerun?: boolean }
 *          | { kind: 'watch', n: number } | { kind: 'kill', n: number, why: Kill }
 *          | { kind: 'judge', n: number } | { kind: 'end', n: number, ending: Ending } | { kind: 'settle', n: number }
 *          | { kind: 'wait', until: number, why: 'accept'|'quota'|'slot'|'leftover' }} Step
 */

const TERMINAL = { done: 'done', stopped: 'stopped', deadline: 'deadline' }
const FAILED = new Set(['failed', 'unclassified', 'transient', 'died'])

const resumesOn = (attempts, index) => attempts.filter(attempt => attempt.index === index && attempt.resume !== undefined).length
const diedOn = (attempts, index) => attempts.filter(attempt => attempt.index === index && attempt.ending?.kind === 'died').length

/** Whether the attempt's ending retires its candidate. A transient ending its CLI can still resume does not, nor does a death within its reruns. */
const retiresIndex = (attempts, attempt, budgets) => {
  const ending = attempt.ending
  if (!ending || !FAILED.has(ending.kind)) return false
  if (ending.kind === 'transient') return ending.resume === undefined || resumesOn(attempts, attempt.index) >= (budgets[attempt.index] ?? 0)
  if (ending.kind === 'died') return diedOn(attempts, attempt.index) > DIED_RERUNS
  return true
}

/**
 * Each candidate as the seat stands now: free, held until a time (its quota, out in the ledger or by this seat's own
 * quota ending) or until a slot frees, or retired. `known`: the vendor said when the quota is back; otherwise it is
 * looked at again then.
 * @returns {({ kind: 'free' } | { kind: 'held', why: 'quota'|'slot', until: number, known?: boolean } | { kind: 'retired' })[]}
 */
export const availability = (tree, now, budgets) => tree.seat.candidates.map((_, index) => {
  const mine = tree.attempts.filter(attempt => attempt.index === index)
  if (mine.some(attempt => retiresIndex(tree.attempts, attempt, budgets))) return { kind: 'retired' }
  const quota = mine.map(attempt => attempt.ending).filter(ending => ending?.kind === 'quota').at(-1)
  const view = tree.quota?.[index]
  const holds = [
    ...quota ? [{ until: quota.until ?? quota.endedAt + EXHAUSTION_DEFAULT_MS, known: quota.until !== undefined }] : [],
    ...view?.state === 'out' ? [{ until: view.until ?? now + SLOT_CHECK_MS, known: view.until !== undefined }] : [],
  ].filter(hold => hold.until > now)
  if (holds.length) {
    const last = holds.reduce((a, b) => b.until > a.until ? b : a)
    return { kind: 'held', why: 'quota', until: last.until, known: last.known }
  }
  if (tree.slotTaken[index]) return { kind: 'held', why: 'slot', until: now + SLOT_CHECK_MS }
  return { kind: 'free' }
})

export const KILL_DETAIL = {
  stopped: 'stopped on request', deadline: 'still running at the deadline',
  crashed: 'ended because seat-router stopped supervising the seat',
}

const LEFT_NOTE = {
  left: 'Its CLI may still be running: its launcher is gone and seat-router could not end it.',
  unknown: 'Its CLI may still be running: seat-router could not read whether it was.',
}

/**
 * A step for an attempt that has no ending yet. A kill due on an attempt whose launcher is gone ends it without a
 * signal: no next attempt starts beside a CLI that may still run.
 * @returns {Step}
 */
const running = (tree, attempt, now, crashed) => {
  const { n } = attempt
  if (attempt.state === 'exited' || attempt.state === 'gone') return { kind: 'judge', n }
  if (attempt.state === 'not-started') {
    const kind = attempt.kill === undefined ? 'not-started' : attempt.kill
    return { kind: 'end', n, ending: { kind, detail: kind === 'not-started' ? 'its launcher never started it' : KILL_DETAIL[kind], text: '', endedAt: now } }
  }
  const due = tree.stopRequested ? 'stopped' : crashed !== undefined ? 'crashed' : ['stopped', 'crashed'].includes(attempt.kill) ? attempt.kill : undefined
  if (!due) return { kind: 'watch', n }
  if (attempt.state === 'left' || attempt.state === 'unknown') {
    return { kind: 'end', n, ending: { kind: due, detail: KILL_DETAIL[due], text: '', endedAt: now, left: true, note: LEFT_NOTE[attempt.state] } }
  }
  return { kind: 'kill', n, why: due }
}

/**
 * What the supervisor does next. Pure: the same tree gives the same step, and every step's effect is idempotent or
 * write-once, so a supervisor adopted after any crash resumes where the dead one stopped. `budgets[i]` is how many
 * times candidate i's CLI may resume a conversation (its adapter's resume budget).
 * @param {Tree} tree
 * @param {number} now
 * @param {number[]} budgets
 * @returns {Step}
 */
export const step = (tree, now, budgets) => {
  const { seat } = tree
  const settle = tree.attempts.find(attempt => attempt.leftover === 'quiet')
  if (settle) return { kind: 'settle', n: settle.n }
  // A process of a CLI's group holds the next launch; one that only uses a folder holds only what deletes it.
  const lingering = tree.attempts.some(attempt => attempt.leftover === 'running')
  const holding = lingering || tree.attempts.some(attempt => attempt.leftover === 'held')
  /** @type {Step} */
  const hold = { kind: 'wait', until: now + SLOT_CHECK_MS, why: 'leftover' }
  if (tree.reported) {
    if (!tree.outcome) return { kind: 'outcome' }
    if (!tree.mailed) return { kind: 'mail' }
    if (tree.live) return { kind: 'unlive' }
    // Past the deadline, what a process may still use is left to prune-seats.
    if (tree.releasePending) return !holding ? { kind: 'release', held: false } : now < seat.createdAt + DEADLINE_MS ? hold : { kind: 'exit' }
    return { kind: 'exit' }
  }
  if (tree.verdict) return tree.released ? { kind: 'report' } : { kind: 'release', held: holding }
  if (tree.refused || (!tree.accepted && now >= seat.createdAt + DEADLINE_MS)) return { kind: 'abandon' }
  if (!tree.accepted) return { kind: 'wait', until: seat.createdAt + DEADLINE_MS, why: 'accept' }
  const last = tree.attempts.at(-1)
  const notStarted = tree.attempts.filter(attempt => attempt.ending?.kind === 'not-started').length
  const crashed = tree.effectFailed
    ?? (tree.generation - 1 > MAX_ADOPTIONS ? 'its supervisor stopped ' + (tree.generation - 1) + ' times' : undefined)
    ?? (notStarted >= MAX_NOT_STARTED ? 'its launcher never started a CLI, ' + notStarted + ' times' : undefined)
  // No verdict while an attempt has no ending: a seat that reported would leave its CLI running unowned.
  if (last && !last.ending) return running(tree, last, now, crashed)
  if (crashed !== undefined) return { kind: 'verdict', verdict: { kind: 'crashed', detail: crashed } }
  const terminal = last?.ending && TERMINAL[last.ending.kind]
  if (terminal) return { kind: 'verdict', verdict: { kind: terminal } }
  if (tree.stopRequested) return { kind: 'verdict', verdict: { kind: 'stopped' } }
  /** @param {Step} next @returns {Step} */
  const unlessHeld = next => lingering ? hold : next
  if (last?.ending?.kind === 'not-started' && now < seat.createdAt + DEADLINE_MS && availability(tree, now, budgets)[last.index]?.kind === 'free') {
    return unlessHeld({ kind: 'launch', n: tree.next, index: last.index, ...(last.resume === undefined ? {} : { resume: last.resume }), ...(last.rerun ? { rerun: true } : {}) })
  }
  if (last?.ending?.kind === 'transient' && last.ending.resume !== undefined && resumesOn(tree.attempts, last.index) < (budgets[last.index] ?? 0)) {
    return now >= seat.createdAt + DEADLINE_MS ? { kind: 'verdict', verdict: { kind: 'deadline' } }
      : unlessHeld({ kind: 'launch', n: tree.next, index: last.index, resume: last.ending.resume })
  }
  if (last && last.ending?.kind !== 'not-started' && seat.tier === 'owner') {
    if (last.ownerUnchanged === undefined && seat.isolation === 'worktree') return { kind: 'probe-owner', n: last.n }
    if (!last.ownerUnchanged) return { kind: 'verdict', verdict: { kind: 'owner-changed', detail: last.ending?.detail ?? '' } }
  }
  if (now >= seat.createdAt + DEADLINE_MS) return { kind: 'verdict', verdict: { kind: 'deadline' } }
  if (seat.isolation === 'worktree' && tree.worktree !== 'ready') return { kind: 'worktree' }
  const states = availability(tree, now, budgets)
  if (last?.ending?.kind === 'died' && states[last.index]?.kind === 'free') return unlessHeld({ kind: 'launch', n: tree.next, index: last.index, rerun: true })
  const eligible = index => states[index]?.kind === 'free'
  const n = tree.next
  if (!last && eligible(seat.first)) return { kind: 'launch', n, index: seat.first }
  // The ledger was read before `now`, so a state whose until has passed by now no longer holds, as availability judges it.
  const stateNow = view => view?.until !== undefined && view.until <= now ? 'unknown' : view?.state ?? 'unknown'
  const order = rank(seat.candidates.map((_, index) => ({
    state: stateNow(tree.quota?.[index]), family: tree.families?.[index] ?? '', firstRank: seat.firstRanks?.[index] ?? 0,
  })), { tier: seat.tier, pinned: seat.pinned === true, live: tree.running ?? {} })
  const next = order.find(eligible)
  if (next !== undefined) return unlessHeld({ kind: 'launch', n, index: next })
  const held = /** @type {{ kind: 'held', why: 'quota'|'slot', until: number, known?: boolean, index: number }[]} */ (
    states.flatMap((state, index) => state.kind === 'held' ? [{ ...state, index }] : []))
  const deadline = seat.createdAt + DEADLINE_MS
  const everyResetPastDeadline = held.length > 0 && held.every(state => state.why === 'quota' && state.known && state.until >= deadline)
  if (everyResetPastDeadline) {
    const resets = held.map(state => name(seat.candidates[state.index] ?? seat.candidates[0]) + ' until ' + utcTime(state.until)).join(', ')
    return { kind: 'verdict', verdict: { kind: 'exhausted', detail: resets } }
  }
  if (held.length) {
    const soonest = held.reduce((a, b) => a.until <= b.until ? a : b)
    return { kind: 'wait', until: Math.min(soonest.until, deadline), why: soonest.why }
  }
  return { kind: 'verdict', verdict: { kind: 'exhausted' } }
}

const utcTime = at => new Date(at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'

const name = candidate => (candidate.account ?? candidate.vendor) + ' ' + candidate.model
const seatName = candidate => candidate.account === undefined ? candidate.vendor : 'claude on the ' + candidate.account + ' account'

/** The fallback trail: what the hook passed over, then each attempt and why it ended, oldest first. */
export const trailOf = tree => {
  const entries = [...tree.seat.trail]
  const ran = tree.attempts.filter(attempt => attempt.ending?.kind !== 'not-started')
  for (const [i, attempt] of ran.entries()) {
    const candidate = tree.seat.candidates[attempt.index]
    if (!candidate) continue
    const label = name(candidate) + (attempt.resume !== undefined ? ' resumed' : attempt.rerun ? ' rerun' : '')
    if (entries.length || i > 0) entries.push(label)
    const ending = attempt.ending
    if (ending && ending.kind !== 'done' && ending.kind !== 'stopped') {
      entries.push(name(candidate) + (ending.kind === 'quota' ? ' out (' : ' failed (') + ending.detail + ')')
    }
  }
  return entries
}

/**
 * @param {Tree} tree
 * @param {Verdict} verdict
 * @param {number} now
 */
export const outcomeOf = (tree, verdict, now) => ({
  schema: 1, seat: tree.seat.id, version: tree.seat.version ?? 'unknown', os: tree.seat.launch.os, tier: tree.seat.tier,
  isolation: tree.seat.isolation, createdAt: tree.seat.createdAt, endedAt: now, verdict: verdict.kind, adoptions: tree.generation - 1,
  attempts: tree.attempts.flatMap(attempt => {
    const candidate = tree.seat.candidates[attempt.index]
    const ending = attempt.ending
    if (!candidate || !ending || ending.kind === 'not-started') return []
    return [{
      n: attempt.n, vendor: candidate.vendor, model: candidate.model, effort: candidate.effort,
      ...(candidate.account === undefined ? {} : { account: candidate.account }), startedAt: attempt.startedAt, endedAt: ending.endedAt,
      ending: ending.kind, detail: ending.detail, ...(attempt.rankedAs === undefined ? {} : { rankedAs: attempt.rankedAs }),
      contradiction: attempt.rankedAs === 'free' && ending.kind === 'quota',
    }]
  }),
})

const VERDICT_TEXT = {
  done: () => '',
  'owner-changed': detail => 'The owner seat ended (' + detail + ') and was not moved to another candidate or rerun, because it changed its worktree. Its output:',
  stopped: () => 'Stopped on request; it was not rerun. Its output so far:',
  deadline: (_, floor) => 'Gave up after ' + DEADLINE_MS / 3_600_000 + ' hours. The floor of its size is ' + floor + '. The last one\'s output:',
  exhausted: (detail, floor) => detail
    ? 'No CLI could take this seat before its ' + DEADLINE_MS / 3_600_000 + '-hour deadline: every candidate left is out of quota until after it ('
      + detail + '). The floor of its size is ' + floor + '. The last one\'s output:'
    : 'No CLI could take this seat: every candidate failed. The floor of its size is ' + floor + '. The last one\'s output:',
  crashed: detail => 'seat-router could not run this seat: ' + detail + '. Its output so far:',
}

const seconds = ms => Math.ceil(ms / 1000)

// agy feeds its model background-task notices as <SYSTEM_MESSAGE> blocks, each after a preamble
// line, and the model can echo them into its answer. In the session's context they would read
// as system text, so a report drops every block in agy's exact shape, whichever seat wrote it:
// tag lines of their own around a `[Message] ` line. A seat that mentions the tag in its own text
// keeps it, and so does a block with no closing line, since where it ends cannot be told.
const NOTICE = /^(?:The following is a <SYSTEM_MESSAGE> not actually sent by the user\. It is provided by the system as important information to pay attention to\.\r?\n(?:[ \t]*\r?\n)*)?<SYSTEM_MESSAGE>\r?\n\[Message\] (?:(?!^<SYSTEM_MESSAGE>\r?$)[\s\S])*?^<\/SYSTEM_MESSAGE>\r?(?:\n|$)/gm

/** @returns {{ text: string, note?: string }} */
export const withoutSystemNotices = text => {
  let total = 0
  const cleaned = text.replace(NOTICE, () => { total += 1; return '' })
  if (!total) return { text }
  return { text: cleaned, note: 'Removed ' + total + ' system-message block' + (total === 1 ? '' : 's') + ' from the seat\'s output.' }
}

/**
 * The report. Its header is `Seat <id> ("<description>", <vendor> <model> <effort> <tier>) finished.`
 * @param {Tree} tree
 * @param {Verdict} verdict
 * @param {{ release?: string, kept: string[], keepFailed: string, waits: { quota?: number, slot?: number }, notes: string[] }} extra
 */
export const reportText = (tree, verdict, extra) => {
  const last = tree.attempts.at(-1)
  const candidate = tree.seat.candidates[last?.index ?? tree.seat.first] ?? tree.seat.candidates[0]
  const lines = ['Seat ' + tree.seat.id + ' ("' + tree.seat.description + '", '
    + (candidate ? seatName(candidate) + ' ' + candidate.model + ' ' + candidate.effort + ' ' : '') + tree.seat.tier + ') finished.']
  const trail = trailOf(tree)
  if (trail.length) lines.push('Fallback: ' + trail.join(' → '))
  if (extra.waits.quota) lines.push('Waited ' + seconds(extra.waits.quota) + ' seconds for quota reset.')
  if (extra.waits.slot) lines.push('Waited ' + seconds(extra.waits.slot) + ' seconds for the one Claude seat on the session\'s account that this machine runs at a time.')
  lines.push(...new Set(tree.attempts.flatMap(attempt => attempt.ending?.note ?? [])))
  if (extra.release) lines.push(extra.release)
  if (extra.kept.length) lines.push('Images the seat made, copied out of its CLI\'s home: ' + extra.kept.join(', '))
  if (extra.keepFailed) lines.push('Copying the images the seat made out of its CLI\'s home failed: ' + extra.keepFailed.trim().split(/\r?\n/).join('; '))
  lines.push(...extra.notes)
  const cleaned = withoutSystemNotices(last?.ending?.text ?? '')
  if (cleaned.note) lines.push(cleaned.note)
  const lead = VERDICT_TEXT[verdict.kind](verdict.detail ?? '', tree.seat.floor)
  lines.push('', lead ? lead + '\n\n' + (cleaned.text.trim() || '(none)') : cleaned.text)
  return lines.join('\n')
}
