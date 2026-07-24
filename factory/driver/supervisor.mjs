#!/usr/bin/env node
// Fleet supervisor (PR-D, Layer-1) — machine-side daemon, one per machine.
//
//   node supervisor.mjs            # daemon: one pass every 60s (launchd/systemd keep it alive)
//   node supervisor.mjs --once     # single pass, then exit (tests, ad-hoc checks)
//
// Duties, all reconstructed from disk every pass (registry + each factory's
// window.lock + journals) so an OS restart of the supervisor loses nothing:
//
//   1. Out-of-band wall-clock kill of hung driver runs — the driver's own
//      timeouts run on its event loop, so a stalled sync call (git/gh over a
//      dead network, 2026-07-11: 4.5h) hangs the watchdog WITH the watched.
//      A live lock past its wall-clock bound gets its process tree killed,
//      `prep` cleans up, the owner gets one escalation.
//   2. Owner-directed relaunch directives (opt-in, per named run — NEVER a
//      standing default: scheduled factories keep their timers, manual
//      factories run only when asked).
//   3. Structured escalations: append-only ~/.factory/escalations.jsonl (the
//      L3/Eva contract — see .docs/escalations.md) + best-effort Telegram.
//
// Like watchdog.mjs it runs the driver that ships BESIDE it (the machine
// runtime) and is read-only apart from kills, prep runs, its own state
// (~/.factory/supervisor/) and the escalations outbox.

import { spawn, spawnSync, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { stateDir, writeJsonAtomic } from "./paths.mjs";
import { generateSupervisorUnits, defaultPathLine } from "./schedule.mjs";

const DRIVER = fileURLToPath(new URL("factory.mjs", import.meta.url));

// Wall-clock hang bounds. Windows legitimately overrun windowEndsAt (a last
// session may start minutes before it and run its full timeout, then the
// merge gate and window-end sweep add their budgets) — the dev bound is
// derived from the factory's own config so a raised timeout can never turn
// a healthy finalization into a "hang"; a real hang (hours) still dies the
// same pass it exceeds the bound.
const SINGLE_GRACE_MS = 30 * 60 * 1000;
const KILL_WAIT_MS = 5_000;
const PASS_INTERVAL_MS = 60_000;
// A relaunched driver writes its first window.lock (and journal) only after
// finalization replay + git fetch — minutes, on the flaky networks that
// need directives most. Until this grace passes, "no lock, no journal" means
// "still starting", never "ran zero sessions". Env override is for tests.
const LAUNCH_GRACE_MS = Number(process.env.SUPERVISOR_LAUNCH_GRACE_MS ?? 15 * 60 * 1000);

const home = os.homedir();
const supDir = path.join(home, ".factory", "supervisor");
const regPath = path.join(home, ".factory", "registry.json");
const outboxPath = path.join(home, ".factory", "escalations.jsonl");
const statePath = path.join(supDir, "state.json");

const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try {
    fs.mkdirSync(supDir, { recursive: true });
    fs.appendFileSync(path.join(supDir, "supervisor.log"), line + "\n");
  } catch { /* stdout still has it */ }
  process.stdout.write(line + "\n");
};

const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
};

// KEY=VALUE lines, # comments — same format as watchdog.mjs/factory.mjs.
const loadEnv = (p) => {
  const env = {};
  if (!fs.existsSync(p)) return env;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0) env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return env;
};

// kill(pid, 0) succeeds on a zombie, and a hung driver's parent may never
// reap it — a zombie is dead for every purpose the supervisor has.
const alive = (pid) => {
  try { process.kill(pid, 0); } catch { return false; }
  try {
    const stat = execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8", timeout: 30_000 }).trim();
    return !!stat && !stat.startsWith("Z");
  } catch { return false; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- process tree ----------

// One `ps` snapshot of every process: pid -> { ppid, pgid, zombie }.
// Zombies stay in the table until reaped — they must never count as "still
// running" or a kill could wait forever on an unreaped corpse.
const psTable = () => {
  const table = new Map();
  const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat="], { encoding: "utf8", timeout: 30_000 });
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/.exec(line);
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), pgid: Number(m[3]), zombie: m[4].startsWith("Z") });
  }
  return table;
};

const psCommand = (pid) => {
  try { return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 30_000 }).trim(); }
  catch { return null; }
};

