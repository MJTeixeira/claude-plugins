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
import { autoCandidates, familyOf, formatCandidate, parseCandidates, SIZES } from './chain'
import type { Candidate, Family, Size } from './chain'
import {
  chooseInitial, claudeBrief, cliModels, installedVendors, parseMarker, seatConfigFrom, setSeatConfig, setSize, sizeCandidates,
  singleFlightPoll, singleFlightQuotaRefresh, startExternal,
} from './router'
import type { ExternalVendor } from './router'

const seatsState = atom({ plugin: 'seat-router', key: 'seats' } as const, [], { shape: 'seat-display-3' })
const quotasState = atom({ plugin: 'seat-router', key: 'quotas' } as const, {}, { shape: 'quota-windows-1' })
const queueState = atom({ plugin: 'seat-router', key: 'queue' } as const, null)
const vendorsState = atom({ plugin: 'seat-router', key: 'vendors' } as const, null, { shape: 'installed-vendors-1' })
const claudeSeatsState = atom({ plugin: 'seat-router', key: 'claudeSeats' } as const, [], { shape: 'claude-seat-display-2' })
const seatPaneTickState = atom({ plugin: 'seat-router', key: 'seatPaneTick' } as const, 0)
const seatPanelState = atom({ plugin: 'seat-router', key: 'seatPanel' } as const, { isDoneCollapsed: false })

const PANE = 'seats'

// The seat rules, naming only the CLIs this machine has and the candidates they serve.
const seatRules = (vendors: readonly ExternalVendor[], sizes: Record<Size, Candidate[]>, mixFanouts: boolean): string => {
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
    + 'commits, pushes, opens or merges a PR, or needs the network; every other seat is `reviewer`, sandboxed to its '
    + 'folder with no network and no .git writes. Pass `isolation: "worktree"` when the seat works on code. A seat '
    + 'cannot be continued: give follow-up work to a fresh seat with the whole scope. The mod falls back along the size\'s '
    + 'candidates; when a report says no CLI could take the seat, start the Agent it asks for yourself, in that turn.'
    + (mixFanouts && others.length > 0
      ? '\nEvery review or verification fan-out mixes model families: beside the Claude agents, add one seat per other family ('
        + others.map(family => '`seat: ' + family + ' <size> reviewer`').join(', ') + '), all in one message.'
      : '')
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

const isRunning = (status: string): boolean => status === 'running' || status === 'waiting'

const externalCard = (seat: SeatDisplay): Card => ({
  id: seat.id,
  vendor: seat.vendor,
  description: seat.description,
  model: seat.model,
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

const SIZE_QUESTION: Record<Size, string> = {
  heavy: 'Heavy tasks (large changes, hard reviews): which model goes first?',
  standard: 'Standard tasks: which model goes first?',
  light: 'Light tasks (quick checks, bulk work): which model goes first?',
}
const AUTO = 'Auto (recommended)'

// Asks, size by size, which model goes first, offering the auto candidates the CLIs report, and stores each answer.
async function setup($: EngineInterface): Promise<string> {
  const models = await cliModels($)
  const rows = await $.config.list()
  const lines: string[] = []
  for (const size of ['heavy', 'standard', 'light'] as const) {
    const auto = autoCandidates(size, models)
    let answer: string
    try {
      answer = await $.ui.ask(SIZE_QUESTION[size], { header: size[0]?.toUpperCase() + size.slice(1), options: [AUTO, ...auto.slice(0, 3).map(formatCandidate)] })
    } catch {
      lines.push(size + ' and after: not asked, kept as they were.')
      break
    }
    const chosen = answer === AUTO ? undefined : parseCandidates(answer)[0]
    if (answer !== AUTO && !chosen) {
      lines.push(size + ': kept as it was; "' + answer + '" is not `<codex|agy|claude> <model> [effort]`.')
      continue
    }
    const setting = chosen
      ? [chosen, ...auto.filter(candidate => candidate.vendor !== chosen.vendor || candidate.model !== chosen.model)].map(formatCandidate).join(', ')
      : 'auto'
    const row = rows.find(item => item.key.startsWith('seat-router') && item.key.endsWith('.' + size + 'Seats'))
    const written = row ? await $.config.set({ key: row.key, value: setting }) : { deny: 'no setting row' }
    if ('deny' in written && written.deny) {
      lines.push(size + ': not saved (' + written.deny + ').')
      continue
    }
    setSize(size, setting)
    lines.push(size + ': ' + setting + '.')
  }
  return 'Seat sizes:\n' + lines.join('\n') + '\nChange them again with /seats setup, or in /config.'
}

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
    return { sections: [...composed.sections, { id: 'seat-router:loaded', text: seatRules(vendors, sizes, mixFanouts), scope: 'session' }] }
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'seats', description: 'Show or hide the seats of this session; `/seats setup` picks the models each size tries first' })
    await $.tool.register({
      name: 'queue',
      description: 'Update autopilot queue progress. Call whenever the autopilot queue changes; set done, running, and pending all to 0 to clear it. '
        + '`now` names the task in progress, a few words.',
      inputSchema: QUEUE_SCHEMA,
      isDeferred: false,
    })
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

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const marker = parseMarker(e.prompt)
    if (!marker) return next(e)
    const initial = await chooseInitial($, marker)
    const chosen = initial.allOut ? undefined : initial.chain[initial.position ?? 0]
    if (chosen?.vendor === 'claude') {
      return next({
        ...e, prompt: claudeBrief(marker.brief, initial.trail), model: chosen.model as typeof e.model,
        ...(chosen.effort ? { effort: chosen.effort as typeof e.effort } : {}),
      })
    }
    const seat = await startExternal($, e, marker, initial)
    void startElapsedTick($)
    return {
      result: {
        status: 'async_launched', agentId: seat.id, description: e.description, resolvedModel: seat.model, prompt: e.prompt,
        outputFile: seat.dir + '/report.md', canReadOutputFile: true, canContinueAgent: false,
      },
    }
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
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    if (e.agentId === undefined) return completed
    const now = await $.clock.now()
    const tokens = e.usage === undefined ? undefined : usageTokens(e.usage)
    await recordClaudeSeat($, e.agentId, now - e.durationMs, current => ({
      endedAt: now,
      ...(e.usage?.model === undefined ? {} : { model: e.usage.model }),
      ...(tokens === undefined ? {} : { tokens: (current?.tokens ?? 0) + tokens }),
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
    const known = new Map(claudeSeats.map(seat => [seat.id, seat]))
    const cards = [...seats.map(externalCard), ...agents.map(agent => claudeCard(agent, known.get(agent.id)))]
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
    const known = new Map(claudeSeats.map(seat => [seat.id, seat]))
    const cards = [...seats.map(externalCard), ...agents.map(agent => claudeCard(agent, known.get(agent.id)))]
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
