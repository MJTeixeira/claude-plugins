#!/usr/bin/env node
// The owner seat's PreToolUse hook. It stops accidents in plain commands, not a seat trying to get around it (owner
// ruling, 2026-11-08): it reads the commands a line runs, a shell's -c script among them, and reads a here-document's
// body and a quoted argument as text. A folder, a variable or a target it cannot place runs; a forced recursive delete
// reads a variable nothing sets as empty, as the shell does, and refuses a path that starts with one.
// codex and Claude send `tool_input.command` and `cwd` (codex reports a call's own workdir there only from
// openai/codex#57198) and are refused with a `hookSpecificOutput` deny, not exit 2: on Windows codex runs the hook through
// PowerShell `-Command`, which reports exit 2 as 1, and a failed hook lets the command run (openai/codex#48183). agy sends
// `toolCall.args.CommandLine` (with `Cwd`, else its workspace is the cwd) and is refused with its own JSON decision.
// With --reviewer it is a worktree reviewer's hook: the owner's refusals, then reviewerGuard()'s, and a Claude file
// tool's write into a --main checkout.
// Usage: node owner-guard.mjs [--own SEAT_FOLDER] [--reviewer [--main CHECKOUT]...] [--claude] < hook-input.json
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { isSeatId } from './core/layout.mjs'

const SHELLS = ['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'cmd']
const WRAPPERS = ['command', 'builtin', 'exec', 'nohup', 'time', 'sudo', 'doas', 'xargs', 'nice', 'env']
// Shell words a command's program may follow.
const LEADS = ['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!']
const CD_WORDS = ['cd', 'chdir', 'pushd', 'popd', 'sl', 'set-location', 'push-location', 'pop-location']
const CD_OPTIONS = ['/d', '-l', '-p', '-path', '-literalpath', '--']
const GIT_VALUE_OPTIONS = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']
const PUSH_VALUE_OPTIONS = ['--repo', '--receive-pack', '--exec', '-o', '--push-option']
const DEFAULT_BRANCHES = ['main', 'master', 'dev', 'develop', 'trunk']
const ASSIGNING = ['export', 'declare', 'typeset', 'local', 'readonly']
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/
// Where a command substitution cut a word: the word's value is one the guard cannot read.
const CUT = '\u0000'

/**
 * A command line as simple commands, each a list of words; quotes are honoured, and every shell operator ends a command. A
 * `\` escapes the next character as in a POSIX shell; read the `windows` way, `\` is an ordinary character and cmd's `^`
 * and PowerShell's `` ` `` escape the next one instead. A `#` that starts a word comments out the rest of its line.
 */
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
    const next = line[index + 1]
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
    } else if ((windows ? char === '^' || char === '`' : char === '\\') && next !== undefined) {
      if (next !== '\n') {
        word += next
        started = true
      }
      index += 1
    } else if (char === '#' && !started) {
      const end = line.indexOf('\n', index)
      index = (end === -1 ? line.length : end) - 1
    } else if (char === '$' && next === '{') {
      const close = line.indexOf('}', index)
      const end = close === -1 ? line.length : close + 1
      word += line.slice(index, end)
      started = true
      index = end - 1
    } else if (char === '&' && (next === '>' || /[<>]/.test(line[index - 1] ?? ''))) {
      word += char
      started = true
    } else if (char === '\n' || ';&|(){}'.includes(char) || char === '`' || (char === '$' && next === '(')) {
      if (char === '`' || char === '$') {
        word += CUT
        started = true
      }
      endCommand()
      if (char === '$') index += 1
    } else if (/\s/.test(char)) endWord()
    else {
      word += char
      started = true
    }
  }
  endCommand()
  return found
}

