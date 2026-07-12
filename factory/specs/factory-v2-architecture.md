# Factory v2 — reliability architecture

Status: Phase 1 (O3/O4/O5/O8/O9) SHIPPED 2026-07-09 and proven on a pilot project.
Phase 2 (O2 MCP reporting server) BUILT 2026-07-09 — sessions get
`report_status` / `open_question` / `log_progress` via a per-session
`--mcp-config` stdio server inside the driver; the driver files needs-human
issues (Decision 1) and treats the last settled MCP report as the session
result, with `last-session.json` as the fallback chain. Phase 3 (O6) BUILT
2026-07-09 (NOTES item 46, accelerated by owner decision): one gated
runtime checkout per machine at `~/.factory/runtime/`, advanced only by
`deploy-runtime.mjs` (syntax gate + read-only fleet doctor gate, ff-only);
schedulers, watchdog, and dashboard all exec it; per-project driver+prompt
copies and the sha256 drift stamps (item 22) are deleted. `init.mjs
--update` survives SLIMMED (deviation from "delete --update"): the guard
hook, skills, and allowlist must live in project repos for origin-built
worktrees, so a rare project-scaffold refresh command has to exist — it
doubles as the one-command v3→O6 migration (removes legacy copies,
regenerates schedulers). A systemd `OnFailure=` unit + `notify-fail.sh`
(plain sh + curl, creds in `~/.factory/telegram.env`) is the outer net for
a runtime too broken to notify — item 26's principle applied to the
runtime itself.

## Why this document

