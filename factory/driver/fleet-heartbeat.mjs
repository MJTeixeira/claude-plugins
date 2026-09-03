// The activity heartbeat (T-056) — what a machine says about a window WHILE
// it runs, on a 20-second tick and only while that window holds the project's
// lock. Its absence is the idle signal (REQ-122): the driver goes silent for
// minutes at a time inside a gate suite or a code review, so a heartbeat that
// stopped arriving is the only honest way to say "no window".
//
// Two of its fields are this publisher's READING of session output, not facts
// the driver states:
//
//   component  which part of the driver holds the window. Derived by
//              `live-tail.mjs`'s `deriveComponent` from the daily log's own
//              narration — the same derivation the dashboard renders, so the
//              board and the dashboard cannot disagree about one machine.
//   activity   what the session is doing inside that component. The driver
//              types nothing here — there is no "what am I doing" enum
//              anywhere in it — so this module owns the guess and keeps it to
//              what the transcript states rather than what a reader could
//              talk itself into. See docs/adr/0006.
//
// Everything else is free: the window lock carries pid, mode and the window's
// start, and the daily log names the live session transcript, which is where
// the turn count and the last event come from.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { envelope, heartbeatBody } from "./fleet-wire.mjs";
import { claimRemote } from "./fleet-snapshot.mjs";
import { activeTranscript, deriveComponent, parseSessionEvents, tailFile } from "./live-tail.mjs";
import { pidAlive, readJson, stateDir } from "./paths.mjs";

// REQ-122's tick, and the collector's own `TICK_SECONDS`.
export const HEARTBEAT_TICK_MS = 20_000;

// The two activity levels this publisher can infer, and the value it says
// instead of inventing a third. `unobserved` is not a failure — it is the
// honest reading whenever there is no session transcript to read, and REQ-51
// keeps it distinct from idle, which the heartbeat's silence already means.
export const ACTIVITY = { work: "task-work", mcp: "mcp-call", none: "unobserved" };

// The window's identity: the driver's own start stamp, reused and never
// minted (REQ-114). The driver stamps its files `nowStamp()`-style — colons
// and dots swapped for dashes — and the collector parses the id back into the
// window's start with an anchored second-precision pattern, so the
// milliseconds a filename carries are dropped rather than sent. A lock whose
// `startedAt` cannot be read yields null and the window simply does not beat:
// a heartbeat that does not name its window names no run.
export const windowStamp = (startedAt) => {
  const at = Date.parse(startedAt ?? "");
  if (!Number.isFinite(at)) return null;
  return new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
};

// The activity guess, and the whole of it. A transcript is only being read
// while a SESSION holds the window — the driver's other components (its
// boundary sweep, the grader, prep) write no transcript this side can name —
// so everything else is `unobserved` rather than the last session's activity
// worn for another few minutes. Within a session, the one thing the
// transcript states outright is the tool's own name: an `mcp__` call is a
// call to the driver, anything else is work on the task. Nothing here matches
// on commands or descriptions to reach for a richer word.
export const inferActivity = (component, lastEvent) => {
  if (component !== "session" || typeof lastEvent !== "string" || lastEvent === "") return ACTIVITY.none;
  return lastEvent.startsWith("mcp__") ? ACTIVITY.mcp : ACTIVITY.work;
};

const dailyLogLines = (logDir, at) => {
  const file = path.join(logDir, `factory-${new Date(at).toISOString().slice(0, 10)}.log`);
  try {
    return fs.readFileSync(file, "utf8").trim().split("\n");
  } catch {
    return []; // a window that started before today's log exists is not a fault
  }
};

// One project's heartbeat body, or null where there is no window to describe.
// `caches` is the caller's (the tail is incremental — offsets and counters
// live across ticks, per `live-tail.mjs`'s no-globals contract), keyed by
// checkout dir and dropped the moment the window ends so the next window
// starts from zero turns.
export const windowHeartbeat = (dir, remote, { home, now, caches, report }) => {
  const sd = stateDir(dir, home);
  const lock = readJson(path.join(sd, "log", "window.lock"));
  if (!lock || !pidAlive(lock.pid)) {
    caches.delete(dir);
    return null;
  }
  const windowId = windowStamp(lock.startedAt);
  const mode = typeof lock.mode === "string" && lock.mode ? lock.mode : null;
  if (!windowId || !mode) {
    report(`fleet-publisher: live window in ${dir} names no ${windowId ? "mode" : "start"} — no heartbeat`);
    return null;
  }
  const at = now();
  const logLines = dailyLogLines(path.join(sd, "log"), at);
  const component = deriveComponent(logLines, true); // the lock is alive: checked above
  const active = activeTranscript(logLines);
  const cache = caches.get(dir) ?? {};
  // A new session is a new transcript: fresh offset, fresh counters — its
  // turn count is the session's, never the window's running total.
  if (cache.file !== (active?.file ?? null)) {
    cache.file = active?.file ?? null;
    cache.tail = {};
    cache.sess = {};
  }
  if (cache.file) parseSessionEvents(tailFile(cache.file, cache.tail), cache.sess);
  caches.set(dir, cache);
  const lastEvent = cache.sess.lastEvent
    ? {
        summary: cache.sess.lastEvent,
        // A duration on this machine (REQ-123), measured from when this
        // publisher READ the event: the transcript's own lines carry no
        // timestamp the tail keeps, and the dashboard dates the same field
        // the same way. Same limit too: a publisher restarted mid-window
        // re-reads the whole transcript and re-dates old events as fresh.
        ageSeconds: Math.max(0, Math.round((at - cache.sess.lastEventAt) / 1000)),
      }
    : null;
  return heartbeatBody({
    project: remote,
    windowId,
    mode,
    tSeconds: Math.max(0, Math.round((at - Date.parse(lock.startedAt)) / 1000)),
    session: component.session ?? null,
    taskId: active?.taskId ?? null,
    component: component.phase,
    activity: inferActivity(component.phase, cache.sess.lastEvent),
    turns: cache.sess.turns ?? 0,
    lastEvent,
  });
};

