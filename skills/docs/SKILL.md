---
name: docs
description: Project docs for agents (.docs/) — read before answering questions about OR exploring an unfamiliar area; update after finishing a small or feature change.
---

# Agent docs (.docs/)

Persistent, agent-facing project knowledge. Optimized for partial loading:
read the index, then only the areas your task touches.

**Questions route through the index too.** Answering a question about an
area IS working in that area: read the index and the relevant area file
before answering, exactly as you would before editing. Advice given from
memory of how something "probably works" is where wrong sessions start —
a read is always cheaper than acting on a wrong answer.

**Authority order** on conflicting claims: source code > `.docs/`/project
docs > everything else (memories, session summaries, code comments in
OTHER files, chat history). Memories and summaries are leads to verify,
never authorities — they reflect when they were written, not now.

## Layout

```
.docs/
├── index.md      # the map — the only file read unconditionally
├── auth.md       # one file per LOGICAL area (not per folder)
└── billing.md
```

`index.md` — lean by construction: a `Commands` section plus one line per
area. A plain index reads in seconds; some projects legitimately carry more
(a topic router, an authority order) — length earns its place per line, it
is never a quota:

```markdown
# Agent docs map. Read only the area files your task touches.
## Commands
- test: npm test (single file: npm test -- path)
- lint: npm run lint · build: npm run build · run: npm run dev (port 3000)
## Areas
- auth — src/auth/**, middleware/session.ts — token issuance, session lifecycle
- billing — src/billing/**, jobs/invoice* — Stripe sync, invoice state machine
```

`Commands` holds the canonical run/test/lint/build commands (per package if a
monorepo) — read them here instead of rediscovering them each session; fix
them here when they change. Area grammar: `- <area> — <path globs> —
<one-line scope>`. Match your task's files against the globs to decide which
area files to load.

`<area>.md` — a few hundred words is the healthy shape; don't write 5000
where 250 would do, but never drop a load-bearing bullet to hit a number.
Only four sections, all optional:
**Contracts** (interfaces others rely on), **Invariants** (what code may
assume), **Gotchas** (surprising behavior/foot-guns), **Why** (decision
rationale that prevents well-meaning refactors). Template and worked example
in `references/area-template.md`.

## Content rules

- Bullets only. Every bullet must be something an agent would otherwise get
  wrong or spend >5 tool calls discovering. No narrative, no "this folder
  contains", nothing 2 minutes of reading the code would reveal.
- Reference symbols, functions, config keys. Never line numbers, file counts,
  or directory inventories — those rot.
- **Reader-repair rule**: if a bullet contradicts the code you just read, fix
  or delete the bullet on the spot, whatever your current task is.

## Lifecycle

- **No init crawl.** When you finish non-trivial work in an area that has no
  file, write one from what you just learned (the moment you know the most)
  and add its index line. `.docs/` grows toward where work actually happens.
- **Update inline** at the end of every small/feature change: 1-2 edits
  adding/fixing/deleting bullets in the touched area files. No subagent.
  Trivial changes skip docs entirely.
- **Share with subagents**: when spawning Explore or code-reviewer, put the
  relevant `.docs/<area>.md` paths in the prompt.
- An area file growing unwieldy? Split the area, or cut bullets that are no
  longer true or no longer surprising. Never delete information an agent
  still needs just to make a file shorter.

## User-facing docs (README, ONBOARDING, CLAUDE.md, docs sites)

`.docs/` serves agents; humans follow README, setup/onboarding guides, and
CLAUDE.md — and those rot the same way. They matter at every project size,
not just complex ones.

- At the end of any small/feature change, ask: did this alter something a
  human follows — install steps, commands, flags, config keys, product
  claims, architecture described in README/ONBOARDING/CLAUDE.md or a docs
  site? If yes, update the matching doc **in the same branch**. Grep those
  files for the terms you changed; don't trust memory of what they say.
- Reader-repair applies here too: touch a human doc that contradicts current
  reality, fix it on the spot.
- Trivial changes skip this exactly like they skip `.docs/`.