// The driver spawns claude detached (its own process group), so killing the
// driver's group alone strands the session — that IS today's gap. Walk the
// tree from the lock pid, collect every member's group, and kill the groups.
const treePgids = (rootPid, table) => {
  const members = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, { ppid }] of table) {
      if (members.has(ppid) && !members.has(pid)) { members.add(pid); grew = true; }
    }
  }
  const ourPgid = table.get(process.pid)?.pgid;
  const pgids = new Set();
  for (const pid of members) {
    const pgid = table.get(pid)?.pgid;
    if (pgid && pgid !== ourPgid && pgid > 1) pgids.add(pgid);
  }
  return pgids;
};

// The pgid set is captured ONCE, before any signal: the root dying first
// would orphan its children out of the ppid walk, and success must mean
// "every captured group is empty" — the root driver dies to SIGTERM in
// milliseconds while a stuck claude child (the hang class this daemon
// exists for) may need the SIGKILL round.
const killTree = async (rootPid) => {
  const pgids = treePgids(rootPid, psTable());
  const liveGroups = () => {
    const table = psTable();
    const live = new Set();
    for (const [, info] of table) if (pgids.has(info.pgid) && !info.zombie) live.add(info.pgid);
    return live;
  };
  const signalGroups = (groups, sig) => {
    for (const pgid of groups) { try { process.kill(-pgid, sig); } catch { /* group already gone */ } }
    if (alive(rootPid)) { try { process.kill(rootPid, sig); } catch { /* gone */ } }
  };
  signalGroups(pgids, "SIGTERM");
  const deadline = Date.now() + KILL_WAIT_MS;
  while (liveGroups().size && Date.now() < deadline) await sleep(200);
  const leftover = liveGroups();
  if (leftover.size) {
    signalGroups(leftover, "SIGKILL");
    const hardDeadline = Date.now() + KILL_WAIT_MS;
    while (liveGroups().size && Date.now() < hardDeadline) await sleep(200);
  }
  return liveGroups().size === 0;
};

// ---------- escalations (the L3/Eva contract — .docs/escalations.md) ----------

let telegram; // resolved once per process, cached
const telegramCreds = () => {
  if (telegram !== undefined) return telegram;
  telegram = null;
  const reg = readJson(regPath);
  const credFiles = [
    path.join(home, ".factory", "telegram.env"),
    ...Object.keys(reg?.factories ?? {}).map((p) => path.join(stateDir(p), ".env")),
  ];
  for (const p of credFiles) {
    const env = loadEnv(p);
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      telegram = { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID };
      break;
    }
  }
  return telegram;
};

const readState = () => readJson(statePath) ?? { escalated: {} };
const writeState = (s) => writeJsonAtomic(statePath, s);

