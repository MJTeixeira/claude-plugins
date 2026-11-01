// Turns a command name and its arguments into what spawn can start without a
// shell on every platform. Windows starts an .exe by name, but npm's .cmd shims
// only through cmd.exe: a shim that wraps a Node script runs that script under
// this Node instead, and any other shim goes through cmd.exe with cross-spawn's
// quoting. Elsewhere the name is spawned as given.
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve, win32 } from 'node:path'

const META = /([()\][%!^"`<>&|;, *?])/g

export function resolveCommand(name, platform = process.platform, env = process.env, exists = existsSync) {
  if (platform !== 'win32') return { file: name, isShim: false }
  if (win32.extname(name)) return { file: name, isShim: /^\.(cmd|bat)$/i.test(win32.extname(name)) }
  const exts = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  for (const dir of (env.PATH || env.Path || '').split(';').filter(Boolean)) {
    for (const ext of exts) {
      const file = win32.join(dir, name + ext)
      if (exists(file)) return { file, isShim: /^\.(cmd|bat)$/i.test(ext) }
    }
  }
  return { file: name, isShim: false }
}

/** The environment with each relative PATH entry made absolute against `cwd`, so a process started elsewhere finds what this one would. */
export function absolutePath(env, cwd) {
  const out = { ...env }
  for (const key of Object.keys(out).filter(name => name.toUpperCase() === 'PATH')) {
    out[key] = out[key].split(delimiter).map(dir => dir && !isAbsolute(dir) ? resolve(cwd, dir) : dir).join(delimiter)
  }
  return out
}

/** Where `name` is on the environment's PATH, as an absolute file, or undefined when no entry has it. */
export function locate(name, env) {
  const path = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
  const exts = process.platform === 'win32' ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : ['']
  for (const dir of path.split(delimiter).filter(dir => isAbsolute(dir))) {
    for (const ext of exts) {
      const file = join(dir, name + ext)
      try {
        if (!statSync(file).isFile()) continue
        if (process.platform !== 'win32') accessSync(file, constants.X_OK)
        return file
      } catch {}
    }
  }
  return undefined
}

// The Node script an npm cmd-shim runs, relative to the shim: `"%dp0%\node_modules\pkg\bin\cli.js" %*`.
export function shimScript(text) {
  return /"%~?dp0%?\\([^"]+\.[cm]?js)"/i.exec(text)?.[1]
}

export function escapeArgument(arg) {
  const quoted = String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')
  return ('"' + quoted + '"').replace(META, '^$1')
}

export function command(name, args, env = process.env) {
  const { file, isShim } = resolveCommand(name, process.platform, env)
  if (!isShim) return { file, args, options: {} }
  const relative = shimScript(readFileSync(file, 'utf8'))
  const script = relative && win32.join(win32.dirname(file), relative)
  if (script && existsSync(script)) return { file: process.execPath, args: [script, ...args], options: {} }
  if (args.some(arg => /[\r\n]/.test(arg))) throw new Error(`${name}: an argument with a line break cannot pass through ${file}`)
  const line = [file.replace(META, '^$1'), ...args.map(escapeArgument)].join(' ')
  return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', '"' + line + '"'], options: { windowsVerbatimArguments: true } }
}
