// The window tape (T-061) — the record of a finished window, rebuilt from the
// files the driver already wrote and uploaded once (fleet-control REQ-128..131,
// their ADR-0007 and ADR-0017).
//
// The design's whole point is that **live and replay are one view over one
// tape**: a finished window is not a second screen, and the live view has only
// ever been a replay of what was arriving. That is only true by construction if
// the tape is built by the same derivations the live path uses, from the same
// bytes — which is what this module does, and why nothing here is buffered
// while a window runs.
//
// Rebuilding rather than buffering is also what makes a crash cheap: a
// publisher that died mid-window lost the live view of it and nothing else. The
// window's material is still on disk, the ledger still says the surface has not
// acked it, and the next start rebuilds it.
//
// Two reconstructions, both from the driver's own files:
//
//   the transcript  every session the window's daily log names, read whole and
//                   typed by the same function the live stream types with. The
//                   events land where the lines say they landed, because the
//                   CLI dates them — which is what makes a rebuild reproduce
//                   the live stream rather than re-date it to now.
//
//   the heartbeats  a tick every 20 seconds from the window's start to its last
//                   sign of life, each one derived from the log as it stood at
//                   that moment. A tape with no heartbeats is not a window
//                   (REQ-122 sends none for a run that never happened), so a
//                   window whose log is unreadable produces no tape at all
//                   rather than an empty one.
//
// One field a rebuild cannot reproduce exactly: `lastEvent.ageSeconds`. Live,
// it is measured from the moment this publisher READ the event; here it is the
// distance from the event to the tick, which is the only clock a finished
// window has left. The difference is bounded by the reading tick and shows up
// nowhere the chain is derived from.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HEARTBEAT_TICK_MS, inferActivity, windowStamp } from "./fleet-heartbeat.mjs";
import { ackWindow, retainWindow, retainedWindows } from "./fleet-retention.mjs";
import { normalizeProjectIdentity } from "./fleet-snapshot.mjs";
import { transcriptEvents } from "./fleet-transcript.mjs";
import { envelope, heartbeatBody } from "./fleet-wire.mjs";
import { activeTranscript, deriveComponent, summarizeBlock } from "./live-tail.mjs";
import { pidAlive, readJson, stateDir } from "./paths.mjs";

// One chunk's worth of tape bytes. Small enough that a chunk is one ordinary
// message on a connection carrying heartbeats — the reason the tape is chunked
// at all is that a `send()` is atomic and a multi-megabyte one stalls every
// heartbeat behind it (REQ-130) — and large enough that a big window is
// hundreds of messages rather than thousands. The collector's own bounds are
// 8192 chunks and 64 MB assembled; this sits well inside both.
export const CHUNK_BYTES = 256 * 1024;

// The collector's own bounds, restated: past either of them an assembled tape
// stops being a tape and starts being an out-of-memory, and it answers with a
// nack. Checked HERE so a window too big to store is said once and kept, rather
// than rebuilt and pushed at every connection for a refusal that will not
// change.
export const MAX_CHUNKS = 8192;
export const MAX_TAPE_BYTES = 64 * 1024 * 1024;

// How far a rebuild will follow a window before deciding its files are lying to
// it. The driver's own windows are hours; a day of ticks is 4320 heartbeats and
// already generous. The bound exists because the last sign of life is read off
// the files, and a transcript whose mtime is wrong — restored from a backup,
// copied between machines — would otherwise produce a tape of a window that
// never ran that long.
export const MAX_WINDOW_SECONDS = 24 * 3600;

// The window id back into the moment it names. `windowStamp` made it: an ISO
// instant at second precision with its colons dashed. Anything else is not this
// driver's stamp, and a window this side cannot date is one it cannot rebuild.
export const windowStartMs = (windowId) => {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/.exec(windowId ?? "");
  if (!m) return null;
  const at = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
  return Number.isFinite(at) ? at : null;
};

const lineTime = (line) => {
  const at = Date.parse(line.slice(1, line.indexOf("]")));
  return Number.isFinite(at) ? at : null;
};

const WINDOW_START = /\b(dev|triage) window starting\b|\btriage session starting\b/;

