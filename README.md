# code4food plugins for Claude Code

> New here? **[ONBOARDING.md](ONBOARDING.md)** is the step-by-step from a
> fresh machine to a working skillset and/or factory.

Two products, one marketplace:

- **`code4food-skillset`** — a token-efficient development workflow for
  interactive Claude Code.
- **`code4food-factory`** — autonomous spec-driven development: Claude builds
  a fully-specced product alone in scheduled daily windows, opening PRs for
  you to review.

## Install

```
/plugin marketplace add MJTeixeira/claude-plugins
/plugin install code4food-skillset@code4food
/plugin install code4food-factory@code4food     # only if you want factories
```

Then, per project, wire the skillset's workflow rules into the project's
CLAUDE.md:

```
/code4food-skillset:setup
```

Want the status bar too (branch, model + effort, cost, tokens, context
size, lines changed)? Ask for it in the same command:

```
/code4food-skillset:setup with statusline
```

Already ran setup without it? Run it again with the word `statusline` —
setup is safe to re-run and only adds what's missing.

## Skillset

Same core flow as heavy skillsets (explore → plan → TDD → review → PR,
worktree isolation, persistent docs) at a fraction of the cost, because
**process is proportional to task size**:

| Task size | Process | Approx. tokens |
|---|---|---|
| Trivial (typo, config value) | edit + verify | ~2–5k |
| Small (contained bugfix) | one failing test → fix → run | ~8–20k |
| Feature (new behavior, cross-layer/system) | explore → plan → approval → TDD → review → PR | ~60–130k |

For comparison, a pipeline that mandates researchers, plan docs, per-cycle
review subagents, and a 7-subagent finishing pass costs ~250–600k tokens for
*any* of these.

What the plugin ships:

- `claude-md-block.md` — a compact router the `setup` command injects into
  the project's CLAUDE.md. Sizes each task and applies only the needed process.
- `skills/` — twelve core skills (dev-workflow, grill-me, tdd, debugging,
  worktrees, finishing, verify, docs, handoff, auth, db-migrations, deploy),
  each under ~500 words, with details in `references/` files loaded only on
  demand.
- `skills/unity`, `skills/godot` — engine skills; their descriptions gate them
  to engine work (MCP hang playbook, batchmode/CI gates, headless discipline,
  capture recipes, engine-specific traps).
- `agents/code-reviewer.md` — the single custom subagent, spawned at most once
  per feature during finishing. Findings are confidence-scored; only ≥ 80/100
  survives.
- `hooks/` — a PreToolUse guard that mechanically blocks `git commit`/`git
  push` on main/master/dev wherever the plugin is enabled. Enforcement at the
  tool layer costs zero context tokens.
- `/commit` — one-shot commit with git context pre-injected and
  least-privilege `allowed-tools`.
- `statusline/statusline.cjs` — optional status bar (branch, model + effort,
  cost, tokens, context size, lines changed); `setup` wires it on request.
  Runs on `node` (bundled with Claude Code) so it works on macOS, Linux, and
  Windows with no extra tools.
- The `.docs/` convention — agent-facing project docs: a small `index.md` map
  plus one file per logical area, so agents load only the slice their task
  touches.

## Factory

The factory is a machine-resident product: config, secrets, schedule, and
logs live under `~/.factory/` on the machine that runs it; the project repo
carries only work data (`.factory/{spec,backlog,inbox}`). Needs a git repo
with a GitHub remote; **factories run on macOS/Linux machines** (any OS can
spec and pilot — see below). The plugin ships the `spec` (multi-sitting
product speccing + red-team pass — needs no factory machine),
`factory-setup` (interview wizard),
`backlog` (task vocabulary), and `verify` (headless verification for
unattended sessions) skills; the driver, prompts, and schedulers live in this
repo's `factory/` tree and run from a per-machine runtime clone.

**Spec first, install later (any machine, any OS):** you don't need the
runtime or a factory machine to start. With just the plugin installed, open
`claude` in a new or existing project folder and say **"spec this
project"** — deep interview sittings write `.factory/spec/` files; come
back for more sittings any time ("are the specs ready?" runs the final
red-team pass). When the specs are ready, move to a macOS/Linux machine
for the factory setup below — the specs travel with the repo.

Prereqs for the steps below (Node ≥ 18, `gh` and `claude` logged in):
[ONBOARDING.md](ONBOARDING.md) step 0. **On a machine that will RUN
factories, skip the `/plugin marketplace add` from the Install section** —
the runtime bootstrap below registers the plugins itself (from the runtime
clone, so sessions run exactly the deployed versions); the marketplace-add
path is for machines that only use the skills.

Once per machine, bootstrap the runtime (or run
`/code4food-factory:deploy-runtime`):

```sh
git clone https://github.com/MJTeixeira/claude-plugins ~/.factory/runtime
```

Then per project:

```sh
cd /path/to/project && claude
```

and say: **"set up a factory here"**. Claude interviews you, writes the
spec files from what you paste, runs the setup wizard, compiles the task
backlog, and offers a supervised first run. Install the schedule when it
hands you the command and it runs daily on its own, opening PRs for you
to merge. Health check any time:

```sh
node ~/.factory/runtime/factory/driver/factory.mjs doctor --project .
```

More: [ONBOARDING.md](ONBOARDING.md) (step-by-step, config reference,
no-chat manual path) and [factory/FACTORY.md](factory/FACTORY.md) (full
runbook — phone dashboard, Telegram notifications, GitHub Projects board,
autonomy levels).

## License

MIT
