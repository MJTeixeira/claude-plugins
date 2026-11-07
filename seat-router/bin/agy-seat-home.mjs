#!/usr/bin/env node
// Builds the HOME an agy seat runs under and prints its path.
// It mirrors ~/.gemini through links, except antigravity-cli/settings.json and
// config/config.json, which are the seat's own: the operator's with AI credits off and,
// in settings, the deny list added. Every seat runs outside agy's sandbox: its
// config/hooks.json adds owner-guard.mjs to the operator's hooks, and its deny list
// keeps the irreversible commands out besides. A reviewer starts none of the
// operator's MCP servers (its config/mcp_config.json lists none) and gets neither the
// operator's gh login nor the macOS keychain gh keeps its token in, but an empty keychain
// of its own; an owner keeps them all. Nothing under the operator's ~/.gemini is touched.
// `--home DIR` builds the HOME at DIR instead of the shared one; `--own DIR` names the seat's folder to the guard,
// and holds in DIR/agy-state the conversation store the operator has none of.
// `release` copies the images the seat generated for the conversation read from `--transcript`
// to `--keep DIR` (skipping agy view copies and subfolders), prints each copy's path, and deletes HOME even when a copy fails.
// Usage: node agy-seat-home.mjs [owner] [--home DIR] [--own DIR]
//        node agy-seat-home.mjs release --home DIR --own DIR --transcript FILE --keep DIR
import { execFileSync } from 'node:child_process'
import { closeSync, constants, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { removeTree } from './remove-tree.mjs'

const real = homedir()
let tier = 'reviewer'
let home = ''
let seatDir = ''
let release = false
let transcript = ''
let keep = ''
const args = process.argv.slice(2)
while (args.length) {
  const arg = args.shift()
  if (arg === 'owner') tier = 'owner'
  else if (arg === 'release') release = true
  else if (arg === '--home') home = args.shift()
  else if (arg === '--own') seatDir = args.shift()
  else if (arg === '--transcript') transcript = args.shift()
  else if (arg === '--keep') keep = args.shift()
  else {
    console.error(`agy-seat-home: unknown argument ${arg}`)
    process.exit(2)
  }
}

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

const conversationOf = file => {
  let fd
  try { fd = openSync(file, 'r') } catch { return undefined }
  const buffer = Buffer.alloc(64 * 1024)
  const read = readSync(fd, buffer, 0, buffer.length, 0)
  closeSync(fd)
  let event
  try { event = JSON.parse(buffer.toString('utf8', 0, read).split('\n')[0]) } catch { return undefined }
  const id = event?.event === 'init' ? event.conversation_id : undefined
  return typeof id === 'string' && /^[\w-]+$/.test(id) ? id : undefined
}

// agy keeps a conversation in these. A seat whose operator has none keeps its own outside
// HOME, so a resumed attempt finds the conversation after the earlier attempt's HOME is gone.
const STATE = ['conversations', 'brain']
const stateOf = name => join(seatDir, 'agy-state', name)

const unlinkedFolderAt = (base, ...names) => {
  let path = base
  for (const name of names) {
    path = join(path, name)
    if (!lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) return undefined
  }
  return path
}

const within = (root, path) => {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

const VIEW_COPY = /^step_\d+_media_\d+\.[^.]+$/
const imagesIn = folder => readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
  const isImage = entry.isFile() && IMAGE.has(extname(entry.name).toLowerCase())
  return isImage && !VIEW_COPY.test(entry.name) ? [join(folder, entry.name)] : []
})

// A hard link would carry a file from outside the seat in, so only a file with one name is copied.
const copyOut = (image, target) => {
  const from = openSync(image, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = fstatSync(from)
    if (!stat.isFile() || stat.nlink !== 1) return false
    const to = openSync(target, 'wx')
    try { writeSync(to, readFileSync(from)) } finally { closeSync(to) }
    return true
  } finally { closeSync(from) }
}

const keepImages = () => {
  const conversation = conversationOf(transcript)
  if (!conversation || !keep) return
  const folders = [
    unlinkedFolderAt(home, '.gemini', 'antigravity-cli', 'brain', conversation),
    unlinkedFolderAt(seatDir, 'agy-state', 'brain', conversation),
    unlinkedFolderAt(real, '.gemini', 'antigravity-cli', 'brain', conversation),
  ].filter(Boolean)
  const seatReal = realpathSync(seatDir)
  const brain = unlinkedFolderAt(real, '.gemini', 'antigravity-cli', 'brain')
  const sources = [seatReal, ...(brain ? [realpathSync(brain)] : [])]
  for (const image of folders.flatMap(imagesIn)) {
    if (!sources.some(root => within(root, realpathSync(image)))) throw new Error(`${image} is outside the seat and agy's brain folder`)
    const kept = lstatSync(keep, { throwIfNoEntry: false })
    if (!within(seatReal, realpathSync(dirname(keep)))) throw new Error(`${keep} is outside the seat`)
    if (!kept) mkdirSync(keep)
    else if (!kept.isDirectory()) throw new Error(`${keep} is not a folder`)
    if (!within(seatReal, realpathSync(keep))) throw new Error(`${keep} is outside the seat`)
    const ext = extname(image)
    const base = basename(image, ext)
    let target = join(keep, base + ext)
    let copied = false
    // A release run again after a crash finds its earlier copies, and makes no second one.
    for (let n = 1; lstatSync(target, { throwIfNoEntry: false }); n += 1) {
      if (lstatSync(target).isFile() && readFileSync(target).equals(readFileSync(image))) copied = true
      target = join(keep, `${base}-${n}${ext}`)
    }
    if (!copied && copyOut(image, target)) console.log(target)
  }
}

