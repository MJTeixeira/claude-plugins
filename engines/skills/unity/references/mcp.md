# Unity MCP — hang playbook & editor techniques

MCP commands run inside the editor with **no client-side timeout**. Any call
not back in ~60–90s is dead: stop waiting, recover (ask the owner to glance
at the editor if interactive; log blocked if unattended).

## The three infinite hangs (prevent, don't cure)

1. **macOS App Nap on a backgrounded editor.** The update loop throttles, the
   bridge never answers — and compilation silently stalls too (`.cs` imports
   but the DLL never rebuilds, console shows 0 errors). **Foreground the
   editor before every MCP test/compile/capture cycle:**
   `osascript -e 'tell application "Unity" to activate'`.
2. **"Scene(s) Have Been Modified — Save?" modal** blocks the main thread;
   only a human can dismiss it. Never run scene-opening tests via MCP; never
   instantiate into the open scene — render in an isolated preview scene
   (below).
3. **`AssetDatabase.Refresh()` inside an awaited command** — the domain
   reload orphans the response. Refresh in its own earlier command (or let
   editor focus auto-import), then run the real command Refresh-free.

Anti-pattern: `EnterPlayModeOptions.DisableDomainReload` to keep a PlayMode
callback alive — pollutes static/scene state (false failures) and dirties the
scene → modal → hang. Read Unity's native `TestResults.xml` instead.

Retry-once transients (not hangs): "Unity not detected (no fresh discovery
files)" and `-32000 Connection closed` right after a `.cs` edit recompiles.

## Recompile / stale-assembly recipe

1. Foreground the editor. 2. Refresh-only command, then the real command.
3. First run after a recompile often executes the **stale pre-edit
   assembly** — re-issue once. 4. Verify via filesystem, not `isCompiling`:
   mtime of `Library/ScriptAssemblies/<Asm>.dll` jumps + `strings | grep
   <NewSymbol>`. Persistently stale = App Nap or a real compile error (both
   show "0 errors" until the editor ticks).

## Tests via MCP (pre-PR gate stays batchmode)

`TestRunnerApi` with an assembly-name filter; runs are async — poll a results
file, not the command. EditMode: a top-level (never nested — the namespace
wrapper duplicates nested classes) `ICallbacks` can write a scratch results
file. PlayMode: the domain reload wipes registered callbacks — poll the
native `TestResults.xml` mtime against a pre-run baseline instead.

## Visual capture without dirtying the scene

`EditorSceneManager.NewPreviewScene()` → instantiate prefab into it → temp
Camera (`cam.scene = s`) + Light → RenderTexture → `ReadPixels` → PNG →
`finally` destroy all + `ClosePreviewScene`. Edit-mode renders are bind pose
— fine for placement checks, not motion. Motion needs Play-mode frame bursts
(a debug scene cycling character × clip), reviewed as a sequence.

## Editor authoring that works

- AnimatorController edits via the `UnityEditor.Animations` API
  (+ `SetDirty`/`SaveAssets`, no Refresh) — never hand-edit `.controller`.
- Prefab edits: `LoadPrefabContents` → `SerializedObject` →
  `SaveAsPrefabAsset` → `UnloadPrefabContents`. Pinned enums: `.intValue`.
- Connection flakiness: one relay per session, editor accepts 1 client —
  kill stale relays; "Connection revoked" needs owner-side Accept + a
  reconnect afterward (the refused handshake is cached).
