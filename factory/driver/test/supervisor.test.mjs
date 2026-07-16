// Fleet supervisor (PR-D): machine-level daemon — out-of-band wall-clock
// kill of hung windows, owner-directed relaunch directives, and a structured
// escalations outbox (~/.factory/escalations.jsonl, the L3/Eva contract).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { stateDir } from "../paths.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// A fake sibling factory.mjs that records every invocation — the supervisor
// must run the driver that ships BESIDE it (machine runtime), so tests copy
// supervisor.mjs next to this recorder to control what prep/dev do.
const RECORDER_DRIVER = `
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
fs.appendFileSync(path.join(os.homedir(), ".factory", "driver-calls.jsonl"),
  JSON.stringify({ ts: new Date().toISOString(), argv: process.argv.slice(2) }) + "\\n");
process.exit(0);
`;

// A long-sleeping stand-in for a hung driver. Named factory.mjs on purpose:
// the supervisor must refuse to kill a lock pid whose command line is not a
// factory driver (pid recycling).
const HUNG_DRIVER = `setInterval(() => {}, 1000);`;

const setup = (t, { config = {} } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".factory"), { recursive: true });

  const binDir = path.join(root, "runtime-driver");
  fs.mkdirSync(binDir);
  fs.copyFileSync(path.join(here, "..", "supervisor.mjs"), path.join(binDir, "supervisor.mjs"));
  fs.copyFileSync(path.join(here, "..", "paths.mjs"), path.join(binDir, "paths.mjs"));
  fs.copyFileSync(path.join(here, "..", "schedule.mjs"), path.join(binDir, "schedule.mjs"));
  fs.writeFileSync(path.join(binDir, "factory.mjs"), RECORDER_DRIVER);

  const project = path.join(root, "proj");
  fs.mkdirSync(path.join(project, ".factory"), { recursive: true });
  fs.writeFileSync(path.join(home, ".factory", "registry.json"),
    JSON.stringify({ factories: { [project]: { name: "proj" } } }, null, 2));
  const sd = stateDir(project, home);
  fs.mkdirSync(path.join(sd, "log"), { recursive: true });
  fs.writeFileSync(path.join(sd, "config.json"),
    JSON.stringify({ enabled: true, sessionTimeoutMin: 45, ...config }, null, 2));

  const hungDir = path.join(root, "hung");
  fs.mkdirSync(hungDir);
  fs.writeFileSync(path.join(hungDir, "factory.mjs"), HUNG_DRIVER);

  return {
    root, home, binDir, project, sd,
    lockPath: path.join(sd, "log", "window.lock"),
    escalations: path.join(home, ".factory", "escalations.jsonl"),
    driverCalls: path.join(home, ".factory", "driver-calls.jsonl"),
    hungScript: path.join(hungDir, "factory.mjs"),
  };
};

const spawnHung = (t, w) => {
  const child = spawn(process.execPath, [w.hungScript, "dev", "--project", w.project],
    { detached: true, stdio: "ignore" });
  child.unref();
  t.after(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } });
  return child.pid;
};

const runOnce = (w, env = {}) =>
  spawnSync(process.execPath, [path.join(w.binDir, "supervisor.mjs"), "--once"], {
    encoding: "utf8", timeout: 60_000, env: { ...process.env, HOME: w.home, ...env },
  });

