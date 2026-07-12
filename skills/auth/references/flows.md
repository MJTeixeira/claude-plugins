# Per-flow checklists

## Password reset

- Token: single-use, expires in minutes-to-an-hour, random (not derived from
  user data), stored hashed — a DB leak must not yield usable reset links.
- Consume the token and invalidate all others for the user on success; also
  invalidate on password change from any path.
- Reset must terminate existing sessions (or at minimum offer to).
- The email/response flow never confirms whether the account existed.

## Refresh token rotation

- Rotate on every use: issuing a new refresh token invalidates the old one.
- Reuse of an already-rotated token means theft — revoke the whole token
  family, force re-login.
- Refresh tokens are stored hashed server-side; access tokens stay short-lived
  (minutes) so revocation lag is bounded.

## API keys / machine tokens

- Show the key once at creation; store only a hash. Keep a non-secret prefix
  (`sk_live_...`) so users and logs can identify keys without exposing them.
- Scope keys to the minimum needed; support revocation from day one.
- Keys authenticate services, not humans — don't let an API key mint user
  sessions.

## Session lifecycle

- Absolute lifetime AND idle timeout, both enforced server-side.
- Logout deletes server-side state, not just the cookie.
- Privilege change (role upgrade, email change, 2FA toggle) re-authenticates
  and rotates the session id.

## Login hardening order

If the project needs more than the basics, add in this order (cost/benefit):
rate limiting → lockout with backoff (temporary, or attackers lock users out)
→ 2FA (TOTP before SMS) → new-device notification.
