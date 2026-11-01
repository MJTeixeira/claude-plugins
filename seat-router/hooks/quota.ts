import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { SeatQuotaDisplay, SeatVendor } from '../types/index'
import { ADAPTERS } from '../bin/vendors/index.mjs'
import { LEDGER_SCHEMA, RULES, composedRecently, due, merge, stateOf } from '../bin/core/ledger.mjs'
import { rank } from '../bin/core/rank.mjs'
import { firstRank, matchWord, onlyText } from '../bin/core/policy.mjs'
import { clockTime } from './art'
import { familyOf } from './chain'
import type { Candidate } from './chain'
import { homeDir, join, seatHome, slashed } from './layout'
import type { CandidateSet, Delegate, ExternalVendor, Initial, Marker, Match, QuotaState } from './router'
import { FACTS } from '../bin/vendors/index.mjs'

type WindowView = { id: string, usedPct: number, state: QuotaState }
type ScopeView = { state: QuotaState, why: string, rule?: string, until?: number, at?: number, source?: string, windows: WindowView[] }
type Ledger = Map<string, ScopeView>
type Standing = { state: QuotaState, why: string, rule?: string, until?: number, scope?: string }
type Want = { key: string, vendor: SeatVendor, scopes: string[], optional: string[], dir?: string, accountKey?: string }

const quotasState = atom({ plugin: 'seat-router', key: 'quotas' } as const, {}, { shape: 'quota-states-1' })

async function quotaDir($: EngineInterface): Promise<string> {
  return join(await seatHome($), 'quota')
}

async function jsonFiles($: EngineInterface, dir: string): Promise<unknown[]> {
  let names: string[]
  try {
    names = (await $.fs.list(dir)).filter(entry => entry.kind === 'file' && entry.name.endsWith('.json')).map(entry => entry.name)
  } catch {
    return []
  }
  const read = await Promise.all(names.map(async name => {
    try { return JSON.parse(await $.fs.read(join(dir, name))) as unknown } catch { return undefined }
  }))
  return read.filter(file => file !== undefined)
}

/** Every writer's quota file on this machine, as written; the ledger validates them. */
export async function quotaFiles($: EngineInterface): Promise<unknown[]> {
  return jsonFiles($, await quotaDir($))
}

export async function ledgerNow($: EngineInterface, busyAt: number): Promise<Ledger> {
  return merge(await quotaFiles($), await $.clock.now(), busyAt) as Ledger
}

async function sessionConfigDir($: EngineInterface): Promise<string> {
  return slashed(await $.env.get('CLAUDE_CONFIG_DIR') ?? (slashed(await homeDir($) ?? '') + '/.claude'))
}

async function accountKeyOf($: EngineInterface, dir: string): Promise<string> {
  const real = await $.fs.stat(dir, { resolve: true }).then(stat => stat.realPath, () => undefined)
  return ADAPTERS.claude.accountKey(real ?? dir)
}

export async function sessionAccountKey($: EngineInterface): Promise<string> {
  return accountKeyOf($, await sessionConfigDir($))
}

async function scopesFor($: EngineInterface, candidate: Candidate, accounts: Record<string, string>): Promise<string[]> {
  if (candidate.vendor !== 'claude') return ADAPTERS[candidate.vendor].scopesOf(candidate)
  const dir = candidate.account === undefined ? await sessionConfigDir($) : accounts[candidate.account] ?? ''
  return ADAPTERS.claude.scopesOf(candidate, await accountKeyOf($, dir))
}

/** Seats running on this machine, by model family, from the live index; `except` leaves one seat out. */
export async function liveFamilies($: EngineInterface, except?: string): Promise<Record<string, number>> {
  const live = await jsonFiles($, join(await seatHome($), 'live'))
  const counts: Record<string, number> = {}
  for (const entry of live as Array<{ id?: unknown, vendor?: unknown, model?: unknown }>) {
    if (entry?.id === except || typeof entry?.vendor !== 'string' || !(entry.vendor in ADAPTERS)) continue
    const family = familyOf({ vendor: entry.vendor as SeatVendor, model: String(entry.model ?? ''), effort: '' })
    counts[family] = (counts[family] ?? 0) + 1
  }
  return counts
}

const nameOf = (candidate: Candidate): string => (candidate.account ?? candidate.vendor) + ' ' + candidate.model

async function isFolder($: EngineInterface, dir: string): Promise<boolean> {
  return dir !== '' && await $.fs.stat(dir).then(stat => stat.kind === 'dir', () => false)
}

/**
 * The pick, from files alone: the line's candidates that can run here, each with the quota it stands at in the merged
 * ledger, ranked; or the refusal when none can run here, or every one is out (naming the earliest reset: the pick
 * never waits).
 */
