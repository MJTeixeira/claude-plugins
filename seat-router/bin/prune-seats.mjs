#!/usr/bin/env node
// Deletes the seat folders under ROOT that ended more than a week ago: reported,
// or still marked running or waiting while their launcher is gone. A folder with
// no seat.json goes once it is a week old. A seat's worktree goes only through
// `git worktree remove`, which refuses one with changes or untracked files; the
// folder then stays. Its seat/* branch always stays. Links (an agy seat's HOME
// links ~/.gemini; Windows makes them junctions) are removed, never followed.
// Prints each folder it deletes.
// Usage: node prune-seats.mjs ROOT
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const root = process.argv[2]
const now = Date.now()

const readJson = path => {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined }
}

const alive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function remove(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (!stat) return
  if (stat.isSymbolicLink()) {
    // Windows removes a junction with rmdir, which leaves its target alone.
    try { unlinkSync(path) } catch { rmdirSync(path) }
  } else if (stat.isDirectory()) {
    for (const name of readdirSync(path)) remove(join(path, name))
    rmdirSync(path)
  } else unlinkSync(path)
}

// When the seat ended, or undefined while it may still run.
function endedAt(dir, seat) {
  if (!seat) return lstatSync(dir).mtimeMs
  if (seat.reported || seat.status === 'reported') return seat.endedAt ?? lstatSync(join(dir, 'seat.json')).mtimeMs
  const launcher = readJson(join(dir, 'pid'))?.launcher
  if (typeof launcher === 'number' && !alive(launcher)) return lstatSync(join(dir, 'pid')).mtimeMs
  return undefined
}

let entries = []
try { entries = readdirSync(root, { withFileTypes: true }) } catch {}
for (const entry of entries) {
  if (!entry.isDirectory() || !entry.name.startsWith('seat.')) continue
  const dir = join(root, entry.name)
  const seat = readJson(join(dir, 'seat.json'))
  const ended = endedAt(dir, seat)
  if (ended === undefined || now - ended < WEEK_MS) continue
  const tree = seat?.worktreePath
  if (tree && existsSync(join(tree, '.git'))) {
    if (spawnSync('git', ['-C', tree, 'worktree', 'remove', tree], { stdio: 'ignore', windowsHide: true }).status !== 0) continue
  }
  remove(dir)
  process.stdout.write(dir + '\n')
}
