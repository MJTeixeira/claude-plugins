---
name: verify
description: Prove a finished task actually works by driving the real product headlessly, before the review pass and the PR. Use this on every task with a runtime surface once the tests are green — a passing suite around a route that 400s in the real server is a failed task with green tests, and in an unattended window nobody will notice but the grader.
---

# Verify — drive the product (factory windows)

Tests prove the diff; driving the product proves the task. A passing suite
around a route that 400s in the real server is a failed task with green
tests. Climb this ladder as far as the task's acceptance criteria reach —
and no further. No human is watching: everything here is headless, and
evidence means captured output, not eyes on a screen.

## The ladder

1. **Tests** — the `implement` skill's red-green loop; already done by the
   time you're here. Not verification of the task, only of the code.
2. **Drive the product headlessly** — start the real thing and exercise the
   changed behavior end-to-end, from outside, the way a user or caller
   would. Fresh evidence from THIS session: command output, response bodies,
   exit codes — never inference from code that looks right.
3. **Human eyes** — visual quality, game feel, aesthetic judgment. You
   cannot self-judge these: that's a `Gate: human` task or an
   `open_question` (→ needs-human). Never talk yourself into
   "probably fine" — fail toward the owner.

## Finding the command

Start from the task's `Verify:` line — someone already agreed it proves this
task, and the grader will run it verbatim. For anything beyond it (booting the
server, running the suite, building), `CONTEXT.md` § Commands pins this repo's
canonical commands. If that section is missing, derive the command from the repo
and name it in your report, so the next session inherits it instead of paying to
re-derive it.

## Headless recipes (step 2, per stack)

- **CLI** — run the real binary/entry point with real arguments; assert on
  stdout/stderr and exit code. `--help` proves nothing.
- **Server/API** — boot the server (background it, capture the log), then
  `curl` the changed endpoints: happy path + one failure path. Check status
  codes AND response bodies. Kill the server after.
- **Web UI** — headless browser (Playwright) against the running app: load
  the page, perform the changed interaction, assert on resulting DOM/text.
  If the project has an e2e harness, extend it; if not, a one-off script in
  `.factory/tmp/` is fine.
- **Godot** — `godot --headless` (see the `godot` skill): run the scene or
  a test script that exercises the change; grep the output for errors.
- **Unity** — `unity -batchmode -nographics -runTests` (see the `unity`
  skill) plus an EditMode/PlayMode test that drives the changed behavior.
- **Library (no runtime surface)** — step 1 already covers it; write one
  consumer-style snippet only when the public API shape changed.

## Rules

- Verify what YOU changed — don't re-drive flows this session never
  touched, and don't re-prove what CI or a previous session already proved.
- The task's `Verify:` line is the contract: run it verbatim. If it only runs
  the suite (`npm test`, the configured gate command), it proves the diff and
  not the task — the merge gate already runs that on the merged tree. Run it
  anyway, ALSO drive the product once (step 2), and say in your report that the
  line was weak, so it gets rewritten.
- Scratch probes (seed scripts, curl loops, one-off Playwright scripts) go
  in `.factory/tmp/`, never the repo root.
- Evidence goes in the PR body / report summary: the command you ran and
  one line of what it returned.
