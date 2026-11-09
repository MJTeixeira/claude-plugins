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
import { homedir } from 'node:os'
import nodePath from 'node:path'
import { fileURLToPath } from 'node:url'

const SHELLS = ['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'cmd']
const WRAPPERS = ['command', 'builtin', 'exec', 'nohup', 'time', 'sudo', 'doas', 'xargs', 'nice']
const GIT_VALUE_OPTIONS = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']
const REMOVERS = ['rm', 'remove-item', 'ri', 'del', 'erase', 'rd', 'rmdir']
// cmd ignores a leading @ and ends an internal command's name at a slash, so @rd/s/q is rd /s /q.
const CMD_REMOVER = /^@?(rd|rmdir|del|erase)(\/.*)?$/i
const REMOVER_WORD = /\b(?:rm|rd|rmdir|del|erase|remove-item|ri)\b/i
const DEFAULT_BRANCHES = ['main', 'master', 'dev', 'develop', 'trunk']
const PUSH_VALUE_OPTIONS = ['--repo', '--receive-pack', '--exec', '-o', '--push-option']
// A word that sets a variable, appending to it with +=.
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/

// The index of the `}` closing a parameter expansion (`${f%%/*}`, PowerShell's `${env:TEMP}`) that starts at `at`, or -1 when
// its body names no parameter, may run a command, or holds a quote, whitespace or another expansion: then the braces still
// split the line, as before, so a command inside stays visible.
const braced = (line, at) => {
  const close = line.indexOf('}', at + 2)
  const body = line.slice(at + 2, close)
  return close === -1 || !/^[!#]?[\w@*#?!-]/.test(body) || /[$`'"\\\s(){]/.test(body) ? -1 : close
}

/**
 * A command line as simple commands, each a list of words; quotes are honoured, and every shell operator ends a command. A `\` escapes the next character as in a POSIX shell; read the `windows` way, `\` is an ordinary character and cmd's `^` and PowerShell's `` ` `` escape the next one instead.
 * `operators`, when given, receives for each command the operator characters between it and the command before it.
 */
export function commands(line, windows = false, operators = undefined) {
  const found = []
  let words = []
  let word = ''
  let started = false
  let between = ''
  const endWord = () => {
    if (started) words.push(word)
    word = ''
    started = false
  }
  const endCommand = (operator = '') => {
    endWord()
    if (words.length) {
      found.push(words)
      operators?.push(between)
      between = ''
    }
    words = []
    between += operator
  }
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    const braces = char === '$' && line[index + 1] === '{' ? braced(line, index) : -1
    if (!windows && char === '$' && line[index + 1] === "'") {
      // bash's and zsh's `$'...'`, where `\'` is a quote inside the string.
      let end = index + 2
      while (end < line.length && line[end] !== "'") end += line[end] === '\\' ? 2 : 1
      word += line.slice(index + 2, end)
      started = true
      index = end
    } else if (char === "'") {
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
    } else if (braces !== -1) {
      word += line.slice(index, braces + 1)
      started = true
      index = braces
    } else if (/\s/.test(char)) {
      if (char === '\n') endCommand(char)
      else endWord()
    } else if (';&|()`{}'.includes(char) || (char === '$' && line[index + 1] === '(')) {
      endCommand(char)
    } else {
      word += char
      started = true
    }
  }
  endCommand()
  return found
}

const programName = word => word.replaceAll('\\', '/').split('/').pop().toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '')

