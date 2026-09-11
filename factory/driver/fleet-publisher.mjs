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
//        …--fixture-window                    # + a recorded window's heartbeat
//        …--fixture-window --subscribe        # + what a watcher would see of it
//        …--fixture-window --tape             # + the tape that window becomes
//        …--command <verb>                    # + that verb, against a recorded
//                                             #   window, answered on stdout
//   node fleet-publisher.mjs install [--yes]  # install + enable the systemd
//                                             # unit (T-062); systemd hosts
//                                             # only, per the fleet-control
//                                             # spec's Further Notes
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
import { createHeartbeatSource, gatherHeartbeats, HEARTBEAT_TICK_MS, writeFixtureWindow } from "./fleet-heartbeat.mjs";
import { gatherInventory } from "./fleet-inventory.mjs";
import { retainWindow } from "./fleet-retention.mjs";
import { claimedProjects, gatherSnapshots } from "./fleet-snapshot.mjs";
import { answerCommand, commandResult, createCommandLog, driveCommand } from "./fleet-command.mjs";
import { applyTapeAck, driveTape, gatherTapes } from "./fleet-tape.mjs";
import { createLeases, createTranscriptSource, driveSubscription, TRANSCRIPT_TICK_MS } from "./fleet-transcript.mjs";
import { snapshotChangeShape } from "./fleet-wire.mjs";
import { machineEnvFile, readEnvLines } from "./paths.mjs";
import { PLATFORM_SCHEDULER } from "./config.mjs";
import { generatePublisherUnits, defaultPathLine } from "./schedule.mjs";
import { installMachineUnit } from "./unit-install.mjs";

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
  const claims = deps.claims ?? claimedProjects(home, report);
  return {
    claims,
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
    heartbeats = createHeartbeatSource(),
    leases = createLeases(),
    transcripts = createTranscriptSource(leases),
    home = os.homedir(),
    commands = createCommandLog(home),
    tapes = gatherTapes,
  } = deps;
  const floor = settings.backoffFloorMs ?? BACKOFF_FLOOR_MS;
  const cap = settings.backoffCapMs ?? BACKOFF_CAP_MS;
  const grace = settings.acceptGraceMs ?? ACCEPT_GRACE_MS;
  const limit = settings.rejectionLimit ?? REJECTION_LIMIT;
  const beat = settings.beatMs ?? INVENTORY_BEAT_MS;
  const tick = settings.heartbeatMs ?? HEARTBEAT_TICK_MS;
  const stream = settings.streamMs ?? TRANSCRIPT_TICK_MS;

  let backoff = 0;
  let rejections = 0;
  let stopped = false;
  let ws = null;
  let graceTimer = null;
  let reconnectTimer = null;
  let beatTimer = null;
  let tickTimer = null;
  let streamTimer = null;

  // The claim list, read on the 60-second beat and shared by every tick between
  // them. Identifying a project costs a `git` spawn, and the two tick paths run
  // three and thirty times a minute: reading it there instead would pay that
  // spawn per project per tick, which is the shape of the spawn storm this
  // suite has already been bitten by once.
  let claims = [];

  // Send-on-change memory (REQ-115), per CONNECTION by construction: it is
  // reset on every fresh send, so a reconnect resends every snapshot and a
  // redeployed collector never starts blank (REQ-132). Keyed by position +
  // remote — the gather walks the registry in sorted order, so the key is
  // stable, and two checkouts of one remote on one machine (a dormant
  // migration leftover) don't share a slot and flap each other every beat.
  let sentSnapshots = new Map();

  // Which windows' tapes have been sent down THIS connection. A tape is
  // uploaded once (REQ-128) and the ack is what finally clears the window, so
  // without this the beat would re-send an unacked tape every 60 seconds. It is
  // per connection on purpose: a publisher that died mid-upload sends the tape
  // again from chunk zero, and the collector abandons the half it held rather
  // than merging it into a tape that never existed.
  let sentTapes = new Set();

  // What counts as change: everything except the age fields that tick on
  // every gather — counting them would degenerate send-on-change into
  // send-always for any project with a hold, a meta worktree or an open PR.
  // Which fields those are belongs to the shape, so `snapshotChangeShape`
  // owns the flattening; a hold appearing/leaving, the divergence COUNTS
  // moving and a PR's STATE moving all still count, and the header's ts
  // never does (body only).
  const changeKey = (body) => JSON.stringify(snapshotChangeShape(body));

  // Gathering is async (the forge probe is a network call), so the send is
  // pinned to the socket it was gathered for: a connection that turned over
  // mid-gather drops the result — the fresh connection owes its own.
  // `fresh` sends everything; a beat sends the inventory unconditionally
  // and only the snapshots whose body changed since this connection last
  // sent them.
  const gatherAndSend = (sock, fresh) =>
    gather(settings, { home })
      .then(({ inventory, snapshots, claims: read }) => {
        claims = read; // the ticks between beats identify nothing themselves
        if (sock !== ws || stopped) return;
        // Sent from HERE because this is where the claim list lands: called at
        // connect it would run against an empty one and quietly send nothing,
        // and a window that ended before the connection would wait a beat.
        sendTapes(sock);
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

  // Every answer this publisher owes, said on whatever connection it has now.
  // The collector never re-issues a command, so a result lost to a reconnect is
  // a command ageing on the owner's log forever — and it is only marked as said
  // once the socket has actually taken it.
  const sendResults = (sock) => {
    if (sock !== ws || stopped) return;
    for (const { commandId, result } of commands.unsent()) {
      try {
        sock.send(JSON.stringify(commandResult(settings.machineId, commandId, result)));
      } catch (e) {
        return log(`command result for ${commandId} could not be sent: ${e}`);
      }
      commands.markSent(commandId);
    }
  };

  // A finished window this machine still owes the surface, rebuilt from disk
  // and sent once. It rides the 60-second beat rather than a tick of its own:
  // a tape is not a liveness signal, and the window it is about has already
  // ended — nothing about it will change while it waits.
  const sendTapes = (sock) => {
    if (sock !== ws || stopped) return;
    try {
      // `sentTapes` goes IN, so a window already sent on this connection is
      // never rebuilt again — it is owed until the ack lands, and rebuilding it
      // every minute would read all of its transcripts to throw the result away.
      // It is only added to once the socket has taken every chunk of that
      // window: a send that throws on chunk 5 of 100 must leave the window owed
      // on the next beat, not wait for a reconnect to be noticed again.
      for (const { key, envelopes } of tapes(settings, { home, claims, sent: sentTapes, report: log })) {
        for (const e of envelopes) sock.send(JSON.stringify(e));
        sentTapes.add(key);
      }
    } catch (e) {
      log(`tape failed: ${e}`);
    }
  };

  const scheduleBeat = (sock) => {
    beatTimer = setTimer(() => {
      if (sock !== ws || stopped) return;
      gatherAndSend(sock, false);
      scheduleBeat(sock);
    }, beat);
  };

  // The heartbeat's own tick (T-056), three times a minute and independent of
  // the 60-second beat: it is the only thing on this connection whose ABSENCE
  // is the message (REQ-122), so it can never ride a slower or a conditional
  // path. Its gather is synchronous local-file reading, and a machine with no
  // live window sends nothing at all.
  const beatHeartbeats = (sock) => {
    try {
      for (const e of heartbeats(settings, { claims, home })) {
        sock.send(JSON.stringify(e));
        // Told the surface about this window, so this machine now owes it a
        // tape and the window's logs must outlive it (REQ-131). Recorded on
        // the SEND rather than in the gather: a machine that published nothing
        // owes nothing, and a dry run must not leave a debt behind it.
        const claim = claims.find((c) => c.remote === e.body.project);
        if (claim) retainWindow(claim.dir, home, e.body.windowId, e.header.ts);
      }
    } catch (e) {
      log(`heartbeat failed: ${e}`);
    }
  };

  const scheduleTick = (sock) => {
    tickTimer = setTimer(() => {
      if (sock !== ws || stopped) return;
      beatHeartbeats(sock);
      scheduleTick(sock);
    }, tick);
  };

  // The watched transcript (T-058). Its own tick, because it is the one thing
  // here a human watches in real time — and it is cheap by construction: with
  // no lease held it reads nothing at all, which is also what makes "no
  // transcript for a window nobody is subscribed to" true rather than
  // asserted.
  const scheduleStream = (sock) => {
    streamTimer = setTimer(() => {
      if (sock !== ws || stopped) return;
      try {
        for (const e of transcripts(settings, { claims, home })) sock.send(JSON.stringify(e));
      } catch (e) {
        log(`transcript failed: ${e}`);
      }
      scheduleStream(sock);
    }, stream);
  };

  // The ONE inbound path: the collector's lease (ADR-0016), re-sent on its own
  // clock while a viewer is attached. Nothing cancels a lease — the collector
  // simply stops renewing — so there is no stop message to lose here, and a
  // publisher that misses one still falls silent when the lease lapses.
  const onMessage = (data) => {
    let inbound;
    try {
      inbound = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
    } catch {
      return log("dropped an inbound message that is not JSON");
    }
    if (inbound?.kind === "transcript") {
      if (!leases.grant(inbound.body, Date.now())) log("dropped a transcript lease naming no project, window or duration");
      return;
    }
    if (inbound?.kind === "tape-ack") {
      // The ack is what makes machine-side pruning safe, so only an `ok` one
      // drops the window: a refused tape stays owed, and its logs stay with it.
      applyTapeAck(inbound.body, { home, claims, report: log });
      return;
    }
    if (inbound?.kind !== "command") return;
    // Answered exactly once, and never queued (ADR-0004): a verb this publisher
    // cannot perform right now is refused, not held. The answer is owed
    // durably and said on whatever connection this publisher has when it is
    // ready — the collector never re-issues a command, so a result dropped at
    // a reconnect would be a command ageing on the owner's log forever.
    answerCommand(inbound.body, settings, { home, claims: claims.length ? claims : undefined, commands, log })
      .then(() => sendResults(ws))
      .catch((e) => log(`command failed: ${e}`));
  };

  const connect = () => {
    ws = makeSocket(wsUrl(settings.url), {
      authorization: `Bearer ${settings.machineId}:${settings.secret}`,
    });
    ws.onopen = () => {
      log("connected");
      // Per connection, and reset HERE rather than inside the gather: the tape
      // send is disk-only and immediate, so a reset that waited for the gather
      // to resolve would wipe the marks it had already made and send every
      // tape twice.
      sentTapes = new Set();
      gatherAndSend(ws, true);
      sendResults(ws); // anything answered while there was nowhere to say it
      scheduleBeat(ws);
      scheduleTick(ws);
      scheduleStream(ws);
      // Rejection arrives as an immediate close after the upgrade; a
      // connection still open past the grace was authenticated, so only
      // then do the rejection count and the backoff reset.
      graceTimer = setTimer(() => { rejections = 0; backoff = 0; }, grace);
    };
    ws.onmessage = (ev) => onMessage(ev?.data);
    ws.onerror = () => {}; // close always follows; retry lives there
    ws.onclose = (ev) => {
      clearTimer(graceTimer);
      clearTimer(beatTimer);
      clearTimer(tickTimer);
      clearTimer(streamTimer);
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
      clearTimer(tickTimer);
      clearTimer(streamTimer);
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
    // The machine's one-line human description (T-065) — same env home as
    // the id, optional where the id is not.
    role: all.FLEET_MACHINE_ROLE,
    url: all.FLEET_CONTROL_URL,
    secret: all.FLEET_PUBLISHER_SECRET,
    // The configured rejection window (D-009 (7) leaves the number to this
    // module): consecutive rejected connections before the fatal exit.
    rejectionLimit: num("FLEET_REJECTION_LIMIT"),
    // Test-only overrides, like SUPERVISOR_LAUNCH_GRACE_MS: real deployments
    // keep the 1s floor and the 60s beat.
    backoffFloorMs: num("FLEET_BACKOFF_FLOOR_MS"),
    beatMs: num("FLEET_BEAT_MS"),
    streamMs: num("FLEET_STREAM_MS"),
  };
};

const main = async () => {
  const args = process.argv.slice(2);

  // install (T-062): generate the unit beside the supervisor's and install
  // it through the same installer. The unit execs the ONE gated machine
  // runtime (deploy-runtime.mjs advances it), never whichever checkout ran
  // install — same premise as the supervisor's installer. Enrollment order
  // matters: place the machine env + credential BEFORE installing, or the
  // daemon's config exit loops into the start limit and pages the owner.
  if (args[0] === "install") {
    const extra = args.slice(1).filter((a) => a !== "--yes");
    if (extra.length) {
      process.stderr.write(`error: unknown argument: ${extra[0]}\n`);
      process.exit(2);
    }
    const home = os.homedir();
    const kind = PLATFORM_SCHEDULER[process.platform] ?? "manual";
    const { files, notes } = generatePublisherUnits(kind, {
      runtimePublisher: path.join(home, ".factory", "runtime", "factory", "driver", "fleet-publisher.mjs"),
      nodeBin: process.execPath,
      pathLine: defaultPathLine(process.execPath, home),
    });
    if (notes.length) {
      process.stderr.write(`error: ${notes.join("; ")}\n`);
      process.exit(1);
    }
    try {
      await installMachineUnit(kind, files, { yes: args.includes("--yes") });
    } catch (e) {
      process.stderr.write(`error: ${e.message}\n`);
      process.exit(1);
    }
    process.exit(0);
  }

  const known = new Set(["--once", "--offline", "--fixture-window", "--subscribe", "--tape", "--command"]);
  // `--command <verb>` is the one flag carrying a value, so its argument is not
  // a flag to be recognised: it is consumed here and checked by the verb table,
  // which is the only thing that knows what a verb is.
  const commandAt = args.indexOf("--command");
  const commandVerb = commandAt === -1 ? null : args[commandAt + 1] ?? null;
  if (commandAt !== -1 && (!commandVerb || commandVerb.startsWith("--"))) {
    process.stderr.write("error: --command needs a verb\n");
    process.exit(2);
  }
  const flags = commandAt === -1 ? args : args.filter((_, i) => i !== commandAt + 1);
  const unknown = flags.find((a) => !known.has(a));
  if (unknown) {
    process.stderr.write(`error: unknown argument: ${unknown}\n`);
    process.exit(2);
  }
  // Both flags qualify --once: --offline alone would be a daemon that never
  // connects, and a fixture window on a daemon would publish a run that is
  // not happening. Neither is a mode at all.
  for (const flag of ["--offline", "--fixture-window", "--subscribe", "--tape", "--command"]) {
    if (args.includes(flag) && !args.includes("--once")) {
      process.stderr.write(`error: ${flag} requires --once\n`);
      process.exit(2);
    }
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
    const print = (e) => process.stdout.write(JSON.stringify(e) + "\n");
    for (const e of await freshConnectionEnvelopes(once)) print(e);
    // The heartbeat is not part of the fresh-connection set — it rides its
    // own 20s tick — but it IS an envelope this process sends, so the drive
    // prints one per live window rather than pretending the mode is complete
    // without them. --fixture-window swaps this machine's windows for a
    // recorded one, which is what makes the path runnable with none running.
    if (args.includes("--fixture-window")) {
      const fixture = writeFixtureWindow();
      try {
        for (const e of gatherHeartbeats(once, { home: fixture.home, claims: [fixture.claim] })) print(e);
        if (args.includes("--subscribe")) for (const e of driveSubscription(once, fixture)) print(e);
        // --tape ends the recorded window, which is what makes a tape owed at all.
        if (args.includes("--tape")) for (const e of await driveTape(once, fixture)) print(e);
      } finally {
        fixture.cleanup();
      }
    } else {
      for (const e of gatherHeartbeats(once)) print(e);
      // Without a fixture window there is nothing recorded to watch: a real
      // machine's own windows are streamed by the daemon, on its lease.
      if (args.includes("--subscribe")) process.stderr.write("note: --subscribe prints nothing without --fixture-window\n");
    }
    // A verb, driven by hand against a recorded window — never against this
    // machine's own projects: a drive that stopped a real factory would be a
    // drive nobody could run twice.
    if (commandVerb) print(await driveCommand(once, commandVerb));
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
