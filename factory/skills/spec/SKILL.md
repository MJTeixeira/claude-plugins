---
name: spec
description: User wants to spec a product for a Factory project — new repo, existing repo, or no factory anywhere yet ("spec this project", "write/refine the specs", "are the specs ready?"). Deep multi-sitting interview producing REQ-numbered .factory/spec/ files, finished by a red-team pass that makes them compile-ready.
---

# Spec a project (multi-sitting, no factory required)

Produce `.factory/spec/*.md` files a Factory can run on for weeks. This
skill needs ONLY this plugin — no `~/.factory/runtime`, no factory host,
any OS. Speccing on a laptop and installing the factory later on another
machine is the normal flow, not a workaround. Do not load skillset skills
here; everything needed is in this file and its references.

The template is `${CLAUDE_PLUGIN_ROOT}/templates/spec-template.md`
(fallback: `~/.factory/runtime/factory/templates/spec-template.md`).
Read it once per session before writing spec files.

## Why depth matters

The limiting factor for long autonomous runs is not code quality — it is
unanswered owner questions. Every decision pinned during speccing is a
`needs-human` stall that never happens mid-window. Interview accordingly:
this is the highest-leverage hour of the whole project.

## Each sitting

1. **Orient.** If `.factory/spec/` has files: read them all, read every
   `## Open decisions` section, and resume from there — summarize what is
   settled and what is open, don't re-ask settled questions. Otherwise
   create the directory (offer `git init` if there's no repo yet) and
   start fresh from whatever the user pastes or describes.
2. **Interview in batches** — 3-5 pointed questions at a time, never a
   long form. Socratic and concrete: prefer "what happens when two users
   edit the same item?" over "any concurrency requirements?". Pin, in
   rough order: who the users are and the core value; scope boundary
   (explicit OUT list, not just in); must-have vs nice-to-have; platforms
   and stack (or "agent's choice within <constraints>"); success criteria
   per feature, observable and testable; milestones as demoable stages.
   Challenge vagueness on the spot: "fast", "simple", "like X" become
   numbers or named behaviors, or go to Open decisions with an owner.
3. **Write as you go**, following the template: numbered REQ ids unique
   across all spec files, one file per domain when the product is big,
   observable behavior not implementation, NFRs measurable, out-of-scope
   explicit.
4. **Close the sitting**: update `## Open decisions` (each entry: the
   question, who decides, what it blocks) — this is the handoff to the
   next sitting, on any machine, any day. Show a compact status (settled
   / open / next questions), then commit the spec files. If a factory is
   already live on this repo, spec files are factory work-data — commit
   them to the base branch and push (metadata is exempt from PR gating).

## The red-team pass (final sitting, or on "are the specs ready?")

Read `references/red-team.md` and run its checklist against every spec
file. Each finding is resolved one of three ways, never silently skipped:

- **Answer it now** — edit the spec (best outcome).
- **Stamp it** — a decision only the owner can make later (visual taste,
  playtest feel, external accounts) gets a `Gate: human` note on the
  affected requirement lines, so compile marks those tasks for owner
  review instead of the factory stalling on them at 3am.
- **Leave it open, dated** — only for decisions that genuinely don't
  block the first milestones; keep them in Open decisions with an owner.

## Done

Declare the specs compile-ready ONLY when: every REQ is independently
testable, out-of-scope exists, milestone 1 ends in something demoable,
and Open decisions contains nothing that blocks the active milestones.
Then point the user at the next step: on a factory machine (macOS/Linux),
"set up a factory here" (the factory-setup skill detects existing specs
and skips straight to the wizard); on any other machine, move to the
factory machine for install — the specs travel with the repo.
