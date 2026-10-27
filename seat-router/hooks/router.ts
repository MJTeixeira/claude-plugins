import { atom, read, update } from 'claude-code'
import type { EngineInterface, ToolCallInput } from 'claude-code'
import type { SeatDisplay, SeatQuotaDisplay, SeatStatus, SeatTier, SeatVendor } from '../types/index'
import { accountCandidate, autoCandidates, familyOf, FAMILIES, formatCandidate, isAuto, isBusy, isPreferred, parseAccounts, parseAgyModels, parseCandidates, pick, RESERVED, rotate, SIZES, sizeOf } from './chain'
import type { Candidate, CliModel, CliModels, Load, Running, Size } from './chain'

const EXPLICIT = /^seat: (codex|agy) (\S+) (\S+) (reviewer|owner)\n/
const SIZED = /^seat: (?:([\w-]+) )?(light|standard|heavy) (reviewer|owner)\n/
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

const seatsState = atom({ plugin: 'seat-router', key: 'seats' } as const, [], {
  shape: 'seat-display-3',
})
const quotasState = atom({ plugin: 'seat-router', key: 'quotas' } as const, {}, {
  shape: 'quota-windows-1',
})
const EXTERNAL_VENDORS = ['codex', 'agy'] as const
// null until the CLIs were asked for.
const vendorsState = atom({ plugin: 'seat-router', key: 'vendors' } as const, null as ExternalVendor[] | null, {
  shape: 'installed-vendors-1',
})
const modelsState = atom({ plugin: 'seat-router', key: 'models' } as const, null as CliModels | null, {
  shape: 'cli-models-1',
})
// The CLIs' usage output, kept QUOTA_FRESH_MS: the engine gives a tool.call hook
// 10s, and seats of one message pick one at a time, so a pick reads a recent
// output (the band refreshes it every two minutes) or joins a read under way.
const QUOTA_FRESH_MS = 150_000
const usageState = atom({ plugin: 'seat-router', key: 'usage' } as const, {} as Partial<Record<UsageSource, { at: number, stdout: string }>>, {
  shape: 'usage-reads-1',
})
// A CLI, or another Claude account by its name.
type UsageSource = ExternalVendor | `claude:${string}`
const usageReading = new Map<UsageSource, Promise<string | undefined>>()
// The shell tools Claude Code runs commands through.
export const SHELL_TOOLS = ['Bash', 'PowerShell']
const NO_SHELL_NOTE = 'This seat has no shell: Bash and PowerShell are refused here. Read, search and edit files with your file tools, and say in your report what you could not run.\n'
const OWNER_NOTE = 'Commands starting with git, gh, npm, npx, node, pnpm, yarn or curl need network or .git writes: run each of them with your run_command tool\'s BypassSandbox set to true. Run every other command inside the sandbox.\n'
type AgentInput = Extract<ToolCallInput, { tool: 'Agent' }>
export type ExternalVendor = Exclude<SeatVendor, 'claude'>

// Each size's setting (`auto`, or a list of candidates), the busy threshold,
// when code work goes to owner seats and the other Claude accounts (name to
// config folder), from the plugin's userConfig.
export type Delegate = 'auto' | 'on' | 'off'
export type SeatConfig = { sizes: Record<Size, string>, busyAt: number, delegate: Delegate, accounts: Record<string, string> }

let seatConfig: SeatConfig = { sizes: { light: 'auto', standard: 'auto', heavy: 'auto' }, busyAt: 80, delegate: 'auto', accounts: {} }

export function setSeatConfig(config: SeatConfig): void {
  seatConfig = config
}

export function setSize(size: Size, setting: string): void {
  seatConfig = { ...seatConfig, sizes: { ...seatConfig.sizes, [size]: setting } }
}

export function seatConfigFrom(options: Readonly<Record<string, unknown>>): SeatConfig {
  const sizes = Object.fromEntries(SIZES.map(size => [size, String(options[size + 'Seats'] ?? 'auto')])) as Record<Size, string>
  return {
    sizes, busyAt: typeof options.busyAt === 'number' ? options.busyAt : 80, delegate: delegateOf(options.delegate),
    accounts: parseAccounts(String(options.claudeAccounts ?? '')),
  }
}

export const accountNames = (): string[] => Object.keys(seatConfig.accounts)

