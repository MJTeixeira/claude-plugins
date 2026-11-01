// Adapted from savvy-progress by johnnyvizz; see ../NOTICE.md.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'
import type { QueueDisplay, SeatDisplay, SeatVendor } from '../types/index'
import {
  CARD_H, HEADER_H, LINE_H, QUOTA_H, ROW_H, SECTION_H, VENDORS,
  cardSvg, fmtTime, fmtTokens, gridSvg, gridTiles, headerSvg, plural, quotaAlt, quotaSvg, quotaWidth,
  rowSvg, runningSvg, stepLine, totals,
} from './art'
import type { Card } from './art'
import { cardRaster, headerRaster, queueRaster, quotaRaster, runningRaster } from './raster'
import type { Drawing } from './raster'
import { accountCandidate, autoCandidates, FAMILIES, familyOf, formatCandidate, parseAccounts, parseCandidates, SIZES } from './chain'
import type { Candidate, Size } from './chain'
import {
  accountDirs, accountNames, accountSetting, branchProtection, busyAtSetting, cliModels, correctUnfinishedNotice, delegateOf, delegateSetting, formatAccounts, foundAccounts, installedVendors, jobNames, jobsOf, parseSeatLine, seatCandidates, seatJobs, seatLineForms, TIERS,
  saveOptions, seatConfigFrom, setAccounts, setDelegate, setJobs, setSeatConfig, setSize, sizeCandidates, probeSandboxes, pruneSeats, singleFlightPoll, startSeat,
} from './router'
import type { Delegate, ExternalVendor, FoundAccount, Jobs, Policies } from './router'
import { answered, noteClear, sighted, stopTask, turnEnded, unanswered, undeliveredLines } from './delivery'
import { decide, delegateReason, noteComposed, quotaLines, refreshBand, refreshQuotas, writeSessionQuota } from './quota'
import { isSeatId } from '../bin/core/layout.mjs'
import { FACTS } from '../bin/vendors/index.mjs'
import { candidateSet, capableWords, CODE_JOB, jobWords, ruleText, SHIPPED_JOBS } from '../bin/core/policy.mjs'

const seatsState = atom({ plugin: 'seat-router', key: 'seats' } as const, [], { shape: 'seat-display-3' })
const quotasState = atom({ plugin: 'seat-router', key: 'quotas' } as const, {}, { shape: 'quota-states-1' })
const queueState = atom({ plugin: 'seat-router', key: 'queue' } as const, null)
const vendorsState = atom({ plugin: 'seat-router', key: 'vendors' } as const, null, { shape: 'installed-vendors-1' })
const seatPaneTickState = atom({ plugin: 'seat-router', key: 'seatPaneTick' } as const, 0)
const seatPanelState = atom({ plugin: 'seat-router', key: 'seatPanel' } as const, { isDoneCollapsed: false })
const delegateShownState = atom({ plugin: 'seat-router', key: 'delegateShown' } as const, null)

const PANE = 'seats'

type Usable = Record<Size, Candidate[]>

const usableOf = (vendors: readonly ExternalVendor[], sizes: Usable): Usable => Object.fromEntries(SIZES.map(size =>
  [size, sizes[size].filter(candidate => candidate.vendor === 'claude' || vendors.includes(candidate.vendor as ExternalVendor))])) as Usable

const taughtJobs = (usable: Usable, policies: Policies): string[] => jobWords(policies)
  .filter(job => SIZES.every(size => candidateSet({ size, job }, usable[size], policies, FACTS).kind === 'ok'))

const jobSentence = (jobs: readonly string[], all: readonly Candidate[], policies: Policies): string => {
  if (jobs.length === 0) return ''
  const shown = jobs.map(job => {
    const policy = policies[job] as Policies[string]
    const parts = [
      ...(policy.description === undefined ? [] : [policy.description]),
      ...(policy.needs.length === 0 ? [] : ['on ' + capableWords(all, policy.needs, FACTS).join(' or ') + ' only']),
      ...ruleText(policy),
    ]
    return '`' + job + '`' + (parts.length === 0 ? '' : ' (' + parts.join('; ') + ')')
  })
  const handed = jobs.filter(job => job !== CODE_JOB).map(job => '`' + job + '`')
  return ' A job, the optional last word, sends the seat only to models that can do that work and follows its rules: '
    + shown.join(', ') + '. A line without one runs on any of its size\'s models.'
    + (handed.length === 0 ? '' : ' Send work that fits ' + [handed.slice(0, -1).join(', '), handed.at(-1)].filter(Boolean).join(' or ')
      + ' to a seat whose line ends in that job instead of doing it yourself, whether or not delegate mode is on.'
      + ' When the mod refuses such a seat, tell the person it was refused and why, and do not do that job\'s work yourself.')
}

