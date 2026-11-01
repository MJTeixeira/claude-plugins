export const asObject = value => value !== null && typeof value === 'object' ? value : undefined

export const numberAt = value => typeof value === 'number' && Number.isFinite(value) ? value : undefined

export const textAt = value => typeof value === 'string' ? value : undefined

export const readJson = text => {
  try { return JSON.parse(text) } catch { return undefined }
}

export const defined = value => value !== undefined

/** Seconds since the epoch, or an ISO date, as epoch milliseconds. */
export const resetTime = value => {
  if (typeof value === 'number' && Number.isFinite(value)) return value * 1000
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

export const oneLine = value => value.replace(/\s+/g, ' ').trim().slice(0, 120)

export const fileName = path => path.split(/[\\/]/).filter(Boolean).pop() ?? path

// Node and the CLIs take `/` on Windows too, so paths the mod builds join with it.
export const join = (...parts) => parts.join('/')

export const slashed = path => path.replaceAll('\\', '/')

/**
 * The windows a usage script (codex-usage.mjs, claude-usage.mjs) prints: one naming no model is the `shared` scope's,
 * and one naming models is each model's scope, as `scopeOfModel` gives it.
 * A window needs a name and a percentage used, or the limit it reached with nothing to measure it.
 */
export const scriptUsage = (payload, shared, scopeOfModel) => {
  const data = asObject(payload)
  if (!Array.isArray(data?.windows)) return undefined
  const windows = data.windows.flatMap(value => {
    const window = asObject(value)
    const id = textAt(window?.name)
    const [used, reached] = [numberAt(window?.used), textAt(window?.reached)]
    if (id === undefined || (used === undefined && reached === undefined)) return []
    const models = Array.isArray(window?.models) ? window.models.filter(model => typeof model === 'string') : []
    const [minutes, resetAt] = [numberAt(window?.minutes), numberAt(window?.resetAt)]
    const scopes = models.length ? [...new Set(models.map(scopeOfModel))] : [shared]
    return scopes.map(scope => ({
      scope, id, ...(used === undefined ? {} : { used }), ...(minutes === undefined ? {} : { minutes }),
      ...(resetAt === undefined ? {} : { resetAt }), ...(reached === undefined ? {} : { reached }),
    }))
  })
  return { ...(typeof data.allowed === 'boolean' ? { allowed: data.allowed } : {}), windows }
}

/** A run's own quota error names no window, so every scope its candidate draws on counts out. */
export const candidateScopes = async (_view, _dir, scopes) => ({ scopes })

/** codex's windows carry no name of their own, so they are named by their length. */
export const durationName = minutes => minutes % 1440 === 0 ? minutes / 1440 + 'd' : minutes % 60 === 0 ? minutes / 60 + 'h' : minutes + 'm'

export const familyOfModel = model => {
  if (model.startsWith('claude')) return 'claude'
  if (model.startsWith('gpt')) return 'gpt'
  if (model.startsWith('gemini')) return 'gemini'
  return 'other'
}

// agy's Windows shell is Windows PowerShell 5.1 whatever else is installed, and a codex reviewer
// without the WindowsApps PATH entries lands there too where PowerShell 7 came from the Store.
// Neither CLI lets the mod pick the shell.
export const POWERSHELL_51_NOTE = 'Your shell may be Windows PowerShell 5.1, where text piped into a program loses every non-ASCII '
  + 'character and && does not separate commands (use ; and check $LASTEXITCODE). Write files with your file tools, or with '
  + 'python using encoding=\'utf-8\', never by piping text through the shell.\n'

// Python on Windows reads and writes files in the ANSI code page (cp1252) unless told
// otherwise, so a seat's python script turns UTF-8 text into mojibake (PEP 686).
export const PYTHON_UTF8 = { PYTHONUTF8: '1' }

// Writes never repeat: a seat that writes between runs is making progress. agy names a write by
// its path alone and codex's file changes carry no content, so neither says what it wrote.
const WRITES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'write_file', 'write_to_file', 'create_file', 'edit_file',
  'replace_file_content', 'multi_replace_file_content', 'apply_patch', 'delete_file', 'move_file'])

export const call = (tool, input, result, name, id) =>
  ({ name, key: WRITES.has(tool) ? '#' + id : JSON.stringify([tool, input, result]) })

const LOOP_CALLS = 24
const LOOP_REPEATS = 3

export const findLoop = calls => {
  if (calls.length < LOOP_CALLS) return undefined
  for (let size = 1; size * LOOP_REPEATS <= LOOP_CALLS; size += 1) {
    let run = size
    while (run < calls.length && calls[calls.length - 1 - run]?.key === calls[calls.length - 1 - run + size]?.key) run += 1
    if (run >= LOOP_CALLS) return { cycle: calls.slice(-size).map(found => found.name), repeats: Math.floor(run / size) }
  }
  return undefined
}

// A loop of LOOP_CALLS calls takes about four transcript lines a call on agy, fewer on codex and Claude.
export const loopSignal = (transcript, toolCalls) => async (view, dir) =>
  findLoop(toolCalls(await view.tail(join(dir, transcript), 400)))

export const lastActionWith = actionOf => text => {
  let action
  for (const line of text.split('\n')) {
    const event = asObject(readJson(line))
    const found = event && actionOf(event)
    if (found?.trim()) action = oneLine(found)
  }
  return action
}
