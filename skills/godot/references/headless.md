# Godot headless CLI — details

## Finding the binary

Resolve in order: project pin (`.docs/`, `.mcp.json`, CI config) → `GODOT_BIN`
/ `GODOT` env → `godot` / `godot4` on PATH → platform default
(`/Applications/Godot_mono.app/Contents/MacOS/Godot` on macOS). Fail with the
resolution list, don't guess versions. For mono builds: real binary or wrapper
script only — symlinks break GodotSharp assembly resolution.

## Display quirks

- On a headless Linux box some workflows (movie capture, anything touching
  rendering) still need a display: wrap in `xvfb-run -a`. Plain logic tests
  don't.
- In headless mode the root viewport can come up the wrong size, so computed
  Control positions (simulated clicks, capture framing) miss. Detect with
  `DisplayServer.get_name() == "headless"` and set `get_tree().root.size`
  from the `display/window/size/viewport_*` project settings first.
- Tests that genuinely need a display should skip themselves on that same
  `DisplayServer` check instead of failing mysteriously in CI.

## Exports

`godot --headless --path <proj> --export-release "<preset>" <output>`

Two prerequisites, both with useless error output when missing:

1. `<preset>` must match a `name=` in `export_presets.cfg` **exactly**.
2. Export templates must be installed for the exact engine version:
   `~/.local/share/godot/export_templates/<version>` (Linux),
   `~/Library/Application Support/Godot/export_templates/` (macOS).

Godot can exit 0 without writing anything — **verify the output file exists
and is non-trivial in size** after every export.

Web exports need `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` response headers
(SharedArrayBuffer); a black screen on load is the canonical missing-headers
symptom. Hosts that can't set headers (e.g. GitHub Pages) need threading
disabled in the preset.

## Dedicated server / long-running processes

A `--headless -- --server`-style boot check should grep the boot log line
(build/protocol sentinel) and then kill the process — it idles forever by
design. Never leave one running after verification.
