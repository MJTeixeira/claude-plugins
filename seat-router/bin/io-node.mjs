import { execFile, execFileSync } from 'node:child_process'
import { closeSync, createReadStream, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { claimFile, cliState, group, holdEndpoint, probe } from './liveness.mjs'

const WIN = process.platform === 'win32'
/** How long accept.mjs and prune-seats.mjs give each command they run; one that runs out was not done. */
export const COMMAND_MS = Number(process.env.SEAT_ROUTER_COMMAND_MS) || 60_000
/** @type {import('node:child_process').ExecFileSyncOptionsWithStringEncoding} */
const hidden = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: COMMAND_MS }
// By full path: a Windows PATH can put Git's POSIX tools (whoami among them) ahead of System32's.
const system32 = (...parts) => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', ...parts)
const powershell = command => execFileSync(system32('WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', command], hidden).trim()

export const readJson = path => {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined }
}

export const readText = path => {
  try { return readFileSync(path, 'utf8') } catch { return '' }
}

/** Writes a whole file or nothing: a reader never sees half of it. */
export const writeAtomic = (path, text) => {
  mkdirSync(dirname(path), { recursive: true })
  const temp = path + '.' + process.pid + '.tmp'
  writeFileSync(temp, text, { mode: 0o600 })
  renameSync(temp, path)
}

export const exists = path => lstatSync(path, { throwIfNoEntry: false }) !== undefined

const generations = dir => {
  try {
    return readdirSync(dir).filter(name => /^\d+$/.test(name)).map(Number).sort((a, b) => a - b)
  } catch {
    return []
  }
}

/**
 * The seat's supervisor lock as fenced generations: `lock/<n>`, each claimed whole by a hard link that fails when the
 * name exists, and naming the endpoint its holder keeps open while it lives. The highest generation owns the seat; a
 * successor takes over a holder whose endpoint reads dead by claiming `<n+1>`, so two adopters racing cannot both win,
 * and a holder whose endpoint cannot be read is left alone. A false dead (a full accept queue) costs a takeover, never
 * a second CLI: every CLI start passes its attempt's `started` claim.
 * @returns {Promise<{ generation: number, mine: () => boolean, endpoint: string, close: () => void } | undefined>}  undefined when another holds it
 */
export const claimLock = async (parent, name = 'lock') => {
  const dir = join(parent, name)
  mkdirSync(dir, { recursive: true })
  const top = generations(dir).at(-1) ?? 0
  if (top && await probe(readJson(join(dir, String(top)))?.endpoint) !== 'dead') return undefined
  const held = await holdEndpoint(dir)
  const generation = top + 1
  if (!claimFile(join(dir, String(generation)), JSON.stringify({ endpoint: held.path, pid: process.pid }) + '\n')) {
    held.server.close()
    return undefined
  }
  return { generation, mine: () => generations(dir).at(-1) === generation, endpoint: held.path, close: () => held.server.close() }
}

/** Every writer's quota file under <home>/quota, parsed; the ledger validates them. */
export const quotaFiles = home => {
  const dir = join(home, 'quota')
  let names
  try { names = readdirSync(dir).filter(name => name.endsWith('.json')) } catch { return [] }
  return names.map(name => readJson(join(dir, name))).filter(file => file !== undefined)
}

/**
 * Removes the claims below `generation` in a fenced lock and the endpoints they name: each lost its holder before the
 * next one was claimed.
 */
export const pruneGenerations = (dir, generation) => {
  for (const name of generations(dir).filter(found => found < generation)) {
    const endpoint = readJson(join(dir, String(name)))?.endpoint
    if (typeof endpoint === 'string' && endpoint.startsWith(dir)) rmSync(endpoint, { force: true })
    rmSync(join(dir, String(name)), { force: true })
  }
}

export const liveEntries = home => {
  const dir = join(home, 'live')
  let names
  try { names = readdirSync(dir).filter(name => name.endsWith('.json')) } catch { return [] }
  return names.map(name => readJson(join(dir, name))).filter(entry => typeof entry?.id === 'string')
}

const alive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/**
 * What the attempt's `outside` record names: the processes it found outside the CLI's group that a process still has
 * the pid of, and whether a listing failed. A reused pid reads as running.
 * @returns {{ running: { pid: number, command: string }[], unlisted: boolean }}
 */
