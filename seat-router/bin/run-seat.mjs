#!/usr/bin/env node
// One attempt's launcher, started detached by its supervisor so that it leads its own process group and outlives the
// mod's reloads. It answers asks on the attempt's endpoint (POSIX: the listener the supervisor passed as fd 3; Windows:
// the pipe attempt.json names), claims `started` before anything else, starts the CLI in its own process group, and
// ends the attempt itself on the attempt's `kill`, the seat's `stop`, supervised or not: SIGINT to the
// CLI, up to LAUNCHER_GRACE_MS for it to exit, then `exit` and SIGKILL to its whole group (Windows: taskkill /T /F, then the
// job libuv put the CLI in ends with this process). On POSIX it records in `outside`, while the CLI runs and once more
// before it ends its group, what the CLI started outside the group.
// attempt-n/spec.json: `argv`, where `{ file }` stands for that file's text; `cwd`; `env`; `stdin` (a file, else
// nothing); `stdout`, `stderr`; `outputs`, other files the CLI writes; `stop`, the seat's stop file; `deadline`, epoch
// ms; `home`, the arguments of agy-seat-home.mjs, whose printed path becomes HOME (and USERPROFILE on Windows);
// `release`, the arguments of agy-seat-home.mjs that delete that HOME, run by `--release`; `dropWindowsApps`, which
// takes the folders under WindowsApps off PATH; `claudeLogin`, which drops the variables that would outrank the login
// of the spec's CLAUDE_CONFIG_DIR; `reviewer`, set for a reviewer in its vendor's sandbox, which passes the CLI only the variables REVIEWER_ENV names, besides the
// spec's own, points gh at an empty config folder and clears git's credential helpers; `unset`, variables removed from
// the environment. A seat run again keeps each earlier attempt's stdout, stderr and outputs as <name>.<n><ext>.
// `--release SPEC` runs the spec's `release`; one that fails says why in release.err beside the spec.
// Usage: node run-seat.mjs ATTEMPT_DIR | node run-seat.mjs --release SPEC
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { delimiter, dirname, join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'
import { claudeConfigEnv, withoutClaudeAuth } from './claude-auth.mjs'
import { command } from './command.mjs'
import { LAUNCHER_CHECK_MS, LAUNCHER_GRACE_MS, claimFile, createdAt, outsideRecorder, taskkillTree } from './liveness.mjs'

const WIN = process.platform === 'win32'
const self = fileURLToPath(import.meta.url)
const [first, second] = process.argv.slice(2)

const readJson = path => {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined }
}

if (first === '--release') {
  const spec = JSON.parse(readFileSync(second, 'utf8'))
  if (spec.release) {
    try {
      execFileSync(process.execPath, [join(dirname(self), 'agy-seat-home.mjs'), ...spec.release], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 120_000 })
    } catch (error) {
      appendFileSync(join(dirname(second), 'release.err'), (error.stderr?.toString().trim() || error.message) + '\n')
    }
  }
  process.exit(0)
}

// A reviewer inherits only these; any other variable may carry a credential. Windows spells names in any case.
const REVIEWER_ENV = new RegExp('^(' + [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_[A-Z]+', 'TERM', 'TMPDIR', 'TZ',
  'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'TEMP', 'TMP', 'WINDIR', 'SYSTEMDRIVE',
  'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES\\(X86\\)', 'PSMODULEPATH',
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
].join('|') + ')$', 'i')
// gh reads its token from the keychain even with an empty config folder (`gh auth git-credential get` answers),
// so the empty credential.helper, read after every config file, clears the helpers the operator's ~/.gitconfig lists.
const reviewerEnv = (env, dir) => ({
  ...Object.fromEntries(Object.entries(env).filter(([name]) => REVIEWER_ENV.test(name))),
  GH_CONFIG_DIR: join(dir, 'gh-logged-out'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
})

const dir = first
const file = name => join(dir, name)
const spec = JSON.parse(readFileSync(file('spec.json'), 'utf8'))
let state = 'starting'
let cli
let ending
let finished = false

const writeAtomic = (path, text) => {
  writeFileSync(path + '.tmp', text)
  renameSync(path + '.tmp', path)
}

const recordOutside = outsideRecorder(dir, appendFileSync)
const said = error => process.stderr.write('run-seat: ' + error.message + '\n')

// Neither record may keep the launcher from ending its group: the kill file, not `exit`, decides a killed attempt's ending.
const finish = async record => {
  if (finished) return
  finished = true
  if (!WIN && cli?.pid !== undefined) await recordOutside(cli.pid, process.pid, true).catch(said)
  try { writeAtomic(file('exit'), JSON.stringify(record)) } catch (error) { said(error) }
  if (WIN) process.exit(0)
  process.kill(0, 'SIGKILL')
}

const due = () => readJson(file('kill'))?.reason ?? (spec.stop && existsSync(spec.stop) ? 'stopped' : undefined)

const end = reason => {
  if (ending) return
  ending = reason
  state = 'ending'
  if (!cli || cli.exitCode !== null || cli.signalCode !== null) return finish({ code: null, killed: reason })
  if (WIN) {
    taskkillTree(cli.pid).then(() => finish({ code: null, killed: reason }))
  } else {
    cli.kill('SIGINT')
    setTimeout(() => finish({ code: null, killed: reason }), LAUNCHER_GRACE_MS)
  }
}

const check = () => {
  if (finished || ending) return
  const reason = due()
  if (reason) end(reason)
}

const server = net.createServer(socket => {
  let buffer = ''
  socket.on('error', () => {})
  socket.on('data', chunk => {
    const lines = (buffer + chunk).split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      let ask
      try { ask = JSON.parse(line) } catch { continue }
      socket.write(JSON.stringify({ seq: ask.ask, state }) + '\n')
      if (ask.kill) setImmediate(check)
    }
  })
})
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(WIN ? readJson(file('attempt.json'))?.pipe : { fd: 3 }, () => resolve(undefined))
  })
} catch (error) {
  process.stderr.write('run-seat: the endpoint could not be held: ' + error.message + '\n')
  process.exit(1)
}

