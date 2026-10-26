import type { SeatVendor } from '../types/index'

export const SIZES = ['light', 'standard', 'heavy'] as const
export type Size = typeof SIZES[number]

export const FAMILIES = ['claude', 'gpt', 'gemini'] as const
export type Family = typeof FAMILIES[number] | 'other'

/** One place a seat can run: a CLI (or a Claude subagent), its model and effort. */
export type Candidate = { vendor: SeatVendor, model: string, effort: string }

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
  [candidate.vendor, candidate.model, candidate.effort].filter(Boolean).join(' ')

/** The size an explicit effort stands for, so an explicit seat falls back within that size. */
export const sizeOf = (effort: string): Size =>
  effort === 'low' || effort === 'medium' ? 'light' : effort === 'high' ? 'standard' : 'heavy'

/** Busy: a window at or past `busyAt`, or the week used faster than it has passed. */
export const isBusy = (load: Load, busyAt: number): boolean =>
  (load.fiveHour ?? 0) >= busyAt || (load.weekly ?? 0) >= busyAt
  || (load.weekly !== undefined && load.weekElapsed !== undefined && load.weekly > load.weekElapsed)

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

/** A model a CLI reports, with the efforts it takes. */
export type CliModel = { model: string, efforts: string[], isDefault?: boolean }
export type CliModels = { codex?: CliModel[], agy?: CliModel[] }

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
// codex ships its default model at low effort; each size steps up from there.
const SIZE_EFFORT: Record<Size, string> = { light: 'low', standard: 'medium', heavy: 'high' }
const CLAUDE_BY_SIZE: Record<Size, Candidate> = {
  light: { vendor: 'claude', model: 'sonnet', effort: 'high' },
  standard: { vendor: 'claude', model: 'opus', effort: 'medium' },
  heavy: { vendor: 'claude', model: 'opus', effort: 'high' },
}

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
 * Gemini Flash, then Claude, each at the size's effort as far as the model takes it.
 */
export const autoCandidates = (size: Size, models: CliModels): Candidate[] => {
  const codex = models.codex?.find(entry => entry.isDefault) ?? models.codex?.[0]
  const agy = models.agy?.find(entry => entry.model.startsWith('gemini') && entry.model.includes('flash'))
  return [
    ...(codex ? [{ vendor: 'codex' as const, model: codex.model, effort: clampEffort(SIZE_EFFORT[size], codex.efforts) }] : []),
    ...(agy ? [{ vendor: 'agy' as const, model: agy.model, effort: clampEffort(SIZE_EFFORT[size], agy.efforts) }] : []),
    CLAUDE_BY_SIZE[size],
  ]
}

export const isAuto = (setting: string): boolean => setting.trim().toLowerCase() === 'auto'
