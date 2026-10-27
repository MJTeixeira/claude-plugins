#!/usr/bin/env node
// The owner seat's PreToolUse hook on codex and agy: refuses the commands an
// owner may never run (force push, git reset --hard, rm -rf, gh pr merge
// --admin, gh repo delete) however the command line spells them. One force push
// passes: `--force-with-lease=<branch>:<sha>` to the branch checked out where the
// command runs, when that is no default branch, as a rebase flow needs. The CLIs'
// own prefix rules miss `git -C . reset --hard`, `rm -fr` and any line their
// shell parser gives up on, such as `git reset --hard HEAD~1`.
// codex and Claude send `tool_input.command` and `cwd` and are refused with exit 2;
// agy sends `toolCall.args.CommandLine` (with `Cwd`, else its workspace is the
// cwd) and is refused with a JSON decision.
// Usage: node owner-guard.mjs < hook-input.json
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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

function refusal(words, branch) {
  const [first, ...args] = strip(words)
  if (!first) return undefined
  const name = programName(first)
  if (SHELLS.includes(name)) {
    const script = args.findIndex(arg => /^-[a-z]*c$/i.test(arg) || /^\/c$/i.test(arg) || /^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(arg))
    return script === -1 ? undefined : check(args.slice(script + 1).join(' '), branch)
  }
  if (name === 'git') {
    let index = 0
    while (index < args.length && args[index].startsWith('-')) {
      index += GIT_VALUE_OPTIONS.includes(args[index]) ? 2 : 1
    }
    const sub = args[index]
    const rest = args.slice(index + 1)
    if (sub === 'reset' && rest.includes('--hard')) return 'Use a reversible Git operation instead of git reset --hard.'
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
export function check(line, branch) {
  for (const windows of [false, true]) {
    for (const words of commands(line, windows)) {
      const reason = refusal(words, branch)
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
  const reason = typeof line === 'string' ? check(line, /\bpush\b/.test(line) ? branch() : undefined) : undefined
  if (reason && agy !== undefined) process.stdout.write(JSON.stringify({ decision: 'deny', reason: 'seat-router owner guard: ' + reason }) + '\n')
  else if (reason) {
    process.stderr.write('seat-router owner guard: ' + reason + '\n')
    process.exit(2)
  }
}
