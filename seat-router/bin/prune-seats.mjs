#!/usr/bin/env node
// Sweeps finished worktrees and seat scratch (tmp) after one day, seat folders after seven days, and records after 60 days. A CLI or folder holder keeps its seat.
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, rmdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { COMMAND_MS, held, seatHolders } from './io-node.mjs'
import { claimFile } from './liveness.mjs'
import { removeTree } from './remove-tree.mjs'
import { claimOf, isSeatId } from './core/layout.mjs'
import { worktreeRelease } from './worktree.mjs'

const DAY_MS = 1 * 24 * 60 * 60 * 1000
const SEAT_MS = 7 * 24 * 60 * 60 * 1000
const RECORD_MS = 60 * 24 * 60 * 60 * 1000
const root = process.argv[2]
const now = Date.now()

const readJson = path => {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined }
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
  return undefined
}

let entries = []
// A ROOT that does not exist yet holds no seats to prune.
try { entries = readdirSync(root, { withFileTypes: true }) } catch {}
for (const entry of entries) {
  if (!entry.isDirectory()) continue
  const dir = join(root, entry.name)
  // A finished seat has no supervisor left, so its last writer is this: an attempt no launcher claimed is fenced here.
  if (/^\.trash-seat-/.test(entry.name)) {
    if (held(await seatHolders(dir, [dir], claimFile))) continue
    removeTree(dir)
    process.stdout.write(dir + '\n')
    continue
  }
  if (!/^seat-/.test(entry.name)) continue
  const seat = readJson(join(dir, 'seat.json'))
  const ended = endedAt(dir, seat)
  if (ended === undefined || now - ended < DAY_MS) continue
  const tree = seat?.schema !== undefined ? join(dir, 'wt') : undefined
  const branch = seat?.schema !== undefined ? 'seat/' + seat.id : undefined
  if (held(await seatHolders(dir, [dir, ...(tree ? [tree] : [])], claimFile))) continue
  removeTree(join(dir, 'tmp'))
  if (tree && existsSync(join(tree, '.git'))) {
    const common = git(['-C', tree, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
    const repo = common.status === 0 ? common.stdout.trim() : ''
    const unfinished = seat?.schema !== undefined && !existsSync(join(dir, 'wt-ready'))
    const readGit = args => { const result = git(args); return { ...result, exitCode: result.status } }
    const release = unfinished ? { flags: ['--force', '--force'] } : await worktreeRelease(readGit, tree, seat)
    if (release.keep) continue
    const force = release.flags ?? []
    // Windows cannot delete a process's current folder, so git runs from the repository, not inside the worktree it removes.
    if (!repo || git(['--git-dir', repo, 'worktree', 'remove', ...force, tree], { stdio: 'ignore' }).status !== 0) continue
    if (seat.tier === 'reviewer' && branch && !deleteBranch(['--git-dir', repo], branch)) continue
  } else if (seat?.schema !== undefined && seat.tier === 'reviewer' && seat.isolation === 'worktree' && existsSync(seat.cwd)) {
    if (!deleteBranch(['-C', seat.cwd], branch)) continue
  }
  if (now - ended < SEAT_MS) continue
  removeTree(dir)
  process.stdout.write(dir + '\n')
}

const names = dir => {
  try {
    return readdirSync(dir)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []
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
  const transcriptsByConfig = new Map()
  for (const box of names(join(home, 'mail'))) {
    const mailbox = join(home, 'mail', box)
    const ids = names(mailbox).map(name => isSeatId(name) ? name : claimOf(name)?.id).filter(Boolean)
    const launchEnv = ids.map(id => readJson(join(root, id, 'seat.json'))?.launch?.env).find(Boolean) ?? process.env
    const config = launchEnv.CLAUDE_CONFIG_DIR ?? join(launchEnv.HOME ?? launchEnv.USERPROFILE ?? homedir(), '.claude')
    if (!transcriptsByConfig.has(config)) {
      const projects = join(config, 'projects')
      transcriptsByConfig.set(config, new Set(names(projects).flatMap(project => names(join(projects, project)).filter(name => name.endsWith('.jsonl')).map(name => name.slice(0, -6)))))
    }
    const transcripts = transcriptsByConfig.get(config)
    if (!transcripts.has(box)) {
      removeTree(join(home, 'mail', box))
      continue
    }
    pruneRecords(join(home, 'mail', box))
    try {
      rmdirSync(join(home, 'mail', box))
    } catch (error) {
      if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error
    }
  }
}
