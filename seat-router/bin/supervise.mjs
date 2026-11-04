#!/usr/bin/env node
// The one writer of a seat: claims the seat's lock, then loops reading the folder and its attempts' endpoints, asking
// the pure `step` what comes next and doing it, until the seat's report is in its mailbox and nothing of it runs.
// Started by accept.mjs, or by a session that found the seat's supervisor gone (adopt.mjs); it runs from the seat's
// runtime/ copy and launches only from the environment seat.json recorded.
// Usage: node supervise.mjs SEAT_FOLDER
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import { closeSync, openSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { command } from './command.mjs'
import { ADAPTERS, familyOf } from './vendors/index.mjs'
import { claimOf, deliveryFile, liveFile, mailDir, outcomeFile } from './core/layout.mjs'
import { RULES, merge, stateOf, withObservations } from './core/ledger.mjs'
import { DEADLINE_MS, KILL_DETAIL, SEAT_SCHEMA, outcomeOf, reportText, step } from './core/lifecycle.mjs'
import * as io from './io-node.mjs'
import { worktreeKeepReason, worktreeRemoveFlags } from './worktree.mjs'
import {
  attemptQuiet, attemptView, claimLock, claimSolo, endSolo, exists, held, holders, lines, liveEntries, outsideOf, quotaFiles, readJson, readText, seatHolders, soloHolder,
} from './io-node.mjs'
import { LAUNCHER_CHECK_MS, LAUNCHER_GRACE_MS, MAX_ATTEMPT, claimFile, outsideRecorder, pipeName, reader, startLauncher, taskkillTree } from './liveness.mjs'
import { removeTree as removeTreeNow } from './remove-tree.mjs'

const OWNER_GUARD_NOTE = 'An owner guard refuses force pushes, git reset --hard, git worktree remove and move (seat-router removes '
  + 'this seat\'s worktree when it ends), git branch -D of branches other than this seat\'s own or ones its worktree checked out, '
  + 'and work-discarding git commands aimed outside this seat\'s folder (-C, --work-tree or after a cd). Combined commands inside this seat\'s folder are allowed. '
  + 'Forced recursive deletes are allowed only for explicit paths inside this seat\'s folder, excluding the seat and worktree roots. '
  + 'gh pr merge --admin and gh repo delete are refused. Never reach a refused result through another shell, interpreter or script. '
  + 'Say in your report what was refused and why you needed it.\n'
const GH_MISSING = 'gh gave no GitHub token here, so this owner ran without GitHub credentials: a push or a pull request over HTTPS may have failed.'
const WIN = process.platform === 'win32'
const TICK_MS = Number(process.env.SEAT_ROUTER_TICK_MS) || (WIN ? 5_000 : 2_000)
const QUOTA_CHECK_MS = 60_000
// A supervisor's signal never cuts short the launcher's own polite end of its CLI.
const KILL_PATIENCE_MS = LAUNCHER_CHECK_MS + LAUNCHER_GRACE_MS + 13_000
const UNENDED_MS = 5_000
const COMMAND_MS = 120_000
const DEFAULT_BUSY_AT = 80

const dir = process.argv[2]
const runtime = dirname(fileURLToPath(import.meta.url))
const seat = readJson(join(dir, 'seat.json'))
if (seat?.schema !== SEAT_SCHEMA) {
  process.stderr.write('supervise: ' + dir + ' holds no seat.json this version reads\n')
  process.exit(1)
}
const { env, home, os } = seat.launch
const lock = await claimLock(dir)
if (!lock) process.exit(0)

// A successor that took the seat over is its only writer, also of an effect this supervisor had begun: every write,
// signal and command checks the lock right before it acts, so after every await too.
const fenced = effect => (...args) => {
  if (!lock.mine()) process.exit(0)
  return effect(...args)
}
const writeAtomic = fenced(io.writeAtomic)
const writeFileSync = fenced(fs.writeFileSync)
const mkdirSync = fenced(fs.mkdirSync)
const rmSync = fenced(fs.rmSync)
const appendFileSync = fenced(fs.appendFileSync)
const renameSync = fenced(fs.renameSync)
const claim = fenced(claimFile)
const quiet = folder => attemptQuiet(folder, claim)
const signalGroup = fenced(pgid => process.kill(-pgid, 'SIGKILL'))
const interrupt = fenced(pid => process.kill(pid, 'SIGINT'))
const killWindowsTree = fenced(taskkillTree)
const launchNow = fenced(startLauncher)

const attemptDir = n => join(dir, 'attempt-' + n)
const view = attemptView(env)
const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
const cli = name => seat.launch.clis?.[name] ?? name
const solo = candidate => candidate.vendor === 'claude' && candidate.account === undefined && Boolean(ADAPTERS.claude.soloOn(os))
const budgets = seat.candidates.map(candidate => ADAPTERS[candidate.vendor].resume?.budget ?? 0)
const workDir = () => seat.isolation === 'worktree' ? join(dir, 'wt') : dir

// On a timeout the command's group is ended while the command is still an unreaped child, so its id cannot be reused.
const run = (argv, cwd) => {
  if (!lock.mine()) process.exit(0)
  let started
  try { started = command(cli(argv[0]), argv.slice(1), env) } catch (error) { return Promise.resolve({ exitCode: 127, stdout: '', stderr: error.message }) }
  return new Promise(resolve => {
    const child = spawn(started.file, started.args, { ...started.options, cwd, env, detached: !WIN, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let exited = false
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => {
      if (!exited) {
        if (WIN) taskkillTree(child.pid)
        else try { process.kill(-child.pid, 'SIGKILL') } catch {}
      }
      resolve({ exitCode: 124, stdout, stderr: argv[0] + ' did not finish in ' + COMMAND_MS / 1000 + ' seconds' })
    }, COMMAND_MS)
    child.on('exit', () => { exited = true })
    child.on('error', error => {
      clearTimeout(timer)
      resolve({ exitCode: 127, stdout, stderr: error.message })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ exitCode: code ?? 1, stdout, stderr })
    })
  })
}
const git = (args, cwd = seat.cwd) => run(['git', ...args], cwd)

