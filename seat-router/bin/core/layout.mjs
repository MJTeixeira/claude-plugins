// Where seat-router keeps its seats, from the environment alone. Imported by the hooks and by the supervisor, so it
// imports nothing from node: (bin/structure.test.mjs). Paths join with `/`, which Node and the CLIs take on Windows too.

const ASCII = /^[\x20-\x7e]*$/

export const fnv = text => {
  let hash = 0x811c9dc5
  for (const unit of text) {
    hash ^= unit.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

const slashed = path => path.replaceAll('\\', '/').replace(/\/+$/, '')

/**
 * The seat-router home: SEAT_ROUTER_HOME when set; ~/.seat-router on macOS and Linux; %LOCALAPPDATA%\seat-router on
 * Windows. codex's Windows sandbox cannot make a folder with a non-ASCII path writable, so a profile with one moves the
 * home to a per-user leaf under %PUBLIC%\seat-router, which accept.mjs locks to the user's SID before writing in it.
 * @param {(name: string) => string|undefined} env
 * @returns {{ home: string, shared: boolean } | undefined}  undefined when the environment names no home folder
 */
export const homeOf = env => {
  const set = env('SEAT_ROUTER_HOME')
  if (set) return { home: slashed(set), shared: false }
  if (env('OS') !== 'Windows_NT') {
    const home = env('HOME')
    return home ? { home: slashed(home) + '/.seat-router', shared: false } : undefined
  }
  const local = env('LOCALAPPDATA')
  if (local && [local, env('USERPROFILE') ?? ''].every(path => ASCII.test(path))) return { home: slashed(local) + '/seat-router', shared: false }
  const shared = env('PUBLIC')
  if (!shared) return local ? { home: slashed(local) + '/seat-router', shared: false } : undefined
  return { home: slashed(shared) + '/seat-router/u-' + fnv((env('USERDOMAIN') ?? '') + '\\' + (env('USERNAME') ?? '')), shared: true }
}

export const seatDir = (home, id) => home + '/seats/' + id
export const liveFile = (home, id) => home + '/live/' + id + '.json'
export const mailDir = (home, sessionId) => home + '/mail/' + sessionId
export const deliveryFile = (home, id) => home + '/deliveries/' + id + '.json'
export const outcomeFile = (home, id) => home + '/outcomes/' + id + '.json'
export const lineageFile = (home, sessionId) => home + '/lineage/' + sessionId + '.json'
export const isSeatId = id => /^seat-[A-Za-z0-9]{6,}$/.test(id)

export const claimName = (id, claimedBy, pid) => id + '.' + claimedBy + '.' + pid

/** @returns {{ id: string, claimedBy: string, pid: string } | undefined} */
export const claimOf = name => {
  const match = /^(seat-[A-Za-z0-9]{6,})\.([^.]+)\.(\d+)$/.exec(name)
  return match ? { id: String(match[1]), claimedBy: String(match[2]), pid: String(match[3]) } : undefined
}

export const takeName = (id, g) => id + '~' + g

/** @returns {{ id: string, g: number } | undefined} */
export const takeOf = name => {
  const match = /^(seat-[A-Za-z0-9]{6,})~(\d+)$/.exec(name)
  return match ? { id: String(match[1]), g: Number(match[2]) } : undefined
}