The Factory runs 7 projects (5 VPS, 2 local) and works, but we fix driver bugs
daily. Claude Code's native dynamic workflows
([docs](https://code.claude.com/docs/en/workflows)) orchestrate dozens–hundreds
of subagents reliably. The two don't compete — Factory is the
macro-orchestrator (scheduling, cross-day state, git/PR pipeline, fleet ops);
workflows are intra-session fan-out and need a live session. But the workflow
*runtime* is a working example of reliable agent orchestration, and this doc
asks: **which of its techniques, applied to the Factory, would remove the
failure classes we've actually hit?**

Evidence base: `factory/NOTES.md` (the numbered lessons ledger) and the
2026-07-07 v3 test runs. Every option below cites the NOTES items it would
have prevented.

## 1. The workflow runtime's reliability model

Its guarantees reduce to five principles:

- **P1 — Validated contracts, not trusted text.** Agent results pass through a
  JSON-schema-validated tool call; mismatch → retry at the tool layer. Nothing
  parses prose.
- **P2 — The runtime owns facts.** Workflow scripts cannot call `Date.now()`
  or touch the filesystem; time, state, and the record of what happened belong
  to the runtime, never the model.
- **P3 — Append-only journal + cached resume.** Every agent result is
  journaled; a stopped run resumes with completed work cached. Crashes lose
  nothing already done.
- **P4 — Mechanical invariants.** Concurrency caps, agent caps, worktree
  isolation are enforced by the runtime, not by asking agents to behave.
- **P5 — Bounded parallelism** where items are independent.

Factory v3 already embodies half of this: the driver-owned status ledger
(NOTES 24), the repo state machine (23), and the merge gate (13, 27) are P2/P4
applied to git. The ledger shows exactly where the principles are still
missing:

| Failure class | NOTES items | Missing principle |
|---|---|---|
| Session self-reports trusted or absent (last-session.json gaps, fake triage timestamps) | 1–2, 12, 30 | P1, P2 |
| Sessions violating prompt rules (commit to base, edit deployed tooling, duplicate needs-human) | 24, 28, 37 | P4 |
| Window finalization dies partway (EACCES at window end skipped board sync, notify, lock release) | 33, 34 | P3 |
| Killed sessions vanish from spend tracking (null-cost rows) | 29 (open) | P3 |
| Deploy drift of per-project driver copies | 4, 22, 37 | packaging, not runtime |
| Sequential fleet ops (watchdog runs 7 doctors one by one) | — | P5 |

## 2. Options

### O1 — Schema-enforced session output (`--json-schema`)

Spawn dev/triage/report sessions with `--output-format json --json-schema
'<schema>'`; the CLI returns a schema-validated `structured_output` field
([headless docs](https://code.claude.com/docs/en/headless#get-structured-output)).
The driver reads the landing report `{taskId, status, summary, pr?,
blockedReason?}` from it instead of trusting a hand-written file. Triage
returns plan *data*; **the driver writes `plan.json` and stamps `generatedAt`
itself** (kills the item-30 fake-timestamp class the same way workflows ban
`Date.now()` in scripts). Before booking any status the driver cross-checks
claims against observable facts — `review` requires the PR to exist
(`gh pr view`), `done` requires the merge.

- Fixes: P1/P2 contract gaps (1–2, 12, 30).
- Cost: small — spawn flags, a hand-rolled validator (zero-dependency ethos),
  prompt edits. Risk: low. Deps: none; doctor gains a min-CLI-version check.
- Limitation: end-of-session only. A killed or turn-capped session still
  reports nothing, so the incremental `last-session.json` write at PR-open
  (item 12) stays as fallback. Precedence: `structured_output` →
  `last-session.json` → repo-snapshot handoff.

### O2 — Driver-provided MCP reporting server (the stronger form of O1)

The driver exposes a small stdio MCP server to each session via
`--mcp-config` ([CLI reference](https://code.claude.com/docs/en/cli-reference))
with tools like:

- `report_status` — validated status transitions, journaled on arrival;
- `open_question` — replaces session-filed needs-human issues; the driver
  dedupes mechanically and files/updates the GitHub issue itself (kills item
  28's triple-filed questions while keeping issue-based visibility — see
  Decision 1);
- `log_progress` — cheap breadcrumbs for the journal and dashboard.

Sessions report **during** the run, at the moment of truth, exactly how
workflow agents report through a forced StructuredOutput tool. A session
killed at minute 40 has already reported everything up to minute 40 — the
"session died silently, inject a repo snapshot and hope" recovery path shrinks
to rare cases.

- Fixes: everything O1 fixes, plus silent-death recovery and needs-human
  duplicates (28). This is P1+P2 done properly.
- Cost: medium — a small MCP server inside the driver (stdio, zero deps
  possible over the MCP JSON-RPC framing), prompt rewrite of the reporting
  sections, allowlist entry. Risk: low-medium (one new moving part; degrade to
  the O1 fallback chain if the server fails). Needs a smoke test: MCP stdio
  server wired through `claude -p --mcp-config` under the factory allowlist.

### O3 — Hook-enforced invariants (PreToolUse)

Ship a hook script (installed via project settings by init/`--update`) that
mechanically **denies**:

- `git push` / `git commit` targeting the base branch from a session;
- Edit/Write under `.factory/driver.mjs`, `.factory/prompts/`,
  `.factory/schedulers/` (deployed tooling is read-only — item 37);
- git operations touching `.factory/backlog/` (task branches are code-only —
  item 24).

Every one of those NOTES items exists because a session ignored or never saw a
prompt sentence. Hooks convert prompt discipline into deterministic denial at
the tool layer — P4, the runtime owns invariants. Hooks load in `claude -p`
(only `--bare` skips them, per the
[headless docs](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode));
still smoke-test the deny path in a real factory session before rollout.

- Fixes: the P4 class (24, 28-adjacent, 37).
- Cost: small — one hook script + settings wiring. Risk: low; the deny message
  tells the session to route through needs-human, which prompts already
  instruct. Deps: none.

### O4 — Window journal + resumable finalization

Append-only per-window journal, `.factory/log/journal-<window-ts>.jsonl`
(Decision 3): one line per driver step — window
start, session spawn/result, gate action, status flip, sweep item, board sync,
notify, lock release — each `{step, key, status, detail, ts}`. Window-end
finalization becomes a checklist of **idempotent steps replayed from the
journal**: when the process dies mid-finalization (the item-33 crash: one
EACCES after all merges landed skipped board sync, notify, and lock release),
the next `dev` or `prep` run detects the incomplete window and completes the
remaining steps instead of silently dropping them.

Side benefits: the report session gets pre-collected facts instead of
re-deriving the day (cheaper, honest reports — same spirit as item 14), and
post-mortems read one file instead of grepping logs.

- Fixes: the P3 finalization class (33; hardens the terrain around 34).
- Cost: medium. Risk: low. Deps: none.

### O5 — Real usage for killed sessions (`stream-json`)

Spawn sessions with `--output-format stream-json`; the driver tails the stream
to disk (replacing `dev-*.out`), sums per-message usage as events arrive, and
on kill/timeout writes accumulated tokens instead of a null-cost row. The
final result event still carries `total_cost_usd` for normal ends. This is
exactly the fix NOTES 29 pre-scoped ("stream-json and per-message summation").

- Fixes: item 29 (Open/watch). Cost: small-medium (stream parsing). Risk: low.
  Pairs naturally with O2/O4 — stream events can feed the journal.

### O6 — Machine-level gated runtime (packaging; orthogonal to all above)

Today each project runs a stamped **copy** of the driver, and three NOTES
items exist only to compensate: 4 (`--update`), 22 (sha256 drift stamps), 37
(a session edited its copy). Meanwhile watchdog, dashboard, and init already
run globally from this repo — the architecture is half-global now.

The alternative: one runtime checkout per machine (e.g. `~/.factory/runtime/`),
advanced only by a `deploy-runtime` step gated on syntax check + doctor — the
merge-gate principle applied to the runtime itself. Schedulers point there
with `--project`; per-project copies, `--update`, stamps, and drift detection
are deleted. Because doctor/watchdog/Telegram all live in the runtime, a
broken runtime must be noticed by machinery outside it: a dumb systemd
`OnFailure=` Telegram unit (item 26's principle).

- Fixes: the deploy-drift class (4, 22, 37-packaging). Changes **nothing**
  about window reliability — it changes how cheaply and safely every future
  fix lands (git pull + gate, vs `--update` + `prep` × 7).
- Cost: medium (migration across 7 factories). Risk: fleet-wide coupling on
  one version, mitigated by the deploy gate. Decision independent of O1–O5.

### O7 — Agent SDK rebuild (the big fork)

Rewrite the driver as a TypeScript
[Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) program:
native message objects, in-process interrupt, per-message usage, structured
outputs, permission callbacks. Roughly half the driver's defensive machinery
(`classifySessionEnd`, `.out` parsing, the firstLine stream bugs behind item
34, process-group timeout kills) exists to compensate for the opacity of the
`claude -p` subprocess boundary; an SDK driver deletes most of it.

- Cost: high — a rewrite plus a real npm dependency, ending the
  zero-dependency ethos. Risk: highest of any option.
- Assessment: O2 + O5 capture an estimated 70–80% of the benefit with zero
  dependencies. **Defer.** Revisit only if subprocess-boundary bugs keep
  recurring after O2/O5 land — with the journal (O4) as the evidence.

### O9 — Driver-managed worktrees for sessions and gate

Today sessions and the merge gate operate in the project's one checkout —
which the owner also uses interactively (idle live sessions sit in every
factory repo). The driver flips branches, quarantines WIP, and merges under
them; v3's state machine survives the collisions, but colliding at all is the
defect. Instead: the driver creates a worktree per task (`git worktree add`
from `origin/<base>`), runs the session with cwd there, and removes it after
the gate lands; gate merges happen in a short-lived worktree of base.

- Fixes: the human-co-use collision class at the root (no branch flips under
  idle sessions, no stashed WIP, no index.lock races) and gives sessions a
  clean-by-construction start — the workflow runtime's own per-agent
  isolation, P4 as a mechanical guarantee instead of quarantine machinery.
  Item 23's state machine remains as the safety net, not the routine.
- Consequence (accepted): worktrees are cut from origin, so origin is the
  single rendezvous point — owner work is invisible to the factory until
  pushed (`prep` already pushes). This replaces the driver hunting for
  local-only base commits.
- Cost: medium (session/gate cwd plumbing, worktree lifecycle + tolerant
  cleanup à la item 33's `rmScratch`). Risk: low-medium; worktrees share
  `.git` safely (per-worktree index). Disk cost trivial.

### O8 — Parallel fleet ops

`watchdog.mjs` runs all registered factories' doctors concurrently (cap ~4)
instead of sequentially — pure reads, no shared state; the fleet of 7
finishes in roughly one doctor's time.

Explicit non-goal: **dev sessions stay strictly sequential per project.** The
repo state machine (23) assumes one writer, and that invariant has earned its
keep. Parallelism belongs at fleet level and — optionally, as a separate
future feature — *inside* sessions via the Workflow tool for sweep-shaped
tasks (migrations, audits), which is deliberately out of scope here.

- Cost: trivial. Risk: none.

## 3. Recommended composition

**Phase 1 — mechanical guarantees, no new moving parts:**
O3 hooks + O4 journal/replay + O5 usage + O8 parallel watchdog + O9 worktree
isolation. Closes the "session disobeyed the prompt", "crash loses the
window's tail", and human-co-use collision classes permanently; all
driver/hook logic, deployable with today's `--update` flow.

**Phase 2 — the v2 contract:**
O2 MCP reporting server, with O1's `--json-schema` final report kept as
belt-and-suspenders and as the fallback chain. This is the heart of v2:
sessions become untrusted workers whose claims are validated tool calls made
mid-flight, and the driver cross-checks them against git/gh facts before
acting.

**Phase 3 — optional, independent:**
O6 machine-level gated runtime. Worth doing if the `--update` × 7 tax keeps
hurting; decide after Phases 1–2 prove out (or earlier if a drift incident
recurs).

**Deferred:**
- O7 SDK rebuild — evidence-gated, see above.
- Workflow tool inside sweep-shaped dev tasks — a separate efficiency feature,
  not part of this reliability pass.
- Agent teams — no fit; Factory's cross-day statelessness is the point.

## 4. Decisions (owner, 2026-07-08)

1. **`open_question` routing (O2): hybrid — the driver files the issue.**
   Sessions call `open_question`; the driver dedupes against open `[factory]`
   issues and its own journal, then files or comments on the GitHub issue
   itself. Today's issue-based visibility stays; sessions lose the
   file-an-issue responsibility (and with it, the item-28 duplicate class).
2. **Hook denial UX (O3): hard-deny with message.** The hook denies and tells
   the session why and what to do instead (route through `open_question`). No
   side effects from the guard itself; repeated denials are visible in the
   journal, not auto-escalated.
3. **Journal retention (O4): per-window files.** `journal-<window-ts>.jsonl`,
   pruned like existing logs. Crash replay reads the latest file; post-mortems
   are self-contained per window.
4. **Phase 3 timing (O6): decide after Phase 2.** Phases 1–2 ship with
   today's `--update` flow; revisit O6 once the contract work proves out or a
   drift incident recurs.

## 5. Concurrency, shared state, and file ownership

### Cross-repo concurrency

Factories already run concurrently across projects (verified 5-way in the
2026-07-07 test): each project's scheduler starts its own driver process, and
the lock file is per project — it only prevents two drivers fighting over the
same checkout. The "strictly sequential" rule applies to sessions *within*
one project (one writer per working tree). Nothing in v2 changes this, and O6
doesn't either: the global runtime shares **code**, never state — schedulers
still launch one driver process per project.

### The MCP server is per-session, not a daemon

A stdio MCP server is not a port or a shared endpoint. Each `claude -p`
session launches its own server instance as a child process and talks to it
over stdin/stdout; the driver configures it (via the session's `--mcp-config`)
to write into **that project's** journal. Ten concurrent sessions = ten
independent short-lived server processes. There is no shared "the MCP".

Complete list of what IS shared across factories on one machine: the runtime
code (read-only at run time under O6; only the gated `deploy-runtime` writes
it), `~/.factory/registry.json` (written only at registration), the Telegram
bot and dashboard (channels, no state), and machine/plan rate limits.

### File ownership — three classes, one writer each

Past bugs came from project-internal files being churned by branches, git
operations, and sessions (NOTES 24: backlog edits riding task branches; 37: a
session edited its deployed driver copy; the factory/state orphan branches
that hid inbox notes). v2 resolves this by classifying every file under
`.factory/` and giving each class exactly one writer, enforced mechanically:

| Class | Examples | In git? | Writer | Enforcement |
|---|---|---|---|---|
| Runtime code | `driver.mjs`, `prompts/`, `schedulers/` | today: tracked copies | humans via repo (+ gated deploy) | O3 hook denies session edits; O6 removes it from the project entirely |
| Durable metadata | `spec/`, `backlog/`, `config.json` | yes, on base branch only | the driver (folds flips into merge commits; commits triage output) | v3 item 24 + O3 hook denies session git ops on these paths |
| Runtime state | `log/` (journal, state.json, usage.jsonl, quarantine), `plan.json`, locks, `tmp/` | no — gitignored | the driver (and per-session MCP servers appending to the journal) | can't ride branches or be touched by checkouts by construction |

The key v2 upgrades over v3: sessions stop *needing* to write `.factory`
files at all (reporting goes through the MCP tool; `last-session.json`
survives only as a fallback), and the rules that were prompt discipline
become PreToolUse denials. Branch switches can't corrupt runtime state
(gitignored), can't carry metadata edits (sessions are denied), and — once
O6 lands — can't affect the code being executed (it's outside the repo).

### Human co-use of factory checkouts

The owner works interactively in factory checkouts. The system handles this
by distrusting its own records at every sync point rather than assuming an
untouched tree:

- **Tree level:** window start/between-sessions/window-end reconciliation
  (NOTES 23) quarantines uncommitted files (copied to
  `.factory/log/quarantine-<ts>/` + stashed, never destroyed) and realigns to
  base at origin tip. Consequence: **uncommitted WIP left in a checkout gets
  stashed by the next window** — by design. Commit to a branch, run `prep`
  (item 32, the human-side handshake), or do hands-on work in a separate
  worktree/clone.
- **Task/PR level:** triage reconciles statuses against GitHub facts daily
  (item 17: hand-merged PR → `done`); v2 fact-checking books no status
  transition without verifying it against `gh`.
- **Session level:** every session prompt carries a fresh `repoSnapshot()`
  (branch, status, recent commits, open PRs); a stale `plan.json` falls back
  to live-backlog self-selection.

Known gap (accepted until it bites): human work committed straight to base
that semantically completes a backlog task — no PR, no flip — is invisible to
all three layers; triage may re-queue the task and one session gets confused
before reporting it. Earned fix if recurring: a triage step reconciling
recent base commits against open tasks.

## 6. Pre-build smoke tests — ALL PASSED (pilot project, VPS, CLI 2.1.201, 2026-07-08)

Run from inside the pilot project checkout on the VPS; tree verified clean afterwards;
total probe cost ≈ $0.60.

- **`--json-schema` → PASS.** `claude -p --output-format json --json-schema`
  returned a schema-conforming `structured_output` object
  (`{"repo":"<name>","branch":"main"}`), `subtype: success`. Doctor should
  still version-gate the flag.
- **PreToolUse deny hook in `-p` → PASS.** A hook passed via `--settings`
  denied a Bash call; the session received and quoted the exact
  `permissionDecisionReason` string, then routed around it — precisely the
  hard-deny-with-message UX of Decision 2.
- **stdio MCP server via `--mcp-config` → PASS.** A ~40-line zero-dependency
  newline-delimited JSON-RPC server (initialize / tools/list / tools/call)
  served a `report_status` tool; the session called it with validated
  arguments (`{"taskId":"T-SMOKE","status":"review","summary":"mcp smoke
  test"}` logged server-side) and relayed the tool result. The O2 server can
  be built into the driver with no dependencies.
- **`stream-json` usage from a killed session → PASS, with a caveat.** A
  session SIGTERM-killed at 25s (exit 124, the driver-kill signature) left 15
  parseable events; per-message `usage` on assistant events summed cleanly
  (input incl. cache ≈123k tokens across 3 messages). Caveat: the message
  in flight at kill time reports only the tokens streamed so far, so the sum
  is a lower bound — still strictly better than item 29's null rows.
