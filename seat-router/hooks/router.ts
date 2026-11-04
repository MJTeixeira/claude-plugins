import { atom, read, update } from 'claude-code'
import type { EngineInterface, ToolCallInput } from 'claude-code'
import type { SeatDisplay, SeatStatus, SeatTier, SeatVendor } from '../types/index'
import { ADAPTERS, EXPLICIT_VENDORS, FACTS } from '../bin/vendors/index.mjs'
import { accountCandidate, autoCandidates, familyOf, FAMILIES, floorCandidate, formatCandidate, isAuto, parseAccounts, parseCandidates, RESERVED, SIZES, sizeOf } from './chain'
import type { Candidate, CliModel, CliModels, Size } from './chain'
import { homeDir, join, osOf, seatHome, slashed } from './layout'
import { isSeatId, seatDir as seatDirOf } from '../bin/core/layout.mjs'
import { candidateSet, DEFAULT_JOB, jobWords, parseJobs } from '../bin/core/policy.mjs'
import { acceptRefused, boundSeats, deliverMail, lineage, pickSeat } from './delivery'

const EXTERNAL_VENDORS = EXPLICIT_VENDORS as ExternalVendor[]
export const TIERS = ['reviewer', 'owner'] as const
const EXPLICIT = new RegExp('^seat: (' + EXTERNAL_VENDORS.join('|') + ') (\\S+) (\\S+) (reviewer|owner)(?: (\\S+))?(?:\\r?\\n|$)')
const SIZED = /^seat: (?:([\w-]+) )?(light|standard|heavy) (reviewer|owner)(?: (\S+))?(?:\r?\n|$)/

const seatsState = atom({ plugin: 'seat-router', key: 'seats' } as const, [], {
  shape: 'seat-display-3',
})
const vendorsState = atom({ plugin: 'seat-router', key: 'vendors' } as const, null as ExternalVendor[] | null, {
  shape: 'installed-vendors-1',
})
const modelsState = atom({ plugin: 'seat-router', key: 'models' } as const, null as CliModels | null, {
  shape: 'cli-models-1',
})
type AgentInput = Extract<ToolCallInput, { tool: 'Agent' }>
export type ExternalVendor = Exclude<SeatVendor, 'claude'>

// Each size's setting (`auto`, or a list of candidates), the busy threshold,
// when code work goes to owner seats and the other Claude accounts (name to
// config folder), from the plugin's userConfig.
export type Delegate = 'auto' | 'on' | 'off'
export type Match = { cli: string } | { family: string } | { account: string } | { model: string }
export type JobPolicy = { needs: readonly string[], only: readonly Match[], not: readonly Match[], first: readonly Match[], description?: string }
export type Policies = Readonly<Record<string, JobPolicy>>
export type Jobs = { setting: string, policies: Policies, problems: string[] }
export type SeatConfig = { minFreeDiskGiB?: number, sizes: Record<Size, string>, busyAt: number, delegate: Delegate, accounts: Record<string, string>, jobs: Jobs }
export type CandidateSet = { kind: 'ok', candidates: Candidate[], firsts: readonly Match[], only: readonly Match[] } | { kind: 'empty', reason: string }

export const jobsOf = (setting: string, accounts: Record<string, string>): Jobs => ({
  setting,
  ...parseJobs(setting, { clis: EXTERNAL_VENDORS, families: [...FAMILIES, 'other'], accounts: Object.keys(accounts), sizes: SIZES, tiers: TIERS }) as Omit<Jobs, 'setting'>,
})

let seatConfig: SeatConfig = { sizes: { light: 'auto', standard: 'auto', heavy: 'auto' }, busyAt: 80, delegate: 'auto', accounts: {}, jobs: jobsOf('', {}) }

export function setSeatConfig(config: SeatConfig): void {
  seatConfig = config
}

export function setSize(size: Size, setting: string): void {
  seatConfig = { ...seatConfig, sizes: { ...seatConfig.sizes, [size]: setting } }
}

export function seatConfigFrom(options: Readonly<Record<string, unknown>>): SeatConfig {
  const sizes = Object.fromEntries(SIZES.map(size => [size, String(options[size + 'Seats'] ?? 'auto')])) as Record<Size, string>
  const setting = String(options.jobs ?? '')
  const accounts = parseAccounts(String(options.claudeAccounts ?? ''), Object.keys(jobsOf(setting, {}).policies))
  return {
    minFreeDiskGiB: typeof options.minFreeDiskGiB === 'number' ? options.minFreeDiskGiB : 10,
    sizes, busyAt: typeof options.busyAt === 'number' ? options.busyAt : 80, delegate: delegateOf(options.delegate),
    accounts, jobs: jobsOf(setting, accounts),
  }
}

