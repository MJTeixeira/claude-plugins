---
name: implement
description: Build the backlog task this factory session was given — the order of work from an empty branch to an open PR. Use this whenever an unattended session is about to start writing code for a task, or is midway through one and unsure what comes next. It carries the red-green loop and names the seams where `verify` and `code-review` take over. The driver owns the backlog, the PR call and the merge, so this covers the building, not the bookkeeping.
---

# Implement a task

Implement the work described by your task's `What:` and `Acceptance:` lines. If
you don't have a task yet, the `backlog` skill covers picking one.

Work on a branch `factory/<task-id>-<slug>` in the worktree you were given.

Build in a red-green loop. On every slice, your FIRST edit is the failing
test, not the source — before you write any code, write ONE failing test at a
seam the task already has (its `Acceptance:` criteria name the observations a
grader will make; those are your seams):

1. RED: write ONE failing test, and watch it fail for the right reason.
2. GREEN: the smallest change that passes it.
3. Repeat until the acceptance criteria are covered, then REFACTOR on green.

Seams bound WHERE tests go, never whether they come first. Do not improvise
new test seams — extracting a function just so it can be tested in isolation
creates spaghetti tests; test through the seams the design already offers. If
no public boundary can observe an acceptance criterion, that is a real finding
about the task, not a licence to test internals or to skip the test — say so
in your report.

Two test anti-patterns void the loop even when the order is right:

- **Tautological** — the assertion recomputes the expected value the way the
  code does, so it passes by construction. Expected values come from an
  independent source of truth: a known-good literal, a worked example, the
  spec.
- **Horizontal slicing** — writing all tests first, then all implementation.
  Bulk tests verify imagined behavior. Work in vertical slices: one test, one
  minimal implementation, repeat.

Run typechecking and single test files as you go; run the full
suite once at the end.

**Commit and push after every green step.** You can be killed without warning —
a turn cap, a timeout, the window closing — and the worktree is deleted when you
stop. Anything uncommitted dies with it, and unpushed commits are stranded refs
the next session will never find. A killed session should cost minutes, not
everything you learned.

Run the task's `Verify:` line exactly as written — it is the line the grader
will run — then use `verify` to drive the real product headlessly. Tests prove
the diff; driving the product proves the task.

Then use `code-review` on the work. Under auto-merge there is no human between
you and the base branch, so this is the only code review the PR gets, and it has
to finish before the PR opens — a review racing the merge gate arrives too late.

Open the PR with the `create_pr` tool and report `review` with its url
immediately. You hold no forge credentials; the driver makes the call. The PR
body must end with a `## Review` section carrying the review pass's aggregated
report and what you changed in response to each finding (or the review's
statement that the diff was clean) — a review nobody can read might as well
not have run.

Two things you never do here, because the driver does them and doing both
corrupts the state: writing the task's `Status:` or `Notes:`, and merging.
Report what happened and stop.

If you run out of road — three failed attempts with nothing new learned — say so
through `open_question` and report `blocked` rather than grinding. Waiting costs
the window nothing; thrashing costs it everything.
