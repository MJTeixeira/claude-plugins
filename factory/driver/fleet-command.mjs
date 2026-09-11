// The command path (T-059) — what the surface can make this machine DO, and
// the four verbs that do it (fleet-control REQ-61..REQ-72, REQ-79, REQ-80,
// REQ-134; their ADR-0004 and ADR-0015).
//
// Three rules shape everything here, and they are the whole of ADR-0004:
//
//   NOTHING IS EVER QUEUED. A verb this publisher cannot perform right now is
//   answered, not held. There is no retry, no deadline and no expiry — the
//   collector waits forever and shows the age, because "a publisher that died
//   after merging a PR did merge the PR".
//
//   `accepted` MEANS THAT VERB'S OWN PROMISE AND NOTHING BEYOND IT. A stop that
//   is accepted promises the latch is placed; it never promises the window
//   ended. `run` promises a driver process was started, never that it produces
//   work.
//
//   `moot` IS NOT A FAILURE. It is "you were right and the world moved" — a
//   hold lifted before the click landed, a milestone already active, a PR
//   already merged. The owner asked for a state that is already true. Note
//   that a stop is never moot for want of a window: the hold outlives any one
//   window, so it is placed between windows too (owner ruling 2026-09-11).
//
// Every verb here writes a file the driver already reads, or spawns the
// driver's own CLI. The one exception is `merge`, which uses the machine's own
// forge client — deliberate, because the forge credential lives on the machine
// and never on the collector, and it is the whole reason a merge is this
// publisher's job at all.
//
// Two of the six change something OUTSIDE this machine, and both are guarded
// before they are attempted rather than after (REQ-73, REQ-74). `merge` carries
// a third guard that is about neither the clone nor the lock: a factory's own
// `autonomy` decides whether a monitor may merge its PRs at all (ADR-0022), so
// a `pr-only` factory refuses the verb whatever else is true.
//
//   a stale clone refuses `run` and `promote` and nothing else. Making the
//   safety verbs the least available ones would be backwards: a project whose
//   clone has drifted is exactly the one you most want to be able to stop.
//
//   a live window refuses `merge` and `promote`. A PR merged underneath a
//   session still pushing to its branch is the one way this surface can corrupt
//   work rather than merely report it wrong; the driver refuses a promote under
//   its own lock guard too, and a refusal that surfaced only as a CLI failure
//   would arrive with no place in the result taxonomy.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseMilestones } from "./backlog-index.mjs";
import { windowStamp, writeFixtureWindow } from "./fleet-heartbeat.mjs";
import { behindOrigin, claimedProjects, normalizeProjectIdentity } from "./fleet-snapshot.mjs";
import { createForge } from "./forge.mjs";
import { envelope } from "./fleet-wire.mjs";
import { pidAlive, readEnvFile, readJson, stateDir, writeJsonAtomic } from "./paths.mjs";

// The four values a result may carry, and the whole vocabulary the collector
// accepts (its RESULTS). A value outside this list leaves the command
// unresolved on the owner's log forever, so it is a list rather than four
// string literals scattered through the verbs.
export const RESULTS = ["accepted", "rejected", "failed", "moot"];


// What `run`'s `mode` means to the driver. The collector's own UI always sends
// `manual`, which is not one of the driver's modes but a statement about HOW
// the run happens: by hand rather than on the schedule. The driver's own mode
// names travel as themselves. `--scheduled` is never passed for any of them
// (REQ-63): a scheduled run into a disabled factory exits 0 in silence, which
// is precisely the answer this verb must not give.
export const RUN_MODES = { manual: "dev", dev: "dev", triage: "triage", report: "report" };

// ---------- the in-flight ledger (REQ-134) ----------
//
// A command is written down BEFORE it is performed and updated after, so a
// publisher that dies mid-verb comes back knowing it already started one. That
// order is the whole of REQ-71's promise: written after the act, a crash
// between the two would leave a merge that happened and no record of it.
//
// One file per machine rather than one per project: there is exactly one
// publisher process on a machine, so the read-modify-write that ADR-0028 warns
// about has no second writer to race.
const LEDGER_VERSION = 1;
const RETAIN_DAYS = 30; // the collector's own retention; an id it has forgotten cannot arrive

const ledgerPath = (home) => path.join(home, ".factory", "fleet-commands.json");

