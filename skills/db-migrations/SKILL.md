---
name: db-migrations
description: Creating or editing database schema migrations (Prisma, Alembic, Flyway, Rails, raw SQL) — discipline for changes that can destroy data. Not for query tuning or ORM usage.
---

# Database migrations

Migrations are the one place a coding mistake destroys data. Slow down here.

## Hard rules

- Never edit a migration that has been applied anywhere beyond your machine
  (CI, a teammate, prod). Fix forward with a new migration. Checksummed tools
  (Flyway, Prisma) fail loudly on edits; others drift silently, which is worse.
- Never run reset/wipe commands (`prisma migrate reset`, `db push
  --force-reset`, `flyway clean`) against a database you didn't create this
  session. If the tool suggests a reset to resolve drift, stop and ask.
- Destructive DDL (DROP TABLE/COLUMN, type narrowing, NOT NULL on an existing
  column) gets its own migration and an explicit callout in the PR body. In
  autonomous sessions, destructive DDL on a shared database is a stop-and-
  escalate, not a judgment call.
- The schema change and its generated migration land in the same commit. If CI
  applies migrations from scratch, a green run proves they work — don't
  re-verify locally.

## Compatibility (expand → contract)

Code live during a deploy must work with both old and new schema:

1. Expand: add the new column/table nullable; ship code that handles both.
2. Backfill: a separate data migration, batched on big tables — one giant
   UPDATE holds a lock for its whole runtime.
3. Contract: only after old code is gone — add NOT NULL, drop the old column.

Skipping this is fine only when downtime is acceptable (dev-stage project,
hobby VPS) — say so in the PR.

## Locks

- Index on a big live table: use the non-blocking form (Postgres
  `CREATE INDEX CONCURRENTLY` — must run outside a transaction; MySQL
  `ALGORITHM=INPLACE`).
- Type changes and most NOT NULL additions rewrite or lock the table — check
  table size before locking anything shared.

## Rollback honesty

Write the down path only if it's real. If the migration destroys data, mark it
irreversible in a comment instead of shipping a lying `down()`.

Tool-specific traps (Prisma drift/shadow DB, Alembic autogenerate blind spots,
Flyway checksums): `references/tools.md`.
