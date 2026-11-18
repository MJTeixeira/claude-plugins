import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register, RenderChildren, Timer, UiOpenResult } from 'claude-code'
import type { Card, CardKind, Conduit, Mode, Row, Turn } from '../types/index'
import { IDLE, STOP_WORDS, released, sendsOnTurns, transition } from './machine'
import type { Event } from './machine'
import { ack, askedKind, batchOf, buildDigest, EMPTY, keep, reset, row, toolLine } from './digest'
import type { DigestKind } from './digest'
import { looksLikeCards, parseDelivery } from './cards'
import { FLARE_MS, lensRaster, lensSvg, stateOf, THINK_MS } from './lens'

const conduitState = atom({ plugin: 'conduit', key: 'conduit' } as const, IDLE, { shape: 'conduit-3' })
const keptState = atom({ plugin: 'conduit', key: 'kept' } as const, EMPTY, { shape: 'kept-2' })
const tickState = atom({ plugin: 'conduit', key: 'tick' } as const, 0)

const PLUGIN = 'conduit'
const PANE = 'conduit'
const TICK_MS = 400
const CONSUMED = { consumed: 'conduit card from the paired companion' }

/** How long a prompt digest waits; a turn that ends sooner carries the prompt in its own digest. */
const PROMPT_HOLD_MS = 20_000

type Settings = {
  peer: string
  startPaired: boolean
  mode: 'on-call' | 'watch'
  cap: number
  permissions: 'stop' | 'approve'
  promptDigest: boolean
}

const settingsOf = (options: Record<string, unknown>): Settings => ({
  peer: typeof options.peer === 'string' ? options.peer.trim() : '',
  startPaired: options.startPaired === true,
  mode: options.mode === 'watch' ? 'watch' : 'on-call',
  cap: typeof options.autopilotTurns === 'number' && options.autopilotTurns >= 0 ? Math.floor(options.autopilotTurns) : 20,
  permissions: options.autopilotPermissions === 'approve' ? 'approve' : 'stop',
  promptDigest: options.promptDigest !== false,
})

/** A command's reply; the engine names the plugin before it. */
const said = (text: string): { text: string } => ({ text })

/**
 * The person's own prompt: Enter at the terminal (`composer`), the phone or
 * web client (`bridge`), an SDK host's own turn such as the desktop app
 * (`sdk`). Never a peer, a notification, a schedule or another plugin.
 */
const isPersons = (origin: PromptOrigin | undefined): boolean =>
  origin?.kind === 'composer' || origin?.kind === 'bridge' || origin?.kind === 'sdk'

/** What the companion reads as the user's prompt: the person's own, and what conduit submitted as the user (Send next, autopilot). */
const isUsers = (origin: PromptOrigin | undefined): boolean =>
  isPersons(origin) || (origin?.kind === 'plugin' && origin.name === PLUGIN && origin.asUser === true)

const USAGE = 'Usage: /conduit on [peer] · off · on-call · watch · autopilot · ask [question]'

export const titleOf = (unread: number): string => unread > 0 ? 'conduit (' + unread + ')' : 'conduit'

const LABEL: Record<CardKind, string> = { suggest: 'SUGGEST', note: 'NOTE', ask: 'ASK', prompt: 'PROMPT' }

const clockTime = (ms: number): string => {
  const at = new Date(ms)
  return String(at.getHours()).padStart(2, '0') + ':' + String(at.getMinutes()).padStart(2, '0')
}

const randomToken = (): string => 'cd' + (crypto.getRandomValues(new Uint32Array(1))[0]! % 36 ** 6).toString(36).padStart(6, '0')

/** Applies an event; resolves to the state it met and the state it made. */
async function stepped($: EngineInterface, event: Event): Promise<{ before: Conduit, after: Conduit }> {
  let before = IDLE
  let after = IDLE
  await update($, conduitState, s => {
    before = s
    after = transition(s, event)
    return after
  })
  return { before, after }
}

async function step($: EngineInterface, event: Event): Promise<Conduit> {
  return (await stepped($, event)).after
}

async function isPaneOpen($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE)
}

async function retitle($: EngineInterface): Promise<void> {
  if (!await isPaneOpen($)) return
  const s = await read($, conduitState)
  await $.ui.open({ id: PANE, title: titleOf(s.unread) })
}

