---
description: Bootstrap or update this machine's Factory runtime (~/.factory/runtime)
allowed-tools: Bash(git clone:*), Bash(node:*), Bash(ls:*)
---

## Context

- Runtime present: !`ls -d ~/.factory/runtime 2>/dev/null || echo "NOT BOOTSTRAPPED"`

## Task

The Factory runs from a per-machine runtime clone at `~/.factory/runtime` —
every scheduler, watchdog, dashboard, and session worktree gets its tooling
from it. It advances ONLY through the gated deploy script (syntax check on
every driver module + a read-only doctor pass over every registered factory;
a failed gate leaves the runtime untouched).

1. If the runtime is NOT bootstrapped yet:
   `git clone https://github.com/MJTeixeira/claude-plugins ~/.factory/runtime`
2. Update (gated):
   `node ~/.factory/runtime/factory/driver/deploy-runtime.mjs`
3. Report the result. If the deploy output warns that `dashboard.mjs` changed,
   remind the user to restart the dashboard service. If the gate REFUSED the
   deploy, report the reason verbatim and stop — never force the runtime
   forward by hand.