export const createCommandLog = (home = os.homedir(), { now = Date.now, retainDays = RETAIN_DAYS } = {}) => {
  const read = () => {
    const value = readJson(ledgerPath(home));
    return value && typeof value.commands === "object" && value.commands !== null ? value.commands : {};
  };
  const write = (commands) => {
    fs.mkdirSync(path.dirname(ledgerPath(home)), { recursive: true });
    writeJsonAtomic(ledgerPath(home), { version: LEDGER_VERSION, commands });
  };
  // Retention by age, on every write: the set answers one question — have I
  // seen this id — and an id older than the collector's own retention can never
  // be asked about again.
  const prune = (commands, at) => {
    const horizon = at - retainDays * 86400_000;
    for (const [id, rec] of Object.entries(commands)) {
      if (!Number.isFinite(rec?.at) || rec.at < horizon) delete commands[id];
    }
    return commands;
  };
  return {
    seen: (commandId) => read()[commandId] ?? null,
    // In flight: recorded before the verb runs, with what it was asked to do,
    // so a restart can tell a command it started from one it never saw.
    start: (commandId, verb) => {
      const at = now();
      const commands = prune(read(), at);
      commands[commandId] = { verb, at, result: null };
      write(commands);
    },
    finish: (commandId, result) => {
      const commands = read();
      if (!commands[commandId]) return;
      commands[commandId].result = result;
      commands[commandId].sent = false;
      write(commands);
    },
    // An answer this publisher owes and has not managed to say. The collector
    // never re-issues a command — a repeat id replays to the browser and
    // nothing goes back on the wire — so a result lost to a reconnect is a
    // command that ages on the owner's log forever unless this side says it
    // again. Durable for the same reason the set is: a merge that happened and
    // was never reported is the worst of both answers.
    unsent: () =>
      Object.entries(read())
        .filter(([, rec]) => rec?.result && rec.sent !== true)
        .map(([commandId, rec]) => ({ commandId, result: rec.result })),
    markSent: (commandId) => {
      const commands = read();
      if (!commands[commandId]) return;
      commands[commandId].sent = true;
      write(commands);
    },
  };
};

// ---------- the verbs ----------

// The checkout on this machine that the command names. The collector addresses
// a project by its normalised identity (REQ-111), so the match runs through the
// same normaliser both sides share, against the machine's own claims.
//
// An EMPTY claim list is not a claim list: the daemon fills it on its
// 60-second beat, and a command arriving before the first one must fall back
// to reading the registry rather than answer "this machine does not have that
// project" — a refusal the ledger would then make permanent.
const findProject = (project, home, claims) =>
  (claims?.length ? claims : claimedProjects(home)).find((c) => normalizeProjectIdentity(c.remote) === project) ?? null;

const stopFile = (dir, home) => path.join(stateDir(dir, home), "STOP");

// The window holding this project's lock, or null. The id rather than a
// boolean, because a refusal that names the run the owner is being refused for
// is the difference between a reason and a shrug.
const liveWindowId = (dir, home) => {
  const lock = readJson(path.join(stateDir(dir, home), "log", "window.lock"));
  if (!lock || !pidAlive(lock.pid)) return null;
  return windowStamp(lock.startedAt) ?? String(lock.startedAt ?? "unknown");
};

// The driver's declared OFF switch, read from the driver's own config. A
// disabled factory refuses a manual run loudly — `factory is disabled
// (config.json "enabled": false)` — and exits 0 in silence for a scheduled one.
// This verb never passes `--scheduled`, so the refusal is the honest answer;
// it is read HERE rather than waited for because a `run` promises a process was
// started and nothing beyond it, and waiting for the driver's exit would make
// the promise a different one.
const isDisabled = (dir, home) => readJson(path.join(stateDir(dir, home), "config.json"))?.enabled === false;

const driverCli = fileURLToPath(new URL("./factory.mjs", import.meta.url));