async function openPane($: EngineInterface): Promise<UiOpenResult> {
  const s = await read($, conduitState)
  return $.ui.open({ id: PANE, title: titleOf(s.unread) })
}

/** The names the native peer list shows. */
async function peerNames($: EngineInterface): Promise<string[]> {
  const listed = await $.tool.call({ tool: 'ListAgents' })
  if (listed.deny !== undefined) throw new Error(listed.deny)
  const result = listed.result as { sections?: { kind?: string, rows?: { name?: string }[] }[] } | undefined
  // Only the peer sessions section: subagents, teammates and background agents are no companion.
  return (result?.sections ?? []).filter(section => section.kind === 'sessions')
    .flatMap(section => section.rows ?? []).map(one => one.name ?? '').filter(name => name !== '')
}

async function pair($: EngineInterface, peer: string, mode: 'on-call' | 'watch', isAsked: boolean): Promise<string> {
  const names = await peerNames($)
  if (!names.includes(peer)) {
    return 'no session named "' + peer + '" in the peer list. '
      + (names.length > 0 ? 'It shows: ' + names.join(', ') + '.' : 'It shows none.')
  }
  await step($, { type: 'pair', peer, token: randomToken(), mode })
  await update($, keptState, reset)
  const surfaces = await $.session.surfaces()
  const paired = 'paired with ' + peer + ' in ' + mode + '.'
  if (!isAsked && !surfaces.some(surface => surface !== 'mobile')) return paired
  const opened = await openPane($)
  return opened.isPlaced ? paired : paired + ' The pane is open but not drawn: ' + opened.reason
}

async function record($: EngineInterface, rows: Row[]): Promise<void> {
  await update($, keptState, kept => keep(kept, rows))
}

/**
 * Sends what is kept, and the question if any; says how it went. A delivered
 * digest removes only the rows it carried. Without a `kind` it is a send on
 * request, told by the turn it meets.
 */
async function sendDigest($: EngineInterface, kind?: DigestKind, question?: string): Promise<string> {
  const s = await read($, conduitState)
  if (s.mode === 'off' || !s.pairing) return 'not paired. ' + USAGE
  const kept = await read($, keptState)
  const batch = batchOf(kept)
  const digest = buildDigest({ rows: kept.rows, dropped: kept.dropped, token: s.pairing.token, mode: s.mode, kind: kind ?? askedKind(s.turn), ...(question ? { question } : {}) })
  const sent = await $.session.send({ to: s.pairing.peer, text: digest.text })
  if (!sent.isDelivered) {
    const text = 'the digest did not reach ' + s.pairing.peer + ': ' + sent.reason
    $.ui.toast(text)
    return text
  }
  await update($, keptState, now => ack(now, batch))
  await step($, { type: 'sent', at: await $.clock.now() })
  $.clock.after(THINK_MS + 50, () => update($, tickState, n => n + 1))
  return 'sent ' + digest.rows + ' rows to ' + s.pairing.peer
    + (digest.dropped > 0 ? ', ' + digest.dropped + ' older dropped.' : '.')
}

async function stopAutopilot($: EngineInterface, reason: 'stop' | 'typing' | 'prompt' | 'done' | 'permission'): Promise<void> {
  if ((await read($, conduitState)).mode !== 'autopilot') return
  const { before } = await stepped($, { type: 'stop', reason })
  if (before.mode !== 'autopilot') return
  $.ui.toast('autopilot stopped, ' + STOP_WORDS[reason] + '.')
}

/**
 * Submits the held autopilot prompt as the user's, if autopilot of the same
 * pairing still holds one; resolves whether it did. Counts once against the cap.
 */
async function release($: EngineInterface, cap: number): Promise<boolean> {
  const { before, after } = await stepped($, { type: 'release', cap })
  const text = released(before, after)
  if (text === undefined) return false
  if (after.autopilot.stop === 'cap') $.ui.toast('autopilot stopped, ' + STOP_WORDS.cap + '.')
  void $.prompt.submit({ text, asUser: true }).then(entered => {
    if (entered.drop !== undefined) return step($, { type: 'turn', turn: { kind: 'idle' } })
  })
  await retitle($)
  return true
}