const seatRules = (vendors: readonly ExternalVendor[], usable: Usable, mixFanouts: boolean, accounts: readonly string[], jobs: readonly string[], policies: Policies): string => {
  const all = SIZES.flatMap(size => usable[size])
  const families = FAMILIES.filter(family => all.some(candidate => familyOf(candidate) === family))
  const others = families.filter(family => family !== 'claude')
  const { sized, explicit } = seatLineForms([...vendors, ...families], vendors, jobs)
  return 'The seat-router mod is loaded: an Agent call whose prompt starts with a seat line runs on another CLI ('
    + vendors.join(', ') + ') or as a separate Claude process, and its report arrives later as a message from the seat-router plugin. A seat line is either '
    + '`' + sized + '`, where the mod picks the model of that size by '
    + 'quota and never leaves the named CLI (' + vendors.join('|') + ') or model family (' + families.join('|') + '), or '
    + '`' + explicit + '`, which runs that model, and only while it is out moves to the other models of its family in its effort\'s size, at that effort. A task that names an '
    + 'effort maps to a size: low or medium is light, high is standard, xhigh or max is heavy. Sizes, in the order tried: '
    + SIZES.map(size => size + ' = ' + usable[size].map(formatCandidate).join(', ')).join('; ') + '.'
    + jobSentence(jobs, all, policies) + '\n'
    + 'A seat is a fresh context: it sees only its brief and its folder, so the brief carries '
    + 'the task, the grounding it cannot read from its folder, and its output format. Tier `owner` is for a seat that '
    + 'commits, pushes, opens or merges a PR, or needs tools outside its folder (Docker, a database); it may '
    + 'leave its CLI\'s sandbox, and its report names the branch it leaves, its worktree removed. Every other seat is '
    + '`reviewer`: it reports and does not commit, and its commands reach the network unless it runs on Claude. '
    + 'Pass `isolation: "worktree"` whenever the seat reads or changes this repository, a review included: '
    + 'without it the seat starts in an empty folder and sees only the absolute paths its brief names. A seat '
    + 'cannot be continued: give follow-up work to a fresh seat with the whole scope. Stop one with TaskStop and its seat id; '
    + 'its report follows. The mod falls back along the candidates '
    + 'the line allows and waits out a quota reset for up to six hours from the seat\'s start; a seat none of them could take in that time reports that it failed, '
    + 'with its fallback trail and the last candidate\'s output, and nothing else runs for it. A seat none of whose candidates can run on this machine is refused. '
    + 'A seat line the mod refuses comes back with the grammar to write instead.'
    + (accounts.length > 0
      ? '\nOther Claude accounts on this machine: ' + accounts.join(', ') + '. `seat: <account> <' + SIZES.join('|') + '> <' + TIERS.join('|') + '>` '
        + 'runs that size\'s Claude model on that account and never leaves it; write it only when the person asks for it.'
      : '')
    + (mixFanouts && others.length > 0
      ? '\nEvery review or verification fan-out mixes model families: beside the Claude agents, add one seat per other family ('
        + others.map(family => '`seat: ' + family + ' <size> reviewer`').join(', ') + '), all in one message.'
      : '')
}
const delegateRules = (setting: Delegate, reason: string | undefined, jobs: readonly string[]): string => {
  if (reason !== undefined) {
    return '\nDelegate mode is on (' + reason + '): code work goes to owner seats. A feature, refactor, bug fix or performance task, '
      + 'a PR owner with its fix rounds, and their helpers go out as `seat: <size> owner' + (jobs.includes(CODE_JOB) ? ' ' + CODE_JOB : '') + '` with `isolation: "worktree"`, the size '
      + 'the task\'s effort maps to (standard when none is named); the mod spreads them across model families by quota. This '
      + 'session keeps the planning, briefs, verdicts, the merges it owns and every reply to the person.'
  }
  return setting === 'auto'
    ? '\nDelegate mode turns on by itself while Claude\'s quota is busy; until then code work stays on Claude unless the person asks to delegate it.'
    : ''
}