// Detached, and detached properly: a window outlives the publisher, survives
// its restart, and must not die with it. Output goes to the driver's own log
// dir rather than to this process's pipes, which would fill and block a daemon
// that never reads them.
const spawnDriver = (args, dir, home, deps = {}) => {
  const { spawnFn = spawn, node = process.execPath, log = () => {} } = deps;
  const logDir = path.join(stateDir(dir, home), "log");
  fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(path.join(logDir, "fleet-run.out"), "a");
  try {
    const child = spawnFn(node, [driverCli, ...args], {
      detached: true,
      stdio: ["ignore", out, out],
      cwd: dir,
      // The daemon's own environment minus its credential: a window is a
      // session, and the publisher's secret has no business in one.
      env: driverEnv(),
    });
    // A spawn failure arrives as an EVENT, not a throw — an ENOENT cwd or a
    // process table at its limit would otherwise take the whole daemon down
    // with an unhandled 'error'. There is nothing to answer by then: the verb
    // has already promised what it promised, so this is said and not raised.
    child.on?.("error", (e) => log(`fleet-publisher: run in ${dir} never started: ${e.message}`));
    child.unref?.();
    return child.pid ?? null;
  } finally {
    fs.closeSync(out);
  }
};

// What a spawned driver inherits. `FLEET_PUBLISHER_SECRET` is stripped rather
// than trusted not to be there: it reaches this process from a unit file or a
// shell, and a session that never needs it must never be able to read it.
const driverEnv = () => {
  const { FLEET_PUBLISHER_SECRET, ...rest } = process.env;
  return rest;
};

// The milestone as the backlog states it, or null where the backlog does not
// name one. Read rather than inferred: the driver refuses to promote a
// milestone that is already active, and a refusal this side can see coming is
// `moot` — the owner asked for a state that is already true — where one it
// only learns from an exit code has nowhere to go in the taxonomy.
const milestoneStatus = (dir, id) => {
  try {
    const index = fs.readFileSync(path.join(dir, ".factory", "backlog", "index.md"), "utf8");
    return parseMilestones(index).find((m) => m.id === id)?.status ?? null;
  } catch {
    return null;
  }
};

// The driver's CLI, run to completion. `run` deliberately does not use this —
// it promises a process was started and nothing more — but a promote promises a
// milestone was promoted and pushed, which is only true once the CLI says so.
// Awaited rather than blocking: this daemon's one connection carries the
// fleet's only liveness beat.
const RUN_DRIVER_TIMEOUT_MS = 120_000; // a promote is a commit and a push, not a window

const runDriver = (args, dir, deps = {}) =>
  new Promise((resolve) => {
    const { spawnFn = spawn, node = process.execPath, timeoutMs = RUN_DRIVER_TIMEOUT_MS } = deps;
    // A cap, because this one is awaited: a `git push` against an unreachable
    // forge can hang for as long as the network lets it, and a promise that
    // never settles is a command that never answers and a child nothing reaps.
    const child = spawnFn(node, [driverCli, ...args], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      killSignal: "SIGTERM",
      env: driverEnv(),
    });
    let err = "";
    child.stderr?.on("data", (chunk) => (err += chunk));
    child.stdout?.on("data", () => {});
    child.on("error", (e) => resolve({ code: -1, err: String(e.message ?? e) }));
    child.on("close", (code, signal) => resolve({ code, err: err.trim() || (signal ? `killed after ${timeoutMs}ms` : "") }));
  });

