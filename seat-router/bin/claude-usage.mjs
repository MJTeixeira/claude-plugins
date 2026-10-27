#!/usr/bin/env node
// Prints the plan usage of the Claude account CLAUDE_CONFIG_DIR names (the
// default account without it) as JSON, read without a model turn through Claude
// Code's get_usage control request (Experimental in 2.1.309):
// {"plan":"team","five_hour":{"utilization":12,"resets_at":"…" or null},"seven_day":{…}}
// Exits 1 naming what failed.
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { command } from './command.mjs'

const started = command('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'])
const p = spawn(started.file, started.args, { ...started.options, stdio: ['pipe', 'pipe', 'inherit'], cwd: tmpdir(), windowsHide: true })
const send = o => p.stdin.write(JSON.stringify(o) + '\n')
const fail = why => {
  console.error('claude-usage: ' + why)
  p.kill()
  process.exit(1)
}
// A window not yet started (nothing used in it) has no reset time: resets_at is null.
const pick = (name, w) => {
  if (typeof w?.utilization !== 'number' || (w.resets_at !== null && Number.isNaN(Date.parse(w.resets_at)))) fail('no ' + name + ' utilization/resets_at in get_usage')
  return { utilization: w.utilization, resets_at: w.resets_at }
}
p.on('error', e => fail(e.message))

let buf = ''
p.stdout.on('data', d => {
  buf += d
  for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
    const m = JSON.parse(buf.slice(0, i))
    buf = buf.slice(i + 1)
    if (m.type !== 'control_response') continue
    const r = m.response
    if (r.subtype !== 'success') fail(r.request_id + ': ' + r.error)
    if (r.request_id === 'init') send({ type: 'control_request', request_id: 'usage', request: { subtype: 'get_usage', skip_behaviors: true } })
    if (r.request_id === 'usage') {
      const u = r.response
      if (!u.rate_limits_available) fail('rate limits unavailable for this account\'s auth')
      console.log(JSON.stringify({
        plan: u.subscription_type,
        five_hour: pick('five_hour', u.rate_limits?.five_hour),
        seven_day: pick('seven_day', u.rate_limits?.seven_day),
      }))
      p.kill()
      process.exit(0)
    }
  }
})
send({ type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } })
setTimeout(() => fail('no get_usage answer in 60s'), 60000).unref()
p.on('exit', code => fail('claude exited ' + code + ' before answering get_usage'))
