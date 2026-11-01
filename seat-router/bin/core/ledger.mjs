// Quota as observed. Every writer keeps its own file under <home>/quota (a seat's supervisor, a session's measurements,
// the machine's refresher) and every reader merges them here, so no two writers ever share a file. Imported by the hooks
// and by the supervisor, so it imports nothing from node: (bin/structure.test.mjs).

export const LEDGER_SCHEMA = 1

/** How a scope stands, best first: stateOf keeps the worst, so unknown never passes for free. */
export const STATES = /** @type {const} */ (['free', 'unknown', 'busy', 'out'])

export const RULES = {
  outPct: 95,
  paceMargin: 15,
  paceMinutes: 7 * 24 * 60,
  freshMs: 30 * 60 * 1000,
  exhaustionMs: 30 * 60 * 1000,
  maxAheadMs: 60 * 24 * 60 * 60 * 1000,
  futureToleranceMs: 60 * 1000,
}

/** A scope read no later than this ago is not read again; one vendor is read at most this often on a machine. */
export const ACTIVE_EVERY_MS = 10 * 60 * 1000
/** Pure. Whether the refresher may read: only while a prompt was composed on this machine in the last ACTIVE_EVERY_MS. */
export const composedRecently = (composedAt, now) => now - composedAt <= ACTIVE_EVERY_MS && composedAt <= now + RULES.futureToleranceMs

/** A vendor account is read at least this often, so a bucket it starts metering shows up. */
export const REDISCOVER_MS = 24 * 60 * 60 * 1000

/**
 * @typedef {typeof STATES[number]} State
 * @typedef {{ id: string, minutes?: number, usedPct: number, resetsAt?: number }} Window
 * @typedef {{ scope: string, at: number, windows: Window[] }} Reading
 * @typedef {{ scope: string, at: number, until: number, detail: string }} Exhaustion
 * @typedef {{ vendor: string, at: number, detail: string }} Failure
 * @typedef {{ schema: 1, writer: string, at: number, readings: Reading[], exhaustions: Exhaustion[], failures?: Failure[],
 *             reads?: Record<string, number> }} WriterFile
 *   `reads` is the refresher's: when it last read each vendor account, by the key its want names.
 * @typedef {{ id: string, usedPct: number, state: State }} WindowView
 * @typedef {{ state: State, why: string, rule?: 'exhaustion'|'out'|'busyAt'|'pace'|'stale'|'reset'|'none', until?: number,
 *             at?: number, source?: string, windows: WindowView[] }} ScopeView
 *   `rule` names what made the state; `until` when an out or busy state ends, where a reset says so.
 * @typedef {Map<string, ScopeView>} Ledger
 * @typedef {{ key: string, vendor: string, scopes: string[], optional: string[] }} Want
 *   One vendor account a refresh can read: `scopes` are the ones a candidate in use draws on first, `optional` the
 *   models' own buckets, which count once a reading names them.
 */

const STATE_RANK = Object.fromEntries(STATES.map((state, index) => [state, index]))
const worse = (a, b) => STATE_RANK[a] >= STATE_RANK[b] ? a : b

const finite = value => typeof value === 'number' && Number.isFinite(value)
const text = value => typeof value === 'string'

const validWindow = (window, now) => {
  if (!window || !text(window.id) || !finite(window.usedPct) || window.usedPct < 0 || window.usedPct > 100) return undefined
  if (window.minutes !== undefined && (!finite(window.minutes) || window.minutes <= 0)) return undefined
  if (window.resetsAt !== undefined && (!finite(window.resetsAt) || window.resetsAt > now + RULES.maxAheadMs)) return undefined
  return { id: window.id, usedPct: window.usedPct, ...(window.minutes === undefined ? {} : { minutes: window.minutes }),
    ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }) }
}

/**
 * A writer file as the ledger takes it, or undefined when it is not one this version reads. Every quota file is outside
 * input: what cannot be true is dropped here, window by window.
 * @returns {WriterFile | undefined}
 */
export const validFile = (file, now) => {
  if (file?.schema !== LEDGER_SCHEMA || !text(file.writer) || !Array.isArray(file.readings) || !Array.isArray(file.exhaustions)) return undefined
  const readings = file.readings.flatMap(reading => {
    if (!reading || !text(reading.scope) || !finite(reading.at) || reading.at > now + RULES.futureToleranceMs || !Array.isArray(reading.windows)) return []
    const windows = reading.windows.flatMap(window => validWindow(window, now) ?? [])
    const everyWindowDropped = windows.length === 0 && reading.windows.length > 0
    return everyWindowDropped ? [] : [{ scope: reading.scope, at: reading.at, windows }]
  })
  const exhaustions = file.exhaustions.flatMap(ex => !ex || !text(ex.scope) || !finite(ex.at) || !finite(ex.until) || ex.until > now + RULES.maxAheadMs ? []
    : [{ scope: ex.scope, at: ex.at, until: ex.until, detail: text(ex.detail) ? ex.detail : '' }])
  return { schema: LEDGER_SCHEMA, writer: file.writer, at: finite(file.at) ? file.at : 0, readings, exhaustions,
    ...(Array.isArray(file.failures) ? { failures: file.failures.filter(failure => text(failure?.vendor) && finite(failure.at)) } : {}),
    ...(file.reads && typeof file.reads === 'object'
      ? { reads: Object.fromEntries(Object.entries(file.reads).filter(([, at]) => finite(at) && at <= now + RULES.futureToleranceMs)) } : {}) }
}

