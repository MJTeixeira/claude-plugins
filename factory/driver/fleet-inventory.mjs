// The machine inventory (T-052) — everything a machine says about itself,
// gathered here and only here (fleet-control D-011 (4): one publisher, one
// code path, every machine alike — nothing shells out to a box's own admin
// tooling). Host facts come from Node built-ins and the driver's own state
// files; project claims come from each registered checkout's origin remote.
//
// The collector renders every number here dim, dated and unjudged and will
// never threshold them (ADR-0006/0014) — so nothing in this module judges a
// number either. A fact this machine cannot determine is ABSENT from the
// block, never zero and never a guess: the collector's parseHost drops
// half-shaped fields silently, and a zero where a fact is missing renders
// as a real reading of zero.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readJson, stateDir } from "./paths.mjs";
import { claimRemote, normalizeProjectIdentity } from "./fleet-snapshot.mjs";
import { envelope, inventoryBody } from "./fleet-wire.mjs";

// The forge host of a remote URL — the first segment of a project identity
// (collector ADR-0014: `id` is the host, `github.com`, so reachability can
// be joined to the projects that live there). Derived FROM the identity so
// the join can never fork: a private parser here once kept an scp host's
// case while the identity folded it, and `GITHUB.COM — reachable` joins to
// no project on the board.
export const forgeHostOf = (remote) => {
  const id = normalizeProjectIdentity(remote);
  return id ? id.slice(0, id.indexOf("/")) : null;
};

// One forge probe, spawn-free (built-in fetch): reachable means the host
// answered HTTPS at all — any status counts, because a 4xx from a live
// forge is still a live forge. HTTPS is the deliberate definition of
// reachable here: it is the transport the forge CLIs (and so the merge
// verb, T-060) actually ride.
const PROBE_TIMEOUT_MS = 5000;
export const probeForge = async (host) => {
  try {
    await fetch(`https://${host}/`, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return true;
  } catch {
    return false;
  }
};

// The doctor fold, REQ-39a verbatim: one record per registered project
// (null where none is persisted), folded to the machine's single verdict.
// Worst wins because the row answers "can this host work"; the OLDEST
// reading dates the fold so it can never claim to be fresher than its
// stalest input; a project with no record demotes the fold to `unchecked`
// instead of being skipped, because four passing projects must not render
// as a healthy machine while a fifth has never been looked at. With no
// readings at all the fold is null — the field stays absent and the surface
// renders `never checked`, which today (pre-T-064, nothing persists a
// verdict) is every machine's correct output.
// Rank order for worst-of. The driver's doctor speaks ok|warn|fail (and
// the grader lane pass|fail), so both healthy spellings rank best; an
// unlisted verdict ranks WORST — an unknown verdict is never health, and
// it is emitted as itself rather than mapped onto a known value.
const DOCTOR_RANK = { pass: 3, ok: 3, warn: 2, unchecked: 1 };
export const foldDoctor = (records) => {
  const readings = records.filter(Boolean);
  if (readings.length === 0) return null;
  const candidates = records.map((r) => r ?? { verdict: "unchecked" });
  const worst = candidates.reduce((a, b) =>
    (DOCTOR_RANK[b.verdict] ?? 0) < (DOCTOR_RANK[a.verdict] ?? 0) ? b : a
  );
  const fails = readings.map((r) => r.fails).filter(Boolean).join("; ");
  return {
    verdict: worst.verdict,
    ageSeconds: Math.max(...readings.map((r) => r.ageSeconds)),
    ...(fails ? { fails } : {}),
  };
};

// A timestamp persisted on THIS machine, aged on this machine's clock —
// the one place a subtraction is safe (REQ-123): same machine, same
// clock, and only the duration travels. Unparseable reads as null.
const secondsSince = (iso, now) => {
  const at = Date.parse(iso ?? "");
  return Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 1000)) : null;
};

// One project's persisted doctor record (written by T-064 as
// <stateDir>/doctor.json: { verdict, at, fails? }). A record that cannot
// be aged is no record — it must demote the fold, not date it.
const readDoctorRecord = (sd, now) => {
  const rec = readJson(path.join(sd, "doctor.json"));
  if (!rec || typeof rec.verdict !== "string" || !rec.verdict) return null;
  const ageSeconds = secondsSince(rec.at, now);
  if (ageSeconds === null) return null;
  return {
    verdict: rec.verdict,
    ageSeconds,
    ...(typeof rec.fails === "string" && rec.fails ? { fails: rec.fails } : {}),
  };
};

// The deployed runtime, read from the receipt deploy-runtime.mjs writes.
const readRuntime = (home, now) => {
  const rec = readJson(path.join(home, ".factory", "runtime-deploy.json"));
  if (!rec || typeof rec.to !== "string" || !rec.to) return null;
  const deployedSecondsAgo = secondsSince(rec.ts, now);
  if (deployedSecondsAgo === null) return null;
  return { sha: rec.to, deployedSecondsAgo };
};