export const accountNames = (): string[] => Object.keys(seatConfig.accounts)

export function setAccounts(accounts: Record<string, string>): void {
  seatConfig = { ...seatConfig, accounts, jobs: jobsOf(seatConfig.jobs.setting, accounts) }
}

export const seatJobs = (): Jobs => seatConfig.jobs

export const jobNames = (): string[] => Object.keys(seatConfig.jobs.policies)

export function setJobs(jobs: Jobs): void {
  seatConfig = { ...seatConfig, jobs }
}

export const formatAccounts = (accounts: Record<string, string>): string =>
  Object.entries(accounts).map(([name, dir]) => name + ' ' + dir).join(', ')

export const accountSetting = (): string => formatAccounts(seatConfig.accounts)

export type FoundAccount = { name: string, dir: string, plan?: string }

// The Claude config folders in the home folder besides the session's own
// (`~/.claude-<name>` holding a `.claude.json`), each with the plan a quota read
// reports, or no plan when the read fails: not logged in.
export async function foundAccounts($: EngineInterface): Promise<FoundAccount[]> {
  const found = await homeDir($)
  if (found === undefined) return []
  const home = slashed(found)
  const own = slashed(await $.env.get('CLAUDE_CONFIG_DIR') ?? '').replace(/\/+$/, '')
  let entries: Awaited<ReturnType<EngineInterface['fs']['list']>>
  try {
    entries = await $.fs.list(home)
  } catch {
    return []
  }
  const named = entries.flatMap(entry => {
    const name = /^\.claude-([\w-]+)$/.exec(entry.name)?.[1]
    return entry.kind === 'dir' && name !== undefined && !RESERVED.includes(name) && !jobNames().includes(name) && home + '/' + entry.name !== own ? [{ name, folder: entry.name }] : []
  })
  const accounts = await Promise.all(named.map(async ({ name, folder }): Promise<FoundAccount | undefined> => {
    const path = home + '/' + folder
    if (!await $.fs.exists(path + '/.claude.json')) return undefined
    const read = await accountUsage($, path)
      .catch(() => undefined)
    if (read?.exitCode !== 0) return { name, dir: '~/' + folder }
    const plan = asObject(readJson(read.stdout))?.plan
    return { name, dir: '~/' + folder, plan: typeof plan === 'string' ? plan : 'unknown plan' }
  }))
  return accounts.filter((account): account is FoundAccount => account !== undefined).sort((a, b) => a.name.localeCompare(b.name))
}

export const delegateOf = (value: unknown): Delegate => value === 'on' || value === 'off' ? value : 'auto'

export function setDelegate(delegate: Delegate): void {
  seatConfig = { ...seatConfig, delegate }
}

export const delegateSetting = (): Delegate => seatConfig.delegate

export const busyAtSetting = (): number => seatConfig.busyAt

// The models each installed CLI reports, asked once a session; a CLI that cannot answer offers none.
export async function cliModels($: EngineInterface): Promise<CliModels> {
  const known = await read($, modelsState)
  if (known) return known
  const vendors = await installedVendors($)
  const ask = async (vendor: ExternalVendor): Promise<CliModel[] | undefined> => {
    const models = ADAPTERS[vendor].models
    if (!vendors.includes(vendor) || !models) return undefined
    try {
      const listed = await runTool($, models.run, { timeoutMs: 60_000 })
      return listed.exitCode === 0 ? models.parse(listed.stdout) : undefined
    } catch {
      return undefined
    }
  }
  const [codex, agy] = await Promise.all([ask('codex'), ask('agy')])
  const models: CliModels = { ...(codex ? { codex } : {}), ...(agy ? { agy } : {}) }
  await update($, modelsState, () => models)
  return models
}

/** A size's candidates: built from the CLIs' models when its setting is `auto`, else the listed ones. */
export async function sizeCandidates($: EngineInterface, size: Size): Promise<Candidate[]> {
  const setting = seatConfig.sizes[size]
  return isAuto(setting) ? autoCandidates(size, await cliModels($)) : parseCandidates(setting)
}