async function sendNext($: EngineInterface, card: Card): Promise<void> {
  await step($, { type: 'card', id: card.id, status: 'sent' })
  await step($, { type: 'read' })
  await retitle($)
  void $.prompt.submit({ text: card.text, asUser: true })
}

/** Cancels the running turn and submits the suggestion as the user's next prompt in its place. */
async function stopAndSend($: EngineInterface, card: Card): Promise<void> {
  const { turn } = await read($, conduitState)
  if (turn.kind === 'running') await $.turn.abort({ turnId: turn.id })
  await sendNext($, card)
}

async function editCard($: EngineInterface, card: Card): Promise<void> {
  await $.prompt.fill({ text: card.text, mode: 'replace' })
  await step($, { type: 'read' })
  await retitle($)
}

async function answer($: EngineInterface, card: Card, yes: boolean): Promise<void> {
  const s = await read($, conduitState)
  if (!s.pairing) return
  const reply = yes ? 'yes' : 'no'
  const sent = await $.session.send({ to: s.pairing.peer, text: 'conduit: the user answered ' + reply + ' to your ask: "' + card.text + '"' })
  if (!sent.isDelivered) {
    $.ui.toast('the answer did not reach ' + s.pairing.peer + ': ' + sent.reason)
    return
  }
  await step($, { type: 'card', id: card.id, status: 'answered', answer: reply })
  await step($, { type: 'read' })
  await retitle($)
}

async function dismiss($: EngineInterface, card: Card): Promise<void> {
  await step($, { type: 'card', id: card.id, status: 'dismissed' })
  await step($, { type: 'read' })
  await retitle($)
}

async function setMode($: EngineInterface, mode: Mode): Promise<string> {
  const s = await read($, conduitState)
  if (mode === 'off') {
    if (s.mode === 'off') return 'already off.'
    await step($, { type: 'unpair' })
    await update($, keptState, reset)
    if (await isPaneOpen($)) await $.ui.close({ id: PANE })
    return 'off. Nothing more is sent.'
  }
  if (s.mode === 'off') return 'not paired. Run /conduit on [peer] first.'
  await step($, { type: 'mode', mode })
  return mode + '.'
}

const MODES = ['on-call', 'watch', 'autopilot', 'off'] as const satisfies readonly Mode[]

const modeOf = (value: string): Mode | undefined => MODES.find(mode => mode === value)

/** A mode picked in the tab; autopilot entered there sends a digest at once, as `/conduit autopilot` does. */
async function pickMode($: EngineInterface, mode: Mode): Promise<void> {
  if (await setMode($, mode) === 'autopilot.') await sendDigest($)
}

async function tick($: EngineInterface): Promise<void> {
  const s = await read($, conduitState)
  if (s.mode === 'off') return
  const pane = (await $.ui.panes()).find(one => one.id === PANE)
  if (!pane?.isShown) return
  if (s.unread > 0) {
    await step($, { type: 'read' })
    await retitle($)
  }
  if ((await $.session.surfaces()).includes('terminal')) await update($, tickState, n => n + 1)
}

const shown = (cards: readonly Card[]): Card[] => cards.filter(card => card.status !== 'dismissed').slice().reverse()

const newest = (cards: readonly Card[]): Card | undefined =>
  shown(cards).find(card => card.status === 'new' && card.kind !== 'prompt')

const statusLine = (s: Conduit, cap: number): string | undefined => {
  if (s.mode === 'autopilot') return 'autopilot: ' + s.autopilot.sent + ' of ' + (cap > 0 ? cap : 'no cap') + ' prompts sent'
  if (s.autopilot.stop) return 'autopilot stopped: ' + STOP_WORDS[s.autopilot.stop]
  return undefined
}

type Ui = ReturnType<EngineInterface['ui']['resolve']>

