#!/usr/bin/env node
// The few POSIX tools the mod probes seat files with, written once for every
// platform and taking the flags the mod passes: `pwd`, `head -n N FILE`, `tail -n N FILE`,
// `grep -[Eicoq] PATTERN FILE...` (POSIX classes read as JS), `find DIR -name
// GLOB` (DIR may start `{NAME:FALLBACK}`, NAME's value or else FALLBACK, and `~` is
// the home folder), `exec NAME ARG...`, which starts a CLI as command.mjs resolves it,
// `alive PID` (exit 0 while that process runs), `ancestors` (the pids above this process, nearest first, one a line; only the
// parent's when the process table cannot be read), `claim FROM TO`, which renames a seat's mail marker or claim FROM to
// the claim TO and exits 3 when another process is claiming that seat's report or FROM is gone, so of any number of
// claims of one report one wins, and `delivered CLAIM`, which deletes a delivered report's claim and every take of it.
import { execFileSync, spawn } from 'node:child_process'
import { createReadStream, readdirSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { command } from './command.mjs'
import { claimOf, takeName, takeOf } from './core/layout.mjs'
import { lines, readJson } from './io-node.mjs'
import { claimFile, windowsPowerShell } from './liveness.mjs'

const [tool, ...args] = process.argv.slice(2)

const alive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

const listing = () => {
  if (process.platform !== 'win32') return execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', maxBuffer: 64 << 20 })
  const { file, args, env } = windowsPowerShell('Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }')
  return execFileSync(file, args, { env, encoding: 'utf8', windowsHide: true, timeout: 20_000 })
}

function ancestors() {
  const found = [process.ppid]
  let parents = new Map()
  try {
    parents = new Map(listing().split('\n').flatMap(line => {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
      return match ? [[Number(match[1]), Number(match[2])]] : []
    }))
  } catch {}
  for (let pid = parents.get(process.ppid); pid > 0 && !found.includes(pid); pid = parents.get(pid)) found.push(pid)
  process.stdout.write(found.map(pid => pid + '\n').join(''))
}

async function grep(flags, source, files) {
  const pattern = new RegExp(source.replaceAll('[[:space:]]', '\\s').replaceAll('[[:digit:]]', '\\d'), flags.includes('i') ? 'gi' : 'g')
  let count = 0
  let out = ''
  for (const file of files) {
    const input = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
    // A file that cannot be read has no matching lines, and the exit code says so.
    try {
      for await (const line of input) {
        const found = [...line.matchAll(pattern)]
        if (!found.length) continue
        count += 1
        if (flags.includes('q')) process.exit(0)
        if (flags.includes('o')) out += found.map(match => match[0] + '\n').join('')
        else if (!flags.includes('c')) out += line + '\n'
      }
    } catch {}
  }
  process.stdout.write(flags.includes('c') ? count + '\n' : out)
  // process.exit would cut a pipe write still pending, which on macOS is anything past the pipe buffer.
  process.exitCode = count ? 0 : 1
}

const expand = dir => {
  const named = dir.replace(/^\{(\w+):([^}]*)\}/, (_, name, fallback) => process.env[name] || fallback)
  return named === '~' || named.startsWith('~/') ? homedir() + named.slice(1) : named
}

function find(dir, glob) {
  const pattern = new RegExp('^' + glob.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
  const walk = folder => {
    let entries
    try { entries = readdirSync(folder, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (pattern.test(entry.name)) process.stdout.write(path + '\n')
    }
  }
  walk(dir)
}

const takes = (box, id) => readdirSync(box).flatMap(name => {
  const take = takeOf(name)
  return take?.id === id ? [take.g] : []
}).sort((a, b) => a - b)

// Windows renames by handle (MoveFileExW opens FROM, then renames what it opened), so two renames that both opened
// FROM both succeed.
function claim(from, to) {
  const box = dirname(from)
  const { id } = claimOf(basename(to))
  const top = takes(box, id).at(-1) ?? 0
  const holder = top ? readJson(join(box, takeName(id, top))) : undefined
  if (top && (holder === undefined || alive(holder.pid))) return 3
  const take = join(box, takeName(id, top + 1))
  if (!claimFile(take, JSON.stringify({ pid: process.pid }))) return 3
  try {
    renameSync(from, to)
    return 0
  } catch (error) {
    if (error.code === 'ENOENT') return 3
    throw error
  } finally {
    rmSync(take, { force: true })
  }
}

function delivered(claimPath) {
  rmSync(claimPath, { force: true })
  const box = dirname(claimPath)
  const { id } = claimOf(basename(claimPath))
  for (const g of takes(box, id)) rmSync(join(box, takeName(id, g)), { force: true })
}

function exec(name, rest) {
  const started = command(name, rest)
  const child = spawn(started.file, started.args, { ...started.options, stdio: 'inherit', windowsHide: true })
  child.on('error', error => {
    process.stderr.write(`seat-io exec: ${error.message}\n`)
    process.exit(127)
  })
  child.on('exit', code => process.exit(code ?? 1))
}

try {
  if (tool === 'pwd') process.stdout.write(process.cwd() + '\n')
  else if (tool === 'head') process.stdout.write(lines(args[2], Number(args[1]), false))
  else if (tool === 'tail') process.stdout.write(lines(args[2], Number(args[1]), true))
  else if (tool === 'grep') await grep(args[0], args[1], args.slice(2))
  else if (tool === 'find') find(expand(args[0]), args[2])
  else if (tool === 'exec') exec(args[0], args.slice(1))
  else if (tool === 'alive') process.exit(alive(Number(args[0])) ? 0 : 1)
  else if (tool === 'ancestors') ancestors()
  else if (tool === 'claim') process.exitCode = claim(args[0], args[1])
  else if (tool === 'delivered') delivered(args[0])
  else throw new Error('unknown tool')
} catch (error) {
  process.stderr.write(`seat-io ${tool}: ${error.message}\n`)
  process.exit(tool === 'exec' ? 127 : tool === 'grep' ? 2 : 1)
}
