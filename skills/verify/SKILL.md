---
name: verify
description: Prove a finished change actually works by driving the real product, not just its tests, before declaring done on anything with a runtime surface.
---

# Verify — drive the product

Tests prove the diff; driving the product proves the task. See the changed
behaviour happen for real, once, before declaring anything done.

Start from the task's `Verify:` line — it is the command someone already agreed
proves this task, and in an unattended window it is the command that will be run
verbatim. Then drive the product yourself. A human is present here: visual tools
are fair game, and anything you genuinely cannot self-judge — aesthetics, feel —
you show them rather than guess at.

## Recipes

### Webapp

- Start the dev server (or use the running one); hard-reload.
- Drive the changed flow with the browser tools — navigate, click, fill —
  screenshot the result, compare it against intent.
- Watch the browser console and the dev-server terminal throughout. New errors or
  warnings are failures even when the page looks right.
- If UI changed, sweep the breakers: empty data, long strings, narrow viewport.

### Mobile

- iOS: boot a simulator (`xcrun simctl boot <device>`), build and install, drive
  the flow, `xcrun simctl io booted screenshot out.png` and read the screenshot.
  Logs via `xcrun simctl spawn booted log stream --predicate`, scoped to the app.
- Android: `emulator -avd <name>` or a device from `adb devices`; install; drive;
  `adb exec-out screencap -p > out.png`; `adb logcat` filtered to the package.
- With no simulator or emulator available, say so plainly in the summary.

### Desktop

- Launch via the project's own run command.
- Drive the changed flow, take an OS screenshot (`screencapture -x out.png` on
  macOS) and read it.
- Watch the app's log output and stderr during the flow.

### CLI, API, library

- CLI: run the changed command with realistic arguments plus one edge case (empty
  input, a bad flag) — check output *and* exit code.
- API: curl the changed endpoint, happy path plus one auth or validation failure;
  check status codes and body shape.
- A library with no runnable surface: a realistic integration-style test you
  watched fail counts as the drive. Unit mocks do not.

## Rules

- Claim done only on **fresh evidence** — output or screenshots produced in this
  session, for the thing you changed. Never a memory of an earlier run, never an
  inference from code that reads correctly.
- Verify what you changed. Re-driving untouched flows, or re-proving what CI
  already proved, is time spent buying nothing.
- Scratch probes — seed scripts, curl loops, one-off harnesses — live in a
  gitignored scratch directory, never the repo root.
- Report what you drove and what you saw, quoted where it matters. "Verified" on
  its own is not a report.