const round = value => Math.round(value)

const elapsedPct = (window, now) => Math.max(0, Math.min(100, 100 * (1 - ((window.resetsAt ?? now) - now) / ((window.minutes ?? 1) * 60_000))))

/**
 * @returns {{ state: State, rule: NonNullable<ScopeView['rule']>, why: string, until?: number } | undefined}
 */
const windowState = (window, at, now, busyAt) => {
  if (window.resetsAt !== undefined && window.resetsAt <= now) return undefined
  const used = window.id + ' ' + round(window.usedPct) + '% used'
  const binding = window.resetsAt !== undefined || now - at <= RULES.freshMs
  const until = window.resetsAt === undefined ? {} : { until: window.resetsAt }
  if (window.usedPct >= RULES.outPct && binding) return { state: 'out', rule: 'out', why: used + ', out at ' + RULES.outPct + '%', ...until }
  if (window.usedPct >= busyAt && binding) return { state: 'busy', rule: 'busyAt', why: used + ', busy at ' + busyAt + '%', ...until }
  if (now - at > RULES.freshMs) return { state: 'unknown', rule: 'stale', why: used + ', read ' + round((now - at) / 60_000) + ' minutes ago' }
  if (window.minutes !== undefined && window.minutes >= RULES.paceMinutes && window.resetsAt !== undefined) {
    const passed = elapsedPct(window, now)
    if (window.usedPct > passed + RULES.paceMargin) {
      return { state: 'busy', rule: 'pace', why: used + ', more than ' + RULES.paceMargin + ' points ahead of the ' + round(passed) + '% of it passed', ...until }
    }
  }
  return { state: 'free', rule: 'none', why: used }
}

/** @returns {ScopeView} */
const viewOf = (kept, exhaustion, now, busyAt) => {
  const reading = kept?.reading
  const windows = (reading?.windows ?? []).flatMap(window => {
    const found = windowState(window, reading?.at ?? 0, now, busyAt)
    return found ? [{ window, ...found }] : []
  })
  const shown = windows.map(({ window, state }) => ({ id: window.id, usedPct: window.usedPct, state }))
  const source = kept === undefined ? {} : { at: reading?.at, source: kept.source }
  if (exhaustion) {
    const reason = exhaustion.detail || 'out of quota'
    return { state: 'out', rule: 'exhaustion', why: reason, until: exhaustion.until, at: exhaustion.at, source: exhaustion.source, windows: shown }
  }
  if (!reading) return { state: 'unknown', rule: 'none', why: 'no reading', windows: [] }
  if (reading.windows.length === 0) {
    return now - reading.at > RULES.freshMs
      ? { state: 'unknown', rule: 'stale', why: 'no window of its own, read ' + round((now - reading.at) / 60_000) + ' minutes ago', ...source, windows: [] }
      : { state: 'free', rule: 'none', why: 'no window of its own', ...source, windows: [] }
  }
  if (windows.length === 0) return { state: 'unknown', rule: 'reset', why: 'every window it read has reset since', ...source, windows: [] }
  const worst = windows.reduce((a, b) => STATE_RANK[b.state] > STATE_RANK[a.state] ? b : a)
  const holding = windows.filter(entry => entry.state === worst.state)
  const until = worst.state === 'out' || worst.state === 'busy'
    ? holding.every(entry => entry.until !== undefined) ? Math.max(...holding.map(entry => entry.until ?? 0)) : undefined : undefined
  return { state: worst.state, rule: worst.rule, why: worst.why, ...(until === undefined ? {} : { until }), ...source, windows: shown }
}

/**
 * Pure. One view per scope from every writer's file: the freshest reading of the scope, whoever wrote it, and the
 * latest exhaustion still in force, which keeps the scope out until its `until` whatever any reading says.
 * @param {readonly unknown[]} files @param {number} now @param {number} busyAt @returns {Ledger}
 */
