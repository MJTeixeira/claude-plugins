#!/usr/bin/env node
// Fleet-control publisher (T-051) — machine-side daemon, one per machine,
// sibling of supervisor.mjs (fleet-control ADR-0005: the supervisor's hang
// path blocks its own event loop for minutes, so the surface gets its own
// process). Holds ONE outbound WebSocket to the collector and says who it
// is, beats the machine inventory over it every 60 seconds (T-052, gathered
// in fleet-inventory.mjs), and fills the board with one full snapshot per
// claimed project (T-053, derived in fleet-snapshot.mjs) — everything on a
// fresh connection, then on change as each beat re-derives them.
//
//   node fleet-publisher.mjs                  # daemon: connect and hold
//   node fleet-publisher.mjs --once --offline # print the fresh-connection
//                                             # envelopes as JSONL, no socket
//
// Config comes from the machine-shared env file the driver already owns
// (~/secrets/factory-shared.env — the one machine-level config home):
//   FLEET_MACHINE_ID    explicit identity, never hostname (REQ-113)
//   FLEET_CONTROL_URL   collector base URL; /ws is derived from it
// The credential lives apart from both, per the fleet's secrets discipline
// (~/secrets/<service>.env; placed by T-062's attended enrolment):
//   ~/secrets/fleet-publisher.env → FLEET_PUBLISHER_SECRET
// It travels only as a bearer header on the connection (ADR-0009), formed
// as `Bearer <machineId>:<secret>` — the collector's parseBearerCredential
// is the reading half.
//
// Failure posture (D-009 (7)/(8)): unreachability is retried forever with
// capped exponential backoff — the collector restarting under its own
// pull-deploy is this fleet's normal. Credential rejection is the one
// failure invisible to everything else (systemd reads `active (running)`,
// the board reads `silent`), so rejection sustained past the configured
// window exits non-zero and lets the unit's start limit page the owner.
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { gatherInventory } from "./fleet-inventory.mjs";
import { claimedProjects, gatherSnapshots } from "./fleet-snapshot.mjs";
import { machineEnvFile, readEnvLines } from "./paths.mjs";

// The close code the collector sends for an invalid credential (its
// ws.close(4401, "invalid credential") after a completed upgrade). An
// upgrade that never completes surfaces as 1006 and counts as
// unreachability, not rejection.
export const REJECTED_CLOSE_CODE = 4401;

const BACKOFF_FLOOR_MS = 1000;
const BACKOFF_CAP_MS = 60_000; // same interval as the inventory beat (D-009 (8))
const ACCEPT_GRACE_MS = 5000; // open this long = authenticated (rejection is immediate)
const REJECTION_LIMIT = 5; // consecutive rejected connections before dying loudly
const INVENTORY_BEAT_MS = 60_000; // REQ-120: every 60s, unconditionally

export const wsUrl = (base) => {
  const u = new URL(base);
  u.protocol = u.protocol === "https:" || u.protocol === "wss:" ? "wss:" : "ws:";
  u.pathname = "/ws";
  return u.href;
};

// One gather: the inventory (claims + host block) and one full snapshot per
// claimed project. Inventory first on the wire — the claims establish the
// rows the snapshots fill. The identity read runs ONCE here and feeds both
// gathers, so the claim list and the snapshot identities can never disagree
// within a beat, and the unidentifiable-project report fires once per
// cycle, not once per gather.
export const gatherAll = async (settings, deps = {}) => {
  const { home = os.homedir(), report = (msg) => process.stderr.write(msg + "\n") } = deps;
  const claims = claimedProjects(home, report);
  return {
    inventory: await gatherInventory(settings, { ...deps, claims }),
    snapshots: await gatherSnapshots(settings, { ...deps, claims }),
  };
};

