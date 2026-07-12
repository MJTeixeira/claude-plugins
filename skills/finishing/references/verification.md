# Verify by driving the app — per-platform recipes

Goal: see the changed behavior happen in the real product, once, before
declaring done. Use `.docs/index.md` → `Commands` for the canonical run
command.

## Webapp

- Start the dev server (or use the running one); hard-reload.
- Drive the changed flow with the available browser tools (navigate, click,
  fill); screenshot the result and compare against intent.
- Watch the browser console and the dev-server terminal during the flow — new
  errors/warnings are failures even if the page looks right.
- Sweep the breakers if UI changed: empty data, long strings, narrow viewport.

## Mobile

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

## Desktop

- Launch the app via the project's run command (Electron: `npm start`;
  native: the built binary).
- Drive the changed flow; take an OS screenshot (`screencapture -x out.png`
  on macOS) and read it.
- Check the app's log output/stderr during the flow.

## CLI / API / library

- CLI: invoke the changed command with realistic arguments, including one
  edge case (empty input, bad flag) — check output AND exit code.
- API: hit the changed endpoint with curl (happy path + one auth/validation
  failure); verify status codes and body shape.
- Library with no runnable surface: a realistic integration-style test you
  watched fail counts as the drive; unit mocks don't.

Report what you drove and what you saw, verbatim where it matters — not just
"verified".
