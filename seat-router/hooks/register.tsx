// Adapted from savvy-progress by johnnyvizz; see ../NOTICE.md.
import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register, Timer } from 'claude-code'
import type { ClaudeSeatDisplay, QueueDisplay, SeatDisplay, SeatVendor } from '../types/index'
import {
  CARD_H, HEADER_H, LINE_H, QUOTA_H, ROW_H, SECTION_H, VENDORS,
  cardSvg, fmtTime, fmtTokens, gridSvg, gridTiles, headerSvg, plural, quotaAlt, quotaSvg, quotaWidth,
  rowSvg, runningSvg, stepLine, totals,
} from './art'
import type { Card } from './art'
import { cardRaster, headerRaster, queueRaster, quotaRaster, runningRaster } from './raster'
import type { Drawing } from './raster'
import { autoCandidates, familyOf, formatCandidate, parseAccounts, parseCandidates, SIZES } from './chain'
import type { Candidate, Family, Size } from './chain'
import {
  accountNames, accountSetting, chooseInitial, claudeBrief, cliModels, delegateOf, delegateReason, delegateSetting, formatAccounts, foundAccounts, installedVendors, isRotating, ownerGuardReason, parseMarker, runningFamilies,
  saveOptions, seatConfigFrom, setAccounts, setDelegate, setSeatConfig, setSize, SHELL_TOOLS, sizeCandidates, probeCodexSandbox, pruneSeats, singleFlightPoll, singleFlightQuotaRefresh, startExternal, stopSeat,
} from './router'
import type { Delegate, ExternalVendor, FoundAccount } from './router'

const seatsState = atom({ plugin: 'seat-router', key: 'seats' } as const, [], { shape: 'seat-display-3' })
const quotasState = atom({ plugin: 'seat-router', key: 'quotas' } as const, {}, { shape: 'quota-windows-1' })
const queueState = atom({ plugin: 'seat-router', key: 'queue' } as const, null)
const vendorsState = atom({ plugin: 'seat-router', key: 'vendors' } as const, null, { shape: 'installed-vendors-1' })
const claudeSeatsState = atom({ plugin: 'seat-router', key: 'claudeSeats' } as const, [], { shape: 'claude-seat-display-2' })
const seatPaneTickState = atom({ plugin: 'seat-router', key: 'seatPaneTick' } as const, 0)
const seatPanelState = atom({ plugin: 'seat-router', key: 'seatPanel' } as const, { isDoneCollapsed: false })

const PANE = 'seats'