/** @type {Map<number, ReturnType<typeof reader>>} */
const readers = new Map()
/** @type {Map<number, { done: boolean }>} */
const launchers = new Map()
/** @type {Map<number, { state: string, reply?: any }>} */
const readings = new Map()
/** @type {Map<number, number>} */
const signalledAt = new Map()
/** @type {Map<number, number>} */
const interrupted = new Map()
/** @type {Map<number, ReturnType<typeof outsideRecorder>>} */
const recorders = new Map()
const recordOutside = (n, cli, pgid) => {
  const record = recorders.get(n) ?? outsideRecorder(attemptDir(n), appendFileSync)
  recorders.set(n, record)
  return record(cli, pgid, true)
}

const readerOf = (n, record) => {
  if (!readers.has(n)) readers.set(n, reader(WIN ? record.pipe : join(attemptDir(n), 'ep')))
  return /** @type {ReturnType<typeof reader>} */ (readers.get(n))
}

const startedOf = folder => {
  if (!exists(join(folder, 'started'))) return 'absent'
  return readJson(join(folder, 'started')) ?? 'unparseable'
}

const fence = (folder, reason) => claim(join(folder, 'started'), JSON.stringify({ fenced: true, reason }))

const readAttempt = async (n, folder, record) => {
  let started = startedOf(folder)
  if (started === 'absent') {
    if (launchers.has(n) && !launchers.get(n)?.done) return { state: 'starting' }
    const read = await readerOf(n, record).read()
    if (read.endpoint === 'answered' || read.endpoint === 'silent') return { state: 'starting', ...read }
    if (read.endpoint === 'unknown') return { state: 'unknown' }
    if (fence(folder, 'no launcher held its endpoint')) return { state: 'not-started' }
    started = startedOf(folder)
  }
  if (started === 'unparseable' || started === 'absent') return { state: 'unknown' }
  if (started.fenced) return { state: 'not-started' }
  const read = await readerOf(n, record).read()
  if (read.endpoint === 'answered') return { state: 'answered', reply: read.reply }
  if (read.endpoint === 'silent') return { state: 'silent' }
  if (read.endpoint === 'unknown') return { state: 'unknown' }
  if (!WIN && read.endpoint === 'missing') return { state: 'unknown' }
  return { state: await quiet(folder) ? 'gone' : 'left' }
}

