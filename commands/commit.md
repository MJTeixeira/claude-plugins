---
description: Commit the current work in one shot
allowed-tools: Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git branch:*), Bash(git add:*), Bash(git commit:*)
---

## Context

- Branch: !`git branch --show-current`
- Status: !`git status --short`
- Diff: !`git diff HEAD`
- Recent subjects (match their style): !`git log --oneline -10`

## Task

Create ONE commit for the work above, in a single message with no other
text:

1. If the branch is main/master/dev: stop and say so — never commit there.
2. `git add` exactly the files that belong to this change — never `-A`
   blindly; leave scratch and unrelated files behind.
3. Commit. Subject: `<area>: <imperative summary>`, ≤ 72 chars, matching
   the repo's existing style; body only when the why isn't visible in the
   diff.

Do not push, do not open a PR, do not print anything beyond the commit
result.
