# Attribution

`review` is built on two MIT-licensed upstreams. `LICENSE` beside this file
carries all three copyright notices, as MIT requires:

- **[mattpocock/skills](https://github.com/mattpocock/skills)** by Matt Pocock,
  at commit `d81f3a183412e71a5b1e84ca21bc1a35eea03a60`.
- **pstack** by Lauren Tan, as ported in `pstack-claude` `0.15.2-port.6`
  (upstream [cursor/plugins](https://github.com/cursor/plugins) `pstack/` at
  `e31650eea443aaea1e84cc15d88c13f40080b275`).

The review calls no skill from either. pstack does not load in a factory
session, so the passages the review needs are copied into `baseline.md`.

## Provenance

| Passage | Source | Deviation |
|---|---|---|
| `skills/review/baseline.md`, "Smell baseline" (the two binding rules and the twelve smells) | mattpocock/skills `skills/engineering/code-review/SKILL.md:38-56` | Verbatim. |
| `skills/review/baseline.md`, "Review Rubric" | pstack `skills/interrogate/references/rubric.md` (whole file) | Verbatim, headings one level down. |
| `skills/review/baseline.md`, "Test Behavior, Not Implementation" (the check, the five shapes, the fix, what to keep) | pstack `skills/principle-test-behavior-not-implementation/SKILL.md:6-24` | Verbatim, heading one level down. |
| `skills/review/SKILL.md`, step 1 (fixed point, three-dot diff, commit list, fail early on a bad ref or an empty diff) | mattpocock/skills `code-review/SKILL.md:17-23` | Reworded. The default fixed point is the remote's default branch instead of asking the user. |
| `skills/review/SKILL.md`, step 2 (spec sources in order) | mattpocock/skills `code-review/SKILL.md:25-32` | Reworded. Issues are read with `gh`; the `docs/`, `specs/`, `.scratch/` search and asking the user are gone. |
| `skills/review/SKILL.md`, "Standards" and "Spec" parts | mattpocock/skills `code-review/SKILL.md:34-41`, `:58-72` | Reworded. The standards sources are `CODING_STANDARDS.md`, `CLAUDE.md` and `AGENTS.md`. The two axes run in this session, not in parallel sub-agents, because the review must run in a session whose tool list may not include `Agent`. |
| `skills/review/SKILL.md`, the sentence on traced findings and "I would have done it differently" | pstack `skills/interrogate/references/lead-judgment.md:22-32` | Reworded. |
| `skills/review/SKILL.md`, step 5 (separate parts, no reranking) | mattpocock/skills `code-review/SKILL.md:74-87` | Reworded. |

The rest of `skills/review/SKILL.md` is new: the stale-doc part, the merge
danger, fixing and committing, the two unfixable cases, and the headless rules.
