# code4food plugins for Claude Code

Two plugins, one marketplace:

- **`code4food-skillset`** — the Live skillset, for sessions with a human in
  the room: a typed flow — chart, grill, spec, tickets, implement — that
  terminates in factory-runnable backlog tasks, plus the method skills the
  flow names at its seams (tdd, code-review, verify, diagnosing-bugs, and
  more). Skills only: no injected contract, no hooks, no agents. Built on
  [mattpocock/skills](https://github.com/mattpocock/skills) — see NOTICE.md.
- **`code4food-factory`** — autonomous spec-driven development: Claude builds
  a fully-specced product alone in scheduled daily windows and opens pull
  requests for you to review. Ships the skills a factory window loads, the
  attended-side speccing/setup skills, and the driver itself.

Use either or both. Everything below is the setup path; the factory's full
manual — configuration, operations, contracts, gotchas — is
[`factory/FACTORY.md`](factory/FACTORY.md).

## Install

```
/plugin marketplace add MJTeixeira/claude-plugins
/plugin install code4food-skillset@code4food     # interactive workflow
/plugin install code4food-factory@code4food      # autonomous factory
```

Requirements: **Node.js ≥ 18**, **git**, and the **Claude Code CLI** logged in
(a Pro/Max subscription or an API key). For factories on a GitHub repo you
also need the **GitHub CLI** logged in (`gh auth login`); Bitbucket Cloud
repos use an Atlassian API token instead.

## Just the status line

Want the status line without either plugin — no marketplace, nothing
installed? Grab one file.

**1. Save the script** to `~/.claude/statusline.cjs`:

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/MJTeixeira/claude-plugins/main/statusline/statusline.cjs -o ~/.claude/statusline.cjs
```

```powershell
# Windows (PowerShell)
iwr https://raw.githubusercontent.com/MJTeixeira/claude-plugins/main/statusline/statusline.cjs -OutFile "$env:USERPROFILE\.claude\statusline.cjs"
```

Or open [`statusline/statusline.cjs`](statusline/statusline.cjs) and save it
yourself — it's one plain file, nothing to inspect that isn't right there.

**2. Point Claude Code at it** — merge this into `~/.claude/settings.json`
(merge the key in if the file already has other settings; don't overwrite it):

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/statusline.cjs"
  }
}
```

Requirements: **Node.js ≥ 18** and **git** — nothing else. It's plain Node
(no npm dependencies, no `jq`, no bash) so the same file runs unmodified on
macOS, Linux and Windows, and it reads git state itself rather than
shelling out to anything that might not be installed.

Two lines: model + effort, branch and dirty-file counts, context size and
percentage (flagged past 200k tokens), and the open PR's number and review
state on top; repo name, input/output token counts, 5-hour and 7-day
rate-limit usage, and the active output style underneath. Nothing is
injected into your project and there's nothing to set up per-repo.

## Using the skillset

Run **`/code4food-skillset:setup`** once per repo: it configures the backlog
and spec destinations, the inbound issue tracker, the triage labels and the
doc layout the rest of the flow assumes.

Don't remember which skill you want? Type **`/route`** — it's the router over
everything below, and the only skill whose job is to name the others.

The flow, typed: `/chart` when the effort is too big to hold at once, then
`/grill` or `/grill-with-docs` → `/spec` → `/tickets` → `/implement` (one per
fresh window), with `/handoff` when a session stops mid-task. On-ramps:
`/triage` for inbound issues and external PRs, `/diagnosing-bugs` when
something is broken, `/improve-codebase-architecture` for deepening work,
`/to-questionnaire` when a decision needs someone else's knowledge, `/teach`
when the project's technology is new to you, `/wait-what` when an explanation
does not land.

The method skills — `grilling`, `domain-modeling`, `tdd`, `code-review`,
`verify`, `prototype`, `research`, `codebase-design`, `diagnosing-bugs`,
`wizard`, `resolving-merge-conflicts`, `writing-for-agents` — fire on their
own where the flow names them; you rarely type them.

The flow terminates in `.factory/backlog/` — the same format the Factory
driver parses, whether or not a factory is registered for the repo. A
registered factory picks the tasks up unattended; without one, the backlog
simply has no second consumer yet.

## Setting up a factory

Your project needs to be a git repo with a GitHub or Bitbucket Cloud remote
(private is fine). Factories run on **macOS or Linux** — Windows machines can
use the skillset and pilot a factory repo as a live session, but not host one.

**Start with the specs, before any machinery.** With just the factory plugin
installed — on any OS, no factory host needed — say *"spec this project"* in
the repo. The `spec` skill runs deep interview sittings and writes
`.factory/spec/` files, finishing with a red-team pass that resolves or
owner-gates every judgment call. This is the highest-leverage hour of the whole
setup: **the factory builds what the specs say, and nothing more.**

### 1. Machine setup (once per machine)

```sh
git clone https://github.com/MJTeixeira/claude-plugins ~/.factory/runtime
node ~/.factory/runtime/factory/driver/deploy-runtime.mjs
```

Factories run from that machine-resident runtime, not from your project. The
second command also provisions both plugins from the runtime clone — on a
factory machine, get them this way rather than via `/plugin marketplace add`,
because the two sources would fight over the `code4food` marketplace name and
doctor requires the marketplace to point at the runtime. It is also the update
verb (below).

### 2. Set the project up

Easiest: open `claude` in the project and say **"set up a factory here"**. The
`factory-setup` skill interviews you, turns your specs into `.factory/spec/`
files, runs the wizard, compiles the backlog, and offers a supervised first
window. You only paste tokens.

The manual path is the wizard — one command, 11 questions, everything
mechanical done for you:

```sh
node ~/.factory/runtime/factory/driver/init.mjs --project /path/to/project
```

Enter accepts every default. The two answers worth thinking about are
**autonomy** (start at `pr-only` — every task becomes a PR and you merge) and
**schedule** (`manual` while you're still watching it, which is a valid, declared
end state — doctor checks that what you declared matches what's installed).
See FACTORY.md §Setup for what each question means, and §Configuration
reference for every knob you can tune afterwards.

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
once, or not at all. It refuses while a window is running. Interactive
skillset users update with `/plugin` instead.

## Where things live

A factory is a **machine** product. Your repo carries only work data —
`.factory/{spec,backlog,inbox}` — while config, secrets, logs and the STOP
file live outside git at `~/.factory/projects/<key>/`. Git can't clean it,
clones don't carry it, and machines never share factory config through the
repo. Full detail, and the contracts that make live sessions and multi-machine
use safe, are in [`factory/FACTORY.md`](factory/FACTORY.md).
