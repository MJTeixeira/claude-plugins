# Issue tracker: Local Markdown

Inbound requests for this repo live as markdown files in `.scratch/`.

This is the **inbound** surface only — the raw bug reports and feature requests `/triage`
works. The flow's own artefacts never live here: specs go to `.factory/spec/`, tasks and
decision tickets to `.factory/backlog/`.

It is also **not the Factory's tracker**. A registered Factory files its
needs-human questions and its daily log wherever its own `config.json` says —
the fleet uses Discord threads — and reads your answers back from there. That is
a separate surface carrying traffic in the opposite direction: the Factory asking
you, not other people asking the project.

## Conventions

- One issue per file: `.scratch/issues/<NN>-<slug>.md`, numbered from `01`
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings)
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/issues/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Wayfinding operations

None here. `/chart` writes its map into `.factory/backlog/index.md` and its decision
tickets into the effort's epic file beside it, on every tracker — the storage is fixed by
the backlog format, so there is nothing per-tracker to configure.
