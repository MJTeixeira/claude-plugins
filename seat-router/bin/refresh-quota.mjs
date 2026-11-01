#!/usr/bin/env node
// Reads the vendors' quota for the wants ledger.due names and writes it, with a failure record for each read that
// failed, to <home>/quota/active.json. At most one runs on a machine at a time: it holds the lease quota/active.lock
// (claimLock in io-node.mjs) and writes only while it still holds it.
// Usage: node refresh-quota.mjs HOME < {"wants": [{ key, vendor, scopes, optional, dir?, accountKey? }]}
import { execFile } from 'node:child_process'
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { command } from './command.mjs'
import { LEDGER_SCHEMA, due, expiresAt, validFile } from './core/ledger.mjs'
import { claimLock, pruneGenerations, quotaFiles, readJson, writeAtomic } from './io-node.mjs'
import { ADAPTERS, readingsOf } from './vendors/index.mjs'

const READ_MS = 60_000
const EXPIRED_GRACE_MS = 24 * 60 * 60 * 1000

const home = process.argv[2]
const bin = dirname(fileURLToPath(import.meta.url))
const { wants } = JSON.parse(readFileSync(0, 'utf8'))
const quota = join(home, 'quota')
const lease = await claimLock(quota, 'active.lock')
if (!lease) process.exit(0)
pruneGenerations(join(quota, 'active.lock'), lease.generation)

const run = (argv, env) => new Promise(resolve => {
  let started
  try { started = command(argv[0], argv.slice(1), env) } catch (error) { return resolve({ code: 127, stdout: '', stderr: error.message }) }
  execFile(started.file, started.args, { ...started.options, env, timeout: READ_MS, windowsHide: true, maxBuffer: 16 << 20 }, (error, stdout, stderr) =>
    resolve({ code: error ? typeof error.code === 'number' ? error.code : 1 : 0, stdout, stderr: stderr || error?.message || '' }))
})

const read = async want => {
  const adapter = ADAPTERS[want.vendor]
  const account = want.dir !== undefined && want.vendor === 'claude'
  const env = { ...process.env, ...adapter.execEnv, ...(account ? ADAPTERS.claude.account.env(want.dir) : {}) }
  const args = account ? ADAPTERS.claude.account.args : []
  const usageRun = adapter.usage.run
  const argv = 'script' in usageRun ? [process.execPath, join(bin, usageRun.script), ...args] : [...usageRun.exec, ...args]
  const done = await run(argv, env)
  const usage = done.code === 0 ? adapter.usage.parse(done.stdout, want.accountKey) : undefined
  if (!usage) return { failure: (done.stderr.trim().split('\n').pop() || 'exited ' + done.code) }
  return { readings: readingsOf(usage, Date.now(), want.scopes[0]) }
}

const now = Date.now()
const files = quotaFiles(home)
const kept = validFile(readJson(join(quota, 'active.json')), now)
const active = kept ?? { schema: LEDGER_SCHEMA, writer: 'active', at: now, readings: [], exhaustions: [] }
let readings = active.readings
let failures = active.failures ?? []
const reads = { ...active.reads }
for (const want of due(wants, files, now)) {
  if (!(want.vendor in ADAPTERS)) continue
  const found = await read(want)
  reads[want.key] = Date.now()
  failures = failures.filter(failure => failure.vendor !== want.key)
  if (found.failure) failures.push({ vendor: want.key, at: Date.now(), detail: found.failure })
  else {
    const named = new Set(found.readings.map(reading => reading.scope))
    readings = [...readings.filter(reading => !named.has(reading.scope)), ...found.readings]
  }
}
if (!lease.mine()) process.exit(0)
writeAtomic(join(quota, 'active.json'), JSON.stringify({ schema: LEDGER_SCHEMA, writer: 'active', at: Date.now(), readings, exhaustions: [], failures, reads }))

for (const name of readdirSync(quota).filter(entry => entry.endsWith('.json') && entry !== 'active.json')) {
  const path = join(quota, name)
  if (lease.mine() && expiresAt(readJson(path), now) + EXPIRED_GRACE_MS < now) rmSync(path, { force: true })
}
lease.close()
