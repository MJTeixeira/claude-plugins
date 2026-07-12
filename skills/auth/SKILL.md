---
name: auth
description: Implementing or changing authentication/authorization — logins, sessions, JWTs, OAuth/OIDC, password reset, API tokens. The finishing skill's security pass reviews the diff; this guides building it.
---

# Auth flows

Rule zero: reuse the project's existing mint/verify path. A second parallel
auth path is how bypasses are born.

## Choosing (when the project has no auth yet)

- Default to server-side sessions via the framework's own machinery —
  revocation is free and the pitfalls are pre-solved.
- Pick JWTs only when a stateless bearer is genuinely needed (multiple
  services, third-party API consumers). Before choosing, answer in the plan:
  how do we revoke? Short expiry + refresh rotation, a denylist, or accepted
  risk — written down.

## Universal rules

- Auth endpoints never reveal account existence: same error and status for
  wrong-password vs no-such-user; reset always responds "if the account
  exists, we sent an email".
- Rate-limit login, reset, and signup.
- Passwords: the framework's hasher (argon2/bcrypt). Never hand-rolled
  hashing or `==` on secrets (constant-time compare).
- Session/token cookies: httpOnly + Secure + SameSite. Regenerate the session
  id at login (fixation); destroy server-side state on logout and password
  change.

## JWT traps

- Pin the algorithm allowlist, issuer, and audience at verify time — honoring
  the token header's own `alg` is the classic bypass.
- Claims are readable by anyone: no PII or secrets in them. Keep expiry short.
- Signing secret from env/secret store, never committed.

## OAuth / OIDC traps

- Exact-match redirect URI allowlist; validate `state`; PKCE for public
  clients (SPA, mobile, CLI).
- Verify the token's `aud` is your client id; never accept an access token
  where an id token is required.
- Provider email is not identity unless the provider marks it verified —
  auto-linking accounts by unverified email is an account takeover.

## Authorization

Every new endpoint gets an object-level check: user A must not reach user B's
resource by changing an id. Enforce roles server-side; client-supplied role
data is never trusted (claims you minted yourself are fine).

Per-flow checklists (reset tokens, refresh rotation, API keys):
`references/flows.md`.
