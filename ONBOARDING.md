# Onboarding — set up the Skillset and/or Factory from zero

Step-by-step for a fresh person on a fresh machine. No prior knowledge of
this repo assumed. Two things live here — use either or both:

- **Lean Dev Skillset** — you code interactively with Claude Code; the
  skillset keeps it cheap by matching the amount of process to the size of
  each task. See `README.md`.
- **Factory** — autonomous development: Claude builds a fully-specced
  product alone, in scheduled daily windows, opening pull requests for you
  to review. A MACHINE product: a factory's config, secrets, schedule, and
  logs live under `~/.factory/` on the machine that runs it; the project
  repo carries only work data (`.factory/{spec,backlog,inbox}`). Full
  runbook: `factory/FACTORY.md`.

## 0. Prerequisites (once per machine)

Each step ends with a check — run it and confirm before moving on.

1. **Node.js ≥ 18 and git.**
   Check: `node --version` (v18 or higher) and `git --version`.
2. **Claude Code CLI, logged in:**
   ```sh
   npm install -g @anthropic-ai/claude-code
   claude            # run once anywhere, complete the login in the browser
   ```
   You need a Claude subscription (Pro/Max) or an API key. Factory windows
   cost real money — expect roughly $1–4 per completed task with Sonnet.
   Check: `claude --version` prints a version.
3. **GitHub CLI, logged in** (the factory opens PRs and issues with it):
   ```sh
   gh auth login     # pick GitHub.com → HTTPS → login with browser
   ```
   Check: `gh auth status` says "Logged in".
4. **Add the marketplace** (inside any `claude` session):
   ```
   /plugin marketplace add MJTeixeira/claude-plugins
   ```

## 1. Skillset only (interactive coding)

Install the plugin once, then wire each project:

```
/plugin install code4food-skillset@code4food
```

The plugin brings the skills, the `/commit` command, the code-reviewer
agent, and a branch-guard hook (blocks `git commit`/`git push` on
main/master/dev) everywhere it's enabled. Then, per project, run

```
/code4food-skillset:setup
```

which adds the workflow's managed block to the project's `CLAUDE.md`
(ask for the statusline in the same breath if you want the cost/token
status bar).

Check it worked: open `claude` in the project and ask for something tiny
("fix this typo in README"). It should just make the edit — no plans, no
subagents, no ceremony. Bigger asks automatically get more process.

## 2. Factory (autonomous development)

Your project must be a git repo with a GitHub remote (private is fine).

**You can start before any of this machinery exists**: install the factory
plugin (step 0.4 + `/plugin install code4food-factory@code4food` — works
on any OS, no factory machine needed) and say *"spec this project"* in the
repo. The `spec` skill runs deep interview sittings and writes
`.factory/spec/` files; when they're ready, do the machine setup below on
a macOS/Linux box and the setup flow picks your specs up as-is. Writing
specs is the highest-leverage hour of the whole setup — the factory
builds what they say, nothing more.

### 2.0 Machine setup (once per machine)

The factory runs from a machine-resident runtime, not from your project:

```sh
git clone https://github.com/MJTeixeira/claude-plugins ~/.factory/runtime
node ~/.factory/runtime/factory/driver/deploy-runtime.mjs
```

The second command provisions the plugins from the runtime clone (both the
skillset and the factory skills — "set up a factory here" and the backlog
vocabulary work in any project on the machine) and is also the update verb
(section 6). On a factory machine, get the plugins this way rather than
via `/plugin marketplace add MJTeixeira/claude-plugins` — the two sources
would fight over the `code4food` marketplace name, and doctor requires the
marketplace to point at the runtime clone so sessions run exactly the
deployed skill versions.

Every scheduler and worktree-injected tool execs/copies from that runtime. Optional now, needed later: Telegram creds
in `~/.factory/telegram.env`, the watchdog timer + dashboard service
(templates in `factory/schedulers/` — see `factory/FACTORY.md`
"Machine setup").