/** What closes a card: its one row of buttons while it waits on the person, else what became of it. */
function cardFooter($: EngineInterface, ui: Ui, card: Card, turn: Turn): RenderChildren[] {
  const { Box, Button, Text } = ui
  const row = (buttons: RenderChildren[]) => <Box key={'actions-' + card.id} flexDirection="row" gap={1}>{buttons}</Box>
  if (card.kind === 'suggest' && card.status === 'new') {
    const isRunning = turn.kind === 'running'
    return [
      row([
        <Button key={'send-' + card.id} label="Send next" variant="primary" onPress={() => void sendNext($, card)} />,
        ...(isRunning
          ? [<Button key={'stop-' + card.id} label="Stop and send" onPress={() => void stopAndSend($, card).catch(() => $.ui.toast('the turn could not be stopped; the suggestion was not sent.'))} />]
          : []),
        <Button key={'edit-' + card.id} label="Edit" onPress={() => void editCard($, card)} />,
      ]),
      ...(isRunning ? [<Text key={'hint-' + card.id} dimColor>Stop the running turn and send now.</Text>] : []),
    ]
  }
  if (card.kind === 'ask' && card.status === 'new') {
    return [row([
      <Button key={'yes-' + card.id} label="Yes" variant="primary" onPress={() => void answer($, card, true)} />,
      <Button key={'no-' + card.id} label="No" onPress={() => void answer($, card, false)} />,
    ])]
  }
  if (card.kind === 'note' && card.status === 'new') {
    return [row([<Button key={'dismiss-' + card.id} label="Dismiss" onPress={() => void dismiss($, card)} />])]
  }
  const done = card.kind === 'prompt'
    ? card.status === 'sent' ? 'sent as your prompt' : card.status === 'dropped' ? 'not sent: autopilot stopped' : 'sent when the turn ends'
    : card.status === 'sent' ? 'sent as your next prompt'
      : card.status === 'answered' ? 'answered ' + (card.answer ?? '')
        : ''
  return done ? [<Text key={'done-' + card.id} dimColor>{done}</Text>] : []
}

