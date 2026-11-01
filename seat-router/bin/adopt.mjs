#!/usr/bin/env node
// Starts a supervisor again for every live seat on this machine whose supervisor is gone (a reboot, a crash, a killed
// process), from the seat's own runtime copy. A seat whose supervisor is still starting may get a second one; the
// seat's fenced lock lets one of them run. Removes a live entry whose seat folder is gone. Prints each seat it adopted.
// The seat folder is the home's own for the entry's id, never a path the entry names, and on Windows it runs only from
// folders the user, SYSTEM or Administrators own.
// Usage: node adopt.mjs HOME
import { spawn } from 'node:child_process'
import { readdirSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isSeatId, seatDir } from './core/layout.mjs'
import { exists, notTheUsers, readJson, supervised } from './io-node.mjs'

const home = process.argv[2]
const names = exists(join(home, 'live')) ? readdirSync(join(home, 'live')).filter(name => name.endsWith('.json')) : []
for (const name of names) {
  const id = name.slice(0, -'.json'.length)
  const entry = readJson(join(home, 'live', name))
  const folder = seatDir(home, id)
  // accept.mjs writes seat.json before the live entry, so an entry without it outlived its folder.
  if (!isSeatId(id) || !exists(join(folder, 'seat.json'))) {
    if (entry) rmSync(join(home, 'live', name), { force: true })
    continue
  }
  // accept.mjs runs a seat from its folder's real path, which agy's sandbox checks writes against.
  const dir = realpathSync.native(folder).replaceAll('\\', '/')
  if (notTheUsers([home, join(home, 'seats'), dir, join(dir, 'runtime')]) !== undefined) continue
  if (await supervised(dir)) continue
  spawn(process.execPath, [join(dir, 'runtime', 'supervise.mjs'), dir], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  process.stdout.write(id + '\n')
}