/** The text without its here-documents' bodies: a body is the input of its command, which reads it as text. */
export const withoutBodies = text => {
  let out = ''
  let quote = ''
  const pending = []
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote) {
      if (char === quote) quote = ''
      else if (char === '\\' && quote === '"') {
        out += char
        index += 1
      }
      out += text[index] ?? ''
      continue
    }
    if (char === "'" || char === '"') quote = char
    else if (char === '\\') {
      out += char
      index += 1
    } else if (char === '#' && /^$|[\s;&|(]$/.test(text[index - 1] ?? '')) {
      const end = text.indexOf('\n', index)
      out += text.slice(index, end === -1 ? text.length : end)
      index = (end === -1 ? text.length : end) - 1
      continue
    } else if (char === '<' && text[index + 1] === '<' && text[index + 2] !== '<') {
      const doc = /^<<(-?)\s*\\?(['"]?)([^\s'"\\;&|<>()]+)\2/.exec(text.slice(index))
      if (doc) {
        pending.push({ tabs: doc[1] === '-', delimiter: doc[3] })
        out += doc[0]
        index += doc[0].length - 1
        continue
      }
    } else if (char === '\n' && pending.length) {
      let at = index + 1
      for (const { tabs, delimiter } of pending) {
        while (at < text.length) {
          const end = text.indexOf('\n', at)
          const body = text.slice(at, end === -1 ? text.length : end)
          at = end === -1 ? text.length : end + 1
          if ((tabs ? body.replace(/^\t+/, '') : body) === delimiter) break
        }
      }
      pending.length = 0
      out += char
      index = at - 1
      continue
    }
    out += text[index] ?? ''
  }
  return out
}

const programName = word => word.replaceAll('\\', '/').split('/').pop().toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '')

const isRedirect = word => /^(?:\d+|&)?(?:>>?|<>?|>&|<)/.test(word)
const REDIRECT_ALONE = /^(?:\d+|&)?(?:>>?\|?|<<<|<<-?|<>?|[<>]&)$/
// The words of a command but its redirections: an operator glued to its file (`>out`, `2>/dev/null`), or alone and the
// word after it.
const withoutRedirects = words => words.filter((word, at) => !isRedirect(word) && !(at > 0 && REDIRECT_ALONE.test(words[at - 1])))
// The files a command's output redirections write.
const redirectTargets = words => words.flatMap((word, at) => {
  const glued = /^(?:\d+|&)?>>?\|?([^>|&].*)$/.exec(word)
  return glued ? [glued[1]] : /^(?:\d+|&)?>>?\|?$/.test(word) && words[at + 1] !== undefined ? [words[at + 1]] : []
})

// The words that run: redirections, assignments, the shell words a program may follow, and wrappers like `env` or
// `command` with their options dropped.
const strip = words => {
  let rest = withoutRedirects(words)
  for (;;) {
    while (rest.length && (ASSIGNMENT.test(rest[0]) || LEADS.includes(rest[0]))) rest = rest.slice(1)
    if (!rest.length || !WRAPPERS.includes(programName(rest[0]))) return rest
    rest = rest.slice(1)
    while (rest[0]?.startsWith('-')) rest = rest.slice(1)
  }
}

const shortFlags = word => /^-[A-Za-z]+$/.test(word) ? word.slice(1) : ''

// The script of a shell's -c (cmd's /c, PowerShell's -Command), or undefined.
const shellScript = args => {
  const at = args.findIndex(arg => /^-[a-z]*c$/i.test(arg) || /^\/c$/i.test(arg) || /^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(arg))
  const script = args.slice(at + 1)
  return at === -1 ? undefined : (script[0] === '--' ? script.slice(1) : script).join(' ')
}

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

/** Whether `dir` is `root` or inside it, links resolved. */
const within = (dir, root, path) => {
  const [inner, outer] = [dir, root].map(each => each === null || each === undefined ? null : real(each, path))
  if (inner === null || outer === null) return false
  const [a, b] = [folded(inner, path), folded(outer, path)]
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep)
}

// Variables the shell always sets, to values the guard cannot read.
const SHELL_SET = ['0', '$', '?', '!', '#', '-']

/**
 * What `word` stands for once `~` and its variables are expanded through `lookup`: its `text`, with a variable `isSet`
 * says nothing sets read as empty, as the shell reads it, and named in `unset`; `unknown` when a command substitution,
 * a value set to one the guard cannot read or a `${…}` form but `${X}` and `${X:?}` gives part of it; `aborts` when a
 * `${X:?}` of an unset X stops the shell before the command runs.
 */
