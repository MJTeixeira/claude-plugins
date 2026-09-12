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
//
// T-055 put the VERDICTS here too (fleet-control ADR-0003 — the publisher
// interprets, the collector renders): each parked task's park folded to the
// contract's four values, and the PR the task produced with the state read
// through the driver's own forge client, its own age and its forge. Both are
// read from the task's runtime record in `state.json`, which is where the
// driver writes them; the backlog block carries neither. T-080 added the
// third of them on the same seam — the tracker thread a question park was
// filed on — and the argument for it is at `taskThread`.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { epicKey, parseBacklogTasks, parseMilestones } from "./backlog-index.mjs";
import { envelope, snapshotBody as wireBody } from "./fleet-wire.mjs";
import { createForge } from "./forge.mjs";
import { execGit, factoryKey, readEnvFile, readJson, stateDir } from "./paths.mjs";

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

// ---------- the verdicts (T-055, fleet-control ADR-0003) ----------
//
// The publisher interprets; the collector renders. Everything below turns a
// driver-side fact into the named value the contract carries, so that when a
// row is wrong there is exactly one place to look.

// The park fold: the driver's five recorded park reasons (the writers below in
// factory.mjs are their home; widened by T-054) onto the contract's four task
// parks (ADR-0005). The two breakers are one park to the owner — nothing is formally
// asked of them either way — and a session's own `blocked` park is a question
// park, because what clears it is the owner answering the thread the session
// filed. A value this table does not name travels AS ITSELF (REQ-30): the
// collector renders an unrecognised park as unrecognised, and mapping it onto
// a known verb would be the quiet lie that rule exists to stop.
const PARKS = {
  risk: "risk",
  question: "question",
  blocked: "question",
  "grade-breaker": "breaker",
  "no-progress-breaker": "breaker",
};

// One task's park, or null for none. Only a task the backlog says is parked
// carries one: `parkedBy` is deliberately preserved across session reports,
// so a re-opened task keeps its old marker, and the collector reads the field
// only at `needs-human` anyway. The GATE park is the one the driver never
// records — it is derived at check time from the task block's own `Gate:`
// field and writing it would invent a driver state (T-054) — so it is derived
// here instead, which is where derivation belongs. A park with neither is
// unrecorded: absent, never a guessed verb (REQ-12).
const taskPark = (task, rec) => {
  if (task.status !== "needs-human") return null;
  const recorded = rec?.parkedBy;
  if (typeof recorded === "string" && recorded) return PARKS[recorded] ?? recorded;
  return task.gate === "human" ? "gate" : null;
};

// The thread a question park travels with (T-080) — fleet-control's ask *A
// question park must carry the thread it filed*, so its `answer` verb has
// somewhere to send the owner instead of a claim they have to go and find.
// The driver already keeps it: `state.json`'s `questionThreads` is a
// taskId → url map, written when the thread is opened. Read here rather than
// asked of the driver — the same seam T-055 used for the PR number, and it
// leaves the driver's state shape untouched.
//
// Only a `question` park carries one, and it is the FOLDED park that decides:
// a session's own `blocked` park is a question park, and its thread is what
// the owner answers. Only a value that is actually a link travels — the map
// holds whatever a tracker's create call returned, and a surface that laid a
// non-URL into a link would be worse than one with nowhere to send the owner
// (the stance `prNumberFromUrl` takes on `#NaN`, for the same reason). This
// rule is the collector's own, byte for byte: `threadUrl` in its
// `src/actions.mjs` drops anything that is not an https string, and both ends
// judging alike is what ADR-0005 is about.
//
// Not the task's own `question` field, which carries the `- Question: <url>`
// line the driver writes into the BACKLOG BLOCK for the same thread. Two
// things separate them: that line goes into the driver's meta worktree, so it
// reaches the checkout this snapshot reads (REQ-116) only once the backlog
// change merges, and it is written once and never removed, so it outlives the
// park it names. The map is machine state and readable at once. It is *not*
// pruned on the answer, though — `processQuestions` drops dead threads only on
// its next successful filing pass, and returns early when nothing is being
// asked — so a thread the owner closed can still travel for a while. That is
// a staleness the far end already survives: the url is a link to a closed
// thread, never a claim that anything is open.
const taskThread = (park, recorded) =>
  park === "question" && typeof recorded === "string" && recorded.startsWith("https://")
    ? recorded
    : null;

