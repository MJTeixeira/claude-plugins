import { POWERSHELL_51_NOTE, POWERSHELL_51_UNSET, PYTHON_UTF8, asObject, candidateScopes, durationName, familyOfModel, fileName, guarded, join, lastActionWith, numberAt, readJson, scriptUsage, textAt } from './shared.mjs'

// codex's unelevated Windows sandbox refuses a process node starts with piped stdio (EPERM,
// openai/codex#47868); one that inherits or ignores stdio starts, and so do
// PowerShell's and python's.
const WINDOWS_NOTE = 'On this machine node cannot read the output of a program it starts here (spawn EPERM), so npm '
  + 'scripts and node tools that capture git\'s or another program\'s output (depcruise, vitest\'s changed mode) fail. Run '
  + 'git and other programs from PowerShell or python, and say in your report what you could not run.\n'
// codex's mxc Windows sandbox resets TEMP and TMP to a folder of its own whose files a
// program cannot clean up (pip's ensurepip fails), whatever the launch sets; a folder
// the seat writes, set from its own shell, works.
const mxcNote = temp => {
  const quoted = "'" + temp.replaceAll("'", "''") + "'"
  return 'This sandbox gives programs a temp folder they cannot clean up, so pip, python\'s tempfile and other tools '
    + 'that make temp files fail there. Set TEMP and TMP in the same PowerShell command first, as in '
    + '`$env:TEMP=' + quoted + '; $env:TMP=' + quoted + '; python -m venv .venv`.\n'
}

// codex's mxc Windows sandbox starts on Windows 11 24H2 26100.9278 or 25H2 26200.9278 and
// later and holds a seat to its folder, as the unelevated one does, without that one's bugs
// (openai/codex#19791, #47868). Whether it starts here is asked off the Agent hook's clock, as
// starting codex can take seconds: each session start asks and the answer lands in the seat
// root, and a seat launched before the first answer runs the unelevated sandbox.
const PROBE = { script: 'codex-mxc.mjs', file: 'codex-sandbox' }

// codex's own prefix rules miss reworded commands (`git -C . reset --hard`) and any
// line its shell parser gives up on (`HEAD~1`), so an owner's commands pass this hook.
// On Windows codex runs the hook through PowerShell `-Command`, which reports a failed
// node as exit 1, so the guard answers with a deny decision rather than exit 2
// (openai/codex#48183).
// The hook comes from the command line, which codex runs only past its hook trust check. A worktree reviewer's hook also
// sees apply_patch, codex's file-edit tool, which reaches PreToolUse as `apply_patch` with the patch as tool_input.command
// (codex-rs/core/src/tools/handlers/apply_patch.rs, pre_tool_use_payload). codex's write_stdin, which sends text to a
// command exec_command started, reaches no PreToolUse (handlers/unified_exec/write_stdin.rs, pre_tool_use_payload), so a
// guarded seat runs without unified_exec_tty: a command then runs without a terminal, and write_stdin can only poll it or
// send Ctrl-C (unified_exec/process_manager.rs, StdinClosed).
const guardFlags = (guard, reviewer) => ['--dangerously-bypass-hook-trust', '-c', 'features.unified_exec_tty=false', '-c',
  'hooks.PreToolUse=[{matcher="' + (reviewer ? 'Bash|apply_patch' : 'Bash') + '",hooks=[{type="command",command=' + JSON.stringify(guard) + '}]}]']

