// Log retention (T-082) — the one thing on a machine that deletes a factory's
// own files, and the reason ADR-0029's guard was written a task early.
//
// Nothing in the driver had ever pruned `<state>/log/`: measured 2026-08-17, a
// fleet box held 366 MB across 576 dev transcripts, the oldest three months
// back, growing ~8.3 MB/day and never shedding a byte. The existing `prune*`
// functions are all branches and worktrees.
//
// Two rules shape the sweep, and the second outranks the first:
//
//   age      a file older than `logRetentionDays` (default 30) is a candidate.
//
//   the ledger  a window this machine published and never got an ack for keeps
//               every file a rebuild of it would read, whatever its age. The
//               ledger is asked first and its answer is final — `mayPruneWindow`
//               applies no bound of its own, and neither does this. What ends
//               an unpayable debt is the ledger's own thirty days (T-079), not
//               a sweep deciding it has waited long enough.
//
// What may be touched is an ALLOWLIST, never a denylist. `log/` also holds the
// files the driver reads to work — the window lock, the run state, the doctor
// record, the tape ledger, the finalization journal the supervisor replays —
// and the quarantine directories that hold the only copy of somebody's
// uncommitted bytes. A denylist forgets one of those the first time a new kind
// of file lands beside them, and this function's mistakes are not recoverable.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { owedWindows } from "./fleet-retention.mjs";
import { windowMaterial } from "./fleet-tape.mjs";
import { stateDir } from "./paths.mjs";

// The owner's number (ruling 2026-09-11): a configurable window, thirty days
// by default — the same span the tape ledger and the command ledger use.
export const LOG_RETENTION_DAYS = 30;

// A retention window is a positive whole number of days and nothing else is
// one. Each rejected shape is a config typo that would read as "delete more"
// if it were quietly coerced: a string compares as text, zero and negatives
// put the horizon at or past now, a fraction is a day count nobody wrote.
// Malformed fails doctor and turns the sweep OFF, the way a malformed
// `riskTiers` turns the risk floor off rather than guessing a floor.
export const validRetentionDays = (v) => Number.isInteger(v) && v > 0;

// The two shapes a sweep may touch: a session's files, and the driver's own
// dated daily log.
//
// All FOUR prefixes the driver spawns a session under, not just the two a
// window runs: a `report` session and the acceptance `grade` sessions write
// the same kind of transcript under the same stamp, and leaving them out
// would have been a sweep that says "session logs" and means some of them.
// `gate-suite-*.log` is deliberately not here — it is a suite's output, not a
// session's transcript, and nothing in the task asks for it.
const SESSION_FILE = /^(?:dev|triage|report|grade)-\d{4}-\d{2}-\d{2}T[\d-]+Z\./;
const DATED_LOG = /^factory-\d{4}-\d{2}-\d{2}\.log$/;

// A session's four files (`.out`, `.err`, `.mcp.jsonl`, `.mcp-config.json`)
// share one stamp; the stamp carries no dots, so the first one is the
// extension. They age as one, and a held transcript holds its siblings: a
// rebuild reads only the `.out`, but the window's record is all of them.
const stemOf = (name) => (name.includes(".") ? name.slice(0, name.indexOf(".")) : name);

export const pruneLogs = (dir, deps = {}) => {
  const {
    home = os.homedir(),
    at = Date.now(),
    days = LOG_RETENTION_DAYS,
    report = (msg) => process.stderr.write(msg + "\n"),
  } = deps;
  if (!validRetentionDays(days)) {
    report(`logRetentionDays is not a positive whole number of days (${JSON.stringify(days)}) — nothing was pruned`);
    return { files: 0, bytes: 0, off: true };
  }
  const logDir = path.join(stateDir(dir, home), "log");
  let entries;
  try {
    entries = fs.readdirSync(logDir, { withFileTypes: true });
  } catch {
    return { files: 0, bytes: 0 }; // a factory that has not run yet has nothing to sweep
  }

  const held = new Set();
  for (const windowId of owedWindows(dir, home)) {
    for (const file of windowMaterial(dir, windowId, { home, at })) held.add(file);
  }
  const heldStems = new Set([...held].map((file) => stemOf(path.basename(file))));

  const horizon = at - days * 86400_000;
  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!SESSION_FILE.test(entry.name) && !DATED_LOG.test(entry.name)) continue;
    if (heldStems.has(stemOf(entry.name))) continue;
    const full = path.join(logDir, entry.name);
    let size;
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs >= horizon) continue;
      size = stat.size;
    } catch {
      continue; // gone between the read and the stat: somebody else's sweep, not a fault
    }
    try {
      fs.rmSync(full);
    } catch (e) {
      report(`could not remove ${entry.name} — ${e.message}`);
      continue;
    }
    files += 1;
    bytes += size;
  }
  return { files, bytes };
};

// Bytes as an operator reads them, for the one line prep prints.
export const humanBytes = (n) => {
  const units = ["B", "KB", "MB", "GB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
};