async function showDelegate($: EngineInterface, reason: string | undefined): Promise<void> {
  const now = reason ?? ''
  // update retries on a concurrent write, so of prompts composed at once only one sees the change.
  let shown: string | null = now
  await update($, delegateShownState, current => {
    shown = current
    return now
  })
  if (shown === now || (shown === null && now === '')) return
  $.ui.log(now ? 'seat-router: delegate mode is on (' + now + '): code work goes to owner seats.' : 'seat-router: delegate mode is off: code work stays on Claude.')
}

const QUEUE_SCHEMA = {
  type: 'object',
  properties: {
    done: { type: 'integer', minimum: 0 },
    running: { type: 'integer', minimum: 0 },
    pending: { type: 'integer', minimum: 0 },
    label: { type: 'string', maxLength: 80 },
    now: { type: 'string', maxLength: 80 },
  },
  required: ['done', 'running', 'pending'],
  additionalProperties: false,
} as const

let elapsedTick: Timer | undefined

// Seat lines of one message arrive together, before any quota moves: each picks
// its family only after the one before it is counted as running.
let picking: Promise<unknown> = Promise.resolve()
const oneAtATime = <T,>(work: () => Promise<T>): Promise<T> => {
  const turn = picking.then(work)
  // A pick that throws fails its own Agent call (turn rejects there), not the picks queued behind it.
  picking = turn.catch(() => undefined)
  return turn
}
// The engine gives a tool.call hook 10s, then its .catch refuses the call; a pick this late launches nothing.
const LATE_MS = 9_000

const flights = new Map<string, Promise<void>>()
// A failed timer's work is dropped; its next tick runs it again.
const singleFlight = (key: string, work: () => Promise<void>): Promise<void> => {
  const running = flights.get(key)
  if (running) return running
  const started = work().catch(() => undefined).finally(() => { flights.delete(key) })
  flights.set(key, started)
  return started
}

const BAND_EVERY_MS = 10_000
const REFRESH_EVERY_MS = 120_000

function band($: EngineInterface): Promise<void> {
  return singleFlight('band', async () => refreshBand($, await installedVendors($), busyAtSetting()))
}

async function inUse($: EngineInterface): Promise<Candidate[]> {
  const vendors = await installedVendors($)
  const sized = (await Promise.all(SIZES.map(size => sizeCandidates($, size)))).flat()
    .filter(candidate => candidate.vendor === 'claude' || vendors.includes(candidate.vendor as ExternalVendor))
  return [...sized, ...accountNames().flatMap(name => SIZES.map(size => accountCandidate(size, name)))]
}

function refresh($: EngineInterface): Promise<void> {
  return singleFlight('refresh', async () => {
    await refreshQuotas($, await inUse($), await accountDirs($))
    await band($)
  })
}

const isSeat = async ($: EngineInterface): Promise<boolean> => (await $.env.get('SEAT_ROUTER_SEAT')) !== undefined

const isRunning = (status: string): boolean => status === 'running' || status === 'waiting'

const seatCard = (seat: SeatDisplay): Card => ({
  id: seat.id,
  vendor: seat.vendor,
  description: seat.description,
  model: seat.account === undefined ? seat.model : seat.account + ' · ' + seat.model,
  effort: seat.effort,
  status: isRunning(seat.status) ? 'running' : 'done',
  startedAt: seat.startedAt,
  endedAt: seat.endedAt,
  tokens: seat.liveTokens ?? seat.lastTokens,
  steps: seat.steps,
  lastAction: seat.lastAction,
})

const doneDrawings = new Map<string, unknown>()
const drawnOnce = <T,>(kind: string, size: number, card: Card, draw: () => T): T => {
  if (card.status !== 'done' || card.endedAt === undefined) return draw()
  const key = kind + ' ' + size + ' ' + JSON.stringify(card)
  if (doneDrawings.has(key)) return doneDrawings.get(key) as T
  if (doneDrawings.size >= 200) doneDrawings.clear()
  const drawn = draw()
  doneDrawings.set(key, drawn)
  return drawn
}

