#!/usr/bin/env node
// Builds the HOME an agy seat runs under and prints its path.
// It mirrors ~/.gemini through links, except antigravity-cli/settings.json,
// which is the seat's own. A reviewer's commands auto-run inside agy's terminal
// sandbox, and it starts none of the operator's MCP servers: its
// config/mcp_config.json lists none. An owner runs outside the sandbox and keeps
// them; its config/hooks.json adds owner-guard.mjs to the operator's hooks, and
// its deny list keeps the irreversible commands out besides. Nothing under the
// operator's ~/.gemini is touched. `--home DIR` builds the HOME at DIR instead of the
// shared one, so one seat's grants never reach another. Each `--read DIR` lets
// the seat read DIR and everything under it; writes there stay refused. `--write DIR`
// lets it write DIR too: headless agy registers no workspace, so on Windows its
// AppContainer otherwise mounts the seat's own folder read-only, and even changing
// into it is refused.
// Usage: node agy-seat-home.mjs [owner] [--home DIR] [--write DIR]... [--read DIR]...
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const real = homedir()
let tier = 'reviewer'
let home = ''
const reads = []
const args = process.argv.slice(2)
while (args.length) {
  const arg = args.shift()
  if (arg === 'owner') tier = 'owner'
  else if (arg === '--home') home = args.shift()
  else if (arg === '--write') reads.push(`write_file(${args.shift()})`)
  else if (arg === '--read') reads.push(`read_file(${args.shift()})`)
  else {
    console.error(`agy-seat-home: unknown argument ${arg}`)
    process.exit(2)
  }
}
const seat = home || join(real, '.claude', tier === 'owner' ? 'agy-owner-home' : 'agy-seat-home')
const isLink = path => {
  try { return lstatSync(path).isSymbolicLink() } catch { return false }
}
// Windows removes a junction with rmdir, which leaves its target alone.
const unlink = path => {
  try { unlinkSync(path) } catch { rmdirSync(path) }
}
// A home built before config/ was the seat's own links the operator's folder there.
if (isLink(join(seat, '.gemini', 'config'))) unlink(join(seat, '.gemini', 'config'))
mkdirSync(join(seat, '.gemini', 'antigravity-cli'), { recursive: true })
mkdirSync(join(seat, '.gemini', 'config'), { recursive: true })
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
    if (isLink(path) && !existsSync(path)) unlink(path)
  }
  if (!existsSync(from)) return
  for (const name of readdirSync(from)) {
    if (!skip.includes(name)) link(join(from, name), join(to, name))
  }
}

linkAll(join(real, '.gemini'), join(seat, '.gemini'), ['antigravity-cli', 'config'])
linkAll(join(real, '.gemini', 'antigravity-cli'), join(seat, '.gemini', 'antigravity-cli'), ['settings.json'])
const config = join(seat, '.gemini', 'config')
const own = tier === 'owner' ? ['hooks.json'] : ['mcp_config.json']
for (const name of own) if (isLink(join(config, name))) unlink(join(config, name))
linkAll(join(real, '.gemini', 'config'), config, own)
if (process.platform === 'darwin') {
  mkdirSync(join(seat, 'Library'), { recursive: true })
  link(join(real, 'Library', 'Keychains'), join(seat, 'Library', 'Keychains'))
}

const settings = tier === 'owner' ? {} : { toolPermission: 'proceed-in-sandbox' }
if (tier === 'owner') {
  const operator = join(real, '.gemini', 'config', 'hooks.json')
  const hooks = existsSync(operator) ? JSON.parse(readFileSync(operator, 'utf8')) : {}
  const guard = join(dirname(fileURLToPath(import.meta.url)), 'owner-guard.mjs').replaceAll('\\', '/')
  // agy on Windows hands the command to node with its quotes still in the path, so the
  // path is quoted only when it has to be.
  const command = /\s/.test(guard) ? `node "${guard}"` : `node ${guard}`
  hooks['seat-router-owner-guard'] = { PreToolUse: [{ matcher: 'run_command', hooks: [{ command }] }] }
  writeFileSync(join(config, 'hooks.json'), JSON.stringify(hooks, null, 2) + '\n')
  // git identity and gh config, read where the operator keeps them
  link(join(real, '.gitconfig'), join(seat, '.gitconfig'))
  mkdirSync(join(seat, '.config'), { recursive: true })
  link(join(real, '.config', 'gh'), join(seat, '.config', 'gh'))
  // A force push is left to the guard, which lets a lease onto the seat's own branch through.
  settings.permissions = {
    deny: ['git reset --hard', 'gh pr merge --admin', 'gh repo delete', 'rm -rf'].map(name => `command(${name})`),
  }
} else {
  writeFileSync(join(config, 'mcp_config.json'), JSON.stringify({ mcpServers: {} }) + '\n')
  if (reads.length) settings.permissions = { allow: reads }
}
writeFileSync(join(seat, '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify(settings) + '\n')
console.log(seat)
