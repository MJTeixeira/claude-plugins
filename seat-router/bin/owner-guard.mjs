#!/usr/bin/env node
// The owner seat's PreToolUse hook: protects other checkouts and irreversible Git operations.
// Discarding work and deleting explicit build paths inside the seat are allowed; its roots stay protected.
// A push may delete only the seat's own branch or one its worktree checked out, and keeps push hooks enabled.
// codex and Claude send `tool_input.command` and `cwd` (codex reports a call's own
// workdir there only from openai/codex#57198) and are refused with a
// `hookSpecificOutput` deny, not exit 2: on Windows codex runs the hook through
// PowerShell `-Command`, which reports exit 2 as 1, and a failed hook lets the command
// run (openai/codex#48183). agy sends `toolCall.args.CommandLine` (with `Cwd`, else
// its workspace is the cwd) and is refused with its own JSON decision.
// With --reviewer it is a worktree reviewer's hook: the owner's refusals, then reviewerGuard()'s, and a Claude file
// tool's write into a --main checkout.
// Usage: node owner-guard.mjs [--own SEAT_FOLDER] [--reviewer [--main CHECKOUT]...] < hook-input.json
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import nodePath from 'node:path'
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

// git and GNU tools take any unambiguous prefix of a long option (--force-w, --rec) and fail on an ambiguous one, so
// reading every prefix of three characters or more as the option refuses nothing else that runs.
const longOption = (arg, ...options) => {
  const name = arg.split('=')[0]
  return name.length > 2 && options.some(option => option.startsWith(name))
}

const shellScript = args => {
  const at = args.findIndex(arg => /^-[a-z]*c$/i.test(arg) || /^\/c$/i.test(arg) || /^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(arg))
  const script = args.slice(at + 1)
  return at === -1 ? undefined : (script[0] === '--' ? script.slice(1) : script).join(' ')
}

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
    } else if (longOption(arg, '--force', '--force-with-lease') || shortFlags(arg).includes('f')) return false
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
function gitTree(options, assigned, cwd, path) {
  let dir = path.resolve(cwd)
  let tree = assigned === undefined ? undefined : path.resolve(cwd, assigned)
  for (let index = 0; index < options.length; index += 1) {
    if (options[index] === '-C') dir = path.resolve(dir, options[index + 1] ?? '')
    else if (options[index] === '--work-tree') tree = path.resolve(dir, options[index + 1] ?? '')
    else if (options[index].startsWith('--work-tree=')) tree = path.resolve(dir, options[index].slice('--work-tree='.length))
    if (GIT_VALUE_OPTIONS.includes(options[index])) index += 1
  }
  return tree ?? dir
}

const samePath = (a, b, path) => path.sep === '\\' ? a.toLowerCase() === b.toLowerCase() : a === b

// `checkout` may discard work with no flag: `checkout <path>` reads like `checkout <branch>`,
// so `checkout -b` is caught too. `switch` takes no paths.
function mayDiscardWork(sub, rest) {
  const forced = rest.some(arg => longOption(arg, '--force') || shortFlags(arg).includes('f'))
  return (sub === 'clean' && forced) || sub === 'checkout' || sub === 'restore'
    || (sub === 'switch' && (forced || rest.some(arg => longOption(arg, '--discard-changes'))))
}

const forceDeletesBranch = args => {
  const flags = args.map(shortFlags).join('')
  const deletes = flags.includes('d') || args.some(arg => longOption(arg, '--delete'))
  return flags.includes('D') || (deletes && (flags.includes('f') || args.some(arg => longOption(arg, '--force'))))
}

