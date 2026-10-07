---
name: implement
description: "Implement a board issue: tdd, its Verify line, verify, comment cleanup, review, then a PR that closes it."
disable-model-invocation: true
---

Implement the work described by the board issue the user names. Read it with `gh issue view <n>`: its `Acceptance:` bullets are the work, and its `Verify:` line proves it.

Claim it first: assign it to yourself with `gh issue edit <n> --add-assignee @me`. The factory holds any board issue assigned to someone else, so a window routes around you.

Work in this order:

1. Use /tdd where possible, at pre-agreed seams. Run typechecking regularly, single test files regularly, and the full test suite once at the end.
2. Run the issue's `Verify:` line. A bare `feature <name>` names `.claude/skills/verify-*/features/<name>.md`: drive it through that verify skill. Then use /verify to drive the real product. On a failure, use /diagnosing-bugs.
3. Commit your work to the current branch.
4. Call the Skill tool with `pstack:no-comments` to clean up comments.
5. Call the Skill tool with `code4food-general:review` to review the work.
6. Call the Skill tool with `pstack:poteto-mode` and follow its "Opening a PR" playbook. The PR body carries `Closes #<n>`, so the issue closes when the PR merges.
