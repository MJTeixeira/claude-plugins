#!/usr/bin/env node
// Builds the HOME an agy seat runs under and prints its path.
// It mirrors ~/.gemini through links, except antigravity-cli/settings.json,
// which is the seat's own: commands auto-run inside agy's terminal sandbox.
// The operator's ~/.gemini/antigravity-cli/settings.json is never touched.
// `owner` lets git, gh and the package tools leave the sandbox (network, .git
// writes) when agy asks to bypass it; the deny list keeps the irreversible
// commands out either way. `--home DIR` builds the HOME at DIR instead of the
// shared one, so one seat's grants never reach another. Each `--read DIR` lets
// the seat read DIR and everything under it; writes there stay refused.
// Usage: node agy-seat-home.mjs [owner] [--home DIR] [--read DIR]...
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const real = homedir()
let tier = 'reviewer'
let home = ''
const reads = []
const args = process.argv.slice(2)
while (args.length) {
  const arg = args.shift()
  if (arg === 'owner') tier = 'owner'
  else if (arg === '--home') home = args.shift()
  else if (arg === '--read') reads.push(`read_file(${args.shift()})`)
  else {
    console.error(`agy-seat-home: unknown argument ${arg}`)
    process.exit(2)
  }
}
const seat = home || join(real, '.claude', tier === 'owner' ? 'agy-owner-home' : 'agy-seat-home')
mkdirSync(join(seat, '.gemini', 'antigravity-cli'), { recursive: true })

const isLink = path => {
  try { return lstatSync(path).isSymbolicLink() } catch { return false }
}
// Windows links a directory as a junction, which needs no privilege; a file
// link needs Developer Mode there, so a file is copied when the link is refused.
const link = (target, path) => {
  if (existsSync(path) || isLink(path) || !existsSync(target)) return
  if (statSync(target).isDirectory()) return symlinkSync(target, path, 'junction')
  try {
    symlinkSync(target, path, 'file')
  } catch (error) {
    if (process.platform !== 'win32') throw error
    copyFileSync(target, path)
  }
}
const linkAll = (from, to, skip) => {
  for (const name of readdirSync(to)) {
    const path = join(to, name)
    if (isLink(path) && !existsSync(path)) rmSync(path)
  }
  if (!existsSync(from)) return
  for (const name of readdirSync(from)) {
    if (name !== skip) link(join(from, name), join(to, name))
  }
}

linkAll(join(real, '.gemini'), join(seat, '.gemini'), 'antigravity-cli')
linkAll(join(real, '.gemini', 'antigravity-cli'), join(seat, '.gemini', 'antigravity-cli'), 'settings.json')
if (process.platform === 'darwin') {
  mkdirSync(join(seat, 'Library'), { recursive: true })
  link(join(real, 'Library', 'Keychains'), join(seat, 'Library', 'Keychains'))
}

const settings = { toolPermission: 'proceed-in-sandbox' }
if (tier === 'owner') {
  // git identity and gh config, read where the operator keeps them
  link(join(real, '.gitconfig'), join(seat, '.gitconfig'))
  mkdirSync(join(seat, '.config'), { recursive: true })
  link(join(real, '.config', 'gh'), join(seat, '.config', 'gh'))
  settings.permissions = {
    allow: ['git', 'gh', 'npm', 'npx', 'node', 'pnpm', 'yarn', 'curl'].map(name => `command(${name})`).concat(reads),
    deny: ['git push --force', 'git push -f', 'git reset --hard', 'gh pr merge --admin', 'gh repo delete', 'rm -rf'].map(name => `command(${name})`),
  }
} else if (reads.length) {
  settings.permissions = { allow: reads }
}
writeFileSync(join(seat, '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify(settings) + '\n')
console.log(seat)
