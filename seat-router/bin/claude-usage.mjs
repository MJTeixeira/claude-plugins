#!/usr/bin/env node
// Prints the plan usage of the Claude account CLAUDE_CONFIG_DIR names (the
// default account without it) as JSON, read without a model turn: `/usage` sent
// as a prompt answers with a usage_report (Agent SDK reference, SDKUsageReport),
// --safe-mode keeps every plugin, hook and MCP server out of that session, and
// --no-session-persistence leaves no transcript of it.
// {"plan":"max","windows":[{"name":"5h","minutes":300,"used":4,"resetAt":<epoch ms>},
//   {"name":"Fable 7d","models":["fable"],"minutes":10080,"used":2,"resetAt":…}]}
// A window without `models` applies to every model. `--account` reads another account,
// on its login alone. Exits 1 naming what failed.
import { execFile, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { withoutClaudeAuth } from './claude-auth.mjs'
import { command } from './command.mjs'

const env = process.argv.includes('--account') ? withoutClaudeAuth(process.env) : process.env

const children = []
const fail = why => {
  console.error(`claude-usage: ${why}`)
  for (const child of children) child.kill()
  process.exit(1)
}

const plan = new Promise(resolve => {
  const started = command('claude', ['auth', 'status', '--json'])
  children.push(execFile(started.file, started.args, { ...started.options, cwd: tmpdir(), env, windowsHide: true, timeout: 30_000 }, (error, stdout) => {
    try { resolve(error ? undefined : JSON.parse(stdout).subscriptionType ?? undefined) } catch { resolve(undefined) }
  }))
})

const minutesOf = row => row.kind === 'session' || row.group === 'session' ? 300
  : row.kind.startsWith('weekly') || row.group === 'weekly' ? 10080 : undefined

const windowOf = row => {
  if (typeof row?.kind !== 'string' || typeof row.percent !== 'number') fail('a usage_report row has no kind or percent')
  const minutes = minutesOf(row)
  const model = row.scope?.model?.display_name
  // A window not yet started (nothing used in it) has no reset time: resets_at is null.
  const resetAt = row.resets_at === null || row.resets_at === undefined ? undefined : Date.parse(row.resets_at)
  return {
    name: [model, minutes === 300 ? '5h' : minutes === 10080 ? '7d' : row.kind].filter(Boolean).join(' '),
    ...(model ? { models: [model.toLowerCase()] } : {}),
    ...(minutes === undefined ? {} : { minutes }),
    used: row.percent,
    ...(resetAt === undefined || Number.isNaN(resetAt) ? {} : { resetAt }),
  }
}

const started = command('claude', ['-p', '--safe-mode', '--no-session-persistence', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'])
const child = spawn(started.file, started.args, { ...started.options, stdio: ['pipe', 'pipe', 'inherit'], cwd: tmpdir(), env, windowsHide: true })
children.push(child)
child.on('error', error => fail(error.message))
let buffer = ''
let report
child.stdout.on('data', chunk => {
  buffer += chunk
  for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
    const line = buffer.slice(0, end)
    buffer = buffer.slice(end + 1)
    let message
    // A line that is not an event (a notice the CLI prints) carries no report.
    try { message = JSON.parse(line) } catch { continue }
    if (message?.type === 'assistant' && message.usage_report) report = message.usage_report
  }
})
child.on('close', async code => {
  // Claude Code attaches usage_report only for a claude.ai login with a known plan, off usage-based billing.
  const limits = report?.rate_limits?.limits
  if (!Array.isArray(limits)) fail(report ? 'usage_report has no rate limits' : `no usage_report (claude exited ${code})`)
  const subscription = await plan
  // A row scoped to a surface rather than a model is left out: nothing names the surface a seat draws on.
  const windows = limits.filter(row => !row?.scope?.surface).map(windowOf)
  console.log(JSON.stringify({ ...(subscription ? { plan: subscription } : {}), windows }))
  process.exit(0)
})
child.stdin.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content: '/usage' } })}\n`)
// Inside the mod's 60 s timeout, so this script, not the mod, ends the claude it started.
setTimeout(() => fail('no usage_report in 50s'), 50_000).unref()