**Easiest path from here:** open `claude` in the project and say
*"set up a factory here"* — the `factory-setup` skill interviews you,
writes the spec files from what you paste, runs the wizard, and compiles
the backlog for you. The steps below are the manual path and useful to
understand either way.

### 2.1 Run the wizard

```sh
node ~/.factory/runtime/factory/driver/init.mjs --project /path/to/project
```

It asks 11 questions; Enter accepts the default shown in brackets. What
they mean:

| Question | Meaning | Suggested answer |
|---|---|---|
| Stack | main language; sets which commands the agent may run | auto-detected — accept it |
| Autonomy | who merges the agent's PRs (see below) | `pr-only` to start |
| Base branch | branch the agent's PRs target — never your `main` | `dev` |
| Model | default session model (plan entries override per task) | `sonnet` |
| Schedule | `systemd`/`cron`/`launchd` for independent runs, or `manual` = you start every window yourself | `manual` while trialing |
| Window length (hours) | how long the daily dev window runs | `4` |
| Dev window start | when the daily coding window opens | any time you like |
| Triage time | daily reading of your notes/issues into the backlog, before dev | ~30 min before dev |
| Report time | daily summary posted to GitHub | after the window ends |
| Work days | `Mon-Fri` or `Mon-Sun` | `Mon-Fri` |
| Mirrors | copy status to Notion/Jira — optional | Enter (none) |

**Autonomy levels:** `pr-only` = every task becomes a PR, you merge (start
here). `auto-merge-dev` = the DRIVER merges factory PRs into the base
branch once CI is green (graduate to this when you trust it — CI becomes
the only gate; the agent sessions themselves never merge). `milestone-gates`
= auto-merge inside a milestone, stops at milestone boundaries until you
close the gate issue.

**Schedule is a declaration, not a hope:** `manual` means "no independent
runs, on purpose" and is the normal choice while you're still supervising
test windows. `factory doctor` fails if what you declared doesn't match
what's actually installed — in either direction — so a factory can't sit
silently dead thinking it's scheduled.

