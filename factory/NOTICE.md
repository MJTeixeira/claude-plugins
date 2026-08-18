# Attribution

Skills here are derived from the code4food Live skillset — now shipped as the
`code4food-skillset` plugin at the repo root, ledger `../NOTICE.md` — which is
itself derived from **[mattpocock/skills](https://github.com/mattpocock/skills)**
by Matt Pocock, MIT licensed, at pinned commit
`84fdeffd12f2ee307994d1eb6feb48173b6e0502`. `LICENSE` (beside this file) carries both
copyright notices as MIT requires.

## The standing rule, and how it differs from `live/`

`../NOTICE.md` (the Live ledger) keeps Pocock's text **verbatim unless our artefact contract
forces a change**. That rule does not carry over here unchanged, because this
skillset serves a different session: an unattended factory window with no human
in the room, no ability to ask, and a driver that owns the backlog, the PR and
the merge.

So the rule here is: **derive from `live/`, and record what the unattended
context forced.** A row saying *ours* has no upstream at all. Every other row
names the live skill it came from and what changed — and "an unattended session
cannot do this" is a legitimate forcing reason, unlike in `live/`.

Dropping a skill or changing one for any other reason is still an owner
decision, not a build-time one.

## Provenance

| Skill | From | Deviation | Forced by |
|---|---|---|---|
| `backlog` | **ours** — no upstream | Mostly the reading half: picking order, eligibility, the driver's state overlay, the model-tier pin, claimed tasks, the status vocabulary and what to report when. Two writing rules survive, both scoped to the triage session, which maintains tasks without creating them (owner decision 2026-08-17): stamping `Gate: human` and assigning `Model:`/`Effort:`. The rest of the shipped skill's authoring half — Verify tiers, acceptance wording, the index format — is deliberately absent, because tasks are authored in live sessions. | — |
| `implement` | `live/implement` | Task comes from the driver assignment or the `backlog` skill, not from a human naming one. Four live-driver behaviours removed: the draft-PR claim (the driver's worktree and branch are the claim), the `Status:` write, the `Notes:` write, and taking the PR out of draft. Two added: commit-and-push after every green step (the worktree is deleted at session end), and `create_pr` + report `review` instead of opening the PR yourself. Carries the red-green loop inline (2026-08-17 fold): loop entry is temporal ("first edit is the failing test"), not seam-conditional, plus the tautological and horizontal-slicing anti-patterns compressed from `tdd`'s body. | unattended session; driver owns backlog and PR |
| `tdd` | `live/tdd` (Pocock verbatim) | Body verbatim except the seams rule: "confirm them with the user" becomes the task's `What:`/`Acceptance:` lines standing in as the pre-agreed seams, written into the PR body. The `/codebase-design` pointer is cut — that skill is not in this roster and a router that lies is a bug. `tests.md` and `mocking.md` carried unchanged. | no human to confirm with; skill absent |
| `code-review` | `live/code-review` | Fixed point is the base branch (`FACTORY_BASE_BRANCH` / config `baseBranch`) instead of one the user supplies. Spec sources lose "a path the user passed" and "ask the user where the spec is"; a missing spec now skips the Spec axis and becomes a line in the report. One sentence added on why an empty diff means uncommitted work. | unattended session; driver fixes the base |
| `diagnosing-bugs` | `live/diagnosing-bugs` (Pocock verbatim) | Six hunks, all the same cause: "ask the user" becomes `open_question` + report `blocked`, and the ranked-hypotheses checkpoint becomes a written record instead of a conversation. Loop rung 10 was a HITL bash script driving a human's clicks — replaced with instrument-and-re-run, and `scripts/hitl-loop.template.sh` dropped with it. Added the re-testable-blocker rule (exact command, verbatim first error line). | no human in the room |
| `verify` | **ours** — the shipped `code4food-factory:verify` | Carried whole. Description drops its cross-reference to the old live verify; a §Finding the command section added, pointing at `CONTEXT.md` § Commands; the Verify-tier reference reworded to stand alone now that the tier ladder is a live authoring rule. | knowledge-model swap |
| `godot`, `unity` | **ours** — `code4food-skillset` | `.docs/index.md` § Commands becomes `CONTEXT.md` § Commands, plus a fallback line for when that section is absent. Godot's `.docs/mcp.md` pointer cut. Descriptions rewritten for a window with no editor open. | knowledge-model swap |

## Install precondition — measured, not assumed

**The shipped `code4food-factory` and `code4food-skillset` plugins must not be
installed alongside this one.** Probed 2026-08-17 on Claude Code 2.1.233: with
them enabled, a `claude -p` session loading this plugin via `--plugin-dir` saw
only 5 of its 8 skills — `backlog`, `code-review` and `diagnosing-bugs` were
absent, with no error and no warning. With user settings excluded, all 8 load.
This plugin deliberately reuses the name `code4food-factory`, so a machine
running the test has to uninstall the shipped one first.

## Dropped from `live/`, and why

Every user-invoked live skill (`chart`, `spec`, `tickets`, `handoff`, `route`,
`setup`, `triage`, `grill`, `grill-with-docs`, `teach`, `wait-what`,
`to-questionnaire`, `improve-codebase-architecture`) is absent: those are the
live flow, worked with a human present. Measured 2026-08-16: a skill carrying
`disable-model-invocation: true` does not appear in a `claude -p` session's
skill list at all, so they could not be reached from a window even if they were
shipped.

`auth`, `db-migrations` and `deploy` are absent because no factory prompt or
skill references them. `dev-workflow` is absent because its approval gate needs
a human. `worktrees` is absent because the driver creates the worktree.
