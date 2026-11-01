import { agy } from './agy.mjs'
import { claude } from './claude.mjs'
import { codex } from './codex.mjs'

/**
 * @typedef {'codex'|'agy'|'claude'} VendorId
 * @typedef {'claude'|'gpt'|'gemini'|'other'} Family
 * @typedef {{ vendor: VendorId, model: string, effort: string, account?: string }} Candidate
 * @typedef {{ scope: string, id: string, minutes?: number, used?: number, resetAt?: number, reached?: string }} Window
 *   One window as the vendor's reading names it, of any length; `reached` is a limit hit with nothing left to measure.
 * @typedef {{ allowed?: boolean, windows: Window[] }} Usage
 * @typedef {import('../core/ledger.mjs').Window} LedgerWindow
 * @typedef {{ script: string } | { exec: string[] }} Run  a bin/ helper run with node, or a CLI run through seat-io's exec
 * @typedef {{ text: string, failed: boolean, quota: boolean, detail: string, refused?: string[] }} Check
 * @typedef {{ name: string, key: string }} Call
 * @typedef {{ cycle: string[], repeats: number }} Loop
 * @typedef {{ id: string, dir: string, workDir: string, tier: 'reviewer'|'owner', model: string, effort: string,
 *             account?: string, resumeConversation?: string }} PlanSeat
 * @typedef {{ seat: PlanSeat, brief: string, os: 'windows'|'posix', guard: string, seatRoot: string, configDir?: string }} PlanContext
 *   `guard` is the owner-guard command for this seat; `configDir` the Claude config folder of the seat's account.
 * @typedef {{ dirs: string[], files: Record<string, string>, env: Record<string, string>, spec: Record<string, unknown> }} Plan
 *   `files` are written in the seat's folder, `dirs` made first; `spec` is what run-seat.mjs starts.
 * @typedef {{ read: (path: string) => Promise<string>, list: (path: string) => Promise<{ name: string, kind: string }[]>,
 *             settings: (key: string) => Promise<unknown>, run: (argv: string[], init?: { cwd?: string }) => Promise<{ exitCode: number, stdout: string }>,
 *             home: string }} FactsIo
 * @typedef {{ read: (path: string) => Promise<string>, head: (path: string) => Promise<string>, tail: (path: string, lines: number) => Promise<string>,
 *             grep: (pattern: string, path: string) => Promise<string>, grepParts: (pattern: string, path: string) => Promise<string>,
 *             has: (pattern: string, path: string) => Promise<boolean>, find: (dir: string, glob: string) => Promise<string|undefined> }} AttemptView
 *   Read access to an attempt's files and the vendor files they point at; `grep` patterns are POSIX ERE, `grepParts` returns
 *   only the matches; `find` takes a folder that starts `{NAME:FALLBACK}` or `~`, read where the CLIs run.
 * @typedef {object} VendorAdapter
 * @property {VendorId} id
 * @property {boolean} explicitForm   whether `seat: <id> <model> <effort> <tier>` names it
 * @property {string} transcript      the attempt's event stream, in the seat's folder
 * @property {string} stepPattern     a finished tool call's line in the transcript (ERE)
 * @property {(c: Candidate) => Family} familyOf
 * @property {(c: Candidate) => import('../core/policy.mjs').Capability[]} capabilities
 * @property {(c: Candidate, key?: string) => string[]} scopesOf   every quota scope whose windows the candidate draws on,
 *   its account's first; `key` names a Claude account (ClaudeAdapter.accountKey)
 * @property {(key?: string) => string[]} bandScopes    the scopes the quota band and delegate mode read for the vendor
 * @property {string[]} version
 * @property {Record<string, string>} [execEnv]   set whenever the mod runs the CLI itself
 * @property {{ run: Run, parse: (stdout: string) => { model: string, efforts: string[], isDefault?: boolean }[]|undefined }} [models]
 * @property {{ run: Run, parse: (stdout: string, key?: string) => Usage|undefined }} usage   an active read, run by bin/refresh-quota.mjs
 * @property {(view: AttemptView, dir: string, scopes: string[]) => Promise<{ scope: string, windows: LedgerWindow[] }[]|undefined>} [passiveQuota]
 *   the readings a seat's own output carries about its candidate's `scopes`; undefined when it carries none
 * @property {(view: AttemptView, dir: string, scopes: string[]) => Promise<{ scopes: string[], until?: number }>} exhaustedScopes
 *   after a quota ending: the scopes it puts out, and until when if the vendor said
 * @property {{ script: string, file: string }} [probe]   asked on Windows at session start; its answer lands in the seat root's `file`
 * @property {{ budget: number, note: string, when: (checked: Check) => boolean, conversation: (view: AttemptView, dir: string) => Promise<string|undefined> }} [resume]
 *   a failure the CLI recovers from by resuming the conversation in a new process
 * @property {(io: FactsIo, ctx: PlanContext) => Promise<Record<string, unknown>>} [facts]
 * @property {(input: PlanContext & { facts: Record<string, unknown> }) => Plan} plan   pure
 * @property {(view: AttemptView, dir: string, exitCode: number|undefined) => Promise<Check>} judge
 * @property {(view: AttemptView, dir: string, memo: Record<string, unknown>) => Promise<{ tokens?: number, memo?: Record<string, unknown> }>} liveTokens
 * @property {(text: string) => Call[]} toolCalls
 * @property {(view: AttemptView, dir: string) => Promise<Loop|undefined>} loopSignal
 * @property {(text: string) => string|undefined} lastAction
 * @typedef {VendorAdapter & {
 *   account: { args: string[], env: (dir: string) => Record<string, string> },
 *   accountKey: (realPath: string) => string,
 *   sessionWindows: (rateLimits: ReadonlyArray<{ kind: string, percentUsed: number, resetsAt?: string }>) => LedgerWindow[],
 *   soloOn: (os: 'windows'|'posix') => string|undefined }} ClaudeAdapter
 *   `account` reads another account's usage on its own login; `soloOn` says why one session-account seat runs at a time there.
 */

