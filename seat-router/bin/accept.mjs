#!/usr/bin/env node
// Makes a seat the Agent hook decided on: its folder under the seat-router home, seat.json with the environment its
// launches read, a copy of the runtime it runs from, its live entry, and its detached supervisor; prints
// `{ "id", "dir" }`. Refuses, on stderr with exit 1 and before making anything, a worktree seat whose folder is not
// in a git repository or whose git does not answer within COMMAND_MS, and a home so deep that a seat's sockets would pass the OS's path limit. The request (JSON on stdin) is
// seat.json's fields the hook knows (Seat in core/lifecycle.mjs), plus accounts and settings, and id, the seat id the hook
// picked: its folder is made exclusively, so accept refuses a seat the hook already refused (the hook's `refused` made
// the folder first).
// Usage: node accept.mjs < request.json
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, realpathSync, statfsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { absolutePath, locate } from './command.mjs'
import { homeOf, isSeatId, liveFile, seatDir } from './core/layout.mjs'
import { SEAT_SCHEMA } from './core/lifecycle.mjs'
import { COMMAND_MS, readJson, securePublicLeaf, writeAtomic } from './io-node.mjs'
import { SOCKET_PATH_MAX, socketPaths } from './liveness.mjs'

const bin = dirname(fileURLToPath(import.meta.url))
const refuse = why => {
  process.stderr.write(why + '\n')
  process.exit(1)
}

const request = JSON.parse(readFileSync(0, 'utf8'))
const located = homeOf(name => process.env[name])
if (!located) refuse('this environment names no home folder for seat-router')
const { home, shared } = located
const git = args => execFileSync('git', ['-C', request.cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: COMMAND_MS }).trim()

let baseSha
if (request.isolation === 'worktree') {
  try {
    git(['rev-parse', '--show-toplevel'])
    baseSha = git(['rev-parse', 'HEAD'])
  } catch (error) {
    if (error.code === 'ETIMEDOUT') refuse('git did not answer in ' + COMMAND_MS / 1000 + ' seconds in ' + request.cwd)
    refuse('isolation: "worktree" needs a git repository with a commit, and ' + request.cwd + ' is not one')
  }
}
if (shared) {
  const why = securePublicLeaf(home)
  if (why !== undefined) refuse('the seat-router home ' + home + ' under %PUBLIC% could not be locked to this user: ' + why)
}

mkdirSync(join(home, 'seats'), { recursive: true, mode: 0o700 })
if (request.isolation === 'worktree') {
  const floor = request.minFreeDiskGiB ?? 10
  if (typeof floor !== 'number' || !Number.isFinite(floor) || floor < 0) refuse('minFreeDiskGiB must be a non-negative number')
  const disk = statfsSync(home)
  const free = disk.bavail * disk.bsize / 1024 ** 3
  if (free < floor) refuse('the seat-router home has ' + free.toFixed(1) + ' GiB free, below minFreeDiskGiB (' + floor + ' GiB); free disk space or lower that setting')
}
const tooLong = socketPaths(realpathSync.native(join(home, 'seats')) + '/seat-xxxxxx').find(path => Buffer.byteLength(path) > SOCKET_PATH_MAX)
if (process.platform !== 'win32' && tooLong) {
  refuse('the seat-router home ' + home + ' is too deep: a seat binds sockets at paths like ' + tooLong + ', longer than the '
    + SOCKET_PATH_MAX + ' bytes this OS allows; set SEAT_ROUTER_HOME to a shorter folder')
}
if (request.id !== undefined && !isSeatId(request.id)) refuse('"' + request.id + '" is not a seat id')
let id
let dir
for (;;) {
  id = request.id ?? 'seat-' + randomBytes(6).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 6).padEnd(6, '0')
  dir = seatDir(home, id)
  try {
    mkdirSync(dir, { mode: 0o700 })
    break
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    if (request.id !== undefined) refuse('seat ' + id + ' was refused before it was made')
  }
}
// agy's sandbox checks writes against the resolved path, so a folder reached through a link has every write denied.
dir = realpathSync.native(dir).replaceAll('\\', '/')
cpSync(bin, join(dir, 'runtime'), { recursive: true, filter: source => !/\.test\.mjs$/.test(source) })

const resolved = path => {
  try { return realpathSync.native(path).replaceAll('\\', '/') } catch { return path }
}
// A supervisor adopted by another session starts elsewhere and later: it launches what this process would find now.
const env = absolutePath(process.env, process.cwd())
if (env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = resolved(env.CLAUDE_CONFIG_DIR)
const clis = Object.fromEntries([...new Set([...request.candidates.map(candidate => candidate.vendor), 'git', 'gh'])]
  .flatMap(name => {
    const file = locate(name, env)
    return file ? [[name, file]] : []
  }))
const seat = {
  schema: SEAT_SCHEMA, id, sessionId: request.sessionId, createdAt: Date.now(),
  description: request.description, tier: request.tier, brief: request.brief, cwd: request.cwd, isolation: request.isolation,
  ...(baseSha ? { baseSha } : {}), candidates: request.candidates, first: request.first, trail: request.trail,
  ...(request.scopes ? { scopes: request.scopes } : {}), ...(request.ranked ? { ranked: request.ranked } : {}), ...(request.pinned ? { pinned: true } : {}),
  ...(typeof request.busyAt === 'number' ? { busyAt: request.busyAt } : {}),
  ...(request.firstRanks ? { firstRanks: request.firstRanks } : {}), floor: request.floor,
  ...(typeof request.agentId === 'string' ? { agentId: request.agentId } : {}), version: readJson(join(bin, '..', '.claude-plugin', 'plugin.json'))?.version ?? 'unknown',
  launch: {
    env, clis, os: process.platform === 'win32' ? 'windows' : 'posix', home,
    accounts: Object.fromEntries(Object.entries(request.accounts ?? {}).map(([name, path]) => [name, resolved(path)])),
    settings: request.settings ?? {},
  },
}
writeAtomic(join(dir, 'seat.json'), JSON.stringify(seat, null, 2))
const first = request.candidates[request.first] ?? request.candidates[0]
writeAtomic(liveFile(home, id), JSON.stringify({
  schema: SEAT_SCHEMA, id, sessionId: seat.sessionId, dir, description: seat.description, tier: seat.tier, createdAt: seat.createdAt,
  status: 'running', vendor: first?.vendor, model: first?.model, effort: first?.effort, ...(first?.account ? { account: first.account } : {}),
}, null, 2))
// No handle of the supervisor's may stay open in the seat folder: Windows cannot remove a folder that holds an open file.
spawn(process.execPath, [join(dir, 'runtime', 'supervise.mjs'), dir], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
process.stdout.write(JSON.stringify({ id, dir }) + '\n')