// The daily-log lines belonging to ONE window. The driver writes one log per
// day and a window can cross midnight, so the days are read forward from the
// window's own start.
//
// Where this window ENDS is the next window's start line — and telling the two
// apart is the whole difficulty. The window id comes from the lock, which the
// driver claims BEFORE it narrates anything, so this window's own start line
// lands some way after the moment its id names: seconds on a warm machine,
// minutes where prep runs first. Cutting at "a start line a second or more
// after the id" therefore cuts at THIS window's own opening and rebuilds a tape
// of nothing. Counting is what works: the first start line at or after the id
// is this window's, and the second is where somebody else's begins.
const windowLogLines = (logDir, windowStart, at) => {
  const lines = [];
  let starts = 0;
  const lastDay = new Date(at).toISOString().slice(0, 10);
  for (let day = windowStart; ; day += 86400_000) {
    const stamp = new Date(day).toISOString().slice(0, 10);
    const file = path.join(logDir, `factory-${stamp}.log`);
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      // a day with no log is a day the window wrote nothing, never a fault
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const ts = lineTime(line);
      if (ts === null || ts < windowStart) continue;
      if (WINDOW_START.test(line) && ++starts > 1) return lines;
      lines.push({ ts, line });
    }
    if (stamp >= lastDay) return lines;
  }
};

// Every assistant turn in a session transcript, with where it sits in the
// window and the line a reader would have seen — what a heartbeat counts and
// shows. Read from the same bytes the events come from, through the same
// summarizer the dashboard uses, so a rebuilt heartbeat says what the live one
// said.
const sessionTurns = (records, windowStart, fallbackAt) => {
  const turns = [];
  for (const record of records) {
    if (record.type !== "assistant") continue;
    const stated = Date.parse(record.timestamp ?? "");
    const at = Number.isFinite(stated) ? stated : fallbackAt;
    let summary = null;
    const blocks = record.message?.content;
    if (Array.isArray(blocks)) {
      for (let i = blocks.length - 1; i >= 0 && summary === null; i--) summary = summarizeBlock(blocks[i]);
    }
    turns.push({ t: Math.max(0, Math.round((at - windowStart) / 1000)), summary });
  }
  return turns;
};

const readRecords = (file) => {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null; // a transcript the log named and the disk no longer has
  }
  const records = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      /* a corrupt line is someone else's bug this rebuild must survive */
    }
  }
  return records;
};

// The sessions this window ran, in the order its log named them.
const sessionsOf = (lines) => {
  const sessions = [];
  for (const { ts, line } of lines) {
    const m = line.match(/session (\d+) starting(?: \(plan: ([^,)]+)[^)]*\))? — (.+)$/u);
    if (m) sessions.push({ session: Number(m[1]), taskId: m[2] ?? null, file: m[3].trim(), at: ts });
  }
  return sessions;
};

