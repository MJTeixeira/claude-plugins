# Factory — autonomous spec-driven development

Claude Code develops a fully-specced product alone in daily windows: fresh
headless session per task, state carried in files, humans feed input async.
Portable: the same driver runs on macOS, Linux/VPS, and Windows.

## How it works

```
             ┌──────────── triage (1 session) ────────────┐
  GitHub issues / Notion / Jira / .factory/inbox  →  backlog updates + plan of day
             └────────────────────┬───────────────────────┘
                                  ▼
  dev window (driver loop): pick task → implement (TDD+verify) → PR → update
  backlog/handoff → next fresh session ... until window/STOP/cap/no-tasks
                                  ▼
             report (1 session): honest summary → daily-log issue + mirrors
```

- **State lives in files**, not conversations: `.factory/backlog/` (what to
  do), `.docs/` (what's known), `.docs/HANDOFF.md` (mid-task state). Every
  session starts cold and reads them — no compaction roulette.
- **The factory is a MACHINE product.** A project repo carries only work
  data — `.factory/{spec,backlog,inbox}`, the collaboration surface the
  driver commits to. Everything else about a factory — `config.json`
  (including the schedule declaration and the `enabled` switch), `.env`
  secrets, `log/`, `plan.json`, `board.json`, `STOP` — lives machine-side
  at `~/.factory/projects/<name>-<hash8>/` (called `<state>` below). Git
  can't clean it, clones don't carry it, and the repo never propagates
  factory config between machines: machines run factories independently.
- **The driver is dumb on purpose** (`factory.mjs`, Node ≥18, zero deps): it
  spawns `claude -p` sessions and enforces window time, per-session timeout,
  session cap, and the STOP file. Intelligence lives in prompts + skills.
- **One runtime per machine** (O6, NOTES item 46): driver, prompts, watchdog,
  and dashboard all run from `~/.factory/runtime/` — a clone of this repo
  that advances ONLY through `deploy-runtime.mjs` (syntax gate + fleet
  doctor gate). Nothing driver-shaped is copied into projects, and session
  tooling (allowlist, skills, the guard hook) is INJECTED into each session
  worktree at spawn from the runtime — never committed.
- **Humans are async**: the agent never waits. Sessions ask questions via the
  `open_question` MCP tool; the DRIVER dedupes them and files/updates the
  `needs-human` GitHub issues itself; answers get folded in by the next
  triage.

## Machine setup (once per machine)

1. **The runtime** — every scheduler execs it, every worktree gets its
   tooling from it:
   ```sh
   git clone <this-repo-url> ~/.factory/runtime
   ```
2. **Global skills** — the conversational setup entry point and the backlog
   vocabulary, available in ANY project on the machine:
   ```sh
   cp -R ~/.factory/runtime/factory/skills/factory-setup ~/.claude/skills/
   cp -R ~/.factory/runtime/factory/skills/backlog ~/.claude/skills/
   ```
   (These are machine tooling — the per-project `install.sh` skillset no
   longer bundles them.)
3. **Telegram plumbing** (optional but recommended): bot token + chat id in
   `~/.factory/telegram.env`, and `notify-fail.sh` in `~/.factory/` for the
   `factory-onfailure@.service` outer net (see Monitoring).
4. **Machine services**: the fleet watchdog timer and, on an always-on box,
   the dashboard service — templates in `factory/schedulers/`.
5. **Auth**: `claude` logged in (or `ANTHROPIC_API_KEY` in the factory's
   machine `.env`), `gh auth login` or `GH_TOKEN`.

To deploy driver/prompt improvements after they merge, run — per machine,
not per factory:

```sh
node ~/.factory/runtime/factory/driver/deploy-runtime.mjs
```

It fetches, refuses a dirty or diverged runtime, gates the candidate
(`node --check` on every driver module, then the CANDIDATE driver's doctor
over every registered factory, read-only), fast-forwards only when green,
stamps `~/.factory/runtime-deploy.json`, and Telegrams the result. A failed
gate leaves the runtime exactly where it was — the merge-gate principle
applied to the runtime itself. Log: `~/.factory/deploy.log`. **This is the
ONLY update verb** — there is no per-project tooling refresh anymore
(`init.mjs --update` died with the machine-product refactor).

## Setup (once per project and machine) — two ways, friendliest first

**A. Conversational (recommended):** with the `factory-setup` skill
installed machine-globally (machine setup step 2), open `claude` in (or
near) the project and say *"set up a factory here"*. The skill interviews
you, turns your pasted specs/ideas into `.factory/spec/` files, runs the
wizard below with your answers, compiles the backlog in the same sitting,
and offers a supervised test window. You only paste tokens.

**B. Wizard:** one command, 11 questions, everything mechanical done for you
(git init, the repo work-data dirs, machine-side config + `.env`, workspace
trust, registry entry, doctor run):
```sh
node ~/.factory/runtime/factory/driver/init.mjs --project /path/to/project
```
It writes NOTHING to the repo beyond `.factory/{spec,backlog,inbox}` — no
CLAUDE.md, no `.claude/`, no scaffold commit. Left for you afterwards:
specs into `.factory/spec/`, `GH_TOKEN` into `<state>/.env`, compile the
backlog (`cat <repo>/factory/prompts/compile-spec.md | claude` — prompts
live in the runtime, not the project), one manual test window, and
`factory.mjs schedule --install` if you declared a schedule (it prints the
exact command). **Setup is DONE when doctor is green — not before.**
`schedule: manual` (no independent runs) is a valid, declared end state;
doctor fails on drift between the declaration and what's actually
installed, in either direction.

**Same repo on another machine:** run `init.mjs` there too. Config is
per-machine on purpose — machines never share factory config through the
repo, so there is nothing to replay (`--from`/`factory.yaml` died with the
machine-product refactor).

**Migrating a legacy factory** (repo-side `config.json`, committed tooling
scaffold, or a v3 per-project driver copy):
```sh
node ~/.factory/runtime/factory/driver/factory.mjs migrate --project <path>
```
One shot, idempotent: moves state (`config.json`, `.env`, `log/`,
`plan.json`, `board.json`, `STOP`) to `<state>`, removes the committed
scaffold from git (owner edits kept, loudly), recovers `stack` and schedule
times from a transition-era `factory.yaml` before deleting it, heals
missing config schema keys (never inventing `enabled`), registers the
factory, and ends with a doctor run. Re-running it later is also how an
old config self-heals newly added schema keys.

Reference — what the wizard settles and why it matters:
- **Allowlist**: sessions run `--permission-mode dontAsk`; only allowlisted
  commands execute. The driver injects `.claude/settings.local.json` into
  every session worktree at spawn — a stack preset chosen by
  `config.json → stack` plus extras from `config.json → allow`; widen the
  latter when logs show legitimate denials.
- **Workspace trust**: headless sessions IGNORE the allowlist until the
  project is trusted (`hasTrustDialogAccepted` in `~/.claude.json` — the
  wizard sets it, with a backup). Symptom if missing: "Ignoring N
  permissions.allow entries … workspace has not been trusted" and every tool
  call denied.
- Specs: pattern in `factory/templates/spec-template.md` (runtime) —
  numbered REQ ids make coverage checkable; any spec still compiles.

## Autonomy levels (`config.json → autonomy`)

| Level | Behavior | Use when |
|---|---|---|
| `pr-only` | Every task → PR; humans merge | default; new/critical projects |
| `auto-merge-dev` | The DRIVER merges factory PRs to `baseBranch` when checks green (sessions never merge) | trusted CI, fast iteration |
| `milestone-gates` | Auto-merge inside a milestone; stops at boundaries until you close the gate issue | long autonomous stretches with checkpoints |

Opening the next milestone is a driver verb:

```sh
node ~/.factory/runtime/factory/driver/factory.mjs promote M3 --project <path>
```

flips `## M3 … — not-started` (or `— gated`) to `— active` in
`backlog/index.md` and commits+pushes it as the driver — no hand-edited
`factory/ops-*` PR tripping the merge gate's code-only warning. Prior
active milestones are KEPT active (deps order the work; don't strand
foundation tasks) — marking one `done` stays an explicit human/triage
edit. Idempotent; refuses `done`/unknown milestones and a live window.

## Git & status ownership (NOTES items 23–24, 39–41)

- **Worktree isolation (v2): your checkout is yours.** Every session runs in
  a throwaway worktree under `~/.factory/worktrees/<name>/`, detached at the
  base branch's origin tip (clean by construction, trusted automatically,
  removed after the session). All driver git work — gate merges, status
  flips, triage commits — happens in a persistent detached `meta` worktree
  there, refreshed from origin at every boundary and pushed `HEAD:<base>`.
  The factory never flips your checkout's branch or quarantines your WIP
  mid-window; its only touch is a fast-forward when your checkout is clean,
  on base, and strictly behind. **Origin is the rendezvous point**: your
  work is invisible to the factory until pushed (`prep` pushes for you),
  and quarantine/rescue machinery survives inside `prep` — the explicit
  "make my checkout safe" command.
