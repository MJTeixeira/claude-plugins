// What a machine still owes the surface (T-058, fleet-control REQ-131).
//
// A window's heartbeats and transcript reach the collector while it runs, but
// the RECORD of that window — its tape — is rebuilt from these same files after
// it ends and uploaded then (T-061). So the material must outlive the window:
// nothing may delete a window's logs until the collector has acked its tape.
//
// This ledger was deliberately written before anything pruned them rather than
// after, and `log-retention.mjs` is now the pruner it was written for. It reads
// `owedWindows` — the same private read `mayPruneWindow` answers from, so the
// two can never disagree — and holds every file a rebuild of an owed window
// would touch, whatever its age.
//
// It lives in the PROJECT's own log dir, beside the window files it is about,
// for the same reason a doctor record does (ADR-0028): the machine-wide registry is
// one file rewritten read-modify-write, and two projects ending a window at the
// same moment would drop one of the two records.
import * as fs from "node:fs";
import * as path from "node:path";
import { readJson, stateDir, writeJsonAtomic } from "./paths.mjs";

const LEDGER = "fleet-tapes.json";

// How long a window stays owed before the ledger lets it go (T-079). Thirty
// days, the same number the command ledger prunes its in-flight records at.
//
// Without a bound the ledger only grows: a window whose material is gone can
// never be rebuilt, is never acked, and is therefore owed forever — one entry
// and one log line per beat for the life of the machine, for a debt nothing
// can ever pay. Letting it go is the ONLY way out that is not a lie: acking it
// here would be this machine telling itself the surface has the record.
//
// The cost is stated plainly where it happens — the window's record is lost,
// and the surface never got it. That is why the bound is generous: thirty days
// is long past any collector outage this fleet has had.
export const RETAIN_DAYS = 30;

// Every entry point takes the checkout and the home it is registered under, so
// where the ledger lives is this module's business and nobody else's.
const ledgerDir = (dir, home) => path.join(stateDir(dir, home), "log");
const ledgerPath = (dir, home) => path.join(ledgerDir(dir, home), LEDGER);

const read = (dir, home) => {
  const value = readJson(ledgerPath(dir, home));
  return value && typeof value.windows === "object" && value.windows !== null ? value.windows : {};
};

const write = (dir, home, windows) => {
  fs.mkdirSync(ledgerDir(dir, home), { recursive: true });
  writeJsonAtomic(ledgerPath(dir, home), { windows });
};

// Drop every window owed past the bound. An entry whose `seenAt` is not a
// number is dropped too: it is a record nothing can age, so keeping it would
// be keeping it forever — the exact leak the bound exists to close.
const expired = (windows, at) => {
  const horizon = at - RETAIN_DAYS * 86400_000;
  return Object.entries(windows)
    .filter(([, rec]) => !Number.isFinite(rec?.seenAt) || rec.seenAt < horizon)
    .map(([id]) => id);
};

// This machine has PUBLISHED the window; the surface has not acked its tape.
// Called from the daemon's own beat rather than from the gather, so a dry run
// that sends nothing owes nothing — a machine only owes a tape for a window it
// actually told the surface about. Recording is idempotent: the beat calls it
// on every tick of a live window, and the first sighting is the one that dates
// it.
export const retainWindow = (dir, home, windowId, at = Date.now()) => {
  if (typeof windowId !== "string" || windowId === "") return;
  const windows = read(dir, home);
  if (windows[windowId]) return;
  windows[windowId] = { seenAt: at };
  write(dir, home, windows);
};

// The collector acked this window's tape (T-061 owns the call). The record is
// dropped rather than flagged: a ledger of everything a machine ever ran is a
// second window index nobody asked for, and its only question is "is anything
// still owed".
export const ackWindow = (dir, home, windowId) => {
  const windows = read(dir, home);
  if (!windows[windowId]) return false;
  delete windows[windowId];
  write(dir, home, windows);
  return true;
};

// Every window whose material this machine still owes the surface.
//
// This is also where the bound is applied — the sweep runs from the read the
// gather already does, so it needs no timer and no second caller to remember
// it. A window it lets go is said once, at the moment the ledger forgets it,
// because after that there is nothing left to say it about.
export const retainedWindows = (dir, home, deps = {}) => {
  const { at = Date.now(), report = () => {} } = deps;
  const windows = read(dir, home);
  const gone = expired(windows, at);
  if (gone.length) {
    for (const id of gone) delete windows[id];
    write(dir, home, windows);
    for (const id of gone) {
      report(
        `fleet-publisher: window ${id} in ${dir} was owed for more than ${RETAIN_DAYS} days — ` +
          "dropped from the ledger, its record is lost",
      );
    }
  }
  return Object.keys(windows).sort();
};

// Every window the ledger still holds, aged by nothing. The sweep belongs to
// the publisher's own read above: a second sweeper would let a window go — and
// say its record is lost — from a place where nothing about the wire is
// running, and the loss is the publisher's to report or nobody's.
export const owedWindows = (dir, home) => Object.keys(read(dir, home)).sort();

// The guard. A window this machine never published owes nothing and is
// prunable — the ledger answers for what it recorded, and never claims to be a
// list of every window that ever ran. It applies no bound of its own: a window
// is prunable because the ledger let it go, never because the caller decided it
// had waited long enough.
export const mayPruneWindow = (dir, home, windowId) => !read(dir, home)[windowId];