const expansion = (word, lookup, isSet = name => lookup(name) !== undefined) => {
  const unset = []
  let unknown = word.includes(CUT) || /\$\(|`/.test(word)
  let aborts = false
  const value = (name, check) => {
    const found = lookup(name)
    if (found !== undefined) return found
    if (isSet(name) || SHELL_SET.includes(name)) unknown = true
    else if (check) aborts = true
    else unset.push(name)
    return ''
  }
  const text = word.replace(/^~(?=$|[\\/])/, () => lookup('HOME') ?? value('USERPROFILE'))
    .replace(/\$env:([A-Za-z_]\w*)|\$\{([A-Za-z_]\w*)(:?\?[^}]*)?\}|\$([A-Za-z_]\w*|\d|[@*#?$!-])|%([A-Za-z_]\w*)%/g,
      (_, env, braced, check, plain, percent) => value(env ?? braced ?? plain ?? percent, check))
  return { text, unset, unknown: unknown || /\$\{/.test(text), aborts }
}

/** The text `word` stands for, or undefined when a part of it is one the guard cannot read or nothing sets. */
const expand = (word, lookup) => {
  if (word === undefined) return undefined
  const { text, unset, unknown, aborts } = expansion(word, lookup)
  return unknown || aborts || unset.length ? undefined : text
}

// The folder `text` names from `at`, or null when the guard cannot place it.
const place = (at, text, path) => {
  if (text === undefined) return null
  if (path.isAbsolute(text)) return path.resolve(text)
  return at === null ? null : path.resolve(at, text)
}

const envValue = (env, name) => {
  if (env[name] !== undefined) return env[name]
  const key = Object.keys(env).find(each => each.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : env[key]
}

// Where a cd-like command leads from `at`: undefined for a command that is not one, null for a folder the guard cannot
// place (`-`, a stack entry, a substitution).
const cdTo = (words, at, lookup, path) => {
  const [head = '', ...rest] = withoutRedirects(words)
  const name = head.toLowerCase()
  if (!CD_WORDS.includes(name)) return undefined
  if (['popd', 'pop-location'].includes(name)) return null
  const args = rest.filter(arg => !CD_OPTIONS.includes(arg.toLowerCase()))
  if (args.length === 0) return place(at, lookup('HOME'), path)
  return args.length === 1 && !/^[-+]/.test(args[0]) ? place(at, expand(args[0], lookup), path) : null
}

/**
 * Why `visit` refuses a command of `line`, which starts in the folder `start`, or undefined. It is fed each command, the
 * folder it runs in (null where a cd left one the guard cannot place), the lookup of the variables it sees (the line's
 * own, set before it with `X=v` or `export X=v`, then `ctx.env`'s), for a cd where it leads, and whether a variable is
 * set at all, to a value the guard can read or not (`S=$(mktemp -d)`, a `for X in` loop's).
 */
const walk = (line, start, ctx, visit) => {
  const vars = new Map()
  let at = start
  for (const words of commands(withoutBodies(line), ctx.windows)) {
    const lookup = name => name === 'PWD' ? at ?? undefined : vars.has(name) ? vars.get(name) : envValue(ctx.env, name)
    const isSet = name => name === 'PWD' || vars.has(name) || envValue(ctx.env, name) !== undefined
    const head = words.findIndex(word => !ASSIGNMENT.test(word) && !LEADS.includes(word))
    const persists = head === -1 || ASSIGNING.includes(programName(words[head]))
    for (const word of persists ? words.filter(each => ASSIGNMENT.test(each)) : []) {
      const [name, value] = [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)]
      vars.set(name.replace(/\+$/, ''), name.endsWith('+') ? undefined : expand(value, lookup))
    }
    if (words[0] === 'for' && words[1] !== undefined) vars.set(words[1], undefined)
    const to = cdTo(words, at, lookup, ctx.path)
    const reason = visit(words, at, lookup, to, isSet)
    if (reason) return reason
    if (to !== undefined) at = to
  }
  return undefined
}

/** A git command's folder (moved by -C and --work-tree; null where the guard cannot place it), --git-dir, subcommand and its arguments. */
const gitCommand = (args, at, lookup, path) => {
  let folder = at
  let tree
  let gitDir
  let index = 0
  for (; args[index]?.startsWith('-'); index += 1) {
    const option = args[index]
    const glued = option.startsWith('--') && option.includes('=')
    const flag = glued ? option.slice(0, option.indexOf('=')) : option
    const value = glued ? option.slice(option.indexOf('=') + 1) : GIT_VALUE_OPTIONS.includes(flag) ? args[++index] : undefined
    if (flag === '-C') folder = place(folder, expand(value, lookup), path)
    else if (flag === '--work-tree') tree = value
    else if (flag === '--git-dir') gitDir = value
  }
  const placed = value => value === undefined ? undefined : place(folder, expand(value, lookup), path)
  return { folder: tree === undefined ? folder : placed(tree), gitDir: placed(gitDir), sub: args[index] ?? '', rest: args.slice(index + 1) }
}

const branchOf = ref => ref.replace(/^refs\/heads\//, '')

// Subcommands that discard work, or move the branch, of the checkout they run in.
const discards = (sub, rest) => ['checkout', 'switch', 'restore', 'rm', 'reset'].includes(sub)
  || (sub === 'clean' && rest.some(arg => arg === '--force' || shortFlags(arg).includes('f')))
  || (sub === 'stash' && !['list', 'show'].includes(rest[0] ?? ''))

const FORCE_REASON = 'Force-push only onto the branch checked out here, and never onto main, master, dev, develop or trunk; '
  + '--force-with-lease may update another branch of yours.'
const HOOKS_REASON = 'Push with the repository\'s own push hooks: no --no-verify.'
const DELETE_BRANCH_REASON = name => `Delete only a branch this seat created or checked out, never a default branch: ${name} is not one.`

// Why a push is refused: it deletes a branch that is not this seat's (see ctx.mine), forces a branch that stays (see
// ctx.kept) or another branch than `branch` with more than a lease, skips the push hooks, or mirrors or prunes.
const pushRefusal = (args, ctx) => {
  const plain = []
  let lease = false
  let hard = false
  let deletes = false
  let every = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--no-verify') return HOOKS_REASON
    if (arg === '--mirror' || arg === '--prune') return 'Push named branches, without --mirror or --prune: both delete remote branches.'
    if (arg.startsWith('--force-with-lease') || arg === '--force-if-includes') lease = true
    else if (arg === '--force' || shortFlags(arg).includes('f')) hard = true
    else if (arg === '--delete' || shortFlags(arg).includes('d')) deletes = true
    else if (arg === '--all' || arg === '--branches') every = true
    else if (PUSH_VALUE_OPTIONS.includes(arg)) index += 1
    else if (!arg.startsWith('-')) plain.push(arg)
  }
  const specs = plain.slice(1)
  const deleted = specs.flatMap(spec => deletes ? [spec] : /^\+?:./.test(spec) ? [spec.slice(spec.indexOf(':') + 1)] : []).map(branchOf)
  const other = deleted.find(name => !ctx.mine(name))
  if (other !== undefined) return DELETE_BRANCH_REASON(other)
  hard ||= specs.some(spec => spec.startsWith('+'))
  if (!hard && !lease) return undefined
  if (every) return FORCE_REASON
  const branch = ctx.branch()
  const targets = specs.filter(spec => !/^\+?:/.test(spec)).map(spec => {
    const target = spec.replace(/^\+/, '').split(':').at(-1) ?? ''
    return ['HEAD', '@'].includes(target) ? branch : branchOf(target)
  })
  const lands = targets.length ? targets : [branch]
  return lands.some(target => !target || ctx.kept(target)) || (hard && lands.some(target => target !== branch)) ? FORCE_REASON : undefined
}

const RECURSE = /^-r(e(c(u(r(s(e)?)?)?)?)?)?(:.*)?$/i
const FORCE_PARAMETER = /^-fo(r(c(e)?)?)?(:.*)?$/i

// The targets of a forced recursive delete (rm -rf, PowerShell's Remove-Item -Recurse -Force, cmd's rd /s /q), or undefined.
const forcedTargets = (name, args) => {
  if (['rd', 'rmdir', 'del', 'erase'].includes(name) && args.some(arg => /^\/s$/i.test(arg)) && args.some(arg => /^\/[qf]$/i.test(arg))) {
    return args.filter(arg => !/^\/[a-z?]$/i.test(arg))
  }
  if (!['rm', 'remove-item', 'ri', 'del', 'erase', 'rd', 'rmdir'].includes(name)) return undefined
  const flags = args.filter(arg => arg.startsWith('-'))
  const recursive = flags.some(arg => arg === '--recursive' || RECURSE.test(arg) || (!FORCE_PARAMETER.test(arg) && /[rR]/.test(shortFlags(arg))))
  const force = flags.some(arg => arg === '--force' || FORCE_PARAMETER.test(arg) || shortFlags(arg).includes('f'))
  return recursive && force ? args.filter(arg => !arg.startsWith('-')) : undefined
}

const DELETE_REASON = 'Do not force-delete the filesystem root, the home folder, the main checkout, the seats folder, this seat\'s folder '
  + 'or its worktree, or a folder that holds one: name the folders inside them to delete.'
const OTHER_SEAT_REASON = 'Do not force-delete another seat\'s folder or anything in it: its work is not this seat\'s to discard.'
const CHECKOUT_REASON = dir => `Do not force-delete ${dir}: it is a git checkout, and only one this seat made in its folder or a temp folder may go.`
// The variable a word starts with: $X, ${X}, $env:X or %X%.
const LEADING_VARIABLE = /^(?:\$env:([A-Za-z_]\w*)|\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*|\d)|%([A-Za-z_]\w*)%)/
const UNSET_REASON = name => `Do not force-delete a path that starts with $${name}: nothing sets it, so the delete would start at the filesystem root.`
const THROUGH_REASON = (name, dir, reason) => `Nothing sets $${name}, so this delete reaches ${dir}. ${reason}`

// Why a forced recursive delete of `dir` is refused: it is, or holds, the filesystem root or a folder ctx.protected keeps;
// it is in another seat's folder; or it is a git checkout outside this seat's folder and the temp folders (but one that
// holds a folder ctx.protected keeps).
const deleteRefusal = (dir, ctx) => {
  const { path, seats } = ctx
  if (dir === null) return undefined
  if ([path.parse(dir).root, ...ctx.protected].some(root => within(root, dir, path))) return DELETE_REASON
  const [inner, outer] = [dir, seats].map(each => each === undefined ? null : real(each, path))
  const seat = inner !== null && outer !== null && within(inner, outer, path) ? path.relative(outer, inner).split(path.sep)[0] : ''
  if (isSeatId(seat) && !within(dir, ctx.seat, path)) return OTHER_SEAT_REASON
  if (path !== nodePath || !existsSync(path.join(dir, '.git'))) return undefined
  const scratch = ctx.temp.filter(temp => !ctx.protected.some(kept => within(kept, temp, path)))
  return [ctx.seat, ...scratch].some(root => within(dir, root, path)) ? undefined : CHECKOUT_REASON(dir)
}

const ownerRefusal = (words, at, lookup, isSet, ctx) => {
  const [first = '', ...args] = strip(words)
  const name = programName(first)
  const { path } = ctx
  if (SHELLS.includes(name)) {
    const script = shellScript(args)
    return script === undefined ? undefined : walk(script, at, ctx, ctx.visit)
  }
  if (name === 'git') {
    const { folder, sub, rest } = gitCommand(args, at, lookup, path)
    if (sub === 'reset' && rest.includes('--hard')) return 'Use a reversible Git operation instead of git reset --hard.'
    if (sub === 'worktree' && ['remove', 'move'].includes(rest[0] ?? '')) {
      return 'Leave every worktree where it is and, when a branch you need is checked out in another, work from a new branch or a detached HEAD.'
    }
    if (discards(sub, rest) && ctx.seat !== undefined && folder !== null && !within(folder, ctx.seat, path)) {
      return `Run git ${sub} only inside this seat's folder, ${ctx.seat}: this line runs it in ${folder}.`
    }
    if (sub === 'branch') {
      const flags = rest.map(shortFlags).join('')
      const forced = flags.includes('D') || ((flags.includes('d') || rest.includes('--delete')) && (flags.includes('f') || rest.includes('--force')))
      const other = forced ? rest.filter(arg => !arg.startsWith('-')).map(branchOf).find(name => !ctx.mine(name)) : undefined
      if (other !== undefined) return DELETE_BRANCH_REASON(other)
    }
    return sub === 'push' ? pushRefusal(rest, ctx) : undefined
  }
  if (name === 'gh') {
    const plain = args.filter(arg => !arg.startsWith('-'))
    if (plain[0] === 'pr' && plain[1] === 'merge' && args.includes('--admin')) return 'Do not bypass merge protections.'
    if (plain[0] === 'repo' && plain[1] === 'delete') return 'Do not delete repositories.'
    return undefined
  }
  for (const target of forcedTargets(name, args) ?? []) {
    const variable = LEADING_VARIABLE.exec(target)?.slice(1).find(Boolean)
    if (variable !== undefined && !isSet(variable)) return UNSET_REASON(variable)
    const { text, unset, unknown, aborts } = expansion(target, lookup, isSet)
    // A value the line set but the guard cannot read is a folder it cannot place, and runs.
    if (unknown || aborts || !text) continue
    const glob = text.search(/[*?[]/)
    const dir = place(at, glob === -1 ? text : text.slice(0, glob).replace(/[^\\/]*$/, '') || '.', path)
    const reason = deleteRefusal(dir, ctx)
    if (reason) return unset.length ? THROUGH_REASON(unset[0], dir, reason) : reason
  }
  return undefined
}