/** An explicit line names the model and effort; a sized one leaves them to the size's candidates. */
export type Marker = {
  tier: SeatTier
  job: string
  brief: string
} & ({ vendor: ExternalVendor, model: string, effort: string } | { size: Size, prefer?: string, account?: string })

export type QuotaState = 'free' | 'unknown' | 'busy' | 'out'

/**
 * What the pick decided: the line's candidates that can run here, in list order (`chain`), the one to start
 * (`position`), what was passed over and why (`trail`), each candidate's quota scopes and how it stood, and whether
 * the line pins its first candidate (an explicit model, or an account).
 */
export type Initial = { chain: Candidate[], position: number, trail: string[], scopes: string[][], ranked: QuotaState[], pinned: boolean, firstRanks: number[] }

/** A seat as the pane and the band show it. */
type Shown = {
  id: string
  dir: string
  description: string
  vendor: SeatVendor
  model: string
  effort: string
  account?: string
  tier: SeatTier
  status: SeatStatus
  startedAt: number
  endedAt?: number
}

type Read = { kind: 'marker', marker: Marker } | { kind: 'not-job', word: string } | { kind: 'not-a-line' }

function parseMarker(prompt: string): Read {
  const jobOf = (word: string | undefined): string | undefined =>
    word === undefined ? DEFAULT_JOB : jobWords(seatConfig.jobs.policies).includes(word) ? word : undefined
  const sized = SIZED.exec(prompt)
  if (sized) {
    const [line, named, size, tier, word] = sized
    if (!line || !SIZES.includes(size as Size) || (tier !== 'reviewer' && tier !== 'owner')) return { kind: 'not-a-line' }
    const brief = prompt.slice(line.length)
    const naming = named === undefined ? {}
      : ([...EXTERNAL_VENDORS, ...FAMILIES] as string[]).includes(named) ? { prefer: named }
        : named in seatConfig.accounts ? { account: named } : undefined
    if (naming === undefined) return { kind: 'not-a-line' }
    const job = jobOf(word)
    return job === undefined ? { kind: 'not-job', word: word ?? '' } : { kind: 'marker', marker: { size: size as Size, ...naming, tier, job, brief } }
  }
  const match = EXPLICIT.exec(prompt)
  if (!match) return { kind: 'not-a-line' }
  const [line, vendor, model, effort, tier, word] = match
  if (!line || !EXTERNAL_VENDORS.includes(vendor as ExternalVendor) || !model || !effort || (tier !== 'reviewer' && tier !== 'owner')) return { kind: 'not-a-line' }
  const job = jobOf(word)
  return job === undefined ? { kind: 'not-job', word: word ?? '' }
    : { kind: 'marker', marker: { vendor: vendor as ExternalVendor, model, effort, tier, job, brief: prompt.slice(line.length) } }
}

export type Parsed = { kind: 'none' } | { kind: 'refused', reason: string } | { kind: 'seat', marker: Marker }

export const seatLineForms = (named: readonly string[], vendors: readonly string[], jobs: readonly string[]): { sized: string, explicit: string } => {
  const ending = ' <' + TIERS.join('|') + '>' + (jobs.length === 0 ? '' : ' [<' + jobs.join('|') + '>]')
  return { sized: 'seat: [<' + named.join('|') + '>] <' + SIZES.join('|') + '>' + ending, explicit: 'seat: <' + vendors.join('|') + '> <model> <effort>' + ending }
}

const grammarText = (vendors: readonly string[]): string => {
  const { sized, explicit } = seatLineForms([...vendors, ...FAMILIES, ...Object.keys(seatConfig.accounts)], vendors, jobWords(seatConfig.jobs.policies))
  return '`' + sized + '` or `' + explicit + '`'
}

const sizeOfMarker = (marker: Marker): Size => 'vendor' in marker ? sizeOf(marker.effort) : marker.size

const looksLikeSeatLine = (prompt: string): boolean => /^\s*seat[ \t]*[:\uff1a]/i.test(prompt.replace(/\p{Cf}/gu, ''))