// Append one outbox record + best-effort Telegram. `key` scopes the dedupe:
// the same cause never escalates twice, a new cause (new hang, new window)
// always does.
const escalate = async ({ project, name, type, detail, key }) => {
  const s = readState();
  const dedupeKey = `${project}|${type}|${key ?? detail}`;
  if (s.escalated[dedupeKey]) return false;
  s.escalated[dedupeKey] = new Date().toISOString();
  const record = {
    ts: new Date().toISOString(),
    machine: os.hostname(),
    project,
    name,
    type,
    detail,
  };
  fs.mkdirSync(path.dirname(outboxPath), { recursive: true });
  fs.appendFileSync(outboxPath, JSON.stringify(record) + "\n");
  writeState(s);
  log(`escalation: ${name} ${type} — ${detail}`);
  const creds = telegramCreds();
  if (creds) {
    try {
      // FACTORY_TELEGRAM_API: test double (helpers.mjs startTelegramStub).
      const res = await fetch(`${process.env.FACTORY_TELEGRAM_API ?? "https://api.telegram.org"}/bot${creds.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: creds.chatId,
          text: `[supervisor] 🚨 ${name}: ${type}\n${detail}`,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) log(`telegram HTTP ${res.status} — outbox record stands`);
    } catch (e) {
      log(`telegram failed (${String(e.message ?? e).split("\n")[0]}) — outbox record stands`);
    }
  }
  return true;
};

// ---------- hung-run detection ----------

const runPrep = (project) => {
  const r = spawnSync(process.execPath, [DRIVER, "prep", "--project", project], {
    encoding: "utf8", timeout: 10 * 60 * 1000,
  });
  if (r.status !== 0) log(`prep for ${project} exited ${r.status} — a later dev/prep run replays finalization`);
  return r.status === 0;
};

// A live lock past its wall-clock bound is a hung run. dev locks carry
// windowEndsAt; single-mode locks (triage/report/prep) bound from startedAt
// + the factory's own session timeout. The dev grace is config-derived and
// sized for the realistic tail past windowEnd: a last session may start just
// before it and run its full timeout, its own PR then draws an acceptance-
// grader session (a second timeout), and the window-end sweep may grade one
// more (a third) — plus the merge gate's poll budget around each. Three
// timeouts covers the common case; a factory that ends a window with a large
// backlog of green-but-ungraded PRs can still have the boundary sweep grade
// several back-to-back and overrun this — a false hang-kill there is
// safe-direction (the killed grader cached nothing, the next window re-grades
// and re-merges), never a bad merge. See .docs/known-issues.md.
const hangBound = (lock, cfg) => {
  const timeoutMin = Number(cfg?.sessionTimeoutMin) || 45;
  const windowEnd = Date.parse(lock.windowEndsAt ?? "");
  if (!Number.isNaN(windowEnd)) {
    const gateMin = Number(cfg?.mergeGateMinutes) || 10;
    return windowEnd + (3 * timeoutMin + 2 * gateMin + 30) * 60 * 1000;
  }
  const started = Date.parse(lock.startedAt ?? "");
  if (!Number.isNaN(started)) return started + timeoutMin * 60 * 1000 + SINGLE_GRACE_MS;
  return null;
};

const checkFactory = async (project, meta) => {
  const name = meta?.name ?? path.basename(project);
  const sd = stateDir(project);
  const lock = readJson(path.join(sd, "log", "window.lock"));
  if (!lock?.pid) return;
  if (!alive(lock.pid)) return; // stale lock from a crash — the next dev/prep run replays finalization
  const bound = hangBound(lock, readJson(path.join(sd, "config.json")));
  if (bound === null) {
    log(`${name}: live lock (pid ${lock.pid}) has no parseable timestamps — cannot judge, skipping`);
    return;
  }
  if (Date.now() <= bound) return;

  const overBy = Math.round((Date.now() - bound) / 60000);
  // Never kill a recycled pid: the lock's pid must still be a factory driver.
  const cmd = psCommand(lock.pid);
  if (!cmd || !cmd.includes("factory.mjs")) {
    await escalate({
      project, name, type: "hung-window-unkillable", key: String(lock.pid),
      detail: `${lock.mode ?? "?"} lock (started ${lock.startedAt}) is ${overBy}min past its bound but pid ${lock.pid} is not a factory driver (${cmd ?? "gone"}) — clear ${path.join(sd, "log", "window.lock")} by hand`,
    });
    return;
  }

  log(`${name}: ${lock.mode ?? "?"} run (pid ${lock.pid}) is ${overBy}min past its wall-clock bound — killing`);
  const dead = await killTree(lock.pid);
  if (!dead) {
    await escalate({
      project, name, type: "hung-window-unkillable", key: String(lock.pid),
      detail: `${lock.mode ?? "?"} run pid ${lock.pid} survived SIGTERM+SIGKILL — investigate on the machine`,
    });
    return;
  }
  runPrep(project);
  await escalate({
    project, name, type: "hung-window-killed", key: lock.startedAt ?? String(lock.pid),
    detail: `${lock.mode ?? "?"} run (started ${lock.startedAt}, session ${lock.currentSession ?? "?"}) hung ${overBy}min past its bound — killed its process tree and ran prep`,
  });
};

// ---------- relaunch directives (opt-in, per named run) ----------
// A directive is the owner saying "keep <project>'s dev windows running until
// <time>" — the 2026-07-11 manual-babysit shape as a first-class object.
// Scheduled factories keep their timers, manual factories run only when
// asked; the directive is NEVER a standing default and dies with its span.

const directivesPath = path.join(supDir, "directives.json");
const readDirectives = () => readJson(directivesPath) ?? {};
const writeDirectives = (d) => writeJsonAtomic(directivesPath, d);
// Dropping a directive also clears the project's launch-tracking state:
// leftover strikes or an old lastLaunch must never poison the owner's NEXT
// keep (a stale strike would fail it on its first slow launch; a stale
// lastLaunch would let a days-old skip journal drop it immediately).
const clearLaunchState = (project) => {
  const s = readState();
  if (s.factories?.[project]) {
    delete s.factories[project];
    writeState(s);
  }
};
const dropDirective = (project, why) => {
  const d = readDirectives();
  delete d[project];
  writeDirectives(d);
  clearLaunchState(project);
  log(`directive for ${project} dropped — ${why}`);
};

// Journals a launched run left behind tell the supervisor what happened
// without re-deriving factory status: window-skipped means PR-C's derived
// status said waiting-on-owner/deadlocked, session steps mean real work ran.
const journalStepsSince = (sd, sinceMs) => {
  const logDir = path.join(sd, "log");
  let files = [];
  try { files = fs.readdirSync(logDir).filter((f) => /^journal-.+\.jsonl$/.test(f)); } catch { return null; }
  const fresh = files
    .map((f) => ({ f, mtime: fs.statSync(path.join(logDir, f)).mtimeMs }))
    .filter((x) => x.mtime > sinceMs)
    .sort((a, b) => a.mtime - b.mtime);
  if (!fresh.length) return null;
  const latest = fresh[fresh.length - 1];
  const steps = fs.readFileSync(path.join(logDir, latest.f), "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return { file: latest.f, steps };
};

const launchDev = (project, name) => {
  const child = spawn(process.execPath, [DRIVER, "dev", "--project", project], {
    detached: true, stdio: "ignore",
  });
  child.unref();
  log(`${name}: relaunched dev (pid ${child.pid})`);
};

const checkDirective = async (project, meta, directive) => {
  const name = meta?.name ?? path.basename(project);
  const sd = stateDir(project);
  if (Date.now() > Date.parse(directive.until ?? "")) {
    dropDirective(project, `span ended (${directive.until})`);
    return;
  }
  if (readJson(path.join(sd, "config.json"))?.enabled === false) {
    dropDirective(project, "factory is disabled");
    return;
  }
  const lock = readJson(path.join(sd, "log", "window.lock"));
  if (lock?.pid && alive(lock.pid)) return; // a run is active — nothing to keep alive

  const st = readState().factories?.[project] ?? {};
  if (st.lastLaunch) {
    const lastLaunchMs = Date.parse(st.lastLaunch);
    const journal = journalStepsSince(sd, lastLaunchMs);
    const skipped = journal?.steps.find((r) => r.step === "window-skipped");
    if (skipped) {
      dropDirective(project, `window skipped: ${skipped.detail ?? ""}`);
      await escalate({
        project, name, key: journal.file,
        type: String(skipped.detail ?? "").includes("deadlocked") ? "deadlocked" : "waiting-on-owner",
        detail: `relaunch stopped — ${skipped.detail ?? "window skipped"}`,
      });
      return;
    }
    if (journal?.steps.some((r) => r.step === "session")) {
      st.strikes = 0;
    } else if (Date.now() - lastLaunchMs < LAUNCH_GRACE_MS) {
      // No lock and no journal yet, but the launched driver spends minutes
      // in finalization replay + git fetch before writing either — wait.
      return;
    } else {
      st.strikes = (st.strikes ?? 0) + 1;
      if (st.strikes >= 2) {
        dropDirective(project, `${st.strikes} consecutive launches ran no sessions`);
        await escalate({
          project, name, type: "relaunch-failed", key: directive.createdAt ?? directive.until,
          detail: `${st.strikes} consecutive relaunched dev runs ended without running a session — check ${path.join(sd, "log")} on this machine`,
        });
        return;
      }
    }
  }
  launchDev(project, name);
  const s = readState();
  s.factories = { ...(s.factories ?? {}), [project]: { ...st, lastLaunch: new Date().toISOString() } };
  writeState(s);
};

// ---------- stuck-factory detection (item 50 chunk 2) ----------
// The dumb OnFailure net pings on every unit failure but can't tell a
// transient blip from a factory wedged for days. A scheduled, enabled factory
// whose last N dev windows each aborted before doing anything — no `session`
// step (a session ran, even if it died) and no `window-skipped` step (a clean
// idle: waiting-on-owner / deadlocked / backlog-complete / no-eligible-tasks) —
// is STUCK, not idle. Escalate once per streak. Dev windows are the only mode
// that writes journal-*.jsonl; the filename is the window-start time, so it
// orders windows even when a later run's finalize-replay bumps an old journal's
// mtime.
const STUCK_STREAK = 2;

const isScheduled = (cfg) => {
  const s = cfg?.schedule;
  return !!s && typeof s === "object" && !!s.kind && s.kind !== "manual" && !!s.modes?.dev;
};

// Newest-window-first list of a factory's dev-window journals (by window-start
// time embedded in the filename, not mtime).
const devJournals = (sd) => {
  const logDir = path.join(sd, "log");
  let files;
  try { files = fs.readdirSync(logDir).filter((f) => /^journal-.+\.jsonl$/.test(f)); } catch { return []; }
  return files.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)).map((f) => path.join(logDir, f));
};

// A dev window did its job if it ran a session or cleanly skipped. Only a
// window-start step (± a next-run finalize replay) means it aborted before
// doing anything. Unreadable = don't count it as a failure.
const windowAborted = (journalPath) => {
  let steps;
  try {
    steps = fs.readFileSync(journalPath, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return false; }
  return !steps.some((s) => s.step === "session" || s.step === "window-skipped");
};

const checkStuck = async (project, meta) => {
  const name = meta?.name ?? path.basename(project);
  const sd = stateDir(project);
  const cfg = readJson(path.join(sd, "config.json"));
  if (cfg?.enabled === false || !isScheduled(cfg)) return;
  // A window in progress is not a failure — don't judge until it settles.
  const lock = readJson(path.join(sd, "log", "window.lock"));
  if (lock?.pid && alive(lock.pid)) return;
  // Walk newest→older while windows aborted; the oldest consecutive-aborted
  // journal names the streak, so escalate()'s dedupe fires once per streak
  // (a recovery then re-wedge starts a new streak → a new alert).
  let streak = 0;
  let streakId = null;
  for (const j of devJournals(sd)) {
    if (!windowAborted(j)) break;
    streak += 1;
    streakId = path.basename(j);
  }
  if (streak < STUCK_STREAK) return;
  await escalate({
    project, name, type: "factory-stuck", key: streakId,
    detail: `${streak} consecutive dev windows aborted before running a session and did not cleanly skip — the factory is wedged, not idle; check ${path.join(sd, "log")} on this machine`,
  });
};

// ---------- pass ----------

const pass = async () => {
  const reg = readJson(regPath);
  const factories = Object.entries(reg?.factories ?? {});
  if (!factories.length) {
    log("no factories in ~/.factory/registry.json — nothing to supervise");
    return;
  }
  const directives = readDirectives();
  for (const [project, meta] of factories) {
    try {
      await checkFactory(project, meta);
      if (directives[project]) await checkDirective(project, meta, directives[project]);
      await checkStuck(project, meta);
    } catch (e) {
      log(`${meta?.name ?? project}: check failed (${String(e.message ?? e).split("\n")[0]}) — next pass retries`);
    }
  }
};

// ---------- CLI ----------

const USAGE = `usage: node supervisor.mjs                                  # daemon
       node supervisor.mjs --once                           # single pass
       node supervisor.mjs keep --project <p> --until <ISO-8601 | HH:MM (next occurrence)>
       node supervisor.mjs release --project <p>
       node supervisor.mjs install [--yes]                  # OS keep-alive unit (launchd/systemd)
`;
const fail = (msg) => {
  process.stderr.write(`supervisor: ${msg}\n${USAGE}`);
  process.exit(1);
};

const cliFlags = (rest) => {
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--project") flags.project = path.resolve(rest[++i] ?? "");
    else if (rest[i] === "--until") flags.until = rest[++i];
    else fail(`unknown flag ${rest[i]}`);
  }
  return flags;
};

// "HH:MM" = the NEXT occurrence of that local wall-clock time — at 23:00,
// "--until 00:30" means tonight, not 23 hours ago. An explicit ISO timestamp
// in the past is a typo, not a wish.
const parseUntil = (raw) => {
  const hhmm = /^(\d{1,2}):(\d{2})$/.exec(String(raw ?? "").trim());
  let ts;
  if (hhmm) {
    ts = new Date(new Date().setHours(Number(hhmm[1]), Number(hhmm[2]), 0, 0)).getTime();
    if (ts <= Date.now()) ts += 24 * 3600 * 1000;
  } else {
    ts = Date.parse(raw ?? "");
  }
  if (Number.isNaN(ts)) fail(`--until "${raw}" is not an ISO-8601 timestamp or HH:MM`);
  if (ts <= Date.now()) fail(`--until ${new Date(ts).toISOString()} is already past`);
  return new Date(ts).toISOString();
};

// The installed unit execs the ONE gated machine runtime (deploy-runtime.mjs
// advances it), never whichever checkout ran install — same premise as
// factory.mjs's RUNTIME_DRIVER.
const installUnit = async (yes) => {
  const kind = { darwin: "launchd", linux: "systemd" }[process.platform];
  if (!kind) fail(`no keep-alive process manager for platform ${process.platform} — supervisor needs launchd or systemd`);
  const { files } = generateSupervisorUnits(kind, {
    runtimeSupervisor: path.join(home, ".factory", "runtime", "factory", "driver", "supervisor.mjs"),
    nodeBin: process.execPath,
    pathLine: defaultPathLine(process.execPath, home),
    logDir: supDir,
  });
  fs.mkdirSync(supDir, { recursive: true });
  const run = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
  const say = (m) => process.stdout.write(m + "\n");
  const confirm = async (what) => {
    if (yes) return;
    if (!process.stdin.isTTY) fail("not a TTY — rerun with --yes to confirm the install");
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const a = (await rl.question(`${what} [y/N]: `)).trim();
    rl.close();
    if (!/^y(es)?$/i.test(a)) fail("aborted — nothing changed");
  };

  if (kind === "systemd") {
    const dir = path.join(home, ".config", "systemd", "user");
    const name = "factory-supervisor.service";
    await confirm(`install + enable ${name} (systemd user unit, Restart=always)?`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), files[name]);
    // The dumb-outer-net companion the unit's OnFailure names — installed
    // when absent, never overwritten (same rule as schedule --install).
    const companionSrc = fileURLToPath(new URL("../schedulers/factory-onfailure@.service", import.meta.url));
    if (!fs.existsSync(path.join(dir, "factory-onfailure@.service")) && fs.existsSync(companionSrc)) {
      fs.copyFileSync(companionSrc, path.join(dir, "factory-onfailure@.service"));
    }
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", name]);
    say(`installed and started ${name} (remember: loginctl enable-linger keeps user units alive after logout)`);
  } else {
    const dir = path.join(home, "Library", "LaunchAgents");
    const name = "com.factory.supervisor.plist";
    const dest = path.join(dir, name);
    await confirm(`install + load ${name} (launchd KeepAlive agent)?`);
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(dest)) { try { run("launchctl", ["unload", dest]); } catch { /* was not loaded */ } }
    fs.writeFileSync(dest, files[name]);
    run("launchctl", ["load", dest]);
    say(`installed and loaded ${name}`);
  }
};

const [command, ...rest] = process.argv.slice(2);
if (command === "install") {
  const extra = rest.filter((a) => a !== "--yes");
  if (extra.length) fail(`unknown flag ${extra[0]}`);
  await installUnit(rest.includes("--yes"));
} else if (command === "keep" || command === "release") {
  const { project, until } = cliFlags(rest);
  if (!project) fail("--project <path> is required");
  const reg = readJson(regPath);
  if (!reg?.factories?.[project]) fail(`${project} is not in ~/.factory/registry.json — the supervisor only watches registered factories`);
  const d = readDirectives();
  if (command === "keep") {
    if (!until) fail("keep needs --until <time> — a directive is a named span, never a standing default");
    d[project] = { until: parseUntil(until), createdAt: new Date().toISOString() };
    writeDirectives(d);
    clearLaunchState(project); // a fresh directive starts with a clean slate
    log(`directive: keep ${project} running until ${d[project].until}`);
  } else {
    if (d[project]) dropDirective(project, "released by the owner");
    else log(`no directive for ${project} — nothing to release`);
  }
} else if (command === "--once") {
  if (rest.length) fail(`unknown flag ${rest[0]}`);
  await pass();
} else if (command === undefined) {
  log("supervisor starting (one pass every 60s)");
  while (true) {
    await pass();
    await sleep(PASS_INTERVAL_MS);
  }
} else {
  fail(`unknown command ${command}`);
}
