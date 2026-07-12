# Migration tool traps

## Prisma

- `migrate dev` is a DEV command — on drift it offers to reset the database.
  Production and CI use `migrate deploy` (applies pending, never resets).
- `db push` writes schema without recording history — never on a shared DB;
  it guarantees future drift.
- Drift ("migration history and schema disagree") means someone edited an
  applied migration or pushed around history. Diagnose which; don't accept
  the reset offer on a DB with data.
- `migrate dev` needs a shadow database (CREATE DATABASE permission). On
  restricted hosts set `shadowDatabaseUrl` explicitly.

## Alembic

- `--autogenerate` is a diff guesser — review its output line by line.
  Known blind spots: renames (emitted as drop + add = data loss; hand-edit to
  `alter_column`/`rename_table`), server_default changes, and some constraint/
  enum changes depending on dialect.
- Postgres `ALTER TYPE ... ADD VALUE` can't run inside a transaction block on
  older versions — needs `op.execute` with autocommit isolation.
- Multiple heads (parallel branches both added migrations): `alembic merge`,
  don't renumber existing files.

## Flyway

- Applied migrations are checksummed — editing one fails every future deploy
  with a checksum mismatch. `flyway repair` rewrites the record; use it only
  when you can explain why the checksum changed.
- Version collisions from parallel branches (two V42__) fail at deploy, not
  merge — renumber yours before merging.

## Raw SQL / no framework

- Keep an applied-migrations table (filename + checksum + applied_at) even if
  hand-rolled; "run whatever is in the folder" schemes reapply or skip
  silently.
- Wrap each migration in a transaction where the DDL allows it (Postgres:
  most DDL is transactional; MySQL: DDL auto-commits — order statements so a
  partial failure leaves a recoverable state).