The wizard does everything mechanical: creates the repo work-data dirs
(`.factory/{spec,backlog,inbox}` — all it ever writes to the repo), writes
the machine-side `config.json` + `.env` under `~/.factory/projects/<key>/`
(it prints the exact path — git can't clean or leak it there), marks the
workspace trusted, registers the factory for the dashboard, and finishes
with a doctor run. Setup is done when doctor is green. Session tooling
(allowlist, guard hook) is injected into each session's worktree at spawn
from the runtime, and skills come from the machine-installed plugins —
nothing to commit, nothing to drift.

### 2.2 Write specs

Put one or more markdown files in `.factory/spec/`, following the pattern
in `~/.factory/runtime/factory/templates/spec-template.md`. This is the
highest-leverage hour of the
whole setup: the factory builds what the specs say — nothing more.
Numbered requirements (REQ-1, REQ-2, …) work best; they make coverage
checkable.

### 2.3 Compile the backlog

```sh
cd /path/to/project && cat ~/.factory/runtime/factory/prompts/compile-spec.md | claude
```

This turns the specs into `.factory/backlog/` — milestones, epics, tasks
with acceptance criteria. Review it afterwards and edit freely; it's yours.

### 2.4 One supervised test window (don't skip)

Cap it first — in the machine config (`~/.factory/projects/<key>/config.json`)
set `"maxSessionsPerWindow": 2, "sessionTimeoutMin": 15`, then:

```sh
node ~/.factory/runtime/factory/driver/factory.mjs dev --project /path/to/project
```

Watch it take the first task all the way to a PR. Then restore the two
values (defaults: 12 and 45).

### 2.5 Schedule it

The wizard declared your schedule in the machine config; install it with:

```sh
node ~/.factory/runtime/factory/driver/factory.mjs schedule --install --project /path/to/project
```

It generates the units from the declaration, shows a diff against whatever
is installed, asks for confirmation, then copies + enables (systemd user
timers on Linux, launchd plists on macOS, a managed crontab block as the
fallback). On Linux also run `loginctl enable-linger $USER` — otherwise
timers stop when you log out. Inspect any time with `schedule --status`;
change times with `schedule --declare` then `--install` again.

### 2.6 Health check

```sh
node ~/.factory/runtime/factory/driver/factory.mjs doctor --project /path/to/project
```

Read-only checklist of everything that has actually cost us a lost night
(PATH visible to the scheduler, workspace trust, gh auth scopes, stale
driver copy, …). Every line should be ✓ or – (skipped). Run it after any
change to the machine, tokens, or schedulers.

## 3. Configuration reference (`~/.factory/projects/<key>/config.json`)

The wizard writes sensible values for all of these. You only ever edit
this file to tune behavior — nothing here is required reading on day one.

| Key | Default | What it does |
|---|---|---|
| `enabled` | `true` | `false` = factory OFF: dev/triage/report refuse to run (scheduled fires exit silently, manual triggers get a clear refusal); doctor, prep, board sync, and runtime updates keep working. The one-line pause/resume switch |
| `windowHours` | `4` | length of the daily dev window |
| `autonomy` | `"pr-only"` | who merges PRs (see 2.1) |
| `baseBranch` | `"dev"` | branch the agent's PRs target |
| `maxSessionsPerWindow` | `12` | hard cap on sessions per window |
| `maxTurnsPerSession` | `80` | hard cap on agent turns per session |
| `sessionTimeoutMin` | `45` | wall-clock kill for a hung session |
| `mergeGateMinutes` | `10` | how long the driver polls CI before handing a PR to the next session (only used under `auto-merge-dev`) |
| `permissionMode` | `"dontAsk"` | keep it; `"bypassPermissions"` only inside a container/VM you could afford to lose |
| `claudeCmd` | `"claude"` | binary to launch; change only for a custom install |
| `model` | `"sonnet"` | default model for sessions (also seeds `triageModel`) — individual backlog tasks can override via `Model:`/`Effort:`/`Turns:` hints |
| `effort` | *(unset)* | default reasoning effort |
| `mirrors` | `[]` | `["notion"]` and/or `["jira"]` status mirroring — needs tokens in `.env` |
| `tracker` | `"github"` | the forge's own issue tracker; `"jira"` routes needs-human questions + the daily log to a Jira project instead (repo tracker off) — also set `jiraProject` and the `JIRA_*` keys in `.env` |
| `jiraProject` | *(unset)* | Jira project key (e.g. `"FACT"`), required by `tracker: "jira"` and `board: {"jira": true}` |
| `jiraEpic` | *(unset)* | anchor epic key in a SHARED Jira project — the factory creates and scans only under this epic |
| `notify` | *(unset)* | `{"telegram": true}` for phone notifications (section 4) |
| `board` | *(unset)* | `{"github": true}` for a GitHub Projects board, or `{"jira": true}` for a two-way Jira board (section 4) |

Budget note: there is no per-dollar cap in Claude Code — `windowHours`,
`maxSessionsPerWindow`, `maxTurnsPerSession`, and `sessionTimeoutMin`
together ARE the budget.

**`~/.factory/projects/<key>/.env`** (secrets, machine-side — the whole
file is optional):

| Key | Needed when |
|---|---|
| `GH_TOKEN` | you want the factory to act as a different GitHub identity than your `gh` login (e.g. a machine user); otherwise leave empty |
| `ANTHROPIC_API_KEY` | the machine has no logged-in Claude subscription |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Telegram notifications enabled |
| `NOTION_TOKEN` | Notion mirror enabled |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | Jira mirror enabled, or `tracker: "jira"` |

## 4. Optional features (all off by default)

- **Dashboard** — live web UI over every factory on the machine:
  `node ~/.factory/runtime/factory/driver/dashboard.mjs` →
  http://localhost:7788. Status, declared state (schedule + enabled),
  backlog, PRs with check status, needs-human count, spend, live log, and a
  checkout version-currency chip. Optional config file
  `~/.factory/dashboard.json` (`{port, listen, token}`, all optional; CLI
  flags override it) — `"listen": "tailscale"` binds the tailnet IPv4. With a
  token set it also gets a per-card control cluster: start a window / a single
  task / triage, and pause, resume, enable, or disable a factory from the
  browser. To check it from your phone, see "Dashboard on a VPS" in
  `factory/FACTORY.md` (Tailscale; never expose it publicly).
- **Telegram notifications** — window start/end, per-task results with PR
  links, straight to your phone. Setup is three short steps in
  `factory/FACTORY.md` ("Telegram notifications").
- **GitHub Projects board** — a kanban view of the backlog on GitHub,
  two-way: the factory pushes task status; cards you add or move get
  folded in at the next triage. Setup: `factory/FACTORY.md`
  ("GitHub Projects board").
- **Jira board** — the same two-way view on a Jira project (any forge;
  in a shared project, anchor the factory under one epic with
  `jiraEpic`). Setup: `factory/FACTORY.md` ("Jira board").
- **Notion / Jira mirrors** — read-mostly status copies for stakeholders:
  `config.json → mirrors` + tokens in `.env`.

## 5. Daily operation

- **Feed it**: drop markdown notes in `.factory/inbox/`, or open GitHub
  issues — the morning triage folds them into the backlog.
- **It asks you**: `needs-human` issues on GitHub. Answer in a comment and
  close the issue; the next triage picks it up. The `[factory] daily log`
  issue is its report.
- **Review PRs**: under `pr-only` this is your main job — merge what's
  good, comment on what isn't (comments on `[factory]` PRs are read at
  triage).