if (!claimFile(file('started'), JSON.stringify({ pid: process.pid }))) process.exit(0)

setInterval(check, LAUNCHER_CHECK_MS)

check()

const startCli = () => {
  for (const path of [spec.stdout, spec.stderr, ...(spec.outputs ?? [])].filter(Boolean)) {
    if (!existsSync(path)) continue
    const { dir: folder, name, ext } = parse(path)
    let n = 1
    while (existsSync(join(folder, `${name}.${n}${ext}`))) n += 1
    renameSync(path, join(folder, `${name}.${n}${ext}`))
  }
  const inherited = spec.reviewer ? reviewerEnv(process.env, dir) : process.env
  const env = claudeConfigEnv(spec.claudeLogin ? withoutClaudeAuth({ ...inherited, ...spec.env }) : { ...inherited, ...spec.env })
  for (const name of spec.unset ?? []) delete env[name]
  if (spec.home) {
    const home = execFileSync(process.execPath, [join(dirname(self), 'agy-seat-home.mjs'), ...spec.home], { encoding: 'utf8', windowsHide: true, timeout: 120_000 }).trim()
    env.HOME = home
    if (WIN) env.USERPROFILE = home
  }
  if (spec.dropWindowsApps) {
    for (const key of Object.keys(env).filter(name => name.toUpperCase() === 'PATH')) {
      env[key] = env[key].split(delimiter).filter(entry => !/[\\/]WindowsApps(?:[\\/]|$)/i.test(entry)).join(delimiter)
    }
  }
  const argv = spec.argv.map(arg => typeof arg === 'string' ? arg : readFileSync(arg.file, 'utf8'))
  const started = command(argv[0], argv.slice(1))
  // The CLI's slot 3 is /dev/null: Linux's fork leaves an inherited descriptor open, and the endpoint must stay the launcher's alone.
  /** @type {import('node:child_process').StdioOptions} */
  const stdio = [spec.stdin ? openSync(spec.stdin, 'r') : 'ignore', openSync(spec.stdout, 'w'), openSync(spec.stderr, 'w'), ...(WIN ? [] : [openSync('/dev/null', 'r')])]
  cli = spawn(started.file, started.args, { ...started.options, cwd: spec.cwd, env, windowsHide: true, stdio })
  cli.on('error', error => {
    appendFileSync(spec.stderr, error.message + '\n')
    finish({ code: 127, ...(ending ? { killed: ending } : {}) })
  })
  cli.on('exit', (code, signal) => finish({ code, signal, ...(ending ? { killed: ending } : {}) }))
  if (cli.pid === undefined) return
  writeAtomic(file('cli.json'), JSON.stringify({ pid: cli.pid }))
  if (!WIN) setInterval(() => { if (!finished) recordOutside(cli.pid, process.pid, false).catch(said) }, LAUNCHER_CHECK_MS)
  if (WIN) {
    // A rewrite that fails (a scanner holding the file) keeps the pid-only record, which reads the CLI running while any
    // process has its pid: the seat holds its resources longer, and the launcher lives on to end its CLI.
    createdAt(cli.pid).then(created => {
      if (created !== undefined && created !== 'none' && !finished) writeAtomic(file('cli.json'), JSON.stringify({ pid: cli.pid, created }))
    }).catch(() => {})
  }
}

if (!ending) {
  try {
    startCli()
    state = ending ? 'ending' : 'running'
  } catch (error) {
    appendFileSync(spec.stderr, error.message + '\n')
    finish({ code: 127 })
  }
}
