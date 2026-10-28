import type { SeatVendor } from '../types/index'

export const SIZES = ['light', 'standard', 'heavy'] as const
export type Size = typeof SIZES[number]

export const FAMILIES = ['claude', 'gpt', 'gemini'] as const
export type Family = typeof FAMILIES[number] | 'other'

/** One place a seat can run: a CLI (or a Claude subagent), its model and effort; `account` runs Claude as a CLI on that other account. */
export type Candidate = { vendor: SeatVendor, model: string, effort: string, account?: string }

/** A candidate's load in percent: its worst 5-hour and weekly windows, and how much of that week has passed. */
export type Load = { fiveHour?: number, weekly?: number, weekElapsed?: number }

const VENDOR_NAMES: readonly string[] = ['codex', 'agy', 'claude']

/** The model's family by its name, whichever CLI serves it. */
export const familyOf = (candidate: Candidate): Family => {
  if (candidate.vendor === 'claude' || candidate.model.startsWith('claude')) return 'claude'
  if (candidate.model.startsWith('gpt')) return 'gpt'
  if (candidate.model.startsWith('gemini')) return 'gemini'
  return 'other'
}

/** A size setting: `<cli> <model> [effort]` entries separated by commas; an entry naming no known CLI is dropped. */
export const parseCandidates = (text: string): Candidate[] => text.split(',').flatMap(entry => {
  const [vendor, model, effort = ''] = entry.trim().split(/\s+/)
  return vendor && model && VENDOR_NAMES.includes(vendor) ? [{ vendor: vendor as SeatVendor, model, effort }] : []
})

export const formatCandidate = (candidate: Candidate): string =>
  [candidate.account ?? candidate.vendor, candidate.model, candidate.effort].filter(Boolean).join(' ')

// Words a seat line already gives a meaning, which no account may take.
export const RESERVED: readonly string[] = ['codex', 'agy', 'claude', 'gpt', 'gemini', 'other', 'light', 'standard', 'heavy', 'reviewer', 'owner']

/** The other Claude accounts setting: `<name> <config folder>` entries separated by commas; a reserved or repeated name is dropped. */
export const parseAccounts = (text: string): Record<string, string> => {
  const accounts: Record<string, string> = {}
  for (const entry of text.split(',')) {
    const match = /^\s*([\w-]+)\s+(.+?)\s*$/.exec(entry)
    if (!match?.[1] || !match[2] || RESERVED.includes(match[1]) || match[1] in accounts) continue
    accounts[match[1]] = match[2]
  }
  return accounts
}

/** The size an explicit effort stands for, so an explicit seat falls back within that size. */
export const sizeOf = (effort: string): Size =>
  effort === 'low' || effort === 'medium' ? 'light' : effort === 'high' ? 'standard' : 'heavy'

/** Busy: a window at or past `busyAt`, or the week used faster than it has passed. */
export const isBusy = (load: Load, busyAt: number): boolean =>
  (load.fiveHour ?? 0) >= busyAt || (load.weekly ?? 0) >= busyAt
  || (load.weekly !== undefined && load.weekElapsed !== undefined && load.weekly > load.weekElapsed)

/** Why a load is busy, as fallback trails name it: the window at or past `busyAt`, else the week used faster than it has passed. */
export const busyReason = (load: Load, busyAt: number): string => {
  const percent = (value: number): string => Math.round(value) + '%'
  if ((load.fiveHour ?? 0) >= busyAt) return '5h ' + percent(load.fiveHour ?? 0) + ' used'
  if ((load.weekly ?? 0) >= busyAt) return '7d ' + percent(load.weekly ?? 0) + ' used'
  // Rounded apart, so a week used only just faster than it passed still reads as ahead.
  return '7d ' + Math.ceil(load.weekly ?? 0) + '% used, ' + Math.floor(load.weekElapsed ?? 0) + '% of the week passed'
}

export const pressure = (load: Load): number => Math.max(load.fiveHour ?? 0, load.weekly ?? 0)

/** Whether a candidate is the CLI or family a seat line asked for. */
export const isPreferred = (candidate: Candidate, prefer: string): boolean =>
  candidate.vendor === prefer || familyOf(candidate) === prefer

/**
 * The index of the candidate to run among those not out: the first that is not
 * busy, else the least loaded; -1 when every one is out.
 */
export const pick = (loads: ReadonlyArray<Load | 'out'>, busyAt: number): number => {
  let least = -1
  for (const [index, load] of loads.entries()) {
    if (load === 'out') continue
    if (!isBusy(load, busyAt)) return index
    const current = loads[least]
    if (least === -1 || (current !== 'out' && current !== undefined && pressure(load) < pressure(current))) least = index
  }
  return least
}

/** Seats running now in each family, Claude subagents counted as claude. */
export type Running = Partial<Record<Family, number>>

