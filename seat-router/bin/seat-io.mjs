#!/usr/bin/env node
// The few POSIX tools the mod probes seat files with, written once for every
// platform and taking the flags the mod passes: `pwd`, `mktemp -d TEMPLATE`
// (creates its parent, prints the resolved path), `mkdir DIR`, `head -n N FILE`, `tail -n N FILE`,
// `grep -[Eicoq] PATTERN FILE...` (POSIX classes read as JS), `find DIR -name
// GLOB`, `exec NAME ARG...`, which starts a CLI as command.mjs resolves it,
// `alive PID` (exit 0 while that process runs), and `kill PID`, which ends that
// process and everything it started.
// Files are read in bounded chunks or line by line, never whole.
import { execFileSync, spawn } from 'node:child_process'
import { closeSync, createReadStream, fstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { command } from './command.mjs'

const CHUNK = 64 * 1024
const [tool, ...args] = process.argv.slice(2)

// The first or last n lines, read a chunk at a time from that end.
function lines(path, n, fromEnd) {
  const fd = openSync(path, 'r')
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

async function grep(flags, source, files) {
  const pattern = new RegExp(source.replaceAll('[[:space:]]', '\\s').replaceAll('[[:digit:]]', '\\d'), flags.includes('i') ? 'gi' : 'g')
  let count = 0
  let out = ''
  for (const file of files) {
    const input = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
    try {
      for await (const line of input) {
        const found = [...line.matchAll(pattern)]
        if (!found.length) continue
        count += 1
        if (flags.includes('q')) process.exit(0)
        if (flags.includes('o')) out += found.map(match => match[0] + '\n').join('')
      }
    } catch {}
  }
  process.stdout.write(flags.includes('c') ? count + '\n' : out)
  process.exit(count ? 0 : 1)
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

function exec(name, rest) {
  const started = command(name, rest)
  const child = spawn(started.file, started.args, { ...started.options, stdio: 'inherit', windowsHide: true })
  child.on('error', error => {
    process.stderr.write(`seat-io exec: ${error.message}\n`)
    process.exit(127)
  })
  child.on('exit', code => process.exit(code ?? 1))
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

// run-seat starts detached, so on POSIX its pid names the group of everything it started.
function kill(pid) {
  if (process.platform === 'win32') return execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' })
  try { process.kill(-pid, 'SIGKILL') } catch { process.kill(pid, 'SIGKILL') }
}

try {
  if (tool === 'pwd') process.stdout.write(process.cwd() + '\n')
  else if (tool === 'mktemp') {
    mkdirSync(dirname(args[1]), { recursive: true })
    process.stdout.write(realpathSync.native(mkdtempSync(args[1].replace(/X+$/, ''))) + '\n')
  }
  else if (tool === 'mkdir') mkdirSync(args[0])
  else if (tool === 'head') process.stdout.write(lines(args[2], Number(args[1]), false))
  else if (tool === 'tail') process.stdout.write(lines(args[2], Number(args[1]), true))
  else if (tool === 'grep') await grep(args[0], args[1], args.slice(2))
  else if (tool === 'find') find(args[0], args[2])
  else if (tool === 'exec') exec(args[0], args.slice(1))
  else if (tool === 'alive') process.exit(alive(Number(args[0])) ? 0 : 1)
  else if (tool === 'kill') kill(Number(args[0]))
  else throw new Error('unknown tool')
} catch (error) {
  process.stderr.write(`seat-io ${tool}: ${error.message}\n`)
  process.exit(tool === 'exec' ? 127 : tool === 'grep' ? 2 : 1)
}