// The test process spawns the hung stand-ins and blocks in spawnSync while
// the supervisor runs, so killed children linger as zombies — count those as
// dead, like the supervisor itself does.
const alive = (pid) => {
  try { process.kill(pid, 0); } catch { return false; }
  const r = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
  const stat = (r.stdout ?? "").trim();
  return !!stat && !stat.startsWith("Z");
};
const readCalls = (w) => fs.existsSync(w.driverCalls)
  ? fs.readFileSync(w.driverCalls, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
const readEscalations = (w) => fs.existsSync(w.escalations)
  ? fs.readFileSync(w.escalations, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];

test("hung dev window: tree killed, prep run, hung-window-killed escalated", (t) => {
  const w = setup(t);
  const pid = spawnHung(t, w);
  fs.writeFileSync(w.lockPath, JSON.stringify({
    pid, mode: "dev",
    startedAt: new Date(Date.now() - 6 * 3600 * 1000).toISOString(),
    windowEndsAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
    currentSession: 3,
  }));

  const r = runOnce(w);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(alive(pid), false, "hung driver still alive after the pass");
  const preps = readCalls(w).filter((c) => c.argv[0] === "prep");
  assert.equal(preps.length, 1, `expected one prep run: ${JSON.stringify(readCalls(w))}`);
  assert.ok(preps[0].argv.includes(w.project), "prep must target the hung project");
  const esc = readEscalations(w);
  assert.equal(esc.length, 1, JSON.stringify(esc));
  assert.equal(esc[0].type, "hung-window-killed");
  assert.equal(esc[0].project, w.project);
  assert.equal(esc[0].name, "proj");
  assert.ok(esc[0].ts && esc[0].machine && esc[0].detail, JSON.stringify(esc[0]));
});

test("healthy dev window (windowEndsAt in the future) is untouched", (t) => {
  const w = setup(t);
  const pid = spawnHung(t, w);
  fs.writeFileSync(w.lockPath, JSON.stringify({
    pid, mode: "dev",
    startedAt: new Date().toISOString(),
    windowEndsAt: new Date(Date.now() + 3600 * 1000).toISOString(),
  }));

  const r = runOnce(w);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(alive(pid), true, "healthy driver was killed");
  assert.deepEqual(readEscalations(w), []);
  assert.deepEqual(readCalls(w), []);
});

test("stale lock (dead pid) is left for the next driver run — no kill, no prep, no escalation", (t) => {
  const w = setup(t);
  const pid = spawnHung(t, w);
  try { process.kill(pid, "SIGKILL"); } catch { /* fine */ }
  for (let i = 0; i < 50 && alive(pid); i++) spawnSync("sleep", ["0.1"]);
  fs.writeFileSync(w.lockPath, JSON.stringify({
    pid, mode: "dev",
    startedAt: new Date(Date.now() - 6 * 3600 * 1000).toISOString(),
    windowEndsAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
  }));

  const r = runOnce(w);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.deepEqual(readEscalations(w), []);
  assert.deepEqual(readCalls(w), []);
});

test("a dev window inside its config-derived overrun budget is not killed", (t) => {
  const w = setup(t); // defaults: 45min timeout + 2×10min gate + 30min slack = 95min budget
  const pid = spawnHung(t, w);
  fs.writeFileSync(w.lockPath, JSON.stringify({
    pid, mode: "dev",
    startedAt: new Date(Date.now() - 5 * 3600 * 1000).toISOString(),
    windowEndsAt: new Date(Date.now() - 70 * 60 * 1000).toISOString(), // a legit long finalization
  }));

  const r = runOnce(w);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(alive(pid), true, "killed a window still inside its finalization budget");
  assert.deepEqual(readEscalations(w), []);
});

test("a SIGTERM-ignoring child in its own process group still dies (SIGKILL round)", (t) => {
  const w = setup(t);
  // A hung parent driver that spawned a detached, SIGTERM-ignoring child —
  // the stuck-claude shape: killing the parent's group alone strands it.
  const dir = path.join(w.root, "hung-stubborn");
  fs.mkdirSync(dir);
  const childPidFile = path.join(dir, "child.pid");
  fs.writeFileSync(path.join(dir, "factory.mjs"), `
import { spawn } from "node:child_process";
import * as fs from "node:fs";
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
child.unref();
fs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));
setInterval(() => {}, 1000);
`);
  const parent = spawn(process.execPath, [path.join(dir, "factory.mjs"), "dev", "--project", w.project],
    { detached: true, stdio: "ignore" });
  parent.unref();
  t.after(() => { try { process.kill(-parent.pid, "SIGKILL"); } catch { /* gone */ } });
  for (let i = 0; i < 50 && !fs.existsSync(childPidFile); i++) spawnSync("sleep", ["0.1"]);
  const childPid = Number(fs.readFileSync(childPidFile, "utf8"));
  t.after(() => { try { process.kill(-childPid, "SIGKILL"); } catch { /* gone */ } });
  fs.writeFileSync(w.lockPath, JSON.stringify({
    pid: parent.pid, mode: "dev",
    startedAt: new Date(Date.now() - 6 * 3600 * 1000).toISOString(),
    windowEndsAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
  }));

  const r = runOnce(w);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(alive(parent.pid), false, "hung parent still alive");
  assert.equal(alive(childPid), false, "SIGTERM-ignoring child survived — groups were not verified");
  const esc = readEscalations(w);
  assert.equal(esc.length, 1, JSON.stringify(esc));
  assert.equal(esc[0].type, "hung-window-killed");
});

test("hung single-mode lock (triage, no windowEndsAt) is killed past sessionTimeout + grace", (t) => {
  const w = setup(t);
  const pid = spawnHung(t, w);
  fs.writeFileSync(w.lockPath, JSON.stringify({
    pid, mode: "triage",
    startedAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
  }));

  const r = runOnce(w);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(alive(pid), false, "hung triage driver still alive");
  const esc = readEscalations(w);
  assert.equal(esc.length, 1, JSON.stringify(esc));
  assert.equal(esc[0].type, "hung-window-killed");
  assert.match(esc[0].detail, /triage/);
});

test("a lock pid that is not a factory driver is never killed (pid recycling)", (t) => {
  const w = setup(t);
  // A live process whose command line has no factory.mjs in it.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
    { detached: true, stdio: "ignore" });
  child.unref();
  t.after(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } });
  fs.writeFileSync(w.lockPath, JSON.stringify({
    pid: child.pid, mode: "dev",
    startedAt: new Date(Date.now() - 6 * 3600 * 1000).toISOString(),
    windowEndsAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
  }));

  const r = runOnce(w);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(alive(child.pid), true, "killed a process that is not a factory driver");
  const esc = readEscalations(w);
  assert.equal(esc.length, 1, JSON.stringify(esc));
  assert.equal(esc[0].type, "hung-window-unkillable");
  assert.deepEqual(readCalls(w), [], "prep must not run when nothing was killed");
});

