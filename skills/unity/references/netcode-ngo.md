# Netcode for GameObjects (NGO) — traps

## Server bootstrap

- Call `StartServer()`/`StartClient()` from `Start()`, never `Awake()` —
  NetworkManager initialization order isn't settled yet.
- Use connection approval for version/auth gating: parse the payload,
  protocol-gate, ownership-check, approve/reject with explicit reason codes.
  Log every connect/approve/reject through one formatter — it's the only
  visibility a headless server has.
- `NetworkConfig.ConnectionData` travels **unencrypted** over UDP by default
  — never treat a token in it as secret without DTLS on the transport.
  Flag this as a pre-launch item, don't silently ship it.

## Silent failures

- Client writes to a `NetworkVariable` without write permission are
  **silently ignored** — no error, no sync.
- `Instantiate` without `NetworkObject.Spawn()` = local-only ghost.
- RPCs are fire-and-forget: late joiners never see them. Persistent state
  belongs in NetworkVariables; RPCs are for transient events only.
- Server-authoritative movement: cap speed server-side AND validate
  destinations (bounds/ground) — clients can send any Vector3.

## Disconnect handling

- NGO does **not** guarantee per-client disconnect callbacks on process
  teardown — anything saved only in `OnClientDisconnected` is lost on every
  server restart/deploy. Keep periodic snapshots + a shutdown flush.
- NGO may despawn the player object **before** `OnClientDisconnected` runs —
  capture state on a timer, save `live ?? snapshot`.
- Client side: subscribe `OnClientDisconnectCallback` and surface
  `NetworkManager.DisconnectReason` distinctly (server down vs rejected vs
  unreachable). The default is a silent dead world.

## Scale & duplication

- No built-in interest management: every NetworkVariable/RPC replicates to
  all clients — bandwidth scales with world entities. The documented
  `CheckObjectVisibility` distance pattern is the fix; needed before any
  real player count.
- Enforce single-session-per-identity at approval (lease/lock) — the same
  account connecting twice then "last disconnect-save wins" is dupe-exploit
  class #1.
- Resource pools with gear-driven max: growing max must not refill current
  (equip-cycling exploit); only clamp on shrink.
