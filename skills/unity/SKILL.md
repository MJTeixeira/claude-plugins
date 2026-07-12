---
name: unity
description: Any work in a Unity project — read before running Unity CLI/batchmode, Unity MCP, tests, builds, or asset/animation work.
---

# Unity

Project docs win: `.docs/index.md` § Commands pins this repo's exact
test/build commands and editor version — use those, don't rediscover.

## Two drive modes — mutually exclusive

- **Batchmode CLI** (tests, scripted builds): editor must be **CLOSED** —
  batchmode locks the project. On macOS prefix `caffeinate -i` (App Nap
  throttles background processes). Judge results by the results XML /
  build output existing, never by exit code alone; always pass `-logFile`.
- **Unity MCP** (editor scripting, captures): editor must be **OPEN and
  foregrounded**. Several conditions make MCP calls hang *forever* rather
  than error — read `references/mcp.md` BEFORE your first MCP call, and
  treat any call not returning in ~60–90s as dead.

Close the editor before batchmode gates; reopen for MCP work.

## Serialization hygiene

Always commit `.meta` files; never delete/regenerate one for an existing
asset (GUID references break silently). Editing asset YAML by hand is
viable but recipe-driven — GUID/fileID lookups, URP pink-material
conversion, reimport churn: `references/assets-animation.md`. That file
also has the animation-import recipe (Generic vs Humanoid, path binding,
root-motion baking) — read it before any rig/clip work.

## Verification

- Test Framework + CI traps (asmdef constraints, LogAssert,
  `WaitForEndOfFrame` hanging headless, domain-reload state leaks, headless
  server quirks): `references/batchmode-tests.md`.
- **Green tests prove wiring, not visuals.** Motion/particles/VFX can be
  broken while every test passes and a still capture looks fine. Capture a
  frame sequence and review the motion before claiming visual work done
  (recipes in `references/mcp.md`). Aesthetic sign-off stays with the owner.

## Code traps

Before writing gameplay/editor C#, skim `references/runtime-traps.md` —
one-liners for the plausible-but-wrong patterns (fake-null, Awaitable
pooling, physics query defaults, input callback pooling…). For Netcode for
GameObjects work: `references/netcode-ngo.md`.

## Don't use worktrees here

Unity editors pin one project path, and .NET marks dot-prefixed ancestor
dirs (`.worktrees/`) Hidden, breaking config loading. Branch in-checkout,
one branch at a time.