export const merge = (files, now, busyAt) => {
  /** @type {Map<string, { reading: Reading, source: string }>} */
  const readings = new Map()
  /** @type {Map<string, Exhaustion & { source: string }>} */
  const exhaustions = new Map()
  for (const raw of files) {
    const file = validFile(raw, now)
    if (!file) continue
    for (const reading of file.readings) {
      const kept = readings.get(reading.scope)
      if (!kept || reading.at > kept.reading.at) readings.set(reading.scope, { reading, source: file.writer })
    }
    for (const exhaustion of file.exhaustions) {
      if (exhaustion.until <= now) continue
      const kept = exhaustions.get(exhaustion.scope)
      if (!kept || exhaustion.until > kept.until) exhaustions.set(exhaustion.scope, { ...exhaustion, source: file.writer })
    }
  }
  /** @type {Ledger} */
  const ledger = new Map()
  for (const scope of new Set([...readings.keys(), ...exhaustions.keys()])) ledger.set(scope, viewOf(readings.get(scope), exhaustions.get(scope), now, busyAt))
  return ledger
}

/**
 * Pure. The worst view over the scopes a candidate draws on. The first is its account's, which no reading means
 * unknown; the rest are its model's own buckets, which count once a reading names them.
 * @param {Ledger} ledger @param {readonly string[]} scopes
 * @returns {{ state: State, why: string, rule?: ScopeView['rule'], until?: number, scope?: string }}
 */
export const stateOf = (ledger, scopes) => {
  const views = scopes.flatMap((scope, index) => {
    const view = ledger.get(scope)
    if (view) return [{ scope, view }]
    return index === 0 ? [{ scope, view: /** @type {ScopeView} */ ({ state: 'unknown', rule: 'none', why: 'no reading', windows: [] }) }] : []
  })
  if (views.length === 0) return { state: 'unknown', why: 'no reading' }
  const state = views.map(entry => entry.view.state).reduce(worse)
  const holding = views.filter(entry => entry.view.state === state)
  const until = holding.every(entry => entry.view.until !== undefined) && (state === 'out' || state === 'busy')
    ? Math.max(...holding.map(entry => entry.view.until ?? 0)) : undefined
  const first = holding[0]
  return { state, why: first?.view.why ?? '', ...(first?.view.rule ? { rule: first.view.rule } : {}), ...(until === undefined ? {} : { until }),
    ...(first ? { scope: first.scope } : {}) }
}

/**
 * Pure. The wants a refresh should read now: none read in the last ACTIVE_EVERY_MS; of the rest, those with a scope
 * in use that no reading names from that long ago, a model's bucket gone stale, or no read for a day.
 * @param {readonly Want[]} wants @param {readonly unknown[]} files @param {number} now @returns {Want[]}
 */
export const due = (wants, files, now) => {
  /** @type {Map<string, number>} */
  const read = new Map()
  /** @type {Record<string, number>} */
  let reads = {}
  for (const raw of files) {
    const file = validFile(raw, now)
    if (!file) continue
    if (file.writer === 'active') reads = file.reads ?? {}
    for (const reading of file.readings) read.set(reading.scope, Math.max(read.get(reading.scope) ?? 0, reading.at))
  }
  const stale = scope => now - (read.get(scope) ?? -Infinity) > ACTIVE_EVERY_MS
  return wants.filter(want => {
    const last = reads[want.key]
    if (last !== undefined && now - last < ACTIVE_EVERY_MS) return false
    if (last === undefined || now - last > REDISCOVER_MS) return true
    return want.scopes.some(stale) || want.optional.some(scope => read.has(scope) && stale(scope))
  })
}

/** Pure. When nothing in a writer file can matter any more: its last exhaustion ended, its last window reset, its readings went stale. */
export const expiresAt = (file, now) => {
  const valid = validFile(file, now)
  if (!valid) return now
  return Math.max(valid.at + RULES.freshMs, ...valid.exhaustions.map(ex => ex.until),
    ...valid.readings.flatMap(reading => [reading.at + RULES.freshMs, ...reading.windows.map(window => window.resetsAt ?? 0)]))
}

/**
 * Pure. A writer's file with `readings` replacing its earlier readings of the same scopes and `exhaustions` added to
 * the ones still in force, as the writer saves it whole.
 * @param {unknown} file @param {string} writer @param {number} now
 * @param {{ readings?: readonly Reading[], exhaustions?: readonly Exhaustion[] }} added @returns {WriterFile}
 */
export const withObservations = (file, writer, now, added) => {
  const kept = validFile(file, now) ?? { schema: LEDGER_SCHEMA, writer, at: now, readings: [], exhaustions: [] }
  const replaced = new Set((added.readings ?? []).map(reading => reading.scope))
  return {
    schema: LEDGER_SCHEMA, writer, at: now,
    readings: [...kept.readings.filter(reading => !replaced.has(reading.scope)), ...added.readings ?? []],
    exhaustions: [...kept.exhaustions.filter(ex => ex.until > now), ...added.exhaustions ?? []],
  }
}
