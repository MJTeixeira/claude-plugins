---
name: implement
description: "Implement a piece of work based on a backlog task."
disable-model-invocation: true
---

Implement the work described by the backlog task the user names.

Claim it first: open a draft PR with the task id in its title, so other sessions and any factory window route around you.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Run the task's `Verify:` line, then use /verify to drive the real product.

Once done, use /code-review to review the work.

Commit your work to the current branch.

Update the task's `Status:` and add a `Notes:` line with the PR link, then take the PR out of draft. A live session is its own driver — nothing else will write it.
