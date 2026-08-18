# Attribution

Skills in this plugin come from **[mattpocock/skills](https://github.com/mattpocock/skills)**
by Matt Pocock, MIT licensed, at pinned commit `84fdeffd12f2ee307994d1eb6feb48173b6e0502`.
`LICENSE` carries both copyright notices as MIT requires.

## The standing rule

**His text is kept verbatim unless the change is required by our artefact
contract** — the backlog, spec and ticket formats our Factory driver parses.
Rewriting his prose in a house voice is not a reason. Every deviation below
names the requirement that forced it; a row saying *verbatim* has none.

Dropping a skill, renaming one, or changing his text for any other reason is an
owner decision, not a build-time one.

## Provenance

| Skill | Upstream | Deviation | Forced by |
|---|---|---|---|
| `tdd` | `tdd` | **Verbatim**, with `tests.md` and `mocking.md` | — |
| `grilling` | `grilling` | **Verbatim** | — |
| `domain-modeling` | `domain-modeling` | **Verbatim**, with `CONTEXT-FORMAT.md` and `ADR-FORMAT.md` | — |
| `grill-with-docs` | `grill-with-docs` | **Verbatim** | — |
| `wizard` | `wizard` | **Verbatim**, with `template.sh` | — |
| `resolving-merge-conflicts` | `resolving-merge-conflicts` | **Verbatim** | — |
| `wait-what` | `wait-what` | **Verbatim** | — |
| `grill` | `grill-me` | Renamed only; body verbatim | naming map (owner) |
| `tickets` | `to-tickets` | Verbatim except step 5: task blocks in `.factory/backlog/` instead of `.scratch/` files or tracker issues, the fields the driver parses (`What`, `Type`, `Status`, `Reqs`, `Deps`, `Acceptance`, `Verify`, `Notes`, `Model`, `Effort`, `Gate`), and the four rules those fields force — single-line `Verify`, graded-as-written `Acceptance`, required `Model`/`Effort`, `AFK`/`HITL` typing. His steps 1–4 and his no-file-paths rule are untouched. | artefact contract |
| `spec` | `to-spec` | Verbatim except: written to `.factory/spec/<slug>.md` instead of published to a tracker, and his user-story list carries `REQ-<n>` ids (that id is what `tickets` cites in `Reqs:` and what `code-review` resolves). `Gate: human` marking added so HITL survives into the tasks. | artefact contract |
| `implement` | `implement` | Verbatim except: takes a backlog task rather than "the spec or tickets", and three added lines — claim by draft PR, run the task's `Verify:` line, write `Status:`/`Notes:` back — because a live session has no driver to do them. | artefact contract |
| `code-review` | `code-review` | Verbatim except step 2: spec source is the backlog task (`What`/`Acceptance`/`Reqs`) and the `REQ-` ids resolved in `.factory/spec/`, instead of tracker issues. | artefact contract |
| `triage` | `triage` | **Verbatim**, with `AGENT-BRIEF.md` and `OUT-OF-SCOPE.md` | — |
| `improve-codebase-architecture` | `improve-codebase-architecture` | **Verbatim**, with `HTML-REPORT.md` | — |
| `to-questionnaire` | `to-questionnaire` | **Verbatim** | — |
| `writing-for-agents` | `writing-for-agents` | **Verbatim**, with `SKILL-MECHANICS.md` | — |
| `teach` | `teach` | **Verbatim**, with its four format files | — |
| `chart` | `wayfinder` | Renamed, and the storage is ours. His map is a tracker issue labelled `wayfinder:map` whose tickets are child issues; ours is the head of `.factory/backlog/index.md` above the first milestone heading, with `## D-NNN:` ticket blocks in the effort's epic file. That forces five field-level swaps: claim is `Status: in-progress` (no assignee to hold it), blocking is `Deps:` (no native dependency edge), the type is `Kind:` (no labels), resolution writes `Answer:` + `Status: resolved` (no comment-then-close), and out-of-scope writes `Status: out-of-scope` (no closed state). Two paragraphs go: the tracker-doc lookup (the location is fixed, there is nothing to consult) and the create-then-wire second pass (ids are chosen as the block is written, so no ticket ever needs an id that doesn't exist yet). Everything else — Plan-don't-do, Refer-by-name, all four ticket types, Fog of war, Out of scope, both invocation modes — is his. | artefact contract + naming map (owner) |
| `research` | `research` | **Verbatim** | — |
| `codebase-design` | `codebase-design` | **Verbatim**, with `DEEPENING.md` and `DESIGN-IT-TWICE.md` | — |
| `diagnosing-bugs` | `diagnosing-bugs` | **Verbatim**, with `scripts/hitl-loop.template.sh` | — |
| `prototype` | `prototype` | Verbatim except rule 6: the prototype's context pointer and verdict land on the backlog task's `Notes:`, or the decision ticket's `Answer:` if `chart` raised the question, instead of on a tracker issue. With `LOGIC.md` and `UI.md`. | artefact contract |
| `handoff` | `handoff` | Rewritten around decision 7 — a handoff and a backlog task are one object at two stages, so when the work in flight is a task the handoff *is* the task (`Status: in-progress` + `Notes:`), and his portable-file behaviour becomes the fallback for work with no task under it. His four standing rules — suggested-skills section, don't duplicate other artefacts, redact secrets, honour the argument — are verbatim. One constraint added: no `## ` headings inside a task block, because a `## ` line starts a new block and would cut the task in half. | decision 7 + artefact contract |
| `setup` | `setup-matt-pocock-skills` | Renamed and re-scoped. His Section B (labels) and Section C (domain docs) are verbatim, and `triage-labels.md` and `domain.md` are copied unchanged. Section A survives but configures the **inbound** surface only — `spec` and `tickets` no longer publish to a tracker, so triage is its sole consumer and the section is skipped when `triage` isn't installed. New Section D creates `.factory/backlog/index.md` and `.factory/spec/` when they're absent, and never touches an index that already exists. The three tracker templates lose their `## Wayfinding operations` sections — `chart`'s storage is fixed, so there is nothing per-tracker left to express — and gain the inbound-only framing; `issue-tracker-local.md` also loses its spec and ticket conventions, which now live in `.factory/`. | artefact contract |
| `route` | `ask-matt` | Renamed, and the map re-derived over our roster: his own rule is that a router that lies is a bug, so every pointer resolves to a skill that exists and every skill but the router itself is named. The shape is entirely his — main flow, on-ramps, codebase health, vocabulary underneath, phase boundaries, standalone, precondition — with `PHASE-BOUNDARIES.md` verbatim. The deltas are the renames (`/spec`, `/tickets`, `/grill`, `/chart`, `/setup`), the destinations (`.factory/spec/`, `.factory/backlog/`, `Deps:` in place of native blocking links), and two entries with no upstream: `/verify`, and a short "the backlog is the join" note saying why `/handoff` writes onto the task. | roster + artefact contract |
| `verify` | — | No upstream counterpart. Ours, from `code4food-skillset:verify`, entry point changed to the task's `Verify:` line. Named by `implement`. | — |

