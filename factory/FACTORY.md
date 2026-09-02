# Factory — autonomous spec-driven development

Claude Code develops a fully-specced product alone in daily windows: fresh
headless session per task, state carried in files, humans feed input async.
Portable: the same driver runs on macOS and Linux/VPS. Windows is not a
supported factory host (Windows machines still use the skillset and pilot
factory repos as live sessions — see "Windows" at the end of this file).

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

- **State lives in files**, not conversations: `.factory/backlog/` (what to
  do, and — on a task's `Notes:` — where the last session stopped), plus the
  project's own `CONTEXT.md` and `docs/adr/` for what the code cannot tell you.
  `CONTEXT.md`'s glossary entries carry the synonyms to avoid (`_Avoid_: …`)
  so agent-written text converges on one vocabulary instead of drifting; a
  change that contradicts an ADR says so explicitly rather than silently
  overriding.
  Every session starts cold and reads them — no compaction roulette. A task and
  a handoff are one object at two stages of its life, so mid-task state is
  written back onto the task rather than into a file beside it: a separate file
  forks the state, and only one fork is pickable by the next window.
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
  doctor gate). Nothing driver-shaped is copied into projects; the session
  allowlist + guard hook are INJECTED into each session worktree at spawn
  from the runtime (never committed), and skills come from the
  machine-installed code4food plugins, provisioned from the runtime clone
  by deploy-runtime (versions match the runtime — doctor checks it).
- **Humans are async**: the agent never waits. Sessions ask questions via the
  `open_question` MCP tool; the DRIVER dedupes them and files/updates the
  `needs-human` items on the configured tracker itself (forge issues, Jira,
  or Discord threads); answers get folded in by the next triage. Dedupe is
  by normalized title AND — for a question carrying a `taskId` — by the open
  thread already filed for that task (recorded in `state.questionThreads`,
  keyed by thread url): **one task, one open thread**, because each session
  inheriting a stuck task re-states the same blocker in new wording that no
  title match can catch. A later question about that task comments on its
  thread instead of opening another — led by its own ask, since on that
  lane the wording differs from the thread's title by construction. A
  CLOSED/answered thread suppresses nothing — the question recurred, or
  the answer didn't take. A question a session filed WITHOUT a `taskId`
  while reporting `blocked` is attributed to the task it reported blocked
  on: the tool's field is optional and sessions drop it, and an untied
  question parks nothing — the task would land at `blocked`, which triage
  re-opens, while the owner's answer sits on a thread no task links to.
  Only `blocked` triggers the attribution; a question from a session that
  settled its task stays as general as the session left it.

## Architecture & contracts

The contracts every factory honors, stated once. Everything else in this
file is operations; on conflict with any other doc, memory, or comment,
THIS section and the driver source win. A PR that changes a contract
updates this section in the same PR.

### The three layers

1. **Driver** (`factory.mjs`) — runs windows: spawns sessions, enforces
   caps, gates merges, self-heals inside the window (breakers, turn-cap
   handoffs, needs-human issues).
2. **Supervisor** (`supervisor.mjs`) — machine daemon, one per machine:
   kills hung runs past their wall-clock bound (then `prep`s), executes
   owner-directed relaunches, writes the escalations outbox. Read-only
   otherwise.
3. **Monitor** — any owner-facing consumer: Eva, another agent, a live
   session, or a human on the dashboard. Optional, replaceable, defined by
   the monitor contract below — the product ships the interface, not the
   monitor.

### The fleet publisher (machine daemon)

`factory/driver/fleet-publisher.mjs` is the machine's second daemon beside
the supervisor, deliberately its own process (fleet-control ADR-0005: the
supervisor's hang path blocks its own event loop for minutes, and a
publisher that goes silent whenever the supervisor is busy makes the whole
fleet surface lie). It holds ONE outbound WebSocket to the fleet-control
collector, beats the machine inventory every 60s
(`fleet-inventory.mjs`) and sends one full snapshot per claimed project
(`fleet-snapshot.mjs`); every wire shape is written in `fleet-wire.mjs`
and nowhere else.

- **Config**: identity and collector URL from the machine-shared env file
  (`~/secrets/factory-shared.env`: `FLEET_MACHINE_ID` — explicit, never a
  hostname derivation — and `FLEET_CONTROL_URL`). The credential lives
  apart per the secrets discipline (`~/secrets/fleet-publisher.env`:
  `FLEET_PUBLISHER_SECRET`) and travels only as a bearer header.
- **Install** (T-062): `fleet-publisher.mjs install [--yes]` — the unit is
  generated beside the supervisor's in `schedule.mjs`
  (`generatePublisherUnits`) and installed through the same installer
  (`unit-install.mjs`), as `factory-fleet-publisher.service`: a
  machine-level unit belonging to no project, `Restart=always` under an
  explicit start limit with the `factory-onfailure@` companion, enabled at
  boot. **systemd hosts only** — the fleet-control spec (Further Notes)
  ships no launchd branch; a non-enrolled machine drives a collector
  attended with a throwaway id (`--once` / foreground), never an installed
  daemon.
- **Failure posture** (fleet-control D-009): unreachability retries
  forever with capped backoff and never exits — a collector restarting
  under its own pull-deploy is normal. Credential rejection sustained past
  the configured window exits non-zero; the exit loops into the unit's
  start limit and the OnFailure companion pages the owner — rejection is
  the one failure invisible to both systemd and the board, so it must die
  loudly.
- **Enrollment is attended**: place the env values and the credential
  BEFORE `install` (a daemon installed with no config exits repeatedly and
  pages). The enrolled-machine id list is fleet metadata (`~/matrix`
  `machines.json`, ids only); each machine's secret is placed in that
  machine's own secret location, and the collector receives the list
  through its deploy environment on its host — no repo ever holds a
  secret.

### The origin-rendezvous invariant

