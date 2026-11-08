import { POWERSHELL_51_NOTE, PYTHON_UTF8, asObject, candidateScopes, defined, familyOfModel, fileName, guarded, join, lastActionWith, numberAt, readJson, resetTime, textAt } from './shared.mjs'

// In -p mode agy keeps a run open while a background task (a long run_command, a schedule
// timer) runs and wakes the agent when it ends, so an answer given early is not the run's
// last act: a failed wake-up call ends the run in error after a complete answer. A subagent
// wakes its parent only by messaging it, so one that never reports leaves the run idle and
// agy ends it with whatever the parent last said.
const TASKS_NOTE = 'agy keeps the run open while a background task you started is still running, and wakes you when it ends. '
  + 'Before your final answer, wait for or stop (manage_task kill) every background task and schedule timer you started, so the final answer is the last thing you do. '
  + 'Any subagent you start must report back to you before your final answer.\n'
// agy can end a long -p run with UNAUTHENTICATED mid-turn (google-antigravity/antigravity-cli#1091);
// a new process signs in afresh, so the seat resumes its conversation there.
const UNAUTHENTICATED = /UNAUTHENTICATED \(code 401\)/
const RESUME = 'Your previous session ended unexpectedly: its sign-in expired, not because of anything you did. '
  + 'Any subagent or background task you had running ended with it; check what it left and start it again if you still need it. '
  + 'Then continue the task from where you stopped and give your final answer as the original request asked.'
// agy starts a detached updater that runs `agy --version`; on Windows that child has no
// console, so it opens a visible one for a moment.
const NO_UPDATER = { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }

// agy's Gemini models take only low, medium or high.
const effortOf = effort => ['low', 'medium', 'high'].includes(effort) ? effort : 'high'

// `agy --mode auto -p` prints "--mode auto is not available for this account", and agy's
// sandbox refuses the tools a seat needs (on Windows node cannot even stat %APPDATA%, so no
// npm-installed CLI starts), so every agy seat runs outside it behind the guard. An owner, and a
// reviewer with a worktree, get the operator's gh, keychain and MCP servers; that reviewer's guard
// fences off the `main` checkouts.
const plan = ({ seat, brief, os, main = [] }) => {
  const windows = os === 'windows'
  const home = join(seat.dir, 'home')
  const note = TASKS_NOTE + (windows ? POWERSHELL_51_NOTE : '')
  return {
    dirs: [],
    files: { 'brief.md': brief + '\n' + note },
    env: {},
    spec: {
      argv: [
        'agy', '--output-format', 'stream-json', '--model', seat.model, '--effort', effortOf(seat.effort),
        ...(seat.resumeConversation ? ['--conversation', seat.resumeConversation] : []),
        // The headless docs give -p a five-minute default where the reference and --help give none.
        '--dangerously-skip-permissions', '--print-timeout', '0', '-p', seat.resumeConversation ? RESUME : { file: join(seat.dir, 'brief.md') },
      ],
      cwd: seat.workDir, env: { ...(windows ? PYTHON_UTF8 : {}), ...NO_UPDATER },
      home: [...(guarded(seat) ? ['owner'] : []), '--home', home, '--own', seat.dir, ...main.flatMap(folder => ['--main', folder])],
      release: ['release', '--home', home, '--own', seat.dir, '--transcript', join(seat.dir, 'agy.jsonl'), '--keep', join(seat.dir, 'artifacts')],
      stdout: join(seat.dir, 'agy.jsonl'), stderr: join(seat.dir, 'agy.err'),
    },
  }
}

// agy reports a seat whose guard hook crashed as a success: every shell command failed
// with the hook's error, which shows only in the tool steps.
const GUARD_CRASH = /^JSON hook "jsonhook__seat-router-owner-guard_[^"]*" failed:/
const GUARD_CRASH_LINE = 'jsonhook__seat-router-owner-guard_[^ ]* failed:'
const TEXT_LINE = '"text_delta":'

// agy's result response joins the text of every agent_response step, so a seat that
// narrated while it worked would report the narration; its answer is the last step's text.
const resultOf = jsonl => {
  let last
  let guardCrashed = false
  let answerStep
  let answer
  let all = ''
  for (const line of jsonl.split('\n')) {
    const parsed = asObject(readJson(line))
    if (!parsed) continue
    last = parsed
    const step = asObject(parsed.step_update)
    const error = asObject(asObject(step?.tool_info)?.error)
    if (GUARD_CRASH.test(textAt(error?.message) ?? '')) guardCrashed = true
    const delta = step?.step_type === 'agent_response' ? textAt(step.text_delta) : undefined
    if (delta === undefined) continue
    if (answer === undefined || step?.step_index !== answerStep) answer = ''
    answerStep = step?.step_index
    answer += delta
    all += delta
  }
  if (last?.event !== 'result' && last?.type !== 'result') return { text: '', valid: false, error: '', denied: [], guardCrashed }
  const result = asObject(last?.result)
  // agy leaves denied_actions out when nothing was refused.
  const denied = result?.denied_actions
  const names = Array.isArray(denied) ? denied.map(action => textAt(asObject(action)?.action) ?? '?') : []
  const valid = result?.status === 'SUCCESS'
  const response = textAt(result?.response) ?? ''
  return { text: valid ? answer ?? response : response || all, valid, error: textAt(result?.error) ?? '', denied: names, guardCrashed }
}