export function setAccounts(accounts: Record<string, string>): void {
  seatConfig = { ...seatConfig, accounts }
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
    return entry.kind === 'dir' && name !== undefined && !RESERVED.includes(name) && home + '/' + entry.name !== own ? [{ name, folder: entry.name }] : []
  })
  const accounts = await Promise.all(named.map(async ({ name, folder }): Promise<FoundAccount | undefined> => {
    const path = home + '/' + folder
    if (!await $.fs.exists(path + '/.claude.json')) return undefined
    const read = await $.process.run(['node', join($.plugin.root, 'bin', 'claude-usage.mjs')], { timeoutMs: 60_000, env: { CLAUDE_CONFIG_DIR: path } })
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

// Why code work goes to owner seats now, or undefined while it stays on Claude.
export async function delegateReason($: EngineInterface): Promise<string | undefined> {
  if (seatConfig.delegate === 'on') return 'set to on'
  if (seatConfig.delegate === 'off') return undefined
  const usage = await claudeUsage($).catch(() => undefined)
  if (usage === undefined) return undefined
  return isBusy(loadOf(claudeQuota(usage), await $.clock.now()), seatConfig.busyAt) ? 'Claude\'s quota is busy' : undefined
}

export const delegateSetting = (): Delegate => seatConfig.delegate

// The models each installed CLI reports, asked once a session; a CLI that cannot answer offers none.
export async function cliModels($: EngineInterface): Promise<CliModels> {
  const known = await read($, modelsState)
  if (known) return known
  const vendors = await installedVendors($)
  const ask = async (vendor: ExternalVendor): Promise<CliModel[] | undefined> => {
    if (!vendors.includes(vendor)) return undefined
    try {
      if (vendor === 'agy') {
        const listed = await io($, ['exec', 'agy', 'models'], { timeoutMs: 60_000 })
        return listed.exitCode === 0 ? parseAgyModels(listed.stdout) : undefined
      }
      const listed = await $.process.run(['node', join($.plugin.root, 'bin', 'codex-models.mjs')], { timeoutMs: 60_000 })
      const data = listed.exitCode === 0 ? readJson(listed.stdout) : undefined
      return Array.isArray(data) ? data as CliModel[] : undefined
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
  brief: string
} & ({ vendor: ExternalVendor, model: string, effort: string } | { size: Size, prefer?: string, account?: string })

type Quota = {
  vendor: SeatVendor
  known: boolean
  out: boolean
  detail?: string
  resetAt?: number
  fiveHour?: { used: number, resetAt?: number }
  weekly?: { used: number, resetAt?: number }
  // The windows of the model asked about, where they differ from the band's.
  load?: { fiveHour?: number, weekly?: number, weekResetAt?: number }
}

type Initial = {
  chain: Candidate[]
  trail: string[]
  resetAt?: number
  allOut: boolean
  position?: number
  readings: Quota[]
}

type Seat = {
  id: string
  sessionId: string
  description: string
  vendor: SeatVendor
  model: string
  effort: string
  // The other Claude account a `claude` seat runs on, as a CLI.
  account?: string
  tier: SeatTier
  chainPosition: number
  status: SeatStatus
  startedAt: number
  endedAt?: number
  reported: boolean
  dir: string
  workDir: string
  sessionCwd: string
  brief: string
  chain: Candidate[]
  isolation?: 'worktree'
  worktreePath?: string
  worktreeBranch?: string
  gitDirs?: string[]
  fallbackTrail: string[]
  rolloutPath?: string
  rolloutSearched?: boolean
  waitedAt?: number
  waitedMs?: number
  waitUntil?: number
}

export type Check = {
  text: string
  failed: boolean
  quota: boolean
  detail: string
}

export function parseMarker(prompt: string): Marker | undefined {
  const sized = SIZED.exec(prompt)
  if (sized) {
    const [line, named, size, tier] = sized
    if (!line || !SIZES.includes(size as Size) || (tier !== 'reviewer' && tier !== 'owner')) return undefined
    const brief = prompt.slice(line.length)
    if (named === undefined) return { size: size as Size, tier, brief }
    if (['codex', 'agy', ...FAMILIES].includes(named)) return { size: size as Size, prefer: named, tier, brief }
    if (named in seatConfig.accounts) return { size: size as Size, account: named, tier, brief }
    return undefined
  }
  const match = EXPLICIT.exec(prompt)
  if (!match) return undefined
  const [line, vendor, model, effort, tier] = match
  if (!line || (vendor !== 'codex' && vendor !== 'agy') || !model || !effort || (tier !== 'reviewer' && tier !== 'owner')) return undefined
  return { vendor, model, effort, tier, brief: prompt.slice(line.length) }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function numberAt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function textAt(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function readJson(text: string): unknown | undefined {
  try { return JSON.parse(text) } catch { return undefined }
}

function resetTime(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value * 1000
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

function exceeded(used: number | undefined): boolean {
  return used !== undefined && used > 95
}

function usedDetail(window: string, used: number | undefined): string | undefined {
  return used === undefined ? undefined : window + ' ' + Math.round(used) + '% used'
}

function usageWindow(value: Record<string, unknown> | undefined, used = numberAt(value?.utilization)): { used: number, resetAt?: number } | undefined {
  if (used === undefined) return undefined
  const resetAt = resetTime(value?.resets_at ?? value?.reset_time)
  return { used: Math.max(0, Math.min(100, used)), ...(resetAt === undefined ? {} : { resetAt }) }
}

function minimumReset(resets: Array<number | undefined>): number | undefined {
  const present = resets.filter((value): value is number => value !== undefined)
  return present.length === 0 ? undefined : Math.min(...present)
}

function codexQuota(payload: unknown): Quota {
  const data = asObject(payload)
  const five = asObject(data?.five_hour)
  const week = asObject(data?.seven_day)
  const fiveHour = usageWindow(five)
  const weekly = usageWindow(week)
  const fiveUsed = fiveHour?.used
  const weekUsed = weekly?.used
  const allowed = data?.allowed
  const reached = data?.reached
  const details = [
    allowed === false ? 'not allowed' : undefined,
    reached !== null && reached !== undefined ? 'limit ' + String(reached) : undefined,
    exceeded(fiveUsed) ? usedDetail('5h', fiveUsed) : undefined,
    exceeded(weekUsed) ? usedDetail('7d', weekUsed) : undefined,
  ].filter((value): value is string => value !== undefined)
  return {
    vendor: 'codex', known: true, out: details.length > 0,
    detail: details.join(', '), resetAt: minimumReset([resetTime(five?.resets_at), resetTime(week?.resets_at)]),
    ...(fiveHour === undefined ? {} : { fiveHour }),
    ...(weekly === undefined ? {} : { weekly }),
  }
}

function claudeQuota(payload: unknown): Quota {
  const data = asObject(payload)
  const five = asObject(data?.five_hour)
  const week = asObject(data?.seven_day)
  const fiveHour = usageWindow(five)
  const weekly = usageWindow(week)
  const fiveUsed = fiveHour?.used
  const weekUsed = weekly?.used
  const details = [
    exceeded(fiveUsed) ? usedDetail('5h', fiveUsed) : undefined,
    exceeded(weekUsed) ? usedDetail('7d', weekUsed) : undefined,
  ].filter((value): value is string => value !== undefined)
  return {
    vendor: 'claude', known: true, out: details.length > 0,
    detail: details.join(', '), resetAt: minimumReset([resetTime(five?.resets_at), resetTime(week?.resets_at)]),
    ...(fiveHour === undefined ? {} : { fiveHour }),
    ...(weekly === undefined ? {} : { weekly }),
  }
}

function agyBucketQuota(payload: unknown, model: string): Quota {
  const command = asObject(asObject(payload)?.command)
  const data = asObject(command?.data)
  const groups = Array.isArray(data?.groups) ? data.groups : undefined
  if (!groups) return { vendor: 'agy', known: false, out: false }
  const buckets: Record<string, unknown>[] = []
  for (const group of groups) {
    const items = asObject(group)?.buckets
    if (!Array.isArray(items)) continue
    for (const bucket of items) {
      const object = asObject(bucket)
      if (object) buckets.push(object)
    }
  }
  const isGemini = model.startsWith('gemini')
  const isArgon = model.includes('argon')
  const ids = isGemini ? ['gemini-5h', 'gemini-weekly'] : ['3p-5h', '3p-weekly']
  if (isArgon) ids.push('gemini-argon-wtu-weekly')
  const selected = ids.map(id => buckets.find(bucket => bucket.id === id))
  if (selected.some(bucket => !bucket)) return { vendor: 'agy', known: false, out: false }
  const exhausted = selected.map(bucket => {
    const remaining = numberAt(bucket?.remaining_fraction)
    const used = remaining === undefined ? undefined : (1 - remaining) * 100
    return { used, resetAt: resetTime(bucket?.reset_time) }
  })
  const band = ['gemini-5h', 'gemini-weekly'].map(id => {
    const bucket = buckets.find(item => item.id === id)
    const remaining = numberAt(bucket?.remaining_fraction)
    return remaining === undefined ? undefined : usageWindow(bucket, (1 - remaining) * 100)
  })
  const weeks = exhausted.slice(1).filter(window => window.used !== undefined)
  const worstWeek = weeks.reduce<typeof weeks[number] | undefined>((worst, window) => worst === undefined || (window.used ?? 0) > (worst.used ?? 0) ? window : worst, undefined)
  const load = { fiveHour: exhausted[0]?.used, weekly: worstWeek?.used, weekResetAt: worstWeek?.resetAt }
  const names = isGemini ? ['5h', 'weekly'] : ['3p 5h', '3p weekly']
  if (isArgon) names.push('argon weekly')
  const details = exhausted.map((window, index) => exceeded(window.used) ? usedDetail(names[index] ?? 'quota', window.used) : undefined)
    .filter((value): value is string => value !== undefined)
  return {
    vendor: 'agy', known: true, out: details.length > 0, detail: details.join(', '),
    resetAt: minimumReset(exhausted.map(window => window.resetAt)), load,
    ...(band[0] === undefined ? {} : { fiveHour: band[0] }),
    ...(band[1] === undefined ? {} : { weekly: band[1] }),
  }
}

async function putQuota($: EngineInterface, quota: Quota): Promise<void> {
  const checkedAt = await $.clock.now()
  const value: SeatQuotaDisplay = {
    vendor: quota.vendor, checkedAt, known: quota.known, out: quota.out, detail: quota.detail,
    ...(quota.fiveHour === undefined ? {} : { fiveHour: quota.fiveHour }),
    ...(quota.weekly === undefined ? {} : { weekly: quota.weekly }),
  }
  await update($, quotasState, current => ({ ...current, [quota.vendor]: value }))
}

// Claude's windows as the session's last response reported them, in claude-usage's shape.
async function claudeUsage($: EngineInterface): Promise<Record<string, unknown> | undefined> {
  const { rateLimits } = await $.session.usage()
  const windows = Object.fromEntries(rateLimits.map(limit => [limit.kind, { utilization: limit.percentUsed, resets_at: limit.resetsAt }]))
  return windows.five_hour || windows.seven_day ? windows : undefined
}

// The external CLIs this machine has: one that cannot start or fails `--version` is absent.
export async function installedVendors($: EngineInterface): Promise<ExternalVendor[]> {
  const known = await read($, vendorsState)
  if (known) return known
  const found = await Promise.all(EXTERNAL_VENDORS.map(async vendor => {
    try {
      return (await io($, ['exec', vendor, '--version'])).exitCode === 0 ? vendor : undefined
    } catch {
      return undefined
    }
  }))
  const vendors = found.filter((vendor): vendor is ExternalVendor => vendor !== undefined)
  await update($, vendorsState, () => vendors)
  return vendors
}

// A CLI's or an account's usage output no older than `maxAgeMs`; undefined when the read failed.
async function usageOutput($: EngineInterface, source: UsageSource, maxAgeMs: number): Promise<string | undefined> {
  const kept = (await read($, usageState))[source]
  if (kept && (await $.clock.now()) - kept.at < maxAgeMs) return kept.stdout
  const running = usageReading.get(source)
  if (running) return running
  const reading = (async () => {
    try {
      const result = source === 'codex'
        ? await $.process.run(['node', join($.plugin.root, 'bin', 'codex-usage.mjs')], { timeoutMs: 60_000 })
        : source === 'agy'
          ? await io($, ['exec', 'agy', '-p', '/usage', '--output-format', 'json'], { timeoutMs: 60_000 })
          : await $.process.run(['node', join($.plugin.root, 'bin', 'claude-usage.mjs')], {
            timeoutMs: 60_000, env: { CLAUDE_CONFIG_DIR: await accountDir($, source.slice('claude:'.length)) },
          })
      if (result.exitCode !== 0) return undefined
      const at = await $.clock.now()
      await update($, usageState, current => ({ ...current, [source]: { at, stdout: result.stdout } }))
      return result.stdout
    } catch {
      return undefined
    } finally {
      usageReading.delete(source)
    }
  })()
  usageReading.set(source, reading)
  return reading
}

// An account's config folder, `~` taken as the home folder.
async function accountDir($: EngineInterface, account: string): Promise<string> {
  const dir = slashed(seatConfig.accounts[account] ?? '')
  return dir === '~' || dir.startsWith('~/') ? slashed(await homeDir($) ?? '') + dir.slice(1) : dir
}

// Another account's quota stays off the band, which shows the session's own Claude.
async function accountQuota($: EngineInterface, account: string, maxAgeMs = QUOTA_FRESH_MS): Promise<Quota> {
  const dir = await accountDir($, account)
  try {
    if ((await $.fs.stat(dir)).kind !== 'dir') throw new Error('not a folder')
  } catch {
    return { vendor: 'claude', known: true, out: true, detail: 'no folder ' + (dir || '(unset)') }
  }
  const output = await usageOutput($, `claude:${account}`, maxAgeMs)
  const data = output === undefined ? undefined : readJson(output)
  return data === undefined ? { vendor: 'claude', known: false, out: false } : claudeQuota(data)
}

function candidateQuota($: EngineInterface, candidate: Candidate): Promise<Quota> {
  return candidate.account === undefined ? quota($, candidate.vendor, candidate.model) : accountQuota($, candidate.account)
}

async function quota($: EngineInterface, vendor: SeatVendor, model: string, maxAgeMs = QUOTA_FRESH_MS): Promise<Quota> {
  if (vendor === 'claude') {
    const usage = await claudeUsage($).catch(() => undefined)
    const parsed = usage === undefined ? { vendor, known: false, out: false } as Quota : claudeQuota(usage)
    await putQuota($, parsed)
    return parsed
  }
  if (!(await installedVendors($)).includes(vendor)) return { vendor, known: true, out: true, detail: 'not installed' }
  const output = await usageOutput($, vendor, maxAgeMs)
  const data = output === undefined ? undefined : readJson(output)
  const parsed = data === undefined ? { vendor, known: false, out: false } as Quota
    : vendor === 'codex' ? codexQuota(data) : agyBucketQuota(data, model)
  await putQuota($, parsed)
  return parsed
}

export async function refreshQuotas($: EngineInterface): Promise<void> {
  await Promise.all([
    quota($, 'claude', 'opus'),
    quota($, 'codex', 'gpt', 0),
    // The band draws agy's Gemini windows, whichever Gemini model is named.
    quota($, 'agy', 'gemini', 0),
  ])
}

// agy's Gemini models take low, medium or high; a codex brief's xhigh or
// higher reaches agy on fallback.
function agyEffort(effort: string): string {
  return ['low', 'medium', 'high'].includes(effort) ? effort : 'high'
}

function loadOf(quota: Quota, now: number): Load {
  const load = quota.load ?? { fiveHour: quota.fiveHour?.used, weekly: quota.weekly?.used, weekResetAt: quota.weekly?.resetAt }
  const weekElapsed = load.weekResetAt === undefined ? undefined
    : Math.max(0, Math.min(100, (1 - (load.weekResetAt - now) / WEEK_MS) * 100))
  return { fiveHour: load.fiveHour, weekly: load.weekly, weekElapsed }
}

const sameCandidate = (a: Candidate, b: Candidate): boolean => a.vendor === b.vendor && a.model === b.model

// A candidate as fallback trails name it: its CLI or account, then its model.
const choiceName = (candidate: Candidate): string => (candidate.account ?? candidate.vendor) + ' ' + candidate.model

// The candidates a seat line may run on, in the order tried, CLIs this machine lacks left out.
async function chainFor($: EngineInterface, marker: Marker): Promise<Candidate[]> {
  const installed: SeatVendor[] = ['claude', ...await installedVendors($)]
  const usable = (list: Candidate[]): Candidate[] => list.filter(candidate => installed.includes(candidate.vendor))
  if ('vendor' in marker) {
    const named = { vendor: marker.vendor, model: marker.model, effort: marker.effort }
    return [named, ...usable(await sizeCandidates($, sizeOf(marker.effort))).filter(candidate => !sameCandidate(candidate, named))]
  }
  const list = usable(await sizeCandidates($, marker.size))
  if (marker.account !== undefined) return [accountCandidate(marker.size, marker.account), ...list]
  if (marker.prefer === undefined) return list
  const prefer = marker.prefer
  return [...list.filter(candidate => isPreferred(candidate, prefer)), ...list.filter(candidate => !isPreferred(candidate, prefer))]
}

// Node and the CLIs take `/` on Windows too, so paths the mod builds join with it.
function join(...parts: string[]): string {
  return parts.join('/')
}

function slashed(path: string): string {
  return path.replaceAll('\\', '/')
}

async function isWindows($: EngineInterface): Promise<boolean> {
  return await $.env.get('OS') === 'Windows_NT'
}

async function homeDir($: EngineInterface): Promise<string | undefined> {
  return await $.env.get('HOME') ?? await $.env.get('USERPROFILE')
}

// Where seat folders live: /tmp on macOS and Linux, the user's TEMP on Windows.
// codex's Windows sandbox cannot make a folder with a non-ASCII path writable, and
// an 8.3 TEMP still resolves to the long name, so a non-ASCII profile moves seats
// to PUBLIC, which every local user can read.
async function seatRoot($: EngineInterface): Promise<string> {
  if (!await isWindows($)) return '/tmp'
  const temp = slashed(await $.env.get('TEMP') ?? 'C:/Windows/Temp')
  const ascii = [temp, await $.env.get('USERPROFILE') ?? ''].every(path => /^[\x20-\x7e]*$/.test(path))
  const shared = await $.env.get('PUBLIC')
  return ascii || !shared ? temp : slashed(shared) + '/seat-router'
}

// The POSIX tools seat-io.mjs stands in for, on every platform.
function io($: EngineInterface, args: string[], init?: { timeoutMs?: number, stdin?: string }): ReturnType<EngineInterface['process']['run']> {
  return $.process.run(['node', join($.plugin.root, 'bin', 'seat-io.mjs'), ...args], init)
}

// Claude Code 2.1.310 lists no plugin userConfig rows in /config, so $.config.set
// refuses them: settings are saved through the CLI, under the id the plugin is
// installed as. A --plugin-dir load (`@inline`) has none: its options live in
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

// agy reads only its workspace: the folders its brief names by absolute path
// (`/…`, `~/…`, or `C:\…` on Windows), outside the seat's own, are granted
// read-only. A root and HOME are never granted.
async function briefReads($: EngineInterface, seat: Pick<Seat, 'brief' | 'dir' | 'workDir'>): Promise<string[]> {
  const found = await homeDir($)
  const home = found === undefined ? undefined : slashed(found)
  const folders = new Set<string>()
  for (const match of seat.brief.matchAll(/(?:^|[\s`'"(<[])(~?\/[\w.@+\/-]+|[A-Za-z]:[\\/][\w.@+\\\/-]*)/g)) {
    const named = slashed(match[1] ?? '').replace(/[.,:;]+$/, '').replace(/\/+$/, '')
    const path = named.startsWith('~/') ? (home === undefined ? '' : home + named.slice(1)) : named
    if (!path.startsWith('/') && !/^[A-Za-z]:\//.test(path)) continue
    let kind: string
    try { kind = (await $.fs.stat(path)).kind } catch { continue }
    const folder = kind === 'dir' ? path : path.slice(0, path.lastIndexOf('/'))
    const inside = (root: string) => folder === slashed(root) || folder.startsWith(slashed(root) + '/')
    if (!folder || /^[A-Za-z]:$/.test(folder) || folder === home || inside(seat.workDir) || inside(seat.dir)) continue
    folders.add(folder)
  }
  return [...folders].sort()
}

// Why owner-guard.mjs refuses a shell command, or undefined when it may run: the
// guard of a Claude subagent that runs an owner seat, as codex and agy owners have.
export async function ownerGuardReason($: EngineInterface, command: string): Promise<string | undefined> {
  const ran = await $.process.run(['node', join($.plugin.root, 'bin', 'owner-guard.mjs')], { stdin: JSON.stringify({ tool_input: { command } }) })
  return ran.exitCode === 2 ? ran.stderr.trim() || 'seat-router owner guard: refused.' : undefined
}

// codex's own prefix rules miss reworded commands (`git -C . reset --hard`) and any
// line its shell parser gives up on (`HEAD~1`), so an owner's commands pass this hook.
// The hook comes from the command line, which codex runs only past its hook trust check.
function ownerGuard($: EngineInterface): string[] {
  const command = 'node "' + slashed($.plugin.root) + '/bin/owner-guard.mjs"'
  return ['--dangerously-bypass-hook-trust', '-c', 'hooks.PreToolUse=[{matcher="Bash",hooks=[{type="command",command=' + JSON.stringify(command) + '}]}]']
}

export function claudeBrief(brief: string, trail: string[]): string {
  return trail.length === 0 ? brief : 'Fallback trail (repeat this as the first line of your report): ' + trail.join(' → ') + '\n\n' + brief
}

export function tokenCount(jsonl: string): number | undefined {
  let total: number | undefined
  for (const line of jsonl.split('\n')) {
    const payload = asObject(asObject(readJson(line))?.payload)
    const usage = asObject(asObject(payload?.info)?.total_token_usage)
    total = numberAt(usage?.total_tokens) ?? total
  }
  return total
}

export function completedTokens(jsonl: string): number | undefined {
  for (const line of jsonl.split('\n')) {
    const event = asObject(readJson(line))
    if (event?.type !== 'turn.completed') continue
    const usage = asObject(event.usage)
    const input = numberAt(usage?.input_tokens)
    const output = numberAt(usage?.output_tokens)
    if (input !== undefined && output !== undefined) return input + output
  }
  return undefined
}

export function agyTokens(text: string): number | undefined {
  let event: string | undefined
  let total = 0
  let result: number | undefined
  for (const match of text.matchAll(/"event"\s*:\s*"(step_update|result)"|"total_tokens"\s*:\s*(\d+)/g)) {
    if (match[1]) event = match[1]
    if (match[2] && event === 'step_update') total += Number(match[2])
    if (match[2] && event === 'result') result = Number(match[2])
  }
  return result ?? (total || undefined)
}

export type Activity = { steps: number, lastAction?: string }

/** The transcript a seat's CLI writes: codex, agy, or Claude on another account. */
export type Transcript = ExternalVendor | 'claude'

// A Claude subagent seat writes no transcript of its own.
const transcriptOf = (seat: Pick<Seat, 'vendor' | 'account'>): Transcript | undefined =>
  seat.account !== undefined ? 'claude' : seat.vendor === 'claude' ? undefined : seat.vendor

// A step is one finished tool call: codex streams item.started then item.completed,
// agy streams ACTIVE then DONE (or ERROR) for the same step, Claude a tool_result.
export const STEP_PATTERN: Record<Transcript, string> = {
  codex: '"type":"item\\.completed","item":\\{"id":"[^"]*","type":"(command_execution|file_change|mcp_tool_call)"',
  agy: '"state":"(DONE|ERROR)","step_type":"tool"',
  claude: '"type":"tool_result"',
}

const claudeUsageTokens = (usage: Record<string, unknown> | undefined): number =>
  ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].reduce((sum, key) => sum + (numberAt(usage?.[key]) ?? 0), 0)

/** A Claude transcript's tokens: its result's total once it has one, else each assistant message's usage once. */
export function claudeTokens(jsonl: string): number | undefined {
  const messages = new Map<string, number>()
  for (const line of jsonl.split('\n')) {
    const event = asObject(readJson(line))
    if (event?.type === 'result' && asObject(event.usage)) return claudeUsageTokens(asObject(event.usage))
    const message = asObject(event?.message)
    const id = textAt(message?.id)
    if (event?.type === 'assistant' && id && asObject(message?.usage)) messages.set(id, claudeUsageTokens(asObject(message?.usage)))
  }
  return messages.size ? [...messages.values()].reduce((sum, value) => sum + value, 0) : undefined
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 120)
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

// codex runs every command as `/bin/zsh -lc '<command>'`.
function shellCommand(command: string): string {
  return /^\S*\/(?:ba|z)?sh -l?c (['"])([\s\S]*)\1$/.exec(command)?.[2] ?? command
}

function codexAction(item: Record<string, unknown>): string | undefined {
  const command = textAt(item.command)
  if (item.type === 'command_execution' && command) return 'Ran ' + shellCommand(command)
  if (item.type === 'file_change') {
    const changes = Array.isArray(item.changes) ? item.changes : []
    const paths = changes.map(change => textAt(asObject(change)?.path)).filter(path => path !== undefined)
    return paths.length ? 'Edited ' + paths.map(fileName).join(', ') : undefined
  }
  if (item.type === 'mcp_tool_call') return textAt(item.tool)
  if (item.type === 'agent_message') return textAt(item.text)?.split('\n')[0]
  return undefined
}

function agyAction(step: Record<string, unknown>): string | undefined {
  const name = textAt(step.tool_name)
  if (step.step_type !== 'tool' || !name) return undefined
  const parameters = asObject(asObject(step.tool_info)?.parameters) ?? {}
  const command = textAt(parameters.CommandLine)
  if (command) return 'Ran ' + command
  const path = textAt(parameters.Path) ?? textAt(parameters.AbsolutePath) ?? textAt(parameters.TargetFile)
  return name.replace(/_/g, ' ') + (path ? ' ' + fileName(path) : '')
}

function claudeAction(event: Record<string, unknown>): string | undefined {
  const content = asObject(event.message)?.content
  if (event.type !== 'assistant' || !Array.isArray(content)) return undefined
  let action: string | undefined
  for (const block of content.map(asObject)) {
    const input = asObject(block?.input) ?? {}
    const command = textAt(input.command)
    const path = textAt(input.file_path) ?? textAt(input.path)
    if (block?.type === 'tool_use' && command) action = 'Ran ' + command
    else if (block?.type === 'tool_use') action = (textAt(block.name) ?? 'tool') + (path ? ' ' + fileName(path) : '')
    else if (block?.type === 'text') action = textAt(block.text)?.split('\n')[0] ?? action
  }
  return action
}

/** The newest action in a transcript tail, as one short line. */
export function lastAction(vendor: Transcript, text: string): string | undefined {
  let action: string | undefined
  for (const line of text.split('\n')) {
    const event = asObject(readJson(line))
    const item = asObject(vendor === 'codex' ? event?.item : vendor === 'agy' ? event?.step_update : event)
    const found = item && (vendor === 'codex' ? codexAction(item) : vendor === 'agy' ? agyAction(item) : claudeAction(item))
    if (found?.trim()) action = oneLine(found)
  }
  return action
}

function threadId(jsonl: string): string | undefined {
  const event = asObject(readJson(jsonl))
  return event?.type === 'thread.started' ? textAt(event.thread_id) : undefined
}

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

async function head($: EngineInterface, path: string): Promise<string> {
  try {
    const result = await io($, ['head', '-n', '1', path])
    return result.exitCode === 0 ? result.stdout : ''
  } catch { return '' }
}

async function grepTokens($: EngineInterface, path: string): Promise<string> {
  try {
    const result = await io($, ['grep', '-oE', '"event"[[:space:]]*:[[:space:]]*"(step_update|result)"|"total_tokens"[[:space:]]*:[[:space:]]*[0-9]+', path])
    return result.exitCode === 0 ? result.stdout : ''
  } catch { return '' }
}

async function writeSeat($: EngineInterface, seat: Seat): Promise<void> {
  await $.fs.write(join(seat.dir, 'seat.json'), JSON.stringify(seat, null, 2))
}

async function readActivity($: EngineInterface, seat: Seat): Promise<Activity | undefined> {
  const kind = transcriptOf(seat)
  if (seat.status !== 'running' || kind === undefined) return undefined
  const transcript = join(seat.dir, kind + '.jsonl')
  let steps = 0
  try {
    steps = Number.parseInt((await io($, ['grep', '-cE', STEP_PATTERN[kind], transcript])).stdout, 10) || 0
  } catch {}
  const action = lastAction(kind, await tail($, transcript, 20))
  return { steps, ...(action === undefined ? {} : { lastAction: action }) }
}

function display(seat: Seat, liveTokens: number | undefined, activity: Activity): SeatDisplay {
  return {
    id: seat.id, description: seat.description, vendor: seat.vendor, model: seat.model, effort: seat.effort,
    ...(seat.account === undefined ? {} : { account: seat.account }), tier: seat.tier, status: seat.status, steps: activity.steps,
    startedAt: seat.startedAt, ...(seat.endedAt === undefined ? {} : { endedAt: seat.endedAt }),
    ...(liveTokens === undefined ? {} : { liveTokens }),
    ...(activity.lastAction === undefined ? {} : { lastAction: activity.lastAction }),
  }
}

// Tokens and activity are read only while a seat runs; afterwards it keeps the last ones seen on the same vendor.
export function seatValue(seat: Seat, prior: SeatDisplay | undefined, liveTokens?: number, activity?: Activity): SeatDisplay {
  const same = prior?.vendor === seat.vendor ? prior : undefined
  const lastTokens = liveTokens ?? same?.lastTokens ?? same?.liveTokens
  const kept = activity ?? { steps: same?.steps ?? 0, ...(same?.lastAction === undefined ? {} : { lastAction: same.lastAction }) }
  return { ...display(seat, liveTokens, kept), ...(lastTokens === undefined ? {} : { lastTokens }) }
}

// The poll runs every 5 s; writing an unchanged seat would redraw every reader.
async function putSeat($: EngineInterface, seat: Seat, liveTokens?: number, activity?: Activity): Promise<void> {
  const prior = (await read($, seatsState)).find(value => value.id === seat.id)
  if (prior && JSON.stringify(prior) === JSON.stringify(seatValue(seat, prior, liveTokens, activity))) return
  await update($, seatsState, seats => {
    const current = seats.find(value => value.id === seat.id)
    return [...seats.filter(value => value.id !== seat.id), seatValue(seat, current, liveTokens, activity)]
  })
}

// A reviewer's built-in tools besides its shell: none reaches the network or another session.
const REVIEWER_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'NotebookEdit', 'Skill']

// Claude on another account, with no mod loaded: nobody sees or approves what a mod asks.
// A reviewer's shell runs in Claude Code's sandbox, writing only its folder with no network
// (failIfUnavailable: should the sandbox not start, the seat fails and moves on rather than
// run unsandboxed). The sandbox leaves a worktree's git folders writable, so they are denied
// by absolute path (`//`), which the sandbox and the file tools both honour. On Windows,
// where Claude Code's sandbox does not run, a reviewer has no shell at all; its file tools
// stay held to its folder by acceptEdits. A reviewer gets only the tools that read and edit
// files (`--tools`), none that publishes, schedules or messages, and no MCP server.
// An owner runs without prompts, its account's MCP servers on, its shell commands past
// owner-guard.mjs.
async function launchAccount($: EngineInterface, seat: Seat & { account: string }): Promise<void> {
  const isReviewer = seat.tier === 'reviewer'
  const windows = isReviewer && await isWindows($)
  if (windows) await $.fs.write(join(seat.dir, 'brief.md'), seat.brief + '\n' + NO_SHELL_NOTE)
  const gitDenied = isReviewer ? (await gitDirs($, seat.workDir)).map(dir => 'Edit(/' + (dir.startsWith('/') ? '' : '/') + slashed(dir) + '/**)') : []
  const tiered = !isReviewer ? {
    hooks: { PreToolUse: [{ matcher: SHELL_TOOLS.join('|'), hooks: [{ type: 'command', command: 'node "' + slashed($.plugin.root) + '/bin/owner-guard.mjs"' }] }] },
  } : windows ? {
    permissions: { deny: [...SHELL_TOOLS, 'Edit(.git/**)', ...gitDenied, 'WebFetch', 'WebSearch'] },
  } : {
    sandbox: {
      enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false,
      network: { allowedDomains: [] },
    },
    permissions: { deny: ['Edit(.git/**)', ...gitDenied, 'WebFetch', 'WebSearch'] },
  }
  // Flag settings outrank the account's own, whose env names its mods.
  const settings = { env: { CLAUDE_CODE_PLUGIN_DIRS: '' }, ...tiered }
  await $.fs.write(join(seat.dir, 'settings.json'), JSON.stringify(settings, null, 2))
  const spec: LaunchSpec = {
    argv: [
      'claude', '-p', '--model', seat.model, ...(seat.effort ? ['--effort', seat.effort] : []),
      '--output-format', 'stream-json', '--verbose', '--settings', join(seat.dir, 'settings.json'),
      ...(isReviewer
        ? ['--tools=' + [...(windows ? [] : ['Bash']), ...REVIEWER_TOOLS].join(','), '--strict-mcp-config', '--permission-mode', 'acceptEdits']
        : ['--permission-mode', 'bypassPermissions']),
    ],
    cwd: seat.workDir, stdin: join(seat.dir, 'brief.md'),
    stdout: join(seat.dir, 'claude.jsonl'), stderr: join(seat.dir, 'claude.err'), exit: join(seat.dir, 'exit'), pid: join(seat.dir, 'pid'),
  }
  // The session's own mods, this one among them, would also come in through the environment.
  const env = { CLAUDE_CONFIG_DIR: await accountDir($, seat.account), CLAUDE_CODE_PLUGIN_DIRS: '' }
  await start($, seat, spec, isReviewer ? env : { ...await ownerEnv($), ...env })
}

async function launch($: EngineInterface, seat: Seat): Promise<void> {
  const brief = seat.tier === 'owner' && seat.vendor === 'agy' ? seat.brief + '\n' + OWNER_NOTE : seat.brief
  await $.fs.write(join(seat.dir, 'brief.md'), brief)
  if (seat.account !== undefined) return launchAccount($, { ...seat, account: seat.account })
  const windows = await isWindows($)
  const spec: LaunchSpec = seat.vendor === 'codex' ? {
    argv: [
      'codex', 'exec', '--json', '-m', seat.model, '-c', 'model_reasoning_effort=' + seat.effort,
      '-s', 'workspace-write', '--skip-git-repo-check', '-C', seat.workDir,
      // A reviewer is held to its folder: the user's config would start their MCP servers
      // (computer use among them), and codex's apps, plugins and web search reach the network
      // from the cloud. An owner keeps all of them, as a development session does.
      ...(seat.tier === 'reviewer' ? [
        '--ignore-user-config', '--disable', 'apps', '--disable', 'plugins', '--disable', 'remote_plugin',
        '-c', 'web_search="disabled"',
        // Without a Windows sandbox mode codex refuses every command; the user's config
        // would have named one.
        ...(windows ? ['-c', 'windows.sandbox="unelevated"'] : []),
      ] : []),
      ...(seat.tier === 'owner' ? [
        '-c', 'sandbox_workspace_write.network_access=true', '-c', 'shell_environment_policy.ignore_default_excludes=true',
        ...ownerGuard($),
        ...(seat.gitDirs ?? []).flatMap(dir => ['--add-dir', dir]),
      ] : []),
      '-o', join(seat.dir, 'final.md'), '-',
    ],
    cwd: seat.workDir, stdin: join(seat.dir, 'brief.md'),
    // The Store's pwsh.exe alias cannot start inside codex's Windows sandbox; without
    // it on PATH codex runs System32's powershell.exe.
    ...(windows ? { dropWindowsApps: true } : {}),
    stdout: join(seat.dir, 'codex.jsonl'), stderr: join(seat.dir, 'codex.err'), exit: join(seat.dir, 'exit'), pid: join(seat.dir, 'pid'),
  } : {
    argv: [
      'agy', '--output-format', 'stream-json', '--model', seat.model, '--effort', agyEffort(seat.effort),
      '--sandbox', '--mode', 'accept-edits', '-p', { file: join(seat.dir, 'brief.md') },
    ],
    cwd: seat.workDir,
    home: [
      ...(seat.tier === 'owner' ? ['owner'] : []), '--home', join(seat.dir, 'home'),
      ...(await briefReads($, seat)).flatMap(folder => ['--read', folder]),
    ],
    stdout: join(seat.dir, 'agy.jsonl'), stderr: join(seat.dir, 'agy.err'), exit: join(seat.dir, 'exit'), pid: join(seat.dir, 'pid'),
  }
  await start($, seat, spec, seat.tier === 'owner' ? await ownerEnv($) : undefined)
}

// What run-seat.mjs starts: a CLI (`{ file }` in argv is that file's text) or a wait.
type LaunchSpec = {
  argv?: Array<string | { file: string }>
  cwd?: string
  stdin?: string
  stdout?: string
  stderr?: string
  exit: string
  pid?: string
  home?: string[]
  dropWindowsApps?: boolean
  sleep?: number
}

// The launcher returns at once and leaves the CLI running detached, so the seat outlives a reload of this mod.
async function start($: EngineInterface, seat: Seat, spec: LaunchSpec, env?: Record<string, string>): Promise<void> {
  const path = join(seat.dir, 'launch.json')
  await $.fs.write(path, JSON.stringify(spec, null, 2))
  await $.process.run(['node', join($.plugin.root, 'bin', 'run-seat.mjs'), path], env ? { env } : undefined)
}

// An owner reaches GitHub through the operator's gh token, passed in the
// environment only: the seat's sandbox or HOME cannot reach the keychain.
async function ownerEnv($: EngineInterface): Promise<Record<string, string>> {
  const token = await $.process.run(['gh', 'auth', 'token'])
  if (token.exitCode !== 0 || !token.stdout.trim()) return {}
  return {
    GH_TOKEN: token.stdout.trim(),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_0: '!gh auth git-credential',
  }
}

async function scheduleWait($: EngineInterface, seat: Seat, until: number): Promise<void> {
  const now = await $.clock.now()
  seat.status = 'waiting'
  seat.waitedAt ??= now
  seat.waitUntil = Math.max(now, until)
  await writeSeat($, seat)
  await putSeat($, seat)
  const seconds = Math.max(0, Math.ceil((seat.waitUntil - now) / 1000))
  await start($, seat, { sleep: seconds, exit: join(seat.dir, 'exit'), pid: join(seat.dir, 'pid') })
}

// codex keeps a worktree's own git dir read-only even under a writable common
// dir, so an owner gets both.
async function gitDirs($: EngineInterface, workDir: string): Promise<string[]> {
  const found = await $.process.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir'], { cwd: workDir })
  if (found.exitCode !== 0) return []
  return [...new Set(found.stdout.split('\n').map(line => line.trim()).filter(Boolean))]
}

async function makeSeat($: EngineInterface, input: AgentInput, marker: Marker, chain: Candidate[]): Promise<Seat> {
  // seat-io prints the resolved path: agy's sandbox checks writes against it, so
  // a workspace reached through a symlink (macOS /tmp) has every file write denied.
  const created = await io($, ['mktemp', '-d', join(await seatRoot($), 'seat.XXXXXX')])
  if (created.exitCode !== 0 || !created.stdout.trim()) throw new Error('mktemp failed: ' + created.stderr)
  const dir = slashed(created.stdout.trim())
  const id = 'seat-' + dir.slice(dir.lastIndexOf('.') + 1)
  const sessionId = await $.session.id()
  const pwd = await io($, ['pwd'])
  const sessionCwd = pwd.stdout.trim()
  const now = await $.clock.now()
  const first = chain[0] ?? { vendor: 'claude', model: 'opus', effort: '' }
  const seat: Seat = {
    id, sessionId, description: input.description, vendor: first.vendor, model: first.model,
    effort: first.effort, ...(first.account === undefined ? {} : { account: first.account }), tier: marker.tier, chainPosition: 0, status: 'running', startedAt: now,
    reported: false, dir, workDir: dir, sessionCwd, brief: marker.brief, chain, fallbackTrail: [],
    ...(input.isolation === 'worktree' ? { isolation: 'worktree' as const } : {}),
  }
  if (seat.isolation === 'worktree') {
    seat.worktreePath = join(dir, 'wt')
    seat.worktreeBranch = 'seat/' + id
    const tree = await $.process.run(['git', 'worktree', 'add', '-b', seat.worktreeBranch, seat.worktreePath, 'HEAD'], { cwd: sessionCwd })
    if (tree.exitCode !== 0) throw new Error('git worktree add failed: ' + tree.stderr)
    seat.workDir = seat.worktreePath
  }
  if (seat.tier === 'owner' && seat.vendor === 'codex') seat.gitDirs = await gitDirs($, seat.workDir)
  return seat
}

const seatName = (seat: Pick<Seat, 'vendor' | 'account'>): string =>
  seat.account === undefined ? seat.vendor : 'claude on the ' + seat.account + ' account'

function reportText(seat: Seat, text: string): string {
  const lines = ['Seat ' + seat.id + ' ("' + seat.description + '", ' + seatName(seat) + ' ' + seat.model + ' ' + seat.effort + ' ' + seat.tier + ') finished.']
  if (seat.fallbackTrail.length) lines.push('Fallback: ' + seat.fallbackTrail.join(' → '))
  if (seat.waitedMs !== undefined) lines.push('Waited ' + Math.ceil(seat.waitedMs / 1000) + ' seconds for quota reset.')
  if (seat.tier === 'owner' && seat.worktreeBranch && seat.worktreePath) lines.push('Worktree: ' + seat.worktreeBranch + ' at ' + seat.worktreePath)
  lines.push('', text)
  return lines.join('\n')
}

function agyResult(jsonl: string): { text: string, valid: boolean, denied: string[] } {
  let last: Record<string, unknown> | undefined
  for (const line of jsonl.split('\n')) {
    const parsed = asObject(readJson(line))
    if (parsed) last = parsed
  }
  if (last?.event !== 'result' && last?.type !== 'result') return { text: '', valid: false, denied: [] }
  const result = asObject(last?.result)
  // agy leaves denied_actions out when nothing was refused.
  const denied = result?.denied_actions
  const isClean = denied === undefined || denied === null || (Array.isArray(denied) && denied.length === 0)
  const names = Array.isArray(denied) ? denied.map(action => textAt(asObject(action)?.action) ?? '?') : []
  return { text: textAt(result?.response) ?? '', valid: result?.status === 'SUCCESS' && isClean, denied: names }
}

export function failedSeat(vendor: ExternalVendor, exitCode: number | undefined, text: string, transcript: string, stderr: string): Check {
  const all = text + '\n' + transcript + '\n' + stderr
  const quota = vendor === 'codex'
    ? /usageLimitExceeded|Usage limit reached/i.test(all)
    : /RESOURCE_EXHAUSTED|exhausted your quota|out of quota/i.test(all)
  const blank = !text.trim()
  const completed = vendor !== 'codex' || transcript.split('\n').some(line => line.includes('"turn.completed"'))
  const failed = exitCode !== 0 || blank || !completed
  const detail = quota ? 'usage limit reached'
    : exitCode !== 0 ? 'exit ' + String(exitCode)
    : blank ? 'empty final text'
    : !completed ? 'missing turn.completed' : ''
  return { text, failed, quota, detail }
}

export function failedAgy(exitCode: number | undefined, jsonl: string, stderr: string): Check {
  const result = agyResult(jsonl)
  const base = failedSeat('agy', exitCode, result.text, jsonl, stderr)
  const failed = base.failed || !result.valid
  const detail = result.denied.length ? 'denied ' + result.denied.join(', ') : base.detail || (!result.valid ? 'agy result failed' : '')
  return { ...base, failed, detail: base.quota ? base.detail : detail }
}

// A Claude run passes when its last result event is a success with text; events such as
// a task summary may follow it. It is out of quota when its stream says the rate limit
// rejected it or the API answered 429.
export function failedClaude(exitCode: number | undefined, tailText: string, rejected: boolean): Check {
  const event = tailText.split('\n').map(line => asObject(readJson(line.trim()))).filter(found => found?.type === 'result').at(-1)
  const isResult = event !== undefined
  const text = isResult ? textAt(event.result) ?? '' : ''
  const quota = rejected || (isResult && event.api_error_status === 429)
  const ok = isResult && event.subtype === 'success' && event.is_error !== true
  const failed = exitCode !== 0 || !ok || !text.trim()
  const detail = quota ? 'usage limit reached'
    : exitCode !== 0 ? 'exit ' + String(exitCode)
    : !isResult ? 'no result event'
    : !ok ? 'result ' + String(event.subtype) + (event.is_error === true ? ' (error)' : '')
    : !text.trim() ? 'empty final text' : ''
  return { text, failed, quota, detail }
}

async function checkSeat($: EngineInterface, seat: Seat): Promise<Check> {
  const exitCode = Number((await readText($, join(seat.dir, 'exit'))).trim())
  if (seat.account !== undefined) {
    const transcript = join(seat.dir, 'claude.jsonl')
    const rejected = await matches($, '"type":"rate_limit_event","rate_limit_info":\\{"status":"rejected"', [transcript])
    const checked = failedClaude(Number.isNaN(exitCode) ? undefined : exitCode, await tail($, transcript, 20), rejected)
    if (!checked.failed || checked.detail.startsWith('usage')) return checked
    // A run that never started a turn (a refused sandbox, a bad flag) says why only on stderr.
    const stderr = oneLine(await readText($, join(seat.dir, 'claude.err')))
    return stderr ? { ...checked, detail: checked.detail + ': ' + stderr } : checked
  }
  if (seat.vendor === 'codex') {
    const text = await readText($, join(seat.dir, 'final.md'))
    const transcript = join(seat.dir, 'codex.jsonl')
    const stderr = join(seat.dir, 'codex.err')
    const completed = await matches($, '"turn.completed"', [transcript])
    const limited = await matches($, 'usageLimitExceeded|Usage limit reached', [transcript, stderr])
    return failedSeat('codex', Number.isNaN(exitCode) ? undefined : exitCode, text,
      completed ? '"turn.completed"' : '', limited ? 'usageLimitExceeded' : '')
  }
  const transcript = join(seat.dir, 'agy.jsonl')
  const limited = await matches($, 'RESOURCE_EXHAUSTED|exhausted your quota|out of quota', [transcript, join(seat.dir, 'agy.err')])
  return failedAgy(Number.isNaN(exitCode) ? undefined : exitCode, await tail($, transcript), limited ? 'RESOURCE_EXHAUSTED' : '')
}

async function seatsFor($: EngineInterface, sessionId: string): Promise<Seat[]> {
  let entries: Awaited<ReturnType<EngineInterface['fs']['list']>> = []
  const root = await seatRoot($)
  try { entries = await $.fs.list(root) } catch { return [] }
  const seats: Seat[] = []
  for (const entry of entries) {
    if (entry.kind !== 'dir' || !entry.name.startsWith('seat.')) continue
    const parsed = readJson(await readText($, join(root, entry.name, 'seat.json')))
    const seat = asObject(parsed) as unknown as Seat | undefined
    if (seat?.sessionId === sessionId && typeof seat.dir === 'string') seats.push(seat)
  }
  return seats
}

async function report($: EngineInterface, seat: Seat, text: string, submit = true): Promise<void> {
  if (seat.reported || seat.status === 'reported') return
  const claimed = await io($, ['mkdir', join(seat.dir, 'reporting')])
  if (claimed.exitCode !== 0) return
  seat.status = 'reporting'
  seat.endedAt ??= await $.clock.now()
  const report = reportText(seat, text)
  await $.fs.write(join(seat.dir, 'report.md'), report)
  await writeSeat($, seat)
  await putSeat($, seat)
  if (submit) await $.prompt.submit({ text: report })
  seat.reported = true
  seat.status = 'reported'
  await writeSeat($, seat)
  await putSeat($, seat)
}

async function runCandidate($: EngineInterface, seat: Seat, start: number, readings: Quota[] = []): Promise<void> {
  const choices = seat.chain
  let earliest: number | undefined
  for (let position = start; position < choices.length; position += 1) {
    const choice = choices[position]
    if (!choice) continue
    const available = readings[position] ?? await candidateQuota($, choice)
    if (available.out) {
      seat.fallbackTrail.push(choiceName(choice) + ' out (' + (available.detail || 'quota unavailable') + ')')
      if (available.resetAt !== undefined) earliest = earliest === undefined ? available.resetAt : Math.min(earliest, available.resetAt)
      continue
    }
    if (seat.fallbackTrail.length) seat.fallbackTrail.push(choiceName(choice))
    seat.vendor = choice.vendor
    seat.model = choice.model
    seat.effort = choice.effort
    if (choice.account === undefined) delete seat.account
    else seat.account = choice.account
    seat.chainPosition = position
    if (choice.vendor === 'codex') {
      seat.rolloutPath = undefined
      seat.rolloutSearched = false
    }
    if (choice.vendor === 'claude' && choice.account === undefined) {
      // A plugin's own $.agent.spawn gets no auto-mode verdict outside a request,
      // so the session starts the Claude agent itself, inside its turn.
      await report($, seat, 'codex and agy could not take this seat. Start an Agent yourself (' + claudeAgent(choice) + ', '
        + (seat.isolation === 'worktree' ? 'isolation worktree, ' : '') + 'no seat line) with this brief:\n\n'
        + claudeBrief(seat.brief, seat.fallbackTrail))
      return
    }
    if (seat.tier === 'owner' && choice.vendor === 'codex' && !seat.gitDirs) seat.gitDirs = await gitDirs($, seat.workDir)
    seat.status = 'running'
    await writeSeat($, seat)
    await putSeat($, seat)
    await launch($, seat)
    return
  }
  await scheduleWait($, seat, earliest ?? (await $.clock.now()) + 60_000)
}

async function codexSessions($: EngineInterface): Promise<string> {
  const codexHome = await $.env.get('CODEX_HOME') ?? join(await homeDir($) ?? '', '.codex')
  return join(codexHome, 'sessions')
}

async function liveTokens($: EngineInterface, seat: Seat): Promise<number | undefined> {
  if (seat.status !== 'running' || transcriptOf(seat) === undefined) return undefined
  if (seat.account !== undefined) return claudeTokens(await readText($, join(seat.dir, 'claude.jsonl')))
  if (seat.vendor === 'agy') return agyTokens(await grepTokens($, join(seat.dir, 'agy.jsonl')))
  if (!seat.rolloutPath && !seat.rolloutSearched) {
    const id = threadId(await head($, join(seat.dir, 'codex.jsonl')))
    if (id) {
      seat.rolloutSearched = true
      try {
        const found = await io($, ['find', await codexSessions($), '-name', '*' + id + '.jsonl'])
        if (found.exitCode === 0 && found.stdout.trim()) seat.rolloutPath = found.stdout.trim().split('\n')[0]
      } catch {}
      await writeSeat($, seat)
    }
  }
  return seat.rolloutPath
    ? tokenCount(await tail($, seat.rolloutPath, 100))
    : completedTokens(await tail($, join(seat.dir, 'codex.jsonl'), 100))
}

export async function pollSession($: EngineInterface, sessionId: string): Promise<void> {
  for (const seat of await seatsFor($, sessionId)) {
    await putSeat($, seat, await liveTokens($, seat), await readActivity($, seat))
    if (seat.reported || seat.status === 'reported' || seat.status === 'reporting') continue
    const exit = await readText($, join(seat.dir, 'exit'))
    if (!exit.trim()) {
      if (await launcherGone($, seat) && !(await readText($, join(seat.dir, 'exit'))).trim()) {
        await report($, seat, 'The seat\'s process ended without an exit code (killed, or the machine restarted); it was not rerun.'
          + ' Its output so far:\n\n' + (await partialOutput($, seat) || '(none)'))
      }
      continue
    }
    if (seat.status === 'waiting') {
      const now = await $.clock.now()
      seat.waitedMs = now - (seat.waitedAt ?? now)
      await runCandidate($, seat, 0)
      continue
    }
    if (seat.status !== 'running') continue
    const checked = await checkSeat($, seat)
    if (!checked.failed) {
      await report($, seat, checked.text)
      continue
    }
    seat.fallbackTrail.push(checked.quota ? seat.vendor + ' out (' + checked.detail + ')' : seat.vendor + ' failed (' + checked.detail + ')')
    // An owner may have committed or pushed before it failed; rerunning its
    // brief elsewhere would repeat that, so only a usage limit moves it on.
    if (seat.tier === 'owner' && !checked.quota) {
      await report($, seat, 'The owner seat failed and was not rerun, because it may already have changed its branch. '
        + 'Its output:\n\n' + (checked.text || '(none)'))
      continue
    }
    await runCandidate($, seat, seat.chainPosition + 1)
  }
}

// The launcher's pid, from the pid file run-seat writes; seats launched before it wrote one have none.
async function launcherPid($: EngineInterface, seat: Seat): Promise<number | undefined> {
  return numberAt(asObject(readJson(await readText($, join(seat.dir, 'pid'))))?.launcher)
}

async function launcherGone($: EngineInterface, seat: Seat): Promise<boolean> {
  const pid = await launcherPid($, seat)
  return pid !== undefined && (await io($, ['alive', String(pid)])).exitCode === 1
}

async function partialOutput($: EngineInterface, seat: Seat): Promise<string> {
  const kind = transcriptOf(seat) ?? 'codex'
  return (await readText($, join(seat.dir, 'final.md'))).trim() || lastAction(kind, await tail($, join(seat.dir, kind + '.jsonl'), 20)) || ''
}

/** Ends a seat of this session that is still running or waiting, with everything it started; returns its report. */
export async function stopSeat($: EngineInterface, id: string): Promise<string> {
  const seat = (await seatsFor($, await $.session.id())).find(value => value.id === id)
  if (!seat) return 'No seat ' + id + ' in this session.'
  if (seat.status !== 'running' && seat.status !== 'waiting') return 'Seat ' + id + ' is not running (' + seat.status + ').'
  const pid = await launcherPid($, seat)
  if (pid !== undefined && !await launcherGone($, seat)) {
    const killed = await io($, ['kill', String(pid)])
    if (killed.exitCode !== 0 && !await launcherGone($, seat)) return 'Could not stop seat ' + id + ': ' + killed.stderr.trim()
  }
  // A tool call cannot submit a prompt, so the stopped seat's report is this tool's result.
  await report($, seat, 'Stopped on request; it was not rerun. Its output so far:\n\n' + (await partialOutput($, seat) || '(none)'), false)
  return readText($, join(seat.dir, 'report.md'))
}

/** Deletes seat folders that ended over a week ago, from every session on this machine (see prune-seats.mjs). */
export async function pruneSeats($: EngineInterface): Promise<void> {
  await $.process.run(['node', join($.plugin.root, 'bin', 'prune-seats.mjs'), await seatRoot($)], { timeoutMs: 120_000 })
}

export async function poll($: EngineInterface): Promise<void> {
  await pollSession($, await $.session.id())
}

let activePoll: Promise<void> | undefined
let activeQuotaRefresh: Promise<void> | undefined

export function singleFlightPoll($: EngineInterface): Promise<void> {
  if (activePoll) return activePoll
  activePoll = poll($).finally(() => { activePoll = undefined })
  return activePoll
}

export function singleFlightQuotaRefresh($: EngineInterface): Promise<void> {
  if (activeQuotaRefresh) return activeQuotaRefresh
  activeQuotaRefresh = refreshQuotas($).finally(() => { activeQuotaRefresh = undefined })
  return activeQuotaRefresh
}

/** How the session starts a Claude candidate: the Agent tool's model and effort. */
export function claudeAgent(candidate: Candidate): string {
  return 'model ' + candidate.model + (candidate.effort ? ', effort ' + candidate.effort : '')
}

export async function startExternal($: EngineInterface, input: AgentInput, marker: Marker, initial: Initial): Promise<Seat> {
  const seat = await makeSeat($, input, marker, initial.chain)
  seat.fallbackTrail.push(...initial.trail)
  await writeSeat($, seat)
  await putSeat($, seat)
  if (initial.allOut) await scheduleWait($, seat, initial.resetAt ?? (await $.clock.now()) + 60_000)
  else await runCandidate($, seat, initial.position ?? 0, initial.readings)
  return seat
}

/** This session's codex and agy seats still running or waiting, by family, plus `claude` running Claude subagents. */
export async function runningFamilies($: EngineInterface, claude: number): Promise<Running> {
  const running: Running = { claude }
  for (const seat of await seatsFor($, await $.session.id())) {
    if (seat.status !== 'running' && seat.status !== 'waiting') continue
    const family = familyOf(seat)
    running[family] = (running[family] ?? 0) + 1
  }
  return running
}

/** Only a sized line naming no CLI, family or account rotates across families. */
export const isRotating = (marker: Marker): boolean => !('vendor' in marker) && marker.prefer === undefined && marker.account === undefined

// An explicit line, or a line naming an account, keeps its order and moves on only past a candidate that is out.
// A sized line naming a CLI or family runs the first of those candidates that is
// not busy, else the least loaded; any other sized line goes to the family with
// the fewest seats in `running` (see rotate), and to the least loaded when every
// family is busy.
export async function chooseInitial($: EngineInterface, marker: Marker, running: Running = {}): Promise<Initial> {
  const chain = await chainFor($, marker)
  const trail: string[] = []
  const readings: Quota[] = []
  let resetAt: number | undefined
  const now = await $.clock.now()
  const loads: Array<Load | 'out'> = []
  const rotating = isRotating(marker)
  // A named model or account runs unless it is out.
  const pinned = 'vendor' in marker || marker.account !== undefined
  for (const choice of chain) {
    const available = await candidateQuota($, choice)
    readings.push(available)
    if (available.out) {
      trail.push(choiceName(choice) + ' out (' + (available.detail || 'quota unavailable') + ')')
      if (available.resetAt !== undefined) resetAt = resetAt === undefined ? available.resetAt : Math.min(resetAt, available.resetAt)
      loads.push('out')
      continue
    }
    const load = loadOf(available, now)
    loads.push(load)
    if (!rotating && (pinned || !isBusy(load, seatConfig.busyAt))) break
  }
  const order = rotating ? rotate(chain, loads, running, seatConfig.busyAt) : []
  if (order.length) {
    const first = order[0] as number
    const busy = chain.slice(0, first).filter((_, index) => { const load = loads[index]; return load !== 'out' && load !== undefined && isBusy(load, seatConfig.busyAt) })
    return {
      chain: order.map(index => chain[index]).filter((value): value is Candidate => value !== undefined),
      trail: busy.length ? [...trail, 'busy: ' + busy.map(formatCandidate).join(', ')] : trail, allOut: false, position: 0,
      readings: order.map(index => readings[index]).filter((value): value is Quota => value !== undefined),
    }
  }
  const position = pinned ? loads.findIndex(load => load !== 'out') : pick(loads, seatConfig.busyAt)
  if (position === -1) return { chain, trail, resetAt, allOut: true, readings }
  const chosen = chain[position]
  if (!chosen || pinned) return { chain, trail, allOut: false, position, readings }
  // A sized seat starts on the chosen candidate; the ones it passed over stay behind as its fallback.
  const busy = chain.slice(0, position).filter((_, index) => loads[index] !== 'out').map(formatCandidate)
  return {
    chain: [chosen, ...chain.filter((_, index) => index !== position)],
    trail: busy.length ? [...trail, 'busy: ' + busy.join(', ')] : trail,
    allOut: false, position: 0,
    readings: [readings[position], ...readings.filter((_, index) => index !== position)].filter((value): value is Quota => value !== undefined),
  }
}
