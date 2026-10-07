# Godot visual verification & scene-from-code

## Capture: Movie Maker mode

Deterministic frame sequences straight from the engine, no addon:

```
timeout 120 godot --path <proj> --write-movie captures/<name>/frame.png \
  --fixed-fps 30 --quit-after 450 res://scenes/<Scene>.tscn
```

- `.png` output writes a numbered frame sequence (+ `.wav`); `--fixed-fps`
  makes motion deterministic; `--quit-after 450` ≈ 15s at 30fps.
- Headless Linux: run under `xvfb-run -a`; stills work on software rendering,
  smooth video wants a real GPU.
- Drive the content with a throwaway capture scene/script (pre-positioned
  camera, scripted input) — never rely on live input.
- `captures/` stays gitignored; attach the evidence to the PR.

## Review discipline

- Tests prove wiring; they cannot prove motion looks right. A single still
  can't either (frozen pose, ice-skating, and teleport bugs are invisible
  in one frame). Review a **sampled sequence** — every ~15th frame at 30fps.
- Skip frame 0 — init artifacts.
- You are looking for problems, not confirming it's fine: placement, scale,
  floating objects, default-grey/magenta materials, poses that never change.
- Judge from the running game, never from a clean build. If the owner hasn't
  seen it running, a short captured clip on the PR is the proof.

## Building .tscn from code (silent-drop traps)

Generating scenes via a headless script (`--headless --script <Build>.cs`)
is legit and reviewable, but serialization drops things silently:

- Every node must have `Owner` set (to the scene root) or it is **dropped**
  from the saved scene — no error. Don't recurse ownership into instanced
  sub-scenes (GLB instances), or the .tscn balloons.
- Validate after `Pack()`: compare node counts before/after; a pack that
  lost children still saves "successfully".
- `SetScript()` replaces the C# wrapper object — set scripts last, then
  reacquire references.
- Never hand-edit `.tscn`/`.tres` UIDs or re-generate them; commit `.uid`
  files and let the editor own them (`--import` heals stale caches).
