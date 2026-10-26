#!/usr/bin/env node
// Starts one seat's CLI detached from the mod, so the seat outlives the mod's
// reloads, and returns at once; the CLI's exit code lands in the spec's exit
// file. The spec (JSON): `argv`, where `{ file }` stands for that file's text;
// `cwd`; `env`; `stdin` (a file, else nothing); `stdout`, `stderr`; `exit`;
// `home`, the arguments of agy-seat-home.mjs, whose printed path becomes HOME
// (and USERPROFILE on Windows); `dropWindowsApps`, which takes the folders under
// WindowsApps off PATH; or `sleep`, seconds to wait before writing 0. The
// launcher writes its own pid and the CLI's to `pid`, so the mod can tell a seat
// that died from one still running, and stop it.
// Usage: node run-seat.mjs SPEC
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { command } from './command.mjs'

const self = fileURLToPath(import.meta.url)
const [first, second] = process.argv.slice(2)

if (first !== '--child') {
  const log = openSync(join(dirname(first), 'launcher.out'), 'w')
  spawn(process.execPath, [self, '--child', first], { detached: true, stdio: ['ignore', log, log], windowsHide: true }).unref()
  process.exit(0)
}

const spec = JSON.parse(readFileSync(second, 'utf8'))
const finish = code => writeFileSync(spec.exit, code + '\n')
const pids = cli => spec.pid && writeFileSync(spec.pid, JSON.stringify({ launcher: process.pid, ...(cli ? { cli } : {}) }) + '\n')
rmSync(spec.exit, { force: true })
pids()

if (spec.sleep !== undefined) {
  setTimeout(() => finish(0), spec.sleep * 1000)
} else {
  try {
    const env = { ...process.env, ...spec.env }
    if (spec.home) {
      const home = execFileSync(process.execPath, [join(dirname(self), 'agy-seat-home.mjs'), ...spec.home], { encoding: 'utf8' }).trim()
      env.HOME = home
      if (process.platform === 'win32') env.USERPROFILE = home
    }
    if (spec.dropWindowsApps) {
      for (const key of Object.keys(env).filter(name => name.toUpperCase() === 'PATH')) {
        env[key] = env[key].split(delimiter).filter(dir => !/[\\/]WindowsApps(?:[\\/]|$)/i.test(dir)).join(delimiter)
      }
    }
    const argv = spec.argv.map(arg => typeof arg === 'string' ? arg : readFileSync(arg.file, 'utf8'))
    const started = command(argv[0], argv.slice(1))
    const child = spawn(started.file, started.args, {
      ...started.options, cwd: spec.cwd, env, windowsHide: true,
      stdio: [spec.stdin ? openSync(spec.stdin, 'r') : 'ignore', openSync(spec.stdout, 'w'), openSync(spec.stderr, 'w')],
    })
    pids(child.pid)
    child.on('error', error => {
      appendFileSync(spec.stderr, error.message + '\n')
      finish(127)
    })
    child.on('exit', code => finish(code ?? 1))
  } catch (error) {
    appendFileSync(spec.stderr, error.message + '\n')
    finish(127)
  }
}
