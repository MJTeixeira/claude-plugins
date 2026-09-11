// The watched transcript (T-058) — what a machine sends about a live window
// WHILE somebody has that window open, and nothing at all otherwise.
//
// The flow is a lease, not a subscription this side can lose (fleet-control
// ADR-0016, REQ-124): the collector sends a `transcript` envelope carrying
// `{ project, window, leaseSeconds }` when the first viewer opens a window and
// re-sends it on a clock of its own while any viewer is attached. When the last
// viewer leaves it simply stops renewing. Nothing is cancelled, so a publisher
// that never hears the stop still falls silent on its own once the lease
// lapses — and, just as importantly, a QUIET window keeps streaming: REQ-124
// exists because a 611-second silent stretch was tearing down a stream someone
// was watching, so nothing here may end a stream on the absence of events.
//
// Two rules shape the reading side:
//
//   from now, never a backfill (REQ-57) — a lease that has just arrived seeks
//   the session transcript to its END and emits nothing for what came before.
//   The heartbeat has already said where things stand; the stream costs only
//   what happens from the moment it was opened. A lapsed lease drops its
//   position with it, so re-opening a window starts from THAT moment too and
//   never floods the viewer with the gap.
//
//   the publisher types what the flow reads (ADR-0016) — the work a tool did,
//   the skill and the driver call it was, a spawn and its end, the session's
//   typed suite verdict and the PR it opened, and how the session ended. Every
//   one of those is read off what the transcript STATES: the tool that ran, the
//   argument it was given, the record the CLI wrote. Nothing here scores a
//   tool's OUTPUT — D-007 measured that reading, and it scored a `Read` of a
//   Java test file as a failing suite.
//
//   Three fields the flow reads are deliberately never sent, because no machine
//   states them: `merged` (the driver merges outside any session, so no
//   transcript line says it), `runs` (nothing counts suite runs) and `cached`.
//   The far end renders their absence; a value guessed here would render as
//   fact.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { envelope } from "./fleet-wire.mjs";
import { claimRemote, normalizeProjectIdentity } from "./fleet-snapshot.mjs";
import { dailyLogLines, windowStamp } from "./fleet-heartbeat.mjs";
import { activeTranscript, deriveComponent, summarizeBlock, tailFile } from "./live-tail.mjs";
import { SUITE_VERDICTS } from "./mcp-server.mjs";
import { pidAlive, readJson, stateDir } from "./paths.mjs";

// The stream's own tick. Faster than the heartbeat's 20 seconds because this
// is the one thing on the wire a human watches in real time, and cheap because
// a tick with no active lease reads nothing at all.
export const TRANSCRIPT_TICK_MS = 2000;

// The leases this machine currently holds, keyed by the pair the collector
// names them with. The key is the collector's own project IDENTITY (its
// `subscription.projectId`), not the raw remote a snapshot carries, so the
// match runs through the same normaliser both sides share.
export const createLeases = () => {
  const held = new Map();
  // The collector's own composite key, and its own rule about writing it: the
  // separator is the escape and never the byte, which would make this file
  // binary to grep, to diff and to every reader after them.
  const key = (project, window) => `${project}\u0000${window}`;
  return {
    // One inbound `transcript` envelope body. A renewal is the same message
    // again: it simply pushes the expiry out, which is what keeps a stream
    // open across any length of silence.
    grant: (body, at) => {
      const { project, window, leaseSeconds } = body ?? {};
      if (typeof project !== "string" || typeof window !== "string") return false;
      if (typeof leaseSeconds !== "number" || !Number.isFinite(leaseSeconds) || leaseSeconds <= 0) return false;
      held.set(key(project, window), at + leaseSeconds * 1000);
      return true;
    },
    // Is this window watched right now? Expiry is checked on read rather than
    // on a timer of its own: there is no tick a lapse needs to happen between.
    active: (project, window, at) => {
      const until = held.get(key(project, window));
      if (until === undefined) return false;
      if (until > at) return true;
      held.delete(key(project, window));
      return false;
    },
    // Expiry has to happen without a reader, because there is one case where
    // nobody reads: a window that ended still holds its lease, and the gather
    // returns at the dead lock before it ever asks. Without this the map only
    // grows, and "a tick with no lease reads nothing" stops being true after
    // the first watched window.
    sweep: (at) => {
      for (const [k, until] of held) if (until <= at) held.delete(k);
    },
    size: () => held.size,
  };
};

