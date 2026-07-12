---
name: handoff
description: Stopping mid-task (context running long, window ending, blocked) or starting a session where .docs/HANDOFF.md exists — carry work across sessions.
---

# Session handoff

`.docs/HANDOFF.md` carries in-flight work between sessions. It describes ONE
task in progress; it is not a journal.

## Writing (when stopping before the task is done)

Triggers: context is getting long, an execution window is ending, or you're
blocked and stopping. Write it as your LAST act, when your knowledge is
freshest:

```markdown
# HANDOFF: <task title / backlog id>
- Branch: <branch, worktree path if any>
- Done: <what is complete and verified, 1-3 bullets>
- Next: <the exact next action to take, specific enough to start cold>
- State: <uncommitted files? failing test? half-applied migration? — anything
  a fresh session would not expect>
- Open questions: <decisions pending, who/what they're waiting on; "None">
```

Budget ≤200 words. Facts a cold reader needs — not narrative. Commit it if
the branch is pushed; otherwise leave it in the worktree.

## Reading (at session start)

If `.docs/HANDOFF.md` exists: read it FIRST, before exploring. Trust `Next`
as your starting point, but verify `State` against reality (git status, test
run) — the previous session may have been cut mid-action.

## Deleting

Delete the file in the same change that completes the task (the finishing
pass). A stale handoff is worse than none — if you find one describing work
that's already merged, delete it on the spot.
