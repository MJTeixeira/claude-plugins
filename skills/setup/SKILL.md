---
name: setup
description: Configure this repo for the live skills — set up its backlog and spec destinations, its inbound issue tracker, triage label vocabulary, and domain doc layout. Run once before first use of the other skills.
disable-model-invocation: true
---

# Setup

Scaffold the per-repo configuration that the live skills assume:

- **Backlog and specs** — where the flow's own artefacts land: `.factory/backlog/` and `.factory/spec/`
- **Issue tracker** — where *inbound* requests live, the ones `/triage` works (GitHub by default; GitLab and local markdown are also supported out of the box)
- **Triage labels** — the strings used for the five canonical triage roles
- **Domain docs** — where `CONTEXT.md` and ADRs live, and the consumer rules for reading them

This is a prompt-driven skill, not a deterministic script. Explore, present what you found, confirm with the user, then write.

## Process

### 1. Explore

Look at the current repo to understand its starting state. Read whatever exists; don't assume:

- `git remote -v` and `.git/config` — is this a GitHub repo? Which one?
- `AGENTS.md` and `CLAUDE.md` at the repo root — does either exist? Is there already an `## Agent skills` section in either?
- `CONTEXT.md` and `CONTEXT-MAP.md` at the repo root
- `docs/adr/` and any `src/*/docs/adr/` directories
- `docs/agents/` — does this skill's prior output already exist?
- `.factory/backlog/index.md` and `.factory/spec/` — does the flow already have somewhere to land? If `index.md` exists, a Factory or an earlier session owns it: read it, never rewrite it.
- `.scratch/` — sign that a local-markdown issue tracker convention is already in use
- Is the `triage` skill installed? (a `triage` skill folder alongside this one, or `triage` in your available skills.) This decides whether Sections A and B run at all — the tracker's only consumer is triage.
- Monorepo signals — a `pnpm-workspace.yaml`, a `workspaces` field in `package.json`, or a populated `packages/*` with its own `src/`. Present only in a genuinely large multi-package repo; their absence means single-context, which is almost every repo.

### 2. Present findings and ask

Summarise what's present and what's missing. Then take the sections in order — one section, one answer, then the next.

Lead each section with the recommended answer so the user can accept it in a word. Give a one-line explainer only when the choice genuinely branches; skip the section entirely when exploration already settled it (Sections A and B when `triage` isn't installed, Section C when there's no monorepo, Section D when the backlog already exists).

**Section A — Issue tracker.** Skip this section entirely if the `triage` skill isn't installed — with nothing reading the tracker config, there is nothing to configure.

> Explainer: the "issue tracker" here is where *inbound* work arrives — bug reports, feature requests, external PRs — the raw material `/triage` turns into backlog tasks. It is not where the flow's own artefacts go; `/spec` and `/tickets` always write to `.factory/`. Pick the place other people file things for this repo.

Default posture: these skills were designed for GitHub. If a `git remote` points at GitHub, propose that. If a `git remote` points at GitLab (`gitlab.com` or a self-hosted host), propose GitLab. Otherwise (or if the user prefers), offer:

- **GitHub** — inbound issues live in the repo's GitHub Issues (uses the `gh` CLI)
- **GitLab** — inbound issues live in the repo's GitLab Issues (uses the [`glab`](https://gitlab.com/gitlab-org/cli) CLI)
- **Local markdown** — inbound issues live as files under `.scratch/issues/` in this repo (good for solo projects or repos without a remote)
- **Other** (Jira, Linear, etc.) — ask the user to describe the workflow in one paragraph; the skill will record it as freeform prose

Record the choice in `docs/agents/issue-tracker.md`. The GitHub and GitLab templates carry a "PRs as a request surface" flag, defaulted **off** — leave it off and don't raise it; a user who wants external PRs in the triage queue can flip the flag in the file later.

**Section B — Triage label vocabulary.** Skip this section entirely if the `triage` skill isn't installed (exploration told you) — an uninstalled skill needs no labels.

