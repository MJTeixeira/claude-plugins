---
name: godot
description: Any work in a Godot project (project.godot present) — read before running godot CLI, tests, exports, or visual work.
---

# Godot

Project docs win: `.docs/index.md` § Commands pins this repo's exact
test/build/import commands — use those, don't rediscover. MCP tools
(`mcp__godot__*`), if configured, are documented in `.docs/mcp.md`.

## Headless CLI ground rules

- **Import before anything headless.** After a fresh clone, new assets, or a
  new addon: `godot --headless --path <proj> --import --quit`. It can exit
  nonzero even on success; after adding an addon, run it twice (first pass
  caches the addon's scripts).
- **Exit codes lie — grep the output.** Godot mixes errors into stdout and
  often exits 0 anyway. Capture output and fail on `SCRIPT ERROR`, `ERROR:`,
  `Failed to load`, `Cannot open file`.
- **Wrap every headless invocation in `timeout`** (30–120s). A hung headless
  Godot is normal, not exceptional.
- Per-file syntax check without launching the game:
  `godot --headless --path <proj> --check-only --script res://<file>.gd`.
- Cheap boot smoke test: print a sentinel line from `_ready()`, run
  `godot --headless --quit`, grep for the sentinel AND absence of the error
  patterns above.

Exports, display/viewport quirks, binary discovery: `references/headless.md`.

## C# (mono) projects

- Point `GODOT_BIN`/`GODOT_PATH` at the real binary or a wrapper *script* —
  a symlink breaks GodotSharp assembly resolution.
- Keep the game `.csproj` out of the root solution so plain `dotnet test`
  stays engine-free; run engine tests as a separate pinned command.
- Training data is GDScript-biased: guessed C# enum/constant names are often
  wrong (`BGMode.Sky`, not `BGModeEnum.Sky`) — verify against the installed
  API when a name 404s.

## Verification

- Tests (GdUnit4, input simulation, signal asserts): `references/testing.md`.
- **Never claim visual/motion work done from a green build or a single
  still.** Capture a frame sequence with Movie Maker mode and actually review
  it: `references/visual.md`. Aesthetic sign-off stays with the owner — you
  verify "the right thing happens at the right place/time".
- Building scenes from code has silent-drop traps (node `Owner`, `Pack()`
  losses, `SetScript` ordering) — also in `references/visual.md`.