const attemptOf = async name => {
  const folder = join(dir, name)
  const n = Number(name.slice(8))
  const record = readJson(join(folder, 'attempt.json'))
  if (!record) {
    // A folder an earlier supervisor made and had not recorded yet: its number stays taken, and nothing in it may start.
    if (!exists(join(folder, 'started'))) fence(folder, 'not recorded')
    return undefined
  }
  const ending = readJson(join(folder, 'ending.json'))
  const owner = readJson(join(folder, 'owner.json'))
  const kill = readJson(join(folder, 'kill'))?.reason
  const base = { ...record, ...(kill ? { kill } : {}),
    ...(owner ? { ownerUnchanged: owner.unchanged } : {}) }
  if (ending) {
    const pending = ending.left && !exists(join(folder, 'released'))
    return { ...base, state: 'ended', ending, ...(pending ? { leftover: await leftover(n, folder) } : {}) }
  }
  if (exists(join(folder, 'exit'))) return { ...base, state: 'exited' }
  const reading = await readAttempt(n, folder, record)
  readings.set(n, reading)
  // The launcher writes exit before it ends its group, so an exit that appears during the reading wins over it.
  const state = reading.state === 'gone' && exists(join(folder, 'exit')) ? 'exited' : reading.state
  return { ...base, state }
}

const accountKey = folder => {
  try { return ADAPTERS.claude.accountKey(realpathSync.native(folder).replaceAll('\\', '/')) } catch { return ADAPTERS.claude.accountKey(folder) }
}

const scopesOf = index => {
  const recorded = seat.scopes?.[index]
  if (recorded) return recorded
  const candidate = seat.candidates[index]
  if (candidate.vendor !== 'claude') return ADAPTERS[candidate.vendor].scopesOf(candidate)
  const folder = candidate.account === undefined ? env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? env.USERPROFILE ?? '', '.claude') : seat.launch.accounts[candidate.account] ?? ''
  return ADAPTERS.claude.scopesOf(candidate, accountKey(folder))
}

const standings = () => {
  const ledger = merge(quotaFiles(home), Date.now(), seat.busyAt ?? DEFAULT_BUSY_AT)
  const running = {}
  for (const entry of liveEntries(home)) {
    if (entry.id === seat.id || !(entry.vendor in ADAPTERS)) continue
    const family = familyOf({ vendor: entry.vendor, model: String(entry.model ?? ''), effort: '' })
    running[family] = (running[family] ?? 0) + 1
  }
  return {
    quota: seat.candidates.map((_, index) => {
      const { state, until } = stateOf(ledger, scopesOf(index))
      return { state, ...(until === undefined ? {} : { until }) }
    }),
    families: seat.candidates.map(candidate => familyOf(candidate)), running,
  }
}

/** Returns the reset a quota ending's vendor or reading gave, if any. */
const recordQuota = async (index, quota) => {
  const adapter = ADAPTERS[seat.candidates[index].vendor]
  const scopes = scopesOf(index)
  const now = Date.now()
  let readings = []
  // A stream that cannot be read adds no reading: the ledger then leaves the scope as the other writers say.
  try { readings = ((await adapter.passiveQuota?.(view, dir, scopes)) ?? []).map(reading => ({ ...reading, at: now })) } catch {}
  let exhaustions = []
  let given
  if (quota) {
    const out = await adapter.exhaustedScopes(view, dir, scopes).catch(() => ({ scopes }))
    const full = readings.flatMap(reading => reading.windows.filter(window => window.usedPct >= RULES.outPct && window.resetsAt > now).map(window => window.resetsAt))
    given = out.until ?? (full.length ? Math.max(...full) : undefined)
    exhaustions = out.scopes.map(scope => ({ scope, at: now, until: given ?? now + RULES.exhaustionMs, detail: quota.detail }))
  }
  if (readings.length || exhaustions.length) {
    const path = join(home, 'quota', 'seat-' + seat.id + '.json')
    writeAtomic(path, JSON.stringify(withObservations(readJson(path), 'seat-' + seat.id, now, { readings, exhaustions })))
  }
  return given
}

/** @returns {Promise<import('./core/lifecycle.mjs').Tree>} */
const readTree = async () => {
  const names = readdirSync(dir).filter(name => /^attempt-\d+$/.test(name)).sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)))
  readings.clear()
  const attempts = []
  for (const name of names) {
    const attempt = await attemptOf(name)
    if (attempt) attempts.push(attempt)
  }
  const holder = seat.candidates.some(solo) ? await soloHolder(home) : undefined
  const release = readJson(join(dir, 'release.json'))
  const launchMayBeDue = attempts.every(attempt => attempt.ending)
  const routing = launchMayBeDue ? standings() : {}
  return {
    seat, generation: lock.generation, accepted: exists(join(dir, 'accepted')), refused: exists(join(dir, 'refused')), ...routing,
    worktree: /** @type {'none'|'absent'|'ready'} */ (seat.isolation !== 'worktree' ? 'none' : ready() ? 'ready' : 'absent'),
    attempts, next: names.length ? Number(names.at(-1)?.slice(8)) + 1 : 1, stopRequested: exists(join(dir, 'stop')),
    slotTaken: seat.candidates.map(candidate => solo(candidate) && holder !== undefined && holder !== seat.id),
    ...(exists(join(dir, 'effect-failed.json')) ? { effectFailed: readJson(join(dir, 'effect-failed.json'))?.detail ?? 'an effect failed' } : {}),
    ...(exists(join(dir, 'verdict.json')) ? { verdict: readJson(join(dir, 'verdict.json')) } : {}),
    released: release !== undefined, releasePending: release?.pending === true,
    reported: exists(join(dir, 'report.md')), outcome: exists(outcomeFile(home, seat.id)), mailed: exists(join(dir, 'mailed')),
    live: exists(liveFile(home, seat.id)),
  }
}

