# Homes

Where a block of documentation belongs. Read at step 4 of [SKILL.md](./SKILL.md).

## The four homes

- **`CONTEXT.md`** — the glossary. Terms this project's domain uses, and nothing
  else. A `CONTEXT-MAP.md` plus per-context files where the repo has several.
- **`docs/adr/`** — decisions. `/domain-modeling` owns the test for what
  qualifies; apply it rather than restating it.
- **`docs/agents/*.md`** — what an agent needs to work with this repo: the
  conventions and procedures it follows, and the contracts it must satisfy.
  Each named by a line in the entry file.
- **`CLAUDE.md` / `AGENTS.md`** — the entry file. Pointers, not content.
- **`README.md`** — the human entry point, outside the pattern. What is
  correctly in it is **already home**: it stays, and it is not residue.

Blocks that are really requirements or really tasks have destinations already:
`.factory/spec/` and `.factory/backlog/`.

## Every block lands in a home or stays exactly where it is

There is no fifth home. A block matching none of the four stays in the file it
is already in and goes on the unhomed list in the report.

Reach that conclusion last. Content that looks homeless is nearly always
classified too coarsely. One 319-line "pattern" document held a stack decision
(ADR), ten numbered requirements (spec), a repo contract that already lived in
another repo, a completed migration log (history), a follow-up list (backlog)
and a teardown runbook (`docs/agents/`). Split the file into blocks and the
homelessness went with it.

Creating a new doc file to hold the residue is inventing a fifth home.

## Kinds that look homeless

**Instructions written for an agent to follow** — a review rubric, an output
format, a procedure with steps. Home: `docs/agents/<name>.md`, plus one line
naming it in the entry file. Skills ship from one place and install everywhere;
a `SKILL.md` in a repo with no plugin and no marketplace entry is a markdown
file with frontmatter, so the description meant to make it fire is never read.
The `docs/agents/` file carries the same content, reaches the same agent, and
needs no install.

**Interface contracts** — a wire format, an exit-code table, a protocol another
repo builds against. Home: `docs/agents/<name>.md`. The consumer is an agent
writing code against this repo, which is what that directory is for. A contract
is not a decision and not a glossary: the ADR records *why* the shape was
chosen, the contract file records the shape. In a contract-heavy repo this is
most of the docs, so sort it before reaching for the unhomed list.

**Command lists** — how to build, test, run and deploy. The environment already
states these: the package scripts, the Makefile, `--help`. A doc that restates
them is a cache that goes stale the first time one changes. Delete the list, and
keep only what the environment cannot say — the unwritten convention, the
gotcha, the reason one of them exists.

**Session state** — `HANDOFF.md`, `NEXT-SESSION.md`, postmortems, dated "where
things stand" narratives. Mine the decisions into ADRs; delete the rest.
Progress belongs on the task it is progress on.

**Generated doc maps** — a repo map some tool wrote, full of machine-shaped
links. Delete the file and the generator, in the same commit; deleting the file
alone leaves something that puts it back.

**Task write-ups inside area docs** — `## Create account (T-026)` in the middle
of a document about accounts. The record belongs on the task in
`.factory/backlog/`. Move it there, delete it from the doc.

**A block whose home is another repo.** Before calling anything unhomed, grep
the sibling checkouts for its subject. A fleet-wide contract living in one
machine's repo, a rule another repo already states — both look unhomed until
you look outside. Report it: name the block, the repo, and what is already
there. Moving it is two repos' work and a decision of its own.

## Traps

- **Sorting by duplication instead of by home.** Under-cuts by roughly half. The
  question is whose file this is, not whether the text appears twice.
- **Calling something a duplicate without opening both files.** One pass called
  136 lines a duplicate of another file; 26 were.
- **Calling something unhomed without opening the file.** The same error,
  inverted, and the more expensive one — it leaves the residue in place.
- **Editing while measuring.** A measuring agent caught the file changing under
  it mid-run. Serialize them.
- **Trusting a subagent on how the code behaves.** One draft listed an enum with
  one name invented and one missing; reading the source caught it.
- **One ADR per deleted block.** Independent agents once proposed eleven ADRs
  and eight amendments, all numbered from the same next integer; the real set
  was five and five. Adding sediment to remove sediment.
- **Leaving a pointer to a path the consumer does not have.** A file that ships
  to people without the repo cannot cite `docs/`. Inline the meaning, or name
  something that ships beside it.
