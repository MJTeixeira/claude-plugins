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
// never zero and never a guess. The collector's inventory ingest reads only
// the claims today (`applyInventory(machineId, projectIds)`); the host
// block's reader is fleet-control's rendering half, so these shapes are the
// sending side of the pinned contract (ADR-0005: their reader, once it
// lands, wins):
//   factories          { installed, enabled }  integer counts, enabled ≤ installed
//   diskUsedPercent    number 0..100
//   diskBytes          { total, used } bytes, df's convention — same statfs
//                      read as the percent, so the two never disagree (T-065)
//   memoryUsedPercent  number 0..100
//   memoryBytes        { total, used } bytes (T-065)
//   uptimeSeconds      duration on this machine's clock
//   model              CPU model string, verbatim from os.cpus() (T-065)
//   cpus               logical CPU count (T-065)
//   os                 `type release` string, e.g. "Darwin 25.5.0" (T-065)
//   loadAvg            [1m, 5m, 15m] load averages, 2dp (T-065)
//   role               the machine's configured one-line description,
//                      verbatim (T-065) — configured, never derived
//   runtime            { sha, deployedSecondsAgo }
//   forges             [{ id: forge host, reachable: boolean }]
//   doctor             { verdict, ageSeconds, fails? } — verdict opaque to
//                      the collector, fails opaque text (REQ-127)
// None of the T-065 readings is judged or thresholded here or at the far
// end; they age with the block like everything else in it.
export const inventoryBody = (projects, host) => {
  const block = {};
  for (const key of [
    "factories",
    "diskUsedPercent",
    "diskBytes",
    "memoryUsedPercent",
    "memoryBytes",
    "uptimeSeconds",
    "model",
    "cpus",
    "os",
    "loadAvg",
    "role",
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
//   ages              { pr: [durations] } — how long ago THIS publisher read
//                     each field it dates separately (T-055). The collector's
//                     claimAges folds the list with `oldestInput` and adds its
//                     own elapsed time since receipt, so a list is how several
//                     readings of one field travel without one of them
//                     claiming the others' freshness. `tasks` is the other
//                     name it reads; the backlog is read in the same gather
//                     that sends it, so nothing dates it but receipt.
// Optionals are absent, never null — the same absent-capable stance as the
// host block above.
export const snapshotBody = ({ remote, enabled, autonomy, milestones, tasks, stopHeld, metaDivergence, ages }) => ({
  remote,
  enabled,
  ...(autonomy != null ? { autonomy } : {}),
  milestones,
  tasks,
  ...(stopHeld != null ? { stopHeld } : {}),
  ...(metaDivergence != null ? { metaDivergence } : {}),
  ...(ages != null ? { ages } : {}),
});

// The heartbeat body (REQ-114, REQ-122, REQ-123). The collector accepts the
// `heartbeat` kind (its wire.mjs KINDS); the body's reader is fleet-control's
// rendering half, so this shape is the sending side of the pinned contract,
// not a mirror of a parser (ADR-0005: if that reader disagrees, it wins):
//   project    raw remote URL — the same identity a snapshot sends as
//              `remote`, for the far end to normalise into the row key
//   windowId   the driver's own window stamp, reused and never minted here
//              (REQ-114): the lock's start at second precision,
//              `YYYY-MM-DDTHH-MM-SSZ` with colons dashed, so a URL on screen
//              and a filename on disk name the same run
//   mode       the window lock's mode, verbatim
//   tSeconds   seconds since the window began, on THIS machine (REQ-123)
//   session    which session this tick belongs to; null is the driver's own
//              time — starting up, or sweeping between sessions
//   taskId     the task that session is on, when the daily log named one
//   component  which part of the driver holds the window — INFERRED
//   activity   what the session is doing inside it — INFERRED
//   turns      assistant turns counted in this session's transcript
//   lastEvent  { summary, ageSeconds } — the last thing the session emitted
//              and how long ago, as a duration; null when nothing was read
// component and activity are labelled inferred because the driver has no
// concept of either (REQ-122's fields are this publisher's reading of session
// output); every other field restates something the driver wrote down.
export const heartbeatBody = ({ project, windowId, mode, tSeconds, session, taskId, component, activity, turns, lastEvent }) => ({
  project,
  windowId,
  mode,
  tSeconds,
  session: session ?? null,
  taskId: taskId ?? null,
  component,
  activity,
  turns,
  lastEvent: lastEvent ?? null,
});

// The same body with every age flattened — what send-on-change compares
// (REQ-115). It lives HERE, beside the shape, because it is a claim about
// which fields of that shape tick on their own: a dated field added above
// and forgotten here would degrade send-on-change into send-always, and the
// publisher is not where a reader looks to find that out.
export const snapshotChangeShape = (body) => ({
  ...body,
  ...(body.stopHeld ? { stopHeld: { ...body.stopHeld, heldSeconds: 0 } } : {}),
  ...(body.metaDivergence ? { metaDivergence: { ...body.metaDivergence, copyAgeSeconds: 0 } } : {}),
  ages: undefined,
  ...(body.tasks ? { tasks: body.tasks.map((t) => (t.pr ? { ...t, pr: { ...t.pr, ageSeconds: 0 } } : t)) } : {}),
});