// Quoted as received, so a stray space, tab, BOM or carriage return shows.
const quoted = (line: string): string =>
  JSON.stringify(line).replace(/[^\x20-\x7e]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'))

export function parseSeatLine(prompt: string): Parsed {
  if (!looksLikeSeatLine(prompt)) return { kind: 'none' }
  const leading = /^(?:[ \t]*\r?\n)*/.exec(prompt)?.[0] ?? ''
  const body = prompt.slice(leading.length)
  const end = body.indexOf('\n')
  const first = end === -1 ? body : body.slice(0, end)
  const normalized = first.replace(/[ \t]+\r?$/, '').replace(/[ \t]+/g, ' ').replace(/^seat:/i, 'seat:')
  const read = parseMarker(normalized + (end === -1 ? '' : '\n' + body.slice(end + 1)))
  const grammar = 'A seat line is the first non-blank line of the prompt (seat: is case-insensitive; extra spaces are allowed): ' + grammarText(EXTERNAL_VENDORS) + '.'
  if (read.kind === 'not-job') {
    const jobs = jobWords(seatConfig.jobs.policies)
    return {
      kind: 'refused',
      reason: 'seat-router refused this seat: its last word, ' + quoted(read.word) + ', is not a job; the jobs are '
        + [jobs.slice(0, -1).join(', '), jobs.at(-1)].filter(Boolean).join(' and ') + '. ' + grammar,
    }
  }
  if (read.kind === 'marker') return { kind: 'seat', marker: read.marker }
  const lines = prompt.split('\n')
  const line = lines.find(text => text.trim() !== '') ?? ''
  const why = quoted(line) + ' is not a seat line.'
  return {
    kind: 'refused',
    reason: 'seat-router refused this seat: ' + why + ' ' + grammar,
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function textAt(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function readJson(text: string): unknown | undefined {
  try { return JSON.parse(text) } catch { return undefined }
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 120)
}

// The external CLIs this machine has: one that cannot start or fails `--version` is absent.
export async function installedVendors($: EngineInterface): Promise<ExternalVendor[]> {
  const known = await read($, vendorsState)
  if (known) return known
  const found = await Promise.all(EXTERNAL_VENDORS.map(async vendor => {
    try {
      return (await io($, ['exec', ...ADAPTERS[vendor].version])).exitCode === 0 ? vendor : undefined
    } catch {
      return undefined
    }
  }))
  const vendors = found.filter((vendor): vendor is ExternalVendor => vendor !== undefined)
  await update($, vendorsState, () => vendors)
  return vendors
}

async function accountDir($: EngineInterface, account: string): Promise<string> {
  const dir = slashed(seatConfig.accounts[account] ?? '')
  return dir === '~' || dir.startsWith('~/') ? slashed(await homeDir($) ?? '') + dir.slice(1) : dir
}

export async function accountDirs($: EngineInterface): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(accountNames().map(async name => [name, await accountDir($, name)] as const)))
}

function accountUsage($: EngineInterface, dir: string): ReturnType<EngineInterface['process']['run']> {
  const { account, usage } = ADAPTERS.claude
  return runTool($, usage.run, { timeoutMs: 60_000, env: account.env(dir) }, account.args)
}

const sameCandidate = (a: Candidate, b: Candidate): boolean => a.vendor === b.vendor && a.model === b.model

export async function seatCandidates($: EngineInterface, marker: Marker): Promise<CandidateSet> {
  const installed: SeatVendor[] = ['claude', ...await installedVendors($)]
  const usable = (list: Candidate[]): Candidate[] => list.filter(candidate => installed.includes(candidate.vendor))
  const choose = (want: { size: Size, filter?: Match, named?: Candidate }, base: Candidate[]): CandidateSet =>
    candidateSet({ job: marker.job, ...want }, base, seatConfig.jobs.policies, FACTS) as CandidateSet
  if ('vendor' in marker) {
    const named = { vendor: marker.vendor, model: marker.model, effort: marker.effort }
    const fallbacks = usable(await sizeCandidates($, sizeOf(marker.effort))).map(candidate => candidate.effort ? { ...candidate, effort: marker.effort } : candidate)
    return choose({ size: sizeOf(marker.effort), filter: { family: familyOf(named) }, named }, [named, ...fallbacks.filter(candidate => !sameCandidate(candidate, named))])
  }
  const list = usable(await sizeCandidates($, marker.size))
  if (marker.account !== undefined) return choose({ size: marker.size, filter: { account: marker.account } }, [accountCandidate(marker.size, marker.account), ...list])
  const prefer = marker.prefer
  if (prefer === undefined) return choose({ size: marker.size }, list)
  return choose({ size: marker.size, filter: (EXTERNAL_VENDORS as string[]).includes(prefer) ? { cli: prefer } : { family: prefer } }, list)
}

// The POSIX tools seat-io.mjs stands in for, on every platform.
function io($: EngineInterface, args: string[], init?: { timeoutMs?: number, stdin?: string, env?: Record<string, string> }): ReturnType<EngineInterface['process']['run']> {
  const execEnv = args[0] === 'exec' ? (ADAPTERS as Record<string, { execEnv?: Record<string, string> }>)[args[1] ?? '']?.execEnv : undefined
  return $.process.run(['node', join($.plugin.root, 'bin', 'seat-io.mjs'), ...args], execEnv ? { ...init, env: { ...init?.env, ...execEnv } } : init)
}

type Run = { script: string } | { exec: string[] }

function runTool($: EngineInterface, run: Run, init: { timeoutMs?: number, env?: Record<string, string> }, args: string[] = []): ReturnType<EngineInterface['process']['run']> {
  return 'script' in run ? $.process.run(['node', join($.plugin.root, 'bin', run.script), ...args], init) : io($, ['exec', ...run.exec, ...args], init)
}

// Settings are saved through the CLI, under the id the plugin is installed as. A --plugin-dir load (`@inline`) has none: its options live in
// settings.json. Returns why nothing was saved, or undefined once saved.
export async function saveOptions($: EngineInterface, values: Record<string, string>): Promise<string | undefined> {
  const same = (path: string) => slashed(path).replace(/\/+$/, '').toLowerCase()
  const listed = await io($, ['exec', 'claude', 'plugin', 'list', '--json'], { timeoutMs: 60_000 })
  const plugins = readJson(listed.stdout)
  const mine = Array.isArray(plugins)
    ? plugins.map(asObject).find(plugin => typeof plugin?.installPath === 'string' && same(plugin.installPath) === same($.plugin.root))
    : undefined
  const id = mine?.id
  if (typeof id !== 'string') return '`claude plugin list` does not name this plugin'
  if (id.endsWith('@inline')) return 'it is loaded with --plugin-dir; set pluginConfigs["' + id + '"].options in settings.json'
  const saved = await io($, ['exec', 'claude', 'plugin', 'configure', id, '--values-stdin'], { timeoutMs: 60_000, stdin: JSON.stringify(values) })
  return saved.exitCode === 0 ? undefined : saved.stderr.trim() || '`claude plugin configure` exited ' + saved.exitCode
}


export type Activity = { steps: number, lastAction?: string }


async function readText($: EngineInterface, path: string): Promise<string> {
  try { return await $.fs.read(path) } catch { return '' }
}

async function matches($: EngineInterface, pattern: string, paths: string[]): Promise<boolean> {
  try { return (await io($, ['grep', '-Eiq', pattern, ...paths])).exitCode === 0 } catch { return false }
}

async function tail($: EngineInterface, path: string, lines = 1): Promise<string> {
  try {
    const result = await io($, ['tail', '-n', String(lines), path])
    return result.exitCode === 0 ? result.stdout : ''
  } catch { return '' }
}

async function grepLines($: EngineInterface, pattern: string, path: string): Promise<string> {
  try {
    const result = await io($, ['grep', '-E', pattern, path])
    return result.exitCode === 0 ? result.stdout : ''
  } catch { return '' }
}

async function head($: EngineInterface, path: string): Promise<string> {
  try {
    const result = await io($, ['head', '-n', '1', path])
    return result.exitCode === 0 ? result.stdout : ''
  } catch { return '' }
}

async function grepParts($: EngineInterface, pattern: string, path: string): Promise<string> {
  try {
    const result = await io($, ['grep', '-oE', pattern, path])
    return result.exitCode === 0 ? result.stdout : ''
  } catch { return '' }
}

async function findFile($: EngineInterface, dir: string, glob: string): Promise<string | undefined> {
  try {
    const found = await io($, ['find', dir, '-name', glob])
    return found.exitCode === 0 && found.stdout.trim() ? found.stdout.trim().split('\n')[0] : undefined
  } catch { return undefined }
}

function attemptView($: EngineInterface) {
  return {
    read: (path: string) => readText($, path),
    head: (path: string) => head($, path),
    tail: (path: string, lines: number) => tail($, path, lines),
    grep: (pattern: string, path: string) => grepLines($, pattern, path),
    grepParts: (pattern: string, path: string) => grepParts($, pattern, path),
    has: (pattern: string, path: string) => matches($, pattern, [path]),
    find: (dir: string, glob: string) => findFile($, dir, glob),
  }
}



async function readActivity($: EngineInterface, seat: Shown): Promise<Activity | undefined> {
  const adapter = ADAPTERS[seat.vendor]
  if (seat.status !== 'running') return undefined
  const transcript = join(seat.dir, adapter.transcript)
  let steps = 0
  // A transcript not written yet, or a grep that fails, leaves the seat at 0 steps until the next poll.
  try {
    steps = Number.parseInt((await io($, ['grep', '-cE', adapter.stepPattern, transcript])).stdout, 10) || 0
  } catch {}
  const action = adapter.lastAction(await tail($, transcript, 20))
  return { steps, ...(action === undefined ? {} : { lastAction: action }) }
}

function display(seat: Shown, liveTokens: number | undefined, activity: Activity): SeatDisplay {
  return {
    id: seat.id, description: seat.description, vendor: seat.vendor, model: seat.model, effort: seat.effort,
    ...(seat.account === undefined ? {} : { account: seat.account }), tier: seat.tier, status: seat.status, steps: activity.steps,
    startedAt: seat.startedAt, ...(seat.endedAt === undefined ? {} : { endedAt: seat.endedAt }),
    ...(liveTokens === undefined ? {} : { liveTokens }),
    ...(activity.lastAction === undefined ? {} : { lastAction: activity.lastAction }),
  }
}

// Tokens and activity are read only while a seat runs; afterwards it keeps the last ones seen on the same vendor.
export function seatValue(seat: Shown, prior: SeatDisplay | undefined, liveTokens?: number, activity?: Activity): SeatDisplay {
  const same = prior?.vendor === seat.vendor ? prior : undefined
  const lastTokens = liveTokens ?? same?.lastTokens ?? same?.liveTokens
  const kept = activity ?? { steps: same?.steps ?? 0, ...(same?.lastAction === undefined ? {} : { lastAction: same.lastAction }) }
  return { ...display(seat, liveTokens, kept), ...(lastTokens === undefined ? {} : { lastTokens }) }
}

// The poll runs every 5 s; writing an unchanged seat would redraw every reader.
async function putSeat($: EngineInterface, seat: Shown, liveTokens?: number, activity?: Activity): Promise<void> {
  const prior = (await read($, seatsState)).find(value => value.id === seat.id)
  if (prior && JSON.stringify(prior) === JSON.stringify(seatValue(seat, prior, liveTokens, activity))) return
  await update($, seatsState, seats => {
    const current = seats.find(value => value.id === seat.id)
    return boundSeats([...seats.filter(value => value.id !== seat.id), seatValue(seat, current, liveTokens, activity)])
  })
}

export async function probeSandboxes($: EngineInterface): Promise<void> {
  if (await osOf($) !== 'windows') return
  const root = await seatHome($)
  await Promise.all(Object.values(ADAPTERS).flatMap(adapter => 'probe' in adapter && adapter.probe
    ? [runTool($, { script: adapter.probe.script }, { timeoutMs: 90_000 }, [join(root, adapter.probe.file)])] : []))
}

// The forge's protection of the session repository's default branch, as a /seats line. GitHub refuses
// the read with HTTP 403 on a private repository of a free plan, and answers 404 for both an
// unprotected branch and a repository the token cannot administer.
export async function branchProtection($: EngineInterface): Promise<string> {
  const repo = await io($, ['exec', 'gh', 'api', 'repos/{owner}/{repo}', '--jq', '.default_branch'], { timeoutMs: 15_000 })
  const branch = repo.stdout.trim()
  if (repo.exitCode !== 0 || !branch) return 'Branch protection: cannot be read (' + (repo.stderr.trim().split('\n').pop() || 'gh exited ' + repo.exitCode) + ').'
  const read = await io($, ['exec', 'gh', 'api', 'repos/{owner}/{repo}/branches/' + branch + '/protection'], { timeoutMs: 15_000 })
  const answer = asObject(readJson(read.stdout))
  const message = typeof answer?.message === 'string' ? answer.message : ''
  const state = read.exitCode === 0 ? 'on'
    : answer?.status === '403' && /^Upgrade to GitHub/.test(message) ? 'not available on this plan'
      : answer?.status === '404' && message === 'Branch not protected' ? 'off'
        : 'cannot be read (' + (message ? message + ', HTTP ' + String(answer?.status) : read.stderr.trim().split('\n').pop() || 'gh exited ' + read.exitCode) + ')'
  return 'Branch protection on ' + branch + ': ' + state + '.'
}

const UNFINISHED = 'didn\'t finish before the previous session ended'

type Resumed = 'reported' | 'running' | 'finished'

const RESUMED: Record<Resumed, (dir: string) => string> = {
  reported: dir => 'seat-router delivered its report, or delivers it here (' + dir + '/report.md). '
    + 'That report gives its outcome and says whether anything is left to do.',
  running: () => 'has not reported yet; seat-router checks it and reports its outcome here.',
  finished: dir => 'seat-router has not reported it and does not check it again. Its folder: ' + dir,
}

// Claude Code tracks a seat as a background agent (the Agent call answers async_launched) but
// never learns that it ended: the report reaches the session as a prompt. Resuming a session,
// it lists every such seat as an agent that did not finish.
export async function correctUnfinishedNotice($: EngineInterface, text: string): Promise<string> {
  if (!text.includes(UNFINISHED)) return text
  const home = await seatHome($)
  const sessions = await lineage($)
  return replaceAsync(text, /<task-notification>[\s\S]*?<\/task-notification>/g, async block => {
    if (!block.includes(UNFINISHED)) return block
    const ids = [...block.matchAll(/<task-id>([^<]*)<\/task-id>/g)].map(match => match[1] ?? '')
    const seats: Array<{ id: string, description: string, dir: string, state: Resumed }> = []
    for (const id of ids) {
      if (!isSeatId(id)) continue
      const dir = seatDirOf(home, id)
      const seat = asObject(readJson(await readText($, join(dir, 'seat.json'))))
      if (seat?.id !== id || typeof seat.sessionId !== 'string' || !sessions.includes(seat.sessionId)) continue
      const state = await $.fs.exists(join(dir, 'report.md')) ? 'reported' : await $.fs.exists(join(home, 'live', id + '.json')) ? 'running' : 'finished'
      seats.push({ id, description: String(seat.description), dir, state })
    }
    if (seats.length === 0) return block
    const lines = seats.map(seat => '- ' + seat.id + ' ("' + seat.description + '"): ' + RESUMED[seat.state](seat.dir))
    const others = ids.filter(id => !seats.some(seat => seat.id === id))
    const named = seats.map(seat => seat.id).join(', ')
    const head = others.length === 0
      ? 'seat-router: Claude Code\'s notice listed ' + named + ' as background agents that did not finish. '
        + 'Seats run outside Claude Code, which keeps no record of their end, so that notice is wrong about them.'
      : 'seat-router: Claude Code\'s notice above is wrong about ' + named + ', which are seats: they run outside Claude Code, '
        + 'which keeps no record of their end. It stands as Claude Code wrote it for ' + others.join(', ') + '.'
    const note = [head, ...lines].join('\n')
    return others.length === 0 ? note : block + '\n' + note
  })
}

async function replaceAsync(text: string, pattern: RegExp, replace: (match: string) => Promise<string>): Promise<string> {
  const replaced = await Promise.all([...text.matchAll(pattern)].map(match => replace(match[0])))
  let index = 0
  return text.replace(pattern, () => replaced[index++] ?? '')
}

// A seat's live entry, written by accept.mjs and kept by its supervisor while the seat runs.
type LiveEntry = {
  id: string
  sessionId: string
  dir: string
  description: string
  tier: SeatTier
  createdAt: number
  status: SeatStatus
  vendor: SeatVendor
  model: string
  effort: string
  account?: string
  solo?: boolean
}

async function listNames($: EngineInterface, dir: string): Promise<string[]> {
  try {
    return (await $.fs.list(dir)).map(entry => entry.name)
  } catch {
    return []
  }
}

async function liveEntries($: EngineInterface): Promise<LiveEntry[]> {
  const live = join(await seatHome($), 'live')
  const entries = await Promise.all((await listNames($, live)).filter(name => name.endsWith('.json'))
    .map(async name => asObject(readJson(await readText($, join(live, name)))) as LiveEntry | undefined))
  return entries.filter((entry): entry is LiveEntry => typeof entry?.id === 'string' && typeof entry.dir === 'string')
}

/** The request accept.mjs makes a seat from: everything the hook decided and the session knows. */
async function acceptRequest($: EngineInterface, input: AgentInput, marker: Marker, initial: Initial): Promise<Record<string, unknown>> {
  return {
    sessionId: await $.session.id(), description: input.description, tier: marker.tier, brief: marker.brief,
    cwd: (await io($, ['pwd'])).stdout.trim(), isolation: input.isolation === 'worktree' ? 'worktree' : 'folder',
    candidates: initial.chain, first: initial.position, trail: initial.trail, scopes: initial.scopes, ranked: initial.ranked, pinned: initial.pinned,
    busyAt: seatConfig.busyAt, minFreeDiskGiB: seatConfig.minFreeDiskGiB ?? 10,
    firstRanks: initial.firstRanks,
    floor: formatCandidate(floorCandidate(sizeOfMarker(marker))), accounts: await accountDirs($),
    settings: { enabledPlugins: await $.settings.read({ key: 'enabledPlugins' }) },
  }
}

export type Started = { id: string, dir: string, model: string }

export async function startSeat($: EngineInterface, input: AgentInput, marker: Marker, initial: Initial, deadline: number): Promise<Started> {
  if (await $.clock.now() >= deadline) throw new Error('seat-router took too long to start this seat')
  const request = { ...await acceptRequest($, input, marker, initial), ...(input.agentId === undefined ? {} : { agentId: input.agentId }) }
  const picked = await pickSeat($, input.tool_use_id)
  const made = await $.process.run(['node', join($.plugin.root, 'bin', 'accept.mjs')], {
    stdin: JSON.stringify({ ...request, id: picked.id }), timeoutMs: Math.max(1_000, deadline - await $.clock.now()),
  })
  if (made.exitCode !== 0) {
    await acceptRefused($, picked)
    throw new Error(made.stderr.trim().split('\n').pop() || 'accept.mjs exited ' + made.exitCode)
  }
  const seat = { id: picked.id, dir: String(asObject(readJson(made.stdout))?.dir ?? picked.dir) }
  const first = initial.chain[initial.position] ?? initial.chain[0]
  await putSeat($, {
    id: seat.id, dir: seat.dir, description: input.description, tier: marker.tier, status: 'running', startedAt: await $.clock.now(),
    vendor: first?.vendor ?? 'claude', model: first?.model ?? '', effort: first?.effort ?? '', ...(first?.account ? { account: first.account } : {}),
  })
  return { ...seat, model: first?.model ?? '' }
}

const ADOPT_EVERY_MS = 60_000
let adoptedAt = 0
const liveTokenMemos = new Map<string, Record<string, unknown>>()

async function liveTokens($: EngineInterface, seat: Shown): Promise<number | undefined> {
  if (seat.status !== 'running') return undefined
  const found = await ADAPTERS[seat.vendor].liveTokens(attemptView($), seat.dir, liveTokenMemos.get(seat.id) ?? {})
  if (found.memo) liveTokenMemos.set(seat.id, found.memo)
  return found.tokens
}

export async function poll($: EngineInterface): Promise<void> {
  const home = await seatHome($)
  const ids = await lineage($)
  await deliverMail($, ids)
  const shown = (await liveEntries($)).filter(entry => ids.includes(entry.sessionId)).map((entry): Shown => ({ ...entry, startedAt: entry.createdAt }))
  for (const seat of shown) await putSeat($, seat, await liveTokens($, seat), await readActivity($, seat))
  for (const id of liveTokenMemos.keys()) if (!shown.some(seat => seat.id === id)) liveTokenMemos.delete(id)
  const now = await $.clock.now()
  if (now - adoptedAt < ADOPT_EVERY_MS) return
  adoptedAt = now
  await $.process.run(['node', join($.plugin.root, 'bin', 'adopt.mjs'), home], { timeoutMs: 60_000 })
}

/** Sweeps finished worktrees after one day and seat records after 60 (see prune-seats.mjs). */
export async function pruneSeats($: EngineInterface): Promise<void> {
  await $.process.run(['node', join($.plugin.root, 'bin', 'prune-seats.mjs'), join(await seatHome($), 'seats')], { timeoutMs: 120_000 })
}

let activePoll: Promise<void> | undefined

export function singleFlightPoll($: EngineInterface): Promise<void> {
  if (activePoll) return activePoll
  activePoll = poll($).finally(() => { activePoll = undefined })
  return activePoll
}