// Every envelope a fresh connection owes the collector unprompted
// (REQ-132): the full inventory and a full snapshot per claimed project,
// so a redeployed collector never sits on a blank board waiting for a
// change. The beat is the OTHER set: inventory unconditionally, snapshots
// only where they changed. The --once mode prints EXACTLY this fresh set,
// which is what keeps it honest.
export const freshConnectionEnvelopes = async (settings) => {
  const { inventory, snapshots } = await gatherAll(settings);
  return [inventory, ...snapshots];
};

// The connection state machine, dependency-injected so tests drive it with
// fake sockets and hand-fired timers. Real deps are the module defaults.
export const createPublisher = (settings, deps = {}) => {
  const {
    makeSocket = (url, headers) => new WebSocket(url, { headers }),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    fatal = (msg) => { process.stderr.write(msg + "\n"); process.exit(1); },
    log = () => {},
    gather = gatherAll,
  } = deps;
  const floor = settings.backoffFloorMs ?? BACKOFF_FLOOR_MS;
  const cap = settings.backoffCapMs ?? BACKOFF_CAP_MS;
  const grace = settings.acceptGraceMs ?? ACCEPT_GRACE_MS;
  const limit = settings.rejectionLimit ?? REJECTION_LIMIT;
  const beat = settings.beatMs ?? INVENTORY_BEAT_MS;

  let backoff = 0;
  let rejections = 0;
  let stopped = false;
  let ws = null;
  let graceTimer = null;
  let reconnectTimer = null;
  let beatTimer = null;

  // Send-on-change memory (REQ-115), per CONNECTION by construction: it is
  // reset on every fresh send, so a reconnect resends every snapshot and a
  // redeployed collector never starts blank (REQ-132). Keyed by position +
  // remote — the gather walks the registry in sorted order, so the key is
  // stable, and two checkouts of one remote on one machine (a dormant
  // migration leftover) don't share a slot and flap each other every beat.
  let sentSnapshots = new Map();

  // What counts as change: everything except the two age-of-thing fields
  // that tick on every gather (heldSeconds, copyAgeSeconds) — counting them
  // would degenerate send-on-change into send-always for any project with a
  // hold or a meta worktree. A hold appearing/leaving and the divergence
  // COUNTS moving still count; the header's ts never does (body only).
  const changeKey = (body) => JSON.stringify({
    ...body,
    stopHeld: body.stopHeld ? { ...body.stopHeld, heldSeconds: 0 } : undefined,
    metaDivergence: body.metaDivergence ? { ...body.metaDivergence, copyAgeSeconds: 0 } : undefined,
  });

  // Gathering is async (the forge probe is a network call), so the send is
  // pinned to the socket it was gathered for: a connection that turned over
  // mid-gather drops the result — the fresh connection owes its own.
  // `fresh` sends everything; a beat sends the inventory unconditionally
  // and only the snapshots whose body changed since this connection last
  // sent them.
  const gatherAndSend = (sock, fresh) =>
    gather(settings)
      .then(({ inventory, snapshots }) => {
        if (sock !== ws || stopped) return;
        if (fresh) sentSnapshots = new Map();
        sock.send(JSON.stringify(inventory));
        snapshots.forEach((s, i) => {
          const slot = `${i}:${s.body.remote}`;
          const key = changeKey(s.body);
          if (!fresh && sentSnapshots.get(slot) === key) return;
          sock.send(JSON.stringify(s));
          sentSnapshots.set(slot, key);
        });
      })
      .catch((e) => log(`gather failed: ${e}`));

  const scheduleBeat = (sock) => {
    beatTimer = setTimer(() => {
      if (sock !== ws || stopped) return;
      gatherAndSend(sock, false);
      scheduleBeat(sock);
    }, beat);
  };

  const connect = () => {
    ws = makeSocket(wsUrl(settings.url), {
      authorization: `Bearer ${settings.machineId}:${settings.secret}`,
    });
    ws.onopen = () => {
      log("connected");
      gatherAndSend(ws, true);
      scheduleBeat(ws);
      // Rejection arrives as an immediate close after the upgrade; a
      // connection still open past the grace was authenticated, so only
      // then do the rejection count and the backoff reset.
      graceTimer = setTimer(() => { rejections = 0; backoff = 0; }, grace);
    };
    ws.onerror = () => {}; // close always follows; retry lives there
    ws.onclose = (ev) => {
      clearTimer(graceTimer);
      clearTimer(beatTimer);
      ws = null; // a gather in flight for this socket now has nowhere to land
      if (stopped) return;
      if (ev?.code === REJECTED_CLOSE_CODE) {
        rejections += 1;
        if (rejections >= limit) return fatal("fatal: credential rejected");
      }
      backoff = backoff ? Math.min(backoff * 2, cap) : floor;
      log(`disconnected (code ${ev?.code ?? "?"}), retrying in ${backoff}ms`);
      reconnectTimer = setTimer(connect, backoff);
    };
  };

  return {
    start: connect,
    stop: () => {
      stopped = true;
      clearTimer(graceTimer);
      clearTimer(reconnectTimer);
      clearTimer(beatTimer);
      try { ws?.close(); } catch { /* already closed */ }
    },
  };
};

