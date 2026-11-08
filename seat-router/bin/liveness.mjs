import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { linkSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'

const WIN = process.platform === 'win32'
const ANSWER_MS = 1_000
const CONNECT_MS = 1_000
const QUERY_MS = 10_000
// A launcher checks for a due kill this often, then gives its CLI this long to end on SIGINT.
export const LAUNCHER_CHECK_MS = 2_000
export const LAUNCHER_GRACE_MS = 10_000

/** The longest socket path the OS binds, in bytes without the terminating NUL. */
export const SOCKET_PATH_MAX = process.platform === 'darwin' ? 103 : 107
export const MAX_ATTEMPT = 99
// The supervisor binds an attempt's endpoint at this name and renames it to `ep`: closing its own copy unlinks the name it bound.
const BOUND = 'ep~'

export const socketPaths = seatDir => [join(seatDir, 'attempt-' + MAX_ATTEMPT, BOUND), join(seatDir, 'lock', 'x'.repeat(8))]

const checkLength = path => {
  if (!WIN && Buffer.byteLength(path) > SOCKET_PATH_MAX) throw new Error(path + ' is longer than the ' + SOCKET_PATH_MAX + ' bytes a socket path may have here')
}

const listen = (server, target) => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(target, () => {
    server.off('error', reject)
    resolve(server)
  })
})

export const pipeName = () => '\\\\.\\pipe\\seat-router-' + randomBytes(8).toString('hex')

export const holdEndpoint = async lockDir => {
  const path = WIN ? pipeName() : join(lockDir, 's' + randomBytes(4).toString('hex').slice(1))
  checkLength(path)
  const server = net.createServer(socket => socket.destroy())
  await listen(server, path)
  return { server, path }
}

/**
 * One connect to an endpoint, closed at once: `alive` when it completes, `dead` when it is refused or the name is
 * gone, `unknown` on a timeout or any other error. A full accept queue reads `dead`; a caller acts on it only where a
 * false dead costs work, never a second CLI.
 */
export const probe = path => new Promise(resolve => {
  if (typeof path !== 'string') return resolve('unknown')
  const socket = net.connect({ path })
  const done = state => {
    clearTimeout(timer)
    socket.destroy()
    resolve(state)
  }
  const timer = setTimeout(() => done('unknown'), CONNECT_MS)
  socket.on('connect', () => done('alive'))
  socket.on('error', /** @param {NodeJS.ErrnoException} error */ error => done(error.code === 'ECONNREFUSED' || error.code === 'ENOENT' ? 'dead' : 'unknown'))
})

export const group = pgid => {
  try {
    process.kill(-pgid, 0)
    return 'member'
  } catch (error) {
    return error.code === 'EPERM' ? 'member' : error.code === 'ESRCH' ? 'empty' : 'unknown'
  }
}

export const claimFile = (path, text) => {
  const temp = path + '.' + process.pid + '.' + randomBytes(3).toString('hex')
  writeFileSync(temp, text)
  try {
    linkSync(temp, path)
    return true
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  } finally {
    rmSync(temp, { force: true })
  }
}

export const startLauncher = async (attemptDir, launcher, { env, log }) => {
  let server
  if (!WIN) {
    const bound = join(attemptDir, BOUND)
    checkLength(bound)
    rmSync(bound, { force: true })
    server = await listen(net.createServer(socket => socket.destroy()), bound)
    renameSync(bound, join(attemptDir, 'ep'))
  }
  const child = spawn(process.execPath, [launcher, attemptDir], {
    detached: true, env, windowsHide: true, stdio: ['ignore', log, log, ...(server ? [/** @type {any} */ (server)._handle.fd] : [])],
  })
  server?.close()
  child.unref()
  return child
}

export const reader = path => {
  let socket
  let seq = 0
  let buffer = ''
  const waiting = new Map()
  const connect = () => new Promise(resolve => {
    const next = net.connect({ path })
    const timer = setTimeout(() => {
      next.destroy()
      resolve('unknown')
    }, CONNECT_MS)
    next.on('connect', () => {
      clearTimeout(timer)
      socket = next
      resolve('connected')
    })
    next.on('data', chunk => {
      const lines = (buffer + chunk).split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        let reply
        try { reply = JSON.parse(line) } catch { continue }
        waiting.get(reply.seq)?.(reply)
      }
    })
    next.on('close', () => {
      if (socket === next) socket = undefined
      buffer = ''
    })
    next.on('error', /** @param {NodeJS.ErrnoException} error */ error => {
      clearTimeout(timer)
      resolve(error.code === 'ECONNREFUSED' ? 'refused' : error.code === 'ENOENT' ? 'missing' : 'unknown')
    })
  })
  const ask = extra => new Promise(resolve => {
    const n = ++seq
    const timer = setTimeout(() => {
      waiting.delete(n)
      resolve(undefined)
    }, ANSWER_MS)
    waiting.set(n, reply => {
      clearTimeout(timer)
      waiting.delete(n)
      resolve(reply)
    })
    socket.write(JSON.stringify({ ask: n, ...extra }) + '\n')
  })
  // The connection the last read heard answer or stay silent on: while it is open, only the launcher can be holding it.
  let proof
  return {
    /** @returns {Promise<{ endpoint: 'answered', reply: any } | { endpoint: 'silent'|'refused'|'missing'|'unknown' }>} */
    read: async (extra = {}) => {
      proof = undefined
      if (typeof path !== 'string') return { endpoint: 'missing' }
      if (!socket || socket.destroyed) {
        const connected = await connect()
        if (connected !== 'connected') return { endpoint: connected }
      }
      const held = socket
      const reply = await ask(extra)
      if (held !== socket) return { endpoint: 'unknown' }
      proof = held
      return reply ? { endpoint: 'answered', reply } : { endpoint: 'silent' }
    },
    /**
     * Runs `send`, a signal to the launcher's process group or its CLI, only on the proof of a read since the last
     * signal: the connection that read heard answer or stay silent on is still open, so the launcher still holds the
     * endpoint and the pids it recorded are its own. Returns whether it sent.
     * @param {() => unknown} send
     */
    signal: async send => {
      const proven = proof !== undefined && proof === socket && !proof.destroyed
      proof = undefined
      if (!proven) return false
      await send()
      return true
    },
    open: () => socket !== undefined && !socket.destroyed,
    close: () => socket?.destroy(),
  }
}