function refusal(words, branch, cwd, path, own, allowedBranches = [], cdpath = undefined) {
  const assigned = words.find(word => word.startsWith('GIT_WORK_TREE='))?.slice('GIT_WORK_TREE='.length)
  const [first, ...args] = strip(words)
  if (!first) return undefined
  const name = programName(first)
  if (SHELLS.includes(name)) {
    const script = shellScript(args)
    const placed = words[0] === first && ['-c', '/c', '-command'].includes(args[0]?.toLowerCase())
    return script === undefined ? undefined : check(script, branch, cwd, path, placed ? own : undefined, allowedBranches, cdpath)
  }
  if (name === 'git') {
    let index = 0
    while (index < args.length && args[index].startsWith('-')) {
      index += GIT_VALUE_OPTIONS.includes(args[index]) ? 2 : 1
    }
    const sub = args[index]
    const rest = args.slice(index + 1)
    if (sub === 'reset' && rest.some(arg => longOption(arg, '--hard'))) return 'Use a reversible Git operation instead of git reset --hard.'
    if (sub === 'worktree' && (rest[0] === 'remove' || rest[0] === 'move')) {
      return 'Leave every worktree where it is and, when a branch you need is checked out in another, work from a new branch or a detached HEAD.'
    }
    if (mayDiscardWork(sub, rest) && !samePath(gitTree(args.slice(0, index), assigned, cwd, path), path.resolve(cwd), path)) {
      return `Run git ${sub} only in the folder the command runs in: -C, --work-tree or GIT_WORK_TREE point this one at another folder.`
    }
    if (sub === 'branch' && forceDeletesBranch(rest)) {
      const targets = rest.filter(arg => !arg.startsWith('-')).map(branchOf)
      if (targets.length && targets.every(target => allowedBranches.includes(target))) return undefined
      return 'Delete a branch only with git branch -d, which keeps unmerged commits: another agent may own the branch.'
    }
    if (sub === 'push' && !isLeasedPush(rest, branch) && rest.some(arg => longOption(arg, '--force', '--force-with-lease', '--force-if-includes')
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
  // cmd ignores a leading @ and ends an internal command's name at a slash, so @rd/s/q is rd /s /q.
  const cmdRemover = /^@?(rd|rmdir|del|erase)(\/.*)?$/i.exec(first)
  const remover = cmdRemover ? cmdRemover[1].toLowerCase() : name
  if (REMOVERS.includes(remover)) {
    const flags = args.filter(arg => arg.startsWith('-'))
    // PowerShell's -Force, or a prefix of it, is one parameter, not short flags with an r among them. Either
    // switch counts with any value after a colon (-Recurse:$true), $false included.
    const forceParameter = arg => /^-fo(r(c(e)?)?)?(:.*)?$/i.test(arg)
    // cmd's removers read a switch at every slash, glued to a path, a quote or another switch (x/s/q, /q"x", /s/q/ah);
    // del's /f forces too. To rm, /tmp/s is a path.
    const switches = cmdRemover ? [first, ...args].flatMap(arg => [...arg.matchAll(/\/([a-z])/gi)].map(match => match[1].toLowerCase())) : []
    const recursive = switches.includes('s') || flags.some(arg => longOption(arg, '--recursive') || /^-r(e(c(u(r(s(e)?)?)?)?)?)?(:.*)?$/i.test(arg) || (!forceParameter(arg) && /[rR]/.test(shortFlags(arg))))
    const force = switches.includes('q') || switches.includes('f') || flags.some(arg => longOption(arg, '--force') || forceParameter(arg) || shortFlags(arg).includes('f'))
    if (recursive && force) {
      const targets = args.filter(arg => !arg.startsWith('-'))
      if (remover === 'rm' && words[0] === first && own !== undefined && targets.length && targets.every(target => {
        if (!placeable(target)) return false
        const folders = moved([cwd], target, path)
        const seat = real(path.resolve(own), path)
        if (seat === null) return false
        const roots = [folded(seat, path), folded(path.join(seat, 'wt'), path)]
        return folders.every(folder => within(folder, folded(seat, path), path) && !roots.includes(folded(real(folder, path), path)))
      })) return undefined
      return 'Remove only explicit paths, without a forced recursive delete.'
    }
  }
  return undefined
}

/**
 * Why a command line is refused, or undefined when it may run; `branch` is the one checked out where it runs.
 * `path` resolves folders: node:path, or path.win32 to decide as Windows does.
 * The shell that runs a line is unknown: codex on Windows hands over `"C:\WINDOWS\...\powershell.exe" -Command '...'`,
 * where a POSIX reading drops every `\`. A line is refused when either its POSIX or its Windows reading refuses it.
 */
export function check(line, branch, cwd = process.cwd(), path = nodePath, own = undefined, allowedBranches = [], cdpath = undefined) {
  for (const windows of [false, true]) {
    let places = [path.resolve(cwd)]
    for (const words of commands(line, windows)) {
      const command = plain(words)
      if (own !== undefined && command?.target !== undefined) places = cdpath && searched(command.target) ? [null] : [...new Set([...places, ...moved(places, command.target, path)])]
      else if (own !== undefined && command?.pop) places = [null]
      else if (own !== undefined && (assignments(words).some(word => /^CDPATH=/i.test(word)) || ['source', '.', 'eval', 'iex'].includes(words[0]?.toLowerCase()))) places = [null]
      const program = programName(strip(words)[0] ?? '')
      const nestedRemoval = SHELLS.includes(program) && /\brm\b/.test(shellScript(strip(words).slice(1)) ?? '')
      const located = program === 'rm' || nestedRemoval ? places : [cwd]
      const expandedRemoval = /\brm\b[^\n;&|]*(?:\$\(|`|[{}]|[<>]\()/.test(line)
      const reason = located.map(place => refusal(words, branch, place ?? cwd, path, place === null || expandedRemoval ? undefined : own, allowedBranches, cdpath)).find(Boolean)
      if (reason) return reason
    }
  }
  return undefined
}

const HOOKS_PATH = /^core\.hookspath(=|$)/i

// A refspec with an empty source (`:x`, `+:x`) deletes. The first plain word is the remote even beside --repo, as git reads it.
function deletedBranches(args) {
  const plain = []
  let deletes = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (PUSH_VALUE_OPTIONS.includes(arg)) index += 1
    else if (longOption(arg, '--delete') || shortFlags(arg).includes('d')) deletes = true
    else if (!arg.startsWith('-')) plain.push(arg)
  }
  return plain.slice(1).map(ref => deletes ? ref : /^\+?:/.test(ref) ? ref.slice(ref.indexOf(':') + 1) : '').filter(Boolean).map(branchOf)
}

const HOOKS_REASON = 'Push with the repository\'s own push hooks: no --no-verify, and no core.hooksPath set by -c, git config or GIT_CONFIG_*.'

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

// The words of a command that set environment variables: its leading assignments, those env takes before the program it
// runs, the arguments of export or cmd's set, or a PowerShell $env: statement. An argument of any other program is text.
const assignments = words => {
  const head = words.findIndex(word => !ASSIGNMENT.test(word))
  if (head === -1) return words
  if (/^\$env:/i.test(words[head])) return words.slice(head)
  const program = programName(words[head])
  const rest = words.slice(head + 1)
  const runs = rest.findIndex(word => !word.startsWith('-') && !ASSIGNMENT.test(word))
  if (program === 'env') return [...words.slice(0, head), ...(runs === -1 ? rest : rest.slice(0, runs))]
  return ['export', 'set'].includes(program) ? [...words.slice(0, head), ...rest] : words.slice(0, head)
}

const setsHooksEnv = words => assignments(words).some((word, index, set) => {
  const at = word.indexOf('=')
  const [name, value] = at > 0 ? [word.slice(0, at), word.slice(at + 1)] : [word, set[index + 1] === '=' ? set[index + 2] : undefined]
  return /^(\$env:)?GIT_CONFIG_(PARAMETERS|KEY_\d+)$/i.test(name) && /core\.hookspath/i.test(value ?? '')
})

const CONFIG_READS = ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '--unset', '--unset-all', '--remove-section', '--rename-section', '--edit']
const CONFIG_VALUE_OPTIONS = ['-f', '--file', '--blob', '--type', '--default', '--comment', '--value']

// git config writes a key when a value follows it and no read or unset action is named, in any scope and as `git config
// set`. After `--` the value may start with `-`.
const setsHooksConfig = args => {
  const plain = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--') {
      plain.push(...args.slice(index + 1))
      break
    }
    if (arg === '-l' || arg === '-e' || longOption(arg, ...CONFIG_READS)) return false
    if (CONFIG_VALUE_OPTIONS.includes(arg)) index += 1
    else if (!arg.startsWith('-')) plain.push(arg)
  }
  const [key, value] = plain[0] === 'set' ? plain.slice(1) : plain
  return /^core\.hookspath$/i.test(key ?? '') && value !== undefined
}

function pushRefusal(words, deletable) {
  if (setsHooksEnv(words)) return HOOKS_REASON
  const [first, ...args] = strip(words)
  if (!first) return undefined
  const name = programName(first)
  if (SHELLS.includes(name)) {
    const script = shellScript(args)
    return script === undefined ? undefined : pushCheck(script, deletable)
  }
  if (name !== 'git') return undefined
  let index = 0
  let hooks = false
  let configDeletes = false
  while (index < args.length && args[index].startsWith('-')) {
    const option = args[index]
    const value = option === '-c' || option === '--config-env' ? args[index + 1]
      : option.startsWith('--config-env=') ? option.slice('--config-env='.length) : undefined
    hooks ||= value !== undefined && HOOKS_PATH.test(value)
    configDeletes ||= option === '-c' && /^remote\..+\.push=\+?:/i.test(value ?? '')
    index += GIT_VALUE_OPTIONS.includes(option) ? 2 : 1
  }
  const [sub, ...rest] = args.slice(index)
  if (sub === 'config') return setsHooksConfig(rest) ? HOOKS_REASON : undefined
  if (sub !== 'push') return undefined
  if (hooks || rest.some(arg => longOption(arg, '--no-verify'))) return HOOKS_REASON
  if (rest.some(arg => longOption(arg, '--mirror', '--prune'))) return 'Push named branches, without --mirror or --prune: both delete remote branches.'
  if (configDeletes) return 'Delete a remote branch only by naming it on the push line, not through a remote.<name>.push setting.'
  const foreign = deletedBranches(rest).find(branch => !deletable.includes(branch))
  return foreign === undefined ? undefined
    : `Delete a remote branch only when it is this seat's own or one this worktree checked out; ${foreign} is neither.`
}

const pushCheck = (line, deletable) => {
  for (const windows of [false, true]) {
    for (const words of commands(line, windows)) {
      const reason = pushRefusal(words, deletable)
      if (reason) return reason
    }
  }
  return undefined
}

// A worktree seat's branch is seat/seat-<suffix>; the hook knows its seat-<suffix> folder.
const seatBranches = (own, path) => {
  const suffix = own === undefined ? undefined : /^seat[.-]([^.]+)$/.exec(path.basename(own))?.[1]
  return suffix === undefined ? [] : [`seat/seat-${suffix}`]
}

/** The branches the worktree's HEAD reflog (`<gitdir>/logs/HEAD`) checked out, a default branch never among them. */
export const checkedOut = reflog => [...reflog.matchAll(/\tcheckout: moving from \S+ to (\S+)$/gm)]
  .map(match => match[1]).filter(branch => !DEFAULT_BRANCHES.includes(branch))

const CD_WORDS = ['cd', 'chdir', 'pushd', 'popd', 'sl', 'set-location', 'push-location', 'pop-location']
const PUSH_WORDS = ['pushd', 'push-location']
const POP_WORDS = ['popd', 'pop-location']
const CD_OPTIONS = ['/d', '-l', '-p', '-path', '-literalpath', '--']
const CONTROL_WORDS = 'if|then|else|elif|fi|for|while|until|do|done|case|esac|select|function'
const DISCARD_WORDS = ['clean', 'checkout', 'restore', 'switch', 'stash', 'rm', 'reset', 'read-tree', 'checkout-index']
// Subcommands whose --abort or --quit drops the merge, rebase or pick in progress and the conflicts resolved so far.
const ABORTING = ['rebase', 'merge', 'cherry-pick', 'revert', 'am']
// git's options that take the next word as their value (git.c handle_options), with older git's --super-prefix.
const VALUE_OPTIONS = [...GIT_VALUE_OPTIONS, '--attr-source', '--shallow-file', '--super-prefix']
// Programs that run a script, a file or another command given to them, so the line's text may hold what they run.
const RUNNERS = ['sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish', 'pwsh', 'powershell', 'cmd', 'xargs', 'find', 'perl', 'ruby',
  'python', 'node', 'deno', 'bun', 'env', 'sudo', 'nice', 'timeout', 'stdbuf', 'ionice', 'time', 'command', 'exec', 'caffeinate', 'arch', 'script', 'watch',
  'noglob', 'start-process', 'eval', 'source', '.', 'iex', 'invoke-expression']
// Shell words a command's program may follow.
const LEADS = ['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', 'time', 'coproc']
// A git configuration key whose value runs a command: an alias or a *.cmd.
const RUNS_KEY = /^(?:alias\.|[^=]*\.cmd(?:=|$))/i
const isRedirect = word => /^(?:\d+|&)?(?:>>?|<>?|>&|<)/.test(word) || word === '!'

// The line with a shell's line continuation removed, so a command split across lines reads as one.
const joined = (line, windows) => windows ? line.replace(/[`^]\r?\n/g, '') : line.replace(/\\\r?\n/g, '')

// Parentheses, substitutions, background execution and shell control flow need more context than a command sequence.
const notSimpleLine = line => {
  const text = line.replace(/['"]/g, '')
  return /[()`]/.test(text) || /<</.test(text) || /(^|[^&>])&([^&>]|$)/.test(text)
    || commands(line).some(words => CONTROL_WORDS.split('|').includes(words[0]))
}

const tokens = text => text.match(/[\w.\-/\\*?[\]:~+]+/g) ?? []

// Whether a word could run git: git or git.exe at the end of a path, or a glob that may expand to either.
const namesGit = word => {
  const name = word.split(/[\\/]/).pop()
  if (!/[*?[]/.test(name)) return /^git(\.exe)?$/i.test(name)
  const glob = new RegExp('^' + name.replace(/\[[^\]]*\]|[*?]|[^*?[]+|\[/g, part => part === '*' ? '.*'
    : part === '?' || (part.length > 1 && part.startsWith('[')) ? '.' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&')) + '$', 'i')
  return glob.test('git') || glob.test('git.exe')
}

// A word of wildcards alone (`*`, `???`, `[a-z]*`) names git only through the file names of a folder, so it counts only
// where it may run: as a command's program word or after a runner or a wrapper.
const wildcardOnly = word => /^(?:\[[^\]]*\]|[*?])+$/.test(word.split(/[\\/]/).pop())
const runsGit = words => words.some((word, index) => namesGit(word) && (!wildcardOnly(word)
  || words.slice(0, index).every(before => /^[A-Za-z_][A-Za-z0-9_]*=/.test(before) || LEADS.includes(before))
  || words.slice(0, index).some(before => runner(before) || WRAPPERS.includes(programName(before)))))

const dynamic = word => word !== '[' && word !== '[[' && (/[$`*?[\]{}%!]/.test(word) || word.startsWith('='))

const runner = word => {
  const name = programName(word)
  return RUNNERS.includes(name) || RUNNERS.includes(name.replace(/[\d.]+$/, ''))
}

// What the words after a git program word may discard or run, named for its refusal, or undefined: a discarding subcommand
// (or one with an expansion among its arguments), a leased push, a dynamic subcommand, or one that runs a script or an alias.
const gitReach = args => {
  let index = 0
  let runs = false
  while (args[index]?.startsWith('-')) {
    const option = args[index]
    const value = option === '-c' || option === '--config-env' ? args[index + 1]
      : option.startsWith('--config-env=') ? option.slice('--config-env='.length) : undefined
    runs ||= value !== undefined && RUNS_KEY.test(value)
    index += VALUE_OPTIONS.includes(option) ? 2 : 1
  }
  const sub = (args[index] ?? '').toLowerCase()
  const rest = args.slice(index + 1)
  if (runs || dynamic(sub)) return 'commands'
  if (sub === 'push') return rest.some(arg => /^--force-(with-lease|if-includes)/.test(arg)) ? 'push' : undefined
  return runsScript(sub, rest) || discards(sub, rest) || (DISCARD_WORDS.includes(sub) && rest.some(arg => /[$`%]/.test(arg))) ? sub : undefined
}

// Whether a git subcommand runs a command its arguments give: rebase or difftool -x, submodule foreach, bisect run,
// filter-branch, or config setting an alias or a *.cmd.
const runsScript = (sub, args) => sub === 'filter-branch' || (sub === 'submodule' && args.includes('foreach')) || (sub === 'bisect' && args.includes('run'))
  || (sub === 'config' && args.some(arg => RUNS_KEY.test(arg))) || (['rebase', 'difftool'].includes(sub) && args.some(arg => /^(-[a-z]*x|--exec|--extcmd)/.test(arg)))

// Strings no shell runs: a quoted string's text, read by the reading's own quote rules.
const quoted = windows => windows ? /'[^']*'|"[^"]*"/g : /'[^']*'|"(?:[^"\\]|\\.)*"/g
// A here-document whose delimiter is quoted is text: its body runs only when a shell reads it, and a shell is a runner.
const HEREDOC = /(<<-?[ \t]*(['"])([^'"\s]+)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g
// Any here-document, its delimiter quoted or not: its opener and its body.
const ANY_HEREDOC = /(<<-?[ \t]*(['"]?)([^'"\s]+)\2[^\n]*)\n([\s\S]*?)\n[ \t]*\3[ \t]*(?=\n|$)/g
const SUBSTITUTION = /\$\(|`|[<>]\(/

const interpreter = word => /^(python[\d.]*|node|ruby|perl|deno|bun)$/.test(programName(word))
const processRunner = (text, program) => /\b(?:subprocess|child_process)\b|\bos\.(?:system|exec\w*|popen)\b|\bpty\.spawn\b|\b(?:execSync|exec|spawn|execFile|spawnSync|system)\s*(?:\(|["'])|\b(?:Bun\.spawn|Deno\.Command)\b/.test(text)
  || (/^(ruby|perl)$/.test(programName(program)) && /`|%x\b/.test(text))

// Interpreter payloads are data unless they name a process runner. Keep shell substitutions visible and leave
// shell wrappers alone: their payloads still run as shell commands, even when they contain an interpreter.
const interpreterData = line => {
  const text = line.replace(ANY_HEREDOC,
    (whole, opener, quote, _delimiter, body, offset) => {
      const header = line.slice(line.lastIndexOf('\n', offset - 1) + 1, offset)
      const words = commands(header).at(-1) ?? []
      const program = strip(words)[0] ?? ''
      return interpreter(program) && !processRunner(header + body, program) && (quote || !SUBSTITUTION.test(body)) ? opener : whole
    })
  const words = []
  const payloads = []
  const edits = []
  const finish = () => {
    const program = strip(words)[0] ?? ''
    if (!processRunner(words.join(' '), program)) edits.push(...payloads)
    words.length = 0
    payloads.length = 0
  }
  for (const match of text.matchAll(/'[^']*'|"(?:[^"\\]|\\.)*"|[;&|\n]|[^\s'";&|\n]+/g)) {
    const token = match[0]
    if (/^[;&|\n]$/.test(token)) {
      finish()
      continue
    }
    const program = strip(words)[0] ?? ''
    const payload = /^['"]/.test(token) && /^-[ce]$/.test(words.at(-1) ?? '') && interpreter(program)
    if (payload && (token[0] === "'" || !SUBSTITUTION.test(token))) payloads.push({ at: match.index, length: token.length })
    words.push(token)
  }
  finish()
  let result = text
  for (const { at, length } of edits.reverse()) result = result.slice(0, at) + "''" + result.slice(at + length)
  return result
}

// The discarding git command a line may reach, named for its refusal, or undefined when it reaches none and check() alone
// decides. Its commands are read as a POSIX and a Windows shell would, with here-document bodies dropped and the text of
// each command substitution read as commands too. A line reaches one through git as a command's program word, or as a later
// word of another command (`nohup git clean`), with a subcommand gitReach() names; or through a runner, a dynamic program
// word or an unquoted substitution, when the line's raw text names one: the text with each quote and escape character
// dropped, so `gi\t`, `cle^an` and `"g"it` still name git and clean, and env -S's `\_` is a space. A git or discarding word in
// a message, a PR body or an echo reaches none.
const scope = line => {
  let hit
  let opaque = false
  let dynamicHead = false
  for (const windows of [false, true]) {
    const text = joined(line, windows).replace(HEREDOC, '$1')
    opaque ||= SUBSTITUTION.test(text.replace(quoted(windows), ''))
    const live = text.replace(quoted(windows), match => match.startsWith("'") ? '' : match)
    const views = [text, ...[...live.matchAll(new RegExp(SUBSTITUTION, 'g'))].map(match => live.slice(match.index + match[0].length))]
    for (const words of views.flatMap(view => [...commands(view, windows), ...keptCommands(view, windows)])) {
      const at = words.findIndex(word => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) && !LEADS.includes(word))
      if (at === -1) continue
      const [head, ...rest] = words.slice(at)
      if (namesGit(head)) hit ??= gitReach(rest)
      else {
        const run = strip(words.slice(at))[0] ?? ''
        opaque ||= runner(head) || runner(run)
        dynamicHead ||= dynamic(head) || dynamic(run)
        rest.forEach((word, index) => { if (namesGit(word)) hit ??= gitReach(rest.slice(index + 1)) })
      }
    }
  }
  if (hit !== undefined || !(opaque || dynamicHead)) return hit
  const unquoted = [false, true].map(windows => joined(line, windows).replace(HEREDOC, '$1'))
  const loose = text => text.replace(/\\_/g, ' ').replace(/[\\^`'"]/g, '')
  const readings = [false, true].map(windows => [windows, joined(line, windows)])
  const words = readings.flatMap(([windows, text]) => [loose(text), ...commands(text, windows).flat()].flatMap(tokens))
  const aborts = words.some(word => /^--(abort|quit|skip)$/i.test(word))
  const found = words.filter(word => DISCARD_WORDS.includes(word.toLowerCase()) || /^--force-(with-lease|if-includes)/i.test(word)
    || (aborts && ABORTING.includes(word.toLowerCase())))
  const hasGit = words.some(word => namesGit(word) && !wildcardOnly(word))
    || readings.some(([windows, text]) => [...commands(loose(text), windows), ...commands(text, windows)].some(runsGit))
  const reached = (dynamicHead && found.length > 0) || (opaque && hasGit && (found.length > 0 || unquoted.some(t => /[$`]/.test(t))))
  if (!reached) return undefined
  return found.length === 0 ? 'commands' : found[0].startsWith('-') ? 'push' : found[0].toLowerCase()
}

// The commands of a text as commands() reads them but with { } and & kept inside words, as in `stash@{0}`, `2>&1` and
// `xargs -I{} git -C {} clean`.
const KEPT = '{}&'
const keptCommands = (text, windows) => commands(text.replace(/[{}&]/g, char => String.fromCharCode(0xe000 + KEPT.indexOf(char))), windows)
  .map(words => words.map(word => word.replace(/[\ue000-\ue002]/g, char => KEPT[char.charCodeAt(0) - 0xe000])))

// The words of one command of a simple line, which holds { } and & only inside a word or a redirection.
const wordsOf = (text, windows) => keptCommands(text, windows)[0]

// The commands of a simple line, each with the operator after it, or undefined when the guard cannot be sure which words
// run: a quote that never closes, a `\` escape outside single quotes as a POSIX shell reads it, a cmd `^` before a word
// character, or a `#` comment.
const sequence = (text, windows) => {
  const parts = []
  let from = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === "'") {
      index = text.indexOf("'", index + 1)
      if (index === -1) return undefined
    } else if (char === '"') {
      for (index += 1; index < text.length && text[index] !== '"'; index += 1) if (!windows && text[index] === '\\') return undefined
      if (index === text.length) return undefined
    } else if (char === '#' || (windows ? char === '^' && !/^[\d^~\s]?$/.test(text[index + 1] ?? '') : char === '\\')) return undefined
    else if (char === ';' || char === '\n' || (char === '&' && text[index + 1] === '&') || char === '|') {
      parts.push({ words: wordsOf(text.slice(from, index), windows), goesOn: char !== '&' })
      if (char === '&' || (char === '|' && text[index + 1] === '|')) index += 1
      from = index + 1
    }
  }
  parts.push({ words: wordsOf(text.slice(from), windows) })
  return parts.filter(part => part.words)
}

// Whether a git subcommand may discard work in its tree: what check() refuses aimed elsewhere, and stash (but list and show),
// rm, reset (but --soft with no other mode, which git would apply, abbreviated or not), read-tree -u or --reset, a forced or
// whole checkout-index, and an --abort, --quit or --skip of ABORTING.
const discards = (sub, args) => mayDiscardWork(sub, args) || sub === 'rm'
  || (sub === 'branch' && forceDeletesBranch(args))
  || (sub === 'stash' && !['list', 'show'].includes(args[0]))
  || (sub === 'reset' && (!args.includes('--soft')
    || args.some(arg => arg.length > 2 && ['--mixed', '--hard', '--merge', '--keep'].some(mode => mode.startsWith(arg)))))
  || (sub === 'read-tree' && args.some(arg => arg === '--reset' || shortFlags(arg).includes('u')))
  || (sub === 'checkout-index' && args.some(arg => arg === '--force' || arg === '--all' || /[fa]/.test(shortFlags(arg))))
  || (ABORTING.includes(sub) && args.some(arg => ['--abort', '--quit', '--skip'].includes(arg)))

// The folder a cd-like command names: its one path argument, or undefined for a form the guard cannot place (none, `-`,
// a stack entry, a glued drive change). cmd's `cd /d X`, a glued `cd..`/`cd\`, and pwsh's -Path/-LiteralPath are read.
const cdTarget = (rest, head) => {
  const glued = /^(?:cd|chdir)([./\\].*)$/i.exec(head)
  if (glued && !/^\/d$/i.test(glued[1])) return glued[1].startsWith('/') ? undefined : glued[1]
  const args = rest.filter(arg => !CD_OPTIONS.includes(arg.toLowerCase()))
  const flag = rest.find(arg => /^-(?:path|literalpath):./i.test(arg))
  if (flag) return flag.slice(flag.indexOf(':') + 1)
  return args.length === 1 && !/^[-+]/.test(args[0]) ? args[0] : undefined
}

// Whether an argument of a git command that runs a command names git or a discarding subcommand: the argument itself, or any
// word of one that reads as a command line (`rebase -x 'cd .. && git clean -f'`).
const namesCommand = arg => /[\s;&|]/.test(arg)
  ? tokens(arg).some(word => namesGit(word) || DISCARD_WORDS.includes(word.toLowerCase()))
  : /^git(\.exe)?$/i.test(arg.split(/[\\/]/).pop()) || DISCARD_WORDS.includes(arg.toLowerCase())

// A command of a line that reaches a discarding git, as the guard reads it: a cd-like command naming one folder or none
// (a pop), or a plain git command, whose first word is git itself, with only -C, --work-tree, --no-pager or -P before a
// literal subcommand other than config. One that runs a command line with a git or discarding word in it is { script },
// a line the guard cannot check. Anything else is undefined. A message (`commit -m "clean up"`) runs nothing.
const plain = words => {
  if (isRedirect(words[0])) return undefined
  const [head, ...rest] = words.filter(word => !isRedirect(word))
  const name = head.toLowerCase()
  if (CD_WORDS.includes(name) || /^(?:cd|chdir)[./\\]/i.test(head)) {
    if (POP_WORDS.includes(name)) return rest.length ? undefined : { pop: true }
    const target = cdTarget(rest, head)
    return target === undefined ? undefined : { target, push: PUSH_WORDS.includes(name) }
  }
  if (programName(head) !== 'git') {
    if (scope(words.join(' ')) !== undefined || (runner(head) && rest.some(namesGit))
      || ['source', '.', 'eval', 'iex', 'invoke-expression'].includes(name) || dynamic(head) || head.includes(':')
      || /^(?:GIT_|CDPATH=|\$env:)/i.test(head)
      || assignments(words).some(word => /^(?:GIT_|CDPATH=)/i.test(word))) return undefined
    return { hops: [], discard: false }
  }
  if (/[*?[\]{}$%`!=~]/.test(head)) return undefined
  const hops = []
  let index = 0
  while (rest[index]?.startsWith('-')) {
    const option = rest[index]
    if (option === '-C' || option === '--work-tree') {
      hops.push([option, rest[index + 1]])
      index += 1
    } else if (option.startsWith('--work-tree=')) hops.push(['--work-tree', option.slice('--work-tree='.length)])
    else if (option !== '--no-pager' && option !== '-P') return undefined
    index += 1
  }
  const [sub = '', ...args] = rest.slice(index)
  if (!/^[a-z][a-z-]*$/.test(sub) || sub === 'config') return undefined
  if (runsScript(sub, args) && args.some(namesCommand)) return { script: sub }
  return {
    sub, hops, discard: args.some(arg => /[$`%]/.test(arg)) || discards(sub, args),
    lease: sub === 'push' && args.some(arg => arg.startsWith('--force-with-lease=')),
  }
}

const segments = (target, path) => target.split(path.sep === '\\' ? /[\\/]/ : '/')

// Where a folder is on disk, links resolved, for the part of it that exists. A folder of the other platform's paths stays
// as written; null when the disk cannot answer.
const real = (dir, path) => {
  if (path !== nodePath) return dir
  let head = dir
  while (!existsSync(head) && path.dirname(head) !== head) head = path.dirname(head)
  try {
    return path.join(realpathSync.native(head), path.relative(head, dir))
  } catch {
    return null
  }
}

const folded = (dir, path) => path.sep === '\\' ? dir.replace(/^\\\\\?\\/, '').toLowerCase() : dir

const within = (dir, seat, path) => {
  if (dir === null) return false
  const inner = real(dir, path)
  if (inner === null || seat === null) return false
  const folder = folded(inner, path)
  return folder === seat || folder.startsWith(seat.endsWith(path.sep) ? seat : seat + path.sep)
}

// Where `target` leads from `place` as the system resolves it: each link followed before the `..` after it.
const physical = (place, target, path) => {
  let dir = path.isAbsolute(target) ? path.parse(path.resolve(place, target)).root : real(place, path)
  for (const part of segments(target, path)) {
    if (dir === null) return null
    if (part === '..') dir = path.dirname(dir)
    else if (part && part !== '.') dir = real(path.join(dir, part), path)
  }
  return dir
}

// A folder the guard can place: no variable, `~`, glob, brace, `!` or `%` expansion, and no PowerShell drive or provider
// (`Temp:`, `FileSystem::`) but a drive letter's.
const placeable = target => Boolean(target) && !/^~|[$%!*?[\]{}`]/.test(target) && !target.replace(/^[A-Za-z]:[\\/]/, '').includes(':')

// Each folder a cd or a -C to `target` lands in: where the shell spells it, and, after a `..`, where the system resolves
// it through any link. null where the target is one the guard cannot place.
const moved = (places, target, path) => {
  if (!placeable(target)) return [null]
  // A backslash in a path argument is a separator, as PowerShell and cmd read it, even when the folders are resolved the
  // POSIX way; without this a `Set-Location ..\..` escapes a POSIX reading, which treats the backslash as an ordinary character.
  const to = target.replace(/\\/g, path.sep)
  return places.flatMap(place => place === null ? [null]
    : [path.resolve(place, to), ...(path === nodePath && segments(to, path).includes('..') ? [physical(place, to, path)] : [])])
}

// A cd to a bare relative name (not ./ ../ absolute or ~) searches CDPATH when it is set, so it may land in any folder
// CDPATH lists: the guard cannot place it.
const searched = target => !/^(?:\.{1,2}(?:[\\/]|$)|[\\/]|~|[A-Za-z]:)/.test(target)

const placeRules = (own, path, cdpath) => {
  const seat = real(path.resolve(own), path)
  return {
    path,
    cdpath: Boolean(cdpath),
    seat: seat === null ? null : folded(seat, path),
    refuse: (sub, others) => others
      ? `Run git ${sub} only inside this seat's folder, ${own}: this line also runs ${others}. Run the git command as its own call.`
      : `Run git ${sub} only inside this seat's folder, ${own}: this line runs it elsewhere, or where the guard cannot tell. `
        + `Run the git command as its own plain call, optionally after a plain cd to a folder inside ${own}.`,
    script: sub => `git ${sub} here runs a command line the guard cannot check, on a line that may reach a git command that discards `
      + 'work. Run those commands as separate calls instead.',
    lease: `Force-push with a lease only from the folder the command starts in, inside this seat's folder, ${own}, onto the branch checked out there.`,
  }
}

const inside = (folders, rules) => folders.length > 0 && folders.every(dir => within(dir, rules.seat, rules.path))

// Why a plain line is refused, or undefined when each discarding git command on it runs inside the seat's folder, followed
// from `start` through the cd-like commands before it. A cd that fails leaves the shell where it was, and after a `;` or
// newline the line goes on: every folder since the last one stays possible, and a popd may then land wherever a pushd
// left. After a git command a folder must exist already, since the command may have made it a link.
const walk = (parts, start, rules, sub) => {
  const { path } = rules
  let places = [...start]
  let since = [...start]
  const stack = []
  const pushed = []
  let stacked = false
  let unsure = false
  let gitRan = false
  const hop = (from, to) => {
    const next = moved(from, to, path)
    if (!gitRan || next.includes(null)) return next
    const target = to.replace(/\\/g, path.sep)
    return from.every(place => existsSync(path.isAbsolute(target) ? target : place + path.sep + target)) ? next : [null]
  }
  const last = parts.findLastIndex(({ command }) => command.discard || command.lease)
  for (const { command, goesOn } of parts.slice(0, last + 1)) {
    if (command.pop) {
      if (!unsure && stack.length === 0) return rules.refuse(sub)
      places = unsure ? [...places, ...pushed.flat()] : stack.pop()
      if (unsure) stack.pop()
      stacked = true
    } else if (command.target !== undefined) {
      if (rules.cdpath && searched(command.target)) return rules.refuse(sub)
      if (command.push) {
        stack.push(places)
        pushed.push(places)
        stacked = true
      }
      places = hop(places, command.target)
      if (places.includes(null)) return rules.refuse(sub)
    } else {
      let dirs = places
      let tree
      for (const [option, to] of command.hops) {
        if (option === '-C') dirs = hop(dirs, to)
        else tree = to
      }
      const folders = tree === undefined ? dirs : hop(dirs, tree)
      if (command.lease && !(inside(folders, rules) && folders.every(dir => start.some(base => samePath(dir, base, path))))) return rules.lease
      if (command.discard && !inside(folders, rules)) return rules.refuse(command.sub)
      gitRan = true
    }
    since.push(...places)
    if (goesOn) {
      places = [...new Set(since)]
      since = [...places]
      unsure ||= stacked
    }
  }
  return undefined
}

// codex on Windows may hand over a line inside its PowerShell wrapper, `"C:\…\powershell.exe" -NoProfile -Command '<line>'`.
// A line of exactly that shape, from powershell or pwsh, with -NoProfile, -NoLogo or -NonInteractive or none, the line quoted
// either way, is the line inside it, read as PowerShell reads it.
const WRAPPER = /^\s*(?:"(?:[^"]*[\\/])?(?:powershell|pwsh)(?:\.exe)?"|(?:[^\s"']*[\\/])?(?:powershell|pwsh)(?:\.exe)?)(?:\s+-(?:NoProfile|NoLogo|NonInteractive))*\s+-Command\s+(?:'([^']*)'|"([^"]*)")\s*$/i

// The programs of a line's commands but git and cd: a here-document's body is the input of its command, and the `&` of a
// `>&` or `<&` redirection ends no command.
const otherCommands = (text, windows) => {
  const others = []
  const lines = text.replace(ANY_HEREDOC, '$1').replace(/([<>])&/g, '$1')
  for (const words of commands(lines, windows)) {
    const clean = words.filter(word => !isRedirect(word))
    const first = clean.find(word => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
    if (!first) continue
    const name = programName(first)
    if (!name || CD_WORDS.includes(name) || /^(?:cd|chdir)[./\\]/i.test(first) || name === 'git') continue
    if (CONTROL_WORDS.split('|').includes(name) || LEADS.includes(name)) continue
    others.push(name)
  }
  return [...new Set(others)]
}

// Discarding Git commands must stay inside the seat even beside other commands or pipes. A Windows path's
// backslashes are separators; Claude's Bash tool on Windows still needs the POSIX reading too.
const stray = (line, start, rules, bash) => {
  const script = WRAPPER.exec(line)?.slice(1).find(inner => inner !== undefined)
  const sub = scope(script ?? line)
  if (sub === undefined) return undefined
  for (const windows of script === undefined && (bash || /\\\r?\n/.test(line) || !(rules.path.sep === '\\' && line.includes('\\'))) ? [false, true] : [true]) {
    const text = joined(script ?? line, windows)
    const parts = notSimpleLine(text) ? undefined : sequence(text, windows)?.map(({ words, goesOn }) => ({ command: plain(words), goesOn }))
    if (parts === undefined || parts.some(({ command }) => command === undefined)) {
      const others = otherCommands(text, windows)
      return rules.refuse(sub, others.length ? others.join(', ') : undefined)
    }
    const runs = parts.find(({ command }) => command.script)
    if (runs) return rules.script(runs.command.script)
    const reason = walk(parts, start, rules, sub)
    if (reason) return reason
  }
  return undefined
}

/**
 * Why an owner seat's command line is refused, or undefined when it may run: whatever check() refuses, and then, with the
 * seat's folder known (`own`), a line that may reach a discarding git command (clean -f, checkout, restore, a forced switch,
 * stash, rm, reset but --soft, read-tree -u, checkout-index -f, a rebase or merge --abort, --quit or --skip, a leased push)
 * unless the line keeps each such git command inside that folder. With no folder known,
 * check() alone: a Claude subagent owner's hook input carries the parent session's folder, not the seat's. With `cdpath`
 * set (the hook's CDPATH), a cd to a bare relative name may land anywhere it lists, so the line is refused. `bash` says
 * the line runs in Claude Code's Bash tool, a POSIX shell on every host. `checkedOutBranches`: the branches the worktree
 * checked out, which a push may delete besides `seat/<id>`.
 */
export const guard = (line, branch, cwd = process.cwd(), path = nodePath, own = undefined, cdpath = undefined, bash = false, checkedOutBranches = []) => {
  line = interpreterData(line)
  return check(line, branch, cwd, path, own, seatBranches(own, path), cdpath) ?? pushCheck(line, [...seatBranches(own, path), ...checkedOutBranches.filter(name => !DEFAULT_BRANCHES.includes(name))])
    ?? (own === undefined ? undefined : stray(line, [path.resolve(cwd)], placeRules(own, path, cdpath), bash))
}

// A reviewer seat in a worktree runs outside its vendor's sandbox, as an owner does, but its work is its report: it checks
// out, builds and tests in its worktree and leaves every branch, remote and the main checkout as they were.
const REVIEWER_REFUSED = ['commit', 'push', 'pull', 'merge', 'rebase', 'cherry-pick', 'revert', 'am', 'update-ref']
const REVIEWER_REASON = 'A reviewer seat does not commit, push, merge, rebase, tag or change a branch: check out what you review '
  + '(git fetch, then git checkout <sha>) in your worktree and report.'
const PR_REASON = 'A reviewer seat does not open or merge a pull request, nor change a branch or ref through the API: report instead.'
const LISTS = ['-l', '--list', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '-n', '--show-current', '--contains', '--no-contains',
  '--merged', '--no-merged', '--points-at', '--verify']
const BRANCH_WRITES = /[dDmMcCfu]/
const TAG_WRITES = /[dasufmFe]/
const FETCH_VALUE_OPTIONS = ['--depth', '--deepen', '--shallow-since', '--shallow-exclude', '-j', '--jobs', '--upload-pack', '-o', '--server-option',
  '--refmap', '--negotiation-tip', '--recurse-submodules-default']
const API_VALUE_OPTIONS = ['-X', '--method', '-f', '-F', '--field', '--raw-field', '-H', '--header', '--input', '-q', '--jq', '-t', '--template',
  '--hostname', '--cache', '-p', '--preview']
// REST endpoints that open or merge a pull request, merge a branch or move a ref, and GraphQL's mutations that do the same.
const API_WRITES = [/\/pulls\/?$/, /\/pulls\/\d+\/merge\/?$/, /\/merges\/?$/, /\/merge-upstream\/?$/, /\/git\/refs(\/|$)/]
const GRAPHQL_WRITES = /\b(createPullRequest|mergePullRequest|enablePullRequestAutoMerge|mergeBranch|createRef|updateRef|updateRefs|deleteRef|createCommitOnBranch)\b/

const listsOnly = args => args.some(arg => LISTS.includes(arg.split('=')[0]))

const detached = args => args.some(arg => arg === '-d' || longOption(arg, '--detach'))

const REMOTE_WRITES = ['add', 'set-url', 'remove', 'rm', 'rename', 'set-head', 'set-branches']
const CONFIG_WRITES = ['--add', '--replace-all', '--unset', '--unset-all', '--remove-section', '--rename-section', '--edit']
const CONFIG_READ_OPTIONS = ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list']

// Whether git config writes a setting in any scope: a write action or subcommand, or a key followed by a value.
const configWrites = args => {
  const plainArgs = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--') {
      plainArgs.push(...args.slice(index + 1))
      break
    }
    if (arg === '-e' || longOption(arg, ...CONFIG_WRITES)) return true
    if (arg === '-l' || longOption(arg, ...CONFIG_READ_OPTIONS)) return false
    if (CONFIG_VALUE_OPTIONS.includes(arg)) index += 1
    else if (!arg.startsWith('-')) plainArgs.push(arg)
  }
  if (['get', 'list'].includes(plainArgs[0] ?? '')) return false
  return ['set', 'unset', 'rename-section', 'remove-section', 'edit'].includes(plainArgs[0] ?? '') || plainArgs.length > 1
}

/**
 * What the reviewer guard asks of the repository a command runs in. `kind(name)`: 'branch' for a local branch (or `-`
 * naming one), 'commit' for another name of a commit, 'remote' for a name git checkout would make a branch of from a
 * remote branch, undefined otherwise. `alias(name)`: the alias git would run for `git <name>`, or undefined.
 * @typedef {{ kind: (name: string) => string | undefined, alias: (name: string) => string | undefined }} Repo
 */
/** @type {Repo} */
const NO_REPO = { kind: () => undefined, alias: () => undefined }

// Whether a git subcommand a reviewer runs changes a branch, a tag, a ref, a remote or a setting the repository's
// worktrees share, or moves the worktree onto a branch.
const reviewerGit = (sub, rest, repo) => {
  if (REVIEWER_REFUSED.includes(sub)) return true
  const plainArgs = rest.filter(arg => !arg.startsWith('-'))
  if (sub === 'branch') {
    return rest.some(arg => BRANCH_WRITES.test(shortFlags(arg)) || longOption(arg, '--delete', '--move', '--copy', '--force', '--set-upstream-to',
      '--unset-upstream', '--edit-description', '--track', '--no-track', '--create-reflog')) || (plainArgs.length > 0 && !listsOnly(rest))
  }
  if (sub === 'tag') {
    return rest.some(arg => TAG_WRITES.test(shortFlags(arg)) || longOption(arg, '--delete', '--annotate', '--sign', '--local-user', '--force',
      '--message', '--file', '--edit', '--create-reflog')) || (plainArgs.length > 0 && !listsOnly(rest))
  }
  if (sub === 'checkout') {
    const targets = rest.filter(arg => arg === '-' || !arg.startsWith('-'))
    if (rest.some(arg => /[bBt]/.test(shortFlags(arg)) || longOption(arg, '--orphan', '--track'))) return true
    return !detached(rest) && !rest.includes('--') && !rest.some(arg => arg === '-p' || longOption(arg, '--patch', '--pathspec-from-file'))
      && targets.length === 1 && ['branch', 'remote'].includes(repo.kind(targets[0]) ?? '')
  }
  // switch takes a branch unless detached, and makes one from a remote branch of the same name (--guess).
  if (sub === 'switch') return !detached(rest)
  if (sub === 'worktree') return rest[0] !== 'list'
  if (sub === 'config') return configWrites(rest)
  if (sub === 'remote') return REMOTE_WRITES.includes(plainArgs[0] ?? '')
  if (sub === 'fetch') {
    const specs = []
    for (let index = 0; index < rest.length; index += 1) {
      if (FETCH_VALUE_OPTIONS.includes(rest[index])) index += 1
      else if (!rest[index].startsWith('-')) specs.push(rest[index])
    }
    // A refspec's destination is a local branch when it is a bare name or under refs/heads/, a tag under refs/tags/.
    return specs.slice(1).some(spec => {
      const target = spec.includes(':') ? spec.slice(spec.indexOf(':') + 1) : ''
      return target !== '' && (!target.startsWith('refs/') || /^refs\/(heads|tags)\//.test(target))
    })
  }
  return false
}

const reviewerApi = args => {
  let method
  let fields = false
  let endpoint
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    const [name, glued] = arg.startsWith('--') ? [arg.split('=')[0], arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : undefined]
      : /^-[A-Za-z]./.test(arg) ? [arg.slice(0, 2), arg.slice(2)] : [arg, undefined]
    if (name === '-X' || name === '--method') method = glued ?? args[index + 1]
    if (['-f', '-F', '--field', '--raw-field', '--input'].includes(name)) fields = true
    if (API_VALUE_OPTIONS.includes(name)) {
      if (glued === undefined) index += 1
    } else if (!arg.startsWith('-')) endpoint ??= arg
  }
  if (endpoint === 'graphql') return args.some(arg => GRAPHQL_WRITES.test(arg))
  const verb = (method ?? (fields ? 'POST' : 'GET')).toUpperCase()
  return verb !== 'GET' && endpoint !== undefined && API_WRITES.some(pattern => pattern.test(endpoint.split('?')[0]))
}

const WRITERS = ['rm', 'rmdir', 'mv', 'touch', 'mkdir', 'tee', 'chmod', 'chown', 'truncate', 'remove-item', 'ri', 'del', 'erase', 'rd',
  'move-item', 'mi', 'move', 'new-item', 'ni', 'set-content', 'sc', 'add-content', 'ac', 'out-file', 'clear-content']
// Programs that write only their last argument: what they copy from may be read anywhere.
const COPIERS = ['cp', 'ln', 'install', 'rsync', 'copy-item', 'cpi', 'copy']
const GIT_ENV = /^(?:\$env:)?(GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_INDEX_FILE)=(.*)$/i
const MAIN_REASON = main => `Leave the main checkout (${main.join(', ')}) as it is: run git, folder changes and writes only in your own worktree.`

// A here-document's body is the input of its command, which runs it only when that command is a shell.
const heredocsDropped = line => line.replace(ANY_HEREDOC, (whole, opener, _quote, _delimiter, _body, offset) => {
  const header = line.slice(line.lastIndexOf('\n', offset - 1) + 1, offset)
  return SHELLS.includes(programName(strip(commands(header).at(-1) ?? [])[0] ?? '')) ? whole : opener
})

/** Whether `dir` is in one of the `main` checkouts and not in the seat's own folder. */
const mainFence = (main, own, path) => {
  const roots = main.map(dir => real(path.resolve(dir), path)).filter(dir => dir !== null).map(dir => folded(dir, path))
  const seat = own === undefined ? null : real(path.resolve(own), path)
  return dir => dir !== null && roots.some(root => within(dir, root, path)) && !(seat !== null && within(dir, folded(seat, path), path))
}

// A word of a command line, quoted so a POSIX shell reads it back as the same word.
const shellWord = word => /^[\w@%+=:,./-]+$/.test(word) ? word : "'" + word.replaceAll("'", "'\\''") + "'"

const CD_REASON = 'After a cd to a folder the guard cannot place, write or run a git command that writes only at an absolute path, or cd to a '
  + 'literal path or one through environment variables this shell already has, as in cd "$TMPDIR": the guard cannot tell where this cd lands.'
const ALIAS_DEPTH = 10

const TARGET_REASON = 'Point a git command that writes (-C, --git-dir, --work-tree, GIT_DIR, GIT_WORK_TREE) only at a literal path or one '
  + 'through environment variables this shell already has, as in "$TMPDIR/repo": the guard cannot tell where this one lands.'

// git subcommands that change no file, ref or setting once reviewerGit has passed them: they run with a target the guard
// cannot place. A fetch reviewerGit passes writes only remote-tracking refs.
const GIT_READS = ['', 'log', 'show', 'diff', 'status', 'rev-parse', 'cat-file', 'ls-files', 'ls-tree', 'ls-remote', 'grep', 'fetch', 'blame',
  'describe', 'shortlog', 'rev-list', 'show-ref', 'for-each-ref', 'merge-base', 'name-rev', 'diff-tree', 'diff-files', 'diff-index', 'show-branch',
  'whatchanged', 'cherry', 'range-diff', 'check-ignore', 'check-attr', 'count-objects', 'var', 'version', 'help', 'branch', 'tag', 'config',
  'remote', 'worktree']

// A cd-like command whose folder comes from a command substitution or a PowerShell expression.
const SUBSTITUTED_CD = /(?:^|[;&|(){}\n])\s*(?:cd|chdir|pushd|sl|set-location|push-location)\s+[^\n;&|]*?(?:\$\(|`|\(|<\()/i

// The line with each quoted string's parentheses dropped but a `$(`'s: a parenthesis in a quoted path is part of its name,
// and a single-quoted string expands nothing in either shell.
const quotedParensDropped = line => line.replace(quoted(false), text => text.startsWith("'") ? "''" : text.replace(/(?<!\$)\(|\)/g, ''))

// A target with `~`, `$PWD` and the environment variables it reads expanded from `env`, or undefined when it reads a
// variable the line assigns or `env` lacks, a command substitution, or `~user`.
const expandedTarget = (target, env, line, windows) => {
  const value = name => {
    const assigned = new RegExp('(?:^|[\\s;&|(]|\\$env:)' + name + '\\s*=|\\b(?:for|read|select|set)\\s+(?:-\\S+\\s+)*' + name + '\\b', 'i')
    if (assigned.test(line)) return undefined
    const key = windows ? Object.keys(env).find(each => each.toLowerCase() === name.toLowerCase()) : name
    return key === undefined ? undefined : env[key]
  }
  // A variable it cannot read leaves a `$`, which no folder the guard places has.
  const expanded = target.replace(/^~(?=$|[\\/])/, () => value('HOME') ?? value('USERPROFILE') ?? '$')
    .replace(/^\$\{?PWD\}?(?=$|[\\/])/, '.')
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)|%([A-Za-z_][A-Za-z0-9_]*)%/g,
      (_whole, ...names) => value(names.slice(0, 4).find(Boolean)) ?? '$')
  return /[$`]|^~/.test(expanded) ? undefined : expanded
}

// The folder a cd target names once expanded, or undefined when it cannot be expanded or names a folder no other way the
// guard can place.
const resolvedTarget = (target, env, line, windows) => {
  const expanded = expandedTarget(target, env, line, windows)
  return expanded !== undefined && placeable(expanded) ? expanded : undefined
}

// Each folder `at` lands in from `places`: an absolute path lands where it names, whatever folder a cd left the line in.
const landing = (places, at, path) => moved(path.isAbsolute(at) ? [path.parse(path.resolve(at)).root] : places, at, path)

// Where a git or write target lands, expanded as a cd's is: a path to place, null when it reads a variable or a command
// substitution the guard cannot expand, or undefined when it names no path the guard places (`user:group`, a PowerShell
// drive). A glob lands under the folder before its first wildcard. PowerShell's `$null` names no file.
const targetPath = (target, ctx, windows) => {
  if (/^\$null$/i.test(target)) return undefined
  const expanded = /[$`]|%[A-Za-z_]\w*%|^~(?=$|[\\/])/.test(target) ? expandedTarget(target, ctx.env, ctx.raw, windows) : target
  if (expanded === undefined) return null
  const wildcard = expanded.search(/[*?[\]{}]/)
  const fixed = wildcard === -1 ? expanded : expanded.slice(0, wildcard).replace(/[^\\/]*$/, '') || '.'
  return placeable(fixed) ? fixed : undefined
}

// The files an apply_patch envelope adds, updates, deletes or moves to: codex's file-edit tool, or its CLI form run in a shell.
export const patchFiles = text => [...text.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$/gm)].map(match => match[1])

function reviewerRefusal(words, places, ctx, windows) {
  const { path, inMain, main } = ctx
  // Where a git or write target lands: [] when the guard cannot expand it, null among them under a folder a cd left unplaced.
  const lands = target => {
    const at = targetPath(target, ctx, windows)
    return at === null || at === undefined ? [] : landing(places, at, path)
  }
  // Why a write may not go to `target`: it lands in the main checkout, or under a folder a cd left unplaced. A target the
  // guard cannot expand runs, as Claude Code's own worktree isolation lets it.
  const aimed = target => {
    const at = lands(target)
    return at.some(inMain) ? MAIN_REASON(main) : at.includes(null) ? CD_REASON : undefined
  }
  const firstAimed = targets => targets.map(aimed).find(Boolean)
  // A git target in the main checkout is refused; one the guard cannot expand leaves git unplaced, to run only if it reads.
  let unplaced = false
  const gitAimed = target => {
    if (targetPath(target, ctx, windows) === null) unplaced = true
    return lands(target).some(inMain) ? MAIN_REASON(main) : undefined
  }
  const gitEnv = assignments(words).flatMap(word => GIT_ENV.test(word) ? [GIT_ENV.exec(word)?.[2] ?? ''] : []).map(gitAimed).find(Boolean)
  if (gitEnv) return gitEnv
  const redirected = words.flatMap((word, index) => {
    const glued = /^(?:\d+|&)?>>?\|?([^>|].*)$/.exec(word)
    return glued ? [glued[1]] : /^(?:\d+|&)?>>?\|?$/.test(word) && words[index + 1] !== undefined ? [words[index + 1]] : []
  })
  const redirect = firstAimed(redirected)
  if (redirect) return redirect
  const [first, ...args] = strip(words.filter(word => !isRedirect(word)))
  if (!first) return undefined
  const name = programName(first)
  // A program but git may run git that writes, through a GIT_DIR or GIT_WORK_TREE the guard cannot place.
  if (unplaced && name !== 'git') return TARGET_REASON
  if (SHELLS.includes(name)) {
    const script = shellScript(args)
    return script === undefined ? undefined : reviewerLine(script, places, ctx)
  }
  if (name === 'git') {
    let index = 0
    let dirs = places
    while (index < args.length && args[index].startsWith('-')) {
      const option = args[index]
      const value = ['-C', '--git-dir', '--work-tree'].includes(option) ? args[index + 1]
        : /^--(git-dir|work-tree)=/.test(option) ? option.slice(option.indexOf('=') + 1) : undefined
      const reason = value === undefined ? undefined : gitAimed(value)
      if (reason) return reason
      const at = value === undefined ? undefined : targetPath(value, ctx, windows)
      if (option === '-C' && at) dirs = landing(dirs, at, path)
      index += GIT_VALUE_OPTIONS.includes(option) ? 2 : 1
    }
    if (dirs.some(inMain)) return MAIN_REASON(main)
    const sub = args[index] ?? ''
    const rest = args.slice(index + 1)
    // git runs an alias in place of a subcommand it does not have: a `!` alias as a shell command with the arguments after it.
    const given = args.slice(0, index).flatMap((option, at, options) => option === '-c' ? [options[at + 1] ?? ''] : [])
      .map(setting => new RegExp('^alias\\.' + sub.replace(/[^\w-]/g, '') + '=(.*)$', 'is').exec(setting)?.[1]).findLast(value => value !== undefined)
    const alias = /^[A-Za-z0-9][\w-]*$/.test(sub) ? given ?? ctx.repo.alias(sub) : undefined
    if (alias !== undefined) {
      if (ctx.depth >= ALIAS_DEPTH) return 'Run git commands without nested aliases: this alias expands too deep for the guard to check.'
      const expansion = alias.startsWith('!') ? [alias.slice(1), ...rest.map(shellWord)].join(' ')
        : ['git', ...args.slice(0, index).map(shellWord), alias, ...rest.map(shellWord)].join(' ')
      return ctx.recheck(expansion, places.find(place => place !== null) ?? '.')
    }
    if (reviewerGit(sub, rest, ctx.repo)) return REVIEWER_REASON
    if (GIT_READS.includes(sub)) return undefined
    return unplaced ? TARGET_REASON : dirs.includes(null) ? CD_REASON : undefined
  }
  if (name === 'gh') {
    const plainWords = args.filter(arg => !arg.startsWith('-'))
    if (plainWords.some((word, at) => word === 'pr' && ['create', 'new', 'merge'].includes(plainWords[at + 1]))) return PR_REASON
    if (plainWords.some((word, at) => word === 'pr' && ['checkout', 'co'].includes(plainWords[at + 1])) && !args.includes('--detach')) {
      return 'Check out a pull request detached, without making a branch: gh pr checkout <n> --detach.'
    }
    const api = args.indexOf('api')
    return api !== -1 && reviewerApi(args.slice(api + 1)) ? PR_REASON : undefined
  }
  const targets = args.filter(arg => !arg.startsWith('-'))
  const inPlace = name === 'sed' && args.some(arg => /^-[a-z]*i/.test(arg) || longOption(arg, '--in-place'))
  // sed's first plain word is its script unless -e, --expression, -f or --file gives one.
  const scripted = args.some(arg => /^-[a-z]*[ef]/.test(arg) || longOption(arg, '--expression', '--file'))
  if (WRITERS.includes(name) || inPlace) return firstAimed(inPlace && !scripted ? targets.slice(1) : targets)
  if (COPIERS.includes(name) && targets.length > 1) return aimed(targets.at(-1) ?? '')
  return undefined
}

// `starts` are the folders the line may start in, null among them for one a cd left unplaced.
function reviewerLine(line, starts, ctx) {
  const { path, inMain, main } = ctx
  const raw = ctx.raw ?? line
  if (patchFiles(line).some(file => starts.some(start => start !== null && inMain(path.resolve(start, file))))) return MAIN_REASON(main)
  // The shell splits a substituted cd's `$(...)` into commands of their own, leaving the cd without a folder.
  const substituted = SUBSTITUTED_CD.test(quotedParensDropped(line))
  for (const windows of [false, true]) {
    let places = starts
    for (const words of commands(line, windows)) {
      const [head, ...rest] = words.filter(word => !isRedirect(word))
      if (head !== undefined && (CD_WORDS.includes(head.toLowerCase()) || /^(?:cd|chdir)[./\\]/i.test(head))) {
        if (POP_WORDS.includes(head.toLowerCase())) continue
        const written = cdTarget(rest, head)
        // zsh's `cd old new` swaps old for new in the current folder's path. A cd the guard cannot place adds an unplaced
        // folder (null): what follows runs unless it writes, or runs git that writes, under a relative path.
        if (written === undefined && !substituted && rest.filter(arg => !arg.startsWith('-')).length < 2) continue
        const target = written === undefined ? undefined : resolvedTarget(written, ctx.env, raw, windows)
        places = [...new Set([...places, ...(target === undefined ? [null] : landing(places, target, path))])]
        if (places.some(inMain)) return MAIN_REASON(main)
        continue
      }
      const reason = reviewerRefusal(words, places, ctx, windows)
      if (reason) return reason
    }
  }
  return undefined
}

/**
 * Why a reviewer seat's command line is refused, or undefined when it may run: whatever guard() refuses an owner, and
 * then a commit, push, pull, merge, rebase, cherry-pick, revert, am, a tag, a branch or ref change (a fetch into a local
 * branch or tag among them), a checkout or switch onto a branch, a git config or remote write, git worktree but list,
 * gh pr create or merge and the API calls that do the same, a git command, a folder change or a write aimed at a `main`
 * checkout, any command run from one, and a cd whose folder the guard cannot place. A git alias is checked as what it
 * runs. `own` is the seat's folder; `repo` answers for the repository the line runs in (see Repo); `env` expands a cd's
 * variables.
 */
export const reviewerGuard = (line, branch, cwd = process.cwd(), path = nodePath, own = undefined, main = [], cdpath = undefined, bash = false,
  checkedOutBranches = [], repo = NO_REPO, env = process.env, depth = 0) => {
  const inMain = mainFence(main, own, path)
  const recheck = (expanded, at) => reviewerGuard(expanded, branch, at, path, own, main, cdpath, bash, checkedOutBranches, repo, env, depth + 1)
  const text = heredocsDropped(interpreterData(line))
  return guard(line, branch, cwd, path, own, cdpath, bash, checkedOutBranches)
    ?? (inMain(path.resolve(cwd)) ? MAIN_REASON(main)
      : patchFiles(line).some(file => inMain(path.resolve(cwd, file))) ? MAIN_REASON(main)
      : reviewerLine(text, [path.resolve(cwd)], { path, inMain, main, repo, env, recheck, depth, raw: line }))
}

/** Why a reviewer's file tool may not write `file`: it is in a `main` checkout. */
export const reviewerFileGuard = (file, cwd = process.cwd(), path = nodePath, own = undefined, main = []) =>
  mainFence(main, own, path)(path.resolve(cwd, file)) ? MAIN_REASON(main) : undefined

// The hook runs whatever link its path came through (macOS's /var, a linked plugin folder, a Windows junction), where
// argv[1] and the module's own path differ; a path that cannot be resolved runs it too, since a silent guard allows all.
const invoked = () => {
  try {
    return realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url))
  } catch {
    return true
  }
}

// agy on Windows hands the hook command to node with its quotes still on a path that has a space.
const values = flag => process.argv.flatMap((arg, at) => arg === flag && process.argv[at + 1] !== undefined
  ? [process.argv[at + 1].replace(/^"(.*)"$/s, '$1')] : [])

// codex's apply_patch, agy's file tools and Claude's name the files they write; agy's take the path as Path or TargetFile.
const AGY_WRITES = /write|edit|replace|create|delete|move|rename/i
const writtenFiles = input => {
  if (input.tool_name === 'apply_patch') return patchFiles(String(input.tool_input?.command ?? ''))
  const call = input.toolCall
  if (call !== undefined) {
    if (call.args?.CommandLine !== undefined || !AGY_WRITES.test(String(call.name ?? ''))) return []
    return Object.entries(call.args ?? {}).filter(([key, value]) => /(path|file)$/i.test(key) && typeof value === 'string').map(([, value]) => value)
  }
  const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path
  return typeof file === 'string' ? [file] : []
}

/** The repository at `cwd` as reviewerGuard asks of it. @returns {Repo} */
const repoAt = cwd => {
  const git = (...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })
  /** @type {Set<string> | undefined} */
  let commands
  return {
    kind: name => {
      if (name === '-') {
        const full = git('rev-parse', '--symbolic-full-name', '@{-1}').stdout?.trim() ?? ''
        return full.startsWith('refs/heads/') ? 'branch' : full ? 'commit' : undefined
      }
      if (git('show-ref', '--verify', '--quiet', 'refs/heads/' + name).status === 0) return 'branch'
      if (git('rev-parse', '--verify', '--quiet', name + '^{commit}').status === 0) return 'commit'
      return git('for-each-ref', '--count=1', '--format=%(refname)', 'refs/remotes/*/' + name).stdout?.trim() ? 'remote' : undefined
    },
    // git ignores an alias that has the name of one of its commands.
    alias: name => {
      const found = git('config', '--get', 'alias.' + name)
      if (found.status !== 0) return undefined
      commands ??= new Set((git('--list-cmds=builtins,main,others').stdout ?? '').split('\n'))
      return commands.has(name) ? undefined : found.stdout.replace(/\r?\n$/, '')
    },
  }
}

if (invoked()) {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
  const agy = input.toolCall !== undefined
  const command = agy ? input.toolCall.args?.CommandLine : input.tool_name === 'apply_patch' ? undefined : input.tool_input?.command
  const line = typeof command === 'string' ? command : undefined
  const cwd = input.toolCall?.args?.Cwd ?? input.workspacePaths?.[0] ?? input.cwd ?? process.cwd()
  const own = values('--own')[0]
  const reviewer = process.argv.includes('--reviewer')
  const main = values('--main')
  const branch = () => spawnSync('git', ['-C', cwd, 'branch', '--show-current'], { encoding: 'utf8', windowsHide: true }).stdout?.trim()
  // codex names its shell tool Bash too, though on Windows it runs PowerShell; only Claude's hook passes --claude.
  const bash = process.argv.includes('--claude') && input.tool_name === 'Bash'
  const checkedOutHere = () => {
    const gitDir = spawnSync('git', ['-C', cwd, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8', windowsHide: true }).stdout?.trim()
    const reflog = gitDir ? nodePath.join(gitDir, 'logs', 'HEAD') : undefined
    return reflog && existsSync(reflog) ? checkedOut(readFileSync(reflog, 'utf8')) : []
  }
  const pushes = line !== undefined && /\b(push|branch)\b/.test(line)
  const pushed = pushes ? branch() : undefined
  const checked = pushes ? checkedOutHere() : []
  const reason = line === undefined ? (reviewer ? writtenFiles(input).map(file => reviewerFileGuard(file, cwd, nodePath, own, main)).find(Boolean) : undefined)
    : reviewer ? reviewerGuard(line, pushed, cwd, nodePath, own, main, process.env.CDPATH, bash, checked, repoAt(cwd))
    : guard(line, pushed, cwd, nodePath, own, process.env.CDPATH, bash, checked)
  const name = 'seat-router ' + (reviewer ? 'reviewer' : 'owner') + ' guard: '
  if (reason && agy) process.stdout.write(JSON.stringify({ decision: 'deny', reason: name + reason }) + '\n')
  else if (reason) {
    // codex shows the reason followed by ". Command: <line>".
    const hookSpecificOutput = { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: name + reason.replace(/\.$/, '') }
    process.stdout.write(JSON.stringify({ hookSpecificOutput }) + '\n')
  }
}