// A failed agy -p run ends with `AGY_ERROR: {"status", "error_code", …}` on stderr and exit 3
// (agy changelog 1.2.6); a quota stop reads RESOURCE_EXHAUSTED, 429. Running out of AI credits
// gives only a message (agy changelog 1.2.15). A run is out of quota only when agy's own error
// says so: the agent's text and its commands' output can quote these words.
const CREDITS = /AI credits balance is too low/i
const isQuota = errors => {
  const line = errors.split('\n').filter(entry => entry.startsWith('AGY_ERROR: ')).at(-1)
  const error = line === undefined ? undefined : asObject(readJson(line.slice('AGY_ERROR: '.length)))
  return error?.status === 'RESOURCE_EXHAUSTED' || error?.error_code === 429 || CREDITS.test(errors)
}

export const failedAgy = (exitCode, jsonl, stderr) => {
  const result = resultOf(jsonl)
  // agy's last error is its word on the run: a 401 there is not a quota failure, whatever ran before it.
  const quota = isQuota(result.valid || UNAUTHENTICATED.test(result.error) ? '' : result.error + '\n' + stderr)
  const blank = !result.text.trim()
  const baseDetail = quota ? 'usage limit reached' : exitCode !== 0 ? 'exit ' + String(exitCode) : blank ? 'empty final text' : ''
  const failed = exitCode !== 0 || blank || !result.valid || result.guardCrashed
  const refused = result.denied.length ? 'agy refused ' + result.denied.join(', ') : ''
  const error = result.valid ? '' : result.error.replace(/\s+/g, ' ').trim()
  const reason = baseDetail || (result.guardCrashed ? 'owner guard could not run' : !result.valid && !error ? 'agy result failed' : '')
  const detail = quota ? baseDetail : [reason, error ? 'agy\'s error: ' + error : '', refused].filter(Boolean).join(', ')
  const text = !result.valid && result.text.trim()
    ? 'agy\'s error: ' + (error || '(none given)') + '\nThe text the seat produced before agy\'s error:\n\n' + result.text
    : [refused, result.text].filter(Boolean).join('\n\n')
  return { text, failed, quota, detail, ...(result.denied.length ? { refused: result.denied } : {}) }
}

const judge = async (view, dir, exitCode) => {
  const transcript = join(dir, 'agy.jsonl')
  // agy.err ends each error with its message (`error: …`) and then its `AGY_ERROR: {"status", "error_code", …}` line.
  const lastError = (await view.grep('^(AGY_ERROR|error):', join(dir, 'agy.err'))).trim().split('\n').slice(-2).join('\n')
  const steps = await view.grep(GUARD_CRASH_LINE + '|' + TEXT_LINE, transcript)
  return failedAgy(exitCode, steps + await view.tail(transcript, 1), lastError)
}

export const agyTokens = text => {
  let event
  let total = 0
  let result
  for (const match of text.matchAll(/"event"\s*:\s*"(step_update|result)"|"total_tokens"\s*:\s*(\d+)/g)) {
    if (match[1]) event = match[1]
    if (match[2] && event === 'step_update') total += Number(match[2])
    if (match[2] && event === 'result') result = Number(match[2])
  }
  return result ?? (total || undefined)
}

const liveTokens = async (view, dir) => ({
  tokens: agyTokens(await view.grepParts('"event"[[:space:]]*:[[:space:]]*"(step_update|result)"|"total_tokens"[[:space:]]*:[[:space:]]*[0-9]+', join(dir, 'agy.jsonl'))),
})

const actionOf = event => {
  const step = asObject(event.step_update)
  const name = textAt(step?.tool_name)
  if (step?.step_type !== 'tool' || !name) return undefined
  const parameters = asObject(asObject(step.tool_info)?.parameters) ?? {}
  const command = textAt(parameters.CommandLine)
  if (command) return 'Ran ' + command
  const path = textAt(parameters.Path) ?? textAt(parameters.AbsolutePath) ?? textAt(parameters.TargetFile)
  return name.replace(/_/g, ' ') + (path ? ' ' + fileName(path) : '')
}

