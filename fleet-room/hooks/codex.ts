import type { EngineInterface } from 'claude-code'

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ROLLOUT = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
const PEEKED = 30
const LISTED = 10
const SNIPPET = 160
export const LIST_TAIL = 40
export const CHECK_TAIL = 200

export const isWindowsPath = (path: string): boolean => /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
export const joined = (isWindows: boolean, ...parts: string[]): string => parts.map((part, at) => at === 0 ? part.replace(/[\\/]+$/, '') : part)
  .join(isWindows ? '\\' : '/')
const canonical = (path: string, isWindows: boolean): string => {
  const plain = path.replace(/^\\\\\?\\/, '').replaceAll('\\', '/').replace(/\/+$/, '')
  return isWindows ? plain.toLowerCase() : plain
}
/** True when `folder` is `root` or inside it. */
export const isWithin = (folder: string, root: string, isWindows: boolean): boolean => {
  const a = canonical(folder, isWindows)
  const b = canonical(root, isWindows)
  return a === b || a.startsWith(b + '/')
}

export type Chat = { id: string, title: string, cwd: string | undefined, active: number, lastUser: string | undefined, rollout: string, isExec: boolean }
type Rollout = { id: string, path: string, mtimeMs: number }
type Peek = { head: string | undefined, tail: readonly string[] }

export async function codexHome($: EngineInterface): Promise<string | undefined> {
  const configured = await $.env.get('CODEX_HOME')
  if (configured) return configured
  const home = await $.env.get('HOME') || await $.env.get('USERPROFILE')
  return home ? joined(isWindowsPath(home), home, '.codex') : undefined
}
export async function rollouts($: EngineInterface, home: string): Promise<Rollout[]> {
  const isWindows = isWindowsPath(home)
  const found: Rollout[] = []
  const walk = async (folder: string, depth: number): Promise<void> => {
    let entries: Awaited<ReturnType<EngineInterface['fs']['list']>>
    try { entries = await $.fs.list(folder) } catch { return /* A missing or unreadable folder holds no chats. */ }
    for (const entry of entries) {
      const path = joined(isWindows, folder, entry.name)
      if (entry.kind === 'dir' && depth < 3) await walk(path, depth + 1)
      const id = entry.kind === 'file' ? ROLLOUT.exec(entry.name)?.[1] : undefined
      if (id) found.push({id: id.toLowerCase(), path, mtimeMs: entry.mtimeMs})
    }
  }
  await walk(joined(isWindows, home, 'sessions'), 0)
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs)
}
async function titles($: EngineInterface, home: string): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  let text = ''
  try { text = await $.fs.read(joined(isWindowsPath(home), home, 'session_index.jsonl')) } catch { return names /* No index: chats show untitled. */ }
  for (const line of text.split(/\r?\n/)) {
    const entry = jsonOf(line)
    if (typeof entry?.id === 'string' && typeof entry.thread_name === 'string') names.set(entry.id.toLowerCase(), entry.thread_name)
  }
  return names
}
const jsonOf = (line: string): Record<string, any> | undefined => {
  if (!line.startsWith('{')) return undefined
  try { return JSON.parse(line) } catch { return undefined /* A cut or partial line is skipped. */ }
}
/** The first line and the last `lines` lines of each file, read by a host command so a rollout of any size can be read. */
export async function peek($: EngineInterface, files: readonly string[], lines: number, isWindows: boolean): Promise<Map<string, Peek>> {
  const peeks = new Map<string, Peek>()
  if (!files.length) return peeks
  if (isWindows) {
    const script = "foreach ($p in ($env:FLEET_ROOM_FILES -split \"`n\")) { '@@fleet-room-head ' + $p; Get-Content -LiteralPath $p -TotalCount 1 -Encoding UTF8 -ErrorAction SilentlyContinue; '@@fleet-room-tail'; Get-Content -LiteralPath $p -Tail ([int]$env:FLEET_ROOM_LINES) -Encoding UTF8 -ErrorAction SilentlyContinue }"
    const run = await $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
      {env: {FLEET_ROOM_FILES: files.join('\n'), FLEET_ROOM_LINES: String(lines)}, timeoutMs: 60_000})
    let current: {path: string, head: string[], tail: string[], inTail: boolean} | undefined
    const flush = (): void => { if (current) peeks.set(current.path, {head: current.head[0], tail: current.tail}) }
    for (const line of run.stdout.split(/\r?\n/)) {
      if (line.startsWith('@@fleet-room-head ')) { flush(); current = {path: line.slice(18), head: [], tail: [], inTail: false} }
      else if (line === '@@fleet-room-tail' && current) current.inTail = true
      else if (current && line) (current.inTail ? current.tail : current.head).push(line)
    }
    flush()
    return peeks
  }
  for (const file of files) {
    const head = await $.process.run(['head', '-n', '1', file])
    const tail = await $.process.run(['tail', '-n', String(lines), file])
    peeks.set(file, {head: head.exitCode === 0 ? head.stdout.split('\n')[0] : undefined, tail: tail.exitCode === 0 ? tail.stdout.split('\n') : []})
  }
  return peeks
}
const userText = (entry: Record<string, any> | undefined): string | undefined => {
  const payload = entry?.payload
  if (entry?.type !== 'response_item' || payload?.type !== 'message' || payload.role !== 'user' || !Array.isArray(payload.content)) return undefined
  const text = payload.content.map((part: any) => typeof part?.text === 'string' ? part.text : '').join('').trim()
  // Codex adds its own context blocks as user messages; they open with a tag.
  return text && !text.startsWith('<') ? text : undefined
}
export const lastUser = (tail: readonly string[]): string | undefined => {
  for (let at = tail.length - 1; at >= 0; at--) {
    const text = userText(jsonOf(tail[at]!))
    if (text) return text
  }
  return undefined
}
/** True when a user message in the lines carries the marker: Codex took the queued message into its conversation. */
export const isPickedUp = (tail: readonly string[], marker: string): boolean => tail.some(line => line.includes(marker) && userText(jsonOf(line))?.includes(marker))
export async function listChats($: EngineInterface, home: string, isWindows: boolean): Promise<Chat[]> {
  const found = (await rollouts($, home)).slice(0, PEEKED)
  const names = await titles($, home)
  const peeks = await peek($, found.map(item => item.path), LIST_TAIL, isWindows)
  return found.map(item => {
    const seen = peeks.get(item.path)
    const meta = jsonOf(seen?.head ?? '')?.payload
    return {id: item.id, rollout: item.path, title: names.get(item.id) ?? '(untitled)', active: item.mtimeMs,
      cwd: typeof meta?.cwd === 'string' ? meta.cwd : undefined, lastUser: lastUser(seen?.tail ?? []),
      isExec: meta?.source === 'exec' || meta?.originator === 'codex_exec'}
  })
}
const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}
export const chatList = (chats: readonly Chat[], root: string, isWindows: boolean, isAll: boolean): string => {
  const shown = (isAll ? chats : chats.filter(chat => !chat.isExec && chat.cwd !== undefined && isWithin(chat.cwd, root, isWindows))).slice(0, LISTED)
  if (!shown.length) return isAll ? 'No Codex chats found on this machine.'
    : 'No Codex app chat works in ' + root + '. Call again with all: true to list chats in other folders.'
  return [isAll ? 'Codex chats on this machine, newest first:' : 'Codex chats working in ' + root + ', newest first:',
    ...shown.map(chat => '- ' + chat.id + ' · "' + clip(chat.title, 80) + '" · ' + (chat.cwd ?? 'folder unknown')
      + ' · last active ' + new Date(chat.active).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
      + (chat.isExec ? ' · a codex exec run, which no app wakes' : '')
      + '\n  last user message: ' + (chat.lastUser ? '"' + clip(chat.lastUser, SNIPPET) + '"' : 'none in its recent log')),
    'Propose one to the owner and pair only after the owner confirms it; never pick one yourself.'].join('\n')
}

