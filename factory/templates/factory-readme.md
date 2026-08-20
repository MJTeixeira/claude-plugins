# A factory works in this repo

An autonomous dev factory builds this project from the files in this
directory: it reads the spec, picks tasks from the backlog, and opens pull
requests on a schedule. You don't need any special tooling to work next to
it — this file is the whole contract.

## What's here

- `spec/` — what to build, as REQ-numbered requirements. Humans write these.
- `backlog/` — the work: `index.md` maps milestones to epics; each epic file
  holds tasks with a `- Status:` line (`todo | in-progress | blocked |
  needs-human | review | done`).
- `inbox/` — notes TO the factory. Drop a markdown file here (an idea, a bug,
  a change of direction) **and commit and push it**: triage runs against the
  base branch, so an uncommitted note is never read. Triage turns each note
  into a backlog task — or, when the note leaves an open question a session
  cannot answer, into a task parked at `needs-human` with that question — and
  moves the note to `inbox/processed/`.

## Working alongside the factory

- **Claim a task before you start it: open a DRAFT pull request with the
  task id in the title** (e.g. `T-023: add invoice export`). Branch name is
  up to you. While your PR is open — draft or ready for review — the
  factory and other teammates leave that task alone; merging or closing
  the PR releases the claim.
- Work on a branch and push it — unpushed work is invisible to the factory
  and may be redone.
- On Bitbucket repos, machines that run a factory also carry `bb`, a
  gh-style PR CLI (`bb pr create|list|view|merge|comment`; run `bb` alone
  for usage) — no tokens or curl needed in your session.
- If you ship a task yourself, flip that task's `- Status:` line to `done`
  (and put the PR link in its `- Notes:`) in the same PR that ships the
  work. Only your own tasks' lines — never the counts in `index.md`, never
  other tasks. The factory reconciles everything else.
- New work goes through `inbox/` (or the project board, if one is wired),
  not straight into the backlog files — the factory's triage owns backlog
  structure and formatting.

## What NOT to touch

- Other tasks' `- Status:` lines, and the `n/m` counts in
  `backlog/index.md` — the factory maintains them.
- `.factory/.gitignore` entries — they keep the factory's runtime state
  (logs, plans) out of your commits.

The factory's machinery (driver, config, schedule, logs) lives on the
machine that runs it, not in this repo — deleting this directory does not
uninstall anything. Setup and the full runbook:
https://github.com/MJTeixeira/claude-plugins (its `README.md` for install and
setup, `factory/FACTORY.md` for the manual).
