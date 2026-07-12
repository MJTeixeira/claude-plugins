---
name: tdd
description: Any small or feature-sized code change — write the failing test first, watch it fail for the right reason, then write minimal code to pass.
---

# Test-driven development

## The cycle

1. **RED** — write the test for the next piece of behavior. Run it. **Watch it
   fail, and check it fails for the expected reason** (the behavior is missing),
   not from a typo, bad import, or setup error. A test you never saw fail
   proves nothing.
2. **GREEN** — write the minimal implementation that makes it pass. Run the
   test again and see it pass. Don't implement ahead of the tests.
3. **REFACTOR** — clean up implementation and tests with everything green.
   Re-run after refactoring.

For a small fix, one cycle is usually enough. For a feature, write the tests
for the current chunk (per the plan's test list) before implementing that
chunk — not the entire feature's tests up front if chunks are independent.

If you loop 3+ times on the same failing test without progress, stop patching:
switch to the `debugging` skill and root-cause it.

## Test-quality checklist

This is the canonical copy — apply it to every test you write; other skills
reference it, never duplicate it.

1. **Behavior, not implementation** — asserts observable outcomes (return
   values, state changes, emitted output), never internal call sequences or
   private structure.
2. **Fails for exactly one reason** — one scenario per test; the name says
   which behavior broke.
3. **Proven non-trivial** — you watched it fail before implementing (RED). No
   tests that pass against an empty implementation.
4. **Mocks only at boundaries** — fake external systems (network, clock, fs),
   not the unit under test or its immediate collaborators. A test that only
   exercises mocks tests nothing.
5. **Named after user-visible behavior** — "rejects expired token", not
   "test_validate_2".

## Hygiene (after everything passes)

- Delete redundant scenarios that lock in the same behavior twice, and any
  debug/scratch tests left over from investigation.
- Sweep the new tests against the checklist above once, as a batch.
- Run the project's full relevant suite one final time — fix anything broken,
  even if pre-existing.
