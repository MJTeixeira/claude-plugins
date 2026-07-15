---
description: Wire the lean workflow into this project (CLAUDE.md block + optional statusline)
allowed-tools: Bash(ls:*), Bash(grep:*), Read, Write, Edit
---

## Context

- Project CLAUDE.md: !`ls CLAUDE.md 2>/dev/null || echo "none yet"`
- Existing managed block: !`grep -c "BEGIN LEAN-WORKFLOW MANAGED BLOCK" CLAUDE.md 2>/dev/null || echo 0`

## Task

The skills, `/commit` command, code-reviewer agent, and protected-branch guard
hook already come from this plugin — nothing to copy for those. This command
wires the two pieces a plugin cannot inject. Use the Read/Write/Edit tools for
all file work (not shell copy/merge commands) so this behaves identically on
macOS, Linux, and Windows:

1. **CLAUDE.md managed block.** Read `${CLAUDE_PLUGIN_ROOT}/claude-md-block.md`
   and append its full contents to the project's `CLAUDE.md` (create the file
   if missing). Idempotent: if the `BEGIN LEAN-WORKFLOW MANAGED BLOCK` marker
   already exists, replace everything between (and including) the BEGIN and END
   marker lines with the fresh copy instead of appending. Never touch content
   outside the markers.

2. **Statusline (only if the user asked for it in the command arguments).**
   Read `${CLAUDE_PLUGIN_ROOT}/statusline/statusline.cjs` and Write it to
   `.claude/statusline.cjs` (no `chmod` needed — it runs via `node`; the .cjs
   extension keeps it CommonJS even in `"type": "module"` projects, and keeps
   project linters that sweep .js files off it). Then set in
   `.claude/settings.json`:
   `{"statusLine": {"type": "command", "command": "node .claude/statusline.cjs", "padding": 0}}`
   Merge into any existing `.claude/settings.json` by reading it, setting the
   `statusLine` key, and writing it back — preserve every other key. Do NOT use
   `jq` (it isn't present on Windows); edit the JSON with the Read/Write/Edit
   tools. Create the file if it's missing. A legacy `.claude/statusline.sh`
   or `.claude/statusline.js` left over from an older install is now inert
   (settings.json no longer points at it) — mention it in your report so the
   user can remove it, but don't fail if it's still there.

Then report what was installed, updated, or already current. Do not commit
anything.
