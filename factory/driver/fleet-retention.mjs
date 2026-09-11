// What a machine still owes the surface (T-058, fleet-control REQ-131).
//
// A window's heartbeats and transcript reach the collector while it runs, but
// the RECORD of that window — its tape — is rebuilt from these same files after
// it ends and uploaded then (T-061). So the material must outlive the window:
// nothing may delete a window's logs until the collector has acked its tape.
//
// Nothing on a machine prunes them today — the driver has no log retention at
// all — and this ledger is deliberately written before that changes rather than
// after. It is the enforcement point: whatever eventually prunes asks
// `mayPruneWindow` first, and a window this machine published but never got an
// ack for answers no.
//
// It lives in the PROJECT's own log dir, beside the window files it is about,
// for the same reason a doctor record does (ADR-0028): the machine-wide registry is
// one file rewritten read-modify-write, and two projects ending a window at the
// same moment would drop one of the two records.
import * as fs from "node:fs";
import * as path from "node:path";
import { readJson, stateDir, writeJsonAtomic } from "./paths.mjs";

const LEDGER = "fleet-tapes.json";

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
export const retainedWindows = (dir, home) => Object.keys(read(dir, home)).sort();

// The guard. A window this machine never published owes nothing and is
// prunable — the ledger answers for what it recorded, and never claims to be a
// list of every window that ever ran.
export const mayPruneWindow = (dir, home, windowId) => !read(dir, home)[windowId];