export const outsideOf = folder => {
  const rows = readText(join(folder, 'outside')).split('\n').flatMap(line => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
  const byPid = new Map(rows.filter(row => typeof row.pid === 'number').map(row => [row.pid, row]))
  return { running: [...byPid.values()].filter(row => alive(row.pid)), unlisted: rows.some(row => row.unlisted === true) }
}

const HOLDERS_MS = 30_000

/** Every process's current folder and open files, from /proc. One whose entries cannot be read (another user's) is left out. */
const procOpen = () => readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
  const base = '/proc/' + name
  const names = []
  try { names.push(readlinkSync(base + '/cwd')) } catch {}
  try {
    for (const fd of readdirSync(base + '/fd')) {
      try { names.push(readlinkSync(base + '/fd/' + fd)) } catch {}
    }
  } catch {}
  return names.length ? [{ pid: Number(name), command: readText(base + '/comm').trim(), names }] : []
})

/** Every process's current folder and open files, from one lsof. */
const lsofOpen = () => new Promise((resolve, reject) => {
  execFile(process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof', ['-w', '-n', '-P', '-Fpcn'], { cwd: '/', timeout: HOLDERS_MS, maxBuffer: 1 << 30 }, (error, stdout) => {
    if (error) return reject(error)
    /** @type {{ pid: number, command: string, names: string[] }[]} */
    const rows = []
    for (const line of stdout.split('\n')) {
      const row = rows.at(-1)
      if (line[0] === 'p') rows.push({ pid: Number(line.slice(1)), command: '', names: [] })
      else if (line[0] === 'c' && row) row.command = line.slice(1)
      else if (line[0] === 'n' && row) row.names.push(line.slice(1))
    }
    resolve(rows)
  })
})

/**
 * The processes other than this one whose current folder, or a file they have open, is inside one of `paths`, as the
 * kernel says (/proc on Linux, lsof elsewhere); `unknown` when that could not be read, which keeps what it guards.
 * Windows names no other process's current folder, so there it is the processes the `outside` records of the attempt
 * folders `attempts` name that a process still has the pid of.
 * @param {string[]} paths
 * @param {string[]} attempts
 * @returns {Promise<{ pid: number, command: string }[] | 'unknown'>}
 */
export const holders = async (paths, attempts) => {
  if (WIN) return attempts.flatMap(folder => outsideOf(folder).running)
  try {
    const roots = paths.filter(exists).map(path => realpathSync.native(path))
    if (!roots.length) return []
    const inside = name => roots.some(root => name === root || name.startsWith(root + '/'))
    const open = process.platform === 'linux' ? procOpen() : await lsofOpen()
    return open.filter(row => row.pid !== process.pid && row.names.some(inside)).map(({ pid, command }) => ({ pid, command }))
  } catch {
    return 'unknown'
  }
}

/** Whether what `holders` found keeps the folders it was asked about. */
export const held = found => found === 'unknown' || found.length > 0

/**
 * Whether no process of an attempt's CLI can run any more: no launcher of it can start its CLI, and nothing of its group
 * is left (POSIX: its launcher's process group is empty; Windows: the CLI it recorded is gone, or, before it recorded
 * one, its launcher no longer holds the pipe). A process the CLI started outside its group does not count here: what
 * deletes a folder also asks `holders`. An attempt no launcher claimed yet is fenced with `fence` (a claim of its
 * `started`) so none ever can; without `fence` it reads as not quiet. An ending written without `left` was quiet when
 * written, and stays so.
 * @param {string} folder
 * @param {(path: string, text: string) => boolean} [fence]
 */
export const attemptQuiet = async (folder, fence) => {
  const ending = readJson(join(folder, 'ending.json'))
  if ((ending && !ending.left) || exists(join(folder, 'released'))) return true
  const path = join(folder, 'started')
  if (!exists(path)) fence?.(path, JSON.stringify({ fenced: true, reason: 'ended' }))
  const started = readJson(path)
  if (started?.fenced) return true
  if (typeof started?.pid !== 'number') return false
  if (!WIN) return group(started.pid) === 'empty'
  const cli = readJson(join(folder, 'cli.json'))
  if (cli) return await cliState(cli) === 'gone'
  return await probe(readJson(join(folder, 'attempt.json'))?.pipe) === 'dead'
}

export const attemptFolders = dir => {
  try { return readdirSync(dir).filter(name => /^attempt-\d+$/.test(name)).map(name => join(dir, name)) } catch { return [] }
}

/** Whether no process of any attempt's CLI of the seat in `dir` can run any more (attemptQuiet). */
export const seatQuiet = async (dir, fence) => {
  for (const folder of attemptFolders(dir)) if (!await attemptQuiet(folder, fence)) return false
  return true
}

/**
 * What keeps `paths` of the seat in `dir` from being deleted: `unknown` while a CLI of it may run (seatQuiet), else
 * what `holders` finds.
 */
