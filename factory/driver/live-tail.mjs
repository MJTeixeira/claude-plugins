// Dashboard liveness primitives (spec factory/specs/dashboard-liveness.md):
// incremental file tailing, session-transcript digestion, and driver-phase
// derivation. Pure functions over caches the CALLER owns — no timers, no
// globals, stdlib only — so the dashboard's background refresher composes
// them and tests exercise them directly.
import * as fs from "node:fs";

// Read bytes appended since cache.offset. A file smaller than the stored
// offset was truncated or rotated: reset and read from the start — stale
// offsets must never silently mute the tail. Missing/unreadable files are a
// normal dashboard condition (window not started yet), never a throw.
export const tailFile = (file, cache) => {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    cache.offset = 0;
    return "";
  }
  if (cache.offset === undefined || size < cache.offset) cache.offset = 0;
  if (size === cache.offset) return "";
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(size - cache.offset);
    const read = fs.readSync(fd, buf, 0, buf.length, cache.offset);
    cache.offset += read;
    return buf.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
};

// One tool_use block, one human-scannable line. Preference order mirrors what
// a reader wants to know: the tool's own description, else the file it
// touched, else the command head.
const summarizeBlock = (block) => {
  if (block.type === "tool_use") {
    const input = block.input ?? {};
    const arg = input.description ?? input.file_path ?? (typeof input.command === "string" ? input.command.slice(0, 60) : "");
    return `${block.name}${arg ? ` — ${arg}` : ""}`;
  }
  if (block.type === "text" && typeof block.text === "string") return block.text.slice(0, 80);
  return null;
};

// Digest a chunk of session-transcript jsonl into the caller's cache:
// { buf, turns, lastEvent, lastEventAt, parseErrors }. The chunk boundary is
// byte-oriented (tailFile), so the last line may be partial — it waits in
// cache.buf for its remainder. A corrupt line is someone else's bug the
// dashboard must survive: skip, count, keep going.
export const parseSessionEvents = (chunk, cache) => {
  cache.buf = (cache.buf ?? "") + chunk;
  cache.turns = cache.turns ?? 0;
  cache.parseErrors = cache.parseErrors ?? 0;
  const lines = cache.buf.split("\n");
  cache.buf = lines.pop(); // "" after a complete line, else the partial tail
  for (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      cache.parseErrors += 1;
      continue;
    }
    if (event.type !== "assistant") continue;
    cache.turns += 1;
    const blocks = event.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const summary = summarizeBlock(blocks[i]);
      if (summary) {
        cache.lastEvent = summary;
        cache.lastEventAt = Date.now();
        break;
      }
    }
  }
  return cache;
};

// Which driver component is active NOW, from the daily log's own narration.
// Chronology is log order, so the LAST phase marker wins; a dead lock pid
// overrides everything (REQ-5) — a log's final line outlives the process
// that wrote it.
const PHASES = [
  [/\btriage session starting\b/, () => ({ phase: "triage" })],
  [/\bsession (\d+) starting\b/, (m) => ({ phase: "session", session: Number(m[1]) })],
  [/\bgrader: /, () => ({ phase: "grading" })],
  [/\b(?:merge-gate|sweep): /, () => ({ phase: "sweep" })],
  [/\bprep: /, () => ({ phase: "prep" })],
  // A window-start line is a phase of its own: it outranks every marker the
  // PREVIOUS window left in the same daily log (the 11:30 second-window
  // shape), so a fresh window reads "starting", not yesterday's "session 3".
  [/\bdev window starting\b/, () => ({ phase: "starting" })],
];

export const deriveComponent = (logLines, lockAlive) => {
  if (!lockAlive) return { phase: "idle" };
  for (let i = logLines.length - 1; i >= 0; i--) {
    for (const [re, make] of PHASES) {
      const m = logLines[i].match(re);
      if (m) return make(m);
    }
  }
  return { phase: "starting" };
};