/**
 * The processes outside process group `pgid` descended from `cli` or from any member of the group (a tool command a CLI
 * runs in a session of its own), from one listing of the machine's processes; `unlisted` when it could not be read.
 * @returns {Promise<{ pid: number, command: string }[] | 'unlisted'>}
 */
const outsideGroup = (cli, pgid) => new Promise(resolve => {
  execFile('ps', ['-A', '-o', 'pid=,ppid=,pgid=,command='], { timeout: QUERY_MS, maxBuffer: 64 << 20 }, (error, stdout) => {
    if (error) return resolve('unlisted')
    const rows = stdout.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(match => match !== null)
      .map(match => ({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4].slice(0, 80) }))
    const found = new Map()
    for (let parents = new Set([cli, ...rows.filter(row => row.pgid === pgid).map(row => row.pid)]); parents.size;) {
      const children = rows.filter(row => parents.has(row.ppid) && !found.has(row.pid))
      for (const row of children) found.set(row.pid, row)
      parents = new Set(children.map(row => row.pid))
    }
    resolve([...found.values()].filter(row => row.pgid !== pgid).map(row => ({ pid: row.pid, command: row.command })))
  })
})

/**
 * Records in the attempt's `outside` file, one JSON line each, every process outside the CLI's process group that a
 * listing finds descended from it, so that what survives the group's end is known after the CLI and its records are
 * gone. A listing that fails records `unlisted` when it is the last one before the group ends (`last`).
 * @param {string} folder
 * @param {(path: string, text: string) => void} append
 */
export const outsideRecorder = (folder, append) => {
  const seen = new Set()
  return async (cli, pgid, last) => {
    const found = await outsideGroup(cli, pgid)
    if (found === 'unlisted') {
      if (last) append(join(folder, 'outside'), JSON.stringify({ unlisted: true }) + '\n')
      return
    }
    const fresh = found.filter(row => !seen.has(row.pid))
    for (const row of fresh) seen.add(row.pid)
    if (fresh.length) append(join(folder, 'outside'), fresh.map(row => JSON.stringify(row) + '\n').join(''))
  }
}

/** `env` without the variables `names`, matched as Windows matches variable names, whatever their case. */
export const withoutVariables = (env, names) => {
  const dropped = new Set(names.map(name => name.toUpperCase()))
  return Object.fromEntries(Object.entries(env).filter(([name]) => !dropped.has(name.toUpperCase())))
}

/**
 * How to run `script` in Windows PowerShell 5.1: its file, arguments and environment. By full path, as a Windows PATH can
 * put another powershell.exe ahead of System32's. Without PSModulePath, which a PowerShell 7 parent hands down naming its
 * own modules: 5.1 then fails to autoload Get-Acl and the rest (CouldNotAutoloadMatchingModule), and without the variable
 * it builds its own.
 * @param {string} script
 */
export const windowsPowerShell = script => ({
  file: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  args: ['-NoProfile', '-NonInteractive', '-Command', script],
  env: withoutVariables(process.env, ['PSModulePath']),
})

const powershell = (script, timeout) => new Promise(resolve => {
  const { file, args, env } = windowsPowerShell(script)
  execFile(file, args, { env, timeout, windowsHide: true, encoding: 'utf8' }, (error, stdout) => resolve(error ? undefined : stdout.trim()))
})

/** When a Windows process started, as file-time ticks, `none` when no process has the pid, undefined when it could not be read in time. */
export const createdAt = async pid => {
  const out = await powershell('$p = Get-Process -Id ' + Number(pid) + ' -ErrorAction SilentlyContinue; if (-not $p) { "none" } else { $p.StartTime.ToFileTimeUtc() }', QUERY_MS)
  return out === undefined || out === '' ? undefined : out
}

/**
 * @param {{ pid?: number, created?: string } | undefined} record
 */
export const cliState = async record => {
  if (typeof record?.pid !== 'number') return 'gone'
  const now = await createdAt(record.pid)
  if (now === undefined) return 'unknown'
  if (now === 'none') return 'gone'
  return record.created === undefined || record.created === now ? 'running' : 'gone'
}

/** Ends a Windows process and every descendant it still has a parent link to. */
export const taskkillTree = pid => new Promise(resolve => {
  execFile(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/T', '/F', '/PID', String(pid)],
    { timeout: QUERY_MS, windowsHide: true }, () => resolve(undefined))
})