export const seatHolders = async (dir, paths, fence) => !await seatQuiet(dir, fence) ? 'unknown' : await holders(paths, attemptFolders(dir))

export const supervised = async seat => {
  const top = generations(join(seat, 'lock')).at(-1)
  return top !== undefined && await probe(readJson(join(seat, 'lock', String(top)))?.endpoint) !== 'dead'
}

/**
 * The Windows one-Claude-at-a-time slot: `<home>/solo/<g>`, each claim a hard link naming the seat, the attempt and the
 * claimer's lock endpoint. The highest claim holds the slot until it is free: ended by its claimer (`<g>.end`), its seat
 * folder gone, its attempt ended with nothing of it left running (attemptQuiet), or its attempt never recorded while
 * its seat has a verdict or its claimer reads dead.
 */
const soloFree = async (home, g) => {
  const path = join(home, 'solo', String(g))
  const claim = readJson(path)
  if (!claim) return false
  if (exists(path + '.end') || !exists(join(claim.dir, 'seat.json'))) return true
  const attempt = join(claim.dir, 'attempt-' + claim.n)
  if (!exists(join(attempt, 'attempt.json'))) return exists(join(claim.dir, 'verdict.json')) || await probe(claim.endpoint) === 'dead'
  return exists(join(attempt, 'ending.json')) && await attemptQuiet(attempt)
}

export const soloHolder = async home => {
  const top = generations(join(home, 'solo')).at(-1)
  if (top === undefined || await soloFree(home, top)) return undefined
  return readJson(join(home, 'solo', String(top)))?.seat ?? '?'
}

export const claimSolo = async (home, claim) => {
  const dir = join(home, 'solo')
  mkdirSync(dir, { recursive: true })
  const top = generations(dir).at(-1) ?? 0
  if (top && !await soloFree(home, top) && readJson(join(dir, String(top)))?.seat !== claim.seat) return undefined
  return claimFile(join(dir, String(top + 1)), JSON.stringify(claim)) ? top + 1 : undefined
}

export const endSolo = (home, g) => writeFileSync(join(home, 'solo', g + '.end'), '')

const CHUNK = 64 * 1024

/** The first or last n lines of a file, read in bounded chunks, never whole. */
export const lines = (path, n, fromEnd) => {
  let fd
  try { fd = openSync(path, 'r') } catch { return '' }
  const size = fstatSync(fd).size
  const newlines = text => text.match(/\n/g)?.length ?? 0
  let text = ''
  let position = fromEnd ? size : 0
  while (fromEnd ? position > 0 : position < size) {
    const length = Math.min(CHUNK, fromEnd ? position : size - position)
    if (fromEnd) position -= length
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, position)
    text = fromEnd ? buffer.toString('utf8') + text : text + buffer.toString('utf8')
    if (!fromEnd) position += length
    if (newlines(text) > n) break
  }
  closeSync(fd)
  const all = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
  const kept = fromEnd ? all.slice(-n) : all.slice(0, n)
  return text ? kept.map(line => line + '\n').join('') : ''
}

const grepWith = async (source, path, { parts = false, first = false } = {}) => {
  const pattern = new RegExp(source.replaceAll('[[:space:]]', '\\s').replaceAll('[[:digit:]]', '\\d'), first ? 'gi' : 'g')
  let out = ''
  try {
    const input = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
    for await (const line of input) {
      const found = [...line.matchAll(pattern)]
      if (!found.length) continue
      if (first) {
        input.close()
        return 'y'
      }
      out += parts ? found.map(match => match[0] + '\n').join('') : line + '\n'
    }
  } catch {}
  return out
}

const expand = (dir, env) => {
  const named = dir.replace(/^\{(\w+):([^}]*)\}/, (_, name, fallback) => env[name] || fallback)
  return named === '~' || named.startsWith('~/') ? (env.HOME || env.USERPROFILE || homedir()) + named.slice(1) : named
}

const findFile = (dir, glob) => {
  const pattern = new RegExp('^' + glob.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
  const walk = folder => {
    let entries
    try { entries = readdirSync(folder, { withFileTypes: true }) } catch { return undefined }
    for (const entry of entries) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) {
        const found = walk(path)
        if (found) return found
      } else if (pattern.test(entry.name)) return path.replaceAll(sep, '/')
    }
    return undefined
  }
  return walk(dir)
}

/**
 * The adapters' read access to an attempt's files and the vendor files they point at, over node:fs.
 * `has` matches case-insensitively, `grep` and `grepParts` exactly, as the mod's seat-io greps did; `find` expands `{NAME:FALLBACK}` and `~` from `env`.
 * @param {Record<string, string>} env
 * @returns {import('./vendors/index.mjs').AttemptView}
 */
