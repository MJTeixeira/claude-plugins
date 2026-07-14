---
name: grill-me
description: Scope or requirements are ambiguous before planning — batched Socratic questioning that pins scope boundaries, success criteria, and assumptions into a short scope contract. Also on explicit request ("grill me").
---

# Grill-me (scope interrogation)

Before a plan exists is the cheapest moment to discover you misunderstood the
task. This is a QUESTIONING pass, not a design pass: surface what is unclear
and pin it down — don't argue for an agenda.

## When

- `dev-workflow` step 2 sends you here when scope stays ambiguous after
  exploring (test: you can state two plausible versions of "done").
- The user asks: "grill me", "poke holes in this", "help me scope this".
- Skip when one reading survives exploration, or the user says
  "skip the grill".
- NEVER in unattended sessions (factory windows, headless `-p` runs) —
  there is no one to answer. Follow your session's own contract instead:
  in a factory, `open_question` + mark blocked/proceed conservatively.

## How

- Ask in BATCHES — AskUserQuestion when available, else one numbered list:
  3-5 questions, at most 2 rounds. Round 2 only for follow-ups the first
  answers created. Never one-question-at-a-time drip.
- Only ask what the repo can't answer. Codebase facts (existing patterns,
  current behavior, feasibility) are yours to find, not the user's to recall.
- Pick the 3-5 sharpest for THIS task from:
  - **Scope boundary** — what is explicitly OUT? The nearest adjacent thing
    we are NOT building?
  - **Done test** — what observable behavior proves it works?
  - **Riskiest assumption** — what is being taken for granted that, if wrong,
    changes the approach?
  - **Data/state** — does this touch existing data/users (migration) or is it
    greenfield?
  - **Blast radius** — which existing flows are allowed to change behavior?
  - **Priority under constraint** — if it had to ship at half the size, what
    survives?

## Output — the scope contract

End with a ≤10-line contract and carry it into the plan's Scope section:

```
In:        # 2-4 bullets
Out:       # the explicit exclusions, by name
Done when: # observable checks
Assumes:   # what the user just confirmed
```

Plan against the contract. If implementation later contradicts it, stop and
renegotiate — never silently widen scope.
