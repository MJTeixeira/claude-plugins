import type { EngineInterface, TurnCompleteInput, TurnStartInput } from 'claude-code'
import { briefsChanged, briefsCompose, briefsSettle } from './briefs'
import type { BriefWake } from './briefs'
import { codexChanged, codexCompose, codexSettle } from './local'
import type { CodexWake } from './local'
import type { Batch } from './room'
import { roomChanged, roomCompose, roomReleased, roomSettle, roomSubmitted } from './watch'

const MAX_ERROR_ENDS = 3
/** The inputs of the session's single wake slot, asked in this order; the first with something waiting fills it, so wakes never pile up. */
const SOURCES = ['discord', 'codex', 'briefs'] as const
export type SourceName = typeof SOURCES[number]
/** A batch of input submitted as one plugin turn; `marker` is in its text and binds the turn that starts with it. */
export type Wake = { marker: string }
export type Slot = { kind: 'free' } | { kind: 'held' }
  | { kind: 'submitted', source: SourceName, wake: Wake } | { kind: 'running', source: SourceName, wake: Wake, turnId: string }

type Core = { slot: Slot, main: string | undefined, errorEnds: number, composing: boolean }
const core: Core = { slot: {kind: 'free'}, main: undefined, errorEnds: 0, composing: false }
const SETTLE_FAILED: Record<SourceName, string> = {
  discord: 'fleet-room: could not save wake checkpoints; mentions may replay on a later poll.',
  codex: 'fleet-room: could not archive Codex messages; they may wake this session again.',
  briefs: 'fleet-room: could not archive a brief; it may wake this session again.',
}

export const slot = (): Slot => core.slot
/** Puts back a wake a source saved before a hot reload; a running one also marks its turn as the main turn. */
export function restore(next: Slot): void {
  const prior = core.slot
  if (prior.kind === 'running' && core.main === prior.turnId) core.main = undefined
  core.slot = next
  if (next.kind === 'running') core.main = next.turnId
}
/**
 * A /clear or an in-process /resume ends the conversation a running turn belonged to, so its wake is let go unsettled and its messages wake the
 * next conversation. A submitted or held wake stays: its prompt may still enter the next conversation, guarded.
 */
export async function conversationEnded($: EngineInterface): Promise<void> {
  const current = core.slot
  if (current.kind === 'running') {
    released(current.source)
    core.slot = {kind: 'free'}
  }
  core.main = undefined
  core.errorEnds = 0
  await changed($)
}
// The mod scanner refuses `$` passed through a value, so each source's functions are named here.
async function changed($: EngineInterface): Promise<void> {
  await roomChanged($)
  await codexChanged($)
  await briefsChanged($)
}
async function composeOf($: EngineInterface, source: SourceName): Promise<{ wake: Wake, text: string } | undefined> {
  return source === 'discord' ? roomCompose($) : source === 'codex' ? codexCompose($) : briefsCompose($)
}
async function settleOf($: EngineInterface, source: SourceName, wake: Wake): Promise<void> {
  if (source === 'discord') await roomSettle($, wake as Batch)
  else if (source === 'codex') await codexSettle($, wake as CodexWake)
  else await briefsSettle($, wake as BriefWake)
}
function released(source: SourceName): void {
  if (source === 'discord') roomReleased()
}
export async function submitNext($: EngineInterface): Promise<void> {
  if (core.composing || core.slot.kind !== 'free' || core.main !== undefined) return
  core.composing = true
  try {
    for (const source of SOURCES) {
      const next = await composeOf($, source)
      if (!next) continue
      core.slot = {kind: 'submitted', source, wake: next.wake}
      await changed($)
      if (source === 'discord') roomSubmitted($, next.wake as Batch)
      const marker = next.wake.marker
      // A submit resolves when its turn starts, which may wait behind the operator's turn.
      void $.prompt.submit({text: next.text})
        .then(result => { if (result.drop !== undefined) return dropped($, marker) }, () => dropped($, marker))
        .catch(() => { $.ui.log('fleet-room: could not save dropped wake state.') })
      return
    }
  } finally {
    core.composing = false
  }
}
async function dropped($: EngineInterface, marker: string): Promise<void> {
  const current = core.slot
  if (current.kind !== 'submitted' || current.wake.marker !== marker) return
  released(current.source)
  core.slot = {kind: 'held'}
  await changed($)
}
export async function turnStarted($: EngineInterface, e: TurnStartInput): Promise<void> {
  if (e.agentId !== undefined) return
  core.main = e.turnId
  const current = core.slot
  if (current.kind === 'submitted' && e.text.includes(current.wake.marker)) {
    core.slot = {kind: 'running', source: current.source, wake: current.wake, turnId: e.turnId}
    await changed($)
  }
}
export async function turnEnded($: EngineInterface, e: TurnCompleteInput): Promise<void> {
  if (e.agentId !== undefined) return
  if (core.main === e.turnId) core.main = undefined
  let failed = false
  const current = core.slot
  if (current.kind === 'running' && current.turnId === e.turnId) {
    released(current.source)
    core.errorEnds = e.reason === 'error' ? core.errorEnds + 1 : 0
    try {
      if (e.reason !== 'error' || core.errorEnds >= MAX_ERROR_ENDS) {
        if (core.errorEnds >= MAX_ERROR_ENDS) $.ui.log('fleet-room: settling a wake after three error endings.')
        await settleOf($, current.source, current.wake)
        core.errorEnds = 0
      }
    } catch {
      failed = true
      $.ui.log(SETTLE_FAILED[current.source])
    } finally {
      core.slot = e.reason === 'aborted' ? {kind: 'held'} : {kind: 'free'}
    }
  } else if (current.kind === 'held') core.slot = {kind: 'free'}
  try { await changed($) } catch {
    failed = true
    $.ui.log('fleet-room: could not clear saved wake state; the running slot is free.')
  }
  if (!failed) await submitNext($)
}
