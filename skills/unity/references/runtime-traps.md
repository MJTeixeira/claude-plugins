# Unity runtime traps — plausible-but-wrong one-liners

Each of these compiles, looks idiomatic, and is wrong.

## Object lifetime

- **Fake-null:** `?.`, `??`, `is null`, `is not null`, and `obj is T t` all
  bypass Unity's overridden `==` — destroyed objects pass as alive. Only
  `== null` / `!= null` / implicit bool are safe on UnityEngine.Object.
- `Destroy()` is deferred to end of frame; the object is still iterable this
  frame.
- Awake fires by **GameObject** active state (even on disabled components);
  Start/OnEnable by component enabled state. Parent-before-child destruction
  order is NOT guaranteed.
- Mobile: `OnApplicationQuit` may never fire — `OnApplicationPause(true)` is
  the last reliable save hook, and it must use synchronous I/O.

## Async

- `Awaitable` instances are pooled — awaiting one twice can observe another
  operation. `.AsTask()` for multi-await.
- Pass `destroyCancellationToken` to every Awaitable wait and catch
  `OperationCanceledException`; otherwise continuations run on destroyed
  components.
- A nested coroutine's exception kills only itself; the yielding parent
  resumes as if it completed. No `yield` inside try/catch.
- After `Awaitable.BackgroundThreadAsync()` everything stays off the main
  thread until an explicit `MainThreadAsync()` (which resumes next update).

## Physics queries

- Queries hit **triggers by default** — ground checks/line-of-sight need
  `QueryTriggerInteraction.Ignore`.
- Casts never detect a collider the shape **starts inside** (the classic
  broken ground check) — use `CheckSphere`/`Overlap*`.
- `RaycastAll`/NonAlloc results are unsorted; NonAlloc silently drops hits
  beyond buffer size (count == capacity ⇒ you missed some).
- `LayerMask.GetMask` returns a bitmask; `NameToLayer`/`.layer` return
  indices — mixing them filters wrong with no error.
- `OnTriggerEnter` needs a Rigidbody somewhere in the pair — give trigger
  zones their own kinematic Rigidbody.

## Math / input

- `new Plane(Vector3.up, 5f)` puts the plane at y = **−5** (signed
  distance); use the point constructor. `ScreenToWorldPoint` z is distance
  from camera. `LookRotation(Vector3.zero)` NaNs silently.
- `InputValue`/`CallbackContext` are pooled — copy with `.Get<T>()` inside
  the callback. `Gamepad.current` = most recently used, never "player 1".
- Seeds: `string.GetHashCode()` is not stable across runtimes;
  `System.Random` is not thread-safe.

## Loading

- `AsyncOperation.progress` caps at 0.9 while `allowSceneActivation =
  false` — normalize `/0.9f` or the bar stalls at 90%.
- Addressables handles are refcounted — every `LoadAssetAsync` needs a
  `Release`; instances via `InstantiateAsync` die by `ReleaseInstance`, not
  `Destroy`.
- `SetActiveScene` decides lighting AND where new instances land in
  additive setups.
- ScriptableObjects: runtime edits persist to disk in-editor but vanish in
  builds; scene-object references on an SO are null at runtime.
