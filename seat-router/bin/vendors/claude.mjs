import { fnv } from '../core/layout.mjs'
import { PYTHON_UTF8, asObject, defined, fileName, join, lastActionWith, numberAt, oneLine, readJson, resetTime, scriptUsage, slashed, textAt } from './shared.mjs'

const CONFIG_ENV = 'CLAUDE_CONFIG_DIR'
const SHELL_TOOLS = ['Bash', 'PowerShell']
const REVIEWER_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'NotebookEdit', 'Skill']
const NO_SHELL_NOTE = 'This seat has no shell: Bash and PowerShell are refused here. Read, search and edit files with your file tools, and say in your report what you could not run.\n'
// Concurrent Claude processes on one config folder can replace its .claude.json on Windows
// (anthropics/claude-code#78439), so there a seat on the session's account runs one at a time.
const WINDOWS_ONE_AT_A_TIME = 'Windows runs one Claude seat on the session\'s account at a time, and one is running'

// The plugins claude.ai syncs into a config folder load as `<name>@synced`, in no setting's
// enabledPlugins; each bucket's manifest.json names them.
const syncedPlugins = async (io, configDir) => {
  const root = join(configDir, 'plugins', 'synced')
  let buckets
  try { buckets = await io.list(root) } catch { return [] }
  const names = await Promise.all(buckets.filter(entry => entry.kind === 'dir' && !entry.name.startsWith('.')).map(async entry => {
    const plugins = asObject(readJson(await io.read(join(root, entry.name, 'manifest.json'))))?.plugins
    return (Array.isArray(plugins) ? plugins : []).map(plugin => textAt(asObject(plugin)?.name)).filter(defined).map(name => name + '@synced')
  }))
  return [...new Set(names.flat())]
}

const gitDirs = async (io, workDir) => {
  const found = await io.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir'], { cwd: workDir })
  if (found.exitCode !== 0) return []
  return [...new Set(found.stdout.split('\n').map(line => line.trim()).filter(Boolean))]
}

/** @type {NonNullable<import('./index.mjs').VendorAdapter['facts']>} */
const facts = async (io, { seat, configDir }) => {
  const seatConfigDir = configDir ?? join(io.home, '.claude')
  // Flag settings outrank the account's own, whose env names its mods, and the project's. The session's
  // settings name the project's plugins; the seat's config folder names that account's own.
  const enabled = [
    asObject(await io.settings('enabledPlugins')),
    asObject(asObject(readJson(await io.read(join(seatConfigDir, 'settings.json'))))?.enabledPlugins),
  ].flatMap(plugins => Object.entries(plugins ?? {}).filter(([, on]) => on !== false).map(([id]) => id))
  return {
    gitDirs: seat.tier === 'reviewer' ? await gitDirs(io, seat.workDir) : [],
    plugins: [...enabled, ...await syncedPlugins(io, seatConfigDir)],
  }
}

