// Project snapshot derivation (T-053) — one full snapshot per claimed
// project, read from the CHECKOUT ROOT's .factory (REQ-116: the surface
// shows the backlog the owner has), with the driver's meta-worktree
// divergence carried as its own field so the driver acting on something
// else stays visible (REQ-117).
//
// Identity is the normalised forge remote URL, origin over any other remote
// (REQ-111); a project with no usable remote fails LOUDLY and never falls
// back to its directory name (REQ-112). The backlog is parsed by importing
// the driver's own backlog-index library — never a second markdown parser.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { epicKey, parseBacklogTasks, parseMilestones } from "./backlog-index.mjs";
import { envelope, snapshotBody as wireBody } from "./fleet-wire.mjs";
import { execGit, factoryKey, readJson, stateDir } from "./paths.mjs";

// Publisher-side copy of the collector's normaliser (fleet-control
// src/identity.mjs, pin a664b4f) — the reading half. The two MUST agree
// byte-for-byte: a remote this side accepts that the collector rejects is a
// snapshot dropped silently, and any other disagreement forks one project
// into two rows. Change only in lockstep with fleet-control.
const SCP_LIKE = /^(?:[\w.-]+@)?([\w.-]+):(.+)$/;
const URL_LIKE = /^(?:git|ssh|https?):\/\/(?:[^@/]+@)?([^/]+?)(?::\d+)?\/(.+)$/;

export const normalizeProjectIdentity = (remote) => {
  if (typeof remote !== "string") return null;
  const value = remote.trim();
  if (value === "") return null;

  const urlMatch = value.match(URL_LIKE);
  const scpMatch = !urlMatch && value.match(SCP_LIKE);
  const match = urlMatch ?? scpMatch;
  if (!match) return null;

  const [, host, rawPath] = match;
  // (`repoPath` where the collector says `path` — its file has no module
  // import to shadow; the logic is identical.)
  const repoPath = rawPath.replace(/\.git$/, "").replace(/\/+$/, "");
  if (!host || !repoPath) return null;

  return `${host.toLowerCase()}/${repoPath}`;
};

// The remote a project claims its identity from: `origin` over any other
// remote (REQ-111); with no origin, the first other remote by name, so the
// choice is deterministic across gathers. Null — no remote, or not a repo —
// is the caller's loud path (REQ-112), never a directory-name fallback.
// One spawn on the origin hit, the common case on this fleet; the claim
// read rides every 60s beat, so the spawn count stays where T-052 left it.
export const projectRemote = (dir) => {
  try {
    return execGit(dir, ["config", "--get", "remote.origin.url"], { timeoutMs: 10_000 }) || null;
  } catch {
    // No origin — fall through to the other remotes.
  }
  try {
    const names = execGit(dir, ["remote"], { timeoutMs: 10_000 });
    for (const name of names.split("\n").filter(Boolean).sort()) {
      const url = execGit(dir, ["config", "--get", `remote.${name}.url`], { timeoutMs: 10_000 });
      if (url) return url;
    }
  } catch {
    // Not a repo, or git failed: unidentified, not a crash.
  }
  return null;
};

// A project's claim-worthy remote: identified, or null. The collector
// filters unnormalisable claims silently, so a remote WE accept that IT
// rejects would claim a row no snapshot can fill — both ends of the wire
// judge with the same normaliser.
export const claimRemote = (dir) => {
  const remote = projectRemote(dir);
  return remote && normalizeProjectIdentity(remote) !== null ? remote : null;
};

// Every registered checkout with the remote it claims — ONE read shared by
// the inventory's claim list and the snapshots' identities (via deps.claims
// in both gathers), because a claim set that disagrees with a snapshot's
// remote turns the next inventory into a delete signal for the row that
// snapshot just filled. A project with no usable remote is reported LOUDLY
// through `report` and claims nothing (REQ-112) — never a directory name.
export const claimedProjects = (home, report = () => {}) => {
  const reg = readJson(path.join(home, ".factory", "registry.json"));
  const claims = [];
  for (const dir of Object.keys(reg?.factories ?? {}).sort()) {
    const remote = claimRemote(dir);
    if (remote) claims.push({ dir, remote });
    else report(`fleet-publisher: claimed project cannot be identified (no usable remote): ${dir}`);
  }
  return claims;
};

// One task on the wire: the typed fields a detail view can render, minus
// the two prose fields REQ-118 names — acceptance criteria and the verify
// line were a measured 3.4× payload multiplier for text the board never
// shows. Absent-capable like every wire field: an empty optional is
// omitted, never sent as null.
const wireTask = (t) => ({
  id: t.id,
  title: t.title,
  status: t.status,
  epic: t.epic,
  ...(t.gate ? { gate: t.gate } : {}),
  ...(t.model ? { model: t.model } : {}),
  ...(t.effort ? { effort: t.effort } : {}),
  ...(t.deps.length ? { deps: t.deps } : {}),
  ...(t.question ? { question: t.question } : {}),
});

// One milestone on the wire: its eligibility (the status `promote` acts on)
// plus done/total counted over its epics' tasks, which is what the board's
// milestone meter renders.
const wireMilestone = (m, tasks) => {
  const mine = tasks.filter((t) => m.epics.some((e) => epicKey(e.file) === t.epic));
  return {
    id: m.id,
    title: m.title,
    ...(m.status ? { status: m.status } : {}),
    done: mine.filter((t) => t.status === "done").length,
    total: mine.length,
  };
};