/** @typedef {{ cwd?: string, branch?: () => string, checkedOut?: () => string[], path?: typeof nodePath, own?: string, env?: Record<string, string | undefined>, bash?: boolean, main?: string[] }} GuardOptions */

// What every check of a line reads: the folders a forced recursive delete keeps, the seat's folder and worktree, the
// branches a force push keeps, and the branches this seat may delete.
/** @param {GuardOptions} options */
const ownerContext = ({ branch = () => '', checkedOut = () => [], path = nodePath, own, env = {}, bash = false, main = [] }) => {
  const suffix = own === undefined ? undefined : /^seat[.-]([^.]+)$/.exec(path.basename(own))?.[1]
  const seatBranch = suffix === undefined ? undefined : `seat/seat-${suffix}`
  const seat = own === undefined ? undefined : path.resolve(own)
  const homes = [env.HOME, env.USERPROFILE, ...(path === nodePath ? [homedir()] : [])].filter(Boolean).map(home => path.resolve(home))
  const seats = seat === undefined ? undefined : path.dirname(seat)
  return {
    path, env, main, seat, seats,
    windows: path.sep === '\\' && !bash,
    tree: seat === undefined ? undefined : path.join(seat, 'wt'),
    protected: [...homes, ...main, ...(seat === undefined ? [] : [seats, seat, path.join(seat, 'wt')])],
    temp: [env.TMPDIR, env.TEMP, env.TMP, ...(path === nodePath ? [tmpdir()] : []), ...(path.sep === '/' ? ['/tmp'] : [])]
      .filter(Boolean).map(dir => path.resolve(dir)),
    branch,
    kept: name => DEFAULT_BRANCHES.includes(name) || (name.startsWith('seat/') && name !== seatBranch),
    mine: name => !DEFAULT_BRANCHES.includes(name) && (name === seatBranch || name === branch() || checkedOut().includes(name)),
  }
}