export const register: Register = (on, options) => {
  const settings = settingsOf(options)
  let heldPrompt: Timer | undefined
  const dropHeldPrompt = () => {
    heldPrompt?.cancel()
    heldPrompt = undefined
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'conduit', description: 'Pair with a companion session: on [peer], off, on-call, watch, autopilot, ask [question]' })
    $.clock.every(TICK_MS, () => tick($))
    // session.start comes again on an enable, a respawn or a reload, while $.state survives: keep a live pairing.
    if (settings.startPaired && settings.peer !== '' && (await read($, conduitState)).mode === 'off') {
      void pair($, settings.peer, settings.mode, false).then(text => {
        if (!text.startsWith('paired with')) $.ui.toast(text)
      }, () => $.ui.toast('the peer list could not be read.'))
    }
    return next(e)
  })

  on('command.run', { command: 'conduit' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const tail = rest.join(' ').trim()
    if (verb === '') {
      const s = await read($, conduitState)
      if (s.mode === 'off') return said('not paired. ' + USAGE)
      const opened = await openPane($)
      return said(opened.isPlaced ? 'pane opened.' : 'the pane is open but not drawn: ' + opened.reason)
    }
    if (verb === 'on') {
      const peer = tail || settings.peer
      if (!peer) return said('name the companion session: /conduit on <peer>, or set peer in the plugin settings.')
      return said(await pair($, peer, settings.mode, true))
    }
    if (verb === 'off' || verb === 'on-call' || verb === 'watch' || verb === 'autopilot') {
      const text = await setMode($, verb)
      if (verb === 'autopilot' && text === 'autopilot.') await sendDigest($)
      return said(text)
    }
    if (verb === 'ask') return said(await sendDigest($, undefined, tail))
    return said(USAGE)
  }).catch(() => ({ text: 'could not run that command.' }))

  on('prompt.submit', async ($, e, next) => {
    if (isPersons(e.origin) && e.command === undefined) await stopAutopilot($, 'prompt')
    const entered = await next(e)
    if (e.command !== undefined || e.isMeta || entered.drop !== undefined || !isUsers(e.origin)) return entered
    if ((await read($, conduitState)).mode === 'off') return entered
    await record($, [row('prompt', entered.text)])
    // Autopilot sends none: the companion wrote the prompt.
    if (settings.promptDigest && (await read($, conduitState)).mode === 'watch') {
      dropHeldPrompt()
      heldPrompt = $.clock.after(PROMPT_HOLD_MS, () => {
        heldPrompt = undefined
        void read($, conduitState).then(s => s.mode === 'watch' && s.turn.kind !== 'idle' ? sendDigest($, 'prompt') : undefined)
      })
    }
    return entered
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if ((e as { agentId?: string }).agentId !== undefined || (await read($, conduitState)).mode === 'off') return ran
    const rows = [row('tool', toolLine(String(e.tool), e))]
    if (ran.deny !== undefined) rows.push(row('error', String(e.tool) + ' refused: ' + ran.deny))
    else if (ran.isError) rows.push(row('error', String(e.tool) + ': ' + (ran.text ?? '').split('\n')[0]))
    await record($, rows)
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision !== 'ask' || e.tool_use_id === undefined) return verdict
    if ((await read($, conduitState)).mode !== 'autopilot') return verdict
    // Approve only the engine's own ask; one a plugin made (`plugin` set) is a person's.
    if (settings.permissions === 'approve' && verdict.plugin === undefined) return { ...verdict, decision: 'allow' as const }
    await stopAutopilot($, 'permission')
    return verdict
  }).catch(($, e, next) => next(e))

  on('prompt.edit', async ($, e, next) => {
    if ((await read($, conduitState)).mode === 'autopilot') await stopAutopilot($, 'typing')
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await step($, { type: 'turn', turn: { kind: 'running', id: e.turnId } })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    dropHeldPrompt()
    const s = await step($, { type: 'turn', turn: { kind: 'idle' } })
    if (s.mode === 'off') return done
    await record($, [row('reply', e.answer), ...(e.reason === 'error' ? [row('error', 'the turn ended on an API error')] : [])])
    if (e.isAborted) await stopAutopilot($, 'stop')
    // A held prompt goes now, so this digest asks for none: its own turn's end will.
    const isHandoff = await release($, settings.cap)
    if (sendsOnTurns((await read($, conduitState)).mode)) await sendDigest($, isHandoff ? 'handoff' : 'turn-end')
    return done
  })

  on('session.receive', async ($, e, next) => {
    if (e.origin.kind !== 'peer') return next(e)
    const s = await read($, conduitState)
    const parsed = parseDelivery(e.text, s.mode === 'off' ? undefined : s.pairing, s.retired)
    if (parsed.kind === 'stale') {
      $.ui.log('conduit: dropped a card of an earlier pairing or one that came after off', { to: 'debug' })
      return CONSUMED
    }
    if (parsed.kind === 'pass') return next(e)
    if (parsed.kind === 'plain') {
      $.ui.log('conduit: a reply from ' + (s.pairing?.peer ?? 'the companion') + ' had no card line; passed to the session', { to: 'debug' })
      await step($, { type: 'plain', at: await $.clock.now() })
      return next(e)
    }
    const at = await $.clock.now()
    const isAutopilot = s.mode === 'autopilot'
    const cards: Card[] = parsed.cards.map((card, index) => ({
      id: at.toString(36) + '-' + index,
      kind: card.kind === 'prompt' && !isAutopilot ? 'suggest' : card.kind,
      text: card.text,
      at,
      status: 'new',
    }))
    const after = await step($, { type: 'cards', cards, from: parsed.from, at })
    for (const card of cards) if (card.kind !== 'prompt') $.ui.toast(card.kind + ' from ' + (s.pairing?.peer ?? 'companion'))
    $.clock.after(FLARE_MS + 50, () => update($, tickState, n => n + 1))
    if (isAutopilot && parsed.isDone) await stopAutopilot($, 'done')
    else if (after.pending && after.turn.kind === 'idle') await release($, settings.cap)
    await retitle($)
    return CONSUMED
  }).catch(($, e, next) => next.called || e.origin.kind !== 'peer' || !looksLikeCards(e.text) ? next(e) : CONSUMED)

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'mobile' || e.props.hasSurvey) return next(e)
    const s = await read($, conduitState)
    const card = s.mode === 'off' ? undefined : newest(s.cards)
    if (!card) return next(e)
    const drawn = await next(e)
    const below = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    return (
      <Box flexDirection="column">
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center">
            <Text dimColor bold>{LABEL[card.kind] + ' · ' + (s.pairing?.peer ?? '')}</Text>
            <Button key="open" label={titleOf(s.unread)} onPress={() => void openPane($)} />
          </Box>
          <Text wrap="truncate-end">{card.text}</Text>
          {cardFooter($, ui, card, s.turn)}
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const [s, t, now] = await Promise.all([read($, conduitState), read($, tickState), $.clock.now()])
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    if (s.mode === 'off' || !s.pairing) {
      return (
        <Box flexDirection="column">
          <Text bold>conduit</Text>
          <Text dimColor>Not paired. {USAGE}</Text>
        </Box>
      )
    }
    const peer = s.pairing.peer
    const state = stateOf(s.isAwaiting, s.lastSentAt, s.flareAt, now)
    const flare = state === 'flare' && s.flareAt !== undefined ? 1 - (now - s.flareAt) / FLARE_MS : 0
    const status = statusLine(s, settings.cap)
    const mood = state === 'thinking' ? 'reading your turn' : state === 'flare' ? 'new card' : 'idle'
    const moodLine = mood + (s.lastSentAt !== undefined ? ' · last digest ' + clockTime(s.lastSentAt) : '')
    const unread = s.unread > 0 ? s.unread + ' unread' : undefined
    const turnLine = s.turn.kind === 'running' ? ['Turn running', ...(unread ? [unread] : [])].join(' · ') : unread
    const isApp = e.surface !== 'terminal' && 'Svg' in ui
    const lens = isApp && 'Svg' in ui
      ? <ui.Svg key="lens" source={lensSvg(peer, state, 96, state === 'flare' ? String(s.flareAt) : '')} alt={peer + ' lens, ' + mood} width={96} height={96} isInteractive />
      : 'Raster' in ui
        ? (() => {
          const drawing = lensRaster(peer, t * TICK_MS / 1000, state, flare)
          return <ui.Raster key="lens" cells={drawing.cells} columns={drawing.columns} rows={drawing.rows} />
        })()
        : null
    // An app is sent a Select only if it asked for one, and a hook cannot tell: the phone asks in a dialog instead.
    const modePicker = e.surface === 'mobile'
      ? <Button key="mode" label={s.mode + ' ▾'} onPress={() => void $.ui.ask('Which mode?', MODES).then(
        value => {
          const mode = modeOf(value)
          if (mode !== undefined && mode !== s.mode) return pickMode($, mode)
        },
        // Dismissed: the mode stays.
        () => undefined,
      )} />
      : <ui.Select key="mode" options={MODES.map(mode => ({ value: mode }))} value={s.mode} onSelect={value => {
        const mode = modeOf(value)
        if (mode !== undefined && mode !== s.mode) void pickMode($, mode)
      }} />
    const cards = shown(s.cards)
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column" alignItems="center">
          {lens}
          <Text bold>{peer}</Text>
          <Text dimColor>{moodLine}</Text>
          {status !== undefined && <Text>{status}</Text>}
        </Box>
        <Box flexDirection="column" alignItems="center">
          {/* A long companion name may push Ask past the pane's width. */}
          <Box flexDirection="row" gap={1} alignItems="center" justifyContent="center" flexWrap="wrap">
            <Text dimColor bold>Mode</Text>
            {modePicker}
            <Button key="ask" label={'Ask ' + peer} onPress={() => void sendDigest($)} />
          </Box>
          <Text dimColor>Change anytime, including mid-turn.</Text>
        </Box>
        <Text key="rule" dimColor wrap="truncate">{'─'.repeat(e.props.bodyColumns)}</Text>
        {(turnLine !== undefined || s.plainAt !== undefined) && (
          <Box key="status" flexDirection="column">
            {turnLine !== undefined && <Text color={s.turn.kind === 'running' ? 'claude' : undefined}>{turnLine}</Text>}
            {s.plainAt !== undefined && <Text dimColor>{'last reply from ' + peer + ' at ' + clockTime(s.plainAt) + ': no cards, passed to the session'}</Text>}
          </Box>
        )}
        {cards.length === 0 && (
          <Box key="empty" flexDirection="column">
            <Text>No cards yet.</Text>
            <Text dimColor>Most turns the companion says nothing.</Text>
          </Box>
        )}
        {cards.map(card => (
          <Box key={'card-' + card.id} flexDirection="column" borderStyle="round" paddingX={1} gap={1}>
            <Text dimColor bold>{LABEL[card.kind] + ' · ' + clockTime(card.at)}</Text>
            {isApp ? <ui.Markdown key={'text-' + card.id} text={card.text} /> : <Text wrap="wrap">{card.text}</Text>}
            <Box key={'footer-' + card.id} flexDirection="column">{cardFooter($, ui, card, s.turn)}</Box>
          </Box>
        ))}
      </Box>
    )
  })
}