// ---------- typing the transcript ----------

// What the tool that ran says about the work, and the whole of it. The names
// are the flow's vocabulary (ADR-0016): `reading` and `discovery` collapse to
// one phase at the far end, `editing` is what `dev` MEANS (REQ-43), and `docs`
// is an edit whose file is prose. A tool not named here types nothing — the
// event still travels for its summary, and the flow folds an untyped stretch
// into the phase around it rather than being told a word this side guessed. A
// word invented here would not fold: the far end renders an unrecognised
// `work` as the literal string `undefined`, and says nothing about it.
const WORK_BY_TOOL = {
  Read: "reading",
  NotebookRead: "reading",
  Grep: "discovery",
  Glob: "discovery",
  WebSearch: "discovery",
  WebFetch: "discovery",
  Edit: "editing",
  Write: "editing",
  NotebookEdit: "editing",
};

const DOC_FILE = /\.(?:md|mdx|txt|rst|adoc)$/i;

// A test file by its NAME, which is all this side can honestly claim about a
// path. It gates one rendering at the far end — an edit stretch made only of
// test files, sitting in front of a red verdict, reads as a deliberate TDD red
// rather than as a breakage — so a miss costs a label and never a verdict.
const TEST_FILE = /(?:^|\/)tests?\/|[._-](?:test|spec)\.[a-z]+$|_test\.[a-z]+$/i;

// `committing` is read from the command the session RAN, which the transcript
// states outright — not from anything a command printed. That boundary is
// D-007's: what was run is a fact on the line, what it produced is a reading.
const COMMITTING = /^\s*git\s+(?:commit|push)\b/;

const workOf = (name, input) => {
  if (name === "Bash" && typeof input.command === "string" && COMMITTING.test(input.command)) return "committing";
  const work = WORK_BY_TOOL[name];
  if (work === "editing" && typeof input.file_path === "string" && DOC_FILE.test(input.file_path)) return "docs";
  return work ?? null;
};

// What a `report_status` states beyond having happened. Both travel on CHANGE,
// because the driver asks a session to report at task selection, at PR open and
// as its final act: one verdict carried through three reports is one suite run,
// and one url repeated is one PR.
const reportEvents = (input, cache) => {
  const events = [];
  const verdict = SUITE_VERDICTS.includes(input.suiteVerdict) ? input.suiteVerdict : null;
  if (verdict && verdict !== cache.verdict) {
    cache.verdict = verdict;
    events.push({ kind: "test_result", verdict });
  }
  const pr = typeof input.pr === "string" && input.pr !== "" ? input.pr : null;
  if (pr && pr !== cache.pr) {
    cache.pr = pr;
    events.push({ kind: "pr_opened", summary: pr });
  }
  // A settled report's status IS the session's outcome — the CLI's own result
  // record says when a session ended, never how it went. Held until that record
  // arrives, exactly as the driver holds it.
  if (typeof input.status === "string" && input.status !== "in-progress") cache.status = input.status;
  return events;
};

// The events one tool_use block states. Usually one — the line a viewer reads
// in the transcript panel — but a `report_status` states more than the fact of
// itself: the typed suite verdict (T-057) and the PR the session opened are
// both arguments ON the line, and both are markers at the far end.
const toolEvents = (block, cache) => {
  const name = block.name;
  if (typeof name !== "string" || name === "") return [];
  const input = block.input ?? {};
  // One human-scannable line, from the dashboard's own summarizer: the
  // description the tool was given, else the file it touched, else the head of
  // the command. One summarizer, so the board and the dashboard cannot
  // describe the same turn differently.
  const event = { summary: summarizeBlock(block) };
  const work = workOf(name, input);
  if (work) event.work = work;
  if (work === "editing" && TEST_FILE.test(input.file_path ?? "")) event.testFile = true;
  // An MCP call is a call to the DRIVER, and the flow names its milestones by
  // the bare method (`submit_plan`, `open_question`), so the plugin prefix is
  // dropped here rather than at the far end.
  const mcp = name.startsWith("mcp__") ? name.slice(name.lastIndexOf("__") + 2) : null;
  if (mcp) event.mcp = mcp;
  if (name === "Skill" && typeof input.skill === "string") event.skill = input.skill;
  // The grader states a verdict per criterion under its own field name, `pass`;
  // the flow's field is `passed`, and this is the one place the two names meet.
  // Counted here and never re-judged — the grade lane's meaning is the
  // grader's, and the far end counts an attempt per verdict and a failure only
  // where one is stated false.
  if (mcp === "grade_verdict" && Array.isArray(input.criteria))
    event.passed = input.criteria.every((c) => c?.pass === true);
  const events = [event];
  if (mcp === "report_status") events.push(...reportEvents(input, cache));
  return events;
};

