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

## Chunks (only if >5 independent pieces)
1. chunk — done when <verifiable state>
2. ...

## Open questions
Anything the user must decide. If empty, say "None."
```

Rules:

- Every test in the list must describe observable behavior, not internals
  (checklist in the `tdd` skill applies).
- Don't restate the codebase back to the user; they know it. State only what
  will change.
- If two approaches are genuinely viable, recommend one and give the tradeoff
  in one line — don't write an alternatives survey.
