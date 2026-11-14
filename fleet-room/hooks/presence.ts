import type { EngineInterface, ProcessSpawnChunk, ProcessSpawnResult, Timer } from 'claude-code'

/** What bin/gateway.mjs writes, one JSON object per line. */
export type GatewayEvent =
  | { event: 'ready', user?: string }
  | { event: 'resumed' }
  | { event: 'beat' }
  | { event: 'message', channel: string }
  | { event: 'thread', channel: string, parent: string }
  | { event: 'closed', code: number }
  | { event: 'fatal', code: number }
  | { event: 'unsupported', why: string }
export type Presence = { isStopped: boolean, stop: () => void }

export const RESTART_MS = 30_000
const MAX_RESTART_MS = 10 * 60 * 1000

const eventOf = (line: string): GatewayEvent | undefined => {
  try {
    const value = JSON.parse(line) as unknown
    return value !== null && typeof value === 'object' && typeof (value as {event?: unknown}).event === 'string' ? value as GatewayEvent : undefined
  } catch {
    return undefined
  }
}

/**
 * Keeps the gateway helper running under node so the bot shows online, restarting it with backoff when it exits on its own.
 * The helper reconnects by itself; a fatal close or an unsupported runtime ends it for good. Ending the read loop kills the child.
 * `dms` asks it for direct-message events too.
 */
export function holdPresence($: EngineInterface, token: string, dms: boolean, onEvent: (event: GatewayEvent) => Promise<void>): Presence {
  let stream: AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult> | undefined
  let timer: Timer | undefined
  const presence: Presence = { isStopped: false, stop: () => {
    presence.isStopped = true
    timer?.cancel()
    void stream?.return({ code: null, signal: null }).catch(() => undefined)
  } }
  const run = async (restarts: number): Promise<void> => {
    let isFinal = false
    let isReady = false
    let buffer = ''
    try {
      stream = $.process.spawn({ argv: ['node', $.plugin.root + '/bin/gateway.mjs'], input: JSON.stringify(dms ? { token, dms } : { token }) })
      for await (const chunk of stream) {
        if (presence.isStopped) break
        if (chunk.stream === 'stderr') { $.ui.log('fleet-room gateway: ' + chunk.text.replaceAll(token, '[redacted]').trim(), { to: 'debug' }); continue }
        buffer += chunk.text
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const event = eventOf(line)
          if (!event) continue
          if (event.event === 'ready') isReady = true
          if (event.event === 'fatal' || event.event === 'unsupported') isFinal = true
          await onEvent(event)
        }
      }
    } catch {
      $.ui.log('fleet-room: the gateway helper could not run under node; the bot shows offline.', { to: 'debug' })
    }
    if (presence.isStopped || isFinal) return
    const delay = Math.min(MAX_RESTART_MS, RESTART_MS * 2 ** (isReady ? 0 : restarts))
    $.ui.log('fleet-room: the gateway helper ended; restarting in ' + Math.round(delay / 1000) + ' s.', { to: 'debug' })
    timer = $.clock.after(delay, () => { void run(isReady ? 1 : restarts + 1) })
  }
  void run(0)
  return presence
}