// df's convention — used / (used + available), reserved blocks excluded —
// so the numbers match what the box's own df would say rather than running
// ~5% high on it. One statfs read feeds both the percentage and the
// absolute bytes (T-065), so they can never tell two stories.
const diskFacts = (home) => {
  try {
    const f = fs.statfsSync(home);
    const used = f.blocks - f.bfree;
    if (used + f.bavail <= 0) return { diskUsedPercent: null, diskBytes: null };
    return {
      diskUsedPercent: Math.round((used / (used + f.bavail)) * 100),
      diskBytes: { total: (used + f.bavail) * f.bsize, used: used * f.bsize },
    };
  } catch {
    return { diskUsedPercent: null, diskBytes: null };
  }
};

// The whole inventory envelope: sent every 60 seconds unconditionally and
// once on every fresh connection (REQ-120) — the delete signal and the
// liveness beat ride the same message. Reconstructed from disk on every
// call, the same stance the supervisor takes: no cache to go stale.
// `settings.offline` gathers without opening any socket, so the probe is
// skipped and `forges` stays absent — unknown reachability is not
// unreachable (ADR-0014), so absence withdraws nothing.
export const gatherInventory = async (settings, deps = {}) => {
  const { home = os.homedir(), now = Date.now, probe = probeForge } = deps;
  // `deps.claims` shares gatherAll's one identity read per project per beat;
  // alone, this gather reads identities itself (quietly — the loud
  // unidentifiable-project report is the snapshot gather's).
  const claimByDir = deps.claims && new Map(deps.claims.map((c) => [c.dir, c.remote]));
  const regPath = path.join(home, ".factory", "registry.json");
  const reg = readJson(regPath);
  // A missing registry is a machine with nothing registered — a real zero.
  // A file that exists but does not parse is one this process cannot read:
  // its counts are then absent, not zero. (Its claims still go out empty —
  // the wire has no "unknown claims" value — but registry writes are
  // atomic, so a torn file is not a state this fleet produces.)
  const registryReadable = reg !== null || !fs.existsSync(regPath);
  const projectPaths = Object.keys(reg?.factories ?? {}).sort();

  const projects = [];
  let enabled = 0;
  const doctorRecords = [];
  for (const project of projectPaths) {
    const sd = stateDir(project, home);
    if (readJson(path.join(sd, "config.json"))?.enabled !== false) enabled += 1;
    doctorRecords.push(readDoctorRecord(sd, now()));
    // The claim rides the SAME read the snapshot's identity rides
    // (fleet-snapshot.mjs, origin over any other remote): a claim set that
    // disagrees with a snapshot's remote turns the next inventory into a
    // delete signal for the row that snapshot just filled (REQ-120's sweep).
    // An unidentifiable project is still installed but claims nothing.
    const remote = claimByDir ? claimByDir.get(project) ?? null : claimRemote(project);
    if (remote) projects.push(remote);
  }

  let forges = null;
  if (!settings.offline) {
    const hosts = [...new Set(projects.map(forgeHostOf).filter(Boolean))].sort();
    forges = await Promise.all(
      hosts.map(async (id) => ({ id, reachable: await probe(id) }))
    );
  }

  // T-065: what the machine IS, beside how full it is — absolute readings,
  // unjudged, from the same Node built-ins as every other host fact (D-011
  // (4)). Each is absent when the platform cannot state it: an empty
  // os.cpus() drops model and count, and Windows' loadavg is a hardwired
  // zero — a guess, so it does not travel.
  const cpus = os.cpus();
  const host = {
    factories: registryReadable ? { installed: projectPaths.length, enabled } : null,
    ...diskFacts(home),
    memoryUsedPercent: Math.round((1 - os.freemem() / os.totalmem()) * 100),
    memoryBytes: { total: os.totalmem(), used: os.totalmem() - os.freemem() },
    uptimeSeconds: Math.round(os.uptime()),
    model: cpus[0]?.model?.trim() || null,
    cpus: cpus.length || null,
    os: `${os.type()} ${os.release()}`,
    loadAvg: os.platform() === "win32" ? null : os.loadavg().map((n) => Math.round(n * 100) / 100),
    // The one configured fact: the machine's one-line description, from the
    // same env home as the machine id (FLEET_MACHINE_ROLE) — absent rather
    // than invented when unset.
    role: typeof settings.role === "string" && settings.role ? settings.role : null,
    runtime: readRuntime(home, now()),
    forges,
    doctor: foldDoctor(doctorRecords),
  };
  return envelope(settings.machineId, "inventory", inventoryBody(projects, host), now());
};
