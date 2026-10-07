# Unity batchmode, tests & CI

## Batchmode invocations

```
caffeinate -i "<UnityPath>" -batchmode -projectPath <proj> \
  -runTests -testPlatform EditMode -testResults "$PWD/reports/editmode.xml" \
  -logFile "$PWD/reports/editmode.log"
```

- Success = exit 0 **and** `result="Passed"` in the results XML — check both.
- Scripted builds: `-batchmode -executeMethod <Class.Method>` with a build
  method that restores editor state (active build target/subtarget) in a
  `finally` — a build that leaves the project on the wrong target breaks the
  next session silently. Verify the output artifact exists.
- `caffeinate -i` is macOS-only App Nap protection; on Linux CI use
  `timeout` wrappers instead (a hung batchmode is possible there too).

## Test Framework traps

- Test asmdefs: `"defineConstraints": ["UNITY_INCLUDE_TESTS"]`,
  `autoReferenced: false`, EditMode needs `"includePlatforms": ["Editor"]`,
  and the game assembly must be explicitly referenced or nothing resolves.
- `Debug.LogError`/`LogException` **fails the test** unless matched by
  `LogAssert.Expect()` — code that logs errors on legitimate paths breaks
  the suite.
- `WaitForEndOfFrame` / `Awaitable.EndOfFrameAsync` wait on the render
  phase, which never happens under `-batchmode` — the coroutine hangs
  forever with no error ("times out in CI, passes locally"). Use
  `yield return null` / `NextFrameAsync`, gate render-dependent code on
  `Application.isBatchMode`.
- With domain reload disabled (Enter Play Mode Options), statics leak
  between play sessions; the only reliable reset hook is
  `[RuntimeInitializeOnLoadMethod(SubsystemRegistration)]`. Default
  `RuntimeInitializeOnLoadMethod` timing is *after* Awake already ran.
- EditMode `[UnityTest]`: each `yield return null` is one editor update
  tick, not a frame.

## Headless server builds

- Cap the framerate on a headless server boot
  (`Application.targetFrameRate = 60`, `vSyncCount = 0`) — uncapped
  headless servers flood logs with engine-internal `JobTempAlloc` leak
  warnings that look like (but aren't) gameplay-code leaks.
- Unity boots scene 0 regardless of role — a server needs an explicit
  `#if UNITY_SERVER` scene redirect or it sits in the menu scene with no
  port open.
- Unbounded `-logFile` on a long-running server fills the disk — logrotate
  with `copytruncate`.