const batch = (cards: readonly Card[]): QueueDisplay | null => {
  const running = cards.filter(card => card.status === 'running')
  if (running.length === 0) return null
  const start = Math.min(...running.map(card => card.startedAt ?? Number.POSITIVE_INFINITY))
  const done = cards.filter(card => card.status === 'done' && card.endedAt !== undefined && card.endedAt >= start).length
  return { done, running: running.length, pending: 0, label: 'Subagents' }
}

async function isPaneOpen($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE)
}

async function hasRunningSeat($: EngineInterface): Promise<boolean> {
  return (await read($, seatsState)).some(seat => isRunning(seat.status))
}

async function tickElapsed($: EngineInterface): Promise<void> {
  if (await isPaneOpen($) && await hasRunningSeat($)) {
    await update($, seatPaneTickState, tick => tick + 1)
    return
  }
  elapsedTick?.cancel()
  elapsedTick = undefined
}

async function startElapsedTick($: EngineInterface): Promise<void> {
  if (elapsedTick !== undefined || !await hasRunningSeat($) || !await isPaneOpen($)) return
  elapsedTick = $.clock.every(1_000, () => tickElapsed($))
}

async function togglePane($: EngineInterface): Promise<boolean> {
  if (await isPaneOpen($)) {
    await $.ui.close({ id: PANE })
    return false
  }
  await $.ui.open({ id: PANE, title: 'Seats' })
  await startElapsedTick($)
  return true
}

const SIZE_NAME: Record<Size, string> = {
  heavy: 'Heavy tasks (large changes, hard reviews)',
  standard: 'Standard tasks',
  light: 'Light tasks (quick checks, bulk work)',
}

// The question names what Auto runs, since the dialog's options carry labels only.
const sizeQuestion = (size: Size, auto: readonly Candidate[]): string =>
  SIZE_NAME[size] + ': which model goes first? Auto tries ' + auto.map(formatCandidate).join(', then ')
  + ', and follows your CLIs when their models change. Picking a model puts it first, the others after it.'
const AUTO = 'Auto (recommended)'

async function setup($: EngineInterface): Promise<string> {
  const finding = foundAccounts($)
  const models = await cliModels($)
  const lines: string[] = []
  const sizes: Partial<Record<Size, string>> = {}
  let delegate: Delegate | undefined
  let asked = true
  for (const size of ['heavy', 'standard', 'light'] as const) {
    const auto = autoCandidates(size, models)
    let answer: string
    try {
      answer = await $.ui.ask(sizeQuestion(size, auto), { header: size[0]?.toUpperCase() + size.slice(1), options: [AUTO, ...auto.slice(0, 3).map(formatCandidate)] })
    } catch {
      lines.push(size + ' and after: not asked, kept as they were.')
      asked = false
      break
    }
    const chosen = answer === AUTO ? undefined : parseCandidates(answer)[0]
    if (answer !== AUTO && !chosen) {
      lines.push(size + ': kept as it was; "' + answer + '" is not `<codex|agy|claude> <model> [effort]`.')
      continue
    }
    sizes[size] = chosen
      ? [chosen, ...auto.filter(candidate => candidate.vendor !== chosen.vendor || candidate.model !== chosen.model)].map(formatCandidate).join(', ')
      : 'auto'
  }
  if (asked) {
    try {
      const answer = await $.ui.ask(DELEGATE_QUESTION, { header: 'Delegate', options: Object.keys(DELEGATE_ANSWERS) })
      delegate = DELEGATE_ANSWERS[answer]
      if (!delegate) lines.push('delegate: kept as it was; "' + answer + '" is not Auto, On or Off.')
    } catch {
      lines.push('delegate: not asked, kept as it was.')
      asked = false
    }
  }
  const accounts = asked ? await askAccounts($, await finding, lines) : undefined
  const jobs = asked ? await askJobs($, accounts ?? parseAccounts(accountSetting(), jobNames()), lines) : undefined
  const values: Record<string, string> = Object.fromEntries(Object.entries(sizes).map(([size, setting]) => [size + 'Seats', setting]))
  if (delegate) values.delegate = delegate
  if (accounts) values.claudeAccounts = formatAccounts(accounts)
  if (jobs) values.jobs = jobs.setting
  if (Object.keys(values).length === 0) return 'Seat settings:\n' + lines.join('\n')
  const refused = await saveOptions($, values)
  if (refused) return 'Seat settings not saved: ' + refused + '.\n' + lines.join('\n')
  for (const [size, setting] of Object.entries(sizes)) {
    setSize(size as Size, setting)
    lines.push(size + ': ' + setting + '.')
  }
  if (delegate) {
    setDelegate(delegate)
    lines.push('delegate: ' + delegate + '.')
  }
  if (accounts) {
    setAccounts(accounts)
    lines.push('accounts: ' + (formatAccounts(accounts) || 'none') + '.')
  }
  if (jobs) {
    setJobs(jobs)
    lines.push('jobs: ' + (jobs.setting || 'none') + '.')
  }
  return 'Seat settings:\n' + lines.join('\n') + '\nChange them again with /seats setup.'
}