const updateLive = fields => {
  const path = liveFile(home, seat.id)
  const entry = readJson(path)
  if (entry) writeAtomic(path, JSON.stringify({ ...entry, ...fields }, null, 2))
}

const effectFailed = detail => writeAtomic(join(dir, 'effect-failed.json'), JSON.stringify({ detail }))

const partialOutput = candidate => {
  const adapter = ADAPTERS[candidate.vendor]
  try {
    return readText(join(dir, 'final.md')).trim() || adapter.lastAction(lines(join(dir, adapter.transcript), 20, true)) || ''
  } catch {
    return ''
  }
}

/** The HOME the attempt's spec made for its CLI (an agy seat's), which its release deletes. */
const homeOf = n => {
  const release = readJson(join(attemptDir(n), 'spec.json'))?.release
  return Array.isArray(release) && release.includes('--home') ? String(release[release.indexOf('--home') + 1]) : undefined
}

/** The folders an attempt's CLI ran in that a release deletes: the seat's worktree and the attempt's HOME. */
const usedBy = n => [...(seat.isolation === 'worktree' ? [join(dir, 'wt')] : []), ...(homeOf(n) === undefined ? [] : [homeOf(n)])]

/** Deletes what the attempt's spec made for its CLI (an agy seat's HOME), only once no process of its CLI can run and none uses it. */
const releaseAttempt = async n => {
  if (!await quiet(attemptDir(n))) return false
  if (!Array.isArray(readJson(join(attemptDir(n), 'spec.json'))?.release)) return true
  const home = homeOf(n)
  if (home !== undefined && held(await holders([home], [attemptDir(n)]))) return false
  await run([process.execPath, join(runtime, 'run-seat.mjs'), '--release', join(attemptDir(n), 'spec.json')], dir)
  return true
}

// What the kernel reports holding a folder is read at most this often per attempt while it holds one.
const HOLD_CHECK_MS = 10_000
const heldSince = new Map()

/**
 * How an ended attempt marked `left` stands: `running` while a process of its CLI's group may run, which holds the
 * next launch; `held` while a process uses a folder its release deletes (holders), which holds only that release.
 */
const leftover = async (n, folder) => {
  if (!await quiet(folder)) return 'running'
  if (Date.now() - (heldSince.get(n) ?? -Infinity) < HOLD_CHECK_MS) return 'held'
  if (!held(await holders(usedBy(n), [folder]))) return 'quiet'
  heldSince.set(n, Date.now())
  return 'held'
}

const listed = rows => rows.map(row => 'pid ' + row.pid + ' (' + row.command + ')').join(', ')
const runningNote = running => 'These processes were still running when it ended, in its folders or started by its CLI outside its process group, and seat-router does not end them: '
  + listed(running) + '.'
const UNLISTED_NOTE = 'seat-router could not list what its CLI started outside its process group: a command it started may still be running.'
const UNREAD_NOTE = 'seat-router could not read which processes use its folders, so it keeps them as if one did.'

