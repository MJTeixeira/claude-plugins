<!-- BEGIN LEAN-WORKFLOW MANAGED BLOCK (do not edit inside markers) -->
# Workflow — project-level, supersedes global

This project uses its own lean workflow. IGNORE any global (~/.claude/CLAUDE.md)
workflow checklist: do not announce workflows or build todo lists from one.
Skills referenced below come from the `code4food-skillset` plugin (namespaced
`code4food-skillset:<name>`).

## Size the task first (silently — no announcements)

- **Trivial** — typo, rename, config value, one-liner, comment/doc edit:
  just do it, then verify (run the affected test/build or exercise the change).
- **Small** — contained bugfix or tweak within ONE layer/system, clear
  approach: write or extend one failing test first, implement, run the tests.
  File count is a signal, not the rule — 2 files in a large codebase is
  small; 5 files spanning layers is not.
  If the cause is unclear, use the `debugging` skill before writing fixes.
- **Feature** — new behavior, ambiguous scope, or any change crossing
  architecture layers or system boundaries (frontend/backend/db/external
  service or tenant): use the `dev-workflow` skill: explore → plan → my
  approval → `tdd` → `finishing` (review + checks + PR). One exception: a
  purely mechanical cross-layer passthrough (rename, add-a-field plumbing —
  no logic decisions) stays small.

If unsure between two sizes, pick the smaller; escalate if it grows.

## Git

- If on main/master/dev (or a similarly protected branch) and about to edit
  code: create a branch first. For feature-sized work, use the `worktrees` skill.
- Never commit or push unless I ask.

## Project docs (.docs/)

- If `.docs/HANDOFF.md` exists, read it FIRST — it's in-flight work from a
  previous session (`handoff` skill).
- Before ANSWERING QUESTIONS about or touching an unfamiliar area: read
  `.docs/index.md` (its `Commands` section has the canonical test/build/run
  commands — don't rediscover them), then ONLY the `.docs/<area>.md` files
  for areas your task touches. Verifying a feature exists is cheaper than
  advising from memory of it.
- On conflicting claims: source code > `.docs/` > memories/summaries/chat.
  Memories are leads to verify, never authorities.
- After finishing a small/feature change: update the touched area files
  yourself, inline, per the `docs` skill. Skip for trivial changes.
- Check `.docs/known-issues.md` before debugging; when you hit, defer, or
  fix a known issue, update it (entries are deleted when fixed).
- No `.docs/` yet (workflow adopted mid-project)? Run the `docs` skill's
  initial pass: index.md + known-issues.md now; area files grow with the work.

## Skills and subagents

- Trust skill descriptions. Read a SKILL.md at most once per session, when its
  trigger applies. Load references/ files only when the skill says to.
- Subagents are for feature-sized work, scaled to the surface: the built-in
  Explore agent for codebase recon during `dev-workflow` — one by default;
  in parallel only per SEPARATE system (another service, codebase, or
  external tenant) or per disjoint `.docs` area whose surface is EACH too
  large to read yourself (cap ~4); layers inside one codebase never get
  their own agents — and the `code-reviewer` agent at most once by default
  during `finishing` (that skill adds a second security-lens pass whenever
  the diff has a security surface). No researcher, documenter, or per-phase
  subagents.

## Conduct and code

- Push back on bad ideas, unreasonable expectations, and mistakes. Never say
  "You're absolutely right" or equivalent. Flag what you don't know.
- YAGNI: build only what was asked.
- Root-cause bugs; never patch symptoms. Fix failing tests even if pre-existing.
- ~3 failed attempts at the same problem with no new information: stop, write
  up findings, ask or move on — never thrash.
- try/catch only at system boundaries; let intermediate failures bubble up.
- Comments document code, not process. Tests document behavior, not internals.
<!-- END LEAN-WORKFLOW MANAGED BLOCK -->