const KEEP_JOBS = 'Keep as is'
const NO_JOBS = 'None'

async function askJobs($: EngineInterface, accounts: Record<string, string>, lines: string[]): Promise<Jobs | undefined> {
  const current = seatJobs().setting
  const question = 'Jobs: a seat line\'s optional last word sends the seat only to models that can do that work. Shipped: '
    + jobWords(SHIPPED_JOBS).map(job => job + ' (' + SHIPPED_JOBS[job]?.description + ')').join(', ') + '. Your jobs now: ' + (current || 'none') + '. '
    + 'Under Other, type `<job> [(<what it is for>)]: <rule>, ...` entries separated by `;`, a rule being only, not or first '
    + 'and a CLI, family, account or model pattern, as in `art (layouts, styling, images, diagrams): only codex, only agy, not claude, first codex`.'
  let answer: string
  try {
    answer = await $.ui.ask(question, { header: 'Jobs', options: [KEEP_JOBS, NO_JOBS] })
  } catch {
    lines.push('jobs: not asked, kept as they were.')
    return undefined
  }
  if (answer.trim() === '' || answer === KEEP_JOBS) return undefined
  const jobs = jobsOf(answer === NO_JOBS ? '' : answer.trim(), accounts)
  if (jobs.problems.length > 0) {
    lines.push('jobs: kept as they were; "' + answer + '" has problems: ' + jobs.problems.join(' '))
    return undefined
  }
  return jobs
}

const NO_ACCOUNTS = 'None'

async function askAccounts($: EngineInterface, found: readonly FoundAccount[], lines: string[]): Promise<Record<string, string> | undefined> {
  const offered = { ...Object.fromEntries(found.filter(account => account.plan !== undefined).map(account => [account.name, account.dir])), ...parseAccounts(accountSetting(), jobNames()) }
  const loggedOut = found.filter(account => account.plan === undefined && !(account.name in offered))
  if (Object.keys(offered).length === 0) return undefined
  const plans = found.filter(account => account.plan !== undefined).map(account => account.dir + ' (' + account.plan + ')')
  const question = 'Other Claude accounts: which may seats run on? A seat line naming one (`seat: <name> standard reviewer`) runs Claude on it.'
    + (plans.length > 0 ? ' Logged in: ' + plans.join(', ') + '.' : '')
    + (loggedOut.length > 0 ? ' Not logged in: ' + loggedOut.map(account => account.dir).join(', ') + '.' : '')
    + ' Under Other, type `<name> <config folder>` entries, comma-separated.'
  let answer: string
  try {
    answer = await $.ui.ask(question, { header: 'Accounts', multiSelect: true, options: [...Object.entries(offered).slice(0, 3).map(([name, dir]) => name + ' ' + dir), NO_ACCOUNTS] })
  } catch {
    lines.push('accounts: not asked, kept as they were.')
    return undefined
  }
  const picked = answer.split(',').map(entry => entry.trim()).filter(entry => entry !== '' && entry !== NO_ACCOUNTS).join(', ')
  const accounts = parseAccounts(picked, jobNames())
  if (picked !== '' && Object.keys(accounts).length === 0) {
    lines.push('accounts: kept as they were; "' + answer + '" is not `<name> <config folder>`.')
    return undefined
  }
  return accounts
}

const DELEGATE_QUESTION = 'Delegate mode: when does code work (features, fixes, PR owners) go to owner seats on your other CLIs? '
  + 'Auto does it while Claude\'s quota is busy; On always; Off never.'