const endAttempt = async (n, ending) => {
  const folder = attemptDir(n)
  const candidate = seat.candidates[readJson(join(folder, 'attempt.json')).index]
  // A launcher still alive ends its CLI on the attempt's kill file, whatever reading made the supervisor end it.
  if (KILL_DETAIL[ending.kind] && !exists(join(folder, 'kill'))) writeAtomic(join(folder, 'kill'), JSON.stringify({ reason: ending.kind, at: Date.now() }))
  // A launcher writes `exit` just before it ends its group, so a group that is still emptying gets a moment.
  let left = false
  for (let waited = 0; !await quiet(folder); waited += 100) {
    if (waited >= 2_000) {
      left = true
      break
    }
    await sleep(100)
  }
  const found = await holders(usedBy(n), [folder])
  await releaseAttempt(n)
  const outside = outsideOf(folder)
  const running = [...new Map([...(found === 'unknown' ? [] : found), ...outside.running].map(row => [row.pid, row])).values()]
  const notes = [left ? ending.note ?? 'Its CLI may still be running: a process of it was left after it ended.' : '',
    running.length ? runningNote(running) : '', found === 'unknown' ? UNREAD_NOTE : '', outside.unlisted ? UNLISTED_NOTE : ''].filter(Boolean)
  const { left: _left, note: _note, ...rest } = ending
  writeAtomic(join(folder, 'ending.json'), JSON.stringify({
    ...rest, text: ending.text || (ending.kind === 'not-started' ? '' : partialOutput(candidate)), ...(left || held(found) ? { left: true } : {}),
    ...(notes.length ? { note: notes.join(' ') } : {}),
  }))
  updateLive({ solo: false })
}