/**
 * Why an owner seat's command line is refused, or undefined when it may run. `branch()` gives the branch checked out
 * where it runs, `checkedOut()` the branches its worktree checked out before; `own` is the seat's folder, unknown for a Claude subagent owner, whose hook input carries the parent
 * session's folder; `main` the main checkouts; `env` the hook's environment, whose variables a folder or target expands
 * with; `bash` says the line runs in Claude Code's Bash tool, a POSIX shell on every host; `path` is node:path, or
 * path.win32 to decide as Windows does.
 * @param {string} line
 * @param {GuardOptions} [options]
 */
export const guard = (line, options = {}) => {
  const ctx = ownerContext(options)
  ctx.visit = (words, at, lookup, _to, isSet) => ownerRefusal(words, at, lookup, isSet, ctx)
  return walk(line, ctx.path.resolve(options.cwd ?? process.cwd()), ctx, ctx.visit)
}

// git subcommands a reviewer must not run in the main checkout or in its own worktree.
const REVIEWER_REFUSED = ['commit', 'push', 'pull', 'merge', 'rebase', 'cherry-pick', 'revert', 'am', 'update-ref']
const REVIEWER_REASON = 'A reviewer seat does not commit, push, merge or rebase in its worktree: check out what you review '
  + '(git fetch, then git checkout <sha>) and report. A scratch repository of its own, as one it makes with git init, is its own.'
