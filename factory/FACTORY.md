# Factory — autonomous spec-driven development

Claude Code develops a fully-specced product alone in daily windows: fresh
headless session per task, state carried in files, humans feed input async.
Portable: the same driver runs on macOS and Linux/VPS. Windows is not a
supported factory host (Windows machines still use the skillset and pilot
factory repos as live sessions — see "Windows" at the end of this file).

**This file is operations.** The factory's contracts are recorded as ADRs in
the development repo and enforced by the driver source that ships beside this
file; where this file and the driver disagree, the driver is right.

## How it works

```
             ┌──────────── triage (1 session) ────────────┐
  tracker input (issues / Jira / Discord) / Notion / .factory/inbox  →  backlog updates + plan of day
             └────────────────────┬───────────────────────┘
                                  ▼
  dev window (driver loop): pick task → implement (TDD+verify) → PR → update
  backlog/handoff → next fresh session ... until window/STOP/cap/no-tasks
                                  ▼
  report (1 session): honest summary → daily log on the tracker + mirrors
```

- **State lives in files**, not conversations: `.factory/backlog/` holds what to
  do and, on a task's `Notes:`, where the last session stopped. Every session
  starts cold and reads them — no compaction roulette.
- **The factory is a MACHINE product.** A project repo carries only work data —
  `.factory/{spec,backlog,inbox}`, the collaboration surface the driver commits
  to. Everything else — `config.json`, `.env` secrets, `log/`, `plan.json`,
  `board.json`, `STOP` — lives machine-side at
  `~/.factory/projects/<name>-<hash8>/`, called `<state>` throughout this file.
  Git cannot clean it and clones do not carry it, so machines run factories
  independently.
- **The driver is dumb on purpose** (`factory.mjs`, Node ≥18, zero deps): it
  spawns `claude -p` sessions and enforces window time, per-session timeout,
  session cap and the STOP file. Intelligence lives in prompts and skills.
- **One runtime per machine**: driver, prompts, watchdog, supervisor and
  dashboard all run from `~/.factory/runtime/`, which advances only through
  `deploy-runtime`. Nothing driver-shaped is copied into projects — session
  tooling is injected into each worktree at spawn and never committed, and
  skills come from the machine-installed plugins.
- **Humans are async**: the agent never waits. Sessions ask questions through
  the `open_question` MCP tool; the DRIVER dedupes them and files or updates
  `needs-human` items on the configured tracker. Dedupe is by normalized title
  AND, for a question carrying a `taskId`, by the open thread already filed for
  that task: **one task, one open thread**, because each session inheriting a
  stuck task restates the same blocker in wording no title match would catch. A
  later question about that task comments on its thread instead of opening
  another. A closed or answered thread suppresses nothing — the question
  recurred, or the answer did not take. A question filed WITHOUT a `taskId` by
  a session reporting `blocked` is attributed to the task it blocked on, since
  an untied question parks nothing and would leave the owner's answer on a
  thread no task links to.

## Piloting (owner live sessions)

Live sessions in a factory repo are first-class, any time — the factory is
built to interleave with them.

- **The checkout is the owner's.** The driver never flips its branch and never
  quarantines WIP. Its one touch: a fast-forward when the checkout is clean AND
  on base AND strictly behind origin. `prep` is the explicit repair verb for a
  dirty checkout, not a required handoff step.
- **Claim a backlog task before piloting it: open a DRAFT pull request with the
  task id in the title** (e.g. `T-023: add invoice export`; the branch name is
  free, and this works on both forges). While that PR is open the factory skips
  the task and its merge sweep never touches drafts. The convention ships
  in-repo as `.factory/README.md` — init stamps it, migrate heals it, and
  doctor warns when it is missing — so teammates without the skillset learn it
  by opening the directory.
- **End every live session pushed** (merged or as a PR). Unpushed work is
  invisible to the factory and to your other machines.
- **Update the `Status:` lines of tasks you shipped** as part of what you merge
  — your own tasks only, never index counts or other tasks' lines.