// The two derived streams. Walked once each: the ticks move forward through the
// log lines and the turns rather than re-scanning them, because a long window is
// hundreds of ticks and this runs at the moment a window ends.
const rebuildStreams = (dir, remote, windowId, { home, at }) => {
  const logDir = path.join(stateDir(dir, home), "log");
  const windowStart = windowStartMs(windowId);
  if (windowStart === null) return null;
  const lines = windowLogLines(logDir, windowStart, at);
  if (!lines.length) return null; // no log for this window is no window

  // The live heartbeat sends the lock's own `mode`; by the time a tape is built
  // the lock is gone, so the log's opening line is what is left to read it off.
  // A window whose log never named itself takes the mode from the transcript
  // the driver named after it, and only a window with neither is assumed.
  const opening = lines.find(({ line }) => WINDOW_START.test(line));
  const sessions = sessionsOf(lines);
  const mode =
    opening?.line.match(/\b(dev|triage) window starting\b/)?.[1] ??
    (/triage session starting/.test(opening?.line ?? "") ? "triage" : null) ??
    path.basename(sessions[0]?.file ?? "").match(/^([a-z]+)-/)?.[1] ??
    "dev";
  const transcript = [];
  const turnsByFile = new Map();
  for (const { session, file } of sessions) {
    const records = readRecords(file);
    if (!records) continue;
    let mtime = at;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      /* read a moment ago; the fallback only dates undated records */
    }
    // The tail holds a partial last line back until its remainder arrives —
    // right for a growing file, wrong for one being read whole: a transcript
    // that never got its closing newline would lose its last record, which for
    // a session is the record saying how it ended.
    const text = fs.readFileSync(file, "utf8");
    transcript.push(
      ...transcriptEvents(text.endsWith("\n") ? text : `${text}\n`, {}, { at: mtime, windowStart, session }),
    );
    turnsByFile.set(file, sessionTurns(records, windowStart, mtime));
  }

  // How far the window reached: the last thing anything in it recorded. The
  // wire carries no window-end event, so this is derived — and it is derived
  // from the same two streams the collector dates the stored window from.
  const lastLine = lines[lines.length - 1].ts;
  const lastEvent = transcript.length ? transcript[transcript.length - 1].t : 0;
  const endT = Math.min(
    MAX_WINDOW_SECONDS,
    Math.max(Math.round((lastLine - windowStart) / 1000), lastEvent),
  );

  const heartbeats = [];
  const tick = HEARTBEAT_TICK_MS / 1000;
  const soFar = [];
  let next = 0;
  const seenTurns = new Map(); // file -> how many of its turns this tick has reached
  for (let t = 0; t <= endT; t += tick) {
    while (next < lines.length && lines[next].ts <= windowStart + t * 1000) soFar.push(lines[next++].line);
    // No lines yet is a real tick, not a missing one: the driver claims the
    // lock before it narrates, and a live window beats from that moment with
    // exactly this reading — the phase a log that has said nothing derives.
    const component = deriveComponent(soFar, true);
    const active = activeTranscript(soFar);
    const turns = (active && turnsByFile.get(active.file)) ?? [];
    let count = seenTurns.get(active?.file) ?? 0;
    while (count < turns.length && turns[count].t <= t) count += 1;
    seenTurns.set(active?.file, count);
    const seen = turns.slice(0, count);
    const last = [...seen].reverse().find((turn) => turn.summary);
    heartbeats.push(
      heartbeatBody({
        project: remote,
        windowId,
        mode,
        t,
        session: component.session ?? null,
        taskId: active?.taskId ?? null,
        component: component.phase,
        activity: inferActivity(component.phase, last?.summary),
        turns: seen.length,
        lastEvent: last ? { summary: last.summary, ageSeconds: t - last.t } : null,
      }),
    );
  }
  return heartbeats.length ? { heartbeats, transcript } : null;
};

// One window's whole tape.
//
// The snapshot stream is **empty, deliberately**. REQ-129 is that the tape
// carries what the wire carried and nothing more, and nothing on this machine
// records the snapshots that were sent: they ride send-on-change and are gone
// once sent. Re-deriving one at window end looks like the third stream and is
// not it — its PR states are read AFTER the window, from a forge that has moved
// on, so a replay would show a window state that never travelled. The
// collector reads none of this stream today (its `replayInput` takes the
// heartbeats and the transcript), so an empty one costs nothing and a wrong one
// would cost the invariant. Filling it honestly means journalling each snapshot
// as it is sent, which is a change to the sending half and not to this rebuild.
export const rebuildTape = (dir, remote, windowId, deps = {}) => {
  const { home = os.homedir(), now = Date.now } = deps;
  const streams = rebuildStreams(dir, remote, windowId, { home, at: now() });
  return streams && { ...streams, snapshots: [] };
};

// The tape cut into messages (REQ-130, their ADR-0017): base64 of a slice of
// the tape's UTF-8 BYTES, never a slice of the text — a cut that lands inside a
// multi-byte character has to survive it. The collector compresses on write, so
// what travels is the plain JSON.
export const chunkTape = (tape, { project, window, maxBytes = CHUNK_BYTES }) => {
  const bytes = Buffer.from(JSON.stringify(tape), "utf8");
  const total = Math.max(1, Math.ceil(bytes.length / maxBytes));
  if (bytes.length > MAX_TAPE_BYTES || total > MAX_CHUNKS) return null;
  const chunks = [];
  for (let seq = 0; seq < total; seq++) {
    chunks.push({
      project,
      window,
      seq,
      total,
      data: bytes.subarray(seq * maxBytes, (seq + 1) * maxBytes).toString("base64"),
    });
  }
  return chunks;
};

// A window this machine owes the surface and is no longer running: the ledger
// says it is unacked, and the project's lock either is gone or names a
// different window. A live window is never taped — its tape arrives when it
// ends, which is what makes an acked tape the only thing on this wire that says
// a run is over.
export const finishedWindows = (dir, home) => {
  const lock = readJson(path.join(stateDir(dir, home), "log", "window.lock"));
  const live = lock && pidAlive(lock.pid) ? windowStamp(lock.startedAt) : null;
  return retainedWindows(dir, home).filter((id) => id !== live);
};