export async function decide($: EngineInterface, marker: Marker, set: Extract<CandidateSet, { kind: 'ok' }>,
  settings: { busyAt: number, accounts: Record<string, string>, installed: readonly SeatVendor[] }): Promise<Initial | string> {
  const trail: string[] = []
  const chain: Candidate[] = []
  const listed = set.candidates
  for (const candidate of listed) {
    const dir = candidate.account === undefined ? undefined : settings.accounts[candidate.account] ?? ''
    const missing = !settings.installed.includes(candidate.vendor) ? 'not installed'
      : dir !== undefined && !await isFolder($, dir) ? 'no folder ' + (dir || '(unset)') : undefined
    if (missing) trail.push(nameOf(candidate) + ' cannot run here (' + missing + ')')
    else chain.push(candidate)
  }
  if (chain.length === 0) return 'seat-router refused this seat: none of its candidates can run on this machine (' + trail.join('; ') + '), so nothing runs for this call.'
  const now = await $.clock.now()
  const scopes = await Promise.all(chain.map(candidate => scopesFor($, candidate, settings.accounts)))
  const ledger = await ledgerNow($, settings.busyAt)
  const standings = scopes.map(list => stateOf(ledger, list) as Standing)
  const pinned = ('vendor' in marker || ('account' in marker && marker.account !== undefined)) && chain[0] === listed[0]
  const live = await liveFamilies($)
  const options = chain.map((candidate, index) => ({
    state: standings[index]?.state ?? 'unknown', family: familyOf(candidate), firstRank: firstRank(candidate, set.firsts, FACTS),
  }))
  const order = rank(options, { tier: marker.tier, pinned, live })
  const position = order[0]
  if (position === undefined) {
    const resets = standings.flatMap(standing => standing.until === undefined ? [] : [standing.until])
    const each = chain.map((candidate, index) => nameOf(candidate) + (standings[index]?.until === undefined ? '' : ' until ' + clockTime(standings[index]?.until ?? 0, now))
      + ' (' + (standings[index]?.why ?? '') + ')')
    return 'seat-router refused this seat: every candidate is out of quota (' + each.join('; ') + ')'
      + (resets.length ? ', the first back at ' + clockTime(Math.min(...resets), now) : '')
      + (set.only.length ? '; ' + onlyText(marker.job, set.only) : '') + ', so nothing runs for this call.'
  }
  const chosen = options[position]
  for (const [index, candidate] of chain.entries()) {
    if (index === position) break
    const standing = standings[index]
    const option = options[index]
    if (!standing || !option) continue
    if (standing.state !== chosen.state) trail.push(nameOf(candidate) + ' ' + standing.state + ' (' + standing.why + ')')
    else if (option.firstRank > chosen.firstRank) {
      trail.push(nameOf(candidate) + ' passed over (job ' + marker.job + ' tries ' + matchWord(set.firsts[chosen.firstRank] as Match) + ' first)')
    } else {
      const [runs, chosenRuns] = [live[option.family] ?? 0, live[chosen.family] ?? 0]
      trail.push(nameOf(candidate) + ' passed over (' + option.family + ' runs ' + runs + ', ' + chosen.family + ' runs ' + chosenRuns + ')')
    }
  }
  return { chain, position, trail, scopes, ranked: standings.map(standing => standing.state), pinned, firstRanks: options.map(option => option.firstRank) }
}

/** Why code work goes to owner seats now, or undefined while it stays on Claude: the session account's state, as routing reads it. */
export async function delegateReason($: EngineInterface, setting: Delegate, busyAt: number): Promise<string | undefined> {
  if (setting === 'on') return 'set to on'
  if (setting === 'off') return undefined
  const state = stateOf(await ledgerNow($, busyAt), ADAPTERS.claude.bandScopes(await sessionAccountKey($))).state as QuotaState
  return state === 'busy' || state === 'out' ? 'Claude\'s quota is ' + state : undefined
}

export async function writeSessionQuota($: EngineInterface, rateLimits: ReadonlyArray<{ kind: string, percentUsed: number, resetsAt?: string }>): Promise<void> {
  const windows = ADAPTERS.claude.sessionWindows(rateLimits)
  if (windows.length === 0) return
  const [now, id, key] = [await $.clock.now(), await $.session.id(), await sessionAccountKey($)]
  const writer = 'session-' + id
  const scope = ADAPTERS.claude.bandScopes(key)[0] ?? ''
  await $.fs.write(join(await quotaDir($), writer + '.json'), JSON.stringify({
    schema: LEDGER_SCHEMA, writer, at: now, readings: [{ scope, at: now, windows }], exhaustions: [],
  }))
}

