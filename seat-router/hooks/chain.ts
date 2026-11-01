import type { SeatVendor } from '../types/index'
import { ADAPTERS, familyOf as familyOfCandidate } from '../bin/vendors/index.mjs'

export const SIZES = ['light', 'standard', 'heavy'] as const
export type Size = typeof SIZES[number]

export const FAMILIES = ['claude', 'gpt', 'gemini'] as const
export type Family = typeof FAMILIES[number] | 'other'

export type Candidate = { vendor: SeatVendor, model: string, effort: string, account?: string }

const VENDOR_NAMES: readonly string[] = Object.keys(ADAPTERS)

/** The model's family by its name, whichever CLI serves it. */
export const familyOf = (candidate: Candidate): Family => familyOfCandidate(candidate)

/** A size setting: `<cli> <model> [effort]` entries separated by commas; an entry naming no known CLI is dropped. */
export const parseCandidates = (text: string): Candidate[] => text.split(',').flatMap(entry => {
  const [vendor, model, effort = ''] = entry.trim().split(/\s+/)
  return vendor && model && VENDOR_NAMES.includes(vendor) ? [{ vendor: vendor as SeatVendor, model, effort }] : []
})

export const formatCandidate = (candidate: Candidate): string =>
  [candidate.account ?? candidate.vendor, candidate.model, candidate.effort].filter(Boolean).join(' ')

// Words a seat line or the jobs setting already gives a meaning, which no account may take.
export const RESERVED: readonly string[] = ['codex', 'agy', 'claude', 'gpt', 'gemini', 'other', 'light', 'standard', 'heavy', 'reviewer', 'owner', 'session', 'default']

/**
 * The other Claude accounts setting: `<name> <config folder>` entries separated by commas; a reserved or repeated name,
 * or one of the jobs, is dropped, so an account never shadows a job's entry.
 */
export const parseAccounts = (text: string, jobs: readonly string[]): Record<string, string> => {
  const accounts: Record<string, string> = {}
  for (const entry of text.split(',')) {
    const match = /^\s*([\w-]+)\s+(.+?)\s*$/.exec(entry)
    if (!match?.[1] || !match[2] || RESERVED.includes(match[1]) || jobs.includes(match[1]) || match[1] in accounts) continue
    accounts[match[1]] = match[2]
  }
  return accounts
}

/** The size an explicit effort stands for, so an explicit seat falls back within that size. */
export const sizeOf = (effort: string): Size =>
  effort === 'low' || effort === 'medium' ? 'light' : effort === 'high' ? 'standard' : 'heavy'

/** A model a CLI reports, with the efforts it takes. */
export type CliModel = { model: string, efforts: string[], isDefault?: boolean }
export type CliModels = { codex?: CliModel[], agy?: CliModel[] }

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
// codex ships its default model at low effort; each size steps up from there.
const SIZE_EFFORT: Record<Size, string> = { light: 'low', standard: 'medium', heavy: 'high' }
const AGY_CLAUDE_BY_SIZE: Record<Size, string> = { light: 'claude-sonnet', standard: 'claude-sonnet', heavy: 'claude-opus' }
const CLAUDE_BY_SIZE: Record<Size, Candidate> = {
  light: { vendor: 'claude', model: 'sonnet', effort: 'high' },
  standard: { vendor: 'claude', model: 'opus', effort: 'medium' },
  heavy: { vendor: 'claude', model: 'opus', effort: 'high' },
}

/** The size's Claude model and effort, run on another account. */
export const accountCandidate = (size: Size, account: string): Candidate => ({ ...CLAUDE_BY_SIZE[size], account })

export const floorCandidate = (size: Size): Candidate => CLAUDE_BY_SIZE[size]

/** The wanted effort when the model takes it, else the highest it takes below it, else its lowest. */
export const clampEffort = (wanted: string, efforts: readonly string[]): string => {
  if (efforts.includes(wanted)) return wanted
  const below = EFFORTS.slice(0, EFFORTS.indexOf(wanted)).filter(effort => efforts.includes(effort))
  return below.at(-1) ?? efforts[0] ?? wanted
}

/**
 * A size's candidates when its setting is `auto`: codex's default model, agy's
 * Gemini Flash and Argon, then Claude, then agy's Claude, each at the size's
 * effort as far as the model takes it.
 */
export const autoCandidates = (size: Size, models: CliModels): Candidate[] => {
  const codex = models.codex?.find(entry => entry.isDefault) ?? models.codex?.[0]
  const gemini = ['flash', 'argon'].flatMap(name => models.agy?.find(entry => entry.model.startsWith('gemini') && entry.model.includes(name)) ?? [])
  const agyClaude = models.agy?.find(entry => entry.model.startsWith(AGY_CLAUDE_BY_SIZE[size]))
  return [
    ...(codex ? [{ vendor: 'codex' as const, model: codex.model, effort: clampEffort(SIZE_EFFORT[size], codex.efforts) }] : []),
    ...gemini.map(agy => ({ vendor: 'agy' as const, model: agy.model, effort: clampEffort(SIZE_EFFORT[size], agy.efforts) })),
    CLAUDE_BY_SIZE[size],
    ...(agyClaude ? [{ vendor: 'agy' as const, model: agyClaude.model, effort: clampEffort(SIZE_EFFORT[size], agyClaude.efforts) }] : []),
  ]
}

export const isAuto = (setting: string): boolean => setting.trim().toLowerCase() === 'auto'