If it is installed, ask exactly one question:

> Do you want to keep the default triage labels? (recommended: **yes**)

The defaults are the five canonical roles, each label string equal to its name: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. On **yes**, write them as-is. Only if the user says no — usually because their tracker already uses other names (e.g. `bug:triage` for `needs-triage`) — collect the overrides so `triage` applies existing labels instead of creating duplicates.

**Section C — Domain docs.** Default to **single-context** — one `CONTEXT.md` + `docs/adr/` at the repo root. This fits almost every repo; write it without asking.

Offer **multi-context** — a root `CONTEXT-MAP.md` pointing to per-context `CONTEXT.md` files — only when exploration found monorepo signals. Then confirm which layout they want.

**Section D — Backlog and specs.** Nothing to choose: the destinations are `.factory/backlog/` and `.factory/spec/`, fixed by the format the Factory driver parses. Skip the section when `.factory/backlog/index.md` already exists — say so and move on, because that file is owned by whoever wrote it and rewriting it would strand the epics already listed in it.

When it doesn't exist, say you'll create the empty skeleton, and create it in step 4.

### 3. Confirm and edit

Show the user a draft of:

- The `## Agent skills` block to add to whichever of `CLAUDE.md` / `AGENTS.md` is being edited (see step 4 for selection rules)
- The contents of `docs/agents/issue-tracker.md`, `docs/agents/domain.md`, and `docs/agents/triage-labels.md` (the last two only when `triage` is installed)
- The `.factory/backlog/index.md` skeleton, if one is being created

Let them edit before writing.

### 4. Write

**Pick the file to edit:**

- If `CLAUDE.md` exists, edit it.
- Else if `AGENTS.md` exists, edit it.
- If neither exists, ask the user which one to create — don't pick for them.

Never create `AGENTS.md` when `CLAUDE.md` already exists (or vice versa) — always edit the one that's already there.

If an `## Agent skills` block already exists in the chosen file, update its contents in-place rather than appending a duplicate. Don't overwrite user edits to the surrounding sections.

The block:

```markdown
## Agent skills

### Backlog

Tasks and decision tickets live in `.factory/backlog/`; specs in `.factory/spec/`.

### Issue tracker

[one-line summary of where inbound issues are tracked]. See `docs/agents/issue-tracker.md`.

### Triage labels

[one-line summary of the label vocabulary]. See `docs/agents/triage-labels.md`.

### Domain docs

[one-line summary of layout — "single-context" or "multi-context"]. See `docs/agents/domain.md`.
```

Include the `### Issue tracker` and `### Triage labels` sub-blocks, and write `docs/agents/issue-tracker.md` and `docs/agents/triage-labels.md`, only when `triage` is installed and Sections A and B ran. When it isn't, all four are omitted.

Then write the docs files using the seed templates in this skill folder as a starting point:

- [issue-tracker-github.md](./issue-tracker-github.md) — GitHub issue tracker
- [issue-tracker-gitlab.md](./issue-tracker-gitlab.md) — GitLab issue tracker
- [issue-tracker-local.md](./issue-tracker-local.md) — local-markdown issue tracker
- [triage-labels.md](./triage-labels.md) — label mapping (only if `triage` is installed)
- [domain.md](./domain.md) — domain doc consumer rules + layout

For "other" issue trackers, write `docs/agents/issue-tracker.md` from scratch using the user's description.

Finally, if Section D ran, create `.factory/spec/` and `.factory/backlog/index.md` holding one empty milestone. `/chart` fills the map sections above the heading; `/tickets` lists epics beneath it. The heading's shape is machine-read — a milestone that doesn't parse is invisible to every consumer downstream:

```markdown
# Backlog

## M1: <first milestone> — active
```

### 5. Done

Tell the user the setup is complete and which skills will now read from these files. Mention they can edit `docs/agents/*.md` directly later — re-running this skill is only necessary if they want to switch issue trackers or restart from scratch.
