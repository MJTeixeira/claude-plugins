---
name: converting-docs
description: Convert a repo's existing docs onto the CONTEXT.md + docs/adr/ + docs/agents/ pattern.
disable-model-invocation: true
---

# Converting docs

For a repo whose documentation predates the pattern, or half-adopted it: state
scattered across root markdown files, decisions buried in prose, procedures
written for agents living wherever they were first typed.

The work is finding each block's **home**, then proving the cut before making
it. Classification is where a conversion goes wrong, so it is gated — you
present the whole table and wait.

**Steps 1–5 change no documentation.** Their only output is the table. A run
that stops at the gate is a survey, and is a legitimate way to use this skill on
a repo you are not ready to convert.

## 1. Triage and scope

Establish which of three this repo is:

- **No docs** — nothing of the pattern and nothing to convert. Say so, hand it
  to `/setup`, stop.
- **Partial** — some of the pattern exists: a `docs/adr/` holding one file, an
  index doing an entry block's job. Reconcile with what is there.
- **Old layout** — a hand-rolled doc set, none of the pattern.

Then fix scope. **In scope: markdown a person or an agent reads to understand
the repo.** Out of scope, and listed as such:

- **Markdown a program reads** — config, prompt files, templates. It is code
  wearing a `.md` extension; a pin on it is absolute.
- **`.factory/`** — the flow owns it.
- Vendored and installed trees.

Note whether an entry file (`CLAUDE.md` or `AGENTS.md`) exists and whether it
carries an `## Agent skills` block. Step 6 needs it; the survey does not.

Read the backlog before starting. Where a task already asks for part of this
conversion, the conversion satisfies that task — name it in the report and work
to its acceptance rather than writing the same thing twice. Where that
acceptance and the pattern conflict, because it requires a file the conversion
retires, stop and put it to the user: one of the two has to give, and which is
not yours to choose.

**Done when** the bucket is named and every markdown path in the repo is either
in scope or listed with the reason it is not.

## 2. Measure

Inventory every doc file and every heading in it, with line counts. A 448-line
section is not one thing and cannot be judged as one.

The unit is the **block**, not the heading: where one heading holds several
distinct things, each gets its own row, headed or not.

Fan out subagents — this is legwork — under three constraints:

- **Freeze.** No file in scope is edited while a measuring agent runs.
- **Tables, not prose.** Each agent returns rows: file, block, line count, one
  line on what the block contains, and any `file:line` it relied on. A claim
  about how the *code* behaves is a lead: where it decides a home or a pin, read
  that source yourself; elsewhere the citation carries it.
- **No agent assigns an ADR number.** Numbering is serial, yours, after the gate.

Writing is never fanned out.

**Done when** every in-scope file appears with every block and its line count.

## 3. Find what pins content

Some text cannot move. A test that slices a doc by literal heading string, a
loader that requires a section to exist, CLI output that prints a section name
or a path, a source comment citing an anchor, a task whose `Verify:` line greps
a doc path — each is a **pin**, and a pin changes the plan: the block stays, or
the pin moves in the same commit.

Hunt mechanisms, not strings. Grep for every in-scope **path**, then for the
ways a program reads a doc — `readFileSync` on a `.md`, a literal `"## "` slice,
an anchor, a required-sections list. Grep a heading string only where the
heading is distinctive enough to be worth it; common words like `Context` or
`Status` return noise, not pins.

A heading pin is exact. Punctuation and dash spelling are part of it.

**Done when** every in-scope file has been grepped for by name, every mechanism
that reads a doc has been located, and each pin is on its block's row with the
consumer that holds it.

## 4. Classify by home

Read [HOMES.md](./HOMES.md) now — the home map, the kinds that look homeless,
and the traps.

Sort each block on **whose file this is**, never on whether the text appears
twice. A block can be unique in the whole repo and still belong elsewhere:
"nothing else says this" is a reason to find its home, not a reason to keep it.

You classify from the table, not from the file — with one exception: open the
block before calling it **unhomed**. That label is the expensive mistake, and it
is the one the summaries are least able to support.

Write the table to `.scratch/doc-conversion.md` — file, block, lines, home,
one-line reason, and any pin. Where `.scratch/` is ignored, keep the table
outside the repo and cite its path: an ignored file cannot be the evidence
pass 1 commits. Name the ADRs a block implies by slug; they are numbered in
pass 2. Four of the homes are outcomes rather than destinations:

- **already home** — correctly placed, and stays. Not residue.
- **pinned** — the pin is not yours to move: another repo's code reads it, or
  it is gated on someone else. Where the pin *is* yours, it moves with the
  block and the block homes normally.
- **unhomed** — stays because it matches no home. This is the list the report
  asks for.
- **another repo** — belongs elsewhere; reported, never moved.

**Done when** every block counted in step 2 carries a home and a reason.

## 5. Gate

Present the table and wait for approval.

The table itself, never prose about it — a summary hides the sort axis, which is
the thing most worth catching. A table too large to inline is presented as the
file: point at it, and give the count per outcome so the shape is visible
without opening it.

## 6. Three passes, in order

First the precondition: the entry file carries an `## Agent skills` block. If it
does not, stop and ask the user to run `/setup`, then resume — `/setup` owns
that block's shape. Nothing below writes until it exists.

Each pass is its own commit, and its own PR where the repo does PRs. The order
is what makes the cut provable; the vehicle is free. `.scratch/doc-conversion.md`
is committed with pass 1.

**Pass 1 — contradictions.** A conversion surfaces places where the doc and the
code disagree. Correct the doc: the code is what runs. Where the doc's version
looks deliberate — it describes an intent the code fails to meet — change
neither and list it as a possible code bug. That list is the most valuable thing
this pass yields, and burying it in a deletion diff wastes it.

**Pass 2 — the missing ADRs.** Write every decision that has no record anywhere,
*before* deleting anything, so the cut is provably a deletion of duplicates and
nothing loses its last copy. Hand the writing to `/domain-modeling`, which owns
the ADR and `CONTEXT.md` formats and the test for what deserves an ADR at all.
One ADR per decision, not per deleted block.

**Pass 3 — the cut.** Move each block to its home and delete the source. A file
emptied by the move is deleted, not stubbed — a stub is a second copy of the
location. Grep the repo for every path you delete and fix the references in the
same commit. Delete `.scratch/doc-conversion.md` last.

**Done when** every row in the table is moved, deleted, or explicitly marked as
staying, with none unaccounted for.

## 7. Report

Hand back five lists: contradictions corrected, possible code bugs, blocks that
stayed pinned, blocks that stayed unhomed, and blocks whose home is another
repo. Name any backlog task the conversion satisfied.
