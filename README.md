# code4food plugins for Claude Code

Two plugins, one marketplace:

- **`code4food-skillset`** — a development workflow for interactive Claude
  Code, built on one rule: **process is proportional to task size**. Ceremony
  goes where the stakes are, so a typo doesn't get a planning phase and a
  feature doesn't get skipped review.
- **`code4food-factory`** — autonomous spec-driven development: Claude builds
  a fully-specced product alone in scheduled daily windows and opens pull
  requests for you to review.

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

## Using the skillset

Per project, once:

```
/code4food-skillset:setup
```

That opts the project in by creating `.docs/index.md` — the signal the plugin
watches. From then on the workflow contract is injected at session start
wherever that file exists; nothing is written into your `CLAUDE.md` (a legacy
managed block from an older install gets removed). Ask for the statusline in
the same message if you want the cost/token bar.

**Check it worked:** open `claude` in the project and ask for something tiny
("fix this typo in the README"). It should just make the edit — no plan, no
subagents, no ceremony. Bigger asks pick up more process on their own.

What you get: the task-sizing router; skills for the work that benefits from
discipline (dev-workflow, tdd, debugging, worktrees, finishing, verify, docs,
handoff, auth, db-migrations, deploy, plus Unity and Godot); a `/commit`
command; a code-reviewer subagent; a branch guard that blocks commits on
`main`/`master`/`dev`; and the `.docs/` convention — agent-facing project docs
loaded a slice at a time.

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

- **Feed it**: drop markdown notes in `.factory/inbox/`, or file items on the
  factory's tracker. The morning triage folds them in.
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