/**
 * A sized seat's order across families: of the families with a candidate that
 * is neither out nor busy, the one with the fewest seats running goes first
 * (ties to the family listed first), led by its first such candidate; the other
 * families follow, fewest running first. Indexes into the chain; empty when every
 * family is out or busy.
 */
export const rotate = (chain: readonly Candidate[], loads: ReadonlyArray<Load | 'out'>, running: Running, busyAt: number): number[] => {
  const families: Family[] = []
  for (const candidate of chain) if (!families.includes(familyOf(candidate))) families.push(familyOf(candidate))
  const free = (index: number): boolean => {
    const load = loads[index]
    return load !== undefined && load !== 'out' && !isBusy(load, busyAt)
  }
  const members = (family: Family): number[] => chain.flatMap((candidate, index) => familyOf(candidate) === family ? [index] : [])
  const byRunning = (list: Family[]): Family[] => [...list].sort((a, b) => (running[a] ?? 0) - (running[b] ?? 0))
  const lead = byRunning(families.filter(family => members(family).some(free)))[0]
  if (lead === undefined) return []
  const first = members(lead).find(free) as number
  return [
    first, ...members(lead).filter(index => index !== first),
    ...byRunning(families.filter(family => family !== lead)).flatMap(members),
  ]
}

/** A model a CLI reports, with the efforts it takes. */
export type CliModel = { model: string, efforts: string[], isDefault?: boolean }
export type CliModels = { codex?: CliModel[], agy?: CliModel[] }

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
// codex ships its default model at low effort; each size steps up from there.
const SIZE_EFFORT: Record<Size, string> = { light: 'low', standard: 'medium', heavy: 'high' }
// The Claude model agy serves for each size, by name prefix: Claude's family through its own quota.
const AGY_CLAUDE_BY_SIZE: Record<Size, string> = { light: 'claude-sonnet', standard: 'claude-sonnet', heavy: 'claude-opus' }
const CLAUDE_BY_SIZE: Record<Size, Candidate> = {
  light: { vendor: 'claude', model: 'sonnet', effort: 'high' },
  standard: { vendor: 'claude', model: 'opus', effort: 'medium' },
  heavy: { vendor: 'claude', model: 'opus', effort: 'high' },
}

/** The size's Claude model and effort, run on another account. */
export const accountCandidate = (size: Size, account: string): Candidate => ({ ...CLAUDE_BY_SIZE[size], account })

/** `agy models` lines are `<model>-<effort>\t<name>`: one model per base, with its efforts. */
export const parseAgyModels = (text: string): CliModel[] => {
  const models: CliModel[] = []
  for (const line of text.split('\n')) {
    const id = line.split('\t')[0]?.trim() ?? ''
    const match = /^(.+)-(low|medium|high|xhigh|max)$/.exec(id)
    if (!match?.[1] || !match[2]) continue
    const found = models.find(entry => entry.model === match[1])
    if (found) found.efforts.push(match[2])
    else models.push({ model: match[1], efforts: [match[2]] })
  }
  return models
}

/** The wanted effort when the model takes it, else the highest it takes below it, else its lowest. */
export const clampEffort = (wanted: string, efforts: readonly string[]): string => {
  if (efforts.includes(wanted)) return wanted
  const below = EFFORTS.slice(0, EFFORTS.indexOf(wanted)).filter(effort => efforts.includes(effort))
  return below.at(-1) ?? efforts[0] ?? wanted
}

/**
 * A size's candidates when its setting is `auto`: codex's default model, agy's
 * Gemini Flash, then Claude, then agy's Claude, each at the size's effort as far
 * as the model takes it.
 */
export const autoCandidates = (size: Size, models: CliModels): Candidate[] => {
  const codex = models.codex?.find(entry => entry.isDefault) ?? models.codex?.[0]
  const agy = models.agy?.find(entry => entry.model.startsWith('gemini') && entry.model.includes('flash'))
  const agyClaude = models.agy?.find(entry => entry.model.startsWith(AGY_CLAUDE_BY_SIZE[size]))
  return [
    ...(codex ? [{ vendor: 'codex' as const, model: codex.model, effort: clampEffort(SIZE_EFFORT[size], codex.efforts) }] : []),
    ...(agy ? [{ vendor: 'agy' as const, model: agy.model, effort: clampEffort(SIZE_EFFORT[size], agy.efforts) }] : []),
    CLAUDE_BY_SIZE[size],
    ...(agyClaude ? [{ vendor: 'agy' as const, model: agyClaude.model, effort: clampEffort(SIZE_EFFORT[size], agyClaude.efforts) }] : []),
  ]
}

export const isAuto = (setting: string): boolean => setting.trim().toLowerCase() === 'auto'