// No mod loads in a Claude seat: nobody sees or approves what a mod asks. A reviewer's shell runs in
// Claude Code's sandbox, writing only its folder with no network (failIfUnavailable: should
// the sandbox not start, the seat fails and moves on rather than run unsandboxed). The sandbox leaves a worktree's git folders writable, so they are denied
// by absolute path (`//`), which the sandbox and the file tools both honour. On Windows,
// where Claude Code's sandbox does not run, a reviewer has no shell at all; its file tools
// stay held to its folder by acceptEdits. A reviewer gets only the tools that read and edit
// files (`--tools`), none that publishes, schedules or messages.
// An owner runs without prompts, its shell commands past owner-guard.mjs, which sees no MCP
// tool: so no seat gets an MCP server or a claude.ai connector (`--strict-mcp-config`).
/** @type {import('./index.mjs').VendorAdapter['plan']} */
const plan = ({ seat, brief, os, guard, configDir, facts }) => {
  const isReviewer = seat.tier === 'reviewer'
  const windows = os === 'windows'
  const noShell = isReviewer && windows
  const gitDenied = /** @type {string[]} */ (facts.gitDirs).map(dir => 'Edit(/' + (dir.startsWith('/') ? '' : '/') + slashed(dir) + '/**)')
  const tiered = !isReviewer ? {
    // --claude: the hook's tool_name names the shell, and Claude Code's Bash tool is a POSIX shell on Windows too.
    hooks: { PreToolUse: [{ matcher: SHELL_TOOLS.join('|'), hooks: [{ type: 'command', command: guard + ' --claude' }] }] },
  } : noShell ? {
    permissions: { deny: [...SHELL_TOOLS, 'Edit(.git/**)', ...gitDenied, 'WebFetch', 'WebSearch'] },
  } : {
    sandbox: {
      enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false,
      network: { allowedDomains: [] },
    },
    permissions: { deny: ['Edit(.git/**)', ...gitDenied, 'WebFetch', 'WebSearch'] },
  }
  const settings = {
    env: { CLAUDE_CODE_PLUGIN_DIRS: '' },
    enabledPlugins: Object.fromEntries(/** @type {string[]} */ (facts.plugins).map(id => [id, false])),
    ...tiered,
  }
  return {
    dirs: [],
    files: { 'brief.md': noShell ? brief + '\n' + NO_SHELL_NOTE : brief, 'settings.json': JSON.stringify(settings, null, 2) },
    // The session's own mods, this one among them, would also come in through the environment.
    env: {
      ...(configDir === undefined ? {} : { [CONFIG_ENV]: configDir }),
      CLAUDE_CODE_PLUGIN_DIRS: '', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', SEAT_ROUTER_SEAT: seat.id,
      ...(!isReviewer && windows ? PYTHON_UTF8 : {}),
    },
    spec: {
      argv: [
        'claude', '-p', '--model', seat.model, ...(seat.effort ? ['--effort', seat.effort] : []),
        '--output-format', 'stream-json', '--verbose', '--settings', join(seat.dir, 'settings.json'),
        ...(isReviewer
          ? ['--tools=' + [...(noShell ? [] : ['Bash']), ...REVIEWER_TOOLS].join(','), '--strict-mcp-config', '--permission-mode', 'acceptEdits']
          : ['--strict-mcp-config', '--permission-mode', 'bypassPermissions']),
      ],
      cwd: seat.workDir, stdin: join(seat.dir, 'brief.md'), ...(seat.account === undefined ? {} : { claudeLogin: true }),
      stdout: join(seat.dir, 'claude.jsonl'), stderr: join(seat.dir, 'claude.err'),
    },
  }
}

/** Whether a Claude stream's rate_limit_event lines say the rate limit rejected the run (SDKRateLimitEvent). */
export const rateLimitRejected = lines => lines.split('\n').map(line => asObject(readJson(line))).some(event =>
  event?.type === 'rate_limit_event' && asObject(event.rate_limit_info)?.status === 'rejected')

// Claude Code can emit events such as a task summary after the result event.
export const failedClaude = (exitCode, tailText, rejected) => {
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

const judge = async (view, dir, exitCode) => {
  const transcript = join(dir, 'claude.jsonl')
  const rejected = rateLimitRejected(await view.grep('"rate_limit_event"', transcript))
  const checked = failedClaude(exitCode, await view.tail(transcript, 20), rejected)
  if (!checked.failed || checked.detail.startsWith('usage')) return checked
  // A run that never started a turn (a refused sandbox, a bad flag) says why only on stderr.
  const stderr = oneLine(await view.read(join(dir, 'claude.err')))
  return stderr ? { ...checked, detail: checked.detail + ': ' + stderr } : checked
}

const usageTokens = usage =>
  ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].reduce((sum, key) => sum + (numberAt(usage?.[key]) ?? 0), 0)

/** A Claude transcript's tokens: its result's total once it has one, else each assistant message's usage once. */
export const claudeTokens = jsonl => {
  const messages = new Map()
  for (const line of jsonl.split('\n')) {
    const event = asObject(readJson(line))
    if (event?.type === 'result' && asObject(event.usage)) return usageTokens(asObject(event.usage))
    const message = asObject(event?.message)
    const id = textAt(message?.id)
    if (event?.type === 'assistant' && id && asObject(message?.usage)) messages.set(id, usageTokens(asObject(message?.usage)))
  }
  return messages.size ? [...messages.values()].reduce((sum, value) => sum + value, 0) : undefined
}