- **Stop everything**: `touch ~/.factory/projects/<key>/STOP` (finishes the
  current session, then halts; delete the file to resume). Longer pause:
  `"enabled": false` in the machine config (or the dashboard's ⏻ button).

## 6. Updating (after this repo improves)

```sh
node ~/.factory/runtime/factory/driver/deploy-runtime.mjs
```

One command per MACHINE (not per project): it fetches this repo, gates the
new version (syntax check + every factory's doctor, read-only), and
fast-forwards `~/.factory/runtime` only when green — every scheduler execs
that checkout and every worktree gets its tooling from it, so the whole
fleet is updated at once. It refuses while a window is running. This is
the ONLY update verb — there is no project-side scaffold to refresh
anymore. If a new runtime adds config keys, `factory.mjs migrate` heals
them into old configs (existing values always kept).

## 7. Gotchas that actually burned us (checked by doctor now, read anyway)

1. **Scheduler PATH** — systemd/cron/launchd don't read your shell
   profile; if `claude`/`gh` live in `~/.local/bin`, the scheduled window
   dies instantly. The generated scheduler files include the PATH line;
   keep it.
2. **Workspace trust** — a repo cloned on a headless machine isn't
   trusted, so sessions silently lose all write tools. The wizard sets
   trust (re-running it is safe); the driver refuses to start untrusted
   (and prints the fix).
3. **Never let two windows on the same project OVERLAP** — concurrent
   drivers are not coordinated and will fight over the branch and backlog.
   Two machines running the same project time-shifted (e.g. VPS by night,
   laptop by day) is safe: state converges at origin between windows (see
   `factory/FACTORY.md` §Piloting contract).
4. **gh identity** — the account you `gh auth login` with is what the
   factory acts as. A fine-grained PAT scoped to the one repo is the
   tighter option (`GH_TOKEN` in the machine `.env`).
5. **Dashboard on a shared box** — bind it to a Tailscale IP with a token
   (see `factory/FACTORY.md`), never `0.0.0.0`.