- **Task branches are code-only.** Sessions never edit `.factory/backlog/`,
  never commit to base, never merge. They report MID-RUN through the
  driver's stdio MCP server (v2 O2: `report_status`, `open_question`,
  `log_progress` — validated tool calls appended to
  `<state>/log/<mode>-<ts>.mcp.jsonl`; a session killed at minute 40 has
  already reported everything up to minute 40, and its last settled report
  stands in for `<state>/log/last-session.json`, which survives as the
  fallback). The driver writes backlog `Status:`
  lines itself — `done` folded INSIDE the gate's merge commit, `blocked` as
  its own rare commit, `in-progress`/`review` runtime-only in
  `<state>/log/state.json` (the open PR is the review record; prompts and
  the board get the overlay). After each successful triage the overlay is
  reconciled to the files: triage saw the overlay in its own prompt, so a
  file-expressible entry (`blocked`/`done`) the files now disagree with —
  or a pending flip they contradict — is stale and gets dropped; a runtime
  `blocked` can never outlive a triage that re-opened the task. Runtime-only
  statuses (`in-progress`, `review`) always survive. Net effect: zero
  bookkeeping commits in the normal path and no more backlog merge
  conflicts.
- **The rules are enforced by machinery, not prompts (v2).** A PreToolUse
  guard hook (the runtime's `guard.mjs`, wired by absolute path into the
  `.claude/settings.local.json` the driver injects into every session
  worktree) mechanically denies sessions: edits to deployed
  tooling, dev-session edits to the backlog, `gh pr merge`, and
  commit/push on (or push targeting) the base branch. It activates only
  when the driver sets `FACTORY_MODE` — your interactive sessions in the
  same checkout are untouched.
