# Attribution

`code4food-live` is built from two MIT-licensed upstreams. `LICENSE` carries
every copyright notice, as MIT requires:

- **[mattpocock/skills](https://github.com/mattpocock/skills)** by Matt Pocock,
  at commit `d81f3a183412e71a5b1e84ca21bc1a35eea03a60`: 18 skills, under his
  names.
- **[humanlayer/skills](https://github.com/humanlayer/skills)** by HumanLayer,
  at commit `ca7c8088db69e315a8b2deea43820270457f8f3c`: `show-me`
  (`plugins/show-me/skills/show-me/`) and `visual-pr`
  (`plugins/visual-pr/skills/visual-pr/`).

`verify` is ours, with no upstream.

## The standing rule

Upstream text is copied at the pin and changed only where the factory board
forces it: a repository has one linked board, `factory: <repo>`, every issue on
it is a task the factory runs, a spec is an issue off the board, and a
repository keeps no ADRs, no `docs/` and no `CONTEXT.md`. Each row below names
what changed and why. Every file not listed is byte-identical to its upstream,
`agents/openai.yaml` sidecars included.

The changes the previous `code4food-skillset` carried on Matt's text (the
renames to `grill`, `spec`, `tickets` and `chart`, the relaxed file-path rule,
the backlog fields) are gone: none of them is needed by the board.

## Provenance

| File | Upstream | What changed, and why |
|---|---|---|
| `skills/to-spec/SKILL.md` | Matt `to-spec` | The `/setup-matt-pocock-skills` line becomes the board rule: the spec is an issue in this repository, the epic, off the board, ending in a `## Tasks` checklist (`- [ ] #41`). Step 3 publishes with `gh issue create`, drops the `ready-for-agent` label (the board, not a label, says what a factory runs) and removes the spec from the board if an auto-add workflow put it there. The template gains an empty `## Tasks` section. "Respect any ADRs" goes: there are none. |
| `skills/to-tickets/SKILL.md` | Matt `to-tickets` | Description: published to the board, not a configured tracker. The `/setup-matt-pocock-skills` line becomes the board rule, with a task sized to one unattended session of 150k to 200k tokens. Step 5 is rewritten: each ticket is created with `gh issue create`, added to the board with `gh project item-add` (no draft step), and ordered with `gh issue edit --add-blocked-by` (no sub-issues); the spec's checklist gains each ticket. The local-file template goes and the issue template becomes the driver's admit fields (`Spec`, `Acceptance`, `Verify`, `Model`, `Effort`, `Risk`), with the `feature <name>` and suite-only Verify rules, because a body that fails the parser is refused and parked. "Do NOT modify any parent issue" becomes "only its `## Tasks` checklist". "Respect ADRs" and "In either form" go. |
| `skills/wayfinder/SKILL.md` | Matt `wayfinder` | The `/setup-matt-pocock-skills` paragraph becomes the board rule: the map and its tickets are GitHub issues off the board, children by `gh issue edit --parent`, blocking by `--add-blocked-by`. "Plan, don't do" names `/to-spec` as the handoff. A research ticket's findings go in a comment on the ticket instead of a `research/<name>` branch, matching `research`. |
| `skills/implement/SKILL.md` | Matt `implement` | Rewritten around a board issue: claim by assigning it to yourself (the factory holds an issue assigned to anyone else), then tdd, the issue's `Verify:` line, `/verify`, `/diagnosing-bugs` on a failure, commit, `pstack:no-comments`, `code4food-general:review` in place of `/code-review`, and pstack `poteto-mode`'s "Opening a PR" playbook with `Closes #<n>`. Kept from his text: the tdd line, the typecheck and test cadence, the commit line. |
| `skills/implement/agents/openai.yaml` | Matt `implement` | `short_description` follows the new description. |
| `skills/tdd/SKILL.md` | Matt `tdd` | "Respect ADRs" goes. The refactor pointer names `code4food-general:review` in place of `code-review`, which is not shipped. |
| `skills/diagnosing-bugs/SKILL.md` | Matt `diagnosing-bugs` | "Check ADRs" goes. |
| `skills/improve-codebase-architecture/SKILL.md` | Matt `improve-codebase-architecture` | ADR reads go (lines 14 and 25 upstream) and so does the "ADR conflicts" paragraph. A rejected candidate is offered as a comment on the issue in hand instead of an ADR. |
| `skills/improve-codebase-architecture/HTML-REPORT.md` | Matt `improve-codebase-architecture` | The ADR callout line goes with the ADR-conflicts paragraph it rendered. |
| `skills/domain-modeling/SKILL.md` | Matt `domain-modeling` | `docs/adr/` leaves both file trees and the lazy-creation sentence. "Offer ADRs sparingly" becomes an offer to record the decision as a comment on the issue in hand, pointing at `DECISION-FORMAT.md`. The description says "recording a decision". `GLOSSARY.md` is untouched. |
| `skills/domain-modeling/DECISION-FORMAT.md` | Matt `domain-modeling/ADR-FORMAT.md` | Renamed. The decision lives in an issue comment (`gh issue comment`), not `docs/adr/`; the numbering section goes; the `Status` frontmatter becomes a `Supersedes` link. The template, the three conditions and "What qualifies" are his. |
| `skills/research/SKILL.md` | Matt `research` | Findings go in a comment on the issue the research serves, or a temporary file outside the repository when there is none, never into the repository. Description to match. |
| `skills/retro/SKILL.md` | Matt `retro` | Input widens to a PR and its session, or a week of PRs and their reviews. Step 4 writes what the user accepts: a judgement call into `CODING_STANDARDS.md`, a mechanical one as a lint. The docs-folder pointer and the "Docs" bullet go. |
| `skills/visual-pr/SKILL.md` | HumanLayer `visual-pr` | Gains `disable-model-invocation: true`, so it runs only when the user types it, as its description already says. The description is saved to a temporary file outside the repository instead of `.humanlayer/tasks/`. |
| `skills/visual-pr/references/describe_pr_final_answer.md` | HumanLayer `visual-pr` | The saved-description line reports the temporary path. |

## Verbatim

`grill-me`, `grilling`, `wait-what`, `teach`, `writing-for-agents`,
`prototype`, `codebase-design`, `wizard` and `show-me`, every file. In the
edited skills, every file the table does not name, including
`visual-pr/references/show-me.md`, whose HTML example still names a
`.humanlayer/tasks/` path.