export type CodexCommand = { argv: readonly string[] } | { refused: string }
/**
 * The argv prefix that runs `codex` with no shell. On Windows an npm install puts a `.cmd`/`.ps1` shim on PATH, which
 * only a shell can run, and a shell would parse the message; the shim's own package script runs under node instead.
 */
export async function codexCommand($: EngineInterface, isWindows: boolean): Promise<CodexCommand> {
  if (!isWindows) return {argv: ['codex']}
  const path = await $.env.get('PATH') || await $.env.get('Path') || ''
  const exts = (await $.env.get('PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').map(ext => ext.trim().toLowerCase()).filter(Boolean)
  const dirs = path.split(';').map(dir => dir.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)
  const find = async (name: string, kinds: readonly string[]): Promise<string | undefined> => {
    for (const dir of dirs) for (const ext of kinds) {
      const file = joined(true, dir, name + ext)
      if (await $.fs.exists(file).catch(() => false)) return file
    }
    return undefined
  }
  const found = await find('codex', [...exts, '.ps1'])
  if (!found) return {refused: 'codex is not on PATH; install the Codex CLI or open a session where it is.'}
  if (/\.(exe|com)$/i.test(found)) return {argv: [found]}
  const dir = found.slice(0, found.lastIndexOf('\\'))
  const script = joined(true, dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  if (!await $.fs.exists(script).catch(() => false)) return {refused: found + ' is a script shim fleet-room cannot run without a shell, and its package script ' + script + ' is missing.'}
  const local = joined(true, dir, 'node.exe')
  const node = await $.fs.exists(local).catch(() => false) ? local : await find('node', ['.exe'])
  return node ? {argv: [node, script]} : {refused: found + ' needs node, and node.exe is not on PATH.'}
}

const psQuoted = (text: string): string => "'" + text.replaceAll("'", "''") + "'"
const shQuoted = (text: string): string => "'" + text.replaceAll("'", "'\\''") + "'"
/** The command Codex runs to write one message into the inbox: plain cmdlets on Windows, which Constrained Language Mode allows. */
export const replyCommand = (inbox: string, isWindows: boolean): string => isWindows
  ? 'Set-Content -Encoding utf8 -Path (' + psQuoted(inbox + '\\') + " + (Get-Date -Format yyyyMMddTHHmmssfff) + '.md') -Value @'\n<your message>\n'@"
  : 'cat > ' + shQuoted(inbox + '/') + '"$(date +%Y%m%dT%H%M%S)-$$.md" <<\'FLEET_ROOM_END\'\n<your message>\nFLEET_ROOM_END'
export const footer = (root: string, inbox: string, isWindows: boolean, marker: string): string =>
  '\n\n---\nfleet-room ' + marker + ' · from the Claude Code session in ' + root + '. To message it, now or anytime later, run in your shell:\n'
  + replyCommand(inbox, isWindows)
export const introText = (root: string): string => 'Hello from Claude Code. I am a Claude Code session working in this same folder, '
  + root + '. The owner paired this Codex chat with me through fleet-room.\n'
  + 'You may message me anytime: questions, requests, or a note when you finish something. I may answer much later, after doing work, and I may message you here too.\n'
  + 'To message me, run the command at the end of this message with your text in place of <your message>; each run writes a new file, so send one message per run. Keep the first and last lines of the command as they are.\n'
  + 'No reply is needed in this chat itself: I see only what you send with that command.'
