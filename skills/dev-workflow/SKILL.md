---
name: dev-workflow
description: Feature-sized work — new behavior, changes crossing layers or systems, or ambiguous scope. Explore the codebase, write a short plan, and get user approval before implementing.
---

# Dev workflow (feature-sized work)

## 1. Explore

- Read `.docs/index.md`; load only the `.docs/<area>.md` files matching the
  areas this task touches, and skim `known-issues.md` (cheap; it may flag
  the area you're about to touch). No `.docs/` yet? Run the `docs` skill's
  initial pass first.
- Read the key files directly when the surface is small. Spawn the built-in
  Explore agent only when the relevant surface is too large to read yourself
  (many files, unknown location, unfamiliar conventions) — ONE by default.
  Two cases justify parallel agents: one per SEPARATE system when the change
  spans systems (see Cross-system changes below), and one per AREA (cap ~4)
  when the task touches several disjoint `.docs` areas whose surfaces are
  EACH too large to read yourself — scope each agent to its area's globs and
  area file so no two agents read the same files. The too-large test is the
  gate: in a small repo one agent covers everything, and areas never fan out
  just because they exist. More than ~4 qualifying areas means the task is
  too big — chunk the plan instead. Layers inside one codebase never get
  their own agents. Include the relevant `.docs/<area>.md` paths in each
  prompt, and have it return a ranked list of the key files to read — then
  read those yourself; summaries lose the detail you plan from.
- Web search only for unfamiliar external APIs/libraries, not for the codebase.
- Actively look for existing functions and patterns to reuse before proposing
  new code.
- Before proposing a new dependency: check the repo for an existing equivalent
  (or a stdlib solution) and that the package is maintained; adding it needs
  user sign-off in the plan.

## 2. Plan

If scope is still ambiguous after exploring (you can state two plausible
versions of "done"), run the `grill-me` skill first and plan against its
scope contract.

Write a short plan — it is for you (an agent with the exploration context in
hand), not for a zero-context engineer. Cover: goal, approach, files to touch,
the list of tests you'll write, and open questions. Use the template in
`references/plan-format.md`. If the plan creates new structure (a new
project, a new area, the first instance of a layer), read
`references/architecture.md` first and apply its defaults.

Keep it under a page. If the plan has more than ~5 independent chunks, note the
chunk boundaries — you'll execute and verify chunk-by-chunk to keep context
manageable.

## 3. Approval gate

Present the plan and ask for feedback. Iterate until the user approves. This is
the only mandatory stop in the workflow — do not start implementation before
approval, and do not stop for permission after it.

## 4. Implement

- Follow the `tdd` skill: tests for a chunk first, watch them fail, implement.
- Scratch files (probes, one-off scripts, seed data) go in a gitignored
  scratch dir — `.factory/tmp/` in factory projects, the session scratchpad
  otherwise — never the repo root. Cleanup `rm` may be denied; placement
  beats cleanup.
- For large plans, finish one chunk (tests green) before starting the next.
- If implementation reveals the plan was wrong, say so and propose the
  correction — don't silently diverge.

## 5. Finish

Use the `finishing` skill: checks, one review pass, docs update, PR.

## Cross-system changes

When the task spans SEPARATE systems — your app plus an external service or
tenant, two services, distinct codebases. Layers inside one codebase
(frontend/backend/db of the same app) are not systems; normal explore
covers them:

- Explore with one agent per system, in parallel; each returns its ranked
  files plus the boundary contract it found.
- Map every seam the change touches BEFORE planning. Boundary-recon prompt
  per seam: "Map the contract between <A> and <B>: endpoints/operations
  used, request and response payload shapes, IDs and config keys that cross
  the seam, the error contract, and where each side validates. Return file
  anchors on both sides."
- The plan must name each seam it changes and the test that locks the new
  contract in — a contract/integration test at the seam, not two unit tests
  that agree with themselves.

## UI features

If the task is primarily UI/UX, read `references/ui-iteration.md` during
planning — it covers generating design variations and the screenshot-compare
iteration loop.
