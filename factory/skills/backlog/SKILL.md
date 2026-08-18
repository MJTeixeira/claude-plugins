---
name: backlog
description: Read the Factory backlog in an unattended window — pick the one task to work, judge whether a task is eligible, interpret a task block's fields, and decide what status to report. Use this whenever a factory session is choosing or resuming a task, wondering whether a task is off-limits, reading `Acceptance:`/`Verify:`/`Gate:`/`Deps:`, or deciding between `review`, `blocked`, `incomplete` and `no-tasks`. Not for writing backlog files — in a factory window the driver owns every write.
---

# The backlog, from a factory window

The backlog is the single source of work. `.factory/backlog/index.md` maps
milestones to epics; each `.factory/backlog/<epic>.md` holds the task blocks.

You are one unattended session with no human in the room. Your job is to work
**one** task and report what happened. The driver — the process that spawned
you — owns the files, the PR and the merge. That split is what lets a window
crash mid-task without corrupting anything, so it is worth honouring even when
editing a line yourself would be faster.

## The task block

```markdown
## T-023: <title>
- What: <the end-to-end behaviour this makes work>
- Type: AFK | HITL
- Status: todo | in-progress | blocked | needs-human | review | done
- Reqs: REQ-4, REQ-7
- Deps: T-021
- Gate: human (<reason>)
- Acceptance:
  - <observable criterion with an exact expectation>
- Verify: <one line of command(s) that prove it>
- Notes: <PR link, blocked reason, decisions>
- Model: opus
- Effort: high
- Turns: 120
```

`Acceptance:` is the contract — the task is done when those criteria pass, not
when the code looks finished. An independent grader session will later run
`Verify:` verbatim in a fresh checkout and judge each criterion **as written**,
reading neither your PR body nor your commits. Nothing you write can talk it
past a criterion, so make the criteria actually pass.

`Gate: human (<reason>)` means the acceptance needs judgment you cannot make
headlessly. Build it and open the PR as normal; the merge gate holds it for the
owner instead of auto-merging. Do not try to self-assess the gated part.

`Verify:` that only runs the suite (`npm test`, the configured gate command)
proves the diff, not the task — the merge gate already runs that on the merged
tree. Run it anyway, then also drive the product once per the `verify` skill,
and say in your report that the line was weak so it gets fixed.

**Three things live sessions write that mean nothing to you:** `## D-NNN:`
decision-ticket blocks in the same epic files, map sections at the head of
`index.md` above the first milestone heading, and the `What:`/`Type:` fields.
The driver's parser skips all of them. Read them if they help you understand the
work; never act on them as if they were tasks.

## Picking your task

1. If the prompt carries a **Driver assignment** naming a task, that is your
   task — no selection needed.
2. A task showing `in-progress` means a previous session was cut before
   finishing. Resume it, but verify the real state first — branch, `git status`,
   a test run. Trust the code over the note.
3. Otherwise take the first `todo` task whose `Deps:` are all `done`, scanning
   the **active** milestone's epics in index order.
4. Nothing eligible → report `no-tasks` and stop. Don't invent work.

Four things make a task ineligible even when it reads `todo`:

- **The driver's state overlay wins over the files.** The prompt carries the
  runtime status of every task; a task the overlay shows as `review` or `done`
  is taken, whatever its file says. Backlog files lag by design — a status flip
  rides a merge commit.
- **Milestones that are `gated` or `not-started`.** Only the `active` one is
  open for work.
- **A `Model:` pin above your own tier** (haiku < sonnet < opus < fable). Your
  tier is in the prompt. A cheaper session having a go at a task pinned higher
  produces confidently-wrong work that tests don't catch — skip it, take the
  next eligible task, and note the skip in your report.
- **A claimed task.** A human's open PR carrying the task id in its title holds
  it, draft or ready; the prompt lists these under **Claimed tasks**. Their
  `Status:` flip only lands when their PR merges, so the open PR is the claim,
  not the file.

## Status: you report, the driver writes

Report once through the `report_status` MCP tool. The driver writes the result
into the files — `done` inside the merge commit, `blocked` in its own commit.
Sessions do not edit `Status:` lines, index counts, or anything else under
`.factory/backlog/`. If a backlog file looks stale next to the overlay, it is:
move on, bookkeeping is not your job.