**Origin is the rendezvous point.** Factory sessions start from
`origin/<base>` in throwaway worktrees under `~/.factory/worktrees/` —
never from local state. Work (owner's or a monitor's) becomes visible to
the factory, to other machines, and to other sessions only when pushed.
This is what makes live sessions, multi-machine use, and every repo type
(Unity, Godot, mobile, web) work with ONE rule: branch → push/PR →
converge at origin. The branching strategy never requires worktrees of the
owner, so no engine restriction (e.g. Unity's one-path pin) breaks it.

### Piloting contract (owner live sessions)

Live sessions in a factory repo are first-class, any time — the factory is
built to interleave with them:

- **The checkout is the owner's.** The driver never flips its branch and
  never quarantines WIP. The one thing it does: fast-forward the checkout
  when it is clean AND on base AND strictly behind origin (keeps walk-up
  reads fresh). `prep` is the explicit repair verb for a dirty checkout —
  it is NOT a required handoff step.
- Work on a branch; a sibling worktree is optional owner convenience where
  the toolchain tolerates it (never for Unity — editor pins one path).
- **Claim a backlog task before piloting it: open a DRAFT pull request
  with the task id in the title** (e.g. `T-023: add invoice export`;
  branch name is free, works on both forges). While the PR is open the
  factory skips the task (plan routing + a Claimed-tasks prompt section)
  and its merge sweep never touches drafts; other pilots route around it
  the same way. The claim holds through "ready for review" until the PR
  merges or closes — your `Status:` flip rides the PR and only lands at
  merge, so the open PR is what stops a nightly window duplicating your
  finished-but-unreviewed work. The convention ships in-repo as
  `.factory/README.md` (init stamps it, migrate heals it, doctor warns
  when missing), so teammates without the skillset learn it by opening
  the directory.
- **End every live session pushed** (merged or as a PR). Unpushed work is
  invisible to the factory and to your other machines.
- **Bitbucket repos: use `bb`** — the runtime ships a gh-style PR CLI
  (`factory/driver/bb.mjs`, symlinked onto PATH at machine setup):
  `bb pr create|list|view|merge|comment`, `bb` alone for usage. It reuses
  the driver's forge adapter and resolves credentials machine→project
  (`~/secrets/factory-shared.env` under the registered factory's state
  `.env`), so live sessions never touch tokens or curl
  (session credential forms are proven dead on Bitbucket). `pr create`
  defaults the destination to the factory's `baseBranch` and always sends
  it explicitly. Non-factory Bitbucket repos work too, via
  `BITBUCKET_EMAIL` + `BITBUCKET_API_TOKEN` in the environment.
- **Update the `Status:` lines of tasks you shipped** as part of what you
  merge — your own tasks only, never index counts or other tasks' lines —
  so triage doesn't re-discover work you already did, and any number of
  live devs can pilot the repo before a factory window without colliding
  (disjoint lines converge at origin; see the `backlog` skill §Status).
- Two factories (two machines) on one project: safe when time-shifted,
  because state converges at origin. Concurrent windows on the same
  project are NOT coordinated — don't schedule them to overlap.

### Monitor contract

A monitor consumes the read surfaces and acts only through the sanctioned
act surfaces:

- **Read** (what → status → why → work-product):
  `~/.factory/escalations.jsonl` (the outbox — format in §Escalations
  outbox below; transport across machines is the consumer's concern) → dashboard `GET /api/state` / `GET /api/log` → session logs
  `<state>/log/dev-*.out` → `gh` (PRs, checks, issues).
- **Act**, in escalating order: gh-level (answer needs-human issues,
  comment, merge green PRs *if authorized*) → repo-level fixes on its OWN
  branches pushed to origin (a monitor is just another live session — the
  piloting contract applies) → control-plane (dashboard `POST
  run/stop/resume/enabled`, `<state>/STOP`) → escalate to the human.
- **Never**: enter `~/.factory/worktrees/` (the window's territory), kill
  processes (the supervisor's job — it does it safely and `prep`s after),
  or edit `<state>` internals directly.
- What a monitor may merge is an owner decision per factory, not a
  product default.

### Escalations outbox (the Layer-3 contract)

`~/.factory/escalations.jsonl` is the machine's append-only outbox of things
only the owner can clear. The fleet supervisor
(`factory/driver/supervisor.mjs`) writes it; Layer 3 — any owner-facing monitor — consumes it. This file IS the interface between the
machine layers and the human layer — change it only additively, and update
this doc in the same PR.

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
  pings Telegram (machine creds `~/.factory/telegram.env`, else any
  factory's `.env`) but a failed ping never blocks the outbox write.

### Verification & review contract (two profiles)

Verification guidance ships as TWO deliberately separate skills, one per
session context — never merge them, never cross-load them:

- **Factory windows** verify via `code4food-factory:verify` (headless
  recipes, factory escalation vocabulary: `open_question`, `Gate: human`)
  and then run ONE mandatory `code4food-factory:code-review` pass before
  opening the PR — two parallel sub-agents, Standards and Spec — which is the
  only code review a factory PR gets before auto-merge (the acceptance grader
  below judges criteria, not code quality). Factory sessions have no finishing
  step: verify plus that review pass ARE the pre-PR checks.
- **Live sessions** verify via `code4food-skillset:verify` (attended: watched
  browser, simulator screenshots, `screencapture`).

The two skillsets are separate, DIFFERENTLY-NAMED plugins and coexist on one
machine — same-named skills across them stay reachable under their own
namespaces (the shipped pair ran two `verify` skills that way for months).
What must never happen is two installed plugins sharing one PLUGIN name:
measured 2026-08-17 on Claude Code 2.1.233, that silently drops skills with
no error — which is why the unattended skillset ships INSIDE
`code4food-factory` rather than as a second plugin reusing its name.

Both honor the same two invariants, each in its own words: claim done only
on fresh evidence produced in THIS session, and scratch probes never in the
repo root (`.factory/tmp/` in factory checkouts, a gitignored scratch dir
in live sessions).

**The gate floor (autonomy epic, 1.9.0):** under auto-merge, "no
verification at all" never reads as green. The merge gate merges only when
CI checks pass, and — when `config.json → gateCommand` is set — the repo's
own suite additionally passes ON THE MERGED TREE (run in the meta worktree
between `git merge --no-commit` and the push; red aborts the merge and
leaves a fix note). A repo with NEITHER CI checks nor a `gateCommand`: the
gate refuses to auto-merge and doctor fails (`CI under auto-merge`). The
session's branch-side tests never stand in for either — they proved the
branch, not the combination with base. The rollup verdict is three-state
(T-045): green merges, red leaves the fix note, and absent-but-expected —
an empty rollup while the repo carries CI config (`forge.hasCiConfig`,
the same read as doctor's row) — is blindness, not "no CI": the gate waits
its budget, then leaves a diagnose note naming the silent-CI condition,
never a merge. Only a repo with genuinely no CI config reaches the
gateCommand-as-floor path.

**Risk tiers (autonomy epic, 1.10.0):** some paths are the owner's to
judge no matter what the checks say. A PR touching a prefix listed in
`config.json → riskTiers.high` (auth, payments, migrations, CI config…)
never auto-merges: the gate parks its task at `needs-human` exactly like
`Gate: human` — one PR comment naming the touched paths, and the owner's
own merge flips the task done mechanically (a question-parked task stays
parked, and a blocked task's risky PR is refused with no status change —
a merge doesn't answer a question). Prefixes are literal path matches
(end directories with `/`); a malformed `riskTiers` — wrong shape or a
misspelled key — fails doctor rather than silently disabling the floor.

**Parked means parked (backlog T-003, 2026-08-03):** a task parked
`needs-human` or `blocked` on a question earns no fix note, so nothing
sends a session to its branch — waiting must cost nothing (owner rule,
2026-08-01). Two of the notes are worse than idle work: the conflict and
gate-suite notes say "merge `<base>` into it … push", which moves the head
SHA without changing the branch-vs-base diff, so CI restarts, the next
sweep sees non-green checks and re-emits the same note — three consecutive
windows of one fleet PR (2026-08-01) were that treadmill. The gate itself
still runs (a green parked PR still lands, without a status flip — a merge
doesn't answer an open question); only the session-facing instruction is
dropped, and the driver logs which park dropped it. The exception is a park
that awaits the owner's review OF THAT PR — `Gate: human` or a risk-tier
park — which keeps its notes: the machine-clearable half (resolve the
conflict, fix red checks) is a session's job there, the owner cannot merge
a CONFLICTING PR without it, and a real fix changes the diff, so it cannot
treadmill. The stale-parked retry lane below is the ONE sanctioned
re-engagement of a question-parked task. The drop covers the grader's
fix note like every other (a parked task's acceptance criteria cannot
pass until the owner answers), and the plan lane skips a parked entry
rather than assigning it — the two lanes T-005 (2026-08-04) confirmed in
source and locked with regression fixtures.

**Review means the gate has it (backlog T-012, 2026-08-03):** a task at
`review` holds an open PR the merge gate is already watching, so no session
is sent to it — the plan lane skips it exactly as it skips done/blocked/
needs-human, and self-selection already excluded it. That lane was the last
leg of the same treadmill: every window re-assigned the review task, every
assigned session pushes (the dev prompt requires commit+push at each green
step and a HANDOFF refresh), every push restarted CI, and the window-end
sweep then found non-green checks and left the PR for the next window to
repeat — three windows, three pushes, on a diff that never changed. A
`review` record with no PR, or one whose PR has left the open list (closed
unmerged — a merged one is already flipped `done`), still goes to a session:
only a session can recover those. An unreadable PR list means we know
nothing and the task is left alone.

Review branches still track a moved base, but only when the move MATTERS.
Of the two fix shapes the known-issues entry offered, this takes the second
— skipping the base-merge when it cannot change the branch-vs-base diff —
because the first, a bounded wait on pending checks at window end, cannot
reach zero: CI that outlasts the wait leaves the PR in flight, the next
window re-engages, and the treadmill resumes one window later having also
spent window time waiting. The identity question is the same one T-002
answered for the grade cache: the driver merges base into the branch in the
object database (`merge-tree --write-tree` — no worktree, no checkout), takes
the patch-id of what the branch would then contribute, and pushes ONLY if it
differs from what it contributes today. A base-merge almost never changes
that (the base's own commits cancel on both sides); the case that does is
base work inside a branch hunk's context window. Note what this test does
and does not answer: it answers "did the branch's own diff change", NOT
"would CI now answer differently" — a base commit that renames a helper the
branch calls, or bumps a dependency it uses, leaves the branch's patch-id
byte-identical and still breaks the combination. Proving the COMBINATION is
the gate suite's job (`gateCommand`, the merge floor, run on the merged tree
before any merge exists anywhere), not the refresh's; a factory with CI but
no `gateCommand` has no such proof, and its stale-green risk is the reason
to set one. Unlike every other branch refresh, the driver does
this itself instead of instructing a session (see NOTES item 73): a
diff-identity comparison is mechanical, and a paid session sent to a branch
it has nothing to add to is the cost being removed. It fails toward NOT
pushing at every uncertainty — unreadable patch-id, a git without
`merge-tree --write-tree`, or a conflicting merge (the conflict note owns
that case, and resolving a real conflict changes the diff anyway) — and it
never touches a parked task's branch.

**The acceptance grader (autonomy epic, 1.12.0):** before the gate may
merge a task PR, an INDEPENDENT grader session must record a passing
verdict for the PR's exact head SHA. The driver spawns it (config
`graderModel`, default `opus` — deliberately not the factory's own
`model`) in a throwaway worktree checked out at the PR head, and briefs it
itself from the task's `Acceptance:`/`Verify:` lines — never from the
implementer's PR body or commits; a task with no `Acceptance:` lines is
graded against one criterion synthesized from its title. The grader reads
and runs but never edits; its verdict rides the `grade_verdict` MCP tool,
per criterion with evidence, and is cached in state.json by the DIFF it
graded (see the grade cache below; retries and sweeps never pay twice).
Coverage is
mechanical, not trusted to the grader: the driver briefed N numbered
criteria and requires a verdict entry for each — a short or empty list
(a grader low on turns, or a forged events-file write) fails closed,
never a pass on the criteria it never examined. Fail —
or no recorded verdict at all — means no merge, with the failed criteria
and the grader's evidence left as the next session's fix note; the
server-side merge fallback is equally refused for any task PR whose
current head no grader passed. A factory-branded PR with NO task id is
ungradeable and never auto-merges: the gate parks it for the owner (one
PR comment + notification, deduped in state) — retitling it with its
task id re-enters grading, or the owner merges it themselves. Genuine
piloting PRs are unaffected: the claim convention titles them with the
task id and their branches are not factory-branded, so a taskId-less PR
in the gate is a factory session that dropped its id. Only dev windows
spawn graders; a prep sweep leaves ungraded PRs for the next window
(prep spawns no sessions, by contract). Human-gated and risk-parked PRs
are unchanged: the owner IS their acceptance check.

**The API traceability rule (T-009, `factory/specs/api-ground-truth.md`
REQ-1..4 + REQ-9):** every code-writing lane — dev, stale-parked retry and
the acceptance grader — gets `TRACEABILITY_RULE` appended to its prompt
(one driver-side source beside `FOREGROUND_RULE`, same reason): never
invent an external API surface; every endpoint, method and response field
must be traceable to an in-checkout source (vendored spec, docs snapshot,
existing working code, SDK types), a mock or fixture is never a source,
and no source means stop and ask (`open_question`/`ask_peer`) as the
CORRECT completion. The grader applies it as an evidence rule — an
untraceable endpoint fails the criterion it rides; its asking exits
belong to the implementer, never the grader — with no new verdict states
and no bypass.

**The grade cache — identity is the diff, not the commit (1.21.0):**
verdicts cache under `<taskId>@pid:<patch-id>`, where the patch-id is
`git patch-id --verbatim` over the branch-vs-base diff (`base...head`) —
`--verbatim` rather than `--stable` because both ignore the hunk line
numbers a moved base shifts, but `--stable` also strips WHITESPACE, and
whitespace is semantics in Python, GDScript, YAML and Makefiles. So a
push that CHANGES the branch's content pays for a fresh grade, and a
base-merge refresh that moves the head SHA without changing that diff
reuses the verdict — deliberately. The boundary is the diff itself, and
it errs toward paying (measured 2026-08-02): base work in another file,
or elsewhere in a file the branch touched, keys the same and reuses; base
work INSIDE a branch hunk's context window changes the diff and re-grades
(closer still and the merge conflicts, so there is no refresh to reuse);
any content change on the branch re-grades, whitespace-only ones included.
An EMPTY commit reuses — it changes nothing to grade, so a session cannot
buy a fresh verdict (or advance the graded-fail counter) by pushing one.
On a git older than 2.39 `--verbatim` does not exist, the key falls back
to the head SHA, and the factory simply keeps paying as it did before. **Decision (2026-08-02, owner-approved
task T-002): a same-patch-id diff on a MOVED base may reuse its verdict.**
The grader grades the diff, never the merged tree — proving the
combination with base is the gate suite's job, and the suite runs against
the freshly merged tree on every gate pass, refresh or not. Paying an
~$1.76 grader to re-read an unchanged diff bought nothing: one fleet task
did it eight times on eight refresh SHAs of one diff (fleet incident
2026-08-01) while the task sat parked. Two consequences to know: an
acceptance criterion
EDITED in the backlog after a PR was graded does not by itself invalidate
the cached verdict (the graded-fail breaker's park and the owner's own
merge remain the escape hatches — flip the task back to `todo` to re-open
it for a fresh implementation and grade); and the task id is part of the
key, so two PRs carrying an identical diff never answer for each other.
When a diff has no patch-id (an empty diff, or git refusing), the key
falls back to the head SHA — fail toward paying, never toward reusing an
identity that cannot be vouched for. Legacy head-SHA-keyed entries from
before 1.21.0 are read harmlessly, miss once, and are dropped on the next
write.

**The graded-fail breaker (1.20.0):** a plain retry after a graded fail
rarely recovers — the fleet's own metrics put it at 1 in 6
(ADR 0004, from the 2026-08-02 fleet-metrics analysis): retry sessions inherit the
prior session's conclusions and deliver a minimal delta that fails the
same criteria again. So the fix-note loop has a floor: after
`gradeFailLimit` (config, default 2) CONSECUTIVE genuine graded fails —
fresh head each time — the gate stops writing retry notes and parks the
task `needs-human` with a filed question carrying the failed criteria,
asking for a re-plan (split the task, rescope its acceptance criteria, or
clear the obstacle; flip back to `todo` when done). Only genuine fails
count: short verdicts and no-verdict outcomes are grader capacity, not
code quality, and a cached verdict re-read never double-counts (nor does
a base-merge refresh, which no longer re-grades at all). A passing
grade — or the park itself — clears the streak (`state.json`
`gradeFails`), so re-planned work gets a fresh budget. While parked by
this breaker the still-open PR's cached fail stays silent on later sweeps
(no note regrowth); a task parked by an open question is never converted
(the T-032 invariant — same rule as risk tiers). Works in every mode that
runs the merge gate, unlike the until-done-only no-progress breaker.

## Machine setup (once per machine)

1. **The runtime** — every scheduler execs it, every worktree gets its
   tooling from it:
   ```sh
   git clone https://github.com/MJTeixeira/claude-plugins ~/.factory/runtime
   ```
2. **Plugins** — the skillset (dev workflow, verify, handoff, …) and the
   factory skills (factory-setup interview, backlog vocabulary), available
   in ANY project on the machine. Provisioned by the same deploy verb:
   ```sh
   node ~/.factory/runtime/factory/driver/deploy-runtime.mjs
   ```
   (it registers `~/.factory/runtime` as a local plugin marketplace and
   installs/updates `code4food-skillset` + `code4food-factory` at user
   scope; by hand: `claude plugin marketplace add ~/.factory/runtime &&
   claude plugin install code4food-skillset@code4food
   code4food-factory@code4food`).
3. **Telegram plumbing** (optional but recommended): bot token + chat id in
   `~/secrets/factory-shared.env` (§ Machine credentials), and
   `notify-fail.sh` in `~/.factory/` for the `factory-onfailure@.service`
   outer net (see Monitoring).
4. **Machine services**: the fleet watchdog timer and, on an always-on box,
   the dashboard service — templates in `factory/schedulers/`.
5. **Auth**: `claude` logged in (or `ANTHROPIC_API_KEY` in the factory's
   machine `.env`), `gh auth login` or `GH_TOKEN`.

To deploy driver/prompt improvements after they merge, run — per machine,
not per factory:

```sh
node ~/.factory/runtime/factory/driver/deploy-runtime.mjs
```

It verifies the runtime's origin remote is the canonical distribution repo
(`factory/driver/distribution.mjs`; a wrong or retired remote would report
"up to date" forever — a silently frozen machine; `FACTORY_RUNTIME_ORIGIN`
overrides for forks), fetches, refuses a dirty or diverged runtime, gates
the candidate (`node --check` on every driver module, then the CANDIDATE
driver's doctor over every registered factory, read-only), fast-forwards
only when green, stamps `~/.factory/runtime-deploy.json`, and Telegrams the
result. A failed gate leaves the runtime exactly where it was — the
merge-gate principle applied to the runtime itself. After an advance it also
names any long-lived unit left running old code, with the restart command:
it asks systemd `--user` and launchd which units exec a module out of this
runtime, walks each one's local (`./`-relative) imports transitively, and
reports the unit stale when the deploy's diff touched anything it reaches —
so a change to a module the dashboard merely imports is named too. Only
RUNNING processes qualify (systemd `SubState=running`, a launchd agent with a
pid): timers and the per-factory `@dev`/`@triage`/`@report` oneshots re-exec
per fire and self-heal, and restarting one of those would launch a window. Doctor carries a
standing `runtime origin` row for the same check (URL comparison only, no
network). Log: `~/.factory/deploy.log`. **This is the ONLY update verb** —
there is no per-project tooling refresh anymore (`init.mjs --update` died
with the machine-product refactor).

An **unattended machine** (one running the unattended skillset) declares
itself in `~/.factory/unattended.json`: the plugin + marketplace its
sessions load skills from (instead of the shipped `code4food` pair) and a
sha256 manifest of the runtime files overlaid by hand. `deploy-runtime`
REFUSES on such a machine — a deploy would clobber the overlays and
reinstall the shipped pair. Doctor verifies the declaration instead of
failing red: dirty runtime files must exactly match the manifest, the
declared plugin must be installed at its source's version, and a shipped
`*@code4food` plugin still present fails as a same-name collision. Remove
the declaration to return the machine to the shipped runtime.

## Setup (once per project and machine) — two ways, friendliest first

**Spec first, install later (works on any machine, any OS):** the `spec`
skill needs only the factory PLUGIN — not a runtime, not a factory host —
so a project can be specced in deep multi-sitting interviews on a laptop
(Windows included) days before any factory exists. It writes
`.factory/spec/*.md` from the plugin's template and finishes with a
red-team pass that resolves or `Gate: human`-stamps every owner-judgment
question — the stalls that otherwise interrupt long autonomous runs.
Both setup paths below detect existing specs and skip straight to the
mechanics.

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
backlog (`cat ~/.factory/runtime/factory/prompts/compile-spec.md | claude`,
run from the project — prompts live in the runtime, not the project), one
manual test window, and
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
| `maxSessionTimeoutMin` | `90` | ceiling a plan entry's per-task `timeoutMin` (§Per-task model & effort routing) may raise a session's timeout to; a higher value is clamped and logged |
| `autonomy` | `"pr-only"` | who merges PRs — `pr-only`, `auto-merge-dev`, `milestone-gates` (§Autonomy levels) |
| `baseBranch` | `"dev"` | branch the agent's PRs target — never your `main` |
| `model` | `"sonnet"` | default session model (also seeds `triageModel`); backlog tasks override via `Model:`/`Effort:`/`Turns:` |
| `effort` | *(unset)* | default reasoning effort; needs Claude Code ≥ 2.x |
| `triageModel` | *(= `model`)* | triage-only model. Planning gates everything downstream, so cheap dev sessions can pair with strong triage |
| `graderModel` | `"opus"` | the acceptance grader's model — deliberately NOT `model` (§Verification & review contract) |
| `mergeGateMinutes` | `10` | how long the gate polls CI before leaving a PR for the sweep (auto-merge only) |
| `gateCommand` | `null` | repo suite the gate runs on the MERGED tree before pushing (e.g. `"npm ci --silent && npm test"`); `null` = rely on CI. With NEITHER, the gate refuses to auto-merge and doctor goes red. It is the merge FLOOR, not verification: a task `Verify:` line that only repeats it proves nothing the gate didn't — doctor's `Verify lines` row and the triage lint flag those (§Backlog authoring, Verify tiers); projects with `docs/apis.json` can chain the endpoint lint — see the merge-gate section |
| `gateSuiteTimeoutMin` | `15` | wall-clock bound on `gateCommand`; a timeout counts as a failed suite |
| `riskTiers` | `{"high": []}` | path prefixes (end dirs with `/`) whose PRs always park for owner review. A malformed value FAILS doctor rather than silently disabling the floor |
| `toolchain` | *(unset)* | external tools the window needs, `[{"name": "godot", "check": "godot --version"}]` — one doctor row each, so a missing tool stops the window before it burns sessions. Malformed = doctor fail |
| `noProgressSessions` | `3` | `dev --until-done` only: sessions a task may burn without settling before it parks `needs-human` |
| `gradeFailLimit` | `2` | consecutive genuine graded fails (fresh heads) a task may take before the gate parks it `needs-human` for re-planning instead of writing another retry note (§Verification & review contract, graded-fail breaker) |
| `staleRetryDays` | `1` | days a parked (`blocked`/`needs-human`) task waits before its ONE escalated retry on idle window capacity (§Stale-parked retry); `0` disables the lane |
| `staleRetryModel` | `"fable"` | the retry session's model — the escalation IS the point: the task's own pin and the factory default already parked it |
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
rotating a token edits one file instead of one per project
(spec: `factory/specs/machine-credentials.md`):

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

The triage leg can do this itself (2.6.0): the `promote_milestone` MCP
tool records the ask and the DRIVER flips + commits at session end,
inside its own window lock — the verb's live-window refusal guards
out-of-band runs, not the leg that already holds the lock. Only a clean
(exit 0) triage session's ask is honored, the same bar as its plan; the
flip re-validates the milestone, so a done/unknown ask is refused with a
log line, never applied. The mechanism opens `gated` milestones exactly
as the verb does — the owner's-go-ahead bar for promoting one lives in
the triage prompt (owner evidence in, same bar as unblocking
`needs-human`), not in the driver.

Milestone headings are machine-read, and the canonical shape is
`## M<n>: <title> — <status>` (status LAST on the line; §Backlog authoring
below is the one home for the format). The index format went unspecified for a
long time, so older factories carry other dialects (`### M1: …`,
`## Milestone 1 — … (active)`) — the parser reads all of them, and
`promote` flips the status in whichever dialect the heading uses, so
nothing gets rewritten under the owner. A heading NO dialect covers is a
doctor warn (`milestone headings`): before that row existed, an unreadable
heading silently took out both promote and the dashboard's active-milestone
display on 4 of 6 fleet factories (2026-07-19).

## Backlog authoring: Verify tiers & acceptance wording

Tasks are authored in live sessions and by compile-spec/triage — never by a
factory window (the `code4food-factory:backlog` skill covers the window's
reading half). This section is the one home for the two authoring rules;
other docs and the lints point here. Triage authors from ONE source, inbox
notes, and only up to the completeness bar in the `code4food-factory:tickets`
skill — a note it cannot meet the bar from becomes a task parked at
`needs-human` carrying the question, never a guess.

### Verify tiers

The acceptance grader executes the `Verify:` line VERBATIM in a fresh
checkout. Write it at the highest tier the acceptance criteria reach:

1. **Suite-only — weak.** `npm test`, `dotnet test`, or a repeat of the
   config's `gateCommand`: the merge gate already runs these on the merged
   tree, so this line grades the diff, never the task. Inert package
   scripts (`npm run lint|build|typecheck|type-check|format|format:check|check|compile`,
   `yarn`/`pnpm` alike) and install preludes (`npm ci`) never lift a line
   out of this tier — `npm test && npm run lint` is still suite-only. The
   driver lints for it — doctor's `Verify lines` row, and the triage
   prompt lists the hits to fix. The lint feed is scoped to tasks in
   ACTIVE milestones (blocked/needs-human included; a not-started
   milestone's lines get their look at promote time); with no active
   milestone heading it is unscoped, fail-open.
2. **Drive the product — the bar.** A curl against the changed endpoint
   (status AND body), the CLI with real arguments, a headless engine run —
   and assert on output, not just exit codes (exit-0 proves almost
   nothing). On engine projects, a game-touching task's Verify includes
   the pinned engine-test command (godot/unity skill): engine-free unit
   tests alone skip the engine. The lint cross-checks this edge too —
   acceptance naming engine-tier tests with a Verify that never runs
   them is flagged even when the line otherwise drives the product.
3. **Human eyes.** Visual quality, game feel, aesthetics — that is
   `Gate: human (<reason>)`, never a Verify command; a headless session
   cannot self-judge it.

### Acceptance wording — the strictness dial

The grader judges each criterion AS WRITTEN, so the wording is the
strictness setting: write each criterion observable and checkable by a
stranger in a fresh checkout — observable behavior plus the exact
expectation (the input, the exact output/exit code/error contract, and
the comparison target): "exit 2 with `error:` on stderr", "byte count
matches `wc -c` on non-UTF-8 input".

An unmeasurable adjective ("gracefully", "correctly", "robust", "fast")
delegates strictness to per-run grader mood — the grader battery caught
borderline PRs graded lenient 2-in-3 until the criterion said "byte
length" literally. The driver lints for it (tier `vague`, same doctor
row and triage list as the Verify lint): a criterion with a mood
adjective and no measurable anchor — no number, no backticked
command/string, no path, no comparison target — gets flagged; "word
count matching `wc -w`" passes.

If the expectation can't be written exactly (visual quality, feel), it
belongs in `Gate: human (<reason>)`, not behind an adjective. A task
with no criteria at all becomes one synthesized criterion from its
title, which grades much more loosely than the spec deserves — write
the real ones.

## Git & status ownership (NOTES items 23–24, 39–41)

- **Worktree isolation (v2): your checkout is yours.** Every session runs in
  a throwaway worktree under `~/.factory/worktrees/<name>/`, detached at the
  base branch's origin tip (clean by construction, trusted automatically,
  removed after the session). The task branch a session creates in there is
  pruned from the shared `.git` when the worktree drops or its PR merges —
  but only refs merged into base or on origin at the same sha; a branch
  holding unmerged local work survives, and remote branches are never
  touched. All driver git work — gate merges, status
  flips, triage commits — happens in a persistent detached `meta` worktree
  there, refreshed from origin at every boundary and pushed `HEAD:<base>`.
  The factory never flips your checkout's branch or quarantines your WIP
  mid-window; its only touch is a fast-forward when your checkout is clean,
  on base, and strictly behind. **Origin is the rendezvous point**: your
  work is invisible to the factory until pushed (`prep` pushes for you),
  and quarantine/rescue machinery survives inside `prep` — the explicit
  "make my checkout safe" command.
- **Factory task branches are code-only.** Factory sessions never edit
  `.factory/backlog/`, never commit to base, never merge. (Live/piloting
  sessions are the sanctioned exception: they ship their OWN tasks' `Status:`
  flips inside the PR that ships the work — see the Piloting contract.) They report MID-RUN through the
  driver's stdio MCP server (`factory/driver/mcp-server.mjs`; v2 O2: `report_status`, `open_question`,
  `log_progress`, plus `create_pr` since factory 1.7.0,
  `post_daily_log` since 1.8.0 and `promote_milestone` since 2.6.0
  (triage-only; §Autonomy above); since 2.8.0 `report_status` takes an
  optional `friction` field (≤300 chars, truncated never rejected) —
  what fought the session, recorded in its `.mcp.jsonl` row for a future
  retro pass (docs/retro-criteria.md), read by nothing in the driver — the driver opens PRs and posts the
  daily log itself via the forge/tracker adapters with its own
  credentials, and pre-collects every forge/tracker READ into the
  triage/report prompts' `## Forge inputs` section, so sessions never
  shell out with keys. **Injection posture (autonomy epic, 1.11.0):**
  every issue and comment in that section carries an `(owner)` or
  `(UNTRUSTED)` trust tag — compared on the forge's STABLE id (gh login,
  Bitbucket uuid, Jira accountId; display names are spoofable) against
  `whoami()`, the account the driver authenticates as, and rendered
  position-anchored BEFORE any author-controlled text, so a name or
  title forged to look like a tag lands where the header says it is
  content. The prompts bind
  sessions to take instructions only from owner-authored content;
  UNTRUSTED text is data to summarize/route/question, never to obey.
  Identity unavailable → fail closed: everything tags UNTRUSTED and the
  section says so. Doctor warns (`injection surface`) when auto-merge
  rides a publicly writable surface (public repo + any tracker except
  Jira);
  validated tool calls appended to
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
  board sync, notify) runs as idempotent journaled steps. If a
  window dies mid-finalization, the next `dev` or `prep` run completes
  exactly the missing steps. Killed sessions still land in `usage.jsonl`
  with real token counts summed from their streamed events (`partial: true`
  rows are lower bounds).
- **One driver per project, for the whole process.** `<state>/log/window.lock`
  is claimed atomically at startup by `dev`/`triage`/`report`/`prep` (other
  modes only check it) and released in exactly one place: a pid-checked exit
  handler. Every leg runs INSIDE that claim — the auto-triage before a
  window, each `--until-done` cycle's triage and report legs, a replay of an
  older window's finalization — and none of them release, so no gap opens
  mid-run for a second driver to start in (NOTES item 76). A lock left by a
  crash carries a dead pid, which every reader treats as stale.
- **Every session leaves a metrics row** (`<state>/log/metrics.jsonl`,
  autonomy epic chunk 5), extracted from the session's own stream log:
  `endReason` (the result event's verdict — `success`, `error_max_turns`,
  `api_error`… — or `killed`/`no-output` when the session died without
  one), `turns` (billed total, SUMMED across every result record the
  stream carries — continuation fragments and subagent records each
  report only their own share; `costUsd` is the exception, cumulative
  in the CLI and therefore last-wins), `parentTurns` (parent-conversation
  records only — the one number a turn budget may be set against, since
  `--max-turns` never counts subagent turns), `peakContext`, per-turn `trajectory`
  (`{output, context}` per assistant message), permission-`denials` count
  (null when no result event recorded it) plus `deniedTools` — the same
  denials grouped per tool as `{tool, n, heads}`, where `heads` (up to 3,
  distinct) are redacted prefixes: a Bash command's leading `VAR=`
  assignments dropped whole and the first three plain words kept, stopping
  at any quoted/URL/operator token, so a silent dontAsk denial names the
  capability it blocked (`gh pr merge`) without ever persisting argument
  text; file tools contribute their `file_path`, other tools count only —
  and a `tools` name→count histogram. Written wherever a usage row is written — one ledger row and
  one metrics row per session, every mode. usage.jsonl stays the spend
  ledger; metrics.jsonl feeds plan correction and the no-progress breaker
  (chunk 6). Dev rows carry a `taskId`: a settled report's id verbatim
  (null there means no-tasks); a reportless death (runaway, kill, timeout)
  recovers it from the retry assignment, then the session's last mid-run
  `report_status` breadcrumb, then the plan entry — so every session the
  driver could attribute joins to its task. A session whose spawn itself
  failed after preflight passed (binary gone mid-window, missing cwd)
  records status `spawn-failed`, not `died` — a machine problem, never
  the task's; notify says so and such sessions never feed the
  no-progress breaker.

## Per-task model & effort routing

Every not-yet-done task in the backlog carries `Model:` and `Effort:` hints
(required — the dashboard flags gaps) plus an optional `Turns:` (see the
backlog skill) — set by compile-spec/triage by difficulty, e.g. cheap model
for well-specified CRUD, stronger model for novel game logic. Each triage
submits the ordered session queue for the next window via the
`submit_plan` MCP tool with those settings resolved (corrected against
usage.jsonl evidence — tasks that keep turn-capping get more); the DRIVER
writes `<state>/plan.json` from it, stamps `generatedAt` with its own
clock, and drops queued ids that aren't in the backlog. The driver
spawns each dev session with the entry's `--model`/`--effort`/`--max-turns`
and assigns it the task; missing/stale plan or an exhausted queue falls back
to sessions self-selecting with factory defaults (`config.json → model`,
`effort`, `maxTurnsPerSession`). `--effort` needs Claude Code ≥ 2.x; on
older CLIs the driver logs a warning and omits it. Every spawn execs
`config.json → claudeCmd` (default `"claude"`) — set it when the CLI lives
off PATH for the scheduler's environment.

A plan entry may also carry `timeoutMin` — triage's time lever, for a task
whose turn budget legitimately won't fit the default `sessionTimeoutMin`
(a big-turns/opus task the wall clock would otherwise cut off mid-work; the
turn cap and the wall clock are independent limits). At ingestion (when the
driver writes `plan.json` from triage's `submit_plan` event) a `timeoutMin`
above `maxSessionTimeoutMin` is clamped to it and logged — never silently
honored, same validate-then-cap discipline as `maxTurns`. An entry without
the field spawns with `sessionTimeoutMin` unchanged, and a plan.json written
before this field existed loads without error.

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

Routing policy for the top tier (`fable`, above opus): pin it on
BEHAVIOR-DEFINING or first-of-kind reasoning tasks where subtly-wrong logic
is invisible to tests — rubrics, playbooks, judgment prompts,
architecture-locking spikes. Not for routine infra/CRUD (sonnet) or ordinary
complexity (opus). Tie-break upward when unsure between tiers.

Task vocabulary has two parking states: `blocked` (dependency/technical —
machine-clearable, triage re-opens it) and `needs-human` (only the owner
clears it). A session that cannot self-judge a task's acceptance files an
`open_question` WITH the taskId; the driver files the tracker item, parks
the task `needs-human`, and links it on the task (`- Question: <url>`).
Tasks whose acceptance needs owner judgment upfront carry
`- Gate: human (<reason>)` (stamped by compile-spec — which propagates the
spec's red-team `Gate: human` notes onto every task covering the stamped
REQ — or by triage): the merge gate never
auto-merges their green PRs — it parks the task, asks the owner ONCE on the
PR, and the owner's own merge is the approval (it flips the task done).
Factory-level status derives from the pool: actionable work → normal; only
`needs-human` left → `waiting on owner (N)` — never plain idle; only
dependency-blocked left → `deadlocked` (the louder alarm). A dev window
that starts with zero actionable tasks skips itself BEFORE spawning a paid
session (logs + notifies "window skipped"); an empty backlog still gets its
probe session.

Under `auto-merge-dev`, a session that ends at status `review` with a PR url
hands the merge to the driver: it polls the PR's check rollup via `gh pr view`
(free, no tokens — deliberately NOT `gh pr checks`, which misreads in-flight
CI) and merges on green — sessions never wait on CI. The merge is done LOCALLY
(`git merge --no-ff` + push) so the task's `done` flip travels inside the
merge commit; a CONFLICTING PR is left with an exact rebase instruction for
the next session, and at window end a sweep gives every still-open green
factory PR one more gate pass. Poll budget:
`config.json → mergeGateMinutes` (default 10).

The rollup verdict is three-state (§Architecture & contracts, gate floor):
green merges, red leaves the fix note, and absent-but-expected is
blindness, not green. An empty rollup only means "repo without CI" when
`forge.hasCiConfig` finds no CI config — the forge owns what that means
(github: `.github/workflows/*.yml|yaml`; bitbucket:
`bitbucket-pipelines.yml`), read from the driver-owned project checkout;
with CI config present it means CI never reported — path filters, a
workflow that doesn't trigger on pull requests, a dead runner — so the gate
waits its budget like pending, then leaves a diagnose note naming the
silent-CI condition and never falls through to a merge (T-045; adopted from
mithril-cicd's scar: absence of green never counts as green). Only a repo
with genuinely no CI reaches the gateCommand-as-floor path below.

The gate floor rides the same local merge: set `config.json → gateCommand`
(e.g. `"npm ci --silent && npm test"`) and the driver runs it on the merged
tree before pushing — red aborts the merge, captures the output to
`<state>/log/gate-suite-*.log`, and leaves the fix note (with the output
tail) for the next session. `gateSuiteTimeoutMin` (default 15) bounds it; a
timeout is a failure. On a repo with no CI the gateCommand IS the check —
with neither, the gate refuses to auto-merge and doctor goes red, so a
factory can never silently merge on nothing (fleet lesson, 2026-07-23).
The command runs in the meta worktree: it must be self-contained
(install deps itself or tolerate a warm worktree).

The toolchain manifest is the window's other floor: declare
`config.json → toolchain` as `[{"name": "godot", "check": "godot
--version"}, …]` and doctor grows one row per tool — the check runs
(30s timeout) and a non-zero exit is a red row naming the tool. Since
`--scheduled` runs abort on doctor fails, a missing tool stops the window
BEFORE it burns sessions against it. A malformed manifest is itself a
doctor fail (same rule as riskTiers: a typo must never silently turn a
floor off).

The endpoint lint is a ready-made gate floor for projects with vendored
API oracles (T-011, api-ground-truth REQ-8/14): wire
`config.json → gateCommand` to
`node ~/.factory/runtime/factory/driver/endpoint-lint.mjs --root . [--diff-base <base>]`
(alone or `&&`-chained with the suite). Nonzero exit = a call absent
from a machine-readable oracle, a raw HTTP call bypassing an sdk-rung
oracle's declared hosts, a diff touching vendored-oracle paths
or `docs/apis.json` itself (`--diff-base`, REQ-7/13), or an unparseable manifest/oracle — a typo
never silently turns this floor off. Deprecated and legacy-generation
calls WARN on stdout and exit 0; docs-snapshot/none rungs report
"grader-citation only" and exit 0, so wiring it is always safe. The gate
runs from the repo root, so `--root .` resolves there — a suite that
cds into a subdir must still hand the lint the repo root, because with
no `docs/apis.json` at `--root` it notices, exits 0, and enforces
nothing. What it
can and cannot see (string-literal extraction: client-call shapes plus declared *PATH/*URL/*ENDPOINT constants)
is documented in the module header; the manifest schema lives in the
spec skill's apis-manifest reference.

Risk tiers ride the same landing: before the merge is even attempted, the
gate diffs the PR against base and any file under a `riskTiers.high`
prefix parks the task at `needs-human` for owner review (one PR comment,
no suite run, no merge) — see §Verification & review contract for the
full contract. A high-risk PR with no task id never reaches the risk
check: the ungradeable gate refuses it first (see the acceptance-grader
contract), and the PR waits for the owner either way.

The acceptance grader is the landing's last leg: after checks and the
suite, the driver spawns an independent grader session (`config.json →
graderModel`, default `opus`; usage rows log as mode `grade`) against the
task's `Acceptance:`/`Verify:` lines and merges only on a recorded
per-criterion pass — fail or no verdict leaves the failed criteria and
evidence as the next session's fix note. Verdicts cache by the graded
diff's patch-id in `<state>/log/state.json`, so only a push that changes
the branch-vs-base diff costs another grader session — a base-merge
refresh reuses the verdict; grader session output lands in
`<state>/log/grade-*.out`. See
§Verification & review contract for the full contract.

PRs merged OUTSIDE the gate (the owner, any human) close their tasks
mechanically: every dev window start — under every autonomy level, since
pr-only has no other merge path and no sweeps — checks tasks sitting at
`review` (any gate) or at `needs-human` awaiting PR review (`Gate: human`
or a risk-tier park) that carry a recorded PR, and flips them `done` when
that PR is merged. This runs before
the skip check and before the plan assigns work, so a settled backlog skips
its window and a stale plan entry is skipped instead of burning a session
re-verifying a merge (fleet incident 2026-07-23).

## Peer questions (`config.json → peer`)

When the machine config wires a peer-channel client, dev sessions get an
`ask_peer` MCP tool: ask a peer agent a blocking question mid-window and
wait (minutes) for the answer, instead of stalling the task to
needs-human until a human reads it. The channel itself is NOT part of
the factory — the factory ships only this client seam; any bin honoring
the contract below plugs in, and machines without one never register
the tool. Same driver-mediated boundary as `create_pr` — the SESSION
never touches the channel; the driver spawns the configured bin with
its own identity and maps the exit code:

- `0` — the bin prints JSON (`{id, state, answer}`); the answer text
  returns to the session, labeled as agent-authored ADVICE (it never
  overrides the task, spec, or acceptance criteria).
- anything else — a tool error whose text names the session's fall-back
  (open_question / report_status blocked): `2` malformed request, `3`
  escalated to the owner, `4` cancelled, `5` budget expired, `6` unknown
  addressee, `7` role has no live holder, `8` channel frozen (owner kill
  switch), `9` caller not on the roster, `10` request rejected, `11`
  channel core unreachable. Sessions lose nothing — the tool failing IS
  the pre-channel behavior.

Bin contract: the driver execs
`<bin> ask --to=role:<role> --subject=<question> --budget=<n>s
--task=<taskId> [--context -]` (context arrives on stdin), with env
`<PREFIX>_URL`, `<PREFIX>_MACHINE`, `<PREFIX>_AGENT` set from the config
below (`envPrefix`, default `PEER`). `<PREFIX>_OWNER_KEY` is STRIPPED
from the child environment — a factory never speaks with the owner's
trust label — and the peer's answer text always FOLLOWS the driver's
advice framing, with nothing after it a forged "driver note" could
impersonate.

Machine config (absent = tool not registered; sessions never see it):

```jsonc
"peer": {
  "enabled": true,
  "bin": "/<path-to>/channel-cli.mjs",       // required: the channel client bin
  "envPrefix": "PEER",                       // env-var prefix the bin reads (default shown)
  "url": "http://127.0.0.1:3071",            // default shown
  "machine": "vps",                          // default: os.hostname()
  "agent": "factory-myproject",              // default: factory-<project> from the state-dir name
  "role": "peer-question",                   // default addressee role
  "defaultBudget": "5m",                     // <n>[s|m|h]
  "maxBudget": "10m",                        // hard clamp on session-supplied budgets
  "maxAsksPerSession": 3                     // runaway cap, driver-side (in-memory, forge-proof)
}
```

Keep `maxBudget` comfortably under `sessionTimeoutMin`: the tool BLOCKS
the session while it waits, so a budget that outlives the session
timeout means the driver kills the session mid-wait and the answer is
lost. Session-supplied budgets above the max are clamped (the ask still
happens), never rejected.

The driver's channel identity (`machine` + `factory-<project>`) must be
on the channel's roster — a missing entry is exit 9 and the tool error
says so. Doctor gets one row (`peer client`): skip when unconfigured,
fail on a dead `bin` path, green otherwise.

## Run until done (`dev --until-done`)

Autonomy epic chunk 6 — "tell a fully-specced product to run until it's
done". One command chains triage→dev→report cycles (the same three legs a
scheduled day runs; triage leads every cycle so inbox notes, answered
questions, and out-of-band merges fold in before sessions spend anything)
and posts a one-line digest per cycle. Best on `schedule: manual`
factories — a timer-scheduled factory would start competing windows.

The loop ends when:

- the backlog completes, or only owner-gated work remains — tasks in
  `review` (a delivered PR the owner must merge — the whole deliverable
  under `pr-only`), `needs-human`, or `blocked` count as owner-gated, on
  top of the `waiting-on-owner`/`deadlocked` `deriveFactoryStatus`
  vocabulary the dashboard shows;
- a `STOP` file appears (checked between sessions and between cycles —
  same file, same meaning as a plain window);
- a window dies on a fatal error (unrecoverable repo, worktree failure);
- **two consecutive cycles land nothing** — a stuck loop must never grind
  paid sessions.

**No-progress breaker** (until-done only): a task that burns
`noProgressSessions` (config, default 3) sessions without reaching a
settled status (`done`, `review` — a delivered PR is settled from the
session's side — `blocked`, `needs-human`) is parked `needs-human`
mid-window, with a filed question
carrying the evidence (a dead tracker queues the question but never
disables the park). Counters live in `state.json` (`noProgress`), survive
restarts, and reset the moment the task settles. When the park leaves
nothing actionable, the window ends immediately instead of burning a
probe session.

## Stale-parked retry (one escalated look per park)

Sessions believe recorded blockers instead of re-testing them — the
2026-08-01 rethrow experiment recovered 2 of 3 long-parked tasks the
moment a fresh top-tier session re-ran the recorded command (spec:
`factory/specs/stale-parked-retry.md`). This lane automates exactly that,
on idle capacity only:

- **Trigger** — a window that would otherwise skip (all-parked backlog) or
  end on a `no-tasks` report runs ONE retry session instead, when session
  budget and window time remain. Queued todo work is never displaced, and
  triage's "never queue a parked task" rule is untouched — the lane lives
  outside the plan. In `--until-done` this is per cycle, so a parked
  backlog drains one task per cycle without ever looping.
- **Eligibility** (all must hold) — status `blocked`/`needs-human`; parked
  at least `staleRetryDays` days (`state.json` `updatedAt`; a record
  without the stamp counts as old enough); no retry since the current park
  (**one per park, ever** — a re-park after owner action re-arms it); not
  claimed by a human's open PR; its linked question, if any, still open
  and unanswered (an answered question is triage's fold). Oldest park
  first.
- **Session** — exit-criteria-only prompt (`prompts/retry-task.md`: the
  task block verbatim plus the report/boundary contracts, no dev-task
  coaching) on `staleRetryModel` at effort high. **Re-test the recorded
  blocker FIRST** is the load-bearing instruction. Deliverables ride the
  normal path — same PR flow, same acceptance grader, same merge gate and
  `Gate: human` floor; the retry never hand-flips a parked status and
  never feeds the no-progress or silent-death breakers.
- **Outcome** — stamped in `state.json` (`tasks.<id>.retry = {at, model,
  outcome}`) and appended on the task as `- Retried: <date> <model> —
  <outcome>: <detail>` (inert to the backlog parsers): `recovered` (the
  task re-entered the working pool — delivered, or resumed as a normal
  task), `gate-held` (machine half delivered, waiting at the owner's
  gate), `still-stuck` (blocker confirmed or owner input genuinely
  required; with an existing question thread the fresh evidence lands
  there as a comment — no new threads, no extra notifications).

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
- **Forge** (`config.json → forge`, default `"github"`): set
  `"bitbucket"` for a Bitbucket Cloud repo. Needs `curl` on PATH and
  `BITBUCKET_EMAIL` + `BITBUCKET_API_TOKEN` in `<state>/.env` (Atlassian
  API token; the basic-auth username for API calls is the account EMAIL,
  not the Bitbucket username). Bitbucket deltas, all by design: the
  GitHub Projects board needs a github forge (doctor warns if
  `board.github` is set; the Jira board below works on any forge),
  merge conflicts
  surface at the gate's local merge (the API has no conflict pre-check),
  needs-human questions file into the repo's NATIVE issue tracker unless
  the Jira tracker below is configured, and dashboard check-chips read
  "none" until Pipelines statuses are wired. PR creation always sends
  `destination` explicitly: omit it and the API opens the PR against the
  repo's main branch, not the factory's base — worth eyeballing on a new
  Bitbucket factory's FIRST PR. The dashboard's forge reads cap at 15s and
  degrade to empty cards rather than failing the page, so a slow Bitbucket
  shows a thin dashboard, not a broken one. Sessions and the `finishing`
  skill are forge-neutral — a
  Bitbucket factory ran its first live client pilot 2026-07-19: build,
  verify, review, session pushes, the turn-cap resume chain and the merge
  all proven against the real API. Sessions open PRs through the
  `create_pr` MCP tool (factory 1.7.0) — the driver makes the forge call
  with its own credentials; called for a branch whose PR is already open
  (a rework), it updates that PR's title/body instead of leaving the
  pre-rework text standing. Every shell-side credential recipe was
  live-disproven 2026-07-20 (all command forms denied in real worktrees
  under `dontAsk`), which is why ALL session forge access is driver-side
  by contract since 1.8.0: PR creation via `create_pr`, the daily log
  via `post_daily_log` (failures queue in state and retry, same as
  questions), and triage/report reads via the driver-collected
  `## Forge inputs` prompt section. A session must never fall back to
  shelling out with keys.
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
- **Discord tracker** (`"tracker": "discord"`, spec
  `factory/specs/discord-tracker.md`): questions and the daily log land
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
  the delegation trust ramp's tier 2, spec
  `factory/specs/delegation.md`);
  after that triage succeeds the driver posts `✔ folded into the
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
  Shows per factory: status (running window + session #, idle, STOP'd,
  disabled, missing), declared state chips (schedule kind + a ⚠ chip if
  `enabled` is missing/non-boolean), config, backlog task table with PR/issue
  links, last-session summary, driver log tail, and cost/token spend (today +
  all-time, from `<state>/log/usage.jsonl`). While a window RUNS, rows are
  live in-window (spec `factory/specs/dashboard-liveness.md`): a **component
  chip** names the active driver phase now (triage / session N / grading /
  sweep / prep — derived from the daily log; a dead lock pid reads idle), and
  the detail panel's **now line** shows the running session's turn count and
  last transcript event with its age, from an incremental background tail of
  the session jsonl (own interval, `LIVE_REFRESH_MS` env override; the 5s UI
  tick never parses). Parse trouble degrades to a ⚠ badge — boundary-written
  state files stay authoritative wherever they disagree at rest. The UI is a code4food-branded
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
  --project <path>` (the checks live in `factory/driver/doctor.mjs`;
  `factory.mjs` hands them the loaded config): read-only checklist of
  everything that has actually broken a night once — claude/gh on the
  current AND the systemd unit's
  PATH, workspace trust, scaffold, allowlist, machine-runtime health (clean
  tree; legacy per-project driver copies warn; schedulers still exec'ing a
  deleted `.factory/driver.mjs` FAIL with the migration hint), .env keys
  for enabled features, gh auth scopes, native-tracker reachability (issues
  switched off = questions queue silently — warns, so the preflight never
  aborts a whole window over it), milestone headings that
  no longer parse (promote + dashboard read them), timers + linger, docker when
  compose exists, plan freshness, dashboard registry, plus the setup
  contract (NOTES item 25): `schedule` declared and matching what's
  installed, `enabled` a declared boolean (item 47 — a disabled factory is
  a legitimate state and doctors GREEN, its timer checks skipped),
  the git contract (the repo carries only work data — a still-tracked
  legacy `config.json` or `.env` FAILS with the migrate hint),
  backlog format parseable, Verify-line tiers (a non-done task warns when
  its `Verify:` only re-runs the suite/gateCommand, skips the
  engine-tier tests its own acceptance names, or carries vague
  acceptance wording — a mood adjective with no measurable anchor; the
  grader executes the line verbatim and judges each criterion as
  written (§Backlog authoring, Acceptance wording); the same lint feeds the
  triage prompt),
  CI-or-gateCommand present under auto-merge
  (neither = red FAIL, per the gate floor). Exit 1 on
  problems. Run it after ANY infra change (new machine, runtime deploy,
  token rotation, scheduler edit, feature enable) — it is cheaper than
  losing a window. Scheduler entries pass `--scheduled`, which runs these
  same checks as a preflight and aborts + Telegrams instead of
  half-running. On Discord-tracker factories the preflight also runs the
  **machine-thread sensor** (spec `factory/specs/delegation.md` seam 1):
  each machine-scoped red row (auth, tools, scheduler PATH, peer client)
  files or day-refreshes ONE `[<machine>] <fact>` thread in the questions
  channel — instead of N tasks parking on the same dead token — and the
  next green run for that fact ✔-closes the thread itself with the probe
  as evidence. State: `~/.factory/machine-threads.json` (machine-level:
  all factories on a box converge on one thread per fact). Machine
  threads carry no factory tag and are invisible to issue reads.
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
  `window.lock` + journals), so restarts lose nothing. Three duties:
  1. **Out-of-band wall-clock kill of hung runs** — the driver's own
     timeouts share its event loop, so a stalled sync git/gh call hangs the
     watchdog with the watched (the 2026-07-11 4.5h hang). A live lock past
     its bound (dev: `windowEndsAt` + a config-derived finalization budget
     — 3× sessionTimeout + 2× merge-gate + 30min slack, sized for the last
     session plus its grader plus one sweep grader; triage/report/prep:
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
     §Escalations outbox) and pings Telegram best-effort
     (`~/secrets/factory-shared.env`, else any factory's `.env`). Each cause
     escalates exactly once (dedupe in `~/.factory/supervisor/state.json`).
- `<state>/log/dev-*.out` — full session transcripts.
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
  leftover green factory PRs one gate pass, ends with a doctor summary.
  Zero sessions, zero cost. This is a REPAIR verb, not a required handoff:
  the driver never touches your checkout on its own (see Architecture &
  contracts), so you only need prep when you've left the checkout dirty or
  diverged and want it back to a known-good base.
- **Owner notifications** — two lanes (spec
  `factory/specs/owner-message-format.md`): **Telegram carries errors and
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

## Piloting gotchas (learned the hard way — don't relearn)

- **Never wrap a window launch in a retry-until-success loop** — a trailing
  command exiting nonzero re-runs the block and spawns duplicate drivers
  (three for one project, once). Launch once, verify separately. One driver
  per project, always.
- **Don't `pkill -f <project>` over ssh** — the remote command line contains
  the pattern, so it kills your own shell. Kill by node PID instead.
- **`/model` switch in an interactive session kills that session's background
  children** (dev windows, dashboard launched from it). Relaunch them after.
- **In-flight CI reads as "checks FAILING"** to the merge gate (seen ~5×): a
  PR whose CI is still running gets a fix-note; the next session finds it
  green with nothing to fix and merges. Wastes one session, self-heals.
- **GitHub API timeouts** (`gh pr view failed`, `meta: fetch failed — using
  local refs`) self-heal via the window-end sweep or next session. Only act
  if PRs pile up unmerged.
- **A multi-line Bash command is DENIED outright under `dontAsk`**, however
  well its individual binaries are allowlisted — the permission matcher
  cannot decompose a command carrying newlines. This ate the first live pilot's
  PR: a curl with an inline multi-line `--data '{...}'` was refused, and
  the operator opened PR #1 by hand. Every prompt recipe that SENDS a body
  now writes it to `.factory/tmp/<name>.json` with the Write tool and
  passes `--data @<file>` on one line. Write new recipes the same way.

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

## Windows

Windows is NOT a supported factory host: the supervisor has no Windows
keep-alive, scheduled-task install is not automated or doctor-verified,
and the `notify-fail` outer net is POSIX-only — run factories on macOS or
Linux. Windows machines are fully supported for everything else: the
skillset (statusline and hooks are plain Node), interactive Claude Code
sessions, and piloting a factory repo as a live session (the piloting
contract is host-agnostic — branch, push, converge at origin).