- **Factory metadata is exempt from PR-gating** at every autonomy level:
  backlog/spec/status commits go straight to base (triage's edits are
  committed by the driver after the session). Product code always follows
  the autonomy level.
- **Every window keeps a journal** (`<state>/log/journal-<window-ts>.jsonl`):
  one line per driver step, and window-end finalization (sweep, repo, scratch,
  board sync, notify, lock release) runs as idempotent journaled steps. If a
  window dies mid-finalization, the next `dev` or `prep` run completes
  exactly the missing steps. Killed sessions still land in `usage.jsonl`
  with real token counts summed from their streamed events (`partial: true`
  rows are lower bounds).

## Per-task model & effort routing

Every not-yet-done task in the backlog carries `Model:` and `Effort:` hints
(required — the dashboard flags gaps) plus an optional `Turns:` (see the
backlog skill) — set by compile-spec/triage by difficulty, e.g. cheap model
for well-specified CRUD, stronger model for novel game logic. Each triage
writes `<state>/plan.json`: the ordered session
queue for the next window with those settings resolved (corrected against
usage.jsonl evidence — tasks that keep turn-capping get more). The driver
spawns each dev session with the entry's `--model`/`--effort`/`--max-turns`
and assigns it the task; missing/stale plan or an exhausted queue falls back
to sessions self-selecting with factory defaults (`config.json → model`,
`effort`, `maxTurnsPerSession`). `--effort` needs Claude Code ≥ 2.x; on
older CLIs the driver logs a warning and omits it.

