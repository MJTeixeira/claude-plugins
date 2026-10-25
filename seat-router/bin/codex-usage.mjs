#!/usr/bin/env node
// Prints codex's live rate limits as JSON, read through `codex app-server`
// (account/rateLimits/read), which starts no model turn. Exits 1 naming
// what failed.
import { spawn } from 'node:child_process'
import { command } from './command.mjs'

const started = command('codex', ['app-server'])
const server = spawn(started.file, started.args, { ...started.options, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
const send = message => server.stdin.write(JSON.stringify(message) + '\n')
const fail = reason => {
  console.error(`codex-usage: ${reason}`)
  server.kill()
  process.exit(1)
}

let buffer = ''
server.stdout.on('data', chunk => {
  buffer += chunk
  let end = buffer.indexOf('\n')
  for (; end >= 0; end = buffer.indexOf('\n')) {
    const message = JSON.parse(buffer.slice(0, end))
    buffer = buffer.slice(end + 1)
    if (message.id === 1) {
      send({ method: 'initialized' })
      send({ id: 2, method: 'account/rateLimits/read' })
    }
    if (message.id === 2) {
      if (!message.result) fail(JSON.stringify(message.error))
      const { primary, secondary, rateLimitReachedType, planType } = message.result.rateLimits
      console.log(JSON.stringify({
        plan: planType,
        allowed: message.result.ordinaryUsageAllowed,
        reached: rateLimitReachedType,
        five_hour: { utilization: primary.usedPercent, resets_at: primary.resetsAt },
        seven_day: { utilization: secondary.usedPercent, resets_at: secondary.resetsAt },
      }))
      server.kill()
      process.exit(0)
    }
  }
})
server.on('error', error => fail(error.message))
setTimeout(() => fail('no answer in 20 s'), 20_000)
send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codex-usage', version: '1' } } })