// ---------- relaunch directives (opt-in, per named run) ----------

const supervisorCli = (w, args) =>
  spawnSync(process.execPath, [path.join(w.binDir, "supervisor.mjs"), ...args], {
    encoding: "utf8", timeout: 60_000, env: { ...process.env, HOME: w.home },
  });
const directivesPath = (w) => path.join(w.home, ".factory", "supervisor", "directives.json");
const readDirectives = (w) => JSON.parse(fs.readFileSync(directivesPath(w), "utf8"));
const futureIso = (mins) => new Date(Date.now() + mins * 60 * 1000).toISOString();
const writeDirective = (w, until) => {
  fs.mkdirSync(path.dirname(directivesPath(w)), { recursive: true });
  fs.writeFileSync(directivesPath(w), JSON.stringify({
    [w.project]: { until, createdAt: new Date().toISOString() },
  }));
};
// A relaunched dev child is detached — it may write its recorder line after
// --once returns. Wait for the expected count before asserting on it.
const settleDevCalls = (w, n) => {
  for (let i = 0; i < 50 && readCalls(w).filter((c) => c.argv[0] === "dev").length < n; i++) {
    spawnSync("sleep", ["0.2"]);
  }
  return readCalls(w).filter((c) => c.argv[0] === "dev");
};
const journalName = () => `journal-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
const writeJournal = (w, steps) => {
  const p = path.join(w.sd, "log", journalName());
  fs.writeFileSync(p, steps.map((s) => JSON.stringify({ ts: new Date().toISOString(), status: "done", ...s })).join("\n") + "\n");
  return p;
};

test("keep writes a directive and release removes it; keep refuses an unregistered project", (t) => {
  const w = setup(t);
  const until = futureIso(120);
  const r = supervisorCli(w, ["keep", "--project", w.project, "--until", until]);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(readDirectives(w)[w.project].until, until);

  const stranger = path.join(w.root, "not-registered");
  const bad = supervisorCli(w, ["keep", "--project", stranger, "--until", until]);
  assert.notEqual(bad.status, 0, "keep must refuse a project the registry does not know");

  const rel = supervisorCli(w, ["release", "--project", w.project]);
  assert.equal(rel.status, 0, `${rel.stdout}\n${rel.stderr}`);
  assert.equal(readDirectives(w)[w.project], undefined);
});

test("keep accepts HH:MM as the next occurrence of that local time", (t) => {
  const w = setup(t);
  // 30min ahead — the next occurrence of that wall-clock time is now+30min
  // whether or not it crosses midnight.
  const target = new Date(Date.now() + 30 * 60 * 1000);
  const hhmm = `${String(target.getHours()).padStart(2, "0")}:${String(target.getMinutes()).padStart(2, "0")}`;
  const r = supervisorCli(w, ["keep", "--project", w.project, "--until", hhmm]);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const until = new Date(readDirectives(w)[w.project].until);
  assert.ok(Math.abs(until.getTime() - target.getTime()) < 60_000, `${until.toISOString()} vs ${target.toISOString()}`);
});

test("active directive with no running window relaunches dev; an expired one is dropped without launching", (t) => {
  const w = setup(t);
  writeDirective(w, futureIso(120));
  const r = runOnce(w);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const devs = settleDevCalls(w, 1);
  assert.equal(devs.length, 1, JSON.stringify(readCalls(w)));
  assert.ok(devs[0].argv.includes(w.project));

  const w2 = setup(t);
  writeDirective(w2, new Date(Date.now() - 60_000).toISOString());
  const r2 = runOnce(w2);
  assert.equal(r2.status, 0, `${r2.stdout}\n${r2.stderr}`);
  assert.deepEqual(readCalls(w2), [], "expired directive must not launch");
  assert.equal(readDirectives(w2)[w2.project], undefined, "expired directive must be dropped");
});

test("a directive for a disabled factory is dropped without launching", (t) => {
  const w = setup(t, { config: { enabled: false } });
  writeDirective(w, futureIso(120));
  const r = runOnce(w);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.deepEqual(readCalls(w), []);
  assert.equal(readDirectives(w)[w.project], undefined);
});

test("a directive does not relaunch over a live window", (t) => {
  const w = setup(t);
  const pid = spawnHung(t, w);
  fs.writeFileSync(w.lockPath, JSON.stringify({
    pid, mode: "dev",
    startedAt: new Date().toISOString(),
    windowEndsAt: new Date(Date.now() + 3600 * 1000).toISOString(),
  }));
  writeDirective(w, futureIso(120));
  const r = runOnce(w);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.deepEqual(readCalls(w), [], "must not launch while a window is running");
  assert.ok(readDirectives(w)[w.project], "directive must survive a running window");
});

test("relaunched run that skipped (waiting on owner) drops the directive and escalates exactly once", (t) => {
  const w = setup(t);
  writeDirective(w, futureIso(120));
  assert.equal(runOnce(w).status, 0); // pass 1: launches dev (recorder exits instantly)
  assert.equal(settleDevCalls(w, 1).length, 1);

  writeJournal(w, [
    { step: "window-start" },
    { step: "window-skipped", detail: "waiting on owner (2): T-041, T-042" },
  ]);
  assert.equal(runOnce(w).status, 0); // pass 2: sees the skip
  assert.equal(readCalls(w).filter((c) => c.argv[0] === "dev").length, 1, "must not relaunch after a skip");
  assert.equal(readDirectives(w)[w.project], undefined, "directive must be dropped after a skip");
  let esc = readEscalations(w).filter((e) => e.type === "waiting-on-owner");
  assert.equal(esc.length, 1, JSON.stringify(readEscalations(w)));
  assert.match(esc[0].detail, /T-041/);

  assert.equal(runOnce(w).status, 0); // pass 3: nothing left to do
  esc = readEscalations(w).filter((e) => e.type === "waiting-on-owner");
  assert.equal(esc.length, 1, "skip must escalate exactly once");
});

test("a skip that reports deadlock escalates as deadlocked", (t) => {
  const w = setup(t);
  writeDirective(w, futureIso(120));
  assert.equal(runOnce(w).status, 0);
  writeJournal(w, [
    { step: "window-start" },
    { step: "window-skipped", detail: "deadlocked — every open task is dependency-blocked: T-007" },
  ]);
  assert.equal(runOnce(w).status, 0);
  assert.equal(readEscalations(w).filter((e) => e.type === "deadlocked").length, 1, JSON.stringify(readEscalations(w)));
});

test("two consecutive launches with no sessions drop the directive and escalate relaunch-failed", (t) => {
  const w = setup(t);
  // Grace zeroed: this test is about the strike counter, not the launch grace.
  const noGrace = { SUPERVISOR_LAUNCH_GRACE_MS: "0" };
  writeDirective(w, futureIso(120));
  assert.equal(runOnce(w, noGrace).status, 0); // launch 1 — recorder runs no sessions, writes no journal
  assert.equal(runOnce(w, noGrace).status, 0); // strike 1 → launch 2
  assert.equal(runOnce(w, noGrace).status, 0); // strike 2 → drop + escalate
  const devs = settleDevCalls(w, 2);
  assert.equal(devs.length, 2, JSON.stringify(readCalls(w)));
  assert.equal(readDirectives(w)[w.project], undefined, "directive must be dropped after two failed launches");
  assert.equal(readEscalations(w).filter((e) => e.type === "relaunch-failed").length, 1, JSON.stringify(readEscalations(w)));
});

test("within the launch grace, a quiet just-launched run neither strikes nor relaunches", (t) => {
  const w = setup(t);
  writeDirective(w, futureIso(120));
  assert.equal(runOnce(w).status, 0); // launch 1
  assert.equal(settleDevCalls(w, 1).length, 1);
  // The launched driver spends minutes in replay + fetch before its first
  // lock/journal — passes inside the (default 15min) grace must wait.
  assert.equal(runOnce(w).status, 0);
  assert.equal(runOnce(w).status, 0);
  spawnSync("sleep", ["1"]); // let any buggy extra launch land its recorder line
  assert.equal(readCalls(w).filter((c) => c.argv[0] === "dev").length, 1, JSON.stringify(readCalls(w)));
  assert.ok(readDirectives(w)[w.project], "directive must survive the grace window");
  assert.deepEqual(readEscalations(w), []);
});

test("a new keep is not poisoned by an old skip journal or leftover strikes", (t) => {
  const w = setup(t);
  // Leftovers from a past directive: a tracked launch two hours ago with a
  // strike, and a skip journal newer than that launch (a scheduled window
  // skipped before the owner cleared the gated tasks).
  fs.mkdirSync(path.join(w.home, ".factory", "supervisor"), { recursive: true });
  fs.writeFileSync(path.join(w.home, ".factory", "supervisor", "state.json"), JSON.stringify({
    escalated: {},
    factories: { [w.project]: { lastLaunch: new Date(Date.now() - 2 * 3600 * 1000).toISOString(), strikes: 1 } },
  }));
  writeJournal(w, [
    { step: "window-start" },
    { step: "window-skipped", detail: "waiting on owner (1): T-001" },
  ]);
  const r = supervisorCli(w, ["keep", "--project", w.project, "--until", futureIso(120)]);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(runOnce(w).status, 0);
  assert.equal(settleDevCalls(w, 1).length, 1, "fresh keep must launch, not inherit the old skip");
  assert.ok(readDirectives(w)[w.project], "fresh keep must survive its first pass");
  assert.deepEqual(readEscalations(w), []);
});

test("a healthy relaunched window (journal has sessions) keeps the directive and relaunches again", (t) => {
  const w = setup(t);
  writeDirective(w, futureIso(120));
  assert.equal(runOnce(w).status, 0); // launch 1
  writeJournal(w, [
    { step: "window-start" },
    { step: "session", detail: "1 T-010 → completed" },
    { step: "finalize:complete" },
  ]);
  assert.equal(runOnce(w).status, 0); // healthy → launch 2
  writeJournal(w, [
    { step: "window-start" },
    { step: "session", detail: "2 T-011 → completed" },
    { step: "finalize:complete" },
  ]);
  assert.equal(runOnce(w).status, 0); // still healthy → launch 3 (no strike accumulation)
  const devs = settleDevCalls(w, 3);
  assert.equal(devs.length, 3, JSON.stringify(readCalls(w)));
  assert.ok(readDirectives(w)[w.project], "directive must survive healthy windows");
  assert.deepEqual(readEscalations(w), []);
});

// ---------- stuck-factory detection (item 50 chunk 2) ----------
// A scheduled+enabled factory whose last N=2 dev windows each aborted before
// running anything (no session, no clean window-skipped) is WEDGED, not idle —
// the dumb OnFailure net pings per-failure but can't tell that apart from a
// blip. Dev windows are the only mode that writes journal-*.jsonl.
const SCHEDULED = {
  schedule: { kind: "systemd", timezone: "UTC", modes: { dev: { time: "02:00", days: "Mon-Sun" } } },
};
// seq drives the embedded window-start timestamp so newest-window ordering is
// deterministic (the driver names journals by window-start time).
const writeDevJournal = (w, seq, steps) => {
  const ts = new Date(Date.UTC(2026, 0, 1, 0, seq, 0)).toISOString().replace(/[:.]/g, "-");
  const p = path.join(w.sd, "log", `journal-${ts}.jsonl`);
  fs.writeFileSync(p, steps.map((s) => JSON.stringify({ ts: new Date().toISOString(), status: "done", ...s })).join("\n") + "\n");
  return p;
};
const ABORTED = [{ step: "window-start" }];
const SKIPPED = [{ step: "window-start" }, { step: "window-skipped", detail: "backlog complete — nothing left to build" }];
const WORKED = [{ step: "window-start" }, { step: "session", detail: "1 T-010 → died" }, { step: "finalize:complete" }];
const stuckEsc = (w) => readEscalations(w).filter((e) => e.type === "factory-stuck");

test("two consecutive aborted dev windows escalate factory-stuck exactly once", (t) => {
  const w = setup(t, { config: SCHEDULED });
  writeDevJournal(w, 1, ABORTED);
  writeDevJournal(w, 2, ABORTED);

  assert.equal(runOnce(w).status, 0);
  assert.equal(stuckEsc(w).length, 1, JSON.stringify(readEscalations(w)));
  assert.equal(stuckEsc(w)[0].project, w.project);
  assert.equal(stuckEsc(w)[0].name, "proj");

  assert.equal(runOnce(w).status, 0); // same streak → deduped
  assert.equal(stuckEsc(w).length, 1, "stuck must escalate once per streak");
});

test("a single aborted dev window does not escalate factory-stuck", (t) => {
  const w = setup(t, { config: SCHEDULED });
  writeDevJournal(w, 1, WORKED);
  writeDevJournal(w, 2, ABORTED);

  assert.equal(runOnce(w).status, 0);
  assert.deepEqual(stuckEsc(w), [], "one abort is not a wedge");
});

test("windows that cleanly skip (waiting-on-owner / backlog-complete) are never stuck", (t) => {
  const w = setup(t, { config: SCHEDULED });
  writeDevJournal(w, 1, SKIPPED);
  writeDevJournal(w, 2, SKIPPED);

  assert.equal(runOnce(w).status, 0);
  assert.deepEqual(stuckEsc(w), [], "a correctly-idle factory must not alarm");
});

test("a session-bearing window resets the stuck streak", (t) => {
  const w = setup(t, { config: SCHEDULED });
  writeDevJournal(w, 1, ABORTED);
  writeDevJournal(w, 2, WORKED);  // recovered
  writeDevJournal(w, 3, ABORTED); // newest streak length = 1

  assert.equal(runOnce(w).status, 0);
  assert.deepEqual(stuckEsc(w), []);
});

test("a disabled or manual-schedule factory is never checked for stuck", (t) => {
  const disabled = setup(t, { config: { ...SCHEDULED, enabled: false } });
  writeDevJournal(disabled, 1, ABORTED);
  writeDevJournal(disabled, 2, ABORTED);
  assert.equal(runOnce(disabled).status, 0);
  assert.deepEqual(stuckEsc(disabled), [], "disabled factory must not alarm");

  const manual = setup(t, { config: { schedule: { kind: "manual" } } });
  writeDevJournal(manual, 1, ABORTED);
  writeDevJournal(manual, 2, ABORTED);
  assert.equal(runOnce(manual).status, 0);
  assert.deepEqual(stuckEsc(manual), [], "manual factory must not alarm");
});

test("a live in-progress window is not judged stuck", (t) => {
  const w = setup(t, { config: SCHEDULED });
  const pid = spawnHung(t, w);
  fs.writeFileSync(w.lockPath, JSON.stringify({
    pid, mode: "dev",
    startedAt: new Date().toISOString(),
    windowEndsAt: new Date(Date.now() + 3600 * 1000).toISOString(), // healthy: checkFactory leaves it
  }));
  writeDevJournal(w, 1, ABORTED);
  writeDevJournal(w, 2, ABORTED);

  assert.equal(runOnce(w).status, 0);
  assert.deepEqual(stuckEsc(w), [], "must not judge a window that is still running");
});

test("a growing stuck streak still escalates only once", (t) => {
  const w = setup(t, { config: SCHEDULED });
  writeDevJournal(w, 1, ABORTED);
  writeDevJournal(w, 2, ABORTED);
  assert.equal(runOnce(w).status, 0);
  assert.equal(stuckEsc(w).length, 1, JSON.stringify(readEscalations(w)));

  // The wedge persists — the next scheduled window also aborts.
  writeDevJournal(w, 3, ABORTED);
  assert.equal(runOnce(w).status, 0);
  assert.equal(stuckEsc(w).length, 1, "a lengthening streak must not re-alert");
});

test("a recovery then a fresh wedge escalates a second time", (t) => {
  const w = setup(t, { config: SCHEDULED });
  writeDevJournal(w, 1, ABORTED);
  writeDevJournal(w, 2, ABORTED);
  assert.equal(runOnce(w).status, 0);
  assert.equal(stuckEsc(w).length, 1);

  // A window recovers, then a brand-new 2-window wedge begins.
  writeDevJournal(w, 3, WORKED);
  writeDevJournal(w, 4, ABORTED);
  writeDevJournal(w, 5, ABORTED);
  assert.equal(runOnce(w).status, 0);
  assert.equal(stuckEsc(w).length, 2, "a new streak after a recovery must alert again");
});

test("no Telegram creds anywhere: the outbox is still written and the pass exits clean", (t) => {
  const w = setup(t);
  const pid = spawnHung(t, w);
  fs.writeFileSync(w.lockPath, JSON.stringify({
    pid, mode: "dev",
    startedAt: new Date(Date.now() - 6 * 3600 * 1000).toISOString(),
    windowEndsAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
  }));
  const r = runOnce(w);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(readEscalations(w).length, 1);
});