// The key a sent tape is remembered by. Window ids are the driver's own start
// stamps, so two projects starting a window in the same second share one — the
// project has to be in the key or one of the two tapes is never sent.
export const tapeKey = (remote, windowId) => `${remote}\u0000${windowId}`;

// Every tape this machine owes, one entry per window: its key and the chunk
// envelopes that carry it. Usually none — a machine sends a tape when a window
// ends and never again, because the ack drops the window from the ledger.
//
// The key travels OUT with the envelopes rather than being marked here,
// because a tape is owed until the socket has actually taken it: marking it
// while the array is still being built loses every remaining chunk of a send
// that throws halfway, and the window then waits for a reconnect to be
// noticed again. The caller marks, for the same reason `sendResults` does.
export const gatherTapes = (settings, deps = {}) => {
  const {
    home = os.homedir(),
    now = Date.now,
    claims,
    sent = new Set(),
    report = (msg) => process.stderr.write(msg + "\n"),
  } = deps;
  const tapes = [];
  for (const { dir, remote } of claims ?? []) {
    if (!remote) continue;
    for (const windowId of finishedWindows(dir, home)) {
      // Checked BEFORE the rebuild, not after it: a tape waiting for an ack is
      // owed for as long as the ack takes, and rebuilding it on every beat
      // would read every one of the window's transcripts whole, every minute,
      // to throw the result away.
      if (sent.has(tapeKey(remote, windowId))) continue;
      try {
        const tape = rebuildTape(dir, remote, windowId, { ...deps, home, now });
        if (!tape) {
          // The window stays owed. Acking it here would be this machine telling
          // itself the surface has the record — which is exactly the lie the
          // ack exists to prevent, and it would unlock the logs that are the
          // only remaining copy. A window whose material is genuinely gone
          // costs a line per beat and nothing else.
          report(`fleet-publisher: window ${windowId} in ${dir} cannot be rebuilt — still owed`);
          continue;
        }
        // The raw remote, like every other body: the far end owns the
        // normalising, here as everywhere else (REQ-111).
        const chunks = chunkTape(tape, { project: remote, window: windowId });
        if (!chunks) {
          report(`fleet-publisher: window ${windowId} in ${dir} is too large to store — still owed`);
          // Nothing to send, and nothing a later beat would send differently:
          // an entry with no envelopes is marked by the caller all the same, so
          // the line is said once per connection rather than once per beat.
          tapes.push({ key: tapeKey(remote, windowId), envelopes: [] });
          continue;
        }
        tapes.push({
          key: tapeKey(remote, windowId),
          envelopes: chunks.map((body) => envelope(settings.machineId, "tape-chunk", body, now())),
        });
      } catch (e) {
        report(`fleet-publisher: tape failed for ${dir} ${windowId}: ${e}`);
      }
    }
  }
  return tapes;
};

// The collector's answer. `ok` is what makes machine-side pruning safe, so only
// an ok ack drops the window from the ledger: a rejected tape stays owed, and
// its logs stay with it.
export const applyTapeAck = (body, deps = {}) => {
  const { home = os.homedir(), claims, report = () => {} } = deps;
  const { project, window, ok, reason } = body ?? {};
  if (typeof project !== "string" || typeof window !== "string") return false;
  // The ack names the project the way the collector names one: by the identity
  // it normalised on receipt, never the raw remote this side sent. Normalising
  // it again would yield nothing — an identity is not a remote URL.
  const found = (claims ?? []).find((c) => normalizeProjectIdentity(c.remote) === project);
  if (!found) return false;
  if (ok !== true) {
    report(`fleet-publisher: tape for ${window} was refused (${reason ?? "no reason given"}) — still owed`);
    return false;
  }
  ackWindow(found.dir, home, window);
  return true;
};

// ---------- the drive (`--once --offline --fixture-window --tape`) ----------
//
// A recorded window that has ENDED. Two things separate a run in flight from a
// run whose tape is owed, and the drive does both by hand because on a real
// machine the daemon does them for it: the lock goes (the driver removes it
// when the window ends) and the ledger holds the window (the daemon wrote it
// down when it sent the first heartbeat for it).
export const driveTape = (settings, fixture, at = Date.now()) => {
  const { dir } = fixture.claim;
  retainWindow(dir, fixture.home, fixture.windowId, at);
  fs.rmSync(path.join(stateDir(dir, fixture.home), "log", "window.lock"), { force: true });
  return gatherTapes(settings, { home: fixture.home, now: () => at, claims: [fixture.claim] })
    .flatMap((t) => t.envelopes);
};
