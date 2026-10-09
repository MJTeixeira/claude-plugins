# code4food plugins for Claude Code

Three plugins, one marketplace:

- **`code4food-live`** — skills for sessions with a human in the room:
  [mattpocock/skills](https://github.com/mattpocock/skills) retargeted at a
  factory board (the spec is an issue, each task an issue on the board), one
  implement path through tdd, verify, review and a PR, and HumanLayer's
  `show-me` and `visual-pr`. Skills only: no injected contract, no hooks, no
  agents. See NOTICE.md.
- **`code4food-general`** — skills that live sessions and factory sessions
  both use. Today one: `/code4food-general:review`, which makes a working
  change good against the repository's own standards, its issue's acceptance
  criteria and its docs, and commits the fixes. Built on mattpocock/skills
  and pstack — see `general/NOTICE.md`.
- **`code4food-engines`** — `godot` and `unity`, for game repositories. Install
  it, disable it machine-wide (`claude plugin disable code4food-engines@code4food
  --scope user`), and enable it in each game repository's own
  `.claude/settings.json`: `"enabledPlugins": {"code4food-engines@code4food": true}`.

Use any of them. Everything below is the setup path.

## Install

```
/plugin marketplace add MJTeixeira/claude-plugins
/plugin install code4food-live@code4food         # live sessions
/plugin install code4food-general@code4food      # review, for both
/plugin install code4food-engines@code4food      # godot and unity
```

Requirements: **Node.js ≥ 18**, **git**, and the **Claude Code CLI** logged in
(a Pro/Max subscription or an API key). `code4food-live` also needs the
**GitHub CLI** logged in (`gh auth login`).

## Just the status line

Want the status line without either plugin — no marketplace, nothing
installed? One command:

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/MJTeixeira/claude-plugins/main/statusline/install.cjs -o /tmp/cf-statusline-install.cjs && node /tmp/cf-statusline-install.cjs
```

```powershell
# Windows (PowerShell)
iwr https://raw.githubusercontent.com/MJTeixeira/claude-plugins/main/statusline/install.cjs -OutFile "$env:TEMP\cf-statusline-install.cjs"; node "$env:TEMP\cf-statusline-install.cjs"
```

It downloads `statusline.cjs` to `~/.claude/statusline.cjs` and merges the
`statusLine` key into `~/.claude/settings.json` — every other key in that
file is left exactly as it was, and if you've already got a *different*
`statusLine` configured, it leaves that alone too and just tells you where
the script landed. Safe to run more than once. Requirements: **Node.js ≥
18** and **git** — nothing else, no npm dependencies. Start a new Claude
Code session (or restart this one) to see it — `statusLine` is read at
session start.

Prefer not to pipe a download straight into `node`? Read
[`statusline/install.cjs`](statusline/install.cjs) first, or skip it
entirely: save [`statusline/statusline.cjs`](statusline/statusline.cjs) to
`~/.claude/statusline.cjs` yourself and add the same key to
`~/.claude/settings.json` by hand:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/statusline.cjs"
  }
}
```

Either way you get the same two lines: model + effort, branch and
dirty-file counts, context size and percentage (flagged past 200k tokens),
and the open PR's number and review state on top; repo name, input/output
token counts, 5-hour and 7-day rate-limit usage, and the active output
style underneath. Nothing is injected into your project and there's
nothing to set up per-repo.

## Using code4food-live

The flow targets a repository with one linked GitHub Project board titled
`factory: <repo>`: every issue on that board is a task a factory runs.
`/wayfinder` when the effort is too big to hold at once, then `/grill-me` →
`/to-spec` (the spec becomes an issue, kept off the board) → `/to-tickets`
(each task an issue, added straight to the board) → `/implement` (one board
issue per fresh window: tdd, its `Verify:` line, verify, comment cleanup,
`code4food-general:review`, then the PR). On-ramps: `/diagnosing-bugs` when
something is broken, `/improve-codebase-architecture` for deepening work,
`/research` before a decision that needs reading, `/retro` to turn sessions
and reviews into coding standards or lints, `/teach` when the project's
technology is new to you, `/wait-what` when an explanation does not land.
`/show-me` and `/visual-pr` run only when you type them.

The method skills — `grilling`, `domain-modeling`, `codebase-design`, `tdd`,
`verify`, `prototype`, `wizard`, `writing-for-agents` — fire on their own where
the flow names them; you rarely type them. `implement` calls pstack's
`no-comments` and `poteto-mode`, so install pstack beside it.