const verbs = {
  // REQ-63. The promise: a driver process is started. That it produces work, or
  // produces any at all, is not promised here — the next snapshot says so.
  run: (body, { dir, home, deps, log }) => {
    const mode = RUN_MODES[body.mode];
    if (!mode) {
      log(`fleet-publisher: run refused — unknown mode ${JSON.stringify(body.mode ?? null)}`);
      return "rejected";
    }
    // Already running is not a failure and not a second window: the owner
    // asked for a state the world is already in.
    if (liveWindowId(dir, home)) {
      log(`fleet-publisher: run is moot — a window is already live on ${dir}`);
      return "moot";
    }
    // REQ-73: a stale clone refuses the two verbs that CAUSE work, and nothing
    // else — a driver started on a checkout behind its origin would work on
    // code the owner has already moved past. Only a clone MEASURED to be behind
    // refuses; one this machine could not measure guards nothing.
    if (behindOrigin(dir, home) === true) {
      log(`fleet-publisher: run refused — ${dir} is behind origin`);
      return "rejected";
    }
    if (isDisabled(dir, home)) {
      // The driver's own refusal, in the driver's own words. It cannot travel:
      // a commandResult carries an id and an outcome and nothing else, so the
      // reason lives in this machine's log and the outcome is what the owner
      // sees.
      log(`fleet-publisher: run refused — factory is disabled (config.json "enabled": false)`);
      return "rejected";
    }
    const pid = spawnDriver([mode, "--project", dir], dir, home, { ...deps, log });
    if (!pid) return "failed";
    log(`fleet-publisher: ran ${mode} for ${dir} (pid ${pid})`);
    return "accepted";
  },

  // REQ-64. The promise: a stop hold is placed. The window ends at its next
  // session boundary, which can take a full session timeout — the session in
  // flight is never interrupted.
  //
  // The file's CONTENTS are a convention this publisher owns on both ends: the
  // driver only ever checks that the file exists, T-053 reads the placer and
  // the moment back off it, and a hold placed by hand stays valid and carries
  // only its age.
  stop: (body, { dir, home, now, log }) => {
    // No live-window guard, by owner ruling 2026-09-11: a hold is placed
    // whether or not a window is running. REQ-15 renders `stop held 13d · by
    // hand`, which is a hold on a project that is NOT running — the surface
    // has a rendering for exactly the state a guard here would refuse to
    // create, and a stop between windows is the one that keeps the next one
    // from starting. ADR-0004's "a stop is moot" is about a machine that is
    // not reporting, and the collector refuses that before it reaches here.
    //
    // A hold already placed is not placed again: the board shows how long it
    // has been held, and re-writing it would reset that age and overwrite
    // whoever placed it. The promise — a stop hold is placed — is already kept.
    if (fs.existsSync(stopFile(dir, home))) return "accepted";
    writeJsonAtomic(stopFile(dir, home), { placedBy: "fleet-control", at: new Date(now()).toISOString() });
    log(`fleet-publisher: stop hold placed for ${dir}`);
    return "accepted";
  },

  // REQ-65. The promise: the stop hold is lifted. Whether a window starts is up
  // to the schedule, not to this.
  resume: (body, { dir, home, log }) => {
    const file = stopFile(dir, home);
    if (!fs.existsSync(file)) return "moot"; // already lifted
    fs.rmSync(file, { force: true });
    log(`fleet-publisher: stop hold lifted for ${dir}`);
    return "accepted";
  },

  // The promise: the factory's enabled flag is written. Nothing starts or stops
  // because of it — a live window keeps running, and a disabled factory that
  // was already disabled is still a flag written.
  "set-enabled": (body, { dir, home, log }) => {
    if (typeof body.enabled !== "boolean") {
      log(`fleet-publisher: set-enabled refused — enabled is not a boolean`);
      return "rejected";
    }
    const file = path.join(stateDir(dir, home), "config.json");
    const config = readJson(file);
    if (!config) return "failed"; // no config is not a factory this verb can write
    writeJsonAtomic(file, { ...config, enabled: body.enabled });
    log(`fleet-publisher: ${dir} enabled=${body.enabled}`);
    return "accepted";
  },

  // REQ-78. The promise: the milestone named HERE is promoted and pushed. The
  // id always travels with the command and is never one this publisher chose —
  // the owner confirmed a sentence naming it, and a publisher that picked its
  // own would be promoting something else.
  promote: async (body, { dir, home, deps, log }) => {
    const milestone = typeof body.milestone === "string" && body.milestone ? body.milestone : null;
    if (!milestone) {
      log(`fleet-publisher: promote refused — no milestone named`);
      return "rejected";
    }
    if (behindOrigin(dir, home) === true) {
      log(`fleet-publisher: promote refused — ${dir} is behind origin`);
      return "rejected";
    }
    // Checked HERE, before anything is spawned, from the same lock the
    // heartbeat reads. The driver refuses it too, under its own lock guard —
    // but that refusal would arrive as an exit code, and "a window is running"
    // is a reason the owner should read rather than a failure.
    const window = liveWindowId(dir, home);
    if (window) {
      log(`fleet-publisher: promote refused — window ${window} is live on ${dir}`);
      return "rejected";
    }
    if (milestoneStatus(dir, milestone) === "active") return "moot"; // already open
    const { code, err } = await runDriver(["promote", milestone, "--project", dir], dir, deps);
    if (code !== 0) {
      log(`fleet-publisher: promote ${milestone} failed: ${err || `exit ${code}`}`);
      return "failed";
    }
    log(`fleet-publisher: promoted ${milestone} in ${dir}`);
    return "accepted";
  },

  // REQ-76. The promise: the ONE PR named here is merged, and no other PR is
  // touched. This is the only verb that does not go through the driver: the
  // driver has no merge-this-url verb, and the forge credential lives on this
  // machine precisely so the collector never holds one.
  merge: async (body, { dir, home, deps, log }) => {
    const pr = typeof body.pr === "string" && body.pr ? body.pr : null;
    if (!pr) {
      log(`fleet-publisher: merge refused — no PR named`);
      return "rejected";
    }
    // REQ-74: never underneath a session still pushing to that branch. First of
    // the two refusals because it is the dangerous one — the state this guard
    // exists for is the state where merging corrupts work rather than merely
    // being unwanted.
    const window = liveWindowId(dir, home);
    if (window) {
      log(`fleet-publisher: merge refused — window ${window} is live on ${dir}`);
      return "rejected";
    }
    const config = readJson(path.join(stateDir(dir, home), "config.json"));
    // ADR-0022: what a monitor may merge is an owner decision PER FACTORY, and
    // a factory already declares it. `auto-merge-dev` is the factory that has
    // said its PRs may be merged without a human reading them; `pr-only` — the
    // driver's own default, and what a config saying nothing means — is the
    // factory whose every PR waits for one, and a click on a board is not a
    // human reading a diff. Unlike the guard above, this refusal is permanent:
    // it does not depend on what the machine is doing, and a second click will
    // not change it.
    const autonomy = config?.autonomy ?? "pr-only";
    if (autonomy !== "auto-merge-dev") {
      log(`fleet-publisher: merge refused — ${dir} is ${autonomy}, and only an auto-merge-dev factory is merged from the surface`);
      return "rejected";
    }
    const { makeForge = createForge } = deps;
    const kind = config?.forge || "github";
    let forge;
    try {
      forge = makeForge({ kind, project: dir, env: readEnvFile(stateDir(dir, home), home) });
    } catch (e) {
      // A forge this machine has no client for is not a PR that failed to
      // merge. The collector withholds the verb where it knows the forge is
      // unreachable; where it does not know, this is the honest answer.
      log(`fleet-publisher: merge failed — no forge client for ${kind}: ${e.message}`);
      return "failed";
    }
    // The forge's ASYNC surface, not its ordinary one: the ordinary calls are
    // `execFileSync` with a 60-second cap, and two of them back to back would
    // freeze this daemon for two minutes — during which its heartbeat stops
    // and the board reads the machine as silent. The dashboard's rows already
    // take this transport for the same reason.
    const state = await forge.async.prState(pr);
    if (state.error) {
      log(`fleet-publisher: merge failed — could not read ${pr}: ${state.error}`);
      return "failed";
    }
    // The forge contract's vocabulary (forge.mjs header), which both adapters
    // answer in: comparing against anything else reads an already-merged PR as
    // open on whichever forge does not happen to match, and attempts a merge
    // the owner is then told failed.
    if (state.data === "MERGED") return "moot"; // the world moved before this landed
    const merged = await forge.async.prMerge(pr);
    if (merged.error) {
      log(`fleet-publisher: merge failed — ${pr}: ${merged.error}`);
      return "failed";
    }
    log(`fleet-publisher: merged ${pr}`);
    return "accepted";
  },
};