// Every live window on this machine, as heartbeat envelopes — usually none or
// one. The registry read is cheap; the identifying `git` spawn is paid ONLY
// for a project that actually holds a live lock, because this runs three times
// a minute and the 60-second beat already pays for the rest. `deps.claims`
// (the fixture drive) skips the registry entirely.
export const gatherHeartbeats = (settings, deps = {}) => {
  const {
    home = os.homedir(),
    now = Date.now,
    caches = new Map(),
    report = (msg) => process.stderr.write(msg + "\n"),
  } = deps;
  const claims =
    deps.claims ??
    Object.keys(readJson(path.join(home, ".factory", "registry.json"))?.factories ?? {})
      .sort()
      .filter((dir) => {
        const lock = readJson(path.join(stateDir(dir, home), "log", "window.lock"));
        return Boolean(lock && pidAlive(lock.pid));
      })
      .map((dir) => ({ dir, remote: claimRemote(dir) }));
  const envelopes = [];
  for (const { dir, remote } of claims) {
    // The same loud stance as the snapshot gather (REQ-112): a window on a
    // project with no usable remote has nowhere to land, and inventing a row
    // key from its directory name is the thing that rule forbids.
    if (!remote) {
      report(`fleet-publisher: live window in a project that cannot be identified (no usable remote): ${dir}`);
      continue;
    }
    try {
      const body = windowHeartbeat(dir, remote, { home, now, caches, report });
      if (body) envelopes.push(envelope(settings.machineId, "heartbeat", body, now()));
    } catch (e) {
      report(`fleet-publisher: heartbeat failed for ${dir}: ${e}`);
    }
  }
  return envelopes;
};

// ---------- the fixture window (`--fixture-window`) ----------
//
// A recorded window, written to disk as the driver would write it, so the
// heartbeat path is runnable on a machine that has no window running — which
// is every machine, most of the time. It is deliberately files rather than an
// injected object: the drive is only worth having if it exercises the same
// reads the daemon does (the lock, today's daily log, the transcript by the
// absolute path that log names), and a stub in front of those would prove the
// shape while hiding the reading.
//
// The material is a real window's, transcribed: a dev window a hundred
// seconds in, one session on a task, ending on the driver's own MCP call.
const FIXTURE_TURNS = [
  { name: "Read", input: { file_path: "factory/driver/fleet-publisher.mjs" } },
  { name: "Bash", input: { command: "node --test factory/driver/test/fleet-heartbeat.test.mjs", description: "Run the heartbeat tests" } },
  { name: "Edit", input: { file_path: "factory/driver/fleet-heartbeat.mjs" } },
  { name: "mcp__factory__log_progress", input: { description: "tests green, opening the PR" } },
];

export const writeFixtureWindow = (at = Date.now()) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-fixture-window-"));
  const dir = path.join(home, "repos", "fixture-window");
  const logDir = path.join(stateDir(dir, home), "log");
  fs.mkdirSync(logDir, { recursive: true });
  const startedAt = new Date(at - 100_000).toISOString();
  const transcript = path.join(logDir, `dev-${startedAt.replace(/[:.]/g, "-")}.out`);
  fs.writeFileSync(
    transcript,
    FIXTURE_TURNS.map((t) =>
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", ...t }] } }),
    ).join("\n") + "\n",
  );
  // This process's own pid: a fixture window is live for exactly as long as
  // the drive that wrote it, which is the honest way to make `pidAlive` true
  // without pretending some other process exists.
  fs.writeFileSync(
    path.join(logDir, "window.lock"),
    JSON.stringify({
      pid: process.pid,
      mode: "dev",
      startedAt,
      windowEndsAt: new Date(at + 4 * 3600_000).toISOString(),
      currentSession: 1,
    }),
  );
  fs.writeFileSync(
    path.join(logDir, `factory-${new Date(at).toISOString().slice(0, 10)}.log`),
    [
      `[${startedAt}] dev window starting: 4h window, autonomy pr-only`,
      `[${startedAt}] session 1 starting (plan: T-056, opus, effort high) — ${transcript}`,
      "",
    ].join("\n"),
  );
  return {
    home,
    claim: { dir, remote: "https://github.com/MJTeixeira/fixture-window.git" },
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
};

// The daemon's own source: one cache map held across ticks, so each tick
// reads only the transcript bytes that arrived since the last one.
export const createHeartbeatSource = () => {
  const caches = new Map();
  return (settings, deps = {}) => gatherHeartbeats(settings, { ...deps, caches });
};
