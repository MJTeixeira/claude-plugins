---
name: debugging
description: Bug, test failure, or unexpected behavior whose cause is unclear — use BEFORE proposing any fix.
---

# Debugging

Never fix what you can't explain. A fix without a root cause is a symptom
patch that will come back.

## The loop

1. **Reproduce** — get the failure happening on demand. If there's no failing
   test, write a minimal repro test first; it becomes the RED test for the fix
   (see `tdd`). If you can't reproduce, gather more facts — don't theorize.
2. **Read the actual evidence** — the full error message, stack trace, logs,
   the real values at the failure point. Not what you assume they say.
3. **One hypothesis** — state the single most likely cause, specific enough to
   be falsifiable ("X is null here because Y runs before Z").
4. **Cheapest experiment** — the smallest check that confirms or kills the
   hypothesis: a log line, an assertion, running one test, inspecting state.
   Change one variable at a time.
5. **Repeat** until the hypothesis survives and explains every observed
   symptom. Then fix at the cause, keep the repro test, and remove all
   temporary instrumentation.

Anti-patterns: shotgun-changing several things at once; "fixing" by adding a
null check where the null shouldn't exist; retrying flaky failures until they
pass; declaring victory without re-running the original repro.

**Escalation rule:** ~3 failed attempts at the same problem with no new
information → stop. Write up the symptom, hypotheses tried, and evidence
gathered; then ask the user (interactive) or record it as blocked and move to
other work (unattended). Thrashing degrades the code and burns tokens.

**Exit:** if the root cause would bite the next agent too, add it as a
Gotcha bullet in the relevant `.docs/<area>.md` before moving on.

## When the cause is far from the symptom

If the error appears deep in execution and the bad data/state clearly
originates somewhere upstream (unknown where), read
`references/tracing.md` — backward call-stack tracing with temporary
instrumentation.

## When it's in a browser

If the symptom is frontend behavior (rendering, events, network, state in a
webapp) and there are no useful server-side traces, read
`references/browser.md` — console/network/screenshot recipes using the
available browser tools.