// The verbs this module performs, read off the table that performs them so the
// list cannot drift from the dispatch. A verb outside it is refused by name
// rather than silently ignored, which is why the list is exported at all.
export const VERBS = Object.freeze(Object.keys(verbs));

// One inbound command, performed and answered. Returns the result string; the
// caller sends it. Never throws for a verb's own failure — an exception here
// would leave the command unresolved on the owner's log forever, so the whole
// dispatch is the one place this module catches.
//
// Async because a verb may have to WAIT for what it promises: `run` promises a
// process was started and returns the moment it is, but the two verbs that
// change something outside this machine (T-060) promise a completed act. A
// daemon whose one connection carries the fleet's only liveness beat must not
// block its event loop on a `git push`, which is the same reason this process
// exists apart from the supervisor at all.
export const performCommand = async (body, settings, deps = {}) => {
  const {
    home = os.homedir(),
    now = Date.now,
    log = () => {},
    claims,
    verbs: table = verbs,
  } = deps;
  const { commandId, verb, project, machine } = body ?? {};
  if (typeof commandId !== "string" || commandId === "") return null; // nothing to answer
  // The machine travels explicitly so this side can check it (ADR-0015): a
  // command for another machine arriving on this connection is a defect at the
  // far end, and performing it would be worse than refusing it.
  if (machine !== settings.machineId) {
    log(`fleet-publisher: command ${commandId} names machine ${machine}, not this one`);
    return "rejected";
  }
  const perform = table[verb];
  if (!perform) {
    log(`fleet-publisher: command ${commandId} names an unknown verb ${JSON.stringify(verb ?? null)}`);
    return "rejected";
  }
  const found = findProject(project, home, claims);
  if (!found) {
    log(`fleet-publisher: command ${commandId} names a project this machine does not have: ${project}`);
    return "rejected";
  }
  try {
    return await perform(body, { dir: found.dir, remote: found.remote, home, now, deps, log });
  } catch (e) {
    log(`fleet-publisher: command ${commandId} (${verb}) failed: ${e}`);
    return "failed";
  }
};

