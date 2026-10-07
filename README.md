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

Use any of them. Everything below is the setup path; the factory's full
manual — configuration, operations, contracts, gotchas — is
[`factory/FACTORY.md`](factory/FACTORY.md).

## Install

```
/plugin marketplace add MJTeixeira/claude-plugins
/plugin install code4food-live@code4food         # live sessions
/plugin install code4food-general@code4food      # review, for both
/plugin install code4food-engines@code4food      # godot and unity
```

Requirements: **Node.js ≥ 18**, **git**, and the **Claude Code CLI** logged in
(a Pro/Max subscription or an API key). For factories on a GitHub repo you
also need the **GitHub CLI** logged in (`gh auth login`); Bitbucket Cloud
repos use an Atlassian API token instead.

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

## Setting up a factory

Your project needs to be a git repo with a GitHub or Bitbucket Cloud remote
(private is fine). Factories run on **macOS or Linux** — Windows machines can
use code4food-live and pilot a factory repo as a live session, but not host one.

**Start with the specs, before any machinery**: the factory builds what the
specs say, and nothing more.

### 1. Machine setup (once per machine)

```sh
git clone https://github.com/MJTeixeira/claude-plugins ~/.factory/runtime
node ~/.factory/runtime/factory/driver/deploy-runtime.mjs
```

Factories run from that machine-resident runtime, not from your project. The
second command also provisions the code4food plugins from the runtime clone — on a
factory machine, get them this way rather than via `/plugin marketplace add`,
because the two sources would fight over the `code4food` marketplace name and
doctor requires the marketplace to point at the runtime. It is also the update
verb (below).

### 2. Set the project up

The wizard — one command, 11 questions, everything mechanical done for you:

```sh
node ~/.factory/runtime/factory/driver/init.mjs --project /path/to/project
```

Enter accepts every default. The two answers worth thinking about are
**autonomy** (start at `pr-only` — every task becomes a PR and you merge) and
**schedule** (`manual` while you're still watching it, which is a valid, declared
end state — doctor checks that what you declared matches what's installed).
Every question sets one `config.json` key, so FACTORY.md §Configuration
reference is the one place that explains them — and every other knob you can
tune afterwards.

Then: specs into `.factory/spec/`, compile the backlog
(`cat ~/.factory/runtime/factory/prompts/compile-spec.md | claude`, run from
the project), and run **one supervised window** before you schedule anything:

```sh
node ~/.factory/runtime/factory/driver/factory.mjs dev --project /path/to/project
```

Watch it take the first task all the way to a PR. Cap it first —
`"maxSessionsPerWindow": 2, "sessionTimeoutMin": 15` — then restore the
defaults.

### 3. Confirm it's healthy

```sh
node ~/.factory/runtime/factory/driver/factory.mjs doctor --project /path/to/project
```

Doctor is a read-only checklist of everything that has actually cost someone a
lost night: tools on the scheduler's PATH, workspace trust, auth scopes, stale
runtime, schedule drift, backlog parseability. **Setup is done when doctor is
green — not before.** Run it after any change to the machine, tokens, or
schedulers.

## Day to day

- **Feed it**: drop markdown notes in `.factory/inbox/` **and commit them** (an
  uncommitted note is not input — triage reads the base branch), or file items
  on the factory's tracker. The morning triage folds them in: inbox notes
  become backlog tasks, tracker items become daily-log lines for a live
  session to ticket.
- **It asks you**: questions land on the tracker — repo issues by default, or
  a Jira project or Discord channel if you route them there. Answer in your own
  time; the next triage picks it up. The `[factory] daily log` item is its report.
- **Review PRs**: under `pr-only` this is the job. Comments on `[factory]` PRs
  are read at triage.
- **Stop it**: `touch <state>/STOP` finishes the current session then halts.
  Longer pause: `"enabled": false` in the machine config.

Optional extras, all off by default and all documented in FACTORY.md: a live
web **dashboard** over every factory on the machine, **Telegram**
notifications, two-way **kanban boards**, alternative **trackers**, and
read-only status **mirrors** for stakeholders.

## Updating

```sh
node ~/.factory/runtime/factory/driver/deploy-runtime.mjs
```

One command per **machine**, not per project: it fetches, gates the candidate
(syntax check plus every registered factory's doctor, read-only), and
fast-forwards the runtime only when green — so the whole machine advances at
once, or not at all. It refuses while a window is running. Live-session
users update with `/plugin` instead.

## Where things live

A factory is a **machine** product. Your repo carries only work data —
`.factory/{spec,backlog,inbox}` — while config, secrets, logs and the STOP
file live outside git at `~/.factory/projects/<key>/`. Git can't clean it,
clones don't carry it, and machines never share factory config through the
repo. Full detail, and the contracts that make live sessions and multi-machine
use safe, are in [`factory/FACTORY.md`](factory/FACTORY.md).