const DELEGATE_ANSWERS: Record<string, Delegate> = { [AUTO]: 'auto', On: 'on', Off: 'off' }

const queueTotal = (queue: QueueDisplay): number => queue.done + queue.running + queue.pending

export const register: Register = (on, options) => {
  const config = seatConfigFrom(options)
  setSeatConfig(config)
  const mixFanouts = options.mixFanouts === true

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (await isSeat($)) return composed
    // A failed note only holds the refresher back until the next prompt.
    void noteComposed($).catch(() => undefined)
    const vendors = await installedVendors($)
    if (vendors.length === 0) return composed
    const sizes = Object.fromEntries(await Promise.all(SIZES.map(async size => [size, await sizeCandidates($, size)] as const))) as Usable
    // A ledger that cannot be read leaves code work on Claude, as an unknown quota does.
    const reason = await delegateReason($, delegateSetting(), busyAtSetting()).catch(() => undefined)
    await showDelegate($, reason)
    const usable = usableOf(vendors, sizes)
    const { policies } = seatJobs()
    const jobs = taughtJobs(usable, policies)
    const text = seatRules(vendors, usable, mixFanouts, accountNames(), jobs, policies) + delegateRules(delegateSetting(), reason, jobs)
    return { sections: [...composed.sections, { id: 'seat-router:loaded', text, scope: 'session' }] }
  })

  // The engine refuses only a plugin's own appended note, never a task notice, so a failed rewrite keeps the notice as it came.
  on('session.append', async ($, e, next) => {
    if (await isSeat($)) return next(e)
    if (e.origin.kind === 'task-notification') {
      const content = await Promise.all(e.message.content.map(async block =>
        block.type === 'text' && typeof block.text === 'string' ? { ...block, text: await correctUnfinishedNotice($, block.text) } : block))
      return next({ ...e, message: { ...e.message, content } })
    }
    const stored = await next(e)
    await answered($, e)
    await sighted($, e)
    return stored
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    if (await isSeat($)) return next(e)
    await $.command.register({ name: 'seats', description: 'Show or hide the seats of this session; `/seats setup` picks the models each size tries first and delegate mode' })
    await $.tool.register({
      name: 'queue',
      description: 'Update autopilot queue progress. Call whenever the autopilot queue changes; set done, running, and pending all to 0 to clear it. '
        + '`now` names the task in progress, a few words.',
      inputSchema: QUEUE_SCHEMA,
      isDeferred: false,
    })
    // Neither holds up the session: a failed prune waits for the next start, and a failed probe writes no
    // answer, so reviewers run the unelevated sandbox.
    void pruneSeats($).catch(() => undefined)
    void probeSandboxes($).catch(() => undefined)
    $.clock.every(5_000, () => singleFlightPoll($))
    void singleFlightPoll($)
    // A failed usage read leaves the account unknown until the refresher reads it.
    void $.session.usage().then(usage => writeSessionQuota($, usage.rateLimits)).catch(() => undefined).then(() => band($))
    $.clock.every(BAND_EVERY_MS, () => band($))
    $.clock.every(REFRESH_EVERY_MS, () => refresh($))
    void refresh($)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (!e.changed.includes('rateLimits') || await isSeat($)) return next(e)
    await writeSessionQuota($, e.rateLimits)
    await band($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'seats' }, async ($, e, next) => {
    if (await isSeat($)) return next(e)
    if (e.args.trim() === 'setup') return { text: await setup($) }
    if (!await togglePane($)) return { text: 'Seats pane closed.' }
    const problems = seatJobs().problems.map(problem => 'Jobs setting: ' + problem)
    return { text: ['Seats pane opened.', await branchProtection($), ...problems, ...await quotaLines($, busyAtSetting()), ...await undeliveredLines($)].join('\n') }
  }).catch(($, e, next) => next.called ? next(e) : { text: 'seat-router could not run /seats.' })

  on('tool.call', { tool: 'mcp__seat-router__queue' }, async ($, e, next) => {
    if (await isSeat($)) return next(e)
    const { done, running, pending } = e
    if (![done, running, pending].every(value => Number.isInteger(value) && value >= 0)) {
      return { deny: 'done, running, and pending must be non-negative integers.' }
    }
    const label = e.label?.trim() || undefined
    const now = e.now?.trim().slice(0, 80) || undefined
    const queue: QueueDisplay | null = done + running + pending === 0
      ? null
      : { done, running, pending, ...(label === undefined ? {} : { label }), ...(now === undefined ? {} : { now }) }
    await update($, queueState, () => queue)
    const text = queue === null ? 'Autopilot queue cleared.' : 'Autopilot queue: ' + done + ' done, ' + running + ' running, ' + pending + ' pending.'
    return { result: text }
  }).catch(() => ({ deny: 'seat-router could not update the queue.' }))

  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    if (await isSeat($)) return next(e)
    const stopped = await stopTask($, e.task_id ?? e.shell_id)
    return stopped ? { result: stopped } : next(e)
  }).catch(($, e, next) => {
    const id = e.task_id ?? e.shell_id ?? ''
    if (next.called || !isSeatId(id)) return next(e)
    return { deny: 'seat-router could not stop ' + id + '; see /seats.' }
  })

  on('turn.complete', async ($, e, next) => {
    const ended = await next(e)
    if (!await isSeat($)) await turnEnded($, e)
    return ended
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' && !await isSeat($)) noteClear(e.sessionId)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (await isSeat($)) return next(e)
    const parsed = parseSeatLine(e.prompt)
    if (parsed.kind === 'none') return next(e)
    if (parsed.kind === 'refused') return { deny: parsed.reason }
    const marker = parsed.marker
    const deadline = await $.clock.now() + LATE_MS
    const seat = await oneAtATime(async () => {
      const set = await seatCandidates($, marker)
      if (set.kind === 'empty') return 'seat-router refused this seat: ' + set.reason
      const initial = await decide($, marker, set, {
        busyAt: busyAtSetting(), accounts: await accountDirs($), installed: ['claude', ...await installedVendors($)],
      })
      return typeof initial === 'string' ? initial : startSeat($, e, marker, initial, deadline)
    })
    if (typeof seat === 'string') return { deny: seat }
    // An answer given after the dispatch was aborted reaches no conversation.
    if (next.signal.aborted) {
      await unanswered($, e.tool_use_id, seat.id)
      return { deny: 'seat-router did not start this seat: the call was cancelled.' }
    }
    void startElapsedTick($)
    return {
      result: {
        status: 'async_launched', agentId: seat.id, description: e.description, resolvedModel: seat.model, prompt: e.prompt,
        outputFile: seat.dir + '/report.md', canReadOutputFile: true, canContinueAgent: false,
      },
    }
  }).catch(async ($, e, next) => {
    if (next.called) return next(e)
    await unanswered($, e.tool_use_id)
    const why = next.error.message?.replace(/^\w*Error: /, '') ?? next.error.kind
    return { deny: 'seat-router could not start this seat (' + why + '), so nothing runs for this call.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || await isSeat($)) return next(e)
    // Other mods' bands go beneath ours; the engine's placeholder ({ type: 'engine' }) is never nested.
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null
    const [quotas, queue, seats, vendors] = await Promise.all([read($, quotasState), read($, queueState), read($, seatsState), read($, vendorsState)])
    const shown: readonly SeatVendor[] = vendors ? ['claude', ...vendors] : VENDORS
    const cards = seats.map(seatCard)
    const count = cards.filter(card => card.status === 'running').length
    const progress = queue ?? batch(cards)
    const hasRow = progress !== null
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const seatsButton = count > 0 && <Button key="seats" label={'×' + count} plain onPress={() => void togglePane($)} />
    const nowLine = queue?.now ? <Text dimColor wrap="truncate-end">Now: {queue.now}</Text> : null

    // The terminal's element table carries an `Svg` that draws nothing: test the surface too.
    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const width = Math.max(180, Math.min(1600, (e.props.bodyColumns || 100) * 8 - 60))
      const alt = progress
        ? (progress.label ?? 'Autopilot queue') + ': tasks ' + progress.done + '/' + queueTotal(progress) + ', ' + plural(count, 'seat') + ' running'
        : plural(count, 'seat') + ' running'
      return (
        <Box flexDirection="column">
          {hasRow && (
            <Box flexDirection="row" alignItems="center" gap={1}>
              <ui.Svg source={rowSvg(progress, count, width)} alt={alt} width={width} height={ROW_H} />
              {seatsButton}
            </Box>
          )}
          {nowLine}
          <ui.Svg source={quotaSvg(quotas, shown)} alt={quotaAlt(quotas, shown)} width={quotaWidth(quotas, shown)} height={QUOTA_H} />
          {below}
        </Box>
      )
    }

    // The terminal: the same art in cells. The ×N Button stays beside it, a Raster cannot be pressed.
    if (!('Raster' in ui)) return <Box flexDirection="column">{below}</Box>
    const columns = Math.max(20, e.props.bodyColumns)
    const quota = quotaRaster(quotas, shown, columns)
    const row = hasRow ? queueRaster(progress, count, Math.max(16, columns - (count > 0 ? ('×' + count).length + 5 : 0))) : null
    return (
      <Box flexDirection="column">
        {row && (
          <Box flexDirection="row" gap={1}>
            <ui.Raster key="queue" cells={row.cells} columns={row.columns} rows={row.rows} />
            {seatsButton}
          </Box>
        )}
        {nowLine}
        <ui.Raster key="quota" cells={quota.cells} columns={quota.columns} rows={quota.rows} />
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (await isSeat($)) return next(e)
    await read($, seatPaneTickState)
    const [seats, panel, now] = await Promise.all([read($, seatsState), read($, seatPanelState), $.clock.now()])
    const cards = seats.map(seatCard)
      .sort((a, b) => (b.startedAt ?? -1) - (a.startedAt ?? -1))
    const running = cards.filter(card => card.status === 'running')
    const done = cards.filter(card => card.status === 'done')
    const shownDone = panel.isDoneCollapsed ? [] : done
    const summary = totals(cards, now)
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const doneToggle = done.length > 0 && (
      <Button
        key="done"
        label={(panel.isDoneCollapsed ? '▸' : '▾') + ' Done · ' + done.length}
        plain
        onPress={() => update($, seatPanelState, current => ({ ...current, isDoneCollapsed: !current.isDoneCollapsed }))}
      />
    )
    const empty = cards.length === 0 && <Text dimColor>No seats yet.</Text>

    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const width = Math.max(240, Math.min(900, (e.props.bodyColumns || 40) * 8 - 8))
      const height = HEADER_H + (running.length ? SECTION_H : 0) + (done.length ? LINE_H : 0) + (cards.length ? 0 : LINE_H)
        + (running.length + shownDone.length) * CARD_H
      const card = (item: Card) => (
        <ui.Svg
          key={item.id}
          source={drawnOnce('svg', width, item, () => cardSvg(width, item, now))}
          alt={item.description + ': ' + item.vendor + ' ' + item.model + ', ' + stepLine(item)}
          width={width}
          height={CARD_H}
        />
      )
      return (
        <Box flexDirection="column">
          {/* The grid sizes the pane; the content is laid over it, as an absolute Box paints over what precedes it. */}
          {gridTiles(height).map((tile, index) => (
            <ui.Svg key={'grid-' + index} source={gridSvg(width, tile)} alt="dotted grid" width={width} height={tile} />
          ))}
          <Box flexDirection="column" position="absolute" top={0} left={0} right={0}>
            <ui.Svg
              source={headerSvg(width, summary)}
              alt={plural(cards.length, 'seat') + ', ' + fmtTokens(summary.tokens) + ' tokens, ' + fmtTime(summary.time)}
              width={width}
              height={HEADER_H}
            />
            {empty}
            {running.length > 0 && <ui.Svg source={runningSvg(width, running.length)} alt={'Running · ' + running.length} width={width} height={SECTION_H} />}
            {running.map(card)}
            {doneToggle}
            {shownDone.map(card)}
          </Box>
        </Box>
      )
    }

    if (!('Raster' in ui)) return <Box />
    const columns = Math.max(20, e.props.bodyColumns)
    const raster = (key: string, drawing: Drawing) => (
      <ui.Raster key={key} cells={drawing.cells} columns={drawing.columns} rows={drawing.rows} />
    )
    const card = (item: Card) => raster(item.id, drawnOnce('raster', columns, item, () => cardRaster(item, now, columns)))
    return (
      <Box flexDirection="column">
        {raster('header', headerRaster(summary, columns))}
        {empty}
        {running.length > 0 && raster('running', runningRaster(running.length, columns))}
        {running.map(card)}
        {doneToggle}
        {shownDone.map(card)}
      </Box>
    )
  })
}