// A codex or agy owner, and a reviewer with a worktree, reach the network, .git, Docker and
// the rest of the machine, as a Claude account owner does, and owner-guard.mjs is the fence:
// such a codex seat runs outside codex's sandbox (`danger-full-access`), since an
// auto-reviewed escalation waits on every commit and push. A reviewer without a worktree stays
// in the sandbox, writing only its folder, with the network on so a brief can have it fetch an
// issue or a page.
const plan = ({ seat, brief, os, guard, facts, main = [] }) => {
  const outside = guarded(seat)
  const windows = os === 'windows'
  const windowsReviewer = windows && !outside
  const mxc = windowsReviewer && facts.sandbox === 'mxc'
  const temp = join(seat.dir, 'tmp')
  const note = (mxc ? mxcNote(temp) : windowsReviewer ? WINDOWS_NOTE : '') + (windowsReviewer ? POWERSHELL_51_NOTE : '')
  return {
    dirs: mxc ? [temp] : [],
    files: { 'brief.md': brief + (note ? '\n' + note : '') },
    env: {},
    spec: {
      argv: [
        'codex', 'exec', '--json', '-m', seat.model, '-c', 'model_reasoning_effort=' + seat.effort,
        ...(outside ? ['-s', 'danger-full-access'] : ['-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true']),
        '--skip-git-repo-check', '-C', seat.workDir,
        // A reviewer is held to its folder: the user's config would start their MCP servers
        // (computer use among them), a user rule that allows a command runs it outside the sandbox
        // (--ignore-rules), and codex's apps, plugins and web search act from the
        // cloud. An owner keeps all of them, as a development session does.
        ...(outside ? [] : [
          '--ignore-user-config', '--ignore-rules', '--disable', 'apps', '--disable', 'plugins', '--disable', 'remote_plugin',
          '-c', 'web_search="disabled"',
          // Without a Windows sandbox mode codex refuses every command; the user's config
          // would have named one.
          ...(windows ? ['-c', 'windows.sandbox="' + (mxc ? 'mxc' : 'unelevated') + '"'] : []),
          ...(mxc ? ['--add-dir', temp] : []),
        ]),
        ...(outside ? ['-c', 'shell_environment_policy.ignore_default_excludes=true', ...guardFlags(guard, main.length > 0)] : []),
        // PowerShell 5.1 reads a UTF-8 profile as ANSI, so a profile naming a non-ASCII path
        // prints an error ahead of every command; a non-login shell runs with -NoProfile.
        ...(windows ? ['-c', 'allow_login_shell=false'] : []),
        '-o', join(seat.dir, 'final.md'), '-',
      ],
      cwd: seat.workDir, stdin: join(seat.dir, 'brief.md'), ...(windows ? { env: PYTHON_UTF8 } : {}),
      // The Store's pwsh.exe alias cannot start inside codex's Windows sandbox; without
      // it on PATH codex runs System32's powershell.exe. An owner runs outside the sandbox
      // and keeps it: codex prefers pwsh, and Windows PowerShell 5.1 pipes text into a
      // program as ASCII, so each non-ASCII character arrives as `?`.
      ...(windowsReviewer ? { dropWindowsApps: true, unset: POWERSHELL_51_UNSET } : {}),
      stdout: join(seat.dir, 'codex.jsonl'), stderr: join(seat.dir, 'codex.err'), outputs: [join(seat.dir, 'final.md')],
    },
  }
}

// A run is out of quota only when the CLI's own error says so: the agent's text and its
// commands' output can quote these words, as a seat reading this file does.
// codex exec's errors carry only a message (codex-rs/exec/src/exec_events.rs), so the message decides.
const QUOTA = /Usage limit reached|hit your usage limit/i
// codex writes its own errors as top-level events; an item's text is the agent's, and
// codex.err's tool errors quote the agent's commands.
const ERROR_LINE = '^\\{"type":"(error|turn\\.failed)"'

// codex's safety check refuses a request whose content it flags, and asks for it to be rephrased: running the same
// brief again is refused again, so the report quotes codex's own words.
const POLICY = /flagged for possible|try rephrasing your request/i

const errorMessage = line => {
  const event = asObject(readJson(line))
  return textAt(event?.message) ?? textAt(asObject(event?.error)?.message)
}

// codex exec --json writes some refusals (a hook's block) to stderr only, so a failed run whose JSONL names no error is
// judged by stderr's last line, codex's own, never by a tool's output before it.
const codexErrors = (errors, exitCode, lastStderr) => {
  const messages = errors.split('\n').map(errorMessage).filter(message => message !== undefined)
  return messages.length || exitCode === 0 ? messages : [lastStderr.trim()]
}

export const failedCodex = (exitCode, text, transcript, errors, lastStderr = '') => {
  const quota = QUOTA.test(errors)
  const policy = quota ? undefined : codexErrors(errors, exitCode, lastStderr).find(message => POLICY.test(message))
  const blank = !text.trim()
  const completed = transcript.split('\n').some(line => line.includes('"turn.completed"'))
  const failed = exitCode !== 0 || blank || !completed
  const detail = quota ? 'usage limit reached'
    : policy ? 'refused by codex\'s content policy, which asks to rephrase the request rather than run it again: "' + policy.replace(/\s+/g, ' ').trim() + '"'
    : exitCode !== 0 ? 'exit ' + String(exitCode)
    : blank ? 'empty final text'
    : !completed ? 'missing turn.completed' : ''
  return { text, failed, quota, detail }
}

const judge = async (view, dir, exitCode) => {
  const transcript = join(dir, 'codex.jsonl')
  const text = await view.read(join(dir, 'final.md'))
  const completed = await view.has('"turn.completed"', transcript)
  return failedCodex(exitCode, text, completed ? '"turn.completed"' : '', await view.grep(ERROR_LINE, transcript), await view.tail(join(dir, 'codex.err'), 1))
}

export const tokenCount = jsonl => {
  let total
  for (const line of jsonl.split('\n')) {
    const payload = asObject(asObject(readJson(line))?.payload)
    const usage = asObject(asObject(payload?.info)?.total_token_usage)
    total = numberAt(usage?.total_tokens) ?? total
  }
  return total
}

export const completedTokens = jsonl => {
  for (const line of jsonl.split('\n')) {
    const event = asObject(readJson(line))
    if (event?.type !== 'turn.completed') continue
    const usage = asObject(event.usage)
    const input = numberAt(usage?.input_tokens)
    const output = numberAt(usage?.output_tokens)
    if (input !== undefined && output !== undefined) return input + output
  }
  return undefined
}