export async function refreshBand($: EngineInterface, vendors: readonly ExternalVendor[], busyAt: number): Promise<void> {
  const now = await $.clock.now()
  const ledger = merge(await quotaFiles($), now, busyAt) as Ledger
  const key = await sessionAccountKey($)
  const shown: SeatVendor[] = ['claude', ...vendors]
  const quotas = Object.fromEntries(shown.map(vendor => {
    const scopes = vendor === 'claude' ? ADAPTERS.claude.bandScopes(key) : ADAPTERS[vendor].bandScopes()
    const standing = stateOf(ledger, scopes) as Standing
    const windows = (ledger.get(scopes[0] ?? '')?.windows ?? []).map(window => ({ id: window.id, used: window.usedPct, state: window.state }))
    const back = standing.state === 'out' && standing.until !== undefined ? { back: clockTime(standing.until, now) } : {}
    const display: SeatQuotaDisplay = { vendor, state: standing.state, ...back, windows }
    return [vendor, display]
  }))
  await update($, quotasState, () => quotas)
}

const RULE_TEXT: Record<string, string> = {
  exhaustion: 'its own run hit the limit', out: 'a window at ' + RULES.outPct + '% or more', busyAt: 'a window at busyAt or more',
  pace: 'a window of ' + RULES.paceMinutes / 1440 + ' days or more used over ' + RULES.paceMargin + ' points ahead of its time',
  stale: 'its reading is over ' + RULES.freshMs / 60_000 + ' minutes old', reset: 'every window it read has reset', none: '',
}

export async function quotaLines($: EngineInterface, busyAt: number): Promise<string[]> {
  return quotaLinesOf(await quotaFiles($), await $.clock.now(), busyAt)
}

export const quotaLinesOf = (files: readonly unknown[], now: number, busyAt: number): string[] => {
  const ledger = merge(files, now, busyAt) as Ledger
  const lines = ['Quota rules: busy at ' + busyAt + '% (busyAt), out at ' + RULES.outPct + '%; a window of ' + RULES.paceMinutes / 1440
    + ' days or more is busy when its use runs more than ' + RULES.paceMargin + ' points ahead of the time passed; a reading under busyAt counts for '
    + RULES.freshMs / 60_000 + ' minutes, one at or over it until its window resets.']
  for (const [scope, view] of [...ledger.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const until = view.until === undefined ? '' : ' until ' + clockTime(view.until, now)
    const rule = view.rule && RULE_TEXT[view.rule] ? ', because ' + RULE_TEXT[view.rule] : ''
    const age = view.at === undefined ? '' : ', ' + Math.round((now - view.at) / 60_000) + ' min old'
    lines.push(scope + ': ' + view.state + until + ' (' + view.why + rule + '), from ' + (view.source ?? 'nobody') + age)
  }
  const active = (files as Array<{ writer?: unknown, failures?: Array<{ vendor?: unknown, at?: unknown, detail?: unknown }> }>).find(file => file?.writer === 'active')
  for (const failure of active?.failures ?? []) {
    if (typeof failure?.vendor === 'string' && typeof failure.at === 'number') lines.push(failure.vendor + ' quota unreadable at ' + clockTime(failure.at, now) + ': ' + String(failure.detail ?? ''))
  }
  return lines
}

const isSessionOwnAccount = (candidate: Candidate, dir: string | undefined): boolean => candidate.vendor === 'claude' && dir === undefined

async function wantsOf($: EngineInterface, candidates: readonly Candidate[], accounts: Record<string, string>): Promise<Want[]> {
  const wants = new Map<string, Want>()
  for (const candidate of candidates) {
    const dir = candidate.account === undefined ? undefined : accounts[candidate.account]
    if (isSessionOwnAccount(candidate, dir)) continue
    const key = candidate.vendor !== 'claude' ? candidate.vendor : 'claude:' + candidate.account
    const [first, ...rest] = await scopesFor($, candidate, accounts)
    const accountKey = candidate.vendor === 'claude' && dir !== undefined ? await accountKeyOf($, dir) : undefined
    const want = wants.get(key) ?? { key, vendor: candidate.vendor, scopes: [], optional: [],
      ...(dir === undefined ? {} : { dir }), ...(accountKey === undefined ? {} : { accountKey }) }
    if (first && !want.scopes.includes(first)) want.scopes.push(first)
    for (const scope of rest) if (!want.optional.includes(scope)) want.optional.push(scope)
    wants.set(key, want)
  }
  return [...wants.values()]
}

function composedFile(dir: string): string {
  return join(dir, 'composed')
}

export async function noteComposed($: EngineInterface): Promise<void> {
  await $.fs.write(composedFile(await quotaDir($)), String(await $.clock.now()))
}

export async function refreshQuotas($: EngineInterface, candidates: readonly Candidate[], accounts: Record<string, string>): Promise<void> {
  const now = await $.clock.now()
  const composed = Number(await $.fs.read(composedFile(await quotaDir($))).catch(() => ''))
  if (!composedRecently(composed, now)) return
  const wants = await wantsOf($, candidates, accounts)
  const stale = due(wants, await quotaFiles($), now)
  if (stale.length === 0) return
  await $.process.run(['node', join($.plugin.root, 'bin', 'refresh-quota.mjs'), await seatHome($)], { stdin: JSON.stringify({ wants: stale }), timeoutMs: 180_000 })
}

