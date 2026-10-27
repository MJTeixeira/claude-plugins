#!/usr/bin/env node
// The owner seat's PreToolUse hook on codex and agy: refuses the commands an
// owner may never run (force push, git reset --hard, git worktree remove or move,
// git branch -D, rm -rf, gh pr merge --admin, gh repo delete) however the command
// line spells them. Every worktree is refused: another is someone else's checkout,
// and the mod removes the seat's own when the seat ends, keeping it when it holds
// uncommitted work. For the same reason clean -f, checkout, restore and a forced
// switch are refused when -C, --work-tree or GIT_WORK_TREE aim them at another
// directory than the one the command runs in. One force push
// passes: `--force-with-lease=<branch>:<sha>` to the branch checked out where the
// command runs, when that is no default branch, as a rebase flow needs. The CLIs'
// own prefix rules miss `git -C . reset --hard`, `rm -fr` and any line their
// shell parser gives up on, such as `git reset --hard HEAD~1`.
// codex and Claude send `tool_input.command` and `cwd` and are refused with a
// `hookSpecificOutput` deny, not exit 2: on Windows codex runs the hook through
// PowerShell `-Command`, which reports exit 2 as 1, and a failed hook lets the command
// run (openai/codex#48183). agy sends `toolCall.args.CommandLine` (with `Cwd`, else
// its workspace is the cwd) and is refused with its own JSON decision.
// Usage: node owner-guard.mjs < hook-input.json
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHELLS = ['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'cmd']
const WRAPPERS = ['command', 'builtin', 'exec', 'nohup', 'time', 'sudo', 'doas', 'xargs', 'nice']
const GIT_VALUE_OPTIONS = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']
const REMOVERS = ['rm', 'remove-item', 'ri', 'del', 'erase', 'rd', 'rmdir']
const DEFAULT_BRANCHES = ['main', 'master', 'dev', 'develop', 'trunk']
const PUSH_VALUE_OPTIONS = ['--repo', '--receive-pack', '--exec', '-o', '--push-option']

/** A command line as simple commands, each a list of words; quotes are honoured, and every shell operator ends a command. A `\` escapes the next character as in a POSIX shell; read the `windows` way, `\` is an ordinary character and cmd's `^` and PowerShell's `` ` `` escape the next one instead. */
export function commands(line, windows = false) {
  const found = []
  let words = []
  let word = ''
  let started = false
  const endWord = () => {
    if (started) words.push(word)
    word = ''
    started = false
  }
  const endCommand = () => {
    endWord()
    if (words.length) found.push(words)
    words = []
  }
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === "'") {
      const close = line.indexOf("'", index + 1)
      const end = close === -1 ? line.length : close
      word += line.slice(index + 1, end)
      started = true
      index = end
    } else if (char === '"') {
      started = true
      for (index += 1; index < line.length && line[index] !== '"'; index += 1) {
        if (!windows && line[index] === '\\' && index + 1 < line.length) index += 1
        word += line[index]
      }
    } else if ((windows ? char === '^' || char === '`' : char === '\\') && index + 1 < line.length && line[index + 1] !== '\n') {
      word += line[index + 1]
      started = true
      index += 1
    } else if (/\s/.test(char)) {
      if (char === '\n') endCommand()
      else endWord()
    } else if (';&|()`{}'.includes(char) || (char === '$' && line[index + 1] === '(')) {
      endCommand()
    } else {
      word += char
      started = true
    }
  }
  endCommand()
  return found
}

const programName = word => word.replaceAll('\\', '/').split('/').pop().toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '')

// The words that run: assignments, `env` and its options, and wrappers like `command` dropped.
function strip(words) {
  let rest = words
  for (;;) {
    while (rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) rest = rest.slice(1)
    const name = rest.length ? programName(rest[0]) : ''
    if (name === 'env') {
      rest = rest.slice(1)
      while (rest.length && (rest[0].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]))) {
        rest = rest.slice(['-u', '--unset', '-C', '--chdir', '-S', '--split-string'].includes(rest[0]) ? 2 : 1)
      }
    } else if (WRAPPERS.includes(name)) {
      rest = rest.slice(1)
      while (rest.length && rest[0].startsWith('-')) rest = rest.slice(1)
    } else return rest
  }
}

const shortFlags = word => /^-[A-Za-z]+$/.test(word) ? word.slice(1) : ''

const branchOf = ref => ref.replace(/^refs\/heads\//, '')

// A push whose only force is a lease pinned to a commit, onto `branch` alone.
function isLeasedPush(args, branch) {
  if (!branch || DEFAULT_BRANCHES.includes(branch)) return false
  const plain = []
  let leased = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    const lease = /^--force-with-lease=([^:]+):([0-9a-f]{7,40})$/.exec(arg)
    if (lease) {
      if (branchOf(lease[1]) !== branch) return false
      leased = true
    } else if (arg === '--force' || arg.startsWith('--force-with-lease') || shortFlags(arg).includes('f')) return false
    else if (PUSH_VALUE_OPTIONS.includes(arg)) index += 1
    else if (!arg.startsWith('-')) plain.push(arg)
  }
  const refspecs = plain.slice(1)
  return leased && refspecs.length > 0 && refspecs.every(spec => {
    const [source, target = source] = spec.split(':')
    return !source.startsWith('+') && (source === 'HEAD' || branchOf(source) === branch) && (target === 'HEAD' || branchOf(target) === branch)
  })
}