A task's `Model:` pin is a floor at launch: the driver raises a plan/config
model BELOW the pin to the pin (haiku < sonnet < opus < fable) and logs it —
a cheaper session "having a go" at a pinned task produces confidently-wrong
work (the twins made opposite calls on the same opus-pinned task). A plan
model ABOVE the pin wins: that's triage correcting against observed usage.
Self-selecting sessions apply the same rule from the backlog skill (skip
above-tier tasks).

Triage sessions run with `config.json → triageModel` (defaults to `model`;
`migrate` heals a missing key from the factory's own `model`). Planning
quality gates everything downstream, so a factory can run cheap dev sessions
while giving triage a stronger model — e.g. a game project whose dev tasks
are cheap but whose planning needs a top-tier model.

Task vocabulary has two parking states: `blocked` (dependency/technical —
machine-clearable, triage re-opens it) and `needs-human` (only the owner
clears it). A session that cannot self-judge a task's acceptance files an
`open_question` WITH the taskId; the driver files the GitHub issue, parks
the task `needs-human`, and links the issue on it (`- Question: <url>`).
Tasks whose acceptance needs owner judgment upfront carry
`- Gate: human (<reason>)` (stamped by triage): the merge gate never
auto-merges their green PRs — it parks the task, asks the owner ONCE on the
PR, and the owner's own merge is the approval (it flips the task done).
Factory-level status derives from the pool: actionable work → normal; only
`needs-human` left → `waiting on owner (N)` — never plain idle; only
dependency-blocked left → `deadlocked` (the louder alarm). A dev window
that starts with zero actionable tasks skips itself BEFORE spawning a paid
session (logs + notifies "window skipped"); an empty backlog still gets its
probe session.

Under `auto-merge-dev`, a session that ends at status `review` with a PR url
hands the merge to the driver: it polls `gh pr checks` (free, no tokens) and
merges on green — sessions never wait on CI. The merge is done LOCALLY
(`git merge --no-ff` + push) so the task's `done` flip travels inside the
merge commit; a CONFLICTING PR is left with an exact rebase instruction for
the next session, and at window end a sweep gives every still-open green
factory PR one more gate pass. Poll budget:
`config.json → mergeGateMinutes` (default 10).

## Scheduling (`factory.mjs schedule`)

The schedule is a DECLARATION in machine config (`config.json → schedule`:
`{kind, timezone?, modes: {triage/dev/report: {time, days}}}`), and the
`schedule` subcommand projects it onto the machine — every generated unit
execs the machine runtime (`~/.factory/runtime/…`):

- `schedule --status` — declaration vs what's actually installed.
- `schedule --declare` — set kind/times/days (flags or interactive).
- `schedule --install` — generate from the declaration, DIFF against the
  installed units, confirm (`--yes` to skip), copy + enable. systemd user
  units on Linux (better logs via `journalctl`), launchd plists on macOS
  (system TZ only — it can't express a timezone), a managed crontab block
  as the fallback.
- `schedule --adopt` — parse already-installed units into the declaration
  (for factories scheduled by hand or by older inits).
- `schedule --uninstall` — remove the units.

Doctor verifies the declaration semantically against what's installed
(times, days, timezone, runtime exec path) and fails on drift in either
direction. Templates for the MACHINE services (watchdog timer, dashboard
service, `factory-onfailure@.service`, Windows `register-tasks.ps1`) live
in `factory/schedulers/`.

- Typical day: triage 08:30 → dev 09:00 (window length from config) →
  report ~30min after the window ends.
- **Pausing a factory**: set `"enabled": false` in `<state>/config.json`
  (NOTES item 47) — a machine-file flip, no commits. Timers keep firing and
  exit silently with one log line; manual and dashboard runs are refused
  with the reason; doctor stays green and runtime deploys keep working.
  Resume = set it back to `true`. Don't pause by disabling timers — that is
  undeclared drift (a factory that silently believes it's scheduled) and
  fails doctor.
- **Auth note**: each machine needs `claude` logged in (subscription) or
  `ANTHROPIC_API_KEY` in `<state>/.env`. `gh` needs `GH_TOKEN` (no
  interactive login required).

## Feeding it input (any time)

- **GitHub** (canonical): file issues; comment on `[factory]` PRs; answer
  `needs-human` issues and close them. Next triage folds everything in.
- **Notion / Jira mirrors**: enable in `config.json → mirrors` + tokens in
  `<state>/.env`. Notion needs the official Notion MCP server in the project's
  `.mcp.json` with `NOTION_TOKEN` (internal integration token — OAuth does
  NOT work headless). Jira uses plain REST with an API token.
- **Zero-dependency fallback**: drop a markdown note in `.factory/inbox/`.
- **GitHub Projects board** (opt-in, two-way): set
  `"board": {"github": true}` in `config.json`, grant the scope once
  (`gh auth refresh -s project`), then
  `node ~/.factory/runtime/factory/driver/factory.mjs sync-board --project <path> --init` — creates
  (or finds) a Projects v2 board named after the factory, sets its Status
  options to the backlog vocabulary, adds an Epic field, and caches ids in
  `<state>/board.json`. From then on the driver mirrors the
  backlog to the board at window start/end, after each session, and after
  triage — task cards carry status, epic, model/effort and PR links. The
  backlog markdown stays the source of truth; sync failures never affect
  the run. **The board is also an input**: add a card (draft or issue) and
  the next sync captures it into `.factory/inbox/board-delta.md` for
  triage to fold into the backlog (the card is archived — a proper task
  card replaces it once triaged); drag a card against factory state and
  the move is recorded for triage to judge while the factory's status is
  restored (factory wins on status, humans win on new work and priority).
  Full design: `specs/github-projects-sync.md`.

## Monitoring & control

- **Dashboard** — live web UI over every factory on the machine:
  `node ~/.factory/runtime/factory/driver/dashboard.mjs` → http://localhost:7788.
  Shows per factory: status (running window + session #, idle, STOP'd,
  disabled, missing), declared state chips (schedule kind + a ⚠ chip if
  `enabled` is missing/non-boolean), config, backlog task table with PR/issue
  links, last-session summary, driver log tail, and cost/token spend (today +
  all-time, from `<state>/log/usage.jsonl`). The UI is a code4food-branded
  admin console: a left sidebar (fleet filters — all / running / needs-human /
  paused), a KPI row (factories · running · needs-human · spend-today with a
  sparkline), and a factory **table** whose rows expand to a detail panel
  (controls, PRs, last session, and the usage/tasks/log accordions). The
  header carries the checkout's version currency (`runtime <sha> · current` /
  `· N behind — deploy-runtime.mjs` / `version unknown`); a `scaffold stale`
  chip is transition-era only — it flags a NOT-yet-migrated project whose
  committed scaffold copies drifted from the running checkout (fix:
  `factory.mjs migrate`); migrated projects carry no copies to drift.
  **Config**: `~/.factory/dashboard.json`
  (`{port, listen, token}`, all optional) supplies these; CLI flags override
  it. `"listen": "tailscale"` resolves the tailnet IPv4 at startup. Binds
  127.0.0.1 by default. Factories register in `~/.factory/registry.json` at
  init time. Remote access: see "Dashboard on a VPS" below.
- **Operate a factory (from the dashboard)** — expand a table row for its
  control cluster: it shows only the actions the current state allows, and
  only when the
  dashboard runs with a token (config or `--token`); tokenless it stays
  read-only (mutations answer 403). Idle+enabled: **▶ dev window** (full
  window), **▶ next task** (one session, `--max-sessions 1` — burns leftover
  subscription limit one task at a time), **triage**, **⏸ pause**, **⏻
  disable**. Running: **⏸ stop after current session**. STOP'd: **▶ resume**,
  **⏻ disable**. Disabled: **⏻ enable**. Every mutation writes a file the
  driver already honors — `<state>/STOP` (pause/resume) or the machine
  `config.json → enabled` (item 47's declared switch; timers stay installed,
  scheduled fires exit silently while disabled) — never a signal or a systemd
  touch. Runs are still refused (409) while a window is running or a STOP
  file is present. The shell equivalents: `touch <state>/STOP`, edit
  `<state>/config.json`, or
  `node factory.mjs dev --project <path> --max-sessions 1`.
- **Doctor** — `node ~/.factory/runtime/factory/driver/factory.mjs doctor
  --project <path>`: read-only checklist of everything that has actually
  broken a night once — claude/gh on the current AND the systemd unit's
  PATH, workspace trust, scaffold, allowlist, machine-runtime health (clean
  tree; legacy per-project driver copies warn; schedulers still exec'ing a
  deleted `.factory/driver.mjs` FAIL with the migration hint), .env keys
  for enabled features, gh auth scopes, timers + linger, docker when
  compose exists, plan freshness, dashboard registry, plus the setup
  contract (NOTES item 25): `schedule` declared and matching what's
  installed, `enabled` a declared boolean (item 47 — a disabled factory is
  a legitimate state and doctors GREEN, its timer checks skipped),
  the git contract (the repo carries only work data — a still-tracked
  legacy `config.json` or `.env` FAILS with the migrate hint),
  backlog format parseable, CI-present warning under auto-merge. Exit 1 on
  problems. Run it after ANY infra change (new machine, runtime deploy,
  token rotation, scheduler edit, feature enable) — it is cheaper than
  losing a window. Scheduler entries pass `--scheduled`, which runs these
  same checks as a preflight and aborts + Telegrams instead of
  half-running.
- **Deploy** — `node ~/.factory/runtime/factory/driver/deploy-runtime.mjs`
  after merging driver/prompt changes: one command per machine advances the
  fleet, gated on syntax + every factory's doctor (see "Setup: the
  runtime"). The `OnFailure=factory-onfailure@…` units are the dumb outer
  net: if a factory unit fails in ANY way — even a runtime too broken to
  send its own Telegram — `~/.factory/notify-fail.sh` (plain sh + curl,
  creds in `~/.factory/telegram.env`) still reaches the phone.
- **Fleet watchdog** (item 26): `factory/driver/watchdog.mjs` + the
  `factory-watchdog.timer` template — one timer per MACHINE that runs every
  registered factory's doctor daily, writes `<state>/log/doctor.json`
  (dashboard tile), and Telegrams a summary when anything fails. A dead
  factory gets noticed by machinery within a day, not by you wondering why
  there were no PRs.
- **Fleet supervisor** (PR-D, Layer 1): `factory/driver/supervisor.mjs` —
  one daemon per MACHINE, kept alive by the OS (`supervisor.mjs install`
  writes a systemd `Restart=always` unit or a launchd `KeepAlive` agent; an
  OS restart is the fix for "the relauncher died silently"). Every 60s it
  rebuilds its whole picture from disk (registry + each factory's
  `window.lock` + journals), so restarts lose nothing. Three duties:
  1. **Out-of-band wall-clock kill of hung runs** — the driver's own
     timeouts share its event loop, so a stalled sync git/gh call hangs the
     watchdog with the watched (the 2026-07-11 4.5h hang). A live lock past
     its bound (dev: `windowEndsAt` + a config-derived finalization budget
     — sessionTimeout + 2× merge-gate + 30min slack; triage/report/prep:
     `startedAt` + sessionTimeout + 30min) gets its full process tree
     killed (claude children live in separate process groups — killing the
     driver pid alone strands them), `prep` cleans up, one escalation goes
     out. A lock pid that is no longer a factory driver is never killed
     (pid recycling) — it escalates `hung-window-unkillable` instead.
  2. **Owner-directed relaunch loop** — opt-in per named run, never a
     standing default: `supervisor.mjs keep --project <p> --until <ISO |
     HH:MM>` (HH:MM = next occurrence; `release` cancels). While active
     and no window is running it relaunches `dev`. It stops itself: a
     relaunched window that reports `window-skipped` (waiting on owner /
     deadlocked, PR-C's derived status) drops the directive and escalates
     once; two consecutive launches that run zero sessions drop it as
     `relaunch-failed`; expiry and `enabled:false` drop it silently.
  3. **Escalations outbox** — appends structured records to
     `~/.factory/escalations.jsonl` (the Layer-3/Eva contract — format in
     `.docs/escalations.md`) and pings Telegram best-effort
     (`~/.factory/telegram.env`, else any factory's `.env`). Each cause
     escalates exactly once (dedupe in `~/.factory/supervisor/state.json`).
- `<state>/log/dev-*.out` — full session transcripts.
- `[factory] daily log` issue — plan of day + window reports.
- **Stop**: `touch <state>/STOP` (finishes current session, then exits);
  remove the file to allow the next window. Emergency: kill the driver
  process — next session recovers from HANDOFF/git state.
- **Prep** (after YOU worked in the factory checkout):
  `node ~/.factory/runtime/factory/driver/factory.mjs prep --project <p>` — quarantines anything
  uncommitted (copied to `<state>/log/quarantine-<ts>/` and stashed;
  `git stash pop` to take it back), returns the tree to the base branch at
  origin tip, pushes unpushed commits, drains pending status flips, gives
  leftover green factory PRs one gate pass, ends with a doctor summary.
  Zero sessions, zero cost. Run it whenever you're done piloting and want
  the next window to start from a known-good repo.
- **Telegram notifications** (opt-in) — the driver pushes window start/end,
  per-session results (task, status, cost, PR link), merge-gate merges, and
  breaker trips to a Telegram chat. Setup:
  1. Create a bot: message [@BotFather](https://t.me/BotFather) → `/newbot`
     → copy the token.
  2. Get your chat id: send the bot any message, then open
     `https://api.telegram.org/bot<token>/getUpdates` and read
     `message.chat.id`.
  3. Put both in `<state>/.env`: `TELEGRAM_BOT_TOKEN=…`,
     `TELEGRAM_CHAT_ID=…`, and enable in `config.json`:
     `"notify": {"telegram": true}`.
  One bot serves all factories — messages are prefixed `[<factory-name>]`.
  Notification failures are logged and never affect the run.
- **Budget**: spend ≈ sessions × turns. Caps: `windowHours`,
  `maxSessionsPerWindow`, `maxTurnsPerSession`, `sessionTimeoutMin`. There is
  no per-session dollar cap in Claude Code — these four ARE the budget.
  A session that hits the turn cap mid-wrap-up is logged `turn-capped`, not
  `died` — it doesn't arm the two-deaths breaker, and the driver injects a
  repo snapshot into the next session's prompt so it lands the leftovers
  instead of re-discovering them.

## Safety notes

- `dontAsk` + a narrow allowlist is the default posture. `bypassPermissions`
  (`config.json → permissionMode`) only inside a container/VM you'd be happy
  to lose — see devcontainer docs; never on a machine with your credentials
  loosely scattered.
- The agent never pushes `main` (router rule + `pr-only` default). Protect
  `main`/`dev` with branch protection anyway — belt and suspenders.
- Give the Factory its own GitHub machine user + fine-grained PAT scoped to
  the one repo if coworkers' repos are involved.

## Dashboard on a VPS (Tailscale + iPhone)

Auth is network-level: the dashboard binds the Tailscale interface only, so
nothing is exposed to the public internet — only devices on your tailnet can
reach it. The token is optional defense-in-depth inside the tailnet.

One-time:
1. VPS: install Tailscale (`curl -fsSL https://tailscale.com/install.sh | sh`,
   then `tailscale up`). Note the IP from `tailscale ip -4` (100.x.y.z) and
   the MagicDNS name (`tailscale status`, e.g. `myvps.tailnet-name.ts.net`).
2. iPhone: install the Tailscale app, log in with the same account, toggle ON.
3. VPS: create `~/.factory/dashboard.json`
   (`{ "listen": "tailscale", "token": "<secret>" }`, then
   `chmod 600`), then install the now machine-agnostic
   `schedulers/factory-dashboard.service` (flagless `ExecStart`; instructions
   in the file). The token stays in the file, out of `ps`-visible argv.
4. iPhone Safari: open
   `http://myvps.tailnet-name.ts.net:7788/?token=<secret>` → Share → **Add to
   Home Screen**. You now have a Factory app icon; it auto-refreshes every 5s
   while open.

Do NOT `--listen 0.0.0.0` on a public box: the state includes project paths,
task titles, and spend. The tailnet IS the authentication; keep it that way.

### Where the dashboard runs: on demand, direct, or behind a web server

The dashboard is plain HTTP by design — it never terminates TLS. Pick per
machine; nothing here is mandatory infrastructure:

- **On demand (laptop/desktop).** Just run it when you want to look:
  `node <runtime>/factory/driver/dashboard.mjs --token <secret>` →
  `http://localhost:7788/?token=<secret>`. Nothing to install, no proxy; kill
  it when you're done. This is all a personal machine ever needs.
- **Direct on the tailnet (simplest always-on).** `~/.factory/dashboard.json`
  with `"listen":"tailscale"`; reach it at
  `http://<magicdns>:7788/?token=<secret>`. Tailscale (WireGuard) already
  encrypts the transport — this is the setup documented just above.
- **Behind the box's web server (VPS/cloud).** Bind the dashboard to localhost
  and let your existing reverse proxy own the tailnet/public interface. It is
  ordinary HTTP, so Caddy, nginx, Apache — whatever the server already runs —
  all work the same way.

Caddy example — bind the dashboard to localhost, proxy from the tailnet name:

```jsonc
// ~/.factory/dashboard.json
{ "listen": "127.0.0.1", "token": "<secret>" }
```

```caddy
# Caddyfile
myvps.tailnet-name.ts.net {
    bind <tailscale-ip>                       # tailnet only, never 0.0.0.0
    tls /etc/caddy/ts.crt /etc/caddy/ts.key   # from `tailscale cert <name>`; drop the line for plain HTTP
    reverse_proxy 127.0.0.1:7788
}
```

nginx is the same idea (`proxy_pass http://127.0.0.1:7788;` in a `location /`).
Whatever proxy you use, four things are specific to this app:

1. **Serve it at a host root, not a subpath.** The page uses absolute paths
   (`/api/state`, `/api/run`, `/log`), so a `/dashboard/*` mount 404s every API
   call — give it its own hostname/subdomain.
2. **Set `"listen":"127.0.0.1"`** (not `"tailscale"`) when a proxy fronts it, so
   the proxy is the only thing that can reach the dashboard directly.
3. **Token passthrough is automatic** — the `?token=` query and
   `Authorization: Bearer` header pass through untouched; open with
   `?token=<secret>`.
4. **No websockets** — the UI only polls `/api/state` and `/api/log`, so a plain
   reverse proxy needs no upgrade/streaming config.

Same rule as the direct setup: don't bind the proxy to `0.0.0.0` on a public
box. The tailnet stays the primary auth; TLS/hostname is convenience, not the
security boundary.

## Optional: Anthropic cloud routines adapter

If the machine is off during the window, triage/report (and even dev) can run
as scheduled cloud routines instead (`/schedule` in Claude Code): repos clone
fresh per run, `claude/` branches, PRs, and your claude.ai connectors
(Notion/Jira/Slack) are available there. Point the routine's prompt at the
same `factory/prompts/*.md` files — the state contract is identical. This is
an adapter, not a requirement.

## First run on Windows (untested — verify these)

1. `node --version` ≥ 18; `claude --version` works in the same shell; the
   project is trusted (setup step 6 — the flag lives in `~/.claude.json`,
   which on Windows is under your user profile).
2. Bootstrap the runtime (`git clone <repo-url> %USERPROFILE%\.factory\runtime`)
   and run `node <repo>\factory\driver\init.mjs --project C:\path\to\project`;
   then `node %USERPROFILE%\.factory\runtime\factory\driver\factory.mjs dev
   --project C:\path\to\project` manually once — watch
   `<state>/log/` for a session that starts and reports (a `dev-*.mcp.jsonl`
   with a `report_status` row, or `last-session.json` as the fallback).
   Verify the MCP wiring survives the `shell: true` spawn: the driver quotes
   the `--mcp-config` path (spaces in `C:\Users\First Last\...`), and the
   `--help` feature probe must find `--mcp-config` even through an npm
   `.cmd` shim — if the log says "no --mcp-config", that probe is the bug.
3. Timeout kill uses `child.kill()` — verify a hung session actually dies
   (set `sessionTimeoutMin: 1` and a dummy prompt to test).
4. Then `register-tasks.ps1`, and trigger one task manually via
   `Start-ScheduledTask`.
