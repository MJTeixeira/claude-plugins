---
description: Wire the lean workflow into this project (CLAUDE.md block + optional statusline)
allowed-tools: Bash(cat:*), Bash(ls:*), Bash(cp:*), Bash(chmod:*), Bash(jq:*)
---

## Context

- Project CLAUDE.md: !`ls CLAUDE.md 2>/dev/null || echo "none yet"`
- Existing managed block: !`grep -c "BEGIN LEAN-WORKFLOW MANAGED BLOCK" CLAUDE.md 2>/dev/null || echo 0`

## Task

The skills, `/commit` command, code-reviewer agent, and protected-branch guard
hook already come from this plugin — nothing to copy for those. This command
wires the two pieces a plugin cannot inject:

1. **CLAUDE.md managed block.** Append the full contents of
   `${CLAUDE_PLUGIN_ROOT}/claude-md-block.md` to the project's `CLAUDE.md`
   (create the file if missing). Idempotent: if the
   `BEGIN LEAN-WORKFLOW MANAGED BLOCK` marker already exists, replace
   everything between (and including) the BEGIN and END marker lines with the
   fresh copy instead of appending. Never touch content outside the markers.

2. **Statusline (only if the user asked for it in the command arguments).**
   Copy `${CLAUDE_PLUGIN_ROOT}/statusline/statusline.sh` to
   `.claude/statusline.sh`, `chmod +x` it, and set in `.claude/settings.json`:
   `{"statusLine": {"type": "command", "command": ".claude/statusline.sh", "padding": 0}}`
   (merge with jq — preserve other keys).

Then report what was installed, updated, or already current. Do not commit
anything.