// The checkout root's backlog (REQ-116 — the one the owner has, never the
// meta worktree's). Three outcomes, and the middle one matters: a missing
// backlog dir is a real empty backlog {[], []}; one that exists but cannot
// be read is {null, null} — the collector renders null as `not published`,
// and "this publisher could not read it" must never render as "there is
// nothing to do".
const readBacklog = (dir) => {
  const backlogDir = path.join(dir, ".factory", "backlog");
  if (!fs.existsSync(backlogDir)) return { tasks: [], milestones: [] };
  try {
    const tasks = parseBacklogTasks(backlogDir);
    let indexText = "";
    try { indexText = fs.readFileSync(path.join(backlogDir, "index.md"), "utf8"); }
    catch { /* no index: milestones are simply none */ }
    return { tasks, milestones: parseMilestones(indexText) };
  } catch {
    return { tasks: null, milestones: null };
  }
};

// The stop hold, read from the STOP file's OWN contents — a convention this
// publisher owns on both ends (T-059 writes {placedBy, at}; the driver only
// ever checks that the file exists). A hand-placed hold — empty, or any
// non-JSON content — is still a real hold: it carries its age from the
// file's mtime and no placer. An unstattable file is no reading at all.
const readStopHeld = (dir, home, now) => {
  const stopFile = path.join(stateDir(dir, home), "STOP");
  let st;
  try { st = fs.statSync(stopFile); } catch { return null; }
  const rec = readJson(stopFile);
  const at = Date.parse(rec?.at ?? "");
  const since = Number.isFinite(at) ? at : st.mtimeMs;
  return {
    heldSeconds: Math.max(0, Math.round((now - since) / 1000)),
    ...(typeof rec?.placedBy === "string" && rec.placedBy ? { by: rec.placedBy } : {}),
  };
};

// Meta divergence (REQ-117; wire shape ruled by fleet-control 2026-09-02,
// their ADR-0012 amendment): the driver's meta worktree against the
// checkout the owner is looking at, BOTH directions as non-negative counts
// — a signed net was rejected because it reports agreement in whichever
// direction it drops — plus the driver copy's own age from its HEAD's
// commit date (the age of the THING; a receipt cannot recover it, since a
// copy 14 days stale is 14 days stale the instant it is measured). Zero-zero
// is KNOWN agreement and travels; no meta worktree (or an unmeasurable
// pair) is unknown and stays absent — unknown must never render as
// agreement.
const metaDivergence = (dir, home, now) => {
  try {
    const meta = path.join(home, ".factory", "worktrees", factoryKey(dir), "meta");
    if (!fs.existsSync(meta)) return null;
    // Sha and commit date in one spawn; the counting then runs in the
    // checkout — worktrees share one object store.
    const [metaSha, committedAtRaw] = execGit(meta, ["show", "-s", "--format=%H %ct", "HEAD"], { timeoutMs: 10_000 }).split(/\s+/);
    const counts = execGit(dir, ["rev-list", "--left-right", "--count", `${metaSha}...HEAD`], { timeoutMs: 10_000 });
    const [ahead, behind] = counts.split(/\s+/).map(Number);
    if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null;
    const committedAt = Number(committedAtRaw);
    return {
      behind,
      ahead,
      ...(Number.isFinite(committedAt)
        ? { copyAgeSeconds: Math.max(0, Math.round(now / 1000 - committedAt)) }
        : {}),
    };
  } catch {
    return null;
  }
};

// One project's snapshot body — always the full snapshot (REQ-115). This
// module derives the facts; the SHAPE lives in fleet-wire.mjs with every
// other envelope body. An autonomy the config does not carry is absent, not
// defaulted: buildConfig always writes one and migrate heals it, so a
// config without it is one this publisher failed to read — never a guess.
export const snapshotBody = (dir, remote, home, now) => {
  const cfg = readJson(path.join(stateDir(dir, home), "config.json"));
  const { tasks, milestones } = readBacklog(dir);
  return wireBody({
    remote,
    enabled: cfg?.enabled !== false, // the driver's own default: enabled
    autonomy: typeof cfg?.autonomy === "string" ? cfg.autonomy : null,
    milestones: milestones && milestones.map((m) => wireMilestone(m, tasks ?? [])),
    tasks: tasks && tasks.map(wireTask),
    stopHeld: readStopHeld(dir, home, now),
    metaDivergence: metaDivergence(dir, home, now),
  });
};

// Every claimed project's snapshot (fresh-connection set, REQ-132), each
// derived independently: one project's unreadable state never suppresses
// another's snapshot (REQ-115). `deps.claims` shares one identity read with
// the inventory (gatherAll passes it); left alone, this gather reads — and
// reports the unidentifiable — itself.
export const gatherSnapshots = async (settings, deps = {}) => {
  const {
    home = os.homedir(),
    now = Date.now,
    report = (msg) => process.stderr.write(msg + "\n"),
  } = deps;
  const claims = deps.claims ?? claimedProjects(home, report);
  const envelopes = [];
  for (const { dir, remote } of claims) {
    try {
      envelopes.push(envelope(settings.machineId, "snapshot", snapshotBody(dir, remote, home, now()), now()));
    } catch (e) {
      report(`fleet-publisher: snapshot failed for ${dir}: ${e}`);
    }
  }
  return envelopes;
};
