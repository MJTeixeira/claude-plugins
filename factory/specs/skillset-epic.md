# Skillset epic — the piloted-session skillset, re-derived under the 2026-07-23 premises

Owner-approved 2026-07-27 (discovery session same day: official
skill-authoring + Claude Code best-practices guides, the ~400k-session
study, remaining loop-engineering leads). Companion to `autonomy-epic.md`
— same method: research + premise reset → chunked, one-PR-each plan. Target state, in plain language: **every rule in the
skillset is justified by attention, risk, or evidence — never by token
cost; "done" always means a named check ran and its evidence was shown;
review depth scales with risk; and the skillset improves on measurement
instead of taste.**

Premise reset behind this epic (2026-07-23): token cost is a metric, not a
constraint; the owner must never be the bottleneck; remake is allowed with
motive; safety gates get better instrumentation, never removal. Premise
correction 2026-07-27: the FACTORY is owner-only, but the skillset has two
external users (friends with the plugin installed) and the owner also runs
other, unrelated skill sets in projects where this workflow does not
apply — the contract must stay per-project opt-in and migrations must be
graceful for installs we don't control.

## Why

The skillset predates the premise reset — its identity is literally "lean
workflow", and several rules are cost decisions wearing process clothes:
`finishing` spawns the reviewer "exactly once", subagent caps cite spend,
the sizing router exists to minimize tokens. The 07-23 discovery material
plus this pass's sources converge on the replacement frame:

- **Verification is the spine.** "Give Claude a check it can run … it's
  the difference between a session you watch and one you walk away from"
  (official best practices). A task without a check is just hope; done =
  evidence shown, not assertion.
- **The 400k-session study**: humans make ~70% of planning decisions,
  Claude ~80% of execution; *verified* success (commits, passing tests,
  hard evidence) tracks domain expertise. The skillset's job is bottling
  that expertise and making evidence the default.
- **Review depth is a risk decision, not a budget one** — and more is not
  automatically better: a reviewer prompted to find gaps will report
  some regardless; chasing every finding is over-engineering (official
  caution). Scale by risk, verify findings adversarially where stakes are
  high.
- **Brevity survives the reset for a different reason**: instructions
  compete for attention — "bloated CLAUDE.md files cause Claude to ignore
  your actual instructions." Attention-lean replaces token-lean.
- **Maintain on evidence**: evaluations before authoring, deletion before
  addition, and the same human correction recurring 3+ times means the
  harness — not the human — has the bug.

## Audit verdict (discovery 2026-07-27)

Walked all 14 skills + claude-md-block + agents/commands/hooks against the
premises and sources. **No remake motive: the architecture re-derives
itself** — router + phase skills + domain packs + `.docs` + hooks is the
same layering Anthropic's own guidance recommends. `tdd`, `debugging`,
`docs`, `verify`, `grill-me`, `handoff`, `worktrees`, the five domain
packs, `/commit`, `/setup`, and the branch-guard hook are premise-clean.
The cost-era residue concentrates in: the "lean" framing (block + plugin
description), `finishing`'s review cap, the subagent caps' stated
rationale, and the total absence of instrumentation for piloted sessions.

**Fork decision: NO separate factory skillset.** The factory keeps
consuming the shared mechanics (tdd, docs, handoff, domain packs) and
overlaying only where mode genuinely differs (the verify pair,
backlog/spec). Any future split follows the verify precedent: per-skill,
on evidence of real divergence — never a wholesale fork.

## Chunks (one PR each; every chunk needs an explicit owner yes before merge/publish)

1. **Global delivery, per-project activation — the contract ships with
   the plugin, gated by the project's own opt-in footprint.** A
   SessionStart hook in the skillset plugin (matcher
   `startup|resume|clear|compact`; plugin hooks.json support and the
   10k-char output cap verified against the hooks docs — the block is
   ~4.5k) injects the workflow contract ONLY when `.docs/index.md`
   exists in the project — the file /setup already creates, i.e. the
   workflow's own footprint. Delivery becomes global: the contract
   versions with the plugin (deploy-runtime advances runtimes, /plugin
   update the Mac), killing the per-project block content, the
   fleet-wide refresh chore, the marker-idempotence constraint, and
   cross-project skew. Activation stays per-project: /setup remains the
   opt-in, so the friends' unrelated projects and the owner's other
   work domains never see this contract, and nothing is forced on installs
   we don't control. Transition, strictly ordered: (a) plugin ships the
   gated injection; (b) /setup stops writing the block and gains a
   migrate step that deletes old marker blocks; (c) sweep our fleet
   checkouts (verify each factory project has `.docs/index.md` before
   stripping its block). Friends' projects migrate lazily: whenever they
   update the plugin and re-run /setup — until then old block +
   injection coexist with near-identical content (redundant, harmless;
   ONBOARDING asks them to re-run /setup after updating).
2. **Contract refresh — attention-lean, not token-lean.** After 1, on
   the now plugin-shipped contract: restate every cap and rule with its
   real justification (attention, risk, coordination), drop cost
   language; update plugin.json description; replace "lean" branding in
   prose (the legacy marker string survives only inside /setup's migrate
   step, as the pattern it deletes); drop the now-dead "no `.docs/` yet?
   run the initial pass" line — injection only fires where `.docs/`
   exists, so bootstrap lives solely in /setup. Subagent caps stay but
   re-derived as coordination/context limits; chunk-5 data revisits the
   numbers later.
