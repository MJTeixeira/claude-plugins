---
name: worktrees
description: Need an isolated workspace for feature-sized work while the repo sits on a protected branch (main/master/dev).
---

# Git worktrees

## Create

From the main worktree root:

```sh
git worktree add ../<repo-name>-<branch-name> -b <branch-name>
```

Derive `<branch-name>` from the task (kebab-case, e.g. `add-invoice-export`).
Then `cd` into the new worktree and STAY there for the rest of the task — every
file path and command from now on runs against this directory, not the
original one.

## Symlink live gitignored assets

Worktrees don't carry gitignored files, and some of them are load-bearing.
Check the main worktree for these and symlink each one that exists:

```sh
ln -s <main-worktree>/.env.local .env.local     # and .env, .env.development…
ln -s <main-worktree>/data data                  # local databases, fixtures
```

Skim `.gitignore` for other entries that hold live state (uploads/, .cache
with seeded data). Symlink state, don't copy it — and never symlink
`node_modules`/build dirs; those are per-worktree.

## Setup — conditional, not ritual

- Install dependencies ONLY if the task will run code or tests AND
  `node_modules` (or the language equivalent) is absent or the lockfile differs
  from the main worktree. Otherwise skip.
- Do NOT run the full test suite as a setup step. The first RED test run of
  the `tdd` cycle establishes your baseline for the code you touch.

## Cleanup (after merge/PR)

From the main worktree:

```sh
git worktree remove ../<repo-name>-<branch-name>
git branch -d <branch-name>          # only if merged
```

If the worktree has uncommitted changes or holds the only copy of something,
stop and ask before removing.
