# Autonomy epic — factories that merge everything themselves, safely

Owner-approved 2026-07-24 (discovery session 2026-07-23: loop-engineering /
agent-harness material, Anthropic's AI-native SDLC post, CISO guide).
Target state, in plain language: **a factory PR merges itself only when a
real test suite passed on the merged result, an independent grader
confirmed the task's acceptance criteria, and no high-risk file was
touched — and a fully-specced product can be told "run until it's done"
while the owner reads daily digests.** The owner stays available for what
genuinely needs him (bad specs, human-gated tasks); he must never be the
bottleneck.

Premise reset behind this epic (2026-07-23): token cost is a metric, not a
constraint; the owner is the only user; safety-first autonomy stays —
gates get better instrumentation, never removal.

## Why

Under `auto-merge-dev` the trust chain was: the implementing session's own
tests, a reviewer the implementer briefed and graded itself, then CI —
and on repos with no CI (both live Bitbucket factories, 2026-07-23), the
gate merged on nothing at all ("no checks" read as green). Every external
reference converges on the same fixes: independent verification, risk
tiering, and mechanical floors ("the model that wrote the code is too nice
grading its own homework"; "invest in the gap between generated and
proven").

## Chunks (one PR each; FACTORY.md contract section updated in the same PR)

1. **Gate floor — SHIPPED in this PR (1.9.0).** `gateCommand` +
   `gateSuiteTimeoutMin` config: the merge gate runs the repo's own suite
   on the MERGED tree (meta worktree, between `merge --no-commit` and the
   push); red aborts the merge and leaves a fix note with the output tail.
   No CI checks AND no gateCommand → the gate refuses to auto-merge and
   doctor's `CI under auto-merge` row is a hard fail (was a warn).
2. **Risk tiers — SHIPPED (1.10.0).** `riskTiers.high` path-prefix list
   in config; a PR touching a high-tier path (auth, payments, migrations,
   CI config…) parks for owner review exactly like `Gate: human`, at
   every autonomy level that reaches the gate. Generalizes the
   deployed-tooling refusal already in `landMerge`; the owner's merge
   closes the parked task mechanically; doctor fails on a malformed
   `riskTiers` instead of letting a typo turn the floor off.
3. **Injection posture — SHIPPED (1.11.0).** `## Forge inputs` tags every
   issue and comment `(owner)` or `(UNTRUSTED)` — compared on stable ids
   (gh login, Bitbucket uuid, Jira accountId) against the authenticated
   account, fail-closed when identity is unavailable; triage/report
   prompts take instructions only from owner-authored content; doctor
   warns (`injection surface`) on auto-merge + publicly writable tracker.
4. **Acceptance grader — SHIPPED (1.12.0).** Driver-spawned independent session (config
   `graderModel`, default opus) in its own throwaway worktree, briefed by
   the DRIVER from the task's `Acceptance:`/`Verify:` lines — never by the
   implementer. Verdict via a new `grade_verdict` MCP tool (per-criterion
   pass/fail + evidence); the gate merges only on a recorded pass.
   Skillset alignment rides along (backlog model rubric gains the fable
   tier; cost-era "one review pass" language updated).
5. **Metrics — SHIPPED (1.14.0).** Per-session `metrics.jsonl` extracted from streams the
   driver already keeps: end reason, peak context, per-turn token
   trajectory, permission-denial count, tool histogram. Feeds plan
   correction, the no-progress breaker, and later improvement reviews.
6. **Run-until-done — SHIPPED (1.15.0).** `dev --until-done`: chain triage→dev→report cycles
   until the backlog is done or only human-parked work remains; exits on
   STOP and on a no-progress breaker (N sessions on one task with nothing
   merged → park it; all tripped → end). Digest per cycle. Requires
   chunks 1–2; recommended with `schedule: manual`.
7. **Toolchain manifest — SHIPPED (1.16.0, epic complete 2026-07-26).**
   `toolchain: [{name, check}]` in config; doctor
   verifies each; the existing `--scheduled` preflight then stops a window
   before it burns sessions against a missing tool.

## Rollout notes

- Chunk 1 needs per-factory `gateCommand` values set machine-side at
  deploy (the Bitbucket pair first — they are the zero-CI case; GitHub factories
  already have CI via self-hosted runners and may add gateCommand for the
  combination-bug coverage).
- Model-routing floors shipped ahead of the epic (2026-07-24, config
  only): the Bitbucket pair now runs `triageModel: fable`, `model: opus`.
- Bitbucket Pipelines: owner decided HOLD OFF (separate Bitbucket billing);
  the gateCommand floor covers the hole with zero external spend.
- Known limit: doctor's CI detection reads `.github/workflows` only — a
  Bitbucket factory that later turns Pipelines on still needs a
  gateCommand until detection goes forge-generic (revisit with the
  Pipelines decision).
- Shadow-mode flip protocol (gate grades but the owner merges, N agreeing
  windows before flipping a project to auto-merge) and digest upgrades ride
  chunks 4–6 as their operational halves.

## Sources (discovery session 2026-07-23)

Read during discovery — the material the Why section distills:

- https://x.com/steipete/status/2063697162748260627 — steipete on agent
  harnesses/loops (the thread that opened the session)
- https://x.com/akshay_pachaar/status/2041146899319971922 — loop
  engineering thread
- https://addyosmani.com/blog/agent-harness-engineering/
- https://addyosmani.com/blog/loop-engineering/
- https://leanware.co/insights/ralph-wiggum-ai-coding — the "Ralph
  Wiggum" outer-loop pattern
- https://www.firecrawl.dev/blog/loop-engineering
- https://claude.com/blog/getting-started-with-loops
- https://claude.com/blog/building-verification-loops-in-claude-code-with-skills
- https://claude.com/blog/how-anthropic-secures-its-ai-native-software-development-lifecycle
- https://claude.com/blog/ciso-guide-to-agentic-ai
- https://claude.com/blog/how-datadog-built-a-universal-machine-tool-for-claude-code
- https://claude.com/blog/working-at-the-frontier-rakuten
- https://claude.com/blog/working-at-the-frontier-how-cognition-trusts-claude-fable-5-to-work-through-the-night
- https://claude.com/blog/working-at-the-frontier-why-base44-trusts-claude-fable-5-with-their-most-challenging-engineering-work
- https://claude.com/blog/working-with-claude-fable-5-in-claude-cowork
- https://claude.com/blog/ai-code-migration

Surfaced by the searches but not read (leads for a future pass):

- https://www.langchain.com/blog/the-art-of-loop-engineering
- https://cuigh.com/posts/stop-prompting-design-loops/
- https://dev.to/truongpx396/the-agentic-loop-a-practical-field-guide-mnc
- https://github.com/robinjose911/loop-engineering-handbook/blob/main/SOURCES.md
- https://unlock-ai.natebjones.com/guides/agents/maintenance
- https://visualstudiomagazine.com/articles/2026/07/22/microsoft-agent-framework-makeover-claws-loops-and-harnesses.aspx
- https://medium.com/@shanewang199512/2026-agent-harness-the-game-changer-for-ai-applications-if-youre-not-the-model-you-re-the-e49722a23967