const threadId = jsonl => {
  const event = asObject(readJson(jsonl))
  return event?.type === 'thread.started' ? textAt(event.thread_id) : undefined
}

// The rollout codex keeps under its home counts every token of the thread; codex.jsonl only the finished turns.
// `memo` is what an earlier read found, so the rollout is searched for once.
const liveTokens = async (view, dir, memo) => {
  let found = memo
  if (!memo.tokensFrom && !memo.tokensSearched) {
    const id = threadId(await view.head(join(dir, 'codex.jsonl')))
    if (id) {
      const path = await view.find('{CODEX_HOME:~/.codex}/sessions', '*' + id + '.jsonl')
      found = { tokensSearched: true, ...(path ? { tokensFrom: path } : {}) }
    }
  }
  const tokens = found.tokensFrom
    ? tokenCount(await view.tail(found.tokensFrom, 100))
    : completedTokens(await view.tail(join(dir, 'codex.jsonl'), 100))
  return { tokens, ...(found === memo ? {} : { memo: found }) }
}

// codex runs every command as `/bin/zsh -lc '<command>'`.
const shellCommand = command => /^\S*\/(?:ba|z)?sh -l?c (['"])([\s\S]*)\1$/.exec(command)?.[2] ?? command

const actionOf = event => {
  const item = asObject(event.item)
  if (!item) return undefined
  const command = textAt(item.command)
  if (item.type === 'command_execution' && command) return 'Ran ' + shellCommand(command)
  if (item.type === 'file_change') {
    const changes = Array.isArray(item.changes) ? item.changes : []
    const paths = changes.map(change => textAt(asObject(change)?.path)).filter(path => path !== undefined)
    return paths.length ? 'Edited ' + paths.map(fileName).join(', ') : undefined
  }
  if (item.type === 'mcp_tool_call') return textAt(item.tool)
  if (item.type === 'agent_message') return textAt(item.text)?.split('\n')[0]
  return undefined
}

// codex-usage.mjs names a bucket for one model by that model's whole id (normalModelSlug): gpt-5.3-codex's is not gpt-5.3-codex-spark's.
const SHARED = 'codex/codex'
const scopeOfModel = model => 'codex/' + model.toLowerCase()

/**
 * The rate limits in a token_count event of codex's rollout (undocumented): a bucket by `limit_id`, its `primary` and
 * `secondary` windows, either one null when the plan has no such window.
 */
const rolloutQuota = jsonl => {
  const limits = jsonl.split('\n').map(line => asObject(asObject(readJson(line))?.payload))
    .filter(payload => payload?.type === 'token_count' && asObject(payload.rate_limits)).map(payload => asObject(payload?.rate_limits)).at(-1)
  const id = textAt(limits?.limit_id)
  if (!limits || !id) return undefined
  const windows = [limits.primary, limits.secondary].map(asObject).flatMap(window => {
    const [minutes, used, resets] = [numberAt(window?.window_minutes), numberAt(window?.used_percent), numberAt(window?.resets_at)]
    return minutes === undefined || used === undefined ? []
      : [{ id: durationName(minutes), minutes, usedPct: used, ...(resets === undefined ? {} : { resetsAt: resets * 1000 }) }]
  })
  return [{ scope: 'codex/' + id.toLowerCase(), windows }]
}

const rolloutOf = async (view, dir) => {
  const id = threadId(await view.head(join(dir, 'codex.jsonl')))
  return id ? view.find('{CODEX_HOME:~/.codex}/sessions', '*' + id + '.jsonl') : undefined
}

const passiveQuota = async (view, dir) => {
  const rollout = await rolloutOf(view, dir)
  return rollout ? rolloutQuota(await view.tail(rollout, 200)) : undefined
}

/** @type {import('./index.mjs').VendorAdapter} */
export const codex = {
  id: 'codex',
  explicitForm: true,
  transcript: 'codex.jsonl',
  // codex streams item.started then item.completed.
  stepPattern: '"type":"item\\.completed","item":\\{"id":"[^"]*","type":"(command_execution|file_change|mcp_tool_call)"',
  familyOf: candidate => familyOfModel(candidate.model),
  capabilities: () => ['image-generation'],
  scopesOf: candidate => [SHARED, scopeOfModel(candidate.model)],
  bandScopes: () => [SHARED],
  passiveQuota,
  exhaustedScopes: candidateScopes,
  version: ['codex', '--version'],
  models: { run: { script: 'codex-models.mjs' }, parse: stdout => {
    const data = readJson(stdout)
    return Array.isArray(data) ? data : undefined
  } },
  usage: { run: { script: 'codex-usage.mjs' }, parse: stdout => scriptUsage(readJson(stdout), SHARED, scopeOfModel) },
  probe: PROBE,
  facts: async (io, { seat, os, seatRoot }) =>
    os === 'windows' && !guarded(seat) ? { sandbox: (await io.read(join(seatRoot, PROBE.file))).trim() } : {},
  plan,
  judge,
  liveTokens,
  lastAction: lastActionWith(actionOf),
}