// Config resolution: machine-shared env file under the process env (so a
// unit file or a test can override a key without editing the shared file).
export const loadConfig = (home = os.homedir(), env = process.env) => {
  const shared = readEnvLines(machineEnvFile(home));
  const secretEnv = readEnvLines(path.join(home, "secrets", "fleet-publisher.env"));
  const all = { ...shared, ...secretEnv, ...env };
  const num = (key) => (all[key] ? Number(all[key]) : undefined);
  return {
    machineId: all.FLEET_MACHINE_ID,
    url: all.FLEET_CONTROL_URL,
    secret: all.FLEET_PUBLISHER_SECRET,
    // The configured rejection window (D-009 (7) leaves the number to this
    // module): consecutive rejected connections before the fatal exit.
    rejectionLimit: num("FLEET_REJECTION_LIMIT"),
    // Test-only overrides, like SUPERVISOR_LAUNCH_GRACE_MS: real deployments
    // keep the 1s floor and the 60s beat.
    backoffFloorMs: num("FLEET_BACKOFF_FLOOR_MS"),
    beatMs: num("FLEET_BEAT_MS"),
  };
};

const main = async () => {
  const args = process.argv.slice(2);
  const known = new Set(["--once", "--offline"]);
  const unknown = args.find((a) => !known.has(a));
  if (unknown) {
    process.stderr.write(`error: unknown argument: ${unknown}\n`);
    process.exit(2);
  }
  // --offline qualifies --once; alone it would be a daemon that never
  // connects, which is no mode at all.
  if (args.includes("--offline") && !args.includes("--once")) {
    process.stderr.write("error: --offline requires --once\n");
    process.exit(2);
  }
  const settings = loadConfig();
  // Identity is checked before anything else: no connection, no output,
  // exit 2 (REQ-113 — explicit value, never a hostname derivation).
  if (!settings.machineId) {
    process.stderr.write("error: machineId not set\n");
    process.exit(2);
  }

  if (args.includes("--once")) {
    // --offline reaches the gather too: no socket means no forge probe.
    const once = { ...settings, offline: args.includes("--offline") };
    for (const e of await freshConnectionEnvelopes(once)) {
      process.stdout.write(JSON.stringify(e) + "\n");
    }
    process.exit(0);
  }

  for (const [key, hint] of [
    ["url", "error: FLEET_CONTROL_URL not set"],
    ["secret", "error: FLEET_PUBLISHER_SECRET not set (expected in ~/secrets/fleet-publisher.env)"],
  ]) {
    if (!settings[key]) {
      process.stderr.write(hint + "\n");
      process.exit(2);
    }
  }

  const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
  log(`fleet-publisher: ${settings.machineId} → ${settings.url}`);
  createPublisher(settings, { log }).start();
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch((e) => {
    process.stderr.write(`${e?.stack ?? e}\n`);
    process.exit(1);
  });