// The command as the daemon handles it: replayed from the ledger where the id
// has been seen before, recorded in flight where it has not, and always
// answered exactly once. A repeat id never re-executes — REQ-71's promise is
// that a reconnect neither double-executes nor silently drops a command.
export const answerCommand = async (body, settings, deps = {}) => {
  const { home = os.homedir(), commands = createCommandLog(home, deps), log = () => {} } = deps;
  const commandId = body?.commandId;
  if (typeof commandId !== "string" || commandId === "") return null;
  const seen = commands.seen(commandId);
  if (seen) {
    // Replayed verbatim, and a command this publisher started and never
    // finished replays as nothing at all — which is the honest answer and the
    // collector's own: it renders an unresolved command as ageing, forever if
    // need be, because a publisher that died after merging a PR did merge the
    // PR. Re-running it is the one thing that must not happen, and answering
    // `failed` for a verb that may have succeeded is the other.
    log(`fleet-publisher: command ${commandId} replayed (${seen.result ?? "still unresolved — it was started and never finished"})`);
    return seen.result;
  }
  commands.start(commandId, body?.verb ?? null);
  const result = await performCommand(body, settings, { ...deps, home });
  // A verb that answered with a word outside the four would leave the command
  // ageing on the owner's log forever: the collector's `resolve` drops what it
  // does not recognise. A publisher bug is a failure, not a silence.
  if (result && !RESULTS.includes(result)) {
    log(`fleet-publisher: command ${commandId} answered ${JSON.stringify(result)}, which is not a result`);
    commands.finish(commandId, "failed");
    return "failed";
  }
  if (result) commands.finish(commandId, result);
  return result;
};

// The answer on the wire. Two fields, because two is what the collector reads —
// a reason field would be dropped in silence, which is why every refusal here
// says its reason to this machine's log instead.
export const commandResult = (machineId, commandId, result, at = Date.now()) =>
  envelope(machineId, "commandResult", { commandId, result }, at);

// ---------- the drive (`--once --offline --command <verb>`) ----------

// What each verb is given when it is driven by hand. The point of the arguments
// is that the verb reaches the thing it is about: a `stop` with no window to
// stop, or a merge with no PR named, would answer without ever touching the
// path being driven.
const DRIVE_ARGS = {
  run: { mode: "manual" },
  stop: {},
  resume: {},
  "set-enabled": { enabled: false },
  // The recorded window is live, so these two reach their guard and are
  // refused by it — which is the thing worth driving. Without an argument they
  // would be refused for having none, and the drive would prove that instead.
  promote: { milestone: "M1" },
  merge: { pr: "https://github.com/MJTeixeira/fixture-window/pull/1" },
};

// One verb, performed against a recorded window on disk — the same fixture the
// heartbeat and transcript drives use, and for the same reason: the drive is
// only worth having if it exercises the reads and writes the daemon does. It is
// a throwaway machine, so the file a verb writes is written for real and thrown
// away with it.
export const driveCommand = async (settings, verb, at = Date.now()) => {
  const fixture = writeFixtureWindow(at);
  const commandId = `drive-${at}`;
  try {
    const result = await performCommand(
      {
        commandId,
        machine: settings.machineId,
        project: normalizeProjectIdentity(fixture.claim.remote),
        verb,
        ...(DRIVE_ARGS[verb] ?? {}),
      },
      settings,
      {
        home: fixture.home,
        now: () => at,
        claims: [fixture.claim],
        log: (msg) => process.stderr.write(msg + "\n"),
      },
    );
    return commandResult(settings.machineId, commandId, result, at);
  } finally {
    fixture.cleanup();
  }
};