// The seat rules, naming only the CLIs this machine has and the candidates they serve.
const seatRules = (vendors: readonly ExternalVendor[], sizes: Record<Size, Candidate[]>, mixFanouts: boolean, accounts: readonly string[]): string => {
  const usable = (size: Size) => sizes[size].filter(candidate => candidate.vendor === 'claude' || vendors.includes(candidate.vendor as ExternalVendor))
  const others = [...new Set(SIZES.flatMap(size => usable(size).map(familyOf)))].filter((family): family is Exclude<Family, 'claude' | 'other'> => family !== 'claude' && family !== 'other')
  return 'The seat-router mod is loaded: an Agent call whose prompt starts with a seat line runs on another CLI ('
    + vendors.join(', ') + '), and its report arrives later as a message from the seat-router plugin. A seat line is either '
    + '`seat: [<cli or family>] <light|standard|heavy> <reviewer|owner>`, where the mod picks the model of that size by '
    + 'quota, keeping to the named CLI (' + vendors.join('|') + ') or model family (claude|gpt|gemini) unless all of it is out, or '
    + '`seat: <' + vendors.join('|') + '> <model> <effort> <reviewer|owner>`, which runs exactly that model. A task that names an '
    + 'effort maps to a size: low or medium is light, high is standard, xhigh or max is heavy. Sizes, in the order tried: '
    + SIZES.map(size => size + ' = ' + usable(size).map(formatCandidate).join(', ')).join('; ') + '.\n'
    + 'A seat is a fresh context: it sees only its brief and its folder, so the brief carries '
    + 'the task, the grounding it cannot read from its folder, and its output format. Tier `owner` is for a seat that '
    + 'commits, pushes, opens or merges a PR, or needs the network or tools outside its folder (Docker, a database); it may '
    + 'leave its CLI\'s sandbox, and its report names the branch it leaves, its worktree removed. Every other seat is '
    + '`reviewer`: it reports and does not commit. Pass `isolation: "worktree"` whenever the seat reads or changes this '
    + 'repository, a review included: without it the seat starts in an empty folder and sees only the absolute paths its '
    + 'brief names. A seat '
    + 'cannot be continued: give follow-up work to a fresh seat with the whole scope. The mod falls back along the size\'s '
    + 'candidates; when a report says no CLI could take the seat, start the Agent it asks for yourself, in that turn.'
    + (accounts.length > 0
      ? '\nOther Claude accounts on this machine: ' + accounts.join(', ') + '. `seat: <account> <light|standard|heavy> <reviewer|owner>` '
        + 'runs that size\'s Claude model on that account, only when the person asks for it; it moves to the size\'s other candidates '
        + 'only when the account is out of quota.'
      : '')
    + (mixFanouts && others.length > 0
      ? '\nEvery review or verification fan-out mixes model families: beside the Claude agents, add one seat per other family ('
        + others.map(family => '`seat: ' + family + ' <size> reviewer`').join(', ') + '), all in one message.'
      : '')
}
// When code work goes to owner seats: always (`on`), never (`off`), or while Claude's quota is busy (`auto`).
const delegateRules = (setting: Delegate, reason: string | undefined): string => {
  if (reason !== undefined) {
    return '\nDelegate mode is on (' + reason + '): code work goes to owner seats. A feature, refactor, bug fix or performance task, '
      + 'a PR owner with its fix rounds, and their helpers go out as `seat: <size> owner` with `isolation: "worktree"`, the size '
      + 'the task\'s effort maps to (standard when none is named); the mod spreads them across model families by quota. This '
      + 'session keeps the planning, briefs, verdicts, the merges it owns and every reply to the person. Say when delegate mode '
      + 'turns on and why.'
  }
  return setting === 'auto'
    ? '\nDelegate mode turns on by itself while Claude\'s quota is busy; until then code work stays on Claude unless the person asks to delegate it.'
    : ''
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

const STOP_SCHEMA = {
  type: 'object',
  properties: { id: { type: 'string', pattern: '^seat-\\w+$' } },
  required: ['id'],
  additionalProperties: false,
} as const

let elapsedTick: Timer | undefined

// Seat lines of one message arrive together, before any quota moves: each picks
// its family only after the one before it is counted as running.
let picking: Promise<unknown> = Promise.resolve()
const oneAtATime = <T,>(work: () => Promise<T>): Promise<T> => {
  const turn = picking.then(work)
  picking = turn.catch(() => undefined)
  return turn
}
// Claude seats handed to the session, which $.agent.list may not show for a moment.
const CLAUDE_PICK_MS = 60_000
// The engine skips a tool.call hook after 10s; a pick this late launches nothing.
const LATE_MS = 9_000
// Owner seats handed to Claude: their Agent calls until spawned, then the subagents,
// whose shell commands pass the same owner guard as codex and agy owners.
const ownerCalls = new Set<string>()
const claudeOwners = new Set<string>()
let claudePicks: number[] = []

const isRunning = (status: string): boolean => status === 'running' || status === 'waiting'

const externalCard = (seat: SeatDisplay): Card => ({
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

const claudeCard = (agent: AgentInfo, seat: ClaudeSeatDisplay | undefined): Card => ({
  id: agent.id,
  vendor: 'claude',
  description: agent.description || agent.type || 'Claude subagent',
  model: seat?.model ?? agent.type ?? 'claude',
  effort: seat?.effort ?? '',
  status: isRunning(agent.status) ? 'running' : 'done',
  startedAt: seat?.startedAt,
  endedAt: seat?.endedAt,
  tokens: seat?.tokens,
  steps: seat?.steps ?? 0,
})

// The engine drops a finished subagent from agent.list a while after it ends; the
// seat's own record keeps its card in the pane.
const claudeCards = (agents: readonly AgentInfo[], seats: readonly ClaudeSeatDisplay[]): Card[] => {
  const known = new Map(seats.map(seat => [seat.id, seat]))
  const listed = new Set(agents.map(agent => agent.id))
  const dropped = seats.filter(seat => !listed.has(seat.id) && seat.endedAt !== undefined).map((seat): Card => ({
    id: seat.id,
    vendor: 'claude',
    description: seat.description || 'Claude subagent',
    model: seat.model ?? 'claude',
    effort: seat.effort ?? '',
    status: 'done',
    startedAt: seat.startedAt,
    endedAt: seat.endedAt,
    tokens: seat.tokens,
    steps: seat.steps,
  }))
  return [...agents.map(agent => claudeCard(agent, known.get(agent.id))), ...dropped]
}

// The subagents running now and those that finished while any of them ran:
// the batch the band's Tasks bar counts. Null while none runs.
const batch = (cards: readonly Card[]): QueueDisplay | null => {
  const running = cards.filter(card => card.status === 'running')
  if (running.length === 0) return null
  const start = Math.min(...running.map(card => card.startedAt ?? Number.POSITIVE_INFINITY))
  const done = cards.filter(card => card.status === 'done' && card.endedAt !== undefined && card.endedAt >= start).length
  return { done, running: running.length, pending: 0, label: 'Subagents' }
}

const usageTokens = (usage: { input_tokens: number, output_tokens: number, cache_read_input_tokens: number, cache_creation_input_tokens: number }): number =>
  usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens

function recordClaudeSeat($: EngineInterface, id: string, startedAt: number, change: (current: ClaudeSeatDisplay | undefined) => Partial<ClaudeSeatDisplay>): Promise<ClaudeSeatDisplay[]> {
  return update($, claudeSeatsState, seats => {
    const current = seats.find(seat => seat.id === id)
    const next = { id, startedAt, steps: 0, ...current, ...change(current) }
    return [...seats.filter(seat => seat.id !== id), next]
  })
}

async function isPaneOpen($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE)
}

async function hasRunningSeat($: EngineInterface): Promise<boolean> {
  if ((await read($, seatsState)).some(seat => isRunning(seat.status))) return true
  return (await $.agent.list()).some(agent => isRunning(agent.status))
}

// Elapsed times redraw once a second, only while the pane is open and something runs.
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

// Asks, size by size, which model goes first, offering the auto candidates the CLIs
// report, then the delegate mode, and saves every answer at once.
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
  const values: Record<string, string> = Object.fromEntries(Object.entries(sizes).map(([size, setting]) => [size + 'Seats', setting]))
  if (delegate) values.delegate = delegate
  if (accounts) values.claudeAccounts = formatAccounts(accounts)
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
  return 'Seat settings:\n' + lines.join('\n') + '\nChange them again with /seats setup.'
}

const NO_ACCOUNTS = 'None'

// Offers the other Claude accounts already set and the logged-in config folders
// found in the home folder (searched while the other questions are asked); asks nothing when there are neither. Returns the
// accounts to save, or undefined to keep the setting.
async function askAccounts($: EngineInterface, found: readonly FoundAccount[], lines: string[]): Promise<Record<string, string> | undefined> {
  const offered = { ...Object.fromEntries(found.filter(account => account.plan !== undefined).map(account => [account.name, account.dir])), ...parseAccounts(accountSetting()) }
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
  const accounts = parseAccounts(picked)
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
    const vendors = await installedVendors($)
    if (vendors.length === 0) return composed
    const sizes = Object.fromEntries(await Promise.all(SIZES.map(async size => [size, await sizeCandidates($, size)] as const))) as Record<Size, Candidate[]>
    const text = seatRules(vendors, sizes, mixFanouts, accountNames()) + delegateRules(delegateSetting(), await delegateReason($))
    return { sections: [...composed.sections, { id: 'seat-router:loaded', text, scope: 'session' }] }
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'seats', description: 'Show or hide the seats of this session; `/seats setup` picks the models each size tries first and delegate mode' })
    await $.tool.register({
      name: 'queue',
      description: 'Update autopilot queue progress. Call whenever the autopilot queue changes; set done, running, and pending all to 0 to clear it. '
        + '`now` names the task in progress, a few words.',
      inputSchema: QUEUE_SCHEMA,
      isDeferred: false,
    })
    await $.tool.register({
      name: 'stop',
      description: 'Stop a codex or agy seat of this session that is still running or waiting: ends its CLI and everything it started, '
        + 'and reports the seat stopped. `id` is the seat id (seat-XXXXXX) its Agent call returned. TaskStop cannot stop seats.',
      inputSchema: STOP_SCHEMA,
      isDeferred: false,
    })
    void pruneSeats($).catch(() => undefined)
    void probeCodexSandbox($).catch(() => undefined)
    $.clock.every(5_000, () => singleFlightPoll($))
    void singleFlightPoll($)
    $.clock.every(120_000, () => singleFlightQuotaRefresh($))
    void singleFlightQuotaRefresh($)
    return next(e)
  })

  on('command.run', { command: 'seats' }, async ($, e) => {
    if (e.args.trim() === 'setup') return { text: await setup($) }
    return { text: await togglePane($) ? 'Seats pane opened.' : 'Seats pane closed.' }
  })

  on('tool.call', { tool: 'mcp__seat-router__queue' }, async ($, e) => {
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
  })

  on('tool.call', { tool: 'mcp__seat-router__stop' }, async ($, e) => ({ result: await stopSeat($, e.id) }))

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const marker = parseMarker(e.prompt)
    if (!marker) return next(e)
    const began = await $.clock.now()
    const picked = await oneAtATime(async () => {
      const now = await $.clock.now()
      claudePicks = claudePicks.filter(at => now - at < CLAUDE_PICK_MS)
      const rotating = isRotating(marker)
      const listed = rotating ? (await $.agent.list()).filter(agent => isRunning(agent.status)).length : 0
      const initial = await chooseInitial($, marker, rotating ? await runningFamilies($, Math.max(listed, claudePicks.length)) : {})
      // Past the engine's tool.call budget the Agent already ran as a plain subagent: a seat would run the task twice.
      if ((await $.clock.now()) - began >= LATE_MS) return { kind: 'late' as const }
      const chosen = initial.allOut ? undefined : initial.chain[initial.position ?? 0]
      if (chosen?.vendor === 'claude' && chosen.account === undefined) {
        claudePicks.push(now)
        return { kind: 'claude' as const, claude: chosen, initial }
      }
      return { kind: 'external' as const, seat: await startExternal($, e, marker, initial) }
    })
    if (picked.kind === 'late') return next(e)
    if (picked.kind === 'claude') {
      const { claude, initial } = picked
      if (marker.tier === 'owner' && e.tool_use_id) ownerCalls.add(e.tool_use_id)
      return next({
        ...e, prompt: claudeBrief(marker.brief, initial.trail), model: claude.model as typeof e.model,
        ...(claude.effort ? { effort: claude.effort as typeof e.effort } : {}),
      })
    }
    const seat = picked.seat
    void startElapsedTick($)
    return {
      result: {
        status: 'async_launched', agentId: seat.id, description: e.description, resolvedModel: seat.model, prompt: e.prompt,
        outputFile: seat.dir + '/report.md', canReadOutputFile: true, canContinueAgent: false,
      },
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (ownerCalls.delete(e.tool_use_id) && spawned.agentId) claudeOwners.add(spawned.agentId)
    if (spawned.agentId) await recordClaudeSeat($, spawned.agentId, await $.clock.now(), () => ({ description: e.description }))
    return spawned
  })

  on('tool.check', async ($, e, next) => {
    const command = (e.input as { command?: unknown } | null)?.command
    if (e.agentId !== undefined && claudeOwners.has(e.agentId) && SHELL_TOOLS.includes(e.tool) && typeof command === 'string') {
      const reason = await ownerGuardReason($, command)
      if (reason) return { decision: 'deny', reason }
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      await recordClaudeSeat($, e.agentId, await $.clock.now(), () => ({}))
      void startElapsedTick($)
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      const effort = typeof e.effort === 'string' ? { effort: e.effort } : {}
      await recordClaudeSeat($, e.agentId, await $.clock.now(), current => ({ model: e.model, ...effort, steps: (current?.steps ?? 0) + 1 }))
      void startElapsedTick($)
    }
    const result = yield* next(e)
    // Each step's usage is counted as it lands, so a running subagent shows its tokens.
    const usage = result.usage
    if (e.agentId !== undefined && usage) {
      await recordClaudeSeat($, e.agentId, await $.clock.now(), current => ({ tokens: (current?.tokens ?? 0) + usageTokens(usage) }))
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    if (e.agentId === undefined) return completed
    const now = await $.clock.now()
    const tokens = e.usage === undefined ? undefined : usageTokens(e.usage)
    await recordClaudeSeat($, e.agentId, now - e.durationMs, current => ({
      endedAt: now,
      ...(e.usage?.model === undefined ? {} : { model: e.usage.model }),
      ...(tokens === undefined || current?.tokens !== undefined ? {} : { tokens }),
    }))
    return completed
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    // Other mods' bands go beneath ours; the engine's placeholder ({ type: 'engine' }) is never nested.
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null
    const [quotas, queue, seats, vendors, claudeSeats, agents] = await Promise.all([
      read($, quotasState), read($, queueState), read($, seatsState), read($, vendorsState), read($, claudeSeatsState), $.agent.list(),
    ])
    // Every vendor until the CLIs were asked for, then Claude and the installed ones.
    const shown: readonly SeatVendor[] = vendors ? ['claude', ...vendors] : VENDORS
    // The pane's cards: codex and agy seats, and Claude subagents.
    const cards = [...seats.map(externalCard), ...claudeCards(agents, claudeSeats)]
    const count = cards.filter(card => card.status === 'running').length
    // An autopilot queue reports its own tasks; otherwise the tasks are the batch running now.
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
          <ui.Svg source={quotaSvg(quotas, shown)} alt={quotaAlt(quotas, shown)} width={quotaWidth(shown)} height={QUOTA_H} />
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

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    await read($, seatPaneTickState)
    const [seats, claudeSeats, agents, panel, now] = await Promise.all([
      read($, seatsState), read($, claudeSeatsState), $.agent.list(), read($, seatPanelState), $.clock.now(),
    ])
    const cards = [...seats.map(externalCard), ...claudeCards(agents, claudeSeats)]
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
          source={cardSvg(width, item, now)}
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
    const card = (item: Card) => raster(item.id, cardRaster(item, now, columns))
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