export const attemptView = env => ({
  read: async path => readText(path),
  head: async path => lines(path, 1, false),
  tail: async (path, n) => lines(path, n, true),
  grep: (pattern, path) => grepWith(pattern, path),
  grepParts: (pattern, path) => grepWith(pattern, path, { parts: true }),
  has: async (pattern, path) => Boolean(await grepWith(pattern, path, { first: true })),
  find: async (dir, glob) => findFile(expand(dir, env), glob),
})

// Who may own %PUBLIC%\seat-router, or a folder in a seat-router home, besides the user: its owner could rename the
// user's folder and plant a junction there. An elevated Administrator's new folders are owned by Administrators.
const TRUSTED_OWNERS = ['S-1-5-18', 'S-1-5-32-544']

const userSid = () => /"(S-1-[\d-]+)"/.exec(execFileSync(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], hidden))?.[1]

/** The owner SID of each path, read in one PowerShell. */
const ownersOf = paths => /** @type {string[]} */ ([JSON.parse(powershell('@(' + paths.map(path => "'" + path.replaceAll("'", "''") + "'").join(',')
  + ') | ForEach-Object { (Get-Acl -LiteralPath $_).GetOwner([System.Security.Principal.SecurityIdentifier]).Value } | ConvertTo-Json -Compress'))].flat())

/** Why one of `paths` may be another user's: a link or junction, or an owner `allowed` does not name. */
const foreign = (paths, allowed) => {
  const linked = paths.find(path => lstatSync(path).isSymbolicLink())
  if (linked) return linked + ' is a link or junction'
  const owners = paths.length ? ownersOf(paths) : []
  const at = owners.findIndex(owner => !allowed.includes(owner))
  return at === -1 ? undefined : paths[at] + ' is owned by ' + owners[at] + ', not by ' + allowed.join(', ')
}

/**
 * Why a folder at any depth in `leaf` may be another user's: a link or junction directly in it, or an owner `allowed`
 * does not name. Links deeper in (an agy seat's HOME links ~/.gemini) are checked for their owner and not followed.
 * Read in one PowerShell; an error reading any entry stops it, and so refuses.
 */
const foreignInside = (leaf, allowed) => powershell("$ErrorActionPreference = 'Stop'\n"
  + '$allowed = @(' + allowed.map(sid => "'" + sid + "'").join(',') + ')\n'
  + "$top = New-Object System.IO.DirectoryInfo '" + leaf.replaceAll("'", "''") + "'\n"
  + "$todo = New-Object 'System.Collections.Generic.Stack[System.IO.DirectoryInfo]'\n"
  + '$todo.Push($top)\n$found = $null\n'
  + ':walk while ($todo.Count) {\n'
  + '  $folder = $todo.Pop()\n'
  + '  foreach ($entry in $folder.GetFileSystemInfos()) {\n'
  + '    $link = ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0\n'
  + "    if ($link -and $folder.FullName -eq $top.FullName) { $found = $entry.FullName + ' is a link or junction'; break walk }\n"
  + '    if (-not $link -and ($entry.Attributes -band [System.IO.FileAttributes]::Directory) -eq 0) { continue }\n'
  + "    $owner = $entry.GetAccessControl('Owner').GetOwner([System.Security.Principal.SecurityIdentifier]).Value\n"
  + "    if ($allowed -notcontains $owner) { $found = $entry.FullName + ' is owned by ' + $owner + ', not by ' + ($allowed -join ', '); break walk }\n"
  + '    if (-not $link) { $todo.Push($entry) }\n'
  + '  }\n'
  + '}\n'
  + '$found') || undefined

/**
 * Why the folders of `paths` that exist may not be the user's alone on Windows: a link or junction among them, or an
 * owner other than the user, SYSTEM or Administrators. Undefined when they are, and always on POSIX, whose seat-router
 * home is in the user's own home folder.
 * @param {string[]} paths
 */
export const notTheUsers = paths => {
  if (!WIN) return undefined
  try {
    const sid = userSid()
    if (!sid) return 'whoami named no SID'
    return foreign(paths.filter(exists), [sid, ...TRUSTED_OWNERS])
  } catch (error) {
    return error.message
  }
}

/**
 * The user's SID and the owner, protection and access-entry SIDs of each of `paths` (by name), read in one PowerShell.
 * @typedef {{ owner: string, protected: boolean, sids: string[] }} Acl
 * @param {{ parent?: string, leaf?: string, path?: string }} paths
 * @returns {{ sid?: string, parent?: Acl, leaf?: Acl, path?: Acl }}
 */
