# Godot testing

C# projects: prefer plain `dotnet test` for engine-free logic (see SKILL.md —
keep the game csproj out of the root sln), plus the project's pinned
engine-test command for anything touching Godot types.

## GdUnit4 (GDScript suites)

- Discovery is a convention triple — "tests not found" means one of these is
  missing: filename ends `_test.gd`, `extends GdUnitTestSuite`, methods start
  `test_`. Plugin acting broken: delete `.godot/` and re-import.
- GdUnit4 versions couple to the engine minor version — pin the addon to the
  engine, never track its main branch.
- Headless run (as a script, not a flag):
  `timeout 120 godot --headless --path . -s res://addons/gdUnit4/bin/GdUnitCmdTool.gd --run-tests --continue-on-failure --report-directory ./reports`
  → JUnit XML. Read the XML totals (or a small parse script), not the raw
  engine spew — pre-digesting output is much cheaper than rereading it.
- Wrap every constructed Object in `auto_free()`; create `scene_runner()` in
  `before_test`, free it in `after_test` — otherwise orphan-node reports.

## Simulated input is async

Every simulated event must be followed by
`await runner.await_input_processed()` or the assertion runs before the event
lands. Clicking a Control = set mouse to `global_position + size / 2`, then
press. "Hold for N seconds" = press, loop `await runner.await_idle_frame()`,
release.

## Signal assertions

Must be awaited and time-boxed:
`await assert_signal(node).wait_until(2000).is_emitted("died")`. The negative
form `is_not_emitted` ("must NOT fire within N ms") exists and is the right
tool for suppression tests.

## Speedups

`Engine.time_scale` (with `--fixed-fps` for determinism) fast-forwards
time-dependent tests; `get_tree().paused` freezes state for inspection.

## Boot smoke test (no framework)

Sentinel `print()` in `_ready()` + headless run + grep (SKILL.md) is the
cheapest "did the game actually boot" gate — use it before reaching for a
test framework in CI.
