#!/usr/bin/env node
// Deletes the seat folders under ROOT that ended more than a week ago: a seat folder (seat-XXXXXX) once its report.md is
// a week old, or once its seat.json is when it has neither a report nor a live entry; a seat-router 1.x folder
// (seat.XXXXXX) reported, or still marked running or waiting while its launcher is gone. A folder with no seat.json goes
// once it is a week old, and an abandoned seat's .trash-XXXXXX at once. Nothing of a seat goes while a process of an
// attempt's CLI may still run, or while a process has its current folder or a file open in it or its worktree
// (seatHolders). A seat's worktree goes only through `git worktree remove`, which refuses
// one with changes or untracked files; the folder then stays. One an add cut short (no wt-ready) is removed by force,
// as nothing ran in it. A reviewer's seat/* branch goes with its worktree, or alone when its worktree is already gone,
// since a reviewer commits nothing; an owner's stays, as a pull request may name it. Links (an agy seat's HOME links
// ~/.gemini; Windows makes them junctions) are removed, never followed. A git command that does not finish within
// COMMAND_MS counts as failed, and a seat whose worktree or branch could not be removed keeps its folder, so a later
// run tries again. Under a seat-router home's seats/, it also deletes the delivery, outcome and lineage records and the
// mail markers and claims that are 60 days old.
// Prints each folder it deletes.
// Usage: node prune-seats.mjs ROOT
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, rmdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { COMMAND_MS, held, seatHolders } from './io-node.mjs'
import { claimFile } from './liveness.mjs'
import { removeTree } from './remove-tree.mjs'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const RECORD_MS = 60 * 24 * 60 * 60 * 1000
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

// In the C locale, so that git's "not a git repository" reads the same on every machine.
const git = (args, options = {}) => spawnSync('git', args, { encoding: 'utf8', windowsHide: true, timeout: COMMAND_MS, env: { ...process.env, LC_ALL: 'C' }, ...options })

/** Deletes a branch, done when it is already gone or the folder named no longer holds a repository to keep it. */
const deleteBranch = (gitDir, branch) => {
  const found = git([...gitDir, 'rev-parse', '--verify', '--quiet', 'refs/heads/' + branch])
  if (found.status === 1 || (found.status === 128 && /not a git repository/.test(found.stderr))) return true
  return found.status === 0 && git([...gitDir, 'branch', '-D', branch], { stdio: 'ignore' }).status === 0
}

function endedAt(dir, seat) {
  if (!seat) return lstatSync(dir).mtimeMs
  if (seat.schema !== undefined) {
    const report = lstatSync(join(dir, 'report.md'), { throwIfNoEntry: false })?.mtimeMs
    if (report !== undefined || existsSync(join(dirname(root), 'live', seat.id + '.json'))) return report
    return lstatSync(join(dir, 'seat.json')).mtimeMs
  }
  if (seat.reported || seat.status === 'reported') return seat.endedAt ?? lstatSync(join(dir, 'seat.json')).mtimeMs
  const launcher = readJson(join(dir, 'pid'))?.launcher
  if (typeof launcher === 'number' && !alive(launcher)) return lstatSync(join(dir, 'pid')).mtimeMs
  return undefined
}

let entries = []
// A ROOT that does not exist yet holds no seats to prune.
try { entries = readdirSync(root, { withFileTypes: true }) } catch {}
for (const entry of entries) {
  if (!entry.isDirectory()) continue
  const dir = join(root, entry.name)
  // A week-old seat has no supervisor left, so its last writer is this: an attempt no launcher claimed is fenced here.
  if (/^\.trash-seat-/.test(entry.name)) {
    if (held(await seatHolders(dir, [dir], claimFile))) continue
    removeTree(dir)
    process.stdout.write(dir + '\n')
    continue
  }
  if (!/^seat[.-]/.test(entry.name)) continue
  const seat = readJson(join(dir, 'seat.json'))
  const ended = endedAt(dir, seat)
  if (ended === undefined || now - ended < WEEK_MS) continue
  const tree = seat?.schema !== undefined ? join(dir, 'wt') : seat?.worktreePath
  const branch = seat?.schema !== undefined ? 'seat/' + seat.id : seat?.worktreeBranch
  if (held(await seatHolders(dir, [dir, ...(tree ? [tree] : [])], claimFile))) continue
  if (tree && existsSync(join(tree, '.git'))) {
    const common = git(['-C', tree, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
    const repo = common.status === 0 ? common.stdout.trim() : ''
    const force = seat?.schema !== undefined && !existsSync(join(dir, 'wt-ready')) ? ['--force', '--force'] : []
    // Windows cannot delete a process's current folder, so git runs from the repository, not inside the worktree it removes.
    if (!repo || git(['--git-dir', repo, 'worktree', 'remove', ...force, tree], { stdio: 'ignore' }).status !== 0) continue
    if (seat.tier === 'reviewer' && branch && !deleteBranch(['--git-dir', repo], branch)) continue
  } else if (seat?.schema !== undefined && seat.tier === 'reviewer' && seat.isolation === 'worktree' && existsSync(seat.cwd)) {
    if (!deleteBranch(['-C', seat.cwd], branch)) continue
  }
  removeTree(dir)
  process.stdout.write(dir + '\n')
}

const names = dir => {
  try {
    return readdirSync(dir)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}
const pruneRecords = dir => {
  for (const name of names(dir)) {
    const path = join(dir, name)
    if (now - lstatSync(path).mtimeMs >= RECORD_MS) rmSync(path, { force: true })
  }
}
if (basename(root) === 'seats') {
  const home = dirname(root)
  for (const kind of ['deliveries', 'outcomes', 'lineage']) pruneRecords(join(home, kind))
  for (const box of names(join(home, 'mail'))) {
    pruneRecords(join(home, 'mail', box))
    try {
      rmdirSync(join(home, 'mail', box))
    } catch (error) {
      if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error
    }
  }
}