// An owner reaches GitHub through the operator's gh token, passed in the environment only: the seat's sandbox or HOME
// cannot reach the keychain. A machine without gh, or without a login, runs the owner without it.
const ownerEnv = async () => {
  const token = await run(['gh', 'auth', 'token'], dir)
  if (token.exitCode !== 0 || !token.stdout.trim()) {
    writeFileSync(join(dir, 'gh-missing'), '')
    return {}
  }
  return { GH_TOKEN: token.stdout.trim(), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.https://github.com.helper', GIT_CONFIG_VALUE_0: '!gh auth git-credential' }
}

const factsIo = {
  read: async path => readText(path),
  list: async path => readdirSync(path, { withFileTypes: true }).map(entry => ({ name: entry.name, kind: entry.isDirectory() ? 'dir' : 'file' })),
  settings: async key => seat.launch.settings[key],
  run: async (argv, init) => run(argv, init?.cwd ?? dir),
  home: env.HOME ?? env.USERPROFILE ?? '',
}

const launch = async ({ n, index, resume, rerun }, tree) => {
  if (n > MAX_ATTEMPT) return effectFailed('attempt ' + n + ' is past the ' + MAX_ATTEMPT + ' attempts a seat may make')
  const candidate = seat.candidates[index]
  let slot
  if (solo(candidate)) {
    slot = await claimSolo(home, { seat: seat.id, dir, n, endpoint: lock.endpoint })
    if (slot === undefined) return sleep(TICK_MS)
  }
  const folder = attemptDir(n)
  try {
    mkdirSync(folder)
  } catch (error) {
    if (slot !== undefined) endSolo(home, slot)
    if (error.code === 'EEXIST') return
    throw error
  }
  writeAtomic(join(folder, 'attempt.json'), JSON.stringify({ n, index, startedAt: Date.now(), rankedAs: tree.quota?.[index]?.state ?? 'unknown',
    ...(resume === undefined ? {} : { resume }), ...(rerun ? { rerun: true } : {}), ...(WIN ? { pipe: pipeName() } : {}) }))
  updateLive({ status: 'running', vendor: candidate.vendor, model: candidate.model, effort: candidate.effort, account: candidate.account, solo: solo(candidate), attemptAt: Date.now() })
  const adapter = ADAPTERS[candidate.vendor]
  const isOwner = seat.tier === 'owner'
  const configDir = candidate.account === undefined ? env.CLAUDE_CONFIG_DIR : seat.launch.accounts[candidate.account]
  const context = {
    seat: { id: seat.id, dir, workDir: workDir(), tier: seat.tier, model: candidate.model, effort: candidate.effort,
      ...(candidate.account === undefined ? {} : { account: candidate.account }), ...(resume === undefined ? {} : { resumeConversation: resume }) },
    brief: isOwner ? seat.brief + '\n' + OWNER_GUARD_NOTE : seat.brief,
    os, guard: 'node "' + join(runtime, 'owner-guard.mjs').replaceAll('\\', '/') + '" --own "' + dir + '"', seatRoot: home,
    ...(configDir ? { configDir } : {}),
  }
  const plan = adapter.plan({ ...context, facts: adapter.facts ? await adapter.facts(factsIo, context) : {} })
  for (const made of plan.dirs) mkdirSync(made, { recursive: true })
  for (const [name, text] of Object.entries(plan.files)) writeFileSync(join(dir, name), text)
  // A reviewer's launcher passes the CLI only allowlisted variables besides the spec's own, so the plan's go in the spec.
  const spec = {
    ...plan.spec, argv: [cli(plan.spec.argv[0]), ...plan.spec.argv.slice(1)], env: { ...plan.spec.env, ...plan.env, GIT_CEILING_DIRECTORIES: home + '/seats' },
    stop: join(dir, 'stop'), deadline: seat.createdAt + DEADLINE_MS, ...(isOwner ? {} : { reviewer: true }),
  }
  const launcherEnv = { ...env, ...(isOwner ? await ownerEnv() : {}) }
  // Preparation can take long (facts, gh): the deadline holds for the launch itself, not only for the step that chose it.
  if (Date.now() >= spec.deadline) return fence(folder, 'deadline')
  writeAtomic(join(folder, 'spec.json'), JSON.stringify(spec, null, 2))
  const started = { done: false }
  launchers.set(n, started)
  const log = openSync(join(folder, 'launcher.out'), 'w')
  const child = await launchNow(folder, join(runtime, 'run-seat.mjs'), { env: launcherEnv, log })
  closeSync(log)
  child.on('exit', () => { started.done = true })
  child.on('error', () => { started.done = true })
}

const judge = async n => {
  const folder = attemptDir(n)
  const attempt = readJson(join(folder, 'attempt.json'))
  const candidate = seat.candidates[attempt.index]
  const adapter = ADAPTERS[candidate.vendor]
  const exit = readJson(join(folder, 'exit'))
  // The kill decides how the attempt ended, never the exit code: claude exits 0 on the SIGINT that ends it.
  const reason = readJson(join(folder, 'kill'))?.reason ?? exit?.killed
  const endedAt = Date.now()
  if (reason) {
    const detail = KILL_DETAIL[reason]
    return endAttempt(n, { kind: reason, detail, text: partialOutput(candidate), endedAt })
  }
  let ending
  try {
    // A CLI that finished after its launcher was killed is judged by what it wrote; only one that left no answer died.
    const checked = await adapter.judge(view, dir, exit ? exit.code ?? 1 : 0)
    const text = checked.text || partialOutput(candidate)
    if (!exit && checked.failed) ending = { kind: 'died', detail: 'ended without an exit code (killed, or the machine restarted)', text }
    else if (!checked.failed) ending = { kind: 'done', detail: '', text: checked.text }
    else if (checked.quota) {
      const until = await recordQuota(attempt.index, { detail: checked.detail })
      ending = { kind: 'quota', detail: checked.detail, text, ...(until === undefined ? {} : { until }) }
    } else if (adapter.resume?.when(checked)) {
      const conversation = await adapter.resume.conversation(view, dir) ?? attempt.resume
      ending = { kind: 'transient', detail: checked.detail, text, ...(conversation ? { resume: conversation } : {}) }
    } else ending = { kind: 'failed', detail: checked.detail, text }
  } catch (error) {
    ending = { kind: 'unclassified', detail: 'its output could not be read (' + error.message + ')', text: partialOutput(candidate) }
  }
  if (ending.kind !== 'quota') await recordQuota(attempt.index)
  return endAttempt(n, { ...ending, endedAt })
}

/**
 * Ends a running attempt: the `kill` file first, which the launcher acts on by itself; then, by this tick's reading,
 * fence an attempt no launcher claimed, ask a launcher that answers, and signal one that did not end in time, only
 * with this tick's proof that the launcher still holds the endpoint.
 */
const kill = async ({ n, why }) => {
  const folder = attemptDir(n)
  const path = join(folder, 'kill')
  if (!exists(path)) writeAtomic(path, JSON.stringify({ reason: why, at: Date.now() }))
  const since = readJson(path)?.at ?? Date.now()
  const reading = readings.get(n)
  const record = readJson(join(folder, 'attempt.json'))
  if (reading?.state === 'starting' && startedOf(folder) === 'absent') {
    fence(folder, why)
    return sleep(TICK_MS)
  }
  if (reading?.state === 'answered' && reading.reply?.state !== 'ending') {
    await readerOf(n, record).read({ kill: true })
    return sleep(TICK_MS)
  }
  if (Date.now() - since < KILL_PATIENCE_MS) return sleep(TICK_MS)
  const at = signalledAt.get(n)
  if (at !== undefined) {
    if (Date.now() - at < UNENDED_MS) return sleep(TICK_MS)
    return endAttempt(n, { kind: why, detail: KILL_DETAIL[why], text: '', endedAt: Date.now(), left: true,
      note: 'Its CLI may still be running: its launcher did not answer and could not be ended.' })
  }
  const pid = startedOf(folder)?.pid
  if (typeof pid !== 'number' || (reading?.state !== 'silent' && reading?.state !== 'answered')) return sleep(TICK_MS)
  // Only the launcher holds the endpoint, so the connection this tick's reading held, still open, proves that pid L is
  // the attempt's own launcher, its group the attempt's, and the CLI it recorded its unreaped child.
  const proof = readerOf(n, record)
  if (!WIN) {
    const cli = readJson(join(folder, 'cli.json'))?.pid
    // What the CLI runs outside the group survives the group kill, also a command it starts on the SIGINT, so it is
    // recorded on every tick through the kill, each time before the signal.
    if (typeof cli === 'number') await recordOutside(n, cli, pid)
    const asked = interrupted.get(n)
    if (typeof cli === 'number' && asked === undefined) {
      if (await proof.signal(() => { try { interrupt(cli) } catch {} })) interrupted.set(n, Date.now())
      return sleep(TICK_MS)
    }
    if (asked !== undefined && Date.now() - asked < LAUNCHER_GRACE_MS) return sleep(TICK_MS)
  }
  const sent = await proof.signal(async () => {
    if (WIN) await killWindowsTree(pid)
    else try { signalGroup(pid) } catch {}
  })
  if (sent) signalledAt.set(n, Date.now())
  return sleep(TICK_MS)
}

let quotaCheckedAt = 0
const watch = async n => {
  await sleep(TICK_MS)
  if (Date.now() - quotaCheckedAt < QUOTA_CHECK_MS) return
  quotaCheckedAt = Date.now()
  await recordQuota(readJson(join(attemptDir(n), 'attempt.json')).index)
}

// git makes wt/.git and locks the worktree before it checks out a file, so only `wt-ready`, written once `git worktree
// add` exited 0, says a CLI may run in it.
const ready = () => exists(join(dir, 'wt-ready')) && exists(join(dir, 'wt', '.git'))

const worktree = async () => {
  const tree = join(dir, 'wt')
  if (held(await seatHolders(dir, [tree], claim))) return sleep(TICK_MS)
  const branch = 'seat/' + seat.id
  // What an add cut short left (a crash, or on Windows the end of the supervisor's job) is half made and still locked.
  await git(['worktree', 'remove', '--force', '--force', tree])
  rmSync(tree, { recursive: true, force: true })
  await git(['worktree', 'prune'])
  const has = (await git(['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch])).exitCode === 0
  const added = has ? await git(['worktree', 'add', tree, branch]) : await git(['worktree', 'add', '-b', branch, tree, seat.baseSha])
  if (added.exitCode !== 0) return effectFailed('git worktree add failed: ' + added.stderr.trim())
  writeFileSync(join(dir, 'wt-ready'), '')
}

const probeOwner = async n => {
  const tree = join(dir, 'wt')
  const head = await git(['-C', tree, 'rev-parse', 'HEAD'])
  const status = await git(['-C', tree, 'status', '--porcelain'])
  const unchanged = head.exitCode === 0 && head.stdout.trim() === seat.baseSha && status.exitCode === 0 && !status.stdout.trim()
  writeAtomic(join(attemptDir(n), 'owner.json'), JSON.stringify({ unchanged }))
}

const releaseWorktree = async () => {
  if (seat.isolation !== 'worktree') return undefined
  const tree = join(dir, 'wt')
  const branch = 'seat/' + seat.id
  if (exists(join(tree, '.git')) && !ready()) await git(['worktree', 'remove', '--force', '--force', tree])
  else if (exists(join(tree, '.git'))) {
    const reason = await worktreeKeepReason(git, tree, seat.baseSha)
    if (reason) return 'Worktree: ' + branch + ' at ' + tree + ' (kept: ' + reason + ')'
    if ((await git(['worktree', 'remove', ...await worktreeRemoveFlags(git, tree), tree])).exitCode !== 0) return 'Worktree: ' + branch + ' at ' + tree + ' (kept: git could not remove it)'
    if (seat.tier === 'owner') return 'Branch: ' + branch + ' (its worktree was removed)'
  }
  if (seat.tier === 'reviewer') {
    if ((await git(['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch])).exitCode === 0) await git(['branch', '-D', branch])
    return undefined
  }
  return 'Branch: ' + branch
}

const HELD_LINE = 'A process of this seat\'s CLI may still be running, so its worktree and HOME were kept until it ends.'

const kept = () => {
  try {
    return readdirSync(join(dir, 'artifacts'), { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => join(dir, 'artifacts', entry.name)).sort()
  } catch {
    return []
  }
}

const releaseErrors = () => readdirSync(dir).filter(name => /^attempt-\d+$/.test(name)).map(name => readText(join(dir, name, 'release.err'))).join('')

// A session writes the delivery record before it deletes its claim, so the mailbox is read before the record.
const mailedBefore = box => {
  let names = []
  try {
    names = readdirSync(box)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return names.some(name => name === seat.id || claimOf(name)?.id === seat.id) || exists(deliveryFile(home, seat.id))
}

const wait = async ({ until, why }) => {
  const from = Date.now()
  updateLive({ status: why === 'quota' || why === 'slot' ? 'waiting' : 'running' })
  await sleep(Math.min(until - from, TICK_MS))
  if (why !== 'quota' && why !== 'slot') return
  const waits = readJson(join(dir, 'waits.json')) ?? {}
  writeAtomic(join(dir, 'waits.json'), JSON.stringify({ ...waits, [why]: (waits[why] ?? 0) + Date.now() - from }))
}

const apply = async (next, tree) => {
  switch (next.kind) {
    case 'exit': return process.exit(0)
    case 'abandon': {
      if (held(await seatHolders(dir, [dir], claim))) return sleep(TICK_MS)
      // Renamed out of seats/ first, so a crash leaves a folder prune-seats deletes rather than one nothing finds.
      const trash = join(dirname(dir), '.trash-' + seat.id)
      renameSync(dir, trash)
      fs.rmSync(liveFile(home, seat.id), { force: true })
      removeTreeNow(trash)
      return process.exit(0)
    }
    case 'outcome': return writeAtomic(outcomeFile(home, seat.id), JSON.stringify(outcomeOf(tree, tree.verdict, Date.now()), null, 2))
    case 'mail': {
      const box = mailDir(home, seat.sessionId)
      if (!mailedBefore(box)) {
        mkdirSync(box, { recursive: true })
        writeFileSync(join(box, seat.id), '')
      }
      writeFileSync(join(dir, 'mailed'), '')
      return
    }
    case 'unlive': return rmSync(liveFile(home, seat.id), { force: true })
    case 'verdict': return writeAtomic(join(dir, 'verdict.json'), JSON.stringify(next.verdict))
    case 'release': {
      const found = next.held ? 'unknown' : await seatHolders(dir, [join(dir, 'wt')], claim)
      if (held(found)) {
        const using = found === 'unknown' ? '' : ' In its worktree: ' + listed(found) + '.'
        writeAtomic(join(dir, 'release.json'), JSON.stringify({ line: HELD_LINE + using, pending: true }))
        if (next.held) return
        // Past the deadline, what a process still uses is left to prune-seats.
        if (tree.reported && Date.now() >= seat.createdAt + DEADLINE_MS) return process.exit(0)
        return sleep(TICK_MS)
      }
      let line
      try { line = await releaseWorktree() } catch (error) { line = 'Worktree: could not be released (' + error.message + ')' }
      return writeAtomic(join(dir, 'release.json'), JSON.stringify(line === undefined ? {} : { line }))
    }
    case 'settle':
      if (await releaseAttempt(next.n)) writeFileSync(join(attemptDir(next.n), 'released'), '')
      return
    case 'report': {
      const notes = exists(join(dir, 'gh-missing')) ? [GH_MISSING] : []
      return writeAtomic(join(dir, 'report.md'), reportText(tree, tree.verdict, {
        release: readJson(join(dir, 'release.json'))?.line, kept: kept(), keepFailed: releaseErrors(),
        waits: readJson(join(dir, 'waits.json')) ?? {}, notes,
      }))
    }
    case 'worktree': return worktree()
    case 'probe-owner': return probeOwner(next.n)
    case 'launch':
      try { await launch(next, tree) } catch (error) { effectFailed('launching ' + seat.candidates[next.index].vendor + ' failed: ' + error.message) }
      return
    case 'watch': return watch(next.n)
    case 'kill': return kill(next)
    case 'judge': return judge(next.n)
    case 'end': return endAttempt(next.n, next.ending)
    case 'wait': return wait(next)
  }
}

for (;;) {
  if (!lock.mine()) process.exit(0)
  let next
  try {
    const tree = await readTree()
    next = step(tree, Date.now(), budgets)
    if (!lock.mine()) process.exit(0)
    await apply(next, tree)
  } catch (error) {
    fs.appendFileSync(join(dir, 'supervisor.err'), new Date().toISOString() + ' ' + (next?.kind ?? 'read') + ': ' + (error.stack ?? error.message) + '\n')
    await sleep(TICK_MS)
  }
}