const PR_REASON = 'A reviewer seat does not open or merge a pull request: report instead.'
// git subcommands that change no file, ref or setting of the checkout they run in.
const GIT_READS = ['', 'log', 'show', 'diff', 'status', 'rev-parse', 'cat-file', 'ls-files', 'ls-tree', 'ls-remote', 'grep', 'fetch', 'blame',
  'describe', 'shortlog', 'rev-list', 'show-ref', 'for-each-ref', 'merge-base', 'name-rev', 'diff-tree', 'show-branch', 'range-diff', 'help', 'version']
const WRITERS = ['rm', 'rmdir', 'mv', 'touch', 'mkdir', 'tee', 'chmod', 'chown', 'truncate', 'remove-item', 'ri', 'del', 'erase', 'rd',
  'move-item', 'mi', 'move', 'new-item', 'ni', 'set-content', 'sc', 'add-content', 'ac', 'out-file', 'clear-content']
// Programs that write only their last argument.
const COPIERS = ['cp', 'ln', 'install', 'rsync', 'copy-item', 'cpi', 'copy']
const MAIN_REASON = main => `Leave the main checkout (${main.join(', ')}) as it is: run git, folder changes and writes only in your own worktree.`

/** The files an apply_patch envelope adds, updates, deletes or moves to: codex's file-edit tool, or its CLI form run in a shell. */
export const patchFiles = text => [...text.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$/gm)].map(match => match[1])