// Where a git command's working tree is: `cwd` moved by each `-C`, then `--work-tree` or GIT_WORK_TREE.
function gitTree(options, assigned, cwd) {
  let dir = cwd
  let tree = assigned === undefined ? undefined : resolve(cwd, assigned)
  for (let index = 0; index < options.length; index += 1) {
    if (options[index] === '-C') dir = resolve(dir, options[index + 1] ?? '')
    else if (options[index] === '--work-tree') tree = resolve(dir, options[index + 1] ?? '')
    else if (options[index].startsWith('--work-tree=')) tree = resolve(dir, options[index].slice('--work-tree='.length))
    if (GIT_VALUE_OPTIONS.includes(options[index])) index += 1
  }
  return tree ?? dir
}

const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

// `checkout` discards work with no flag too: `checkout <path>` reads like `checkout <branch>`.
// `switch` takes no paths.
function discardsWork(sub, rest) {
  const forced = rest.includes('--force') || rest.some(arg => shortFlags(arg).includes('f'))
  return (sub === 'clean' && forced) || sub === 'checkout' || sub === 'restore'
    || (sub === 'switch' && (forced || rest.includes('--discard-changes')))
}

function refusal(words, branch, cwd) {
  const assigned = words.find(word => word.startsWith('GIT_WORK_TREE='))?.slice('GIT_WORK_TREE='.length)
  const [first, ...args] = strip(words)
  if (!first) return undefined
  const name = programName(first)
  if (SHELLS.includes(name)) {
    const script = args.findIndex(arg => /^-[a-z]*c$/i.test(arg) || /^\/c$/i.test(arg) || /^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(arg))
    return script === -1 ? undefined : check(args.slice(script + 1).join(' '), branch, cwd)
  }
  if (name === 'git') {
    let index = 0
    while (index < args.length && args[index].startsWith('-')) {
      index += GIT_VALUE_OPTIONS.includes(args[index]) ? 2 : 1
    }
    const sub = args[index]
    const rest = args.slice(index + 1)
    if (sub === 'reset' && rest.includes('--hard')) return 'Use a reversible Git operation instead of git reset --hard.'
    if (sub === 'worktree' && (rest[0] === 'remove' || rest[0] === 'move')) {
      return 'Leave every worktree where it is and, when a branch you need is checked out in another, work from a new branch or a detached HEAD.'
    }
    if (discardsWork(sub, rest) && !samePath(gitTree(args.slice(0, index), assigned, cwd), resolve(cwd))) {
      return 'Discard changes only in the worktree the command runs in: another worktree is someone else\'s checkout.'
    }
    const short = rest.map(shortFlags).join('')
    const deletes = short.includes('d') || rest.includes('--delete')
    if (sub === 'branch' && (short.includes('D') || (deletes && (short.includes('f') || rest.includes('--force'))))) {
      return 'Delete a branch only with git branch -d, which keeps unmerged commits: another agent may own the branch.'
    }
    if (sub === 'push' && !isLeasedPush(rest, branch) && rest.some(arg => arg === '--force' || arg.startsWith('--force-with-lease') || arg === '--force-if-includes'
      || shortFlags(arg).includes('f') || (arg.startsWith('+') && arg.length > 1))) {
      return 'Use a non-force push, or --force-with-lease=<branch>:<sha> onto the branch checked out here.'
    }
    return undefined
  }
  if (name === 'gh') {
    const plain = args.filter(arg => !arg.startsWith('-'))
    if (plain[0] === 'pr' && plain[1] === 'merge' && args.includes('--admin')) return 'Do not bypass merge protections.'
    if (plain[0] === 'repo' && plain[1] === 'delete') return 'Do not delete repositories.'
    return undefined
  }
  if (REMOVERS.includes(name)) {
    const flags = args.filter(arg => arg.startsWith('-'))
    const recursive = flags.some(arg => arg === '--recursive' || /^-r(e(c(u(r(s(e)?)?)?)?)?)?$/i.test(arg) || /[rR]/.test(shortFlags(arg)))
    const force = flags.some(arg => arg === '--force' || /^-fo(r(c(e)?)?)?(:\$true)?$/i.test(arg) || shortFlags(arg).includes('f'))
    if (recursive && force) return 'Remove only explicit paths, without a forced recursive delete.'
  }
  return undefined
}

/**
 * Why a command line is refused, or undefined when it may run; `branch` is the one checked out where it runs.
 * The shell that runs a line is unknown: codex on Windows hands over `"C:\WINDOWS\...\powershell.exe" -Command '...'`,
 * where a POSIX reading drops every `\`. A line is refused when either its POSIX or its Windows reading refuses it.
 */
export function check(line, branch, cwd = process.cwd()) {
  for (const windows of [false, true]) {
    for (const words of commands(line, windows)) {
      const reason = refusal(words, branch, cwd)
      if (reason) return reason
    }
  }
  return undefined
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
  const agy = input.toolCall?.args?.CommandLine
  const line = agy ?? input.tool_input?.command
  const cwd = input.toolCall?.args?.Cwd ?? input.workspacePaths?.[0] ?? input.cwd ?? process.cwd()
  const branch = () => spawnSync('git', ['-C', cwd, 'branch', '--show-current'], { encoding: 'utf8', windowsHide: true }).stdout?.trim()
  const reason = typeof line === 'string' ? check(line, /\bpush\b/.test(line) ? branch() : undefined, cwd) : undefined
  if (reason && agy !== undefined) process.stdout.write(JSON.stringify({ decision: 'deny', reason: 'seat-router owner guard: ' + reason }) + '\n')
  else if (reason) {
    const hookSpecificOutput = { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'seat-router owner guard: ' + reason }
    process.stdout.write(JSON.stringify({ hookSpecificOutput }) + '\n')
  }
}
