---
name: verify
description: Live/attended sessions — prove a finished change actually works by driving the real product, not just its tests, before declaring done on anything with a runtime surface. Factory unattended windows use code4food-factory:verify instead, never this one.
---

# Verify — drive the product (live sessions)

Tests prove the diff; driving the product proves the task. See the changed
behavior happen in the real product, once, before declaring done. A human is
present: visual tools (a watched browser, simulator screenshots,
`screencapture`) are fair game, and anything you genuinely cannot self-judge
(aesthetics, feel) you show to the user instead of guessing.

Loaded by `finishing` step 2; also applies on its own whenever the user asks
"does it actually work?". Use `.docs/index.md` → `Commands` for the
canonical run command.

## Recipes (per platform)

### Webapp

- Start the dev server (or use the running one); hard-reload.
- Drive the changed flow with the available browser tools (navigate, click,
  fill); screenshot the result and compare against intent.
- Watch the browser console and the dev-server terminal during the flow — new
  errors/warnings are failures even if the page looks right.
- Sweep the breakers if UI changed: empty data, long strings, narrow viewport.

### Mobile

- iOS: `xcrun simctl boot <device>` (or use the booted one), build+install
  (`xcodebuild ... -destination` or the project's run command), drive the flow,
  `xcrun simctl io booted screenshot out.png` and read the screenshot.
  Logs: `xcrun simctl spawn booted log stream --predicate` scoped to the app.
- Android: `emulator -avd <name>` / running device via `adb devices`;
  install (`./gradlew installDebug` or project command); drive; screenshot via
  `adb exec-out screencap -p > out.png`; logs via `adb logcat` filtered to the
  app package.
- No simulator/emulator available → say so explicitly in your summary; don't
  claim verification you couldn't do.

### Desktop

- Launch the app via the project's run command (Electron: `npm start`;
  native: the built binary).
- Drive the changed flow; take an OS screenshot (`screencapture -x out.png`
  on macOS) and read it.
- Check the app's log output/stderr during the flow.

### CLI / API / library

- CLI: invoke the changed command with realistic arguments, including one
  edge case (empty input, bad flag) — check output AND exit code.
- API: hit the changed endpoint with curl (happy path + one auth/validation
  failure); verify status codes and body shape.
- Library with no runnable surface: a realistic integration-style test you
  watched fail counts as the drive; unit mocks don't.

## Rules

- Claim "done" only on fresh evidence: command output or screenshots
  produced in THIS session for the thing you changed — never memory of an
  earlier run, never inference from code that looks right.
- Verify what YOU changed — don't re-drive flows this session never touched,
  and don't re-prove what CI already proved.
- Scratch probes (seed scripts, curl loops, one-off scripts) go in a
  gitignored scratch dir — the session scratchpad, or `.factory/tmp/` in a
  factory-enabled project — never the repo root.
- Report what you drove and what you saw, verbatim where it matters — not
  just "verified".