const mainFence = (main, own, path) => dir => dir !== null && dir !== undefined && main.some(root => within(dir, root, path))
  && !(own !== undefined && within(dir, own, path))

// Whether `dir` is in the seat's worktree repository: inside the worktree, on disk, with no repository of its own between.
const ownRepository = (dir, tree, path) => {
  if (dir === null || tree === undefined || !existsSync(dir) || !within(dir, tree, path)) return false
  const top = folded(real(tree, path) ?? tree, path)
  for (let at = real(dir, path) ?? dir; folded(at, path) !== top && path.dirname(at) !== at; at = path.dirname(at)) {
    if (existsSync(path.join(at, '.git'))) return false
  }
  return true
}

const reviewerRefusal = (words, at, lookup, to, ctx) => {
  const { path, inMain, main } = ctx
  const lands = target => inMain(place(at, expand(target, lookup), path))
  if (to !== undefined) return inMain(to) ? MAIN_REASON(main) : undefined
  if (redirectTargets(words).some(lands)) return MAIN_REASON(main)
  const [first = '', ...args] = strip(words)
  const name = programName(first)
  if (name === 'git') {
    const { folder, gitDir, sub, rest } = gitCommand(args, at, lookup, path)
    if ((inMain(folder) || inMain(gitDir)) && !GIT_READS.includes(sub)) return MAIN_REASON(main)
    const dryRun = rest.includes('--dry-run') || rest.some(arg => shortFlags(arg).includes('n'))
    return REVIEWER_REFUSED.includes(sub) && ownRepository(folder, ctx.tree, path) && !(sub === 'push' && dryRun) ? REVIEWER_REASON : undefined
  }
  if (name === 'gh') {
    const plain = args.filter(arg => !arg.startsWith('-'))
    return plain.some((word, at) => word === 'pr' && ['create', 'new', 'merge'].includes(plain[at + 1] ?? '')) ? PR_REASON : undefined
  }
  const targets = args.filter(arg => !arg.startsWith('-'))
  const inPlace = name === 'sed' && args.some(arg => /^-[a-z]*i/.test(arg) || arg.startsWith('--in-place'))
  // sed's first plain word is its script unless -e or -f gives one.
  const scripted = args.some(arg => /^-[a-z]*[ef]/.test(arg) || ['--expression', '--file'].some(option => arg.startsWith(option)))
  if (WRITERS.includes(name) || inPlace) return (inPlace && !scripted ? targets.slice(1) : targets).some(lands) ? MAIN_REASON(main) : undefined
  return COPIERS.includes(name) && targets.length > 1 && lands(targets.at(-1) ?? '') ? MAIN_REASON(main) : undefined
}