const conversationOf = jsonl => {
  const event = asObject(readJson(jsonl))
  return event?.event === 'init' ? textAt(event.conversation_id) : undefined
}

// agy documents no /usage JSON; its buckets carry the status line's quota fields
// (https://antigravity.google/docs/cli/statusline/), and each group's description names
// its models: Gemini's buckets serve Gemini, 3p's Claude and GPT-OSS, Argon's Argon alone.
const BUCKETS = [
  { prefix: 'gemini-argon-', scope: 'agy/argon', models: ['argon'] },
  { prefix: 'gemini-', scope: 'agy/gemini', models: ['gemini'] },
  { prefix: '3p-', scope: 'agy/3p', models: ['claude', 'gpt'] },
]
const MINUTES = { '5h': 300, weekly: 10080 }

const usage = payload => {
  const groups = asObject(asObject(asObject(payload)?.command)?.data)?.groups
  if (!Array.isArray(groups)) return undefined
  const buckets = groups.flatMap(group => {
    const items = asObject(group)?.buckets
    return Array.isArray(items) ? items.map(asObject).filter(defined) : []
  })
  const windows = buckets.flatMap(bucket => {
    const id = textAt(bucket.id) ?? ''
    const kind = BUCKETS.find(entry => id.startsWith(entry.prefix))
    const remaining = numberAt(bucket.remaining_fraction)
    if (bucket.disabled === true || kind === undefined || remaining === undefined) return []
    const span = textAt(bucket.window) ?? id.slice(id.lastIndexOf('-') + 1)
    const minutes = MINUTES[span]
    const resetAt = resetTime(bucket.reset_time)
    return [{
      scope: kind.scope, id, used: (1 - remaining) * 100,
      ...(minutes === undefined ? {} : { minutes }), ...(resetAt === undefined ? {} : { resetAt }),
    }]
  })
  // Argon draws on its own bucket where agy lists one, and on Gemini's elsewhere.
  const argon = windows.some(window => window.scope === 'agy/argon') ? []
    : windows.filter(window => window.scope === 'agy/gemini').map(window => ({ ...window, scope: 'agy/argon' }))
  return { windows: [...windows, ...argon] }
}

// Of the buckets whose model fragments a model's name holds, the one whose fragment ends latest applies:
// gemini-4-argon-high is Argon's, not Gemini's.
const scopesOf = candidate => {
  const name = candidate.model.toLowerCase()
  const reach = bucket => Math.max(-1, ...bucket.models.map(fragment => {
    const at = name.indexOf(fragment)
    return at < 0 ? -1 : at + fragment.length
  }))
  const best = BUCKETS.reduce((found, bucket) => reach(bucket) > (found ? reach(found) : -1) ? bucket : found, undefined)
  return best ? [best.scope] : []
}

/** `agy models` lines are `<model>-<effort>\t<name>`: one model per base, with its efforts. */
export const parseAgyModels = text => {
  const models = []
  for (const line of text.split('\n')) {
    const id = line.split('\t')[0]?.trim() ?? ''
    const match = /^(.+)-(low|medium|high|xhigh|max)$/.exec(id)
    if (!match?.[1] || !match[2]) continue
    const found = models.find(entry => entry.model === match[1])
    if (found) found.efforts.push(match[2])
    else models.push({ model: match[1], efforts: [match[2]] })
  }
  return models
}

/** @type {import('./index.mjs').VendorAdapter} */
export const agy = {
  id: 'agy',
  explicitForm: true,
  transcript: 'agy.jsonl',
  // agy streams ACTIVE then DONE (or ERROR) for the same step.
  stepPattern: '"state":"(DONE|ERROR)","step_type":"tool"',
  familyOf: candidate => familyOfModel(candidate.model),
  capabilities: candidate => familyOfModel(candidate.model) === 'gemini' ? ['image-generation'] : [],
  scopesOf,
  bandScopes: () => ['agy/gemini'],
  exhaustedScopes: candidateScopes,
  version: ['agy', '--version'],
  execEnv: NO_UPDATER,
  models: { run: { exec: ['agy', 'models'] }, parse: parseAgyModels },
  usage: { run: { exec: ['agy', '-p', '/usage', '--output-format', 'json'] }, parse: stdout => usage(readJson(stdout)) },
  resume: {
    budget: 3,
    note: 'sign-in expired mid-run, resumed',
    when: checked => UNAUTHENTICATED.test(checked.detail),
    conversation: async (view, dir) => conversationOf(await view.head(join(dir, 'agy.jsonl'))),
  },
  plan,
  judge,
  liveTokens,
  lastAction: lastActionWith(actionOf),
}
