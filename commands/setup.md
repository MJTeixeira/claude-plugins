---
description: Wire the workflow into this project (opt-in via .docs + optional statusline)
allowed-tools: Bash(ls:*), Bash(grep:*), Read, Write, Edit
---

## Context

- Project CLAUDE.md: !`ls CLAUDE.md 2>/dev/null || echo "none yet"`
- Legacy managed block: !`grep -c "BEGIN LEAN-WORKFLOW MANAGED BLOCK" CLAUDE.md 2>/dev/null || echo 0`
- Agent docs: !`ls .docs/index.md 2>/dev/null || echo "no .docs yet"`

## Task

The skills, `/commit` command, code-reviewer agent, and hooks already come
from this plugin — nothing to copy for those. The workflow contract itself
is injected automatically at session start into projects that opt in: the
opt-in signal is `.docs/index.md`. This command creates that opt-in and
cleans up the legacy per-project copy of the contract. Use the
Read/Write/Edit tools for all file work (not shell copy/merge commands) so
this behaves identically on macOS, Linux, and Windows:

1. **Opt-in (docs bootstrap).** If `.docs/index.md` is missing, run the
   `docs` skill's initial pass: create `.docs/index.md` (Commands verified
   against the repo's real config — package.json, Makefile, CI — plus the
   Areas map from a structural scan) and `.docs/known-issues.md` with its
   header. No area files — those grow with the work. Docs left by other
   tools are neither followed nor migrated; list them in the report as
   deletion candidates. If `.docs/index.md` already exists, the project is
   already opted in — say so and change nothing.

2. **Migrate the legacy CLAUDE.md block.** If the project's CLAUDE.md
   contains the `BEGIN LEAN-WORKFLOW MANAGED BLOCK` marker, delete
   everything between (and including) the BEGIN and END marker lines and
   collapse the leftover blank lines. Never touch content outside the
   markers, and never create CLAUDE.md just for this. The plugin's
   SessionStart hook injects the current contract from now on — a
   committed copy is redundant and goes stale.

3. **Statusline (only if the user asked for it in the command arguments).**
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

Then report what was installed, updated, or already current — and remind
the user that the contract loads at session start: run `/clear` (or start
a new session) to activate it now. Do not commit anything.
