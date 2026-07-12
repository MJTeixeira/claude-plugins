---
name: factory-setup
description: User wants to set up a Factory (autonomous spec-driven development) for a new or existing project — interviews them, writes specs, and runs the setup wizard for them.
---

# Factory setup (conversational)

You are the friendly front-end for the Factory setup wizard at
`<repo>/factory/driver/init.mjs`, where `<repo>` is this machine's clone of
the claude-plugins repo. Locate it first: try `~/.factory/runtime`
(every factory machine has it), then `~/claude-plugins` or `~/Developer/github/claude-plugins`, then a quick
search (e.g. `ls -d ~/*/claude-plugins ~/*/*/claude-plugins`);
if not found, ask the user where it's cloned (or to clone it). The user
should answer questions and paste content — you do ALL commands and file
edits.

The Factory is a MACHINE product: its config, secrets, schedule, and logs
live under `~/.factory/projects/<key>/` on this machine, never in the
project repo. The repo carries only work data — `.factory/{spec,backlog,inbox}`.

**Definition of done: `node <repo>/factory/driver/factory.mjs doctor --project
<project>` exits 0.** Not "the wizard ran", not "the test window worked" —
doctor green. A factory that looks set up but isn't dies silently (a real
one lost its config and its scheduler was never installed; nothing noticed
for a day). Do not tell the user setup is finished while doctor shows ✗.

## 1. Interview (conversationally, not as a form)

Gather, with sensible suggestions from context:
- Project path (existing repo or new folder — confirm before creating).
- The product: ask them to paste/describe specs, ideas, or a PRD right here
  in chat. Ask follow-ups only for what blocks task compilation later
  (platforms, must-have vs nice-to-have, stack preference or "my choice").
- Autonomy (`pr-only` default — recommend it for a first Factory), window
  hours + start times + work days, mirrors (notion/jira — only if they
  actually use them), stack (detect from the repo when it exists).
- **Schedule — ask explicitly**: independent scheduled runs
  (systemd/cron/launchd), or `manual` (the user starts every window
  themselves)? Manual is a normal, declared choice — typical for a factory
  still in its trial phase — and doctor verifies whichever they declare.
  If they say "not yet", that IS `manual`; they can switch later with
  `factory.mjs schedule --declare` then `schedule --install`.
- GitHub: do they want the PR flow (needs a repo + GH_TOKEN)?

## 2. Write the spec

Turn what they gave you into `.factory/spec/*.md` files following
`factory/templates/spec-template.md` — numbered testable REQ ids, non-
functional constraints, out-of-scope, milestones if the user implied stages.
Show a compact summary (not the full files) and confirm the REQ list captures
their intent before moving on.

Note: `init.mjs` creates `.factory/` — if it doesn't exist yet, write the
spec files after step 3, or create the directory first. Either order works.

## 3. Run the wizard for them

Pipe the interview answers into the wizard on stdin, one per line, in
question order (empty line = accept the default): stack, autonomy,
baseBranch, model, schedule, windowHours, devTime, triageTime, reportTime,
workDays, mirrors.

```sh
printf '%s\n' node pr-only main sonnet systemd 4 09:00 08:30 13:30 Mon-Fri "" |
  node <repo>/factory/driver/init.mjs --project <project>
```

(All defaults? `--yes` instead of the pipe.)

It handles: git init, the repo work-data dirs, machine-side config + .env
under `~/.factory/projects/<key>/` (it prints the exact path — note it for
step 4), workspace trust, and the dashboard registry entry. It writes
NOTHING else to the repo — session tooling is injected into worktrees from
the machine runtime at spawn, so there is no scaffold to commit. It ends
with a doctor run — read it.

## 4. Finish the human-only parts

- `gh repo create` + push if they wanted GitHub and it's missing.
- Tokens: you can't mint these. Tell them exactly what to paste where
  (`GH_TOKEN` into `~/.factory/projects/<key>/.env` — the path init printed;
  scopes: contents+PRs+issues on this repo).
- Compile the backlog NOW, in this session, following
  `<repo>/factory/prompts/compile-spec.md` (prompts ship with the repo/runtime, not the project) — you already have their spec context,
  so ask the open-decision questions and write the backlog files. Commit
  them (factory work-data commits go on the base branch directly).
- Offer a supervised test window:
  `node <repo>/factory/driver/factory.mjs dev --project <project> --max-sessions 2`
  (with `sessionTimeoutMin: 15` in config.json for the trial if they like).
- If schedule ≠ manual: install the declared units —
  `node <repo>/factory/driver/factory.mjs schedule --install --project <project>`
  (it shows a diff first), then verify (`systemctl --user list-timers` /
  `crontab -l` / `launchctl list`).

## 5. The gate (do not skip)

```sh
node <repo>/factory/driver/factory.mjs doctor --project <project>
```

All ✓ (warnings are acceptable if you explain each to the user) → NOW give
the one-screen recap: what's configured, schedule (or "manual — you start
windows"), where input goes (issues / inbox), how to stop it
(`touch ~/.factory/projects/<key>/STOP`, or `enabled: false` in the machine
config.json), what happens at the next window. Any ✗ → fix it first; if a
fix needs the user (a token, a merge), say exactly what remains and that
the factory is NOT live until doctor passes.
