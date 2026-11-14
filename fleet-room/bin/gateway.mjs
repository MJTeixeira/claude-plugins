// Holds a Discord gateway (v10) session so the bot shows online while the listening session lives.
// The fleet-room mod starts it with `node gateway.mjs`, writes {"token": ..., "dms": true?} on stdin, and reads one JSON event per stdout line.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const GATEWAY_URL = 'wss://gateway.discord.gg'
const QUERY = '/?v=10&encoding=json'
/** GUILDS (thread creates) and GUILD_MESSAGES (which channel got a message); neither is privileged. */
export const INTENTS = 1 | (1 << 9)
/** DIRECT_MESSAGES adds which direct-message channel got a message; it is not privileged either. */
export const DM_INTENTS = INTENTS | (1 << 12)
/**
 * The intents for the helper's stdin request: direct-message events only when the mod reads the operator's direct messages.
 * @param {{ token?: string, dms?: boolean }} request
 */
export const intentsOf = request => request.dms === true ? DM_INTENTS : INTENTS
/** Close codes after which Discord refuses any reconnect: authentication failed, invalid shard, sharding required, invalid version or intents. */
export const FATAL_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014])
/** Close codes after which the session cannot resume and must identify again. */
const FRESH_CODES = new Set([4007, 4009])
// Discord keeps a session resumable when the client closes with any code but 1000 or 1001.
const RESUMABLE_CLOSE = 4000
export const MAX_BACKOFF_MS = 60_000

const OP = { dispatch: 0, heartbeat: 1, identify: 2, resume: 6, reconnect: 7, invalidSession: 9, hello: 10, ack: 11 }

/**
 * Runs one gateway session over `WebSocket` until stopped or a fatal close, reconnecting and resuming with backoff.
 * `emit` receives `{event}` objects: ready, resumed, message ({channel}), thread ({channel, parent}), beat, closed ({code}), fatal ({code}).
 */
export const runGateway = ({ token, intents = INTENTS, WebSocket, timers = globalThis, random = Math.random, emit, platform = process.platform }) => {
  let socket
  let session
  let resumeUrl
  let seq = null
  let me
  let beat
  let retry
  let isAcked = true
  let attempts = 0
  let isStopped = false

  const send = (op, d) => socket?.send(JSON.stringify({ op, d }))
  const quiet = () => {
    timers.clearTimeout(beat)
    beat = undefined
  }
  const reconnect = delay => {
    timers.clearTimeout(retry)
    retry = timers.setTimeout(connect, delay)
  }
  const backoff = () => Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** attempts++) * (0.5 + random() / 2)
  // Abandons the current socket without waiting for its close handshake, which a zombied connection never finishes.
  const drop = delay => {
    const old = socket
    socket = undefined
    quiet()
    try { old?.close(RESUMABLE_CLOSE) } catch { /* An already closed socket needs no close. */ }
    if (!isStopped) reconnect(delay)
  }
  const pulse = interval => {
    beat = timers.setTimeout(() => {
      if (!isAcked) { emit({ event: 'closed', code: 0 }); drop(backoff()); return }
      isAcked = false
      send(OP.heartbeat, seq)
      pulse(interval)
    }, interval)
  }
  const hello = interval => {
    quiet()
    isAcked = true
    if (session) send(OP.resume, { token, session_id: session, seq })
    else send(OP.identify, { token, intents, properties: { os: platform, browser: 'fleet-room', device: 'fleet-room' },
      presence: { since: null, activities: [], status: 'online', afk: false } })
    // The first beat waits a random part of one interval; later beats repeat at the full interval.
    beat = timers.setTimeout(() => {
      isAcked = false
      send(OP.heartbeat, seq)
      pulse(interval)
    }, Math.floor(interval * random()))
  }
  const dispatch = (type, d) => {
    if (type === 'READY') {
      session = d.session_id
      resumeUrl = d.resume_gateway_url
      me = d.user?.id
      attempts = 0
      emit({ event: 'ready', user: me })
    } else if (type === 'RESUMED') {
      attempts = 0
      emit({ event: 'resumed' })
    } else if (type === 'MESSAGE_CREATE') {
      if (d.author?.id !== me) emit({ event: 'message', channel: d.channel_id })
    } else if (type === 'THREAD_CREATE') emit({ event: 'thread', channel: d.id, parent: d.parent_id })
  }
  const receive = (ws, data) => {
    if (ws !== socket) return
    const payload = JSON.parse(String(data))
    if (payload.s !== null && payload.s !== undefined) seq = payload.s
    switch (payload.op) {
      case OP.hello: hello(payload.d.heartbeat_interval); break
      case OP.ack: isAcked = true; emit({ event: 'beat' }); break
      case OP.heartbeat: send(OP.heartbeat, seq); break
      case OP.reconnect: drop(0); break
      case OP.invalidSession:
        if (!payload.d) { session = undefined; seq = null }
        drop(1_000 + Math.floor(random() * 4_000))
        break
      case OP.dispatch: dispatch(payload.t, payload.d); break
    }
  }
  const closed = (ws, code) => {
    if (ws !== socket) return
    socket = undefined
    quiet()
    if (isStopped) return
    if (FATAL_CODES.has(code)) {
      isStopped = true
      emit({ event: 'fatal', code })
      return
    }
    if (FRESH_CODES.has(code)) { session = undefined; seq = null }
    emit({ event: 'closed', code })
    reconnect(backoff())
  }
  function connect() {
    if (isStopped) return
    let ws
    try {
      ws = new WebSocket((session && resumeUrl ? resumeUrl : GATEWAY_URL) + QUERY)
    } catch {
      emit({ event: 'closed', code: 0 })
      reconnect(backoff())
      return
    }
    socket = ws
    ws.onmessage = event => receive(ws, event.data)
    ws.onclose = event => closed(ws, event.code)
  }
  connect()
  return {
    stop: () => {
      isStopped = true
      quiet()
      timers.clearTimeout(retry)
      const old = socket
      socket = undefined
      try { old?.close(1000) } catch { /* An already closed socket needs no close. */ }
    },
  }
}

const main = async () => {
  const write = event => new Promise(done => process.stdout.write(JSON.stringify(event) + '\n', done))
  if (typeof globalThis.WebSocket !== 'function') {
    await write({ event: 'unsupported', why: 'node ' + process.version + ' has no built-in WebSocket (Node 22 or later has one)' })
    process.exit(3)
  }
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const request = JSON.parse(input)
  runGateway({ token: request.token, intents: intentsOf(request), WebSocket: globalThis.WebSocket, emit: event => {
    void write(event).then(() => { if (event.event === 'fatal') process.exit(2) })
  } })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