/**
 * Why a reviewer seat's command line is refused, or undefined when it may run: whatever guard() refuses an owner, then
 * anything aimed at a `main` checkout (a cd into it, a write, a git command but a read, a command run from it), a commit,
 * push (but --dry-run), merge or rebase in its own worktree, and gh pr create or merge. Options as guard()'s, `main` required.
 * @param {string} line
 * @param {GuardOptions} [options]
 */
export const reviewerGuard = (line, options = {}) => {
  const ctx = ownerContext(options)
  const cwd = ctx.path.resolve(options.cwd ?? process.cwd())
  const inMain = mainFence(ctx.main, ctx.seat, ctx.path)
  const reviewer = { ...ctx, inMain }
  ctx.visit = (words, at, lookup, to, isSet) => ownerRefusal(words, at, lookup, isSet, ctx) ?? reviewerRefusal(words, at, lookup, to, reviewer)
  if (inMain(cwd) || patchFiles(line).some(file => inMain(ctx.path.resolve(cwd, file)))) return MAIN_REASON(ctx.main)
  return walk(line, cwd, ctx, ctx.visit)
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

if (invoked()) {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
  const agy = input.toolCall !== undefined
  const command = agy ? input.toolCall.args?.CommandLine : input.tool_name === 'apply_patch' ? undefined : input.tool_input?.command
  const line = typeof command === 'string' ? command : undefined
  const cwd = input.toolCall?.args?.Cwd ?? input.workspacePaths?.[0] ?? input.cwd ?? process.cwd()
  const own = values('--own')[0]
  const reviewer = process.argv.includes('--reviewer')
  const git = (...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).stdout?.trim() ?? ''
  // An owner's main checkout holds the repository its worktree shares.
  const common = line !== undefined && /\b(?:rm|rd|rmdir|del|erase|remove-item|ri)\b/i.test(line) ? git('rev-parse', '--path-format=absolute', '--git-common-dir') : ''
  const options = {
    cwd, own, env: process.env,
    branch: () => git('branch', '--show-current'),
    checkedOut: () => [...git('log', '-g', '--format=%gs', 'HEAD').matchAll(/^checkout: moving from \S+ to (\S+)$/gm)].map(match => match[1]),
    // codex names its shell tool Bash too, though on Windows it runs PowerShell; only Claude's hook passes --claude.
    bash: process.argv.includes('--claude') && input.tool_name === 'Bash',
    main: reviewer ? values('--main') : /[\\/]\.git$/.test(common) ? [nodePath.dirname(common)] : [],
  }
  const reason = line === undefined ? (reviewer ? writtenFiles(input).map(file => reviewerFileGuard(file, cwd, nodePath, own, options.main)).find(Boolean) : undefined)
    : reviewer ? reviewerGuard(line, options) : guard(line, options)
  const name = 'seat-router ' + (reviewer ? 'reviewer' : 'owner') + ' guard: '
  if (reason && agy) process.stdout.write(JSON.stringify({ decision: 'deny', reason: name + reason }) + '\n')
  else if (reason) {
    // codex shows the reason followed by ". Command: <line>".
    const hookSpecificOutput = { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: name + reason.replace(/\.$/, '') }
    process.stdout.write(JSON.stringify({ hookSpecificOutput }) + '\n')
  }
}
