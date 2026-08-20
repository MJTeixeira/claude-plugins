---
name: tickets
description: Author a backlog task block from an inbox note in an unattended triage window — the completeness bar a note must clear to become a runnable task, the block's shape and the driver's parse rules, and when to park instead. Use this whenever a factory triage session is turning a `.factory/inbox/` note into work, or judging whether what it can write is complete enough for a session to run alone. The live skillset's `tickets` skill is the attended half, with a human to quiz; this one has nobody to ask.
---

# Author a ticket from an inbox note

An inbox note is a human's raw input: an idea, a bug, a deploy failure, a board
card. Your job is to turn it into ONE task block a fresh session can finish
alone — or, when the note cannot carry one, to author what you have and **park
it** so the owner finishes it.

A live `/tickets` session ends by quizzing the user and iterating until they
approve. You have nobody to quiz. **The bar below replaces that approval**: a
task enters the working pool only when you can meet it from the note plus the
code in front of you. Guessing past it wastes a whole session on the wrong
thing, which costs far more than a park.

## The bar

`Status: todo` only when every one of these holds. Any miss ⇒ park.

1. **One vertical slice.** The note describes a narrow but COMPLETE path through
   every layer it touches (schema, API, UI, tests), demoable on its own, sized
   to fit one fresh context window.
2. **`What:` is behaviour**, stated end-to-end from the user's perspective —
   not a layer-by-layer implementation list, and not a restatement of the note.
3. **Every `Acceptance:` criterion is observable**: the input, the exact output
   or exit code or error contract, and the comparison target. A grader that has
   only this task executes them as written. `exit 2 with "error:" on stderr`
   grades consistently; "handles bad input gracefully" does not.
4. **`Verify:` runs commands that already exist in this repo** — you checked,
   not invented. An invented command is a red task with a green-looking line.
5. **`Type: AFK` is honest.** It is a positive claim that a session finishes
   this alone. Visual quality, game feel, aesthetics, product sign-off, and
   anything whose acceptance you cannot write as a check are HITL by
   construction — those carry `Gate: human (<reason>)`.
6. **No decision is yours to make.** Nothing in the task rests on a choice the
   note left open, contradicts `.factory/spec/`, or would need a spec change.
7. **`Model:` and `Effort:` follow from the task**, judged against the spec per
   the `code4food-factory:backlog` rubric — never a blanket default.

Two shapes never clear the bar, no matter how clear the note:

- **More than one ticket's worth of work.** Breaking work into a sequenced set
  is a live job — the edges between slices are exactly what the quiz settles.
  Park a single task naming the note and asking for a live breakdown.
- **A wide refactor** — one mechanical change (rename a column, retype a shared
  symbol) whose blast radius fans across the codebase, so no single slice lands
  green. It needs an expand–contract sequence; park it.

## Parking

Author the block anyway — the note's content belongs in the backlog, not in a
file nobody reads — then:

- `Status: needs-human`
- `Notes:` states **what is missing as a specific question the owner can answer
  in one line**, plus the note's gist. "Should the retry back off, and to what
  ceiling?" clears; "needs more detail" does not.
- Fill every field you legitimately can. A parked task the owner answers flips
  to `todo` at the next triage and runs — leave nothing else for them to write.
- Report it in the daily log under **waiting on owner: T-…**.

`needs-human` is the right park here, not `blocked`: only the owner clears it.
Never downgrade it.

## Not yours at all

- A note proposing a change to the factory's own tooling (driver, prompts,
  schedulers, hooks) never becomes a task — it runs from the machine runtime,
  outside this repo. Call `open_question` quoting the note, and name any
  in-repo parts (scripts, docs, CI) in the daily log.
- A note that is an FYI, a question, or an answer — not work — gets a daily-log
  line quoting it, no task.

## The block

Append the task to the epic file it belongs to,
`.factory/backlog/e<n>-<kebab-name>.md`. Start a new epic file only when the
note is its own theme, and add it to `.factory/backlog/index.md` under the
milestone it belongs to. The `## M<n>: … — <status>` headings are machine-read:
leave their shape exactly as found, and let the driver's counter refresh own
the `n/m done` numbers. Ids continue from the highest `T-` in the backlog.
Touch no task other than the one you are adding.

<task-block-template>

## T-023: <Ticket title>
- What: the end-to-end behaviour this ticket makes work, from the user's perspective
- Type: AFK
- Status: todo
- Reqs: REQ-4, REQ-7
- Deps: T-021
- Acceptance:
  - Criterion 1
  - Criterion 2
- Verify: <command(s) that prove it>
- Notes: from inbox note `<filename>` — <gist, plus anything the fields above cannot hold>
- Model: sonnet
- Effort: medium

</task-block-template>

The driver parses these blocks field by field, which forces three rules:

- **`Verify:` is ONE line.** Whatever follows the colon on that line is the
  whole value — chain commands with `&&` and put explanation in `Notes:`. A
  `Verify:` followed by an indented list parses as empty, and an empty
  `Verify:` hands the grader nothing to run.
- **`Deps:` carries blocking edges, or `None`.** `Reqs:` carries the REQ ids
  from `.factory/spec/`, when there is one.
- **`Model:` and `Effort:` are required.** `sonnet/low` mechanical and fully
  specified; `sonnet/medium` standard specified implementation; `sonnet/high`
  tricky but specified; `opus/*` where a cheaper model plausibly produces
  confidently-wrong output that tests miss. Torn between tiers ⇒ take the
  higher one.

Name interfaces, types, contracts and the modules that hold them — a module you
are creating IS part of the contract. Avoid line numbers and
open-file-X-edit-line-N instructions: a ticket can sit unstarted for weeks while
the code moves underneath it, and a position is the first thing to rot. Avoid
code snippets for the same reason.