if (release) {
  if (!home || !seatDir) {
    console.error('agy-seat-home: release needs --home and --own')
    process.exit(2)
  }
  try {
    keepImages()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  } finally {
    removeTree(home)
  }
  process.exit()
}

const seat = home || join(real, '.claude', tier === 'owner' ? 'agy-owner-home' : 'agy-seat-home')
const isLink = path => {
  try { return lstatSync(path).isSymbolicLink() } catch { return false }
}
// Windows removes a junction with rmdir, which leaves its target alone.
const unlink = path => {
  try { unlinkSync(path) } catch { rmdirSync(path) }
}
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
if (seatDir) {
  for (const name of STATE) {
    if (!existsSync(stateOf(name)) && existsSync(join(real, '.gemini', 'antigravity-cli', name))) continue
    mkdirSync(stateOf(name), { recursive: true })
    link(stateOf(name), join(seat, '.gemini', 'antigravity-cli', name))
  }
}
linkAll(join(real, '.gemini', 'antigravity-cli'), join(seat, '.gemini', 'antigravity-cli'), ['settings.json'])
const config = join(seat, '.gemini', 'config')
const own = tier === 'owner' ? ['hooks.json', 'config.json'] : ['hooks.json', 'config.json', 'mcp_config.json']
for (const name of own) if (isLink(join(config, name))) unlink(join(config, name))
linkAll(join(real, '.gemini', 'config'), config, own)
const keychains = join(seat, 'Library', 'Keychains')
const gh = join(seat, '.config', 'gh')
// agy saves a refreshed login with `security`, which finds the default keychain under HOME. A HOME with
// none makes macOS raise "Keychain Not Found" and agy wait on it, so a reviewer gets an empty keychain at
// the path macOS defaults to, unlocked and never locking again.
const ownKeychain = () => {
  const file = join(keychains, 'login.keychain-db')
  const security = (...args) => execFileSync('/usr/bin/security', args, { env: { ...process.env, HOME: seat }, stdio: 'ignore' })
  mkdirSync(keychains, { recursive: true })
  if (!existsSync(file)) security('create-keychain', '-p', '', file)
  security('unlock-keychain', '-p', '', file)
  security('set-keychain-settings', file)
}
if (tier !== 'owner') {
  for (const path of [keychains, gh]) if (isLink(path)) unlink(path)
  if (process.platform === 'darwin') ownKeychain()
} else if (process.platform === 'darwin') {
  if (!isLink(keychains)) removeTree(keychains)
  mkdirSync(join(seat, 'Library'), { recursive: true })
  link(join(real, 'Library', 'Keychains'), keychains)
}

const operator = join(real, '.gemini', 'config', 'hooks.json')
const hooks = existsSync(operator) ? JSON.parse(readFileSync(operator, 'utf8')) : {}
const guard = join(dirname(fileURLToPath(import.meta.url)), 'owner-guard.mjs').replaceAll('\\', '/')
// agy on Windows hands the command to node with its quotes still in the path, so a
// path is quoted only when it has to be.
const quoted = path => /\s/.test(path) ? `"${path}"` : path
const command = `node ${quoted(guard)}${seatDir ? ` --own ${quoted(seatDir)}` : ''}`
hooks['seat-router-owner-guard'] = { PreToolUse: [{ matcher: 'run_command', hooks: [{ command }] }] }
writeFileSync(join(config, 'hooks.json'), JSON.stringify(hooks, null, 2) + '\n')
// A seat never spends AI credits past the plan's quota, which the quota check would not count as out:
// useG1Credits in settings.json and userSettings.useAiCredits in config.json both stay off
// (google-antigravity/antigravity-cli#1080).
const operatorConfig = join(real, '.gemini', 'config', 'config.json')
const agyConfig = existsSync(operatorConfig) ? JSON.parse(readFileSync(operatorConfig, 'utf8')) : {}
agyConfig.userSettings = { ...agyConfig.userSettings, useAiCredits: false }
writeFileSync(join(config, 'config.json'), `${JSON.stringify(agyConfig, null, 2)}\n`)
if (tier !== 'owner') writeFileSync(join(config, 'mcp_config.json'), JSON.stringify({ mcpServers: {} }) + '\n')
link(join(real, '.gitconfig'), join(seat, '.gitconfig'))
if (tier === 'owner') {
  mkdirSync(join(seat, '.config'), { recursive: true })
  link(join(real, '.config', 'gh'), gh)
}
// A seat gets what the operator's own agy may do (allowNonWorkspaceAccess, say): a refusal
// in -p mode halts the conversation that asked. A force push is left to the guard, which lets
// a lease onto the seat's own branch through.
const operatorSettings = join(real, '.gemini', 'antigravity-cli', 'settings.json')
const settings = existsSync(operatorSettings) ? JSON.parse(readFileSync(operatorSettings, 'utf8')) : {}
const deny = ['git reset --hard', 'gh pr merge --admin', 'gh repo delete', 'rm -rf'].map(name => `command(${name})`)
settings.useG1Credits = false
settings.permissions = { ...settings.permissions, deny: [...new Set([...(settings.permissions?.deny ?? []), ...deny])] }
writeFileSync(join(seat, '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify(settings) + '\n')
console.log(seat)