## Verified, not asserted

Every skill was diffed file-by-file against the pinned SHA on 2026-08-08, and
each surviving hunk classified. **Fourteen skills are byte-identical to his in
every file**: `codebase-design`, `diagnosing-bugs`, `domain-modeling`,
`grill-with-docs`, `grilling`, `improve-codebase-architecture`, `research`,
`resolving-merge-conflicts`, `tdd`, `teach`, `to-questionnaire`, `wait-what`,
`wizard`, `writing-for-agents`. The audit found six unforced changes that had
survived the earlier passes; all six were reverted to his text.

## Owner overrides on his text

Places where the owner has deliberately changed his wording, none forced by the
artefact contract:

- **The file-path rule, relaxed** in `tickets` and `spec`. He writes "avoid
  specific file paths"; ours names interfaces, types, contracts and the modules
  that hold them, and forbids line numbers and edit-line-N instructions instead.
  A module being created is part of the contract; a position rots first. The
  first live test produced better tickets under the relaxed rule.

- **Two upstream errors corrected** (owner, 2026-08-08). Both are places where
  his text contradicts its own page, so reverting them would ship a sentence
  that is wrong on its face. Worth reporting upstream.
  - `route` — his `ask-matt` says "**two** on-ramps merge onto it" while the
    On-ramps section below it lists three (triage, diagnosing-bugs, wayfinder).
    Ours says three.
  - `setup` — his intro offers "GitHub by default; local markdown is also
    supported out of the box", but his own Section A offers GitLab and the skill
    ships `issue-tracker-gitlab.md`. Ours names GitLab in the intro too.

- **`route` carries one section his router does not**: "The backlog is the
  join", stating that `/tickets`' output is what a factory window picks up and
  why `/handoff` writes onto the task. It is the only place decisions 6 and 7
  are explained to a reader. Owner kept it, 2026-08-08.

## Coverage

**His shipped manifest is carried in full** — all 25 skills, plus `verify`, which is
ours. Nothing of his was dropped.

His `in-progress/`, `misc/` and `deprecated/` directories sit outside that
manifest and are not part of what he ships.

Every `/`-pointer in every skill resolves to a skill in this plugin (or to a
Claude Code builtin, `/clear` and `/compact`). `route` names all 25 others.

## Naming map

`grill-me` → `grill`, `to-spec` → `spec`, `to-tickets` → `tickets`,
`wayfinder` → `chart`, `ask-matt` → `route`, `setup-matt-pocock-skills` →
`setup`. Owner decision; bodies are unaffected.

His per-skill `agents/openai.yaml` sidecars **are** copied, verbatim except the
`display_name` of a renamed skill. They carry Codex display metadata and mirror
the invocation policy; Claude Code reads the SKILL.md frontmatter and ignores
them. `verify` has no upstream sidecar, so one was written for it.

## What was not adapted at all

The upstream repo ships skills and nothing else — no hooks, no commands, no
always-loaded contract. That architecture is deliberate here too, and is the one
thing this plugin copies wholesale rather than adapts.
