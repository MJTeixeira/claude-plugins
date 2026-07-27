# Plan format

Keep the whole plan under a page. Bullets over prose.

```markdown
## Goal
One or two sentences: the user-visible outcome.

## Approach
3-6 bullets: the mechanism. Name existing functions/patterns being reused
(with file paths) and anything new being introduced.

## Files
- path/to/file — what changes
- path/to/new_file — why it must be new (existing code checked: <what you looked at>)

## Tests
- test name/scenario — the behavior it locks in
(one line each; these become the RED tests in the tdd skill)

## Done evidence
The end-to-end check that proves the feature works and what it must show
(inherit the scope contract's "Done when" if grill-me ran). Named BEFORE
implementation; finishing refuses "done" until exactly this check ran
in-session with its output shown.

## Chunks (only if >5 independent pieces)
1. chunk — done when <verifiable state>
2. ...

## Open questions
Anything the user must decide. If empty, say "None."
```

Rules:

- Every test in the list must describe observable behavior, not internals
  (checklist in the `tdd` skill applies).
- Done evidence must be executable this session — a command, or a flow
  driven per the `verify` skill. "Code looks right" and "tests exist" are
  not evidence; the unit tests already have their own section.
- Don't restate the codebase back to the user; they know it. State only what
  will change.
- If two approaches are genuinely viable, recommend one and give the tradeoff
  in one line — don't write an alternatives survey.