// The words that run: assignments, the shell words a program may follow (`do`, `then`), `env` and its options, and
// wrappers like `command` dropped.
function strip(words) {
  let rest = words
  for (;;) {
    while (rest.length && (ASSIGNMENT.test(rest[0]) || LEADS.includes(rest[0]))) rest = rest.slice(1)
    const name = rest.length ? programName(rest[0]) : ''
    if (name === 'env') {
      rest = rest.slice(1)
      while (rest.length && (rest[0].startsWith('-') || ASSIGNMENT.test(rest[0]))) {
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

// A lease spelled out in full: bare, naming a ref, or naming a ref and the commit it must hold.
const LEASE = /^--force-with-lease(?:=([^:]+)(?::([0-9a-f]{7,40}))?)?$/
// Options that push more than the refspecs name.
const PUSHES_MORE = ['--all', '--branches', '--mirror']
const FORCE_REASON = 'Use a non-force push, or --force-with-lease=<branch>:<sha> onto the branch checked out here.'
// The names git reads as the commit checked out, in a refspec as anywhere.
const CHECKED_OUT = ['HEAD', '@']

// git's reading of a boolean setting: true, yes, on, a non-zero number, or a key with no value.
const settingOn = value => value !== undefined && (/^(?:true|yes|on|)$/i.test(value) || (/^-?\d+$/.test(value) && Number(value) !== 0))

// The remote a push with none on its line goes to (branch.<b>.pushRemote, remote.pushDefault), and the one the branch
// fetches from (branch.<b>.remote, else the only remote, else origin), as git's remote.c picks them.
const remotesOf = (repo, branch) => {
  const one = key => repo.config(key).at(-1)
  const remotes = repo.remotes()
  const fetch = one(`branch.${branch}.remote`) ?? (remotes.length === 1 ? remotes[0] : 'origin')
  return { fetch, push: one(`branch.${branch}.pushremote`) ?? one('remote.pushdefault') ?? fetch }
}

// A branch's upstreams, the refs its branch.<b>.merge names: git's remote.c reads them only when branch.<b>.remote is set.
const upstreamsOf = (repo, branch) => repo.config(`branch.${branch}.remote`).length ? repo.config(`branch.${branch}.merge`) : []
const pushDefault = repo => repo.config('push.default').at(-1) ?? 'simple'

// The branch a push with no refspec updates on `remote`, as builtin/push.c's setup_default_push_refspecs() picks it, or why
// the guard cannot tell. A remote.<name>.push or remote.<name>.mirror setting comes first.
const defaultLanding = (repo, branch, remote) => {
  const pushes = repo.config(`remote.${remote}.push`)
  if (settingOn(repo.config(`remote.${remote}.mirror`).at(-1))) return { unknown: `remote.${remote}.mirror pushes every branch.` }
  if (pushes.length) {
    const lands = pushes.filter(spec => !spec.startsWith('^')).map(spec => configLanding(spec, branch))
    return lands.includes(undefined) ? { unknown: `remote.${remote}.push holds a refspec the guard does not read.` } : { lands: /** @type {string[]} */ (lands) }
  }
  const mode = pushDefault(repo)
  if (mode === 'matching') return { unknown: 'push.default=matching pushes every branch with a namesake on the remote.' }
  if (!['simple', 'upstream', 'tracking', 'current'].includes(mode)) return { unknown: `push.default=${mode} pushes nothing.` }
  const same = remote === remotesOf(repo, branch).fetch
  if (mode === 'current' || (mode === 'simple' && !same)) return { lands: [branch] }
  if (!same) return { unknown: `push.default=${mode} refuses a push to ${remote}, which ${branch} does not fetch from.` }
  const upstreams = upstreamsOf(repo, branch)
  // push.autoSetupRemote makes a branch with no upstream its own.
  if (upstreams.length === 0 && settingOn(repo.config('push.autosetupremote').at(-1))) return { lands: [branch] }
  if (upstreams.length !== 1) return { unknown: `${branch} has ${upstreams.length} upstreams, and push.default=${mode} needs one.` }
  if (mode === 'simple' && upstreams[0] !== `refs/heads/${branch}`) return { unknown: `${branch}'s upstream is ${upstreams[0]}, which push.default=simple refuses.` }
  return { lands: [branchOf(upstreams[0])] }
}

// The branch a remote.<name>.push refspec updates when a push names none, read from the branch checked out: only a
// `<src>` (to its own name) and a plain `<src>:<dst>` are read; a glob, a forced or matching refspec is undefined.
const configLanding = (spec, branch) => {
  if (spec.startsWith('+') || spec.includes('*') || spec.startsWith(':') || spec === '') return undefined
  const colon = spec.lastIndexOf(':')
  const target = colon === -1 ? spec : spec.slice(colon + 1)
  if (CHECKED_OUT.includes(target)) return colon === -1 ? branch : undefined
  return branchOf(target)
}

// What one side of a refspec, `pattern`, maps `ref` to (refspec.c's match_name_with_pattern()): `to` for an exact match,
// `to` with its `*` replaced by what the pattern's `*` matched, undefined for no match.
const refMatch = (pattern, ref, to = '') => {
  const star = pattern.indexOf('*')
  if (star === -1) return pattern === ref ? to : undefined
  const [head, tail] = [pattern.slice(0, star), pattern.slice(star + 1)]
  if (ref.length < head.length + tail.length || !ref.startsWith(head) || !ref.endsWith(tail)) return undefined
  return to.replace('*', ref.slice(head.length, ref.length - tail.length))
}

// The branch a refspec naming `branch` with no `:<dst>` updates on `remote`, as builtin/push.c's refspec_append_mapped()
// sends it: through the first remote.<name>.push entry whose source matches refs/heads/<branch>; else, with
// push.default=upstream, to the branch's one upstream; else to its own name. Undefined when a `+` entry maps it, a forced
// push; null when a negative entry matches it, which git 2.50 still maps through the entries after it and another git may not.
const mappedLanding = (repo, branch, remote) => {
  const ref = `refs/heads/${branch}`
  const entries = repo.config(`remote.${remote}.push`)
  if (entries.some(entry => entry.startsWith('^') && refMatch(entry.slice(1), ref) !== undefined)) return null
  for (const entry of entries.filter(spec => !spec.startsWith('^'))) {
    const forced = entry.startsWith('+')
    const colon = entry.lastIndexOf(':')
    if (colon === -1) continue
    const mapped = refMatch(entry.slice(forced ? 1 : 0, colon), ref, entry.slice(colon + 1))
    if (mapped === undefined) continue
    return forced || mapped === '' ? undefined : branchOf(mapped)
  }
  const upstreams = upstreamsOf(repo, branch)
  return ['upstream', 'tracking'].includes(pushDefault(repo)) && upstreams.length === 1 ? branchOf(upstreams[0]) : branch
}

// A push's words after `push`: its remote (the first plain word, else --repo), its refspecs, its leases, whether it forces
// more than a lease (--force, -f, a push of --all, --branches or --mirror) and whether it pushes tags (--tags, or the last
// of --follow-tags and --no-follow-tags; undefined when neither is given).
const pushWords = args => {
  const plain = []
  const leases = []
  let named
  let forced = false
  let tags
  let all = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    const lease = LEASE.exec(arg)
    if (lease) leases.push(lease[1])
    else if (longOption(arg, '--tags')) all = true
    else if (longOption(arg, '--follow-tags')) tags = true
    else if (longOption(arg, '--no-follow-tags')) tags = false
    else if (longOption(arg, '--force', '--force-with-lease', ...PUSHES_MORE) || shortFlags(arg).includes('f')) forced = true
    else if (arg === '--repo') named = args[++index]
    else if (arg.startsWith('--repo=')) named = arg.slice('--repo='.length)
    else if (PUSH_VALUE_OPTIONS.includes(arg)) index += 1
    else if (!arg.startsWith('-')) plain.push(arg)
  }
  const [remote = named, ...refspecs] = plain
  return { remote, refspecs, leases, forced, tags: all || tags, plain }
}

// Whether a push lands where HEAD, an upstream or a setting sends it: it names no refspec, or one with no `:<dst>`.
const landsByHead = args => {
  const { refspecs } = pushWords(args)
  return refspecs.length === 0 || refspecs.some(spec => !spec.includes(':'))
}

/**
 * Where a push whose only force is a lease lands: the branches it updates (`lands`), or why the guard refuses it (`unknown`:
 * it cannot tell where the push lands; `tags`: it pushes tags, which a bare lease forces); undefined when it forces more than
 * a lease on the branch checked out (--force, -f, a `+` refspec, a lease on another ref, --all) or names a refspec other than
 * that branch. With no refspec the push lands where git sends it; a `<src>` with no `:<dst>` lands where git maps it.
 * `local` says repo is the repository and the settings the push reads: no -C, -c, --git-dir or GIT_* variable changes
 * them. With no repository known (NO_REPO), a refspec reads as it is written and a push with none is refused, as before.
 */
function leasedPush(args, branch, repo, local) {
  const { remote, refspecs, leases, forced, tags, plain } = pushWords(args)
  if (forced || !leases.length || leases.some(ref => ref !== undefined && branchOf(ref) !== branch)) return undefined
  // git splits a refspec at its last colon.
  const split = refspecs.map(spec => spec.includes(':') ? [spec.slice(0, spec.lastIndexOf(':')), spec.slice(spec.lastIndexOf(':') + 1)] : [spec, undefined])
  if (split.some(([source, target]) => source.startsWith('+') || (!CHECKED_OUT.includes(source) && branchOf(source) !== branch)
    || (target !== undefined && branchOf(target) !== branch))) return undefined
  if (tags || (tags === undefined && settingOn(repo.config('push.followtags').at(-1)))) return { tags: true }
  if (repo === NO_REPO) return refspecs.length ? { lands: [branch] } : undefined
  if (!local) return { unknown: 'the push reads a repository or settings this line changes (-C, -c, --git-dir, a GIT_ variable or a wrapper).' }
  if (plain.some(dynamic)) return { unknown: 'a word of it is one the shell expands.' }
  if (!refspecs.length) return defaultLanding(repo, branch, remote ?? remotesOf(repo, branch).push)
  // A HEAD with no :<dst> lands on the branch it names; git maps no other ref named alone through HEAD.
  const lands = split.map(([source, target]) => target !== undefined || CHECKED_OUT.includes(source) ? branch : mappedLanding(repo, branch, remote))
  if (lands.includes(undefined)) return undefined
  return lands.includes(null) ? { unknown: `a negative remote.${remote}.push entry names ${branch}.` } : { lands: /** @type {string[]} */ (lands) }
}

// Where a git command's working tree may be: `cwd` moved by each `-C`, then `--work-tree` or GIT_WORK_TREE, each with its
// variables expanded by `lookup`. A literal path the guard does not expand is a folder name; null for a variable it cannot.
function gitTrees(options, assigned, cwd, path, lookup) {
  const resolved = (dirs, to) => {
    const values = /[$%~]/.test(to) ? expansions(to, lookup) : [to]
    return dirs.flatMap(dir => values.map(value => dir === null || value === undefined ? null : path.resolve(dir, value)))
  }
  let dirs = [path.resolve(cwd)]
  let trees = assigned === undefined ? undefined : resolved([path.resolve(cwd)], assigned)
  for (let index = 0; index < options.length; index += 1) {
    if (options[index] === '-C') dirs = resolved(dirs, options[index + 1] ?? '')
    else if (options[index] === '--work-tree') trees = resolved(dirs, options[index + 1] ?? '')
    else if (options[index].startsWith('--work-tree=')) trees = resolved(dirs, options[index].slice('--work-tree='.length))
    if (GIT_VALUE_OPTIONS.includes(options[index])) index += 1
  }
  return trees ?? dirs
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

const VARIABLE = /\$env:([A-Za-z_]\w*)|\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)|%([A-Za-z_]\w*)%/g
const MAX_EXPANSIONS = 32

/**
 * Each text `target` may expand to, undefined for one the guard cannot read (a command substitution, `~user`, a variable
 * with no value it knows). `~` is HOME (or USERPROFILE), and `$PWD` at the start the current folder, unless `pwd` is false;
 * every other variable takes each value `lookup(name)` gives it.
 */
const expansions = (target, lookup, pwd = true) => {
  const homes = () => {
    const home = lookup('HOME')
    return home.some(value => value !== undefined) ? home : lookup('USERPROFILE')
  }
  const starts = /^~(?=$|[\\/])/.test(target) ? homes().map(home => home === undefined ? undefined : home + target.slice(1))
    : /^\$\{?PWD\}?(?=$|[\\/])/.test(target) ? [pwd ? target.replace(/^\$\{?PWD\}?/, '.') : undefined] : [target]
  const found = new Set()
  const expand = (text, from) => {
    if (found.size > MAX_EXPANSIONS) return
    if (text === undefined) return void found.add(undefined)
    const variable = new RegExp(VARIABLE.source, 'g')
    variable.lastIndex = from
    const match = variable.exec(text)
    if (!match) return void found.add(/[$`]|^~/.test(text) ? undefined : text)
    const name = match.slice(1, 5).find(Boolean) ?? ''
    for (const value of lookup(name)) {
      expand(value === undefined ? undefined : text.slice(0, match.index) + value + text.slice(match.index + match[0].length), match.index + (value?.length ?? 0))
    }
  }
  for (const start of starts) expand(start, 0)
  return found.size > MAX_EXPANSIONS ? [undefined] : [...found]
}

// A form that sets a variable to a value the guard does not follow: a loop, read or getopts variable, PowerShell's
// Set-Variable or a compound assignment but +=, printf -v, mapfile, unset, an array element, or a ${X:=v} default.
const untracked = (name, raw) => new RegExp('\\b(?:for|foreach|select|set|set-variable|sv|new-variable|nv|coproc)\\s+(?:-\\S+\\s+)*\\(?\\$?' + name + '\\b(?!\\+?=)'
  + '|\\b(?:read|getopts|mapfile|readarray|unset|vared)\\b[^;&|\\n]*?(?<![\\w$:{/.-])' + name + '\\b(?![=-])'
  + '|\\bprintf\\s+(?:\\S+\\s+)*?-v\\s*' + name + '\\b|(?<![\\w$])' + name + '\\[[^\\]\\n]*\\]\\+?=|\\$\\{' + name + ':?='
  + '|\\$(?:env:)?' + name + '\\s*(?:[-*/%]|\\?\\?)=', 'i').test(raw)

// A line that may set any variable: eval, source or PowerShell's Invoke-Expression, a nameref, or a name an expansion
// gives (`export "$X=v"`, `read "$X"`, `printf -v "$X"`).
const UNFOLLOWED = new RegExp(/(?:^|[;&|(){}\n]|\b(?:then|do|else)\s)\s*(?:eval|source|\.|iex|invoke-expression)(?:\s|$)/.source
  + /|\b(?:declare|typeset|local)\s+(?:[-+]\w+\s+)*-\w*n|\b(?:export|declare|typeset|local|readonly|read)\b[^;&|\n<>]*\s["']?\$/.source
  + /|\bprintf\s+(?:\S+\s+)*?-v\s*["']?\$/.source, 'i')
// A loop or a function, which may run a command again after a later command set a variable it reads.
const LOOPS = /(?:^|[;&|(){}\n]|\b(?:then|do|else)\s)\s*(?:while|until|for|select|foreach|repeat|function)\b|\(\)\s*\{/i
const assigns = name => new RegExp('(?:^|[\\s;&|(]|\\$env:|\\$)' + name + '\\s*\\+?=', 'i')

// Whether the line may set `name` in a way the guard does not follow, or set it again after a command read it.
const unfollowed = (name, raw) => UNFOLLOWED.test(raw) || untracked(name, raw) || (LOOPS.test(raw) && assigns(name).test(raw))

/** The values a variable has before a line sets it: the environment's, none the guard can read when the line sets it or `env` lacks it. */
const environment = (env, raw, windows) => name => {
  if (env === undefined || assigns(name).test(raw) || unfollowed(name, raw)) return [undefined]
  const key = windows ? Object.keys(env).find(each => each.toLowerCase() === name.toLowerCase()) : name
  return [key === undefined ? undefined : env[key]]
}

const ASSIGNING = ['export', 'declare', 'typeset', 'local', 'readonly']

// The variables a command sets: `kept` for the rest of the line (`X=v` alone, export and its kin, cmd's set, PowerShell's
// `$X = v` and `$env:X = v`), `temporary` for its program alone (`X=v cmd`, `env X=v cmd`). `X+=v` appends: its value is
// `${X}v`. A value the guard cannot read, as one a command substitution, a PowerShell expression or an attribute gives, is
// undefined.
const assignedBy = (words, windows) => {
  const powershell = /^\$(?:env:)?([A-Za-z_]\w*)(?:(\+?)=(.*))?$/is.exec(words[0] ?? '')
  const operator = powershell?.[3] === undefined ? words[1] : powershell[2] + '='
  if (powershell && /^(?:[-+*/%]|\?\?)?=$/.test(operator ?? '')) {
    const name = powershell[1]
    const value = powershell[3] !== undefined ? [powershell[3], ...words.slice(1)] : words.slice(2)
    const read = value.length === 1 && value[0] !== '' && ['=', '+='].includes(operator) ? value[0] : undefined
    return { kept: [[name, read !== undefined && operator === '+=' ? '${' + name + '}' + read : read]], temporary: [] }
  }
  const pair = word => {
    const at = word.indexOf('=')
    const append = word[at - 1] === '+'
    const name = word.slice(0, append ? at - 1 : at)
    return [name, append ? '${' + name + '}' + word.slice(at + 1) : word.slice(at + 1) || undefined]
  }
  const head = words.findIndex(word => !ASSIGNMENT.test(word))
  if (head === -1) return { kept: words.map(pair), temporary: [] }
  const program = programName(words[head])
  const leading = words.slice(0, head).map(pair)
  const rest = words.slice(head + 1)
  if (ASSIGNING.includes(program) || (windows && program === 'set')) {
    // An attribute but export, readonly, global or trace (declare -i, -l, -a, typeset -Z), or cmd's set /a or /p, changes
    // or reads the value; a declare, typeset or local with no value may unset the name.
    const follows = rest.every(word => !/^[-+/]/.test(word) || /^[-+][gxrt]+$/.test(word))
    const unsets = !['export', 'readonly', 'set'].includes(program)
    const kept = rest.flatMap(word => ASSIGNMENT.test(word) ? [follows ? pair(word) : [pair(word)[0], undefined]]
      : unsets && /^[A-Za-z_]\w*$/.test(word) ? [[word, undefined]] : [])
    return { kept, temporary: leading }
  }
  if (program === 'env') {
    const runs = rest.findIndex(word => !word.startsWith('-') && !ASSIGNMENT.test(word))
    return { kept: [], temporary: [...leading, ...(runs === -1 ? rest : rest.slice(0, runs)).filter(word => ASSIGNMENT.test(word)).map(pair)] }
  }
  return { kept: [], temporary: leading }
}

/**
 * The variables each command of a line sees, fed the line's commands in order with the operators before each (see
 * commands()). It starts from `base` (see environment()). Until the first operator but `;` or a newline, or the first
 * shell keyword, a command that sets a variable sets the one value it has; after one, every value set so far may be it,
 * and so may the one it had before. A command's own `X=v` adds a value for that command alone. `feed` returns the lookup
 * for the command fed.
 */
const varScope = (base, raw, windows) => {
  const seen = new Map()
  let straight = true
  const key = name => windows ? name.toLowerCase() : name
  const lookup = name => {
    const values = seen.get(key(name))
    return values === undefined ? base(name) : unfollowed(name, raw) ? [...values, undefined] : values
  }
  const valuesOf = value => value === undefined ? [undefined] : expansions(value, lookup, false)
  const feed = (words, before = '') => {
    if (!/^[;\n]*$/.test(before) || CONTROL_WORDS.split('|').includes(words[0]) || LEADS.includes(words[0])) straight = false
    const { kept, temporary } = assignedBy(words, windows)
    const own = new Map(temporary.map(([name, value]) => [key(name), valuesOf(value)]))
    for (const [name, value] of kept) {
      const values = valuesOf(value)
      seen.set(key(name), straight ? values : [...new Set([...lookup(name), ...values])])
    }
    return own.size === 0 ? lookup : name => [...new Set([...lookup(name), ...(own.get(key(name)) ?? [])])]
  }
  return { feed }
}

const NO_VARIABLES = () => [undefined]

// The folders the OS keeps temporary files in, by the environment, /tmp on a POSIX host that names none: never a
// filesystem root, the home folder or a folder holding it.
const tempRoots = (env, path) => {
  if (env === undefined) return []
  const homes = [env.HOME, env.USERPROFILE, ...(path === nodePath ? [homedir()] : [])].filter(Boolean).map(home => real(path.resolve(home), path))
  const named = ['TMPDIR', 'TEMP', 'TMP'].flatMap(name => env[name] ? [env[name]] : [])
  return [...new Set((named.length === 0 && path.sep === '/' ? ['/tmp'] : named).map(dir => real(path.resolve(dir), path)))]
    .filter(root => root !== null && path.parse(root).root !== root && !homes.some(home => home !== null && within(home, folded(root, path), path)))
    .map(root => folded(root, path))
}

// Whether `dir` is a git checkout or inside one, up to the folder `top`.
const inCheckout = (dir, top, path) => {
  for (let at = dir; within(at, top, path) && folded(at, path) !== top; at = path.dirname(at)) {
    if (existsSync(path.join(at, '.git'))) return true
  }
  return false
}

/**
 * Whether a forced recursive delete of `target` from `cwd` removes nothing a seat must keep: each folder it may name,
 * variables expanded, is inside the seat's folder but neither that folder nor its worktree root, or is inside a folder of
 * temporary files but not that folder, and is no git checkout, inside none and holds no seat folder.
 */
const removable = (target, cwd, path, own, lookup, temps) => {
  const seat = real(path.resolve(own), path)
  if (seat === null) return false
  const roots = [folded(seat, path), folded(path.join(seat, 'wt'), path)]
  return expansions(target, lookup).every(at => at !== undefined && moved([cwd], at, path).every(folder => {
    const dir = folder === null ? null : real(folder, path)
    if (dir === null) return false
    if (within(dir, folded(seat, path), path)) return !roots.includes(folded(dir, path))
    return temps.some(temp => within(dir, temp, path) && folded(dir, path) !== temp && !inCheckout(dir, temp, path))
      && !within(seat, folded(dir, path), path)
  }))
}

function refusal(words, branch, cwd, path, own, allowedBranches = [], cdpath = undefined, ctx = undefined, lookup = NO_VARIABLES) {
  const assigned = words.find(word => word.startsWith('GIT_WORK_TREE='))?.slice('GIT_WORK_TREE='.length)
  const [first, ...args] = strip(words)
  if (!first) return undefined
  const name = programName(first)
  // Whether the program is the command's own first word, after the shell words a program may follow: no assignment or
  // wrapper changes where or how it runs.
  const bare = words.find(word => !LEADS.includes(word)) === first
  if (SHELLS.includes(name)) {
    const script = shellScript(args)
    const placed = bare && ['-c', '/c', '-command'].includes(args[0]?.toLowerCase())
    return script === undefined ? undefined : check(script, branch, cwd, path, placed ? own : undefined, allowedBranches, cdpath, ctx)
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
    if (mayDiscardWork(sub, rest) && !gitTrees(args.slice(0, index), assigned, cwd, path, lookup).every(tree => tree !== null && samePath(tree, path.resolve(cwd), path))) {
      return `Run git ${sub} only in the folder the command runs in: -C, --work-tree or GIT_WORK_TREE point this one at another folder.`
    }
    if (sub === 'branch' && forceDeletesBranch(rest)) {
      const targets = rest.filter(arg => !arg.startsWith('-')).map(branchOf)
      if (targets.length && targets.every(target => allowedBranches.includes(target))) return undefined
      return 'Delete a branch only with git branch -d, which keeps unmerged commits: another agent may own the branch.'
    }
    if (sub === 'push' && rest.some(arg => longOption(arg, '--force', '--force-with-lease', '--force-if-includes')
      || shortFlags(arg).includes('f') || (arg.startsWith('+') && arg.length > 1))) {
      if (!branch || DEFAULT_BRANCHES.includes(branch)) return FORCE_REASON
      // A wrapper before git (xargs, env) may add refspecs or settings the guard does not see.
      const local = bare && args.slice(0, index).every(option => option === '--no-pager' || option === '-P') && !assignments(words).some(word => /^GIT_/i.test(word))
      const leased = leasedPush(rest, branch, ctx?.repo ?? NO_REPO, local)
      if (leased === undefined) return FORCE_REASON
      if ('tags' in leased) return `Push tags without a lease: --tags, --follow-tags and push.followTags push tags, which a bare lease forces. Name the branch alone: git push --force-with-lease --no-follow-tags <remote> HEAD:${branch}.`
      if ('unknown' in leased) return `The guard cannot tell where this push lands: ${leased.unknown} Name the branch: git push --force-with-lease <remote> HEAD:${branch}.`
      const others = [...new Set(leased.lands.filter(name => name !== branch))]
      if (others.length) return `This push would update ${others.join(', ')}, not ${branch}, the branch checked out here. Name the branch: git push --force-with-lease <remote> HEAD:${branch}.`
    }
    return undefined
  }
  if (name === 'gh') {
    const plain = args.filter(arg => !arg.startsWith('-'))
    if (plain[0] === 'pr' && plain[1] === 'merge' && args.includes('--admin')) return 'Do not bypass merge protections.'
    if (plain[0] === 'repo' && plain[1] === 'delete') return 'Do not delete repositories.'
    return undefined
  }
  const cmdRemover = CMD_REMOVER.exec(first)
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
      // To cmd a slash in a path may start a switch, so a target with one is not explicit; a word of switches alone
      // (`/s`, `/s/q`, `/s,/q`) is none. A redirection's file is no target.
      const targets = strip(withoutRedirects(words)).slice(1)
        .filter(arg => !arg.startsWith('-') && !(cmdRemover && /^(?:\/[a-z?]|,)+$/i.test(arg)))
      const temps = tempRoots(ctx?.env, path)
      if (bare && own !== undefined && targets.length
        && targets.every(target => !(cmdRemover && target.includes('/')) && removable(target, cwd, path, own, lookup, temps))) return undefined
      return 'Remove only explicit paths, without a forced recursive delete.'
    }
  }
  return undefined
}

// A line a Windows shell runs, not Claude Code's Bash tool, with a backslash but no line continuation, is read the Windows way
// only: PowerShell and cmd read a backslash as a separator, and the POSIX reading would drop it, leaving `cd C:\x\wt` a folder
// it cannot place.
const windowsLine = (line, path, bash) => path.sep === '\\' && !bash && line.includes('\\') && !/\\\r?\n/.test(line)

/**
 * Why a command line is refused, or undefined when it may run; `branch` is the one checked out where it runs.
 * `path` resolves folders: node:path, or path.win32 to decide as Windows does.
 * The shell that runs a line is unknown: codex on Windows hands over `"C:\WINDOWS\...\powershell.exe" -Command '...'`,
 * where a POSIX reading drops every `\`. A line is refused when either its POSIX or its Windows reading refuses it.
 */
export function check(line, branch, cwd = process.cwd(), path = nodePath, own = undefined, allowedBranches = [], cdpath = undefined, ctx = undefined) {
  // A Windows host runs a line outside Claude's Bash tool in PowerShell or cmd, where a backslash separates folders: as
  // stray() reads it, a delete there is placed the Windows way alone, when both readings see the same deletes.
  const removes = words => {
    const [run = '', ...args] = strip(words)
    return REMOVERS.includes(programName(run)) || CMD_REMOVER.test(run) || (SHELLS.includes(programName(run)) && REMOVER_WORD.test(shellScript(args) ?? ''))
  }
  const removals = windows => commands(line, windows).filter(removes).length
  const windowsPaths = own !== undefined && ctx !== undefined && windowsLine(line, path, ctx.bash) && removals(false) === removals(true)
  for (const windows of [false, true]) {
    let places = [path.resolve(cwd)]
    const operators = []
    const found = commands(line, windows, operators)
    const variables = varScope(environment(ctx?.env, line, windows), line, windows)
    for (const [at, words] of found.entries()) {
      const lookup = variables.feed(words, operators[at])
      const command = plain(words)
      if (own !== undefined && command?.target !== undefined) places = cdpath && searched(command.target) ? [null] : [...new Set([...places, ...reached(places, command.target, path, lookup)])]
      else if (own !== undefined && command?.pop) places = [null]
      else if (own !== undefined && (assignments(words).some(word => /^CDPATH=/i.test(word)) || ['source', '.', 'eval', 'iex'].includes(words[0]?.toLowerCase()))) places = [null]
      const aliased = ctx === undefined ? undefined : aliasRefusal(words, places, cwd, path, ctx, lookup)
      if (aliased) return aliased
      if (windowsPaths && !windows && removes(words)) continue
      const located = removes(words) ? places : [cwd]
      // `${X}` reads as `$X`; any other brace is a brace or parameter expansion the guard does not place.
      const expandedRemoval = new RegExp(REMOVER_WORD.source + /[^\n;&|]*(?:\$\(|`|[{}]|[<>]\()/.source, 'i').test(line.replace(/\$\{([A-Za-z_]\w*)\}/g, '$$$1'))
      const reason = located.map(place => refusal(words, branch, place ?? cwd, path, place === null || expandedRemoval ? undefined : own, allowedBranches, cdpath, ctx, lookup)).find(Boolean)
      if (reason) return reason
    }
  }
  return undefined
}

const ALIAS_DEPTH = 10
const ALIAS_DEPTH_REASON = 'Run git commands without nested aliases: this alias expands too deep for the guard to check.'
const ALIAS_UNREAD_REASON = 'Run git without an alias that --config-env reads from a variable the guard cannot read: it cannot check what the alias runs.'

// A word of a command line, quoted so a POSIX shell reads it back as the same word.
const shellWord = word => /^[\w@%+=:,./-]+$/.test(word) ? word : "'" + word.replaceAll("'", "'\\''") + "'"

// The values git may read from the environment variable `name`: the command's own `X=v`, else those the line or the
// environment gave it (see varScope()).
const gitEnvironment = (words, lookup) => name => {
  const own = assignedBy(words, false).temporary.findLast(([set]) => set === name)
  return own === undefined ? lookup(name) : own[1] === undefined ? [undefined] : expansions(own[1], lookup, false)
}

/**
 * The command lines git may run for `git <args>` when its subcommand is an alias, or undefined: the expansion with the
 * options before it and the arguments after it, or a `!` alias's shell command with the arguments after it. A
 * `-c alias.<name>=<value>` or a `--config-env=alias.<name>=<variable>` on the line gives the alias, the last one winning as
 * git applies them in order, else `repo` (see Repo). `variable(name)` gives a variable's values (see gitEnvironment());
 * one the guard cannot read is undefined among them.
 */
const aliasExpansions = (args, repo, variable) => {
  let index = 0
  while (index < args.length && args[index].startsWith('-')) index += GIT_VALUE_OPTIONS.includes(args[index]) ? 2 : 1
  const sub = args[index] ?? ''
  if (!/^[A-Za-z0-9][\w-]*$/.test(sub)) return undefined
  const options = args.slice(0, index)
  const setting = new RegExp('^alias\\.' + sub + '=(.*)$', 'is')
  const given = options.flatMap((option, at) => {
    const env = option === '--config-env' ? options[at + 1] : option.startsWith('--config-env=') ? option.slice('--config-env='.length) : undefined
    const name = env === undefined ? undefined : setting.exec(env)?.[1]
    if (name !== undefined) return [/^[A-Za-z_]\w*$/.test(name) ? variable(name) : [undefined]]
    const value = option === '-c' ? setting.exec(options[at + 1] ?? '')?.[1] : undefined
    return value === undefined ? [] : [[value]]
  }).at(-1)
  const aliases = given ?? [repo.alias(sub)].filter(alias => alias !== undefined)
  if (aliases.length === 0) return undefined
  const rest = args.slice(index + 1).map(shellWord)
  // git runs a `!` alias from the top of the work tree -C names.
  const folders = options.flatMap((option, at) => option === '-C' ? ['cd ' + shellWord(options[at + 1] ?? '') + ' && '] : [])
  return aliases.map(alias => alias === undefined ? undefined : alias.startsWith('!') ? [folders.join('') + alias.slice(1), ...rest].join(' ')
    : ['git', ...options.map(shellWord), alias, ...rest].join(' '))
}

// Why a git alias on the line is refused: what it runs is refused from a folder the line may be in, the root of the drive
// for a folder the guard cannot place, or it is set from a variable the guard cannot read.
const aliasRefusal = (words, places, cwd, path, ctx, lookup) => {
  const [first, ...args] = strip(words.filter(word => !isRedirect(word)))
  if (!first || programName(first) !== 'git') return undefined
  const runs = aliasExpansions(args, ctx.repo, gitEnvironment(words, lookup))
  if (runs === undefined) return undefined
  if (runs.includes(undefined)) return ALIAS_UNREAD_REASON
  if (ctx.depth >= ALIAS_DEPTH) return ALIAS_DEPTH_REASON
  return places.flatMap(place => runs.map(run => ctx.expand(run, place ?? path.parse(path.resolve(cwd)).root))).find(Boolean)
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
  const [name, value] = at > 0 ? [word.slice(0, at).replace(/\+$/, ''), word.slice(at + 1)] : [word, set[index + 1] === '=' ? set[index + 2] : undefined]
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
// The words of a command but its redirections: an operator glued to its file (`>out`, `2>/dev/null`), or alone and the
// word after it.
const withoutRedirects = words => words.filter((word, at) => !isRedirect(word) && !(at > 0 && /^(?:\d+|&)?(?:>>?\|?|<<<|<<-?|<>?|[<>]&)$/.test(words[at - 1])))

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
  || words.slice(0, index).every(before => ASSIGNMENT.test(before) || LEADS.includes(before))
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
    runs ||= value !== undefined && RUNS_KEY.test(value) && !/^alias\./i.test(value)
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
const quoted = windows => windows ? /'[^']*'|"[^"]*"/g : /\$'(?:[^'\\]|\\.)*'|'[^']*'|"(?:[^"\\]|\\.)*"/g
const SUBSTITUTION = /\$\(|`|[<>]\(/

// The words that open a shell construct, each with the word that closes it.
const OPENS = { if: 'fi', case: 'esac', do: 'done', '{': '}', foreach: 'end' }
// Words after which a command may start, so a closing word there closes.
const COMMAND_STARTS = ['then', 'do', 'else', 'elif', 'if', 'while', 'until', '{', '!', 'time']

/**
 * The statements of a text a POSIX shell runs, each with its here-documents, as bash and zsh both read them; undefined
 * where the guard cannot be sure they do, which keeps every body. A `<<` or `<<-` outside quotes, a comment, an arithmetic
 * expression, a parameter expansion and backticks opens a here-document; its delimiter is a word that only a blank, a
 * newline or an operator ends; its body starts after the next newline that is neither quoted nor a line continuation and
 * ends at the first line that is exactly its delimiter (leading tabs dropped for `<<-`). A statement ends at a newline
 * outside every construct, unless |, ||, |& or && comes last before it: then the command it feeds goes on after the bodies
 * read there. Each statement: `code`, its text but the bodies; whether `substitutes` a command or process substitution
 * anywhere in it outside single quotes; `docs`, its here-documents, each with the span `from`-`to` of its body and
 * terminator line, the span `operator` of its `<<` and delimiter, whether its delimiter is `quoted`, whether a command or
 * process substitution `captured` its output, and its `body`.
 * @returns {{ code: string, substitutes: boolean, docs: Doc[] }[] | undefined}
 */
const hereDocuments = text => {
  const statements = []
  let statement = { code: '', substitutes: false, docs: [] }
  // '"' for a double-quoted string, '(' for a subshell, '$(' for a command or process substitution, or an OPENS word.
  const stack = []
  /** @type {{ delimiter: string, tabs: boolean, quoted: boolean, depth: number, captured: boolean, operator: number[] }[]} */
  let pending = []
  let codeFrom = 0
  let word = ''
  let literal = false
  let atCommand = true
  let continued = false
  let test = false
  const endWord = () => {
    if (word === '' && !literal) return
    if (!literal) {
      const closes = Object.keys(OPENS).find(open => OPENS[open] === word)
      if (Object.hasOwn(OPENS, word)) stack.push(word)
      else if (closes !== undefined && atCommand && stack.at(-1) === closes) stack.pop()
      if (word === '[[') test = true
      if (word === ']]') test = false
    }
    atCommand = !literal && COMMAND_STARTS.includes(word)
    continued = false
    word = ''
    literal = false
  }
  // The end of the span from the `(` or `[` at `from` to its match, an arithmetic expression, holding no quote or newline.
  // bash and zsh read a `<<` in one as a shift when it holds no substitution and closes with `))` or is a `$[...]`.
  const arithmetic = from => {
    const [open, close] = text[from] === '[' ? '[]' : '()'
    let depth = 0
    for (let at = from; at < text.length; at += 1) {
      if (text[at] === open) depth += 1
      else if (text[at] === close && --depth === 0) {
        const span = text.slice(from, at + 1)
        const shifts = (open === '[' || span.endsWith('))')) && !/\$\(|`/.test(span)
        return /['"`\n]/.test(span) || (span.includes('<<') && !shifts) ? undefined : at + 1
      }
    }
    return undefined
  }
  // The end of a `${...}` parameter expansion that holds no quote, newline or `<<`.
  const parameter = from => {
    let depth = 0
    for (let at = from + 1; at < text.length; at += 1) {
      if (text[at] === '\\') at += 1
      else if (text[at] === '{') depth += 1
      else if (text[at] === '}' && --depth === 0) {
        const body = text.slice(from, at)
        return /<<|['"\n]/.test(body) ? undefined : at + 1
      }
    }
    return undefined
  }
  // The end of a backtick substitution that holds no `<<`, nor a newline while a here-document waits for its body.
  const backticks = from => {
    for (let at = from + 1; at < text.length; at += 1) {
      if (text[at] === '\\') at += 1
      else if (text[at] === '`') {
        const body = text.slice(from, at)
        return body.includes('<<') || (pending.length && body.includes('\n')) ? undefined : at + 1
      }
    }
    return undefined
  }
  // The bodies of the waiting here-documents, read from `at`; the index after them, or undefined.
  const bodies = at => {
    for (const { delimiter, tabs, quoted, depth, captured, operator } of pending) {
      const from = at
      for (;;) {
        if (at >= text.length) return undefined
        const start = at
        const end = text.indexOf('\n', at)
        const line = text.slice(at, end === -1 ? text.length : end)
        const bare = tabs ? line.replace(/^\t+/, '') : line
        at = end === -1 ? text.length : end + 1
        if (bare === delimiter) {
          statement.docs.push({ from, to: at, operator, quoted, captured, body: text.slice(from, start) })
          break
        }
        // bash ends a body at `EOF)` inside a substitution and zsh does not; a line continuation joins an unquoted body's lines.
        if ((!quoted && line.endsWith('\\')) || (depth > 0 && bare.startsWith(delimiter))) return undefined
      }
    }
    pending = []
    return at
  }
  let index = 0
  while (index < text.length) {
    const char = text[index]
    const next = text[index + 1]
    if (stack.at(-1) === '"') {
      if (char === '\\') index += 2
      else if (char === '"') {
        stack.pop()
        index += 1
      } else if (char === '`') {
        const end = backticks(index)
        if (end === undefined) return undefined
        statement.substitutes = true
        index = end
      } else if (char === '$' && next === '(' && text[index + 2] === '(') {
        const end = arithmetic(index + 1)
        if (end === undefined) return undefined
        index = end
      } else if (char === '$' && next === '(') {
        stack.push('$(')
        statement.substitutes = true
        atCommand = true
        index += 2
      } else if (char === '$' && next === '{') {
        const end = parameter(index + 1)
        if (end === undefined) return undefined
        index = end
      } else if (char === '\n' && pending.length) return undefined
      else index += 1
      continue
    }
    if (char === "'" || (char === '$' && next === "'")) {
      let at = index + (char === '$' ? 2 : 1)
      while (at < text.length && text[at] !== "'") at += char === '$' && text[at] === '\\' ? 2 : 1
      if (at >= text.length || (pending.length && text.slice(index, at).includes('\n'))) return undefined
      word += 'x'
      literal = true
      index = at + 1
    } else if (char === '"' || (char === '$' && next === '"')) {
      stack.push('"')
      literal = true
      word += 'x'
      index += char === '$' ? 2 : 1
    } else if (char === '\\') {
      // bash joins a line continuation before it reads an operator: `<\⏎<` is `<<`, `$\⏎[` an arithmetic expression.
      if (next === undefined || (next === '\n' && /[<$]/.test(text[index - 1] ?? ''))) return undefined
      if (next !== '\n') {
        word += 'x'
        literal = true
      }
      index += 2
    } else if (char === '$' && next === '(' && text[index + 2] === '(') {
      const end = arithmetic(index + 1)
      if (end === undefined) return undefined
      word += 'x'
      literal = true
      index = end
    } else if (char === '$' && next === '[') {
      const end = arithmetic(index + 1)
      if (end === undefined) return undefined
      word += 'x'
      literal = true
      index = end
    } else if (char === '$' && next === '(') {
      stack.push('$(')
      statement.substitutes = true
      word += 'x'
      literal = true
      atCommand = true
      index += 2
    } else if (char === '$' && next === '{') {
      const end = parameter(index + 1)
      if (end === undefined) return undefined
      word += 'x'
      literal = true
      index = end
    } else if (char === '`') {
      const end = backticks(index)
      if (end === undefined) return undefined
      statement.substitutes = true
      word += 'x'
      literal = true
      index = end
    } else if (char === '#' && word === '' && !literal) {
      const end = text.indexOf('\n', index)
      index = end === -1 ? text.length : end
    } else if (char === '\n') {
      endWord()
      index += 1
      if (pending.length) {
        statement.code += text.slice(codeFrom, index)
        const after = bodies(index)
        if (after === undefined) return undefined
        index = after
        codeFrom = index
      }
      if (stack.length === 0 && !continued) {
        statement.code += text.slice(codeFrom, index)
        statements.push(statement)
        statement = { code: '', substitutes: false, docs: [] }
        codeFrom = index
      }
      atCommand = true
    } else if (char === ' ' || char === '\t') {
      endWord()
      index += 1
    } else if (char === '<' && next === '<' && text[index + 2] !== '<') {
      endWord()
      if (test) return undefined
      let at = index + 2
      const tabs = text[at] === '-'
      if (tabs) at += 1
      while (text[at] === ' ' || text[at] === '\t') at += 1
      let delimiter = ''
      let quoted = false
      while (at < text.length && !/[ \t\n;&|()<>]/.test(text[at])) {
        const part = text[at]
        if (part === "'" || part === '"') {
          const close = text.indexOf(part, at + 1)
          if (close === -1 || /[\\$`\n]/.test(text.slice(at + 1, close))) return undefined
          delimiter += text.slice(at + 1, close)
          quoted = true
          at = close + 1
        } else if (part === '\\') {
          if (at + 1 >= text.length || text[at + 1] === '\n') return undefined
          delimiter += text[at + 1]
          quoted = true
          at += 2
        } else if (part === '$' || part === '`') return undefined
        else {
          delimiter += part
          at += 1
        }
      }
      if (delimiter === '') return undefined
      pending.push({ delimiter, tabs, quoted, depth: stack.length, captured: stack.includes('$('), operator: [index, at] })
      atCommand = false
      index = at
    } else if ((char === '<' || char === '>') && next === '(') {
      endWord()
      stack.push('$(')
      statement.substitutes = true
      atCommand = true
      index += 2
    } else if (char === '<' || char === '>' || (char === '&' && next === '>')) {
      endWord()
      index += (/^(?:<<<|<>|<&|>>|>\||>&|&>>|&>|[<>])/.exec(text.slice(index)) ?? [''])[0].length
      atCommand = false
    } else if (char === '(') {
      endWord()
      if (next === '(') {
        const end = arithmetic(index)
        if (end === undefined) return undefined
        index = end
      } else {
        stack.push('(')
        index += 1
      }
      atCommand = true
    } else if (char === ')') {
      endWord()
      if (stack.at(-1) === '(' || stack.at(-1) === '$(') {
        if (pending.some(doc => doc.depth >= stack.length)) return undefined
        stack.pop()
      }
      atCommand = true
      index += 1
    } else if (char === ';' || char === '&' || char === '|') {
      endWord()
      const operator = (/^(?:;;&|;;|;&|&&|\|\||\|&|[;&|])/.exec(text.slice(index)) ?? [char])[0]
      index += operator.length
      atCommand = true
      continued = ['|', '||', '&&', '|&'].includes(operator)
    } else {
      word += char
      index += 1
    }
  }
  endWord()
  if (pending.length || stack.at(-1) === '"') return undefined
  statement.code += text.slice(codeFrom)
  statements.push(statement)
  return statements
}

/** @typedef {{ from: number, to: number, operator: number[], quoted: boolean, captured: boolean, body: string }} Doc */

// The text with the bodies of `docs` cut out and each one's operator an empty here-string, so no here-document is left
// for a later reading to find.
const cutBodies = (text, /** @type {Doc[]} */ docs) => docs.flatMap(doc => [{ from: doc.operator[0], to: doc.operator[1], put: "<<<''" }, { from: doc.from, to: doc.to, put: '' }])
  .sort((a, b) => b.from - a.from).reduce((rest, { from, to, put }) => rest.slice(0, from) + put + rest.slice(to), text)

// The text without its here-document bodies (`quotedOnly`: those whose delimiter is quoted), or as it is when the guard
// cannot read them.
const withoutBodies = (text, quotedOnly = false) => {
  const statements = hereDocuments(text)
  return statements === undefined ? text : cutBodies(text, statements.flatMap(statement => statement.docs).filter(doc => !quotedOnly || doc.quoted))
}

const interpreter = word => /^(python[\d.]*|node|ruby|perl|deno|bun)$/.test(programName(word))
const processRunner = (text, program) => /\b(?:subprocess|child_process)\b|\bos\.(?:system|exec\w*|popen)\b|\bpty\.spawn\b|\b(?:execSync|exec|spawn|execFile|spawnSync|system)\s*(?:\(|["'])|\b(?:Bun\.spawn|Deno\.Command)\b/.test(text)
  || (/^(ruby|perl)$/.test(programName(program)) && /`|%x\b/.test(text))

// An interpreter whose whole script is on the line and runs no process: a `-c` or `-e` payload interpreterData() emptied, or
// a here-document read from stdin, on a line whose here-document bodies bodiesDropped() dropped.
const inlineData = words => {
  const [program, ...args] = strip(withoutRedirects(words))
  if (!interpreter(program ?? '')) return false
  const payload = args.findIndex(arg => /^-[ce]$/.test(arg))
  if (payload !== -1) return args[payload + 1] === '' && args.slice(0, payload).every(arg => arg.startsWith('-'))
  return words.some(word => /^\d*<</.test(word)) && args.every(arg => arg.startsWith('-'))
}

// Whether a statement may run what its here-documents hold: a substitution in it may read the stdin a here-document gives
// a loop, a group, a conditional or the command it sits in (`if true; then x=$(cat); fi <<'EOF'`, `x=$(cat) <<'EOF'`), and
// its output may be run later; or one of its commands may run what it reads (a word `runs` names, as its program or a
// wrapper's, or a dynamic program word, but an interpreter reading a script that starts no process), or reads it into a
// variable. Otherwise a loop, a group or a conditional runs only the commands in it.
const feedsCommand = (statement, runs) => statement.substitutes || commands(joined(statement.code, false)).some(words => {
  const plainWords = withoutRedirects(words)
  const head = plainWords.find(word => !ASSIGNMENT.test(word)) ?? ''
  const [program = '', ...args] = strip(plainWords)
  const script = interpreter(program) && args.every(arg => arg.startsWith('-')) && statement.docs.every(doc => !processRunner(doc.body, program))
  const running = word => runs(word) && !(word === program && script)
  return dynamic(head) || dynamic(program) || ['read', 'mapfile', 'readarray'].includes(programName(program)) || running(head) || running(program)
    || plainWords.some(word => word !== '.' && running(word))
})

// A function or an alias the text defines may run what a here-document holds under any name.
const DEFINES = /\bfunction\s|\w\s*\(\s*\)|(?:^|[;&|\n])\s*alias\s/

// A here-document's body is the input of its command: text, unless its statement may run it (see feedsCommand()), a
// substitution captures it as words that may go anywhere, or an unquoted body substitutes a command.
const bodiesDropped = (text, runs) => {
  const statements = hereDocuments(text)
  return statements === undefined || statements.some(statement => DEFINES.test(statement.code)) ? text
    : cutBodies(text, statements.flatMap(statement => feedsCommand(statement, runs) ? []
    : statement.docs.filter(doc => !doc.captured && (doc.quoted || !SUBSTITUTION.test(doc.body)))))
}

// Interpreter payloads are data unless they name a process runner. Keep shell substitutions visible and leave
// shell wrappers alone: their payloads still run as shell commands, even when they contain an interpreter. Here-document
// bodies are read as blanks, so a quote in one pairs with none outside it; when the guard cannot read them, nothing is data.
const interpreterData = line => {
  const statements = hereDocuments(line)
  if (statements === undefined) return line
  const text = statements.flatMap(statement => statement.docs)
    .reduce((rest, doc) => rest.slice(0, doc.from) + rest.slice(doc.from, doc.to).replace(/[^\n]/g, ' ') + rest.slice(doc.to), line)
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
  let result = line
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
  // A here-document body still on the line is one a command runs (see bodiesDropped()).
  const scriptless = hereDocuments(line)?.every(statement => statement.docs.length === 0) ?? false
  const textual = withoutBodies(line, true)
  for (const windows of [false, true]) {
    const text = joined(textual, windows)
    opaque ||= SUBSTITUTION.test(text.replace(quoted(windows), ''))
    const live = text.replace(quoted(windows), match => match.startsWith("'") ? '' : match)
    const views = [text, ...[...live.matchAll(new RegExp(SUBSTITUTION, 'g'))].map(match => live.slice(match.index + match[0].length))]
    for (const words of views.flatMap(view => [...commands(view, windows), ...keptCommands(view, windows)])) {
      // A group's closing `}` is no program word: the redirections after it apply to the group.
      const at = words.findIndex(word => !ASSIGNMENT.test(word) && !LEADS.includes(word) && word !== '}')
      if (at === -1) continue
      const [head, ...rest] = words.slice(at)
      if (namesGit(head)) hit ??= gitReach(rest)
      else {
        const run = strip(words.slice(at))[0] ?? ''
        opaque ||= (runner(head) || runner(run)) && !(scriptless && inlineData(words.slice(at)))
        dynamicHead ||= dynamic(head) || dynamic(run)
        rest.forEach((word, index) => { if (namesGit(word)) hit ??= gitReach(rest.slice(index + 1)) })
      }
    }
  }
  if (hit !== undefined || !(opaque || dynamicHead)) return hit
  const unquoted = [false, true].map(windows => joined(textual, windows))
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
// run: a quote that never closes, a `\` escape outside single quotes or a `$'...'` string as a POSIX shell reads it, a cmd
// `^` before a word character, or a `#` comment.
const sequence = (text, windows) => {
  const parts = []
  let from = 0
  let before = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (!windows && char === '$' && text[index + 1] === "'") return undefined
    if (char === "'") {
      index = text.indexOf("'", index + 1)
      if (index === -1) return undefined
    } else if (char === '"') {
      for (index += 1; index < text.length && text[index] !== '"'; index += 1) if (!windows && text[index] === '\\') return undefined
      if (index === text.length) return undefined
    } else if (char === '#' || (windows ? char === '^' && !/^[\d^~\s]?$/.test(text[index + 1] ?? '') : char === '\\')) return undefined
    else if (char === ';' || char === '\n' || (char === '&' && text[index + 1] === '&') || char === '|') {
      parts.push({ words: wordsOf(text.slice(from, index), windows), goesOn: char !== '&', before })
      before = char === '&' || (char === '|' && text[index + 1] === '|') ? char + char : char
      if (before.length === 2) index += 1
      from = index + 1
    }
  }
  parts.push({ words: wordsOf(text.slice(from), windows), before })
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
      || ['source', '.', 'eval', 'iex', 'invoke-expression'].includes(name) || dynamic(head) || (head.includes(':') && !ASSIGNMENT.test(head))
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
    lease: sub === 'push' && args.some(arg => /^--force-with-lease(=|$)/.test(arg)),
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

// Each folder a cd or a -C to `target` lands in, as moved() places it, once `lookup` has expanded its variables.
const reached = (places, target, path, lookup) => expansions(target, lookup).flatMap(at => at === undefined ? [null] : moved(places, at, path))

// A cd to a bare relative name (not ./ ../ absolute or ~) searches CDPATH when it is set, so it may land in any folder
// CDPATH lists: the guard cannot place it.
const searched = target => !/^(?:\.{1,2}(?:[\\/]|$)|[\\/]|~|[A-Za-z]:)/.test(target)

const placeRules = (own, path, cdpath, env) => {
  const seat = real(path.resolve(own), path)
  return {
    path,
    env,
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
const walk = (parts, start, rules, sub, line, windows) => {
  const { path } = rules
  const variables = varScope(environment(rules.env, line, windows), line, windows)
  let places = [...start]
  let since = [...start]
  const stack = []
  const pushed = []
  let stacked = false
  let unsure = false
  let gitRan = false
  const hop = (from, to, lookup) => expansions(to, lookup).flatMap(at => {
    const next = at === undefined ? [null] : moved(from, at, path)
    if (!gitRan || next.includes(null)) return next
    const target = at.replace(/\\/g, path.sep)
    return from.every(place => existsSync(path.isAbsolute(target) ? target : place + path.sep + target)) ? next : [null]
  })
  const last = parts.findLastIndex(({ command }) => command.discard || command.lease)
  for (const { command, goesOn, words, before } of parts.slice(0, last + 1)) {
    const lookup = variables.feed(words, before)
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
      places = hop(places, command.target, lookup)
      if (places.includes(null)) return rules.refuse(sub)
    } else {
      let dirs = places
      let tree
      for (const [option, to] of command.hops) {
        if (option === '-C') dirs = hop(dirs, to, lookup)
        else tree = to
      }
      const folders = tree === undefined ? dirs : hop(dirs, tree, lookup)
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
  const lines = withoutBodies(text).replace(/([<>])&/g, '$1')
  for (const words of commands(lines, windows)) {
    const clean = words.filter(word => !isRedirect(word))
    const first = clean.find(word => !ASSIGNMENT.test(word))
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
  for (const windows of script !== undefined || windowsLine(line, rules.path, bash) ? [true] : [false, true]) {
    const text = joined(script ?? line, windows)
    const parts = notSimpleLine(text) ? undefined : sequence(text, windows)?.map(({ words, goesOn, before }) => ({ command: plain(words), goesOn, words, before }))
    if (parts === undefined || parts.some(({ command }) => command === undefined)) {
      const others = otherCommands(text, windows)
      return rules.refuse(sub, others.length ? others.join(', ') : undefined)
    }
    const runs = parts.find(({ command }) => command.script)
    if (runs) return rules.script(runs.command.script)
    const reason = walk(parts, start, rules, sub, text, windows)
    if (reason) return reason
  }
  return undefined
}

// Programs that change neither HEAD, an upstream, a setting, the folder nor the environment, and run no other program.
const STILL = ['echo', 'printf', 'true', 'false', 'test', '[', ':', 'pwd', 'cat', 'head', 'tail', 'grep', 'wc', 'sleep', 'date', 'ls']
// git subcommands that move no HEAD and change no upstream or setting.
const GIT_STILL = ['status', 'log', 'diff', 'show', 'add', 'commit', 'merge', 'cherry-pick', 'revert', 'am', 'tag', 'rev-parse', 'rev-list',
  'ls-files', 'ls-remote', 'show-ref', 'for-each-ref', 'describe', 'merge-base', 'blame', 'grep', 'shortlog', 'cat-file']

// Whether a command's redirections write a file: any target but /dev/null, nul or another descriptor.
const writesFile = words => words.some((word, at) => {
  const operator = /^(?:\d+|&)?>>?[|&]?/.exec(word)
  return operator !== null && !/^(?:\/dev\/null|nul|-|\d+)$/i.test(word.slice(operator[0].length) || words[at + 1] || '')
})

// Whether a command may change what a push with no :<dst> reads to find where it lands: HEAD (checkout, switch, rebase,
// reset, bisect, symbolic-ref, update-ref, branch), an upstream (branch -u, push, fetch or pull --set-upstream), a setting
// (config, remote, worktree), the folder (cd) or the environment, or whether it runs what the guard does not know: any
// other program, git subcommand or alias, an expansion, or a redirection into a file.
const movesLanding = words => {
  const run = words.slice(Math.max(0, words.findIndex(word => !LEADS.includes(word))))
  const [head, ...rest] = withoutRedirects(run)
  if (head === undefined) return false
  if (writesFile(run) || ASSIGNMENT.test(head) || dynamic(head) || rest.some(dynamic)) return true
  if (programName(head) !== 'git') return !STILL.includes(programName(head))
  let index = 0
  while (rest[index] === '--no-pager' || rest[index] === '-P') index += 1
  const [sub = '', ...args] = rest.slice(index)
  if (sub === 'push') return args.some(arg => longOption(arg, '--set-upstream') || shortFlags(arg).includes('u'))
  if (sub === 'fetch' || sub === 'pull') return args.some(arg => longOption(arg, '--set-upstream'))
  return !GIT_STILL.includes(sub) && !(sub === 'branch' && args.every(arg => LISTS.includes(arg.split('=')[0])))
}

const orderReason = branch => 'A command before this push on the line, or beside it, may move HEAD or change an upstream or a setting that '
  + `decides where a push with no :<dst> lands. Run the push as its own call, or name the branch: git push --force-with-lease <remote> HEAD:${branch}.`

// The commands of a sequence grouped by pipeline: the commands of one run side by side.
const pipelines = parts => parts.reduce((groups, part) => {
  if (part.before === '|' && groups.length) groups.at(-1).push(part.words)
  else groups.push([part.words])
  return groups
}, [])

/**
 * Why a lease push on `line` is refused for what runs before or beside it, or undefined: one that lands where HEAD, an
 * upstream or a setting sends it (landsByHead()) after a command that may change them (movesLanding()), since the guard
 * read them before the line ran. Read as a sequence, a command runs after those before it and beside the others of its
 * pipeline; on a line with a subshell, a substitution, a here-document, a loop, a function or a background job, every
 * command may run before any other. A shell's script and a git alias's expansion are read the same way; `moved` says a
 * command that ran before them may have changed where a push lands.
 */
const leaseOrder = (line, branch, repo, moved = false, depth = 0) => {
  for (const windows of [false, true]) {
    const text = joined(line, windows)
    const parts = notSimpleLine(text) ? undefined : sequence(text, windows)
    let ran = moved
    for (const group of parts === undefined ? [commands(text, windows)] : pipelines(parts)) {
      const moves = group.map(movesLanding)
      for (const [at, words] of group.entries()) {
        const reason = leaseRun(words, branch, repo, ran || moves.some((move, other) => move && other !== at), depth)
        if (reason) return reason
      }
      ran ||= moves.includes(true)
    }
  }
  return undefined
}

// Why one command, run after commands that may have changed where a push lands (`moved`), is refused as leaseOrder()
// reads it: a lease push itself, or one in a shell's script or a git alias's expansion.
const leaseRun = (words, branch, repo, moved, depth) => {
  const [first, ...args] = strip(withoutRedirects(words))
  if (!first) return undefined
  const name = programName(first)
  if (SHELLS.includes(name)) {
    const script = shellScript(args)
    return script === undefined ? undefined : leaseOrder(script, branch, repo, moved, depth)
  }
  if (name !== 'git') return undefined
  let index = 0
  while (index < args.length && args[index].startsWith('-')) index += GIT_VALUE_OPTIONS.includes(args[index]) ? 2 : 1
  const rest = args.slice(index + 1)
  if (args[index] === 'push') return moved && landsByHead(rest) && rest.some(arg => longOption(arg, '--force-with-lease')) ? orderReason(branch) : undefined
  const runs = depth < ALIAS_DEPTH ? aliasExpansions(args, repo, () => [undefined]) : undefined
  return runs?.filter(run => run !== undefined).map(run => leaseOrder(run, branch, repo, moved, depth + 1)).find(Boolean)
}

/**
 * Why an owner seat's command line is refused, or undefined when it may run: whatever check() refuses, and then, with the
 * seat's folder known (`own`), a line that may reach a discarding git command (clean -f, checkout, restore, a forced switch,
 * stash, rm, reset but --soft, read-tree -u, checkout-index -f, a rebase or merge --abort, --quit or --skip, a leased push)
 * unless the line keeps each such git command inside that folder; last, a lease push another command on its line may send
 * elsewhere (leaseOrder()). With no folder known, check() and leaseOrder() alone: a Claude subagent owner's hook input
 * carries the parent session's folder, not the seat's. With `cdpath`
 * set (the hook's CDPATH), a cd to a bare relative name may land anywhere it lists, so the line is refused. `bash` says
 * the line runs in Claude Code's Bash tool, a POSIX shell on every host. `checkedOutBranches`: the branches the worktree
 * checked out, which a push may delete besides `seat/<id>`. `repo` answers for the git aliases of the repository the line
 * runs in (see Repo), whose expansion is checked as the line would run it. `env`, the hook's environment, gives the
 * variables a folder or a delete target expands with and the OS temp folder; without it no variable expands.
 */
export const guard = (line, branch, cwd = process.cwd(), path = nodePath, own = undefined, cdpath = undefined, bash = false, checkedOutBranches = [],
  repo = NO_REPO, env = undefined, depth = 0) => {
  line = bodiesDropped(interpreterData(line), runner)
  const ctx = { env, repo, depth, bash, expand: (expanded, at) => guard(expanded, branch, at, path, own, cdpath, bash, checkedOutBranches, repo, env, depth + 1) }
  return check(line, branch, cwd, path, own, seatBranches(own, path), cdpath, ctx) ?? pushCheck(line, [...seatBranches(own, path), ...checkedOutBranches.filter(name => !DEFAULT_BRANCHES.includes(name))])
    ?? (own === undefined ? undefined : stray(line, [path.resolve(cwd)], placeRules(own, path, cdpath, env), bash)) ?? leaseOrder(line, branch, repo)
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
 * What the guards ask of the repository a command runs in. `kind(name)`: 'branch' for a local branch (or `-`
 * naming one), 'commit' for another name of a commit, 'remote' for a name git checkout would make a branch of from a
 * remote branch, undefined otherwise. `alias(name)`: the alias git would run for `git <name>`, or undefined. `config(key)`:
 * every value git config holds for the key, none when unset. `remotes()`: the remotes' names.
 * @typedef {{ kind: (name: string) => string | undefined, alias: (name: string) => string | undefined, config: (key: string) => string[],
 *   remotes: () => string[] }} Repo
 */
/** @type {Repo} */
const NO_REPO = { kind: () => undefined, alias: () => undefined, config: () => [], remotes: () => [] }

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
const GIT_ENV = /^(?:\$env:)?(GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_INDEX_FILE)(\+?)=(.*)$/i
const MAIN_REASON = main => `Leave the main checkout (${main.join(', ')}) as it is: run git, folder changes and writes only in your own worktree.`


/** Whether `dir` is in one of the `main` checkouts and not in the seat's own folder. */
const mainFence = (main, own, path) => {
  const roots = main.map(dir => real(path.resolve(dir), path)).filter(dir => dir !== null).map(dir => folded(dir, path))
  const seat = own === undefined ? null : real(path.resolve(own), path)
  return dir => dir !== null && roots.some(root => within(dir, root, path)) && !(seat !== null && within(dir, folded(seat, path), path))
}

const CD_REASON = 'After a cd to a folder the guard cannot place, write or run a git command that writes only at an absolute path, or cd to a '
  + 'literal path or one through environment variables this shell already has, as in cd "$TMPDIR": the guard cannot tell where this cd lands.'
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

// The text a target may be once `lookup` expands it: `~`, `$PWD`, `%NAME%` and variables (see expansions()); a target
// without them as it is.
const targetTexts = (target, lookup) => /[$`]|%[A-Za-z_]\w*%|^~(?=$|[\\/])/.test(target) ? expansions(target, lookup) : [target]

// The folders a cd target may name once expanded, undefined for one it cannot expand or names no other way the guard can place.
const resolvedTargets = (target, lookup) => targetTexts(target, lookup).map(at => at !== undefined && placeable(at) ? at : undefined)

// Each folder `at` lands in from `places`: an absolute path lands where it names, whatever folder a cd left the line in.
const landing = (places, at, path) => moved(path.isAbsolute(at) ? [path.parse(path.resolve(at)).root] : places, at, path)

// Where a git or write target may land, expanded as a cd's is: each path to place, null for an expansion that reads a
// variable or a command substitution the guard cannot expand, none for one that names no path the guard places
// (`user:group`, a PowerShell drive). A glob lands under the folder before its first wildcard. PowerShell's `$null` names no file.
const targetPaths = (target, lookup) => /^\$null$/i.test(target) ? [] : targetTexts(target, lookup).flatMap(expanded => {
  if (expanded === undefined) return [null]
  const wildcard = expanded.search(/[*?[\]{}]/)
  const fixed = wildcard === -1 ? expanded : expanded.slice(0, wildcard).replace(/[^\\/]*$/, '') || '.'
  return placeable(fixed) ? [fixed] : []
})

// The files an apply_patch envelope adds, updates, deletes or moves to: codex's file-edit tool, or its CLI form run in a shell.
export const patchFiles = text => [...text.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$/gm)].map(match => match[1])

function reviewerRefusal(words, places, ctx, lookup) {
  const { path, inMain, main } = ctx
  // Where a git or write target lands: [] when the guard cannot expand it, null among them under a folder a cd left unplaced.
  const lands = target => targetPaths(target, lookup).flatMap(at => at === null ? [] : landing(places, at, path))
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
    if (targetPaths(target, lookup).includes(null)) unplaced = true
    return lands(target).some(inMain) ? MAIN_REASON(main) : undefined
  }
  const gitEnv = assignments(words).flatMap(word => {
    const [, name, append, value] = GIT_ENV.exec(word) ?? []
    return name === undefined ? [] : [append ? '${' + name + '}' + value : value]
  }).map(gitAimed).find(Boolean)
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
    return script === undefined ? undefined : reviewerLine(script, places, { ...ctx, windowsOnly: false }, lookup)
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
      const ats = value === undefined ? [] : targetPaths(value, lookup).filter(at => at !== null)
      if (option === '-C' && ats.length) dirs = ats.flatMap(at => landing(dirs, at, path))
      index += GIT_VALUE_OPTIONS.includes(option) ? 2 : 1
    }
    if (dirs.some(inMain)) return MAIN_REASON(main)
    const sub = args[index] ?? ''
    const rest = args.slice(index + 1)
    const aliased = aliasExpansions(args, ctx.repo, gitEnvironment(words, lookup))
    if (aliased !== undefined) {
      return aliased.includes(undefined) ? ALIAS_UNREAD_REASON : ctx.depth >= ALIAS_DEPTH ? ALIAS_DEPTH_REASON
        : aliased.map(expansion => ctx.recheck(expansion, places.find(place => place !== null) ?? '.')).find(Boolean)
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

// `starts` are the folders the line may start in, null among them for one a cd left unplaced; `outer` the variables of the
// line that runs this one in a shell, else those of ctx.env.
function reviewerLine(line, starts, ctx, outer = undefined) {
  const { path, inMain, main } = ctx
  const raw = ctx.raw ?? line
  if (patchFiles(line).some(file => starts.some(start => start !== null && inMain(path.resolve(start, file))))) return MAIN_REASON(main)
  // The shell splits a substituted cd's `$(...)` into commands of their own, leaving the cd without a folder.
  const substituted = SUBSTITUTED_CD.test(quotedParensDropped(line))
  for (const windows of ctx.windowsOnly ? [true] : [false, true]) {
    let places = starts
    const operators = []
    const found = commands(line, windows, operators)
    const variables = varScope(outer ?? environment(ctx.env, raw, windows), raw, windows)
    for (const [at, words] of found.entries()) {
      const lookup = variables.feed(words, operators[at])
      const [head, ...rest] = words.filter(word => !isRedirect(word))
      if (head !== undefined && (CD_WORDS.includes(head.toLowerCase()) || /^(?:cd|chdir)[./\\]/i.test(head))) {
        if (POP_WORDS.includes(head.toLowerCase())) continue
        const written = cdTarget(rest, head)
        // zsh's `cd old new` swaps old for new in the current folder's path. A cd the guard cannot place adds an unplaced
        // folder (null): what follows runs unless it writes, or runs git that writes, under a relative path.
        if (written === undefined && !substituted && rest.filter(arg => !arg.startsWith('-')).length < 2) continue
        const targets = written === undefined ? [undefined] : resolvedTargets(written, lookup)
        places = [...new Set([...places, ...targets.flatMap(target => target === undefined ? [null] : landing(places, target, path))])]
        if (places.some(inMain)) return MAIN_REASON(main)
        continue
      }
      const reason = reviewerRefusal(words, places, ctx, lookup)
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
  const text = bodiesDropped(interpreterData(line), program => SHELLS.includes(programName(program)))
  return guard(line, branch, cwd, path, own, cdpath, bash, checkedOutBranches, repo, env)
    ?? (inMain(path.resolve(cwd)) ? MAIN_REASON(main)
      : patchFiles(line).some(file => inMain(path.resolve(cwd, file))) ? MAIN_REASON(main)
      : reviewerLine(text, [path.resolve(cwd)], { path, inMain, main, repo, env, recheck, depth, raw: line, windowsOnly: windowsLine(line, path, bash) }))
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

/** The repository at `cwd` as the guards ask of it. @returns {Repo} */
const repoAt = cwd => {
  const git = (...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })
  /** @type {Set<string> | undefined} */
  let commands
  const aliases = new Map()
  /** @type {Map<string, string[]> | undefined} */
  let settings
  const settingKey = key => key.slice(0, key.indexOf('.')).toLowerCase() + key.slice(key.indexOf('.'), key.lastIndexOf('.')) + key.slice(key.lastIndexOf('.')).toLowerCase()
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
      if (!aliases.has(name)) {
        const found = git('config', '--get', 'alias.' + name)
        commands ??= found.status === 0 ? new Set((git('--list-cmds=builtins,main,others').stdout ?? '').split('\n')) : undefined
        aliases.set(name, found.status !== 0 || commands?.has(name) ? undefined : found.stdout.replace(/\r?\n$/, ''))
      }
      return aliases.get(name)
    },
    // Every setting, read once: a key's section and name are case-insensitive, its subsection is not. A key with no value
    // reads as '', which a boolean setting takes as true.
    config: key => {
      if (settings === undefined) {
        settings = new Map()
        for (const entry of (git('config', '--list', '-z').stdout ?? '').split('\0').filter(Boolean)) {
          const end = entry.includes('\n') ? entry.indexOf('\n') : entry.length
          const name = settingKey(entry.slice(0, end))
          settings.set(name, [...(settings.get(name) ?? []), entry.slice(end + 1)])
        }
      }
      return settings.get(settingKey(key)) ?? []
    },
    remotes: () => (git('remote').stdout ?? '').split(/\r?\n/).filter(Boolean),
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
    : guard(line, pushed, cwd, nodePath, own, process.env.CDPATH, bash, checked, repoAt(cwd), process.env)
  const name = 'seat-router ' + (reviewer ? 'reviewer' : 'owner') + ' guard: '
  if (reason && agy) process.stdout.write(JSON.stringify({ decision: 'deny', reason: name + reason }) + '\n')
  else if (reason) {
    // codex shows the reason followed by ". Command: <line>".
    const hookSpecificOutput = { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: name + reason.replace(/\.$/, '') }
    process.stdout.write(JSON.stringify({ hookSpecificOutput }) + '\n')
  }
}
