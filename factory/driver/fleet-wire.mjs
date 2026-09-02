// The fleet-control wire shapes — the ONE place envelopes are written
// (contract: fleet-control .factory/spec/fleet-control.md @ a664b4f,
// REQ-107..REQ-109). The collector's src/wire.mjs is the reading half;
// its parseEnvelope requires exactly this header: a string machineId, a
// numeric ts and a numeric v, plus a string kind from its KINDS list.
//
// `v` is negotiated additively — the collector supports current and
// previous, additions only (REQ-109) — so this constant tracks the
// collector's CURRENT_VERSION and is the one cheap place to bump.
export const WIRE_VERSION = 2;

// Discriminators the collector accepts today. Kept as data so a test can
// assert every emitted envelope names a kind the collector knows.
export const KINDS = [
  "snapshot",
  "inventory",
  "heartbeat",
  "transcript",
  "command",
  "commandResult",
  "tape-chunk",
  "tape-ack",
];

// One envelope: shared header + kind discriminator + body. `ts` is this
// machine's own clock (epoch ms) — ages travel as durations elsewhere
// (REQ-123), so nothing downstream subtracts two machines' clocks.
export const envelope = (machineId, kind, body, ts = Date.now()) => ({
  header: { machineId, ts, v: WIRE_VERSION },
  kind,
  body,
});

// The inventory body (REQ-120/121, collector ADR-0014): the projects the
// machine claims (remote URLs — the collector normalises them into project
// identities) and a host block whose every field is independently
// absent-capable. Absent means "this publisher could not determine it" —
// never zero and never a guess — and the collector's parseHost drops any
// field that arrives half-shaped, so the shapes here mirror its parsers:
//   factories          { installed, enabled }  integer counts, enabled ≤ installed
//   diskUsedPercent    number 0..100
//   memoryUsedPercent  number 0..100
//   uptimeSeconds      duration on this machine's clock
//   runtime            { sha, deployedSecondsAgo }
//   forges             [{ id: forge host, reachable: boolean }]
//   doctor             { verdict, ageSeconds, fails? } — verdict opaque to
//                      the collector, fails opaque text (REQ-127)
export const inventoryBody = (projects, host) => {
  const block = {};
  for (const key of [
    "factories",
    "diskUsedPercent",
    "memoryUsedPercent",
    "uptimeSeconds",
    "runtime",
    "forges",
    "doctor",
  ]) {
    if (host[key] != null) block[key] = host[key];
  }
  return { projects, host: block };
};

// The snapshot body (REQ-115..119, collector's applySnapshot): one project,
// always in full. The collector reads
//   remote            raw remote URL — normalised into the row key THERE
//   enabled           boolean (its parser Boolean()s whatever arrives)
//   autonomy          string when the machine's config carries one
//   milestones/tasks  arrays stored as sent, or null for "could not read" —
//                     null renders `not published`, [] a real empty backlog
//   stopHeld          { heldSeconds, by? } — placer optional (their ruling
//                     2026-09-02), both ages of the THING aged from receipt
//                     on their side (pin 8c769a1)
//   metaDivergence    { behind, ahead, copyAgeSeconds } — both directions as
//                     non-negative counts, never a signed net (ADR-0012
//                     amendment)
// Optionals are absent, never null — the same absent-capable stance as the
// host block above.
export const snapshotBody = ({ remote, enabled, autonomy, milestones, tasks, stopHeld, metaDivergence }) => ({
  remote,
  enabled,
  ...(autonomy != null ? { autonomy } : {}),
  milestones,
  tasks,
  ...(stopHeld != null ? { stopHeld } : {}),
  ...(metaDivergence != null ? { metaDivergence } : {}),
});
