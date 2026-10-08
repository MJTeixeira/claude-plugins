---
name: to-tickets
description: Break a plan, spec, or the current conversation into a set of tracer-bullet tickets, each declaring its blocking edges, published as issues on the repository's factory board (edges as GitHub blocked-by links).
disable-model-invocation: true
---

# To Tickets

Break a plan, spec, or conversation into a set of **tickets**: tracer-bullet vertical slices, each declaring the tickets that **block** it.

This repository has exactly one linked GitHub Project board, titled `factory: <repo>`. Every issue on that board is a task the factory will run, and a board issue whose body fails the factory's parser is refused and parked. Each ticket is one such task: one unattended session of roughly 150k to 200k tokens of context. That session reads the ticket's own issue body and nothing else: it has no GitHub login, so it cannot open the spec or any other issue.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes a reference (a spec path, an issue number or URL) as an argument, fetch it and read its full body and comments.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state of the code. Ticket titles and descriptions should use the project's domain glossary vocabulary.

Look for opportunities to prefactor the code to make the implementation easier. "Make the change easy, then make the easy change."

### 3. Draft vertical slices

Break the work into **tracer bullet** tickets.

<vertical-slice-rules>

- Each slice cuts a narrow but COMPLETE path through every layer (schema, API, UI, tests): vertical, NOT a horizontal slice of one layer
- A completed slice is demoable or verifiable on its own
- Each slice is sized to fit in a single fresh context window
- Any prefactoring should be done first

</vertical-slice-rules>

Give each ticket its **blocking edges**: the other tickets that must complete before it can start. A ticket with no blockers can start immediately.

**Wide refactors are the exception to vertical slicing.** A **wide refactor** is one mechanical change (rename a column, retype a shared symbol) whose **blast radius** fans across the whole codebase, so a single edit breaks thousands of call sites at once and no vertical slice can land green. Don't force it into a tracer bullet; sequence it as **expand–contract**. First expand: add the new form beside the old so nothing breaks. Then migrate the call sites over in batches sized by blast radius (per package, per directory), each batch its own ticket blocked by the expand, keeping CI green batch to batch because the old form still exists. Finally contract: delete the old form once no caller remains, in a ticket blocked by every migrate batch. When even the batches can't stay green alone, keep the sequence but let them share an integration branch that all block a final integrate-and-verify ticket; green is promised only there.

### 4. Quiz the user

Present the proposed breakdown as a numbered list. For each ticket, show:

- **Title**: short descriptive name
- **Blocked by**: which other tickets (if any) must complete first
- **What it delivers**: the end-to-end behaviour this ticket makes work

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the blocking edges correct: does each ticket only depend on tickets that genuinely gate it?
- Should any tickets be merged or split further?

Iterate until the user approves the breakdown.

### 5. Publish the tickets to the board

Find the board: the one project titled `factory: <repo>` in `gh project list --owner <owner>`.

Publish the approved tickets in dependency order (blockers first), so each blocking edge can name a real issue. For each ticket:

1. Create the issue in this repository: `gh issue create --title <title> --body-file <file>`, its body in the shape below.
2. Add it straight to the board: `gh project item-add <board number> --owner <owner> --url <issue url>`. There is no draft step; the board's workflow sets `Todo` when the item is added.
3. Wire its blocking edges: `gh issue edit <n> --add-blocked-by <m>`. Order lives only there; use no sub-issues.

Then add each ticket to the spec issue's `## Tasks` checklist, `- [ ] #<n>`, by editing the spec's body.

Work the **frontier**: any ticket whose blockers are all done. For a purely linear chain that means top to bottom.

Do NOT close the spec issue or modify it beyond its `## Tasks` checklist.

The body carries these fields and nothing else the factory reads, in exactly this shape:

<issue-template>

- Spec: #<spec issue>
- Acceptance:
  - <one criterion per bullet, each checkable against the code or a run, stating outright every value, name, path and decision it takes from the spec>
- Verify: `<one shell command that drives the product and fails on this commit>`
- Model: <sonnet, or opus for a task that needs judgment>
- Effort: <low, medium, high, xhigh or max>
- Risk: high <optional>

</issue-template>

- When `.claude/skills/verify-*/features/<name>.md` already drives the behaviour, write `- Verify: feature <name>`, bare, with no backticks.
- A Verify that only runs the test suite (`npm test`, `pytest`, `cargo test` and the like) is refused: the merge gate already runs the suite, so the line must drive the product. When no command obviously drives the behaviour, ask the user for one rather than invent it.
- The title says what the ticket delivers; the body holds nothing but the fields above.
- `- Spec:` is a back-link for people; the session never follows it. Before publishing, reread each body for a pointer standing in for a fact ("as in spec #52", "the values in the spec", "see #N") and replace it with what it points at.

Beyond the paths the spec fixes, avoid specific file paths or code snippets: they go stale fast. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it and note briefly that it came from a prototype. Trim to the decision-rich parts, not a working demo, just the important bits.