// The PR's number, derived from the url the driver already recorded rather
// than asked of the forge (fleet-control's companion request, answered by
// deriving it here — the COLLECTOR may not parse a forge path, REQ-110, but
// the publisher is the interpreting half). Both forms the fleet uses end in
// the number: github `/pull/12`, bitbucket `/pull-requests/12`. Anything that
// is not a positive integer is absent — `#NaN` beside a merge claim is worse
// than no number.
export const prNumberFromUrl = (url) => {
  const n = Number(/\/(\d+)\/?$/.exec(String(url ?? ""))?.[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// Whose PR state is worth a forge call (REQ-125): a task awaiting a merge or
// parked. The rule is a cost rule with teeth — this runs on every beat, and
// the fleet's measured driver spends far more on `gh`/`curl` spawns than on
// its own JS, so every other status carries its url and no state.
const FETCH_STATE_AT = new Set(["review", "needs-human"]);

// One project's PR-state reader: the driver's own forge client, built once
// per snapshot and only if some task actually needs it. Two failures are
// their own values and are never conflated with a PR that is merely not
// green (REQ-126): a forge this driver has no implementation for reads
// `unsupported`, and a forge that refuses or times out reads `unreachable`.
// A state that comes back is case-folded to the contract's spelling and
// otherwise travels as itself — the fold is a spelling, not a mapping.
export const prStateReader = (dir, home, kind, make = createForge) => {
  // Read outside the construction guard: a credential file this process
  // cannot read is not a forge nobody implements, and only the second of
  // those is `unsupported`.
  const env = readEnvFile(stateDir(dir, home), home);
  let forge;
  let unsupported = false;
  return (url) => {
    if (!forge && !unsupported) {
      // createForge refuses exactly one thing — a kind it has no
      // implementation for — so its refusal IS the unsupported verdict.
      try { forge = make({ kind, project: dir, env }); }
      catch { unsupported = true; }
    }
    if (unsupported) return "unsupported";
    try {
      const state = forge.prState(url);
      // A client that answers without a state has not been read — shipping
      // the string "undefined" as a verdict would put a nonsense value on
      // the board under the rule that protects real unknown ones.
      return typeof state === "string" && state ? state.toLowerCase() : "unreachable";
    } catch {
      return "unreachable";
    }
  };
};

// One task on the wire: the typed fields a detail view can render, minus
// the two prose fields REQ-118 names — acceptance criteria and the verify
// line were a measured 3.4× payload multiplier for text the board never
// shows, plus this task's two verdicts. Absent-capable like every wire
// field: an empty optional is omitted, never sent as null.
//
// `pr` is the task's own record in `state.json` — the runtime authority the
// driver writes the url into for every report at `review`, not only for
// parks. A task at `review` with no url recorded (what a local-only repo
// reports) travels with no `pr` at all, which is exactly the absence the
// collector needs to withhold a verb it could not name an object for.
const wireTask = (t, rec, { forge, readState, now, threads }) => {
  const url = typeof rec?.pr === "string" && rec.pr ? rec.pr : null;
  const number = url ? prNumberFromUrl(url) : null;
  const park = taskPark(t, rec);
  const thread = taskThread(park, threads[t.id]);
  let pr = null;
  if (url) {
    // When the reading happened, on this machine's clock. `dateReadings`
    // below turns it into the duration that travels (REQ-123) once every
    // read in the body is done — a PR read early in a slow gather is older
    // than one read at the end of it, and a stale green causes a wrong
    // ACTION, which is why the age is carried rather than inferred at the
    // far end.
    let state = null;
    let readAt = null;
    if (FETCH_STATE_AT.has(t.status)) {
      readAt = now();
      state = readState(url);
    }
    pr = {
      url,
      ...(number !== null ? { number } : {}),
      // The forge travels WITH the PR (CONTEXT.md, PR): this fleet is not
      // single-forge, so which one a PR lives on is part of the PR rather
      // than of the machine that read it.
      forge,
      ...(state !== null ? { state, readAt } : {}),
    };
  }
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    epic: t.epic,
    ...(t.gate ? { gate: t.gate } : {}),
    ...(t.model ? { model: t.model } : {}),
    ...(t.effort ? { effort: t.effort } : {}),
    ...(t.deps.length ? { deps: t.deps } : {}),
    ...(t.question ? { question: t.question } : {}),
    ...(park ? { park } : {}),
    ...(thread ? { thread } : {}),
    ...(pr ? { pr } : {}),
  };
};

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

// The clone's own drift, measured the way the driver measures it: commits on
// the last-known origin ref that this checkout does not have. No fetch — the
// answer is as fresh as the machine's last one, which is what a machine can
// honestly say without turning a guard into a network call. Unknown is not
// stale: a checkout with no origin, or an unreadable one, guards nothing.
export const behindOrigin = (dir, home) => {
  const base = readJson(path.join(stateDir(dir, home), "config.json"))?.baseBranch ?? "dev";
  try {
    const behind = Number(execGit(dir, ["rev-list", "--count", `${base}..origin/${base}`], { timeoutMs: 10_000 }));
    return Number.isFinite(behind) ? behind > 0 : null;
  } catch {
    // No origin ref to compare against, or not a repo at all. Unknown, and it
    // must travel as unknown: `false` here would render a clone this machine
    // could not measure as one it measured and found current, which is exactly
    // the case the guard exists for.
    return null;
  }
};

// REQ-73's input, absent where this machine could not measure it: the far end
// reads an absent `clone` as unknown and guards nothing, which is the honest
// reading and never the one that quietly withdraws a verb.
const cloneState = (dir, home) => {
  const behind = behindOrigin(dir, home);
  return behind === null ? null : { behindOrigin: behind };
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

// Every PR reading dated at once, when the body is built: each carries how
// long ago IT was read, so the first read of a slow gather is not passed off
// as being as fresh as the last. The instant itself never travels — only the
// duration does.
const dateReadings = (wireTasks, at) => wireTasks && wireTasks.map((t) => {
  if (typeof t.pr?.readAt !== "number") return t;
  const { readAt, ...pr } = t.pr;
  return { ...t, pr: { ...pr, ageSeconds: Math.max(0, Math.round((at - readAt) / 1000)) } };
});

// One project's snapshot body — always the full snapshot (REQ-115). This
// module derives the facts; the SHAPE lives in fleet-wire.mjs with every
// other envelope body. An autonomy the config does not carry is absent, not
// defaulted: buildConfig always writes one and migrate heals it, so a
// config without it is one this publisher failed to read — never a guess.
// `now` is a CLOCK, not an instant: the PR reads happen inside this call and
// are dated across it, so a body that takes a frozen number could not date
// its own work.
export const snapshotBody = (dir, remote, home, now, deps = {}) => {
  const { makeReader = prStateReader } = deps;
  const at = now();
  const sd = stateDir(dir, home);
  const cfg = readJson(path.join(sd, "config.json"));
  // The forge the driver itself would use for this project: its configured
  // kind, github by default like every other caller of createForge.
  const forge = typeof cfg?.forge === "string" && cfg.forge ? cfg.forge : "github";
  const { tasks, milestones } = readBacklog(dir);
  // The park and the PR live on the task's RUNTIME record (state.json under
  // the project's state dir), which is where the driver writes both; the
  // backlog block carries neither. The question threads live in the same
  // file but one level up — a map of the whole project's live threads, not a
  // per-task field — which is why it is read beside the records rather than
  // out of one. An unreadable state file leaves every task without all three
  // — absent, never invented.
  const state = readJson(path.join(sd, "log", "state.json"));
  const runtime = state?.tasks ?? {};
  const threads = state?.questionThreads ?? {};
  const readState = makeReader(dir, home, forge);
  const wireTasks = dateReadings(
    tasks && tasks.map((t) => wireTask(t, runtime[t.id], { forge, readState, now, threads })),
    now(),
  );
  // Every PR reading's own age, as the list the collector folds to its
  // oldest (REQ-21): the row's PR claims can then be dated without any one
  // reading lending its freshness to another.
  const prAges = (wireTasks ?? []).map((t) => t.pr?.ageSeconds).filter((a) => typeof a === "number");
  return wireBody({
    remote,
    enabled: cfg?.enabled !== false, // the driver's own default: enabled
    autonomy: typeof cfg?.autonomy === "string" ? cfg.autonomy : null,
    milestones: milestones && milestones.map((m) => wireMilestone(m, tasks ?? [])),
    tasks: wireTasks,
    clone: cloneState(dir, home),
    stopHeld: readStopHeld(dir, home, at),
    metaDivergence: metaDivergence(dir, home, at),
    ages: prAges.length ? { pr: prAges } : null,
  });
};

// ---------- the fixture park (`--fixture-park`) ----------
//
// A recorded question park, written to disk as the driver would write it, so
// the thread a park carries is runnable on a machine where nothing is parked
// — which is every machine, most of the time. Files rather than an injected
// object, for the reason `writeFixtureWindow` is: the drive is only worth
// having if it exercises the same reads the daemon does — the checkout's
// backlog and the state dir's `state.json` — and a stub in front of those
// would prove the shape while hiding the reading.
//
// No git repo and no remote of its own: the drive hands this claim straight
// to `gatherSnapshots`, which is the same way the fixture window is claimed,
// so nothing here needs identifying. Its task carries no PR either, which is
// what keeps the drive off the network: no url, no forge call.
const FIXTURE_PARK_THREAD = "https://github.com/MJTeixeira/fixture-park/issues/7";

export const writeFixturePark = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-fixture-park-"));
  const dir = path.join(home, "repos", "fixture-park");
  const backlog = path.join(dir, ".factory", "backlog");
  fs.mkdirSync(backlog, { recursive: true });
  fs.writeFileSync(
    path.join(backlog, "index.md"),
    "# Backlog\n\n## M1: Only — active\n- [e1](e1.md) — 1 task\n",
  );
  fs.writeFileSync(
    path.join(backlog, "e1.md"),
    [
      "## T-001: The task that had to ask",
      "- Status: needs-human",
      "- Verify: node --test",
      "",
    ].join("\n"),
  );
  const logDir = path.join(stateDir(dir, home), "log");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(
    path.join(logDir, "state.json"),
    JSON.stringify({
      tasks: { "T-001": { status: "needs-human", parkedBy: "question" } },
      questionThreads: { "T-001": FIXTURE_PARK_THREAD },
    }),
  );
  return {
    home,
    claim: { dir, remote: "https://github.com/MJTeixeira/fixture-park.git" },
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
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
      const body = snapshotBody(dir, remote, home, now, { makeReader: deps.makeReader });
      envelopes.push(envelope(settings.machineId, "snapshot", body, now()));
    } catch (e) {
      report(`fleet-publisher: snapshot failed for ${dir}: ${e}`);
    }
  }
  return envelopes;
};
