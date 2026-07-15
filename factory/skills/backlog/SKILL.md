---
name: backlog
description: Working inside a Factory project (.factory/ exists) — how to pick, execute, and update backlog tasks.
---

# Factory backlog

The factory's rules — piloting, checkout ownership, the monitor contract,
how sessions and owners converge at origin — live in
`~/.factory/runtime/factory/FACTORY.md` §Architecture & contracts. Read
THAT before answering questions about factory behavior; this skill covers
only the backlog vocabulary.

The backlog is the single source of work. `.factory/backlog/index.md` maps
milestones → epics; each `.factory/backlog/<epic>.md` holds tasks:

```markdown
## T-023: <title>
- Status: todo | in-progress | blocked | needs-human | review | done
- Reqs: REQ-4, REQ-7          # spec requirements this satisfies
- Deps: T-021                  # must be done first ("None" if none)
- Gate: human (<reason>)       # optional: acceptance needs owner judgment —
                               # the merge gate holds green PRs for owner review
- Acceptance:
  - <observable criterion, testable>
- Verify: <command(s) that prove it>
- Notes: <PR link, blocked reason, decisions>
- Model: opus                  # required unless done: model for the session
- Effort: high                 # required unless done: low|medium|high|xhigh|max
- Turns: 120                   # optional: session turn budget
```

`Model:` and `Effort:` are REQUIRED on every task that isn't done — a task
without them is a defect the dashboard flags and triage must fix by reading
the spec (never by stamping a blanket default). `Turns:` stays optional.
Assign by difficulty, honestly:

- sonnet/low — mechanical and fully specified: docs, config, seed data.
- sonnet/medium — standard well-specified implementation: CRUD, pages,
  parsers with a known format.
- sonnet/high — tricky but specified: clock/timezone math, concurrency,
  e2e/integration, fuzzy parsing, thin-spec ops work.
- opus/* — where a cheaper model plausibly produces confidently-wrong
  output that tests can't catch (novel algorithm or game-design judgment,
  canon interpretation, architecture whose mistakes propagate), AND for
  the FIRST-of-its-kind integration in each engine/subsystem (first
  netcode task, first combat pipeline, first replication, first rig work)
  — these set the pattern every follow-up copies; the followers drop back
  to sonnet/high. Note the reason in the task's Notes.

Tie-breaker: time is the scarce resource, not tokens. When torn between
two tiers, take the higher one — a session that flails against a task too
big for its model, or a burned owner-review cycle, costs more than any
model delta. Stay honest at the bottom (docs and data files don't need
opus), but never talk yourself DOWN a tier to save money.

Triage copies hints into the day's session plan and corrects them against
observed usage (a task that keeps turn-capping gets more turns next time).

## Picking the next task

1. If `.docs/HANDOFF.md` exists, resume that task — it outranks everything.
2. If a task shows `in-progress` (in the backlog file OR the prompt's
   Driver state overlay), a previous session was cut before finishing —
   resume it (verify actual state first: branch, `git status`, test run;
   trust the code over the note).
3. Otherwise: first `todo` task whose `Deps` are all `done`, scanning the
   ACTIVE milestone's epics in index order — with the Driver state overlay
   applied on top of the files (a task the overlay shows as `review` or
   `done` is NOT eligible even if its file still says `todo`). Never start
   tasks from a milestone marked `gated` or `not-started`. A task whose
   `Model:` pin is ABOVE your own tier (haiku < sonnet < opus < fable) is
   not eligible for you either — skip it; the plan routes it to a stronger
   session.
4. Nothing eligible → report `no-tasks` and stop; don't invent work.

## Status (dev sessions REPORT, the driver EDITS)

Dev sessions never edit `Status:` lines, index counts, or anything else in
`.factory/backlog/` — status is reported once, in
`.factory/log/last-session.json`, and the driver writes it into the files
(done rides inside the merge commit; blocked gets its own commit). Only
TRIAGE sessions edit backlog files, and only content: new tasks, acceptance
criteria, Notes, hints, unblocking (`blocked → todo`, answered
`needs-human → todo`), milestone gating.

What to report when:

- `review` — your PR is open (every autonomy level). Include the PR url.
- `blocked` — a technical dependency stops you: put the reason in your
  summary, then end. Never wait. If what stops you is a DECISION or
  judgment only the owner can make, also call `open_question` with the
  `taskId` — the driver files the issue and parks the task `needs-human`
  (a status only the owner clears; `blocked` is machine-clearable and
  triage may re-open it).
- `completed` — nothing was left to do (task already merged/landed).
- Milestone finished (all tasks done) under `milestone-gates` autonomy:
  file the `needs-human` gate issue and report `no-tasks`; triage marks the
  milestone `done`/`gated` in the files until a human flips the gate to
  `active`.

## Rules

- Acceptance criteria are the contract — the task is done when they pass,
  not when the code looks done. Run the task's `Verify` commands.
- Scope creep goes to the backlog via your report, not the diff: mention
  discovered work in your summary and triage turns it into a task.
- Backlog edits (triage only) are facts, not prose — keep the format
  exactly; the driver edits `Status:` lines mechanically and the dashboard
  parses them.