What to report, and when:

- **`review`** — your PR is open. Include the url. Report this the moment the
  PR exists, before anything else, so a turn cap after that point loses nothing.
- **`blocked`** — a technical dependency stops you. Put the reason in your
  summary and end; never wait. If what stops you is a decision only the owner
  can make, also call `open_question` with the `taskId` — the driver files it
  and parks the task `needs-human`, which only the owner clears.
- **`completed`** — there was nothing left to do (already merged or landed).
- **`incomplete`** — you ran out of window or turns mid-task. Say exactly where
  you stopped, so the next session lands the leftovers rather than re-deriving
  them.
- **`no-tasks`** — nothing eligible.

Mid-task progress belongs on the task's `Notes:` — the driver writes it from
your report, and a task and a handoff are the same object at two stages of its
life. Keep it free prose, but never put a `## ` heading in it: a `## ` line
starts a new block and would cut the task in half.

## The triage session is the one exception

Triage runs once before the dev window, in the driver's meta worktree. It edits
backlog files and never runs git — the driver commits its tree when it finishes.

Triage **maintains** tasks; it does not create them. New work is authored in a
live session, so an inbound issue, a board card or a bug report that arrives
without a task becomes a line in the daily log, not a new task block. Two of the
edits it does make need a rule.

### Stamping `Gate: human (<reason>)`

Stamp it on a task whose acceptance needs judgment no headless session can make:
visual quality, game feel, aesthetics, product sign-off — anything whose
expectation cannot be written as a check. The merge gate then holds its green PR
for the owner instead of auto-merging.

The tell is an acceptance criterion reaching for an unmeasurable adjective. If
the expectation can be stated exactly, state it exactly and no gate is needed;
if it genuinely cannot, the gate is the honest home for it, and hiding it behind
"looks good" only moves the judgment to a grader that cannot make it either.

A human-gated task whose machine half is already done — PR open, waiting on the
owner — is waiting, not stuck. Don't plan it again.

### Assigning `Model:` and `Effort:`

Both are required on every task that isn't done; a task missing them is a defect
to fix by reading the task against the spec, never by stamping a blanket
default. Judge by difficulty, honestly:

- **sonnet/low** — mechanical and fully specified: docs, config, seed data.
- **sonnet/medium** — standard well-specified implementation: CRUD, pages,
  parsers with a known format.
- **sonnet/high** — tricky but specified: clock and timezone math, concurrency,
  e2e and integration work, fuzzy parsing, thin-spec ops work.
- **opus/\*** — where a cheaper model plausibly produces confidently-wrong output
  that tests can't catch: a novel algorithm, game-design judgment, canon
  interpretation, architecture whose mistakes propagate. **Also the
  first-of-its-kind integration in each engine or subsystem** — the first netcode
  task, the first combat pipeline, the first replication or rig work. Those set
  the pattern every follow-up copies, so they are worth buying right; the
  followers drop back to sonnet/high. Note the reason in `Notes:`.
- **fable/\*** (above opus) — behaviour-defining reasoning artifacts where subtly
  wrong logic is invisible even to careful review: rubrics, judgment prompts,
  playbooks, spec red-teams, architecture-locking spikes the whole project
  inherits. Not for routine implementation at any difficulty — a hard parser is
  still opus at most. Note the reason in `Notes:`.

Time is the scarce resource here, not tokens. Torn between two tiers, take the
higher one: a session that flails against a task too big for its model, or a
burned owner-review cycle, costs more than any model delta. Stay honest at the
bottom — docs and data files don't need opus — but never talk yourself *down* a
tier to save money.

`Turns:` stays optional. Correct all three against observed usage: a task that
keeps turn-capping gets more turns next time.

## Finishing a milestone

Under `milestone-gates` autonomy, a milestone whose tasks are all `done` needs
the owner to open the next one. Raise it with `open_question` — the driver files
the tracker item, never you — and report `no-tasks`. A live session flips the
milestone to `active` once the owner says so.

## Scope

Work stops at your one task. Discovered work goes in your report as a sentence,
not in your diff — a live session turns it into a task later. A diff that grew
past its acceptance criteria is harder to grade and harder to review, and the
grader judges what the criteria said, not what you added.