// A spawn's two halves, stated by the CLI as records of their own and paired by
// the id it minted. The flow builds a lane from the pair, and a start whose end
// never arrives renders as a lane still running — so an end is recognised only
// on the statuses that really are ends, and a status nobody has seen leaves the
// lane open rather than closing it on a guess.
const SPAWN_ENDED = ["completed", "failed", "stopped"];

const spawnEvent = (record) => {
  const id = typeof record.task_id === "string" && record.task_id ? record.task_id : null;
  if (!id) return null;
  const str = (v) => (typeof v === "string" && v !== "" ? v : null);
  if (record.subtype === "task_started") {
    const event = { kind: "spawn_started", spawnId: id };
    const kind = str(record.task_type);
    const summary = str(record.description);
    if (kind) event.spawnKind = kind;
    if (summary) event.summary = summary;
    return event;
  }
  if (record.subtype === "task_notification" && SPAWN_ENDED.includes(record.status))
    return { kind: "spawn_ended", spawnId: id, outcome: record.status };
  return null;
};

// The session's end, in the vocabulary the far end branches on. The outcome is
// the driver's own: a settled report's status, and only where no session ever
// reported one does the CLI's exit say whether it ran out of turns or died
// (`factory.mjs` reads its own two structural signals for the cap the same
// way). `completed` is the one translation — the flow's word for it is `done`.
// A word the far end does not know is printed verbatim and rendered as an end
// that did not go well, so translating the one word that means success is worth
// doing and inventing words for the rest is not.
const OUTCOME = { completed: "done" };

const sessionEnded = (record, cache) => {
  const capped = record.subtype === "error_max_turns" || record.terminal_reason === "max_turns";
  const status = cache.status ?? (capped ? "turn-capped" : "died");
  const ended = { kind: "session_ended", outcome: OUTCOME[status] ?? status };
  if (typeof record.total_cost_usd === "number") ended.costUsd = record.total_cost_usd;
  return ended;
};

// Where each line of a batch sits in the window, in seconds on this machine
// (REQ-123). The line's OWN timestamp is what places it: the CLI dates every
// assistant and user line, and dates none of its own `system` and `result` rows
// (nor anything at all before 2026-08).
//
// An undated row is placed by the dated lines it sits BETWEEN — carried forward
// from the one above it, or back from the first one below when it opens the
// batch — and only a batch with no dated line anywhere falls back to the moment
// of reading. The reader's clock is a bad stand-in precisely here: it is later
// than every line in the batch by construction, so using it would push each
// undated row past the dated lines that follow it, and the far end sorts
// nothing and pairs a spawn with the end that comes after it.
//
// Two things ride on preferring the line's own clock: the chain is ordered by
// `t` and cut by it, and a tape rebuilt from these same files after the window
// ends (T-061) reproduces the live stream rather than re-dating every event to
// the moment of the rebuild. `cache.t` is the floor across batches — time never
// runs backwards between two reads of one growing file.
const offsetsFor = (records, cache, { at, windowStart }) => {
  const stated = records.map((r) => {
    const parsed = Date.parse(r.timestamp ?? "");
    return Number.isFinite(parsed) ? parsed : null;
  });
  let carry = stated.find((v) => v !== null) ?? at;
  return stated.map((value) => {
    if (value !== null) carry = value;
    cache.t = Math.max(Math.max(0, Math.round((carry - windowStart) / 1000)), cache.t ?? 0);
    return cache.t;
  });
};

