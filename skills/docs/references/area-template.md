# Area file template + worked example

Template (all sections optional — include only what has content):

```markdown
# <area>

## Contracts
- <interface/function others rely on, and the rule callers must follow>

## Invariants
- <what code in/around this area may safely assume>

## Gotchas
- <surprising behavior that will bite an agent that doesn't know it>

## Why
- <decision + rationale, so nobody "fixes" it back> (dated if useful)
```

Worked example — `.docs/auth.md`:

```markdown
# auth

## Contracts
- `issueToken(user, scope)` is the ONLY token mint point; everything else
  verifies. Adding a second mint path breaks key rotation.
- Session cookie name and TTL come from `config/auth.ts`, not env vars.

## Invariants
- A user row is never deleted; deactivation sets `disabled_at`. Code may
  assume FK targets exist.

## Gotchas
- `verifyToken` returns expired-but-valid tokens with `expired: true` —
  callers MUST check the flag; several past bugs came from skipping it.
- Test fixtures bypass `issueToken`; don't use them to test minting.

## Why
- JWTs over server sessions because the mobile app is offline-first
  (decided 2025-Q3).
```

Litmus test for each bullet: would an agent without it either (a) do the wrong
thing, or (b) burn >5 tool calls rediscovering it? If neither, cut it.
