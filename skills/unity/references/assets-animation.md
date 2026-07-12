# Unity assets, serialization & animation import

## .meta / GUID hygiene

- Every asset's `.meta` is part of the asset — commit them together; never
  regenerate a `.meta` for an existing asset (all GUID references to it
  break silently, often as invisible None fields).
- Hand-writing a new `.asset` + `.meta` works (reuse the target script's
  `m_Script` GUID, fresh 32-hex GUID in the meta); the editor imports on
  focus — confirm with a cheap check before relying on it.
- YAML prefab references are `{fileID: <id>, guid: <guid>, type: 3}`: guid
  from the prefab's `.meta`; the root GameObject fileID is the one whose
  Transform has `m_Father: {fileID: 0}` — NOT the first block in the file.
- Reset to a clean baseline after import churn: `git checkout` the `.meta`
  files + reimport (restores stable fileIDs, heals references).

## URP / render-pipeline conversion

- Asset-store packs shipped on Built-in shaders render **pink** in URP until
  converted (Edit → Rendering → Materials → Convert, or the pack's URP
  guide). Check per pack — some ship URP-ready, some need conversion.
- Every quality tier must have the URP asset assigned in QualitySettings or
  cameras go pink only in that tier.
- VFX prefab discipline: anything spawned without a code-side destroy must
  self-clean (e.g. CFXR `clearBehavior=Destroy`); looping effects are only
  safe where code owns the lifetime.

## Animation import — Generic, not Humanoid (stylized/shared-rig packs)

Humanoid retargeting muscle-caps amplitude and silently discards chest
rotation + limb translation — swings look small and wrong. For packs whose
rigs share a skeleton:

1. Import animation FBXs as **Generic** (`animationType = Generic`,
   `avatarSetup = CreateFromThisModel`, no muscle config).
2. Character Animators use **avatar = None** → Generic binds clips by
   transform **path**. All rigs sharing one controller must have identical
   bone paths (`AnimationUtility.CalculateTransformPath`) — a mismatch
   T-poses silently.
3. Networked characters: `applyRootMotion = false`, so root-motion skills
   (jump/spin) must be **baked to pose** on the clip
   (`clipAnimations` + `lockRootRotation/HeightY/PositionXZ = true`) or the
   motion is discarded.
4. Reimporting an FBX churns clip fileIDs → controller states lose their
   clips. Rebind **by clip name** across the FBXs, not by fileID.
5. Clip names in marketing/videos differ from actual sub-asset names —
   enumerate the imported clips; the asset is the source of truth.
6. Attack→idle transitions: exit time ≈ 0.9+, or follow-through clips early.

## Platform quirk worth knowing

`Application.streamingAssetsPath` on Android points inside the APK —
`File.ReadAllText` fails; use `UnityWebRequest` even for bundled files.