// Digest a chunk of session-transcript jsonl into typed events, holding a
// partial trailing line in the caller's cache exactly as the dashboard's tail
// does — the chunk boundary is bytes, not lines. The cache also carries what a
// session has already said (its verdict, its PR, its settled status), which is
// what keeps a repeated report from reading as a second suite run.
export const transcriptEvents = (chunk, cache, { at, windowStart, session }) => {
  cache.buf = (cache.buf ?? "") + chunk;
  const lines = cache.buf.split("\n");
  cache.buf = lines.pop();
  const records = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // a corrupt line is someone else's bug this stream must survive
    }
  }
  const offsets = offsetsFor(records, cache, { at, windowStart });
  const events = [];
  records.forEach((record, i) => {
    const stamp = { t: offsets[i], session };
    if (record.type === "assistant") {
      const blocks = record.message?.content;
      if (!Array.isArray(blocks)) return;
      for (const block of blocks) {
        if (block?.type !== "tool_use") continue;
        for (const event of toolEvents(block, cache)) events.push({ ...stamp, ...event });
      }
      return;
    }
    if (record.type === "system") {
      const spawn = spawnEvent(record);
      if (spawn) events.push({ ...stamp, ...spawn });
      return;
    }
    // The CLI's own end-of-session record: the one place the transcript states
    // that a session is over (REQ-52 — a session with no such record is still
    // running, and nothing here invents an end for it).
    if (record.type === "result") events.push({ ...stamp, ...sessionEnded(record, cache) });
  });
  return events;
};

// ---------- the gather ----------

// Start reading where the file currently ENDS. This is the no-backfill rule
// (REQ-57) in one line, and it is a stat rather than a read: a subscription
// opened on a window an hour in must not pay for — or send — that hour.
const seekToEnd = (file, cache) => {
  try {
    cache.offset = fs.statSync(file).size;
  } catch {
    cache.offset = 0; // no transcript yet: the next tick reads it from its start
  }
};

// One project's transcript envelope body, or null where there is nothing to
// send: no live window, no lease on it, or no new lines since the last tick.
const windowTranscript = (dir, remote, { home, now, caches, leases }) => {
  const sd = stateDir(dir, home);
  const lock = readJson(path.join(sd, "log", "window.lock"));
  if (!lock || !pidAlive(lock.pid)) {
    caches.delete(dir);
    return null;
  }
  const windowId = windowStamp(lock.startedAt);
  const identity = normalizeProjectIdentity(remote);
  if (!windowId || !identity) return null;
  const at = now();
  if (!leases.active(identity, windowId, at)) {
    // Not watched: drop the position with the lease, so the next viewer to
    // open this window starts from THEIR moment and never inherits the gap.
    caches.delete(dir);
    return null;
  }
  const logDir = path.join(sd, "log");
  const logLines = dailyLogLines(logDir, Date.parse(lock.startedAt), at);
  const active = activeTranscript(logLines);
  const held = caches.get(dir);
  const file = active?.file ?? null;
  const fresh = held?.window !== windowId || held?.file !== file;
  const windowStart = Date.parse(lock.startedAt);
  // From the daily log's own session line — the SAME line that names the file
  // being read — rather than from the lock. The two move at different instants,
  // and a tick that caught them mid-turnover would stamp one session's turns
  // with the other's number.
  const session = deriveComponent(logLines, true).session ?? null;

  // A session that turned over inside the window it belongs to leaves a tail
  // nobody has read: the last turns it took and, at the end of them, the record
  // that says how it ended. Read those before following the log to the next
  // session's file, under the session they belong to — a session whose end
  // nobody sent renders at the far end as one still running.
  const trailing =
    held && held.file && held.window === windowId && held.file !== file
      ? transcriptEvents(tailFile(held.file, held.tail), held, { at, windowStart, session: held.session })
      : [];

  // A lease that has just arrived, or a session that has just turned over: both
  // start from now, and both start from nothing said. The whole cache is
  // replaced rather than reset field by field — what a session reported, where
  // its clock had reached and how far the tail had read are all ITS state, and a
  // field left behind by the previous one is a report this one never made.
  const cache = fresh ? { window: windowId, file, session, tail: {}, buf: "" } : held;
  if (fresh && file) seekToEnd(file, cache.tail);
  caches.set(dir, cache);
  if (!cache.file) return trailing.length ? { project: remote, window: windowId, events: trailing } : null;
  const events = [
    ...trailing,
    ...transcriptEvents(tailFile(cache.file, cache.tail), cache, { at, windowStart, session }),
  ];
  if (!events.length) return null; // silence is not an envelope
  return { project: remote, window: windowId, events };
};