- **Bitbucket repos: use `bb`** — the runtime ships a gh-style PR CLI
  (`factory/driver/bb.mjs`, symlinked onto PATH at machine setup):
  `bb pr create|list|view|merge|comment`, `bb` alone for usage. It resolves
  credentials machine→project (`~/secrets/factory-shared.env` under the
  registered factory's state `.env`), so live sessions never touch tokens or
  curl — session credential forms are proven dead on Bitbucket. Non-factory
  Bitbucket repos work too, via `BITBUCKET_EMAIL` + `BITBUCKET_API_TOKEN` in
  the environment.

## Machine setup (once per machine)

ONBOARDING.md walks the install; this is what it does not say.

1. **The runtime** — every scheduler execs it, and every session worktree gets
   its tooling from it:
   `git clone https://github.com/MJTeixeira/claude-plugins ~/.factory/runtime`
2. **Plugins** — provisioned by the same deploy verb, at user scope, so the
   skillset and factory skills are available in ANY project on the machine:
   `node ~/.factory/runtime/factory/driver/deploy-runtime.mjs`
3. **Auth** — `claude` logged in (or `ANTHROPIC_API_KEY` in the factory's
   machine `.env`), plus `gh auth login` or `GH_TOKEN`.
4. **Machine services** — the fleet watchdog timer, the supervisor, and on an
   always-on box the dashboard: templates in `factory/schedulers/`. Telegram
   plumbing is optional but recommended (§Machine credentials), with
   `notify-fail.sh` in `~/.factory/` for the `factory-onfailure@.service`
   outer net.
5. **`bb` on PATH** — symlink `factory/driver/bb.mjs` for Bitbucket repos.

### Fleet publisher (optional, systemd hosts only)

A machine can stream its state to a fleet-control collector:
`fleet-publisher.mjs install [--yes]` writes
`factory-fleet-publisher.service`, a machine-level unit belonging to no
project, `Restart=always` with the `factory-onfailure@` companion, enabled at
boot. **systemd only** — there is no launchd branch, so a non-enrolled machine
drives a collector attended (`--once` / foreground) with a throwaway id, never
an installed daemon.

**Place the config and credential BEFORE `install`** — a daemon installed with
no config exits repeatedly and pages you. Identity and collector URL go in
`~/secrets/factory-shared.env` (`FLEET_MACHINE_ID`, explicit and never derived
from a hostname; `FLEET_CONTROL_URL`; optional `FLEET_MACHINE_ROLE`); the
credential lives apart in `~/secrets/fleet-publisher.env`
(`FLEET_PUBLISHER_SECRET`) and travels only as a bearer header. Each machine's
secret stays in that machine's own secret location — no repo ever holds one.

**Driving it by hand.** `--once` prints what a fresh connection would send and
exits; `--offline` keeps it off the network. Three flags write the thing a real
machine usually has none of, and every one of them requires `--once`:
`--fixture-window` writes a recorded window to disk so the heartbeat runs on a
machine with none, `--subscribe` streams that window's transcript the way a
viewer watching it would see it — from the moment of subscription, never a
replay — and `--fixture-park` writes a throwaway factory with one task parked on
a question and the tracker thread it filed, printed as one more snapshot, so the
thread a park carries can be read where nothing is parked. All of them still
need `FLEET_MACHINE_ID` set: identity is checked before anything is printed.
`--tape` ends that recorded window and prints the tape it becomes, and
`--stale-ledger` alongside it dates that window's ledger entry past the thirty
days a window stays owed, so the sweep that lets a window go can be watched
without waiting for one. `--timings` alongside `--tape` prints what the rebuild
did — how many session transcripts it read, how many times it opened each, and
how often it handed the event loop back — on stderr, so it never joins the
envelope stream on stdout. One read per session
is the healthy number; anything above it means a window's transcripts are being
parsed more than once, which on a day-sized window is tens of megabytes of work
the daemon does instead of beating.
`FLEET_STREAM_MS` overrides the transcript's own 2-second tick (tests only).
`--command <verb>` performs one verb against that recorded window and prints the
answer — never against this machine's own projects, so it is safe to run twice.

The daemon keeps one file of its own, `~/.factory/fleet-commands.json`: the
commands it has been given, written down before each is performed and aged out
after thirty days. It is what stops a restart from performing a command twice
and what makes an answer survive a reconnect. Deleting it is safe for a machine
with nothing in flight and is otherwise how you get a command run twice.

Failure posture worth knowing before it pages you: unreachability retries
forever with capped backoff and never exits, because a collector restarting
under its own deploy is normal. A sustained credential REJECTION exits
non-zero, loops into the unit's start limit, and pages — rejection is the one
failure invisible to both systemd and the board, so it dies loudly.

### Deploying a runtime advance

`deploy-runtime.mjs` is the ONLY update verb — there is no per-project tooling
refresh. Run it per machine, not per factory. It refuses rather than proceeds
on every doubt: a runtime whose origin is not the canonical distribution repo
(a wrong or retired remote reports "up to date" forever — a silently frozen
machine; `FACTORY_RUNTIME_ORIGIN` overrides for forks), a dirty or diverged
runtime, a candidate failing `node --check`, a candidate whose doctor is not
green over every registered factory, or plugin content changed without a
version bump. A failed gate leaves the runtime exactly where it was.

After an advance it names any long-lived unit still running old code, with the
restart command. Running that command is yours: the deploy hints and never
restarts what it superseded — the supervisor and the fleet publisher alike. It
asks systemd `--user` and launchd which units exec a module out of this
runtime, walks each one's local imports transitively, and reports the unit
stale when the deploy's diff touched anything it reaches — so a change to a
module the dashboard merely imports is named too. Only RUNNING processes
qualify; timers and the per-factory `@dev`/`@triage`/`@report` oneshots re-exec
per fire and self-heal, and restarting one of those would launch a window.

Log: `~/.factory/deploy.log`. Stamp: `~/.factory/runtime-deploy.json`.

An **unattended machine** declares itself in `~/.factory/unattended.json`,
naming the plugin its sessions load instead of the shipped pair and a sha256
manifest of hand-overlaid runtime files. `deploy-runtime` REFUSES there.
Doctor verifies the declaration instead of failing red: overlaid files must
match the manifest exactly, the declared plugin must be installed at its
source's version, and a leftover `*@code4food` plugin fails as a same-name
collision. Remove the declaration to return the machine to the shipped runtime.

## Setup (once per project and machine)

ONBOARDING.md is the walkthrough. Three things it does not cover:

**Spec before you have a host.** The `spec` skill needs only the factory
PLUGIN — no runtime, no factory host — so a project can be specced in
multi-sitting interviews on any machine, Windows included, days before a
factory exists. Its red-team pass resolves or `Gate: human`-stamps every
owner-judgment question, which is what stops those questions interrupting a
long autonomous run later. Both setup paths detect existing specs and skip to
the mechanics.

**Setup is DONE when doctor is green — not before.** `schedule: manual` (no
independent runs) is a valid declared end state; doctor fails on drift between
what you declared and what is installed, in either direction.

**Same repo on another machine: run `init.mjs` there too.** Config is
per-machine on purpose — machines never share factory config through the repo,
so there is nothing to replay.

`init` writes nothing to the repo beyond `.factory/`: the `{spec,backlog,inbox}`
dirs, `.factory/.gitignore`, and `.factory/README.md` (the in-repo claim
contract for teammates). No CLAUDE.md, no `.claude/`, no scaffold commit.

Two answers the wizard asks that no default can settle for you:

- **Allowlist**: sessions run `--permission-mode dontAsk`, so only allowlisted
  commands execute. The driver injects `.claude/settings.local.json` into every
  session worktree at spawn — a preset chosen by `config.json → stack` plus
  extras from `config.json → allow`. Widen `allow` when logs show legitimate
  denials.
- **Workspace trust**: headless sessions IGNORE the allowlist until the project
  is trusted, and BOTH flags in `~/.claude.json` are required.
  `hasTrustDialogAccepted` alone lets the session run, but the allowlist and
  hooks apply only once `hasCompletedProjectOnboarding` is set too — without
  it a `dontAsk` session denies even `echo`. The wizard sets the pair, with a
  backup. Symptom if missing: "Ignoring N permissions.allow entries … workspace
  has not been trusted", and every tool call denied.

**Migrating a legacy factory** (repo-side `config.json`, a committed tooling
scaffold, or a per-project driver copy):
`node ~/.factory/runtime/factory/driver/factory.mjs migrate --project <path>`.
One shot, idempotent: moves state to `<state>`, removes the committed scaffold
from git (owner edits kept, loudly), heals missing config schema keys without
ever inventing `enabled`, registers the factory, ends with a doctor run.
Re-running it later is how an old config self-heals newly added keys.

## Configuration reference (`<state>/config.json`)

The ONE table for every key the driver reads — the sections below explain the
behaviour, this says what exists and what it defaults to. `init` writes
sensible values for all of them; `migrate` heals keys added by a later
runtime (never inventing `enabled`). A doc-coverage ratchet
(`factory/driver/test/docs-coverage.test.mjs`) fails the build if this table
and the driver disagree in EITHER direction, so a new key is unmergeable
without its row.

| Key | Default | What it does |
|---|---|---|
| `enabled` | `true` | `false` = factory OFF: dev/triage/report refuse (scheduled fires exit silently); doctor, prep, board sync and runtime updates keep working. The pause switch — never pause by disabling timers, that is undeclared drift and fails doctor |
| `schedule` | *(from `init`)* | the schedule DECLARATION `{kind, timezone?, modes: {triage/dev/report: {time, days}}}`; `factory.mjs schedule` projects it onto the machine and doctor fails on drift either way. Edit via `schedule --declare`, not by hand |
| `stack` | *(auto-detected)* | main language; picks the allowlist preset injected into every session worktree |
| `allow` | *(unset)* | extra allowlist entries appended to the stack preset — widen when logs show legitimate denials |
| `windowHours` | `4` | length of the daily dev window |
| `maxSessionsPerWindow` | `12` | hard cap on sessions per window |
| `maxTurnsPerSession` | `80` | hard cap on agent turns per session |
| `sessionTimeoutMin` | `45` | wall-clock kill for a hung session |
| `maxSessionTimeoutMin` | `90` | ceiling a plan entry's per-task `timeoutMin` may raise a session's timeout to; a higher value is clamped and logged |
| `autonomy` | `"pr-only"` | who merges PRs. `pr-only`: every task lands as a PR a human merges — the default, and what a new or critical project wants. `auto-merge-dev`: the DRIVER merges factory PRs to `baseBranch` when checks are green (sessions never merge) — for trusted CI and fast iteration |
| `baseBranch` | `"dev"` | branch the agent's PRs target — never your `main` |
| `model` | `"sonnet"` | default session model (also seeds `triageModel`); backlog tasks override via `Model:`/`Effort:`/`Turns:` |
| `effort` | *(unset)* | default reasoning effort; needs Claude Code ≥ 2.x |
| `triageModel` | *(= `model`)* | triage-only model. Planning gates everything downstream, so cheap dev sessions can pair with strong triage |
| `graderModel` | `"opus"` | the acceptance grader's model — deliberately NOT `model`, so the judge does not inherit the implementer's blind spots |
| `mergeGateMinutes` | `10` | how long the gate polls CI before leaving a PR for the sweep (auto-merge only) |
| `gateCommand` | `null` | repo suite the gate runs on the MERGED tree before pushing (e.g. `"npm ci --silent && npm test"`); `null` = rely on CI. With NEITHER, the gate refuses to auto-merge and doctor goes red. It is the merge FLOOR, not verification: a task `Verify:` line that only repeats it proves nothing the gate didn't — doctor's `Verify lines` row and the triage lint flag those; projects with `docs/apis.json` can chain the endpoint lint — see the merge-gate section |
| `gateSuiteTimeoutMin` | `15` | wall-clock bound on `gateCommand`; a timeout counts as a failed suite |
| `riskTiers` | `{"high": []}` | path prefixes (end dirs with `/`) whose PRs always park for owner review. A malformed value FAILS doctor rather than silently disabling the floor |
| `toolchain` | *(unset)* | external tools the window needs, `[{"name": "godot", "check": "godot --version"}]` — one doctor row each, so a missing tool stops the window before it burns sessions. Malformed = doctor fail |
| `noProgressSessions` | `3` | `dev --until-done` only: sessions a task may burn without settling before it parks `needs-human` |
| `gradeFailLimit` | `2` | consecutive genuine graded fails (fresh heads) a task may take before the gate parks it `needs-human` for re-planning instead of writing another retry note. Only fresh verdicts with genuinely failed criteria count: a cached verdict re-read never double-counts |
| `staleRetryDays` | `1` | days a parked (`blocked`/`needs-human`) task waits before its ONE escalated retry on idle window capacity (§Stale-parked retry); `0` disables the lane |
| `staleRetryModel` | `"fable"` | the retry session's model — the escalation IS the point: the task's own pin and the factory default already parked it |
| `logRetentionDays` | `30` | days `<state>/log/` keeps a session's files before `prep` sweeps them. Candidates are exactly the session transcripts (`dev-`/`triage-`/`report-`/`grade-`, with their `.err`/`.mcp*` siblings) and the dated `factory-<day>.log` — never the lock, the state, the doctor record, the tape ledger, a journal, a `gate-suite-*.log` or a quarantine directory — and never a window whose tape the fleet-control collector has not acked, whatever its age. A malformed value FAILS doctor and prunes NOTHING rather than guessing a window |
| `permissionMode` | `"dontAsk"` | keep it; `"bypassPermissions"` only inside a container/VM you could afford to lose |
| `claudeCmd` | `"claude"` | binary to launch; set it when the CLI lives off the scheduler's PATH |
| `forge` | `"github"` | where PRs live: `"github"` (gh CLI) or `"bitbucket"` (Cloud REST) — see §Scheduling → Forge |
| `tracker` | *(the forge's own)* | where needs-human questions + the daily log land: the forge's tracker (legacy value `"github"`), `"jira"`, or `"discord"` |
| `jiraProject` | *(unset)* | Jira project key (e.g. `"FACT"`), required by `tracker: "jira"` and `board: {"jira": true}` |
| `jiraEpic` | *(unset)* | anchor epic key in a SHARED Jira project — everything is created under it and scans never leave it |
| `discordChannel` | *(unset)* | legacy single channel id for `tracker: "discord"`; serves any kind unset in `discordChannels`. The bot must be invited with Message Content intent ON |
| `discordChannels` | *(unset)* | per-type channel ids `{"questions", "activity", "digests"}`: question threads open in `questions`, the daily log in `digests`, FYI notifications post to `activity`. Any unset kind falls back to `discordChannel`, so single-channel configs keep working unchanged |
| `discordTag` | *(unset)* | short factory name prefixed on every thread (`[<tag>] …`) so one channel serves many factories. Hand-set — it is identity, never derived from a path |
| `discordOwnerId` | *(unset)* | the owner's Discord user id — the trust anchor: only this user's replies count as owner answers |
| `discordResolverId` | *(unset)* | the resolver's Discord user id (delegation trust ramp). Inert until `resolverTrust` is `"answer"` |
| `resolverTrust` | `"draft"` | trust tier for resolver replies on question threads: `"draft"` = only owner replies answer (the resolver's post is a proposal the owner oks); `"answer"` = `discordResolverId` replies count as answers. The owner flips this manually; doctor fails a tier-2 config whose resolver id is unset or equals the owner's |
| `board` | *(unset)* | `{"github": true}` for a GitHub Projects board, or `{"jira": true}` for the two-way Jira board |
| `mirrors` | `[]` | `["notion"]` and/or `["jira"]` read-mostly status mirroring — needs tokens in `.env` |
| `notify` | *(unset)* | `{"telegram": true}` for phone notifications — errors/emergencies only; routine traffic rides the Discord tracker's channels (§Monitoring & control) |
| `machineLabel` | `os.hostname()` | short machine name on doctor machine threads (`[zeroone] gh auth — …`); set it where the hostname is not the fleet name |
| `peer` | *(unset)* | peer-channel client for the `ask_peer` tool (§Peer questions); absent = the tool is never registered |

There is no per-dollar cap in Claude Code — `windowHours`,
`maxSessionsPerWindow`, `maxTurnsPerSession` and `sessionTimeoutMin`
together ARE the budget.

**Secrets — `<state>/.env`** (machine-side, the whole file optional). The
driver resolves every key machine→project: it merges
`~/secrets/factory-shared.env` (see § Machine credentials below) under the
project file, and the project file wins per key. There is no second
resolution path — forge/tracker credentials, session env, the dashboard,
and `bb` all read this one merge:

| Key | Needed when |
|---|---|
| `GH_TOKEN` | the factory should act as a different GitHub identity than your `gh` login (e.g. a machine user) |
| `BITBUCKET_EMAIL`, `BITBUCKET_API_TOKEN` | `forge: "bitbucket"` — an Atlassian API token scoped to the factory's repo(s), never a personal full-access one. The basic-auth username is the account EMAIL |
| `ANTHROPIC_API_KEY` | the machine has no logged-in Claude subscription |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | the Jira mirror, `tracker: "jira"`, or `board: {"jira": true}` |
| `DISCORD_BOT_TOKEN` | `tracker: "discord"` — the bot token from the Discord developer portal |
| `NOTION_TOKEN` | the Notion mirror (internal integration token — OAuth does NOT work headless) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | `notify: {"telegram": true}` |

### Machine credentials (`~/secrets/factory-shared.env`)

Creds shared by every factory on a box live in ONE machine file, so
rotating a token edits one file instead of one per project:

- `~/secrets/factory-shared.env` — same KEY=VALUE format as `<state>/.env`,
  file mode 600, `~/secrets` mode 700. The driver auto-merges it under
  every project's `.env` (project wins per key); a missing file is fine —
  all-project mode stays legitimate. Doctor warns on loose perms and on a
  project `.env` key byte-identical to the machine file's (a dead
  duplicate — delete the project copy).
- ONLY `factory-shared.env` auto-loads. Other `~/secrets/<service>.env`
  files are other services' creds a factory session must never see;
  projects opt into those explicitly if they need them.
- Each key gets a row in the machine's secrets registry
  (`docs/secrets.md` in the box's admin repo) in the same change — the
  registry maps secret → env-var names → consumers.
- The Telegram outer net (`~/.factory/notify-fail.sh`) and the Bitbucket
  git helper read this file too. The legacy `~/.factory/telegram.env` and
  `~/.factory/bitbucket.env` homes are retired (hard-migrated 2026-08-18)
  — nothing reads them.

**Bitbucket git transport**: every factory machine on a Bitbucket forge
sets the global `credential.helper` to `~/.factory/bin/git-credential-bitbucket`
— a hand-placed machine artifact (the driver never ships executables into
`~/.factory/bin` silently). Canonical content:

```sh
#!/bin/sh
# git credential helper — Bitbucket over HTTPS from the machine credentials
# file. Install: chmod +x, then
#   git config --global credential.helper "$HOME/.factory/bin/git-credential-bitbucket"
[ "$1" = "get" ] || exit 0
ENV_FILE="$HOME/secrets/factory-shared.env"
[ -f "$ENV_FILE" ] || exit 0
TOKEN=$(sed -n 's/^BITBUCKET_API_TOKEN=//p' "$ENV_FILE" | head -n 1)
[ -n "$TOKEN" ] || exit 0
printf 'username=x-bitbucket-api-token-auth\npassword=%s\n' "$TOKEN"
```

(The basic-auth username for git over HTTPS is the literal
`x-bitbucket-api-token-auth`; the account email is for REST calls only.
Never copy the token value into `~/.git-credentials` or a repo.)

Mac exception (owner decision 2026-08-18): the owner's Mac keeps its
keychain/GitKraken SSH auth for Bitbucket — the helper is for the
factory boxes.

## Peer questions (`config.json → peer`)

Wiring `config.json → peer` gives dev sessions an `ask_peer` MCP tool: ask a
peer agent a blocking question mid-window and wait minutes for the answer,
instead of parking the task at `needs-human` until a human reads it. Absent
config means the tool is never registered and sessions never see it.

**`peer.bin` must be a Node script** — the driver runs it as `node <bin>`, so a
shell wrapper or a compiled binary never executes, and doctor only checks that
the path exists. A wrong kind of bin passes setup and fails at the first
question.

```jsonc
"peer": {
  "enabled": true,
  "bin": "/<path-to>/channel-cli.mjs",   // required: the channel client bin
  "envPrefix": "PEER",                   // env-var prefix the bin reads (default shown)
  "url": "http://127.0.0.1:3071",        // default shown
  "machine": "vps",                      // default: os.hostname()
  "agent": "factory-myproject",          // default: factory-<project> from the state dir
  "role": "peer-question",               // default addressee role
  "defaultBudget": "5m",                 // <n>[s|m|h]
  "maxBudget": "10m",                    // hard clamp on session-supplied budgets
  "maxAsksPerSession": 3                 // runaway cap, driver-side
}
```

**Keep `maxBudget` comfortably under `sessionTimeoutMin`.** The tool BLOCKS the
session while it waits, so a budget outliving the session timeout means the
driver kills the session mid-wait and the answer is lost. Session-supplied
budgets above the max are clamped, never rejected — the ask still happens.

The driver's channel identity (`machine` + `factory-<project>`) must be on the
channel's roster; a missing entry is exit 9 and the tool error says so. Doctor
gets one `peer client` row: skip when unconfigured, fail on a dead `bin` path.
Every other non-zero exit is a tool error naming the session's fall-back, and
sessions lose nothing when it fires — the tool failing IS the pre-channel
behaviour.

## Run until done (`dev --until-done`)

One command chains triage→dev→report cycles — the same three legs a scheduled
day runs, with triage leading each cycle so inbox notes, answered questions and
out-of-band merges fold in before sessions spend anything — and posts a
one-line digest per cycle. Best on `schedule: manual` factories; a
timer-scheduled factory would start competing windows.

The loop ends when the backlog completes or only owner-gated work remains
(`review`, `needs-human` and `blocked` all count as owner-gated), when a `STOP`
file appears (checked between sessions and between cycles), when a window dies
on a fatal error, or when **two consecutive cycles land nothing** — a stuck
loop must never grind paid sessions.

**No-progress breaker** (until-done only): a task that burns
`noProgressSessions` sessions without reaching a settled status is parked
`needs-human` mid-window with a filed question carrying the evidence. A dead
tracker queues the question but never disables the park. Counters live in
`state.json`, survive restarts, and reset the moment the task settles. When the
park leaves nothing actionable the window ends immediately rather than burning
a probe session.

## Stale-parked retry (one escalated look per park)

Sessions believe recorded blockers instead of re-testing them. This lane spends
ONE escalated session re-testing a stale park, on idle capacity only.

- **Trigger** — a window that would otherwise skip, or that ends on a
  `no-tasks` report, runs one retry instead when session budget and window time
  remain. Queued todo work is never displaced; the lane lives outside the plan,
  so triage's "never queue a parked task" rule is untouched. Under
  `--until-done` this is per cycle, so a parked backlog drains one task per
  cycle without looping.
- **Eligibility**, all of which must hold — status `blocked`/`needs-human`;
  parked at least `staleRetryDays` days (a record without the stamp counts as
  old enough); **one retry per park, ever**, with a re-park after owner action
  re-arming it; not claimed by a human's open PR; its linked question, if any,
  still open and unanswered, since an answered question is triage's to fold.
  Oldest park first.
- **Session** — an exit-criteria-only prompt on `staleRetryModel` at effort
  high. **Re-test the recorded blocker FIRST** is the load-bearing instruction.
  Deliverables ride the normal path: same PR flow, same acceptance grader, same
  merge gate and `Gate: human` floor. The retry never hand-flips a parked
  status and never feeds the no-progress or silent-death breakers.
- **Outcome** — stamped in `state.json` and appended on the task as
  `- Retried: <date> <model> — <outcome>: <detail>`, inert to the backlog
  parsers. `recovered` (back in the working pool), `gate-held` (machine half
  delivered, waiting at the owner's gate), or `still-stuck` (blocker confirmed;
  fresh evidence lands as a comment on the existing question thread — no new
  threads, no extra notifications).

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
service, `factory-onfailure@.service`) live in `factory/schedulers/`.

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
- **Forge** (`config.json → forge`, default `"github"`): set `"bitbucket"` for
  a Bitbucket Cloud repo. Needs `curl` on PATH and `BITBUCKET_EMAIL` +
  `BITBUCKET_API_TOKEN` in `<state>/.env` — an Atlassian API token, whose
  basic-auth username for API calls is the account EMAIL, not the Bitbucket
  username. Bitbucket deltas, all by design: the GitHub Projects board needs a
  github forge (the Jira board works on any), merge conflicts surface at the
  gate's local merge because the API has no conflict pre-check, needs-human
  questions file into the repo's native tracker unless Jira or Discord is
  configured, and check-chips read "none" until Pipelines statuses are wired.
  **PR creation always sends `destination` explicitly** — omit it and the API
  opens the PR against the repo's main branch rather than the factory's base,
  which is worth eyeballing on a new Bitbucket factory's FIRST PR. Dashboard
  forge reads cap at 15s and degrade to empty cards, so a slow Bitbucket shows
  a thin dashboard rather than a broken one.

  All session forge access is driver-side by contract: PR creation through the
  `create_pr` MCP tool (called again for a branch whose PR is open, it updates
  that PR instead of leaving pre-rework text standing), the daily log through
  `post_daily_log` (failures queue in state and retry, like questions), and
  triage/report reads through the driver-collected `## Forge inputs` prompt
  section. Every shell-side credential recipe was live-disproven under
  `dontAsk`, so **a session must never fall back to shelling out with keys**.

  **A Bitbucket repo ships with its issue tracker OFF**, and the API then
  answers 410 Gone on `/issues` while every PR call keeps working — so
  needs-human questions queue silently. Doctor probes the native tracker
  and WARNS on that (enable the tracker, or set `tracker: "jira"` or
  `"discord"`). It warns
  rather than fails on purpose: doctor is also the `--scheduled` preflight,
  so a fail row aborts EVERY timer-fired window — dev and report included,
  not just the filings that would vanish. A factory whose tracker is off is
  degraded, not misconfigured: the pilot window that exposed this shipped
  T-001 with its tracker off, and failing the preflight would have cost
  that work to protect two questions about tooling.
  The queue itself is never lost — a filing that throws goes to
  `state.pendingQuestions` and retries at the next session end. Its
  visibility is the driver's job, not doctor's: a session end that leaves
  questions stranded logs and Telegrams the count and titles
  (`⚠ N question(s) could not be filed …`) — announced when the stuck SET
  changes, not on every retry (a permanently dead tracker used to produce
  an unbounded stream of identical warnings; the retry stays unbounded,
  only the announcement dedupes). That announcement is the
  load-bearing half — warning without it recreates the original silent-loss
  bug, which is exactly how the pilot lost two real diagnoses.
  Non-native trackers also get a doctor `tracker reachability` row (warn,
  never fail): authCheck proves credentials, not that filings can land.
- **Tracker** (`config.json → tracker`, default the forge's own tracker;
  the legacy value `"github"` means the same): set `"jira"` to route
  needs-human questions and the `[factory] daily log` to a Jira Cloud
  project instead — for repos whose native tracker is off (the common
  Bitbucket-Cloud-plus-Jira shape: issues disabled on the repo, planning
  lives in Jira). Also needs `"jiraProject": "<KEY>"` in `config.json` and
  `JIRA_BASE_URL` + `JIRA_EMAIL` + `JIRA_API_TOKEN` in `<state>/.env`
  (Atlassian API token, same three keys as the Jira report mirror);
  doctor checks the keys and live-probes the auth. The driver files
  questions there (issue type Task), triage reads answers there (close
  the Jira issue with an answer, as on GitHub), and the dashboard's
  needs-human pill and daily-log link follow. PRs stay on the forge
  either way. In a SHARED Jira project, `"jiraEpic": "<KEY>"` anchors
  everything under one epic — tracker issues are created as its children
  and scans never leave it (see the Jira board bullet below).
- **Discord tracker** (`"tracker": "discord"`): questions and the daily log land
  as THREADS in a Discord channel — for owners who answer in chat, not
  in any issue tracker (born 2026-07-27, when Jira was ruled out for a
  client's scrum-shared projects). Needs a channel (`"discordChannel":
  "<id>"`, or the per-type split `"discordChannels": {"questions",
  "activity", "digests"}` — question threads in `questions`, the daily
  log in `digests`, FYI posts to `activity`; unset kinds fall back to
  `discordChannel`) +
  `"discordTag": "<short-name>"` + `"discordOwnerId": "<user id>"` in
  `config.json` and `DISCORD_BOT_TOKEN` in `<state>/.env` (bot invited
  with View Channel / Send Messages / Send Messages in Threads / Create
  Public Threads / Read Message History / Manage Threads; Message
  Content intent ON in the developer portal). `discordOwnerId` is the
  OWNER's user id (developer mode → right-click your name → Copy User
  ID) and is the trust anchor: the driver authenticates as the bot here
  — unlike every other tracker — so the owner's identity must be
  declared or every answer would read UNTRUSTED and could never fold.
  Every thread the factory creates is named `[<discordTag>] …` and reads
  are scoped to that prefix, so several factories share one channel; the
  tag is hand-set because it is identity — never derive it from a path.
  The answer flow has NO owner ceremony: the owner just replies in the
  question thread. A reply FROM THE OWNER after the bot's last `✔`
  marker makes the thread ANSWERED (surfaces to triage as a closed
  tracker issue; teammates' comments are context, never the answer —
  and a resolver's reply counts only under `resolverTrust: "answer"`,
  the delegation trust ramp's tier 2).
  After that triage succeeds the driver posts `✔ folded into the
  backlog` and archives the thread — only threads whose owner answer
  actually rendered in the triage prompt are acked, so a failed comment
  fetch can never archive an unread answer. Replying to an archived
  thread reopens it. An unanswered question that hit Discord's
  auto-archive timer still counts as OPEN.
  Doctor checks the token, the config keys, and live-probes the bot plus
  every distinct configured channel.
  Human-initiated threads are NOT captured as work input (the channel is
  shared; inbox/backlog stay the input paths). PRs stay on the forge.

## Feeding it input (any time)

- **GitHub** (canonical): file issues; comment on `[factory]` PRs; answer
  `needs-human` issues and close them. Next triage folds everything in.
  On a `tracker: "jira"` factory the same loop runs in the Jira project:
  answer `[factory] question:` issues there and resolve them. On a
  `tracker: "discord"` factory, just REPLY in the question thread —
  no closing, no emoji; the factory marks `✔` once it folded the answer.
- **Notion / Jira mirrors**: enable in `config.json → mirrors` + tokens in
  `<state>/.env`. Notion needs the official Notion MCP server in the project's
  `.mcp.json` with `NOTION_TOKEN` (internal integration token — OAuth does
  NOT work headless). Jira uses plain REST with an API token.
- **Zero-dependency fallback**: drop a markdown note in `.factory/inbox/`,
  then **commit and push it to the base branch**. Triage runs in the driver's
  meta worktree, reset to `origin/<baseBranch>` at every boundary — an
  uncommitted note is not late, it is simply not input, and the next dirty-tree
  sweep quarantines it out of your checkout. Triage reads every top-level
  `*.md` there and authors ONE backlog task per note, or parks it at
  `needs-human` with the question it could not answer alone (the completeness
  bar is the `code4food-factory:tickets` skill); processed notes move to
  `.factory/inbox/processed/`. Notes are the only input triage tickets itself —
  tracker issues and PR comments still surface in the daily log for a live
  session. Doctor's `work data committed` row warns when your checkout holds
  uncommitted files under `.factory/{spec,backlog,inbox}`, which is exactly
  the drop-and-forget shape.
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
  the next sync captures it into `.factory/inbox/board-delta.md`, which
  triage tickets like any inbox note (the card is archived — a proper task
  card replaces it once triaged); drag a card against factory state and
  the move is recorded for triage to judge while the factory's status is
  restored (factory wins on status, humans win on new work and priority).
  Full design: `specs/github-projects-sync.md`.
- **Jira board** (opt-in, two-way — the Jira twin of the Projects board,
  works on ANY forge): set `"board": {"jira": true}` + `"jiraProject"`
  (and `JIRA_*` keys in `<state>/.env`, same as the tracker), then run
  `sync-board --init` — it maps the backlog status vocabulary onto the
  project's REAL workflow columns by name (loudly listing unmapped ones;
  add columns in Jira's UI and re-run --init to pick them up — the driver
  never edits workflows) and caches the map in `<state>/jira-board.json`.
  Task cards are plain Task issues (`T-xxx — title`, labels
  `factory-task` + `epic:<name>`), moved via real workflow transitions at
  the same sync points as the GitHub board. Inbound works the same too:
  a human-filed issue in scope is captured into
  `.factory/inbox/board-delta.md` and labeled `factory-captured` (Jira
  issues are NEVER deleted — triage closes the original with a comment
  naming the new task); a dragged card is reported after two consecutive
  sightings and the factory's status restored. Pruned tasks get
  `factory-archived`. **Shared Jira project?** Set `"jiraEpic": "<KEY>"`
  and the factory stays inside that epic: every card and tracker issue is
  created under it and every scan is scoped to its children — the rest of
  the project is invisible to the factory. (One anchor epic for now;
  mapping backlog epics onto multiple Jira epics is deliberately
  deferred.)

## Monitoring & control

- **Dashboard** — live web UI over every factory on the machine:
  `node ~/.factory/runtime/factory/driver/dashboard.mjs` → http://localhost:7788.
  Per factory: status, declared-state chips, config, the backlog table with
  PR/issue links, last-session summary, driver log tail, and spend from
  `<state>/log/usage.jsonl`. While a window runs, rows go live — a component
  chip names the active phase and the detail panel shows the running session's
  turn count and last event with its age. Parse trouble degrades to a ⚠ badge:
  **boundary-written state files stay authoritative wherever they disagree at
  rest**, so a live row is a reading, never the record. The header shows the
  runtime's version currency, which is how you notice a machine is behind.
  **Config**: `~/.factory/dashboard.json` (`{port, listen, token}`, all
  optional); CLI flags override it. `"listen": "tailscale"` resolves the tailnet
  IPv4 at startup; it binds 127.0.0.1 by default. Factories register in
  `~/.factory/registry.json` at init.
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
  --project <path>`: a read-only checklist of everything that has actually
  broken a night once — `claude`/`gh` on the current AND the systemd unit's
  PATH, workspace trust, the allowlist, runtime health, `.env` keys for enabled
  features, gh auth scopes, tracker reachability, milestone headings that no
  longer parse, timers and linger, docker where compose exists, plan freshness,
  the git contract (a still-tracked legacy `config.json` or `.env` FAILS with
  the migrate hint), backlog parseability, Verify-line tiers and acceptance
  wording, and CI-or-`gateCommand` under auto-merge. Exit 1 on problems.
  **Run it after ANY infra change** — new machine, runtime deploy, token
  rotation, scheduler edit, feature enable. It is cheaper than losing a window.
  Warnings are not failures: a disabled factory is a legitimate state and
  doctors GREEN with its timer checks skipped.
  Every run — this command, the `--scheduled` preflight, `prep` and the fleet
  watchdog — records its verdict at `<state>/log/doctor.json`, freshest run
  wins. A project with no record has never been checked, which is not a pass:
  the dashboard tile and the fleet publisher's machine row both read it there.
  Scheduler entries pass `--scheduled`, which runs the same checks as a
  preflight and aborts + Telegrams rather than half-running. On Discord-tracker
  factories the preflight also files ONE `[<machine>] <fact>` thread per
  machine-scoped red row — instead of N tasks parking on the same dead token —
  and the next green run for that fact ✔-closes the thread with the probe as
  evidence. State lives in `~/.factory/machine-threads.json`, machine-level, so
  every factory on a box converges on one thread per fact.
- **Deploy** — `node ~/.factory/runtime/factory/driver/deploy-runtime.mjs`
  after merging driver/prompt changes: one command per machine advances the
  fleet, gated on syntax + every factory's doctor (see "Setup: the
  runtime"). The `OnFailure=factory-onfailure@…` units are the dumb outer
  net: if a factory unit fails in ANY way — even a runtime too broken to
  send its own Telegram — `~/.factory/notify-fail.sh` (plain sh + curl,
  creds in `~/secrets/factory-shared.env`) still reaches the phone.
- **Fleet watchdog** (item 26): `factory/driver/watchdog.mjs` + the
  `factory-watchdog.timer` template — one timer per MACHINE that runs every
  registered factory's doctor daily, writes `<state>/log/doctor.json`
  (`fails` AND `warns` — the dashboard tile shows warnings distinctly from
  failures), and Telegrams a summary when anything FAILS; warnings stay off
  Telegram by design (owner ruling 2026-08-06). A dead
  factory gets noticed by machinery within a day, not by you wondering why
  there were no PRs.
- **Fleet supervisor** (PR-D, Layer 1): `factory/driver/supervisor.mjs` —
  one daemon per MACHINE, kept alive by the OS (`supervisor.mjs install`
  writes a systemd `Restart=always` unit or a launchd `KeepAlive` agent; an
  OS restart is the fix for "the relauncher died silently"). Every 60s it
  rebuilds its whole picture from disk (registry + each factory's
  `window.lock` + journals), so restarts lose nothing. Four duties:
  1. **Out-of-band wall-clock kill of hung runs** — the driver's own
     timeouts share its event loop, so a stalled sync git/gh call hangs the
     watchdog with the watched (the 2026-07-11 4.5h hang). A live lock past
     its bound (dev: `windowEndsAt` + a config-derived finalization budget —
     `max(sessionTimeoutMin, maxSessionTimeoutMin)` for a last dev session
     that may be running under a plan's raised timeout, + 2× sessionTimeout
     + 2× merge-gate + 30min slack, sized for that session plus its grader
     plus one sweep grader. Once `graderStartedAt` is stamped the bound
     RE-BASES onto it — `graderStartedAt` + sessionTimeout + merge-gate +
     30min — because the stamp proves the dev session already finished, so a
     long sweep is not killed for the dev session's budget;
     triage/report/prep: `startedAt` + sessionTimeout + 30min) gets its full process tree
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
  3. **Stuck-factory detection** (item 50 chunk 2) — the OnFailure net pings
     on every unit failure but cannot tell a blip from a factory wedged for
     days. A scheduled, enabled factory whose last 2 dev windows each aborted
     before doing anything — no `session` step (a session ran, even if it
     died) and no `window-skipped` step (a clean idle: waiting-on-owner /
     deadlocked / backlog-complete / no-eligible-tasks) — is STUCK, not idle,
     and escalates once per streak as `factory-stuck`. Dev windows are the
     only mode that writes `journal-*.jsonl`, and the filename is the
     window-start time, so windows order correctly even when a later run's
     finalize-replay bumps an old journal's mtime.
  4. **Escalations outbox** — appends structured records to
     `~/.factory/escalations.jsonl` (the machine/human interface — format in
     §Escalations outbox below) and pings Telegram best-effort
     (`~/secrets/factory-shared.env`, else any factory's `.env`). Each cause
     escalates exactly once (dedupe in `~/.factory/supervisor/state.json`).
- **Open the next milestone**:
  `node ~/.factory/runtime/factory/driver/factory.mjs promote M3 --project <p>`
  flips that milestone to `active` in `backlog/index.md` and commits it as the
  driver, so no hand-edited PR trips the merge gate's code-only warning.
  Every other heading reading `active` is closed in the same commit — `done`
  if its epics hold no unfinished task, `gated` if they do — so exactly one
  milestone is open for work and the success line names each displacement by
  id and new status (ADR-0018). The verb is idempotent and refuses
  `done`/unknown milestones and a live window; triage can ask for the same
  flip itself, which the driver applies at session end.
- `<state>/log/dev-*.out` — full session transcripts. `prep` sweeps these past
  `logRetentionDays`; until then nothing ever deleted them, and a fleet box had
  reached 366 MB of them. **`prep` is the only thing that sweeps**, and it is a
  repair verb — a box nobody runs it on still grows.
- `<state>/log/window.lock` — the live window's claim. A lock left by a crash
  carries a dead pid, which every reader treats as stale: the fix for a stuck
  window is to run the next one, not to delete the file.
- `<state>/log/journal-<window-ts>.jsonl` — one line per driver step. A window
  that died mid-finalization is completed by the next `dev` or `prep` run.
- `<state>/log/usage.jsonl` — the spend ledger, one row per session.
- `<state>/log/metrics.jsonl` — one row per session for plan correction and the
  no-progress breaker.
- `[factory] daily log` on the tracker (issue, Jira item, or Discord
  thread) — plan of day + window reports.
- **Stop**: `touch <state>/STOP` (finishes current session, then exits);
  remove the file to allow the next window. Emergency: kill the driver
  process — next session recovers from HANDOFF/git state.
- **Prep** (after YOU worked in the factory checkout):
  `node ~/.factory/runtime/factory/driver/factory.mjs prep --project <p>` — quarantines anything
  uncommitted (copied to `<state>/log/quarantine-<ts>/` and stashed;
  `git stash pop` to take it back), returns the tree to the base branch at
  origin tip, pushes unpushed commits, drains pending status flips, gives
  leftover green factory PRs one gate pass, sweeps session logs past
  `logRetentionDays`, ends with a doctor summary.
  Zero sessions, zero cost. This is a REPAIR verb, not a required handoff:
  the driver never touches your checkout on its own, so you only need prep when
  you've left the checkout dirty or diverged and want it back to a known-good
  base.
- **Owner notifications** — two lanes: **Telegram carries errors and
  emergencies only** — aborts, dirty-tree quarantines, base divergence,
  doctor-red refusals, alert-status sessions (blocked/timeout/died/
  spawn-failed), unpostable questions/daily-logs, unrecoverable repos,
  until-done stuck. Routine owner traffic posts to the Discord tracker's
  per-type channels instead: merges, review requests, and parks to the
  `activity` channel, the until-done cycle digest to `digests`
  (tag-prefixed plain messages; falls back to the Telegram lane when no
  posting tracker is configured, so nothing goes silent). The emergency
  lane has the mirror-image floor: a KEEP message whose Telegram send
  FAILS is also posted to the tracker's questions channel when the
  tracker can post, and outside factories (supervisor, watchdog,
  deploy-runtime) a failed send is retried exactly once. Window
  start/end/skip pings and routine ✔ session pings are GONE — the daily
  log and cycle digest carry that. Telegram setup (opt-in):
  1. Create a bot: message [@BotFather](https://t.me/BotFather) → `/newbot`
     → copy the token.
  2. Get your chat id: send the bot any message, then open
     `https://api.telegram.org/bot<token>/getUpdates` and read
     `message.chat.id`.
  3. Put both in `~/secrets/factory-shared.env` (§ Machine credentials):
     `TELEGRAM_BOT_TOKEN=…`, `TELEGRAM_CHAT_ID=…`, and enable in
     `config.json`: `"notify": {"telegram": true}`.
  One bot serves all factories — messages are prefixed `[<factory-name>]`.
  Notification failures are logged and never affect the run.
- **Budget**: spend ≈ sessions × turns. Caps: `windowHours`,
  `maxSessionsPerWindow`, `maxTurnsPerSession`, `sessionTimeoutMin`. There is
  no per-session dollar cap in Claude Code — these four ARE the budget.
  A session that hits the turn cap mid-wrap-up is logged `turn-capped`, not
  `died` — it doesn't arm the two-deaths breaker, and the driver injects a
  repo snapshot into the next session's prompt so it lands the leftovers
  instead of re-discovering them. The capped task is also stamped
  `in-progress` in the runtime state, so even when the window ends right
  there (the prompt note is in-memory) the next window's state overlay
  still names the unfinished task.

  **Landing reserve (T-008).** A dev session's CLI is spawned with its granted
  budget PLUS a fixed reserve of 10 turns, while the prompt states the
  unpadded granted number — so the closing acts (`create_pr`, then
  `report_status`) survive a session that spends its whole stated budget. The
  reserve is a constant in the driver, deliberately not configurable, and
  deliberately not disclosed to the session: a stated budget is a budget, and
  a session told about the reserve would spend it. Dev lane only, the
  stale-parked retry lane included — triage, grade and report have no PR-and-
  report endgame to forfeit. `maxTurnsPerSession` therefore describes what a
  session is told it has, not the cap the CLI enforces.
- **`wait-forfeit`: a session that ended a turn waiting on a background
  task.** A session that backgrounds a long command (the gate suite, a
  subagent) and then ends its turn on prose is betting on a re-entry it may
  not get. Background completions DO re-enter a `claude -p` session as a new
  run — but only while the task is still pending when the turn ends. Lose
  that race and the run ends for good: the CLI exits 0, the `.out` carries a
  clean `success` result, and without this class the driver bookkeeps a
  ~$3.50 death as an ordinary one. Measured on dev-skills 2026-08-04: two
  sessions, ~$7.10.

  **Both fix shapes were taken, because either alone is unsound.** The
  prompt rule (`FOREGROUND_RULE` in the driver — one source, appended to the
  three lanes that run long commands: the dev lane, the stale-parked retry
  lane and the acceptance grader, which re-runs the task's own `Verify`
  command) is prevention only: it is
  advisory, a session can and did ignore it, and asserting a sentence exists
  in a prompt proves nothing about the failure. The driver-side
  classification is detection only: it names a class that has already cost
  the money. Prevention without detection goes silently unenforced;
  detection without prevention pays for the same lesson every window.

  The detection is `classifySessionEnd` → `wait-forfeit`, for a **non-capped
  clean `success`** whose **last assistant turn called no tool** while a
  **background task it started was still open**. All three clauses carry
  weight: the turn cap is checked first (that is `turn-capped`, T-008's
  class, and it too can leave tasks open), `is_error` keeps a mid-response
  API failure in `errored`, and the open task — not the closing prose — is
  what separates a forfeit from an ordinary text wrap-up, which also ends on
  text. The openness is read from the CLI's `system` background-task events
  (`task_started`, then `task_updated`/`task_notification` with a terminal
  status) **snapshotted at each `result` event, never at end of file**: the
  CLI kills surviving tasks AFTER its final result, so end-of-file state
  reads every forfeit as cleanly closed. The window log line and the ⚠
  alert name the class and point at the quarantine directory holding the
  session's uncommitted work.

  Task handling is deliberately unchanged: a wait-forfeit is still a
  reportless death, so the task stays re-assignable next window. This is a
  name for a class, not a new retry lane.

### Escalations outbox

`~/.factory/escalations.jsonl` is the machine's append-only outbox of things
only the owner can clear. The supervisor writes it; any owner-facing monitor
consumes it. This file IS the interface between the machine and the human
— change it only additively, and update this section in the same PR.

#### Record format

One JSON object per line:

```json
{
  "ts": "2026-07-12T03:14:15.000Z",
  "machine": "myhost.local",
  "project": "/path/to/myproject",
  "name": "myproject",
  "type": "hung-window-killed",
  "detail": "dev run (started 2026-07-11T22:00:00Z, session 3) hung 190min past its bound — killed its process tree and ran prep"
}
```

- `ts` — when the supervisor escalated (ISO-8601 UTC).
- `machine` — `os.hostname()` of the machine that wrote it. Consumers merge
  outboxes from several machines; this is the disambiguator.
- `project` — absolute project path on that machine (the registry key).
- `name` — the factory's human name (registry `name`, falls back to the
  path basename). Use this when talking to the owner.
- `type` — closed set, see below. Consumers must tolerate unknown types
  (render them generically) so the set can grow additively.
- `detail` — one human-readable sentence with the facts and, where useful,
  the machine-side path to look at. Free text; never parse it.

#### Types

| type | meaning | what the owner does |
|---|---|---|
| `hung-window-killed` | a driver run sat past its wall-clock bound; the supervisor killed its tree and ran `prep` | usually nothing — relaunch if the window's work matters tonight |
| `hung-window-unkillable` | a lock pid is past its bound but is not a factory driver (pid recycling) or survived SIGKILL | inspect the machine, clear the lock file named in `detail` |
| `waiting-on-owner` | a relaunch directive stopped because the window skipped: every open task needs the owner (PR-C derived status) | answer the open questions / clear the gated tasks |
| `deadlocked` | same stop, but every open task is dependency-blocked — nothing even the owner is asked to clear | untangle the backlog dependencies |
| `relaunch-failed` | two consecutive relaunched dev runs ended without running a session | check the driver log dir named in `detail` |
| `factory-stuck` | N consecutive dev windows aborted before running a session and did not cleanly skip — wedged, not idle | check the machine-side `log/` dir named in `detail` |

#### Semantics

- **Append-only.** The supervisor never rewrites or truncates the file.
  Consumers track their own read offset (byte offset or last-seen `ts`);
  there is no ack field — acknowledgement is a consumer-side concern.
- **Escalate-once.** Each cause escalates exactly once (dedupe keys live in
  `~/.factory/supervisor/state.json`); a NEW instance of the same problem
  (a new hang, a new skip) escalates again. Consumers may still see
  duplicates across machines and should key on `(machine, ts, project,
  type)`.
- **Telegram is the fallback, the file is the record.** The supervisor also
  pings Telegram (machine creds `~/secrets/factory-shared.env`, else any
  registered factory's `.env`) but a failed ping never blocks the outbox
  write.

### Traps worth not relearning

- **Never wrap a window launch in a retry-until-success loop** — a trailing
  command exiting nonzero re-runs the block and spawns duplicate drivers (three
  for one project, once). Launch once, verify separately.
- **Don't `pkill -f <project>` over ssh** — the remote command line contains the
  pattern, so it kills your own shell. Kill by node pid instead.
- **A `/model` switch in an interactive session kills that session's background
  children** (dev windows, a dashboard launched from it). Relaunch them after.
- **GitHub API timeouts** (`gh pr view failed`, `meta: fetch failed — using
  local refs`) self-heal via the window-end sweep or the next session. Only act
  if PRs pile up unmerged.
- **Send request bodies from a FILE, never inline.** A curl with an inline
  multi-line `--data '{...}'` ate the first live pilot's PR — the operator
  opened PR #1 by hand. Every prompt recipe that sends a body writes it to
  `.factory/tmp/<name>.json` with the Write tool and passes `--data @<file>` on
  one line; write new recipes the same way. The mechanism is narrower than the
  old "multi-line is denied outright" lore: plain multi-line commands pass the
  `dontAsk` matcher, and the shape that actually failed — `$VAR` + pipe +
  multi-line — was lifted on 2.1.220. The file-backed recipe is kept because it
  works on every version.

## Dashboard

The dashboard is one monitor among several — the product ships the interface,
not the monitor — so this is only what its own `--help` cannot tell you.

Run it when you want to look:
`node <runtime>/factory/driver/dashboard.mjs --token <secret>` →
`http://localhost:7788/?token=<secret>`. For an always-on box, put
`{ "listen": "tailscale", "token": "<secret>" }` in `~/.factory/dashboard.json`,
`chmod 600` it (the token stays out of `ps`-visible argv), and install
`schedulers/factory-dashboard.service`.

**Never bind it to `0.0.0.0` on a public box.** The state includes project
paths, task titles and spend, and the dashboard never terminates TLS. Auth is
network-level: binding the tailnet interface IS the authentication, and the
token is defence in depth inside it.

Behind a reverse proxy, set `"listen": "127.0.0.1"` so the proxy is the only
thing that can reach it, and note two things no proxy config guesses: the page
uses absolute paths (`/api/state`, `/api/run`, `/log`), so it needs a host root
rather than a `/dashboard/*` subpath, which would 404 every API call; and it
polls rather than streaming, so no websocket upgrade config is needed. The
`?token=` query and `Authorization: Bearer` header pass through untouched.

## Windows

Windows is NOT a supported factory host: the supervisor has no Windows
keep-alive, scheduled-task install is not automated or doctor-verified,
and the `notify-fail` outer net is POSIX-only — run factories on macOS or
Linux. Windows machines are fully supported for everything else: the
skillset (statusline and hooks are plain Node), interactive Claude Code
sessions, and piloting a factory repo as a live session (the piloting
contract is host-agnostic — branch, push, converge at origin).
