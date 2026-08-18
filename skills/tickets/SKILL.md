---
name: tickets
description: Break a plan, spec, or the current conversation into a set of tracer-bullet tickets, each declaring its blocking edges, written as task blocks into the `.factory/backlog/` files the Factory driver parses.
disable-model-invocation: true
---

# Tickets

Break a plan, spec, or conversation into a set of **tickets** — tracer-bullet vertical slices, each declaring the tickets that **block** it.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes a reference (a spec path, an issue number or URL) as an argument, fetch it and read its full body and comments.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state of the code. Ticket titles and descriptions should use the project's domain glossary vocabulary, and respect ADRs in the area you're touching.

Look for opportunities to prefactor the code to make the implementation easier. "Make the change easy, then make the easy change."

### 3. Draft vertical slices

Break the work into **tracer bullet** tickets.

<vertical-slice-rules>

- Each slice cuts a narrow but COMPLETE path through every layer (schema, API, UI, tests) — vertical, NOT a horizontal slice of one layer
- A completed slice is demoable or verifiable on its own
- Each slice is sized to fit in a single fresh context window
- Any prefactoring should be done first

</vertical-slice-rules>

Give each ticket its **blocking edges** — the other tickets that must complete before it can start. A ticket with no blockers can start immediately.

**Wide refactors are the exception to vertical slicing.** A **wide refactor** is one mechanical change — rename a column, retype a shared symbol — whose **blast radius** fans across the whole codebase, so a single edit breaks thousands of call sites at once and no vertical slice can land green. Don't force it into a tracer bullet; sequence it as **expand–contract**. First expand: add the new form beside the old so nothing breaks. Then migrate the call sites over in batches sized by blast radius (per package, per directory), each batch its own ticket blocked by the expand, keeping CI green batch to batch because the old form still exists. Finally contract: delete the old form once no caller remains, in a ticket blocked by every migrate batch. When even the batches can't stay green alone, keep the sequence but let them share an integration branch that all block a final integrate-and-verify ticket — green is promised only there.

### 4. Quiz the user

Present the proposed breakdown as a numbered list. For each ticket, show:

- **Title**: short descriptive name
- **Blocked by**: which other tickets (if any) must complete first
- **What it delivers**: the end-to-end behaviour this ticket makes work

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the blocking edges correct — does each ticket only depend on tickets that genuinely gate it?
- Should any tickets be merged or split further?

Iterate until the user approves the breakdown.

### 5. Write the tickets into the backlog

Write the approved tickets as **task blocks** appended to the epic file they belong to — `.factory/backlog/e<n>-<kebab-name>.md` — in dependency order, blockers first. Start a new epic file when the work is its own theme, and add it to `.factory/backlog/index.md` under the milestone it belongs to, with its task count. The `## M<n>: … — <status>` milestone headings are machine-read: leave their shape exactly as found.

Work the **frontier**: any ticket whose blockers are all done. For a purely linear chain that means top to bottom.

Do NOT modify any task other than the ones you are adding.

<task-block-template>

## T-023: <Ticket title>
- What: the end-to-end behaviour this ticket makes work, from the user's perspective — not a layer-by-layer implementation list
- Type: AFK
- Status: todo
- Reqs: REQ-4, REQ-7
- Deps: T-021
- Acceptance:
  - Criterion 1
  - Criterion 2
- Verify: <command(s) that prove it>
- Notes: <anything the next session needs that the fields above cannot hold>
- Model: sonnet
- Effort: medium

</task-block-template>

Ids continue from the highest `T-` already in the backlog. `Deps:` carries the blocking edges, or `None`. `Reqs:` carries the REQ ids from the spec, when there is one.

The driver parses these blocks field by field, which forces four rules:

- **`Verify:` is ONE line.** Whatever follows the colon on that line is the whole value — chain several commands with `&&` and put any explanation in `Notes:`. A `Verify:` followed by an indented list parses as empty, and an empty `Verify:` hands the grader nothing to run.
- **`Acceptance:` criteria are executed as written** by a grader that has only this task, so each states observable behaviour plus the exact expectation — the input, the exact output or exit code or error contract, and the comparison target. `exit 2 with "error:" on stderr` grades consistently; "handles bad input gracefully" does not.
- **`Model:` and `Effort:` are required on every task.** `sonnet/low` mechanical and fully specified; `sonnet/medium` standard specified implementation; `sonnet/high` tricky but specified; `opus/*` where a cheaper model plausibly produces confidently-wrong output that tests miss. When torn between two tiers, take the higher one.
- **`Type:` is `AFK` or `HITL`.** AFK is a positive claim that a session can finish it alone. HITL means finishing it needs a human's judgment, and the task also carries `Gate: human (<reason>)`, which holds its PR for review even when green. Visual quality, game feel, aesthetics, and anything whose acceptance you cannot write as a check are HITL by construction.

Name interfaces, types, contracts and the modules that hold them — a module you are creating IS part of the contract. Avoid line numbers and open-file-X-edit-line-N instructions: a ticket can sit unstarted for weeks while the code moves underneath it, and a position is the first thing to rot. Avoid code snippets for the same reason. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it and note briefly that it came from a prototype. Trim to the decision-rich parts — not a working demo, just the important bits.