/** @type {{ codex: VendorAdapter, agy: VendorAdapter, claude: ClaudeAdapter }} */
export const ADAPTERS = { codex, agy, claude }

export { durationName } from './shared.mjs'

export const EXPLICIT_VENDORS = Object.values(ADAPTERS).filter(adapter => adapter.explicitForm).map(adapter => adapter.id)

export const familyOf = candidate => ADAPTERS[candidate.vendor].familyOf(candidate)

/** @type {import('../core/policy.mjs').Facts} */
export const FACTS = {
  familyOf,
  capabilities: candidate => ADAPTERS[candidate.vendor].capabilities(candidate),
  modelOf: candidate => candidate.model,
}

/**
 * An active read as ledger readings, one per scope it names, each window under the vendor's own id. A limit reached
 * with nothing left to measure is a full window, and ordinary use refused is one for `account`, the scope read.
 * @param {Usage} usage @param {number} at @param {string} [account]
 * @returns {{ scope: string, at: number, windows: LedgerWindow[] }[]}
 */
export const readingsOf = (usage, at, account) => {
  /** @type {Map<string, LedgerWindow[]>} */
  const scopes = new Map()
  const add = (scope, window) => scopes.set(scope, [...scopes.get(scope) ?? [], window])
  for (const window of usage.windows) {
    add(window.scope, { id: window.id, usedPct: Math.min(100, Math.max(0, window.used ?? 100)),
      ...(window.minutes === undefined ? {} : { minutes: window.minutes }), ...(window.resetAt === undefined ? {} : { resetsAt: window.resetAt }) })
  }
  if (usage.allowed === false && account) add(account, { id: 'not allowed', usedPct: 100 })
  return [...scopes].map(([scope, windows]) => ({ scope, at, windows }))
}