const locksOf = paths => {
  const read = JSON.parse(powershell("$ErrorActionPreference = 'Stop'\n$id = [System.Security.Principal.SecurityIdentifier]\n"
    + '$acl = { param($path) $a = Get-Acl -LiteralPath $path; @{ owner = $a.GetOwner($id).Value; protected = $a.AreAccessRulesProtected; '
    + 'sids = @($a.Access | ForEach-Object { $_.IdentityReference.Translate($id).Value }) } }\n'
    + '@{ sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'
    + Object.entries(paths).map(([name, path]) => '; ' + name + " = & $acl '" + path.replaceAll("'", "''") + "'").join('')
    + ' } | ConvertTo-Json -Compress -Depth 4'))
  for (const name of Object.keys(paths)) read[name].sids = [read[name].sids].flat()
  return read
}

/** Whether a leaf's ACL is the lock securePublicLeaf sets: owner and only access entry `sid`, inheritance removed. */
const lockedTo = (acl, sid) => acl.owner === sid && acl.protected === true && acl.sids.length > 0 && acl.sids.every(entry => entry === sid)

/**
 * Locks a %PUBLIC% home leaf to the user before anything is written in it: owner and only access entry the user's
 * SID, inheritance removed, no link or junction on the way. The parent all users' leaves share must be owned by the
 * user, SYSTEM or Administrators (by SID: group names are localized); one this call makes lets other users add a leaf
 * of their own and nothing more. A leaf that exists already and holds that lock is trusted as it is, as the 0700
 * POSIX home is: only the user could have written in it since. One that exists without it is used only when the user
 * owns it and the user, SYSTEM or Administrators own each folder in it, at any depth (foreignInside): another user
 * could have made it, or a folder in it, to edit what seats run.
 * Returns why it refused, or undefined once it holds.
 */
export const securePublicLeaf = leaf => {
  if (!WIN) return 'the %PUBLIC% home is a Windows protocol'
  try {
    const parent = dirname(leaf)
    const found = locksOf({ ...(exists(parent) ? { parent } : {}), ...(exists(leaf) ? { leaf } : {}) })
    const sid = found.sid
    if (!sid) return 'whoami named no SID'
    const icacls = (...args) => execFileSync(system32('icacls.exe'), args, { stdio: 'ignore', windowsHide: true, timeout: COMMAND_MS })
    const readAcl = path => locksOf({ path }).path
    let made = true
    try {
      mkdirSync(parent)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      made = false
    }
    if (lstatSync(parent).isSymbolicLink()) return parent + ' is a link or junction'
    if (made) {
      icacls(parent, '/inheritance:r', '/grant:r', '*' + sid + ':F', '*S-1-5-18:F', '*S-1-5-32-544:F', '*S-1-5-11:(RD,AD,X,RA,REA,RC,S)')
      icacls(parent, '/setowner', '*' + sid)
    }
    const owner = (!made && found.parent ? found.parent : readAcl(parent)).owner
    if (owner !== sid && !TRUSTED_OWNERS.includes(owner)) return parent + ' is owned by ' + owner + ', not by ' + sid + ', SYSTEM or Administrators'
    const linked = () => {
      for (let path = leaf; path !== dirname(path); path = dirname(path)) {
        if (lstatSync(path).isSymbolicLink()) return path + ' is a link or junction'
      }
      return undefined
    }
    if (exists(leaf)) {
      if (found.leaf && lockedTo(found.leaf, sid)) return linked()
      const theirs = foreign([leaf], [sid]) ?? foreignInside(leaf, [sid, ...TRUSTED_OWNERS])
      if (theirs !== undefined) return theirs
    }
    mkdirSync(leaf, { recursive: true })
    const link = linked()
    if (link !== undefined) return link
    icacls(leaf, '/inheritance:r', '/grant:r', '*' + sid + ':(OI)(CI)F')
    icacls(leaf, '/setowner', '*' + sid)
    // A new folder can carry explicit entries (SYSTEM, Administrators) that removing inheritance keeps.
    for (const other of new Set(readAcl(leaf).sids.filter(entry => entry !== sid))) icacls(leaf, '/remove', '*' + other)
    const acl = readAcl(leaf)
    const sids = acl.sids
    if (acl.owner !== sid) return 'its owner is ' + acl.owner + ', not ' + sid
    if (!acl.protected) return 'it still inherits access entries'
    if (sids.some(entry => entry !== sid)) return 'it grants access to ' + sids.filter(entry => entry !== sid).join(', ')
    return undefined
  } catch (error) {
    return error.message
  }
}