3. **Risk-scaled review — finishing + code-reviewer.** Replace "exactly
   once" with review scaled to risk: trivial diffs none (as today),
   normal diffs one fresh-eyes pass, diffs touching high-risk paths
   (auth, payments, migrations, CI/config — same tier philosophy as the
   factory's riskTiers) get the security-lens second pass (already
   shipped) PLUS adversarial verification of top findings before acting
   (verify-to-refute — the grader lesson pointed inward). The reviewer
   contract keeps the ≥80 confidence floor and correctness-gaps-only rule.
4. **Done-evidence line — dev-workflow plan template + finishing.** Every
   plan names its end-to-end check up front ("Done evidence: <the check
   and what it must show>"), inheriting grill-me's "Done when" where a
   scope contract exists; finishing refuses "done" until that named check
   ran in-session with its output shown. Turns the verification spine
   from prose into a ratchet.
5. **Piloted-session metrics.** A SessionEnd-hook writer producing a
   per-session row schema-aligned with the factory's `metrics.jsonl`
   (endReason, turns, peakContext, denials, tool histogram) by parsing
   the session transcript the way the driver's `parseSessionStream`
   already does — port, don't reimplement. Local and owner-readable; no
   external spend. Feeds chunk 6 and future cap revisits.
6. **Maintenance loop — mostly internal.** A maintenance discipline doc
   in this repo's `.docs/`: evaluation scenarios required for every
   changed skill (exercised in a fresh session before publish), deletion
   before addition, and the repeated-correction rule (same owner
   correction 3+ times across sessions = harness bug → becomes a hook or
   skill edit, recorded). Shipped content gets one line: reader-repair
   extended to skills — a session that catches a skill contradicting
   reality reports it, exactly like a stale docs bullet.

## Rollout notes

- Chunk order is dependency order: 1 changes the contract's delivery
  mechanism, 2 rides it, 3–4 are pure content (publish-gated skillset
  bumps), 5 adds a second hook, 6 is mostly internal repo docs.
  Hook-bearing chunks (1, 5) are proven on the Mac before deploy-runtime
  advances the fleet.
- Chunk 1 restores clean layering: project CLAUDE.md returns to purely
  project-specific facts, the owner's global CLAUDE.md keeps personal
  conduct rules, and the workflow contract lives with the skills that
  implement it — the "supersedes global" header hack dissolves once the
  old blocks are swept.
- The gate pattern generalizes: any other skill set (e.g. a future work-domain
  workflow) can ship its own contract behind its own opt-in marker —
  different marker, no collision, same delivery mechanics. Out of scope
  for this epic; recorded so chunk 1's design doesn't paint it out.
- Factory prompts reference skillset skills by name (`dev-task.md`);
  nothing here renames a skill, so no factory-side change rides this
  epic.
- Spec approval is not chunk approval: product-change-approval applies to
  every chunk individually.
- Delta-over-default test, applied in discovery and standing from now on:
  each skill must carry house content vanilla Claude Code cannot know
  (premises, `.docs` contract, incident tripwires, forge recipes). All
  current skills pass; re-run the test whenever the CLI absorbs more
  built-ins (plan mode, /code-review, and checkpoints already cover
  ground the skillset deliberately does not duplicate).

## Sources (discovery 2026-07-27; foundation = autonomy-epic.md §Sources)

Read this pass:

- https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
  — official skill-authoring guide: conciseness ("the context window is a
  public good"), degrees of freedom, pushy descriptions, progressive
  disclosure, evaluation-driven development
- https://code.claude.com/docs/en/best-practices — official Claude Code
  guide: verification loops and their gates, CLAUDE.md pruning
  discipline, hooks for zero-exception rules, adversarial-review
  over-engineering caution, common failure patterns
- https://www.anthropic.com/research/claude-code-expertise — the
  ~400k-session study: planning/execution decision split, expertise →
  verified success, evidence-tiered verification
- https://ghuntley.com/ralph/ — the original Ralph loop: one task per
  loop, backpressure, search-before-assuming
- https://www.langchain.com/blog/the-art-of-loop-engineering —
  verification rubrics, trace-driven harness improvement
- https://cuigh.com/posts/stop-prompting-design-loops/ — loop anatomy
  (state / verification / feedback routing); KERNEL prompt frame
- https://dev.to/truongpx396/the-agentic-loop-a-practical-field-guide-mnc
  — maker–checker split, stop conditions as contracts, skill library over
  repeated prompts, CLIs over heavy MCPs
- https://unlock-ai.natebjones.com/guides/agents/maintenance — the
  maintenance loop: deletion before addition, replay packs,
  repeated-correction signal, Keep/Change/Pause/Retire
- https://code.claude.com/docs/en/hooks — SessionStart context injection:
  plugin hooks.json support, stdout/additionalContext, 10k-char cap,
  source matchers (chunk 1's mechanism, verified 2026-07-27)
- https://medium.com/@shanewang199512/2026-agent-harness-the-game-changer-for-ai-applications-if-youre-not-the-model-you-re-the-e49722a23967
  — harness-over-model evidence (TerminalBench harness-only jump)

Not fetchable this pass: visualstudiomagazine.com (HTTP 403).