// Every watched window on this machine, as transcript envelopes — usually
// none. The claim walk mirrors the heartbeat's: the registry read is cheap,
// and this tick pays nothing at all on a machine nobody is watching.
export const gatherTranscripts = (settings, deps = {}) => {
  const {
    home = os.homedir(),
    now = Date.now,
    caches = new Map(),
    leases,
    report = (msg) => process.stderr.write(msg + "\n"),
  } = deps;
  if (!leases) return [];
  leases.sweep(now());
  // Nothing watched and no position held: this tick reads nothing at all. The
  // second half matters — a lease that has just lapsed leaves a position behind
  // it, and that position must be dropped by a walk rather than kept, or the
  // next viewer to open the window inherits the gap they did not ask for.
  if (leases.size() === 0 && caches.size === 0) return [];
  const claims =
    deps.claims ??
    Object.keys(readJson(path.join(home, ".factory", "registry.json"))?.factories ?? {})
      .sort()
      // The identifying `git` spawn is paid only for a project that actually
      // holds a live lock — the same stance the heartbeat gather takes, and it
      // matters more here because this tick runs thirty times a minute.
      .filter((dir) => {
        const lock = readJson(path.join(stateDir(dir, home), "log", "window.lock"));
        return Boolean(lock && pidAlive(lock.pid));
      })
      .map((dir) => ({ dir, remote: claimRemote(dir) }));
  const envelopes = [];
  for (const { dir, remote } of claims) {
    if (!remote) continue; // the heartbeat gather already reports this one loudly
    try {
      const body = windowTranscript(dir, remote, { home, now, caches, leases });
      if (body) envelopes.push(envelope(settings.machineId, "transcript", body, now()));
    } catch (e) {
      report(`fleet-publisher: transcript failed for ${dir}: ${e}`);
    }
  }
  return envelopes;
};

// The daemon's own source: one cache map held across ticks, so each tick reads
// only the bytes that arrived since the last one.
export const createTranscriptSource = (leases) => {
  const caches = new Map();
  return (settings, deps = {}) => gatherTranscripts(settings, { ...deps, leases, caches });
};

// ---------- the drive (`--once --fixture-window --subscribe`) ----------

// What the recorded window does while somebody watches it. Deliberately turns
// the fixture does NOT already carry: the material written before the lease is
// the material this stream must never send, so reusing it would hide the bug it
// is meant to catch. Between them they state every kind the flow branches on
// that a machine can honestly produce — a spawn and its end, an edit of a test
// file, the session's typed suite verdict and the PR it opened, and the CLI's
// own end-of-session record.
const fixtureLiveRecords = (startedAt) => {
  const at = (seconds) => new Date(Date.parse(startedAt) + seconds * 1000).toISOString();
  const turn = (seconds, name, input) => ({
    type: "assistant",
    timestamp: at(seconds),
    message: { content: [{ type: "tool_use", name, input }] },
  });
  return [
    { type: "system", subtype: "task_started", task_id: "sp-1", task_type: "local_bash", description: "Run the driver suite" },
    turn(104, "Edit", { file_path: "factory/driver/test/fleet-transcript.test.mjs" }),
    { type: "system", subtype: "task_notification", task_id: "sp-1", status: "completed", summary: "Run the driver suite" },
    turn(112, "Bash", { command: "git commit -m 'T-058'", description: "Commit the stream" }),
    turn(118, "mcp__factory__report_status", {
      status: "review",
      summary: "the stream is green",
      pr: "https://github.com/MJTeixeira/fixture-window/pull/1",
      suiteVerdict: "pass",
    }),
    { type: "result", subtype: "success", total_cost_usd: 1.25 },
  ];
};

// The whole flow in three steps, against a real fixture window on disk: a
// viewer opens the window (the lease), the stream takes its position from the
// END of what is already there, and only what arrives afterwards travels. Two
// gathers rather than one is the point — a drive that gathered once could not
// tell a stream that starts from now from one that replays.
export const driveSubscription = (settings, fixture, at = Date.now()) => {
  const leases = createLeases();
  const deps = { home: fixture.home, now: () => at, caches: new Map(), leases, claims: [fixture.claim] };
  leases.grant(
    { project: normalizeProjectIdentity(fixture.claim.remote), window: fixture.windowId, leaseSeconds: 90 },
    at,
  );
  gatherTranscripts(settings, deps); // the subscription: position taken, nothing sent
  fixture.appendTurns(fixtureLiveRecords(fixture.startedAt));
  return gatherTranscripts(settings, deps);
};