const actionOf = event => {
  const content = asObject(event.message)?.content
  if (event.type !== 'assistant' || !Array.isArray(content)) return undefined
  let action
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

// A model's own bucket is named for the word that sets the model apart (`Fable 7d` is claude-fable's and fable's).
const modelWord = model => model.toLowerCase().split(/[^a-z]+/).find(word => word && word !== 'claude') ?? model.toLowerCase()

const accountKey = realPath => fnv(slashed(realPath).replace(/\/+$/, ''))
const accountScope = key => 'claude/' + key + '/all'
const scopeOfModel = key => model => 'claude/' + key + '/' + modelWord(model)

const KINDS = { five_hour: { id: '5h', minutes: 300 }, seven_day: { id: '7d', minutes: 10080 } }
const windowOfKind = (kind, usedPct, resetsAt) => {
  const known = KINDS[kind]
  return { id: known?.id ?? kind.replaceAll('_', ' '), ...(known ? { minutes: known.minutes } : {}), usedPct, ...(resetsAt === undefined ? {} : { resetsAt }) }
}

/** The session's own rate limits ($.session.usage(), session.measure) as windows; Claude Code's rate limits name no model. */
const sessionWindows = rateLimits => rateLimits.map(limit => windowOfKind(limit.kind, limit.percentUsed, resetTime(limit.resetsAt)))

const rateLimitEvents = text => text.split('\n').map(line => asObject(readJson(line))).filter(event => event?.type === 'rate_limit_event')

// A Claude stream reports its account's windows after each response, `utilization` as a fraction of 1 (measured
// 2026-10-30: 0.1 and 0.45 while the status line read 10% and 45%).
const passiveQuota = async (view, dir, scopes) => {
  const info = asObject(rateLimitEvents(await view.grep('"rate_limit_event"', join(dir, 'claude.jsonl'))).at(-1)?.rate_limit_info)
  const unified = asObject(info?.unifiedWindows)
  if (!unified || !scopes[0]) return undefined
  const windows = Object.entries(unified).flatMap(([kind, value]) => {
    const fraction = numberAt(asObject(value)?.utilization)
    return fraction === undefined ? [] : [windowOfKind(kind, fraction * 100, resetTime(asObject(value)?.resetsAt))]
  })
  return [{ scope: scopes[0], windows }]
}

const exhaustedScopes = async (view, dir, scopes) => {
  const rejected = rateLimitEvents(await view.grep('"rate_limit_event"', join(dir, 'claude.jsonl')))
    .map(event => asObject(event.rate_limit_info)).filter(info => info?.status === 'rejected').at(-1)
  const until = resetTime(rejected?.resetsAt)
  const type = textAt(rejected?.rateLimitType)
  const [account, own] = scopes
  // A model's own cap (`seven_day_<model word>`) puts out that model alone; an account window puts out every model.
  const named = type === undefined ? scopes : own !== undefined && type.split('_').includes(own.split('/').at(-1) ?? '') ? [own] : [account]
  return { scopes: named.filter(scope => scope !== undefined), ...(until === undefined ? {} : { until }) }
}

/** @type {import('./index.mjs').ClaudeAdapter} */
export const claude = {
  id: 'claude',
  explicitForm: false,
  transcript: 'claude.jsonl',
  stepPattern: '"type":"tool_result"',
  familyOf: () => 'claude',
  capabilities: () => [],
  scopesOf: (candidate, key) => [accountScope(key), scopeOfModel(key)(candidate.model)],
  bandScopes: key => [accountScope(key)],
  accountKey,
  version: ['claude', '--version'],
  account: { args: ['--account'], env: dir => ({ [CONFIG_ENV]: dir }) },
  usage: { run: { script: 'claude-usage.mjs' }, parse: (stdout, key) => scriptUsage(readJson(stdout), accountScope(key), scopeOfModel(key)) },
  sessionWindows,
  passiveQuota,
  exhaustedScopes,
  soloOn: os => os === 'windows' ? WINDOWS_ONE_AT_A_TIME : undefined,
  facts,
  plan,
  judge,
  liveTokens: async (view, dir) => ({ tokens: claudeTokens(await view.read(join(dir, 'claude.jsonl'))) }),
  lastAction: lastActionWith(actionOf),
}
