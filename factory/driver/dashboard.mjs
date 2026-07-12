#!/usr/bin/env node
// Factory dashboard — local web UI over the file state of every registered
// factory on this machine. Zero deps. Reads are file-state + `gh` reads for
// PR/issue status (cached 2 min). The ONE mutation is POST /api/run — start
// a dev window / single task / triage for a factory — and it is disabled
// unless the dashboard runs with --token.
//
//   node dashboard.mjs [--port 7788] [--listen <addr>] [--token <secret>]
//
// Config: ~/.factory/dashboard.json ({port, listen, token} — all optional)
// supplies these; CLI flags override it (backward compatible — tests and
// one-off runs use flags). A machine-agnostic unit file can then run the
// dashboard flagless, keeping the token out of `ps`-visible argv.
//
// Factories come from ~/.factory/registry.json (init.mjs registers them).
// --listen: bind address. Default 127.0.0.1 (local only). On a VPS, bind the
//   Tailscale interface (--listen 100.x.y.z, or "listen": "tailscale" in the
//   config to resolve it at startup) — never 0.0.0.0 on a public box;
//   network-level identity (the tailnet) is the primary auth.
// --token: defense-in-depth for reads. When set, requests need
//   ?token=<secret> (or Authorization: Bearer <secret>). REQUIRED for every
//   mutation (run/stop/resume/enable): no token, no mutation surface.

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile, execFileSync, spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { stateDir } from "./paths.mjs";
import { normalizeSchedule, nextFire } from "./schedule.mjs";
import { deriveFactoryStatus } from "./status.mjs";

// ---------- config: file < flags, each setting tracks its source ----------
const CONFIG_PATH = path.join(os.homedir(), ".factory", "dashboard.json");
let port = 7788, listen = "127.0.0.1", token = null;
const src = { port: "default", listen: "default", token: "default" };

let fileCfg = null; // reading an optional config file is a system boundary
try { fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch { /* absent/unreadable → defaults */ }
if (fileCfg && typeof fileCfg === "object") {
  if (fileCfg.port !== undefined) { port = Number(fileCfg.port); src.port = "file"; }
  if (fileCfg.listen !== undefined) { listen = String(fileCfg.listen); src.listen = "file"; }
  if (fileCfg.token !== undefined && fileCfg.token !== null) { token = String(fileCfg.token); src.token = "file"; }
}

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--port") { port = Number(argv[++i]); src.port = "flag"; }
  else if (argv[i] === "--listen") { listen = argv[++i]; src.listen = "flag"; }
  else if (argv[i] === "--token") { token = argv[++i]; src.token = "flag"; }
}

// A token file readable by group/other leaks the secret at rest — name the fix,
// but never chmod for the operator.
if (src.token === "file") {
  try {
    if (fs.statSync(CONFIG_PATH).mode & 0o077) {
      process.stderr.write(`warning: ${CONFIG_PATH} is group/other-readable and holds a token — chmod 600 ${CONFIG_PATH}\n`);
    }
  } catch { /* stat race — ignore */ }
}

// "listen": "tailscale" → the machine's tailnet IPv4, resolved once at startup.
// The operator declared an intent: honor it or stop — never widen the bind.
if (listen === "tailscale") {
  try {
    const ip = execFileSync("tailscale", ["ip", "-4"], { encoding: "utf8", timeout: 5_000 }).trim().split("\n")[0].trim();
    if (!ip) throw new Error("`tailscale ip -4` returned nothing");
    listen = ip;
  } catch (e) {
    process.stderr.write(`fatal: listen="tailscale" but the Tailscale IPv4 could not be resolved (${e.message}).\n` +
      `Start tailscaled or set "listen" to an explicit address in ${CONFIG_PATH}.\n`);
    process.exit(1);
  }
}

const tokenOk = (req) => {
  if (!token) return true;
  const url = new URL(req.url, "http://x");
  const given = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("token") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};

const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
};

const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// git@github.com:u/r.git | https://github.com/u/r.git -> https://github.com/u/r
const repoWebUrl = (project) => {
  try {
    const conf = fs.readFileSync(path.join(project, ".git", "config"), "utf8");
    const m = conf.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/);
    if (!m) return null;
    let u = m[1].replace(/\.git$/, "");
    const ssh = u.match(/^git@([^:]+):(.+)$/);
    if (ssh) u = `https://${ssh[1]}/${ssh[2]}`;
    return u.startsWith("http") ? u : null;
  } catch { return null; }
};

const parseBacklog = (factoryDir) => {
  const dir = path.join(factoryDir, "backlog");
  const milestones = [];
  const tasks = [];
  const indexPath = path.join(dir, "index.md");
  if (!fs.existsSync(indexPath)) return { milestones, tasks };
  let current = null;
  for (const line of fs.readFileSync(indexPath, "utf8").split("\n")) {
    const m = line.match(/^##\s+(M\d+)[:\s]+(.*?)\s*(?:—\s*(\S+))?\s*$/);
    if (m) { current = { id: m[1], name: m[2], status: m[3] ?? "", epics: [] }; milestones.push(current); continue; }
    const e = line.match(/^-\s+(E\d+)\s+(\S+)\s+—\s+(\S+)/);
    if (e && current) current.epics.push({ id: e[1], name: e[2], file: e[3] });
  }
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "index.md")) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    for (const block of text.split(/^## /m).slice(1)) {
      const head = block.match(/^(T-[\w-]+):\s*(.*)/);
      if (!head) continue;
      const status = block.match(/- Status:\s*(\S+)/)?.[1] ?? "todo";
      const links = [...block.matchAll(/https?:\/\/\S+/g)].map((x) => x[0].replace(/[).,]$/, ""));
      const model = block.match(/- Model:\s*(\S+)/)?.[1] ?? null;
      const effort = block.match(/- Effort:\s*(\S+)/)?.[1] ?? null;
      // The issue a session filed for this task (driver writes `- Question:`
      // under the Status line) — the needs-human pill links straight to it.
      // http(s) only: this lands in an href, and backlog files are written
      // by autonomous sessions — a bare \S+ would let a `javascript:` token
      // ride into the owner's click.
      const question = block.match(/- Question:\s*(https?:\/\/\S+)/)?.[1] ?? null;
      tasks.push({ id: head[1], title: head[2].trim(), status, epic: f.replace(".md", ""), links, model, effort, question });
    }
  }
  return { milestones, tasks };
};

const DAYS_SHOWN = 14;

const usageSummary = (factoryDir) => {
  const p = path.join(factoryDir, "log", "usage.jsonl");
  const sum = { todayCost: 0, totalCost: 0, todayTokens: 0, totalTokens: 0, todaySessions: 0, totalSessions: 0,
    todayTurnCapped: 0, todayDied: 0, todayModels: {}, days: [] };
  const dayIndex = new Map();
  for (let i = DAYS_SHOWN - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    dayIndex.set(d, sum.days.push({ date: d, cost: 0 }) - 1);
  }
  if (!fs.existsSync(p)) return sum;
  const today = new Date().toISOString().slice(0, 10);
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    const tokens = (r.inputTokens ?? 0) + (r.outputTokens ?? 0) + (r.cacheReadTokens ?? 0) + (r.cacheCreateTokens ?? 0);
    sum.totalCost += r.costUsd ?? 0;
    sum.totalTokens += tokens;
    sum.totalSessions += 1;
    const day = r.ts?.slice(0, 10);
    if (dayIndex.has(day)) sum.days[dayIndex.get(day)].cost += r.costUsd ?? 0;
    if (day === today) {
      sum.todayCost += r.costUsd ?? 0;
      sum.todayTokens += tokens;
      sum.todaySessions += 1;
      if (r.status === "turn-capped") sum.todayTurnCapped += 1;
      if (r.status === "died" || r.status === "timeout") sum.todayDied += 1;
      if (r.model) sum.todayModels[r.model] = (sum.todayModels[r.model] ?? 0) + 1;
    }
  }
  return sum;
};

// ---------- GitHub facts (via gh, background-cached) ----------
// The 5s UI tick must never wait on the network: refresh runs on its own
// interval and factoryState only reads the cache. Read-only gh calls.

const GH_REFRESH_MS = 120_000;
const ghCache = new Map(); // project -> { fetchedAt, error, prs, needsHuman, dailyLogUrl }

const ghJson = (project, args) => new Promise((resolve) => {
  execFile("gh", args, { cwd: project, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) {
      const reason = err.code === "ENOENT" ? "gh not installed"
        : (String(stderr ?? "").trim() || err.message || "gh failed").split("\n")[0].slice(0, 120);
      resolve({ error: reason });
      return;
    }
    try { resolve({ data: JSON.parse(stdout) }); } catch { resolve({ error: "unparseable gh output" }); }
  });
});

// SUCCESS/FAILURE/… per check -> one chip per PR.
const prChecks = (pr) => {
  const checks = pr.statusCheckRollup ?? [];
  if (!checks.length) return "none";
  if (checks.some((c) => ["FAILURE", "ERROR", "TIMED_OUT", "STARTUP_FAILURE"].includes(c.conclusion))) return "fail";
  if (checks.some((c) => c.status && c.status !== "COMPLETED")) return "pending";
  return "pass";
};

// needs-human by label when present, by the "[factory] question" title
// convention otherwise (sessions can't always create labels).
const isNeedsHuman = (issue) =>
  (issue.labels ?? []).some((l) => l.name === "needs-human") ||
  /^\[factory\] question/i.test(issue.title ?? "");

const gitIn = (cwd, args) => new Promise((resolve) => {
  execFile("git", args, { cwd, timeout: 20_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
    resolve(err ? null : stdout.trim());
  });
});

// ---------- stale-clone guard ----------
// The dashboard reads file state from the LOCAL clone; when its base branch
// is behind origin (a remote machine's window merged work), that picture is
// partial and mutations could act on it. Verdict: current only when the
// local base head CONTAINS origin's head (read via gh api — no fetch, so the
// clone itself is never touched). Every failure is null (unknown) and the
// guard only bites on a positive "behind" — a gh outage must not lock the
// owner out. Accepted residual gap: a clone pulled fresh during a remote
// mid-window still looks current.
const cloneCurrency = async (project) => {
  const base = readJson(path.join(stateDir(project), "config.json"))?.baseBranch ?? "main";
  const localSha = await gitIn(project, ["rev-parse", base]);
  if (!localSha) return null;
  const remote = await ghJson(project, ["api", `repos/{owner}/{repo}/branches/${base}`]);
  const remoteSha = remote.data?.commit?.sha;
  if (!remoteSha) return null;
  const behind = localSha === remoteSha ? false
    : (await gitIn(project, ["merge-base", "--is-ancestor", remoteSha, base])) === null;
  return { base, localSha, remoteSha, behind };
};

const refreshGh = async (project) => {
  if (!fs.existsSync(path.join(project, ".git"))) return;
  const prs = await ghJson(project, ["pr", "list", "--state", "open",
    "--json", "number,title,url,isDraft,headRefName,statusCheckRollup"]);
  const issues = await ghJson(project, ["issue", "list", "--state", "open",
    "--json", "number,title,url,labels"]);
  const entry = {
    fetchedAt: new Date().toISOString(),
    error: prs.error ?? issues.error ?? null,
    prs: [], needsHuman: [], dailyLogUrl: null,
    clone: await cloneCurrency(project),
  };
  if (!prs.error) {
    entry.prs = prs.data.map((p) => ({
      number: p.number, title: p.title, url: p.url, draft: p.isDraft,
      branch: p.headRefName, checks: prChecks(p),
    }));
  }
  if (!issues.error) {
    entry.needsHuman = issues.data.filter(isNeedsHuman)
      .map((i) => ({ number: i.number, title: i.title, url: i.url }));
    entry.dailyLogUrl = issues.data.find((i) => /^\[factory\] daily log/i.test(i.title ?? ""))?.url ?? null;
  }
  ghCache.set(project, entry);
};

const refreshAllGh = async () => {
  for (const p of Object.keys(registry().factories ?? {})) {
    try { await refreshGh(p); } catch { /* retry next round */ }
  }
};

// ---------- scaffold currency (per card, local reads only) ----------
// Transition-era check: projects that still carry pre-migrate scaffold copies
// (guard, spec template) drift when the checkout advances — byte-compare them
// against the checkout the dashboard runs from. A project with NO copy is the
// post-P2 shape (tooling is injected into worktrees, nothing to drift) and is
// current by definition; if the checkout source is absent we can't judge.
const CHECKOUT_DIR = path.dirname(fileURLToPath(import.meta.url)); // …/factory/driver
const SCAFFOLD_FILES = [
  { name: "guard.mjs", source: path.join(CHECKOUT_DIR, "hooks", "guard.mjs"), rel: path.join("hooks", "guard.mjs") },
  { name: "spec-template.md", source: path.join(CHECKOUT_DIR, "..", "templates", "spec-template.md"), rel: "spec-template.md" },
];

const bytesEqual = (a, b) => {
  try { return Buffer.compare(fs.readFileSync(a), fs.readFileSync(b)) === 0; } catch { return false; }
};

const scaffoldCurrency = (factoryDir) => {
  const files = [];
  for (const f of SCAFFOLD_FILES) {
    const copy = path.join(factoryDir, f.rel);
    if (!fs.existsSync(copy)) continue; // no copy = migrated, nothing to drift
    if (!fs.existsSync(f.source)) continue; // can't compare — skip
    if (!bytesEqual(f.source, copy)) files.push(f.name);
  }
  return { stale: files.length > 0, files };
};

// ---------- checkout version currency (header, background-cached) ----------
// Which commit the dashboard's own checkout is on, and how far behind origin's
// default branch. The `git fetch` is network — it runs here on a slow interval,
// never on the UI tick. Any git/network failure caches an {error} and the page
// renders "version unknown" rather than breaking. Same path covers the VPS
// runtime (~/.factory/runtime) and a dev-Mac clone.
const VERSION_REFRESH_MS = 1_800_000; // 30 min
let versionCache = null;

const gitOut = (args) => new Promise((resolve) => {
  execFile("git", args, { cwd: CHECKOUT_DIR, timeout: 20_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
    resolve(err ? null : stdout.trim());
  });
});

const refreshVersion = async () => {
  const sha = await gitOut(["rev-parse", "--short", "HEAD"]);
  if (sha === null) { versionCache = { error: "not a git checkout" }; return; }
  const branch = (await gitOut(["rev-parse", "--abbrev-ref", "origin/HEAD"]))?.replace(/^origin\//, "") || "main";
  const deploy = readJson(path.join(os.homedir(), ".factory", "runtime-deploy.json"));
  const lastDeploy = deploy?.ts ?? null;
  if ((await gitOut(["fetch", "origin", branch, "--quiet"])) === null) {
    versionCache = { sha, branch, error: "fetch failed", lastDeploy };
    return;
  }
  const behindStr = await gitOut(["rev-list", "--count", `HEAD..origin/${branch}`]);
  // A failed rev-list means we don't know the distance — render "unknown",
  // never a false "current": the chip's only value is being trustworthy.
  if (behindStr === null) { versionCache = { sha, branch, error: "rev-list failed", lastDeploy }; return; }
  const behind = Number(behindStr);
  versionCache = { sha, branch, behind, current: behind === 0, lastDeploy };
};

const factoryState = (project, meta) => {
  const F = path.join(project, ".factory"); // work data (backlog) in the repo
  const S = stateDir(project); // machine-side state (config, log, STOP, …)
  if (!fs.existsSync(F)) return { path: project, name: meta?.name ?? path.basename(project), status: "missing" };
  const lock = readJson(path.join(S, "log", "window.lock"));
  const running = lock && pidAlive(lock.pid);
  const stopped = fs.existsSync(path.join(S, "STOP"));
  const config = readJson(path.join(S, "config.json"));
  const { milestones, tasks } = parseBacklog(F);
  // Runtime status overlay (NOTES item 24): in-progress/review live in
  // state.json, not the backlog files. File-status `done` wins.
  const runtime = readJson(path.join(S, "log", "state.json"))?.tasks ?? {};
  for (const t of tasks) {
    const rt = runtime[t.id];
    if (rt?.status && rt.status !== t.status && t.status !== "done") t.status = rt.status;
  }
  // Derived factory status (PR-C predicate, post-overlay): "idle with only
  // gated work" must read as waiting-on-owner, never plain idle. An empty
  // backlog is "normal" — no tasks is not the same claim as "all done".
  const derived = tasks.length ? deriveFactoryStatus(tasks) : { status: "normal", detail: null };
  const doctor = readJson(path.join(S, "log", "doctor.json"));
  const logFile = path.join(S, "log", `factory-${new Date().toISOString().slice(0, 10)}.log`);
  const logLines = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n") : [];
  const logTail = logLines.slice(-6);
  // Merge-gate activity: driver-side merges are invisible in usage.jsonl
  // (no session, no cost) — surface them from today's driver log.
  const gateLines = logLines.filter((l) => l.includes("merge-gate:"));
  const gate = {
    merged: gateLines.filter((l) => l.includes("merge-gate: checks green")).length,
    left: gateLines.filter((l) => /leaving|still pending/.test(l)).length,
    last: gateLines.at(-1) ?? null,
  };
  return {
    path: project,
    name: meta?.name ?? path.basename(project),
    status: running ? "running" : stopped ? "stopped" : config?.enabled === false ? "disabled" : "idle",
    lock: running ? lock : null,
    config,
    // Declared operational state (NOTES item 47), surfaced for chips + the
    // enable/disable control. `enabled` passes through raw so a missing or
    // non-boolean value (doctor 11b would fail) shows a warning chip.
    enabled: config?.enabled ?? null,
    // The chip shows the KIND; since P3 the declaration may be a block
    // (kind/timezone/modes) instead of the legacy string.
    schedule: (typeof config?.schedule === "object" ? config.schedule?.kind : config?.schedule) ?? null,
    // Soonest declared fire (null for manual, legacy kind-only, or a broken
    // declaration) — the card renders "next <mode> HH:MM" from it.
    nextWindow: nextFire(normalizeSchedule(config?.schedule)),
    derived,
    scaffold: scaffoldCurrency(F),
    milestones,
    tasks,
    lastSession: readJson(path.join(S, "log", "last-session.json")),
    doctor,
    usage: usageSummary(S),
    repoUrl: repoWebUrl(project),
    gh: ghCache.get(project) ?? null,
    gate,
    logTail,
  };
};

const registry = () => readJson(path.join(os.homedir(), ".factory", "registry.json")) ?? { factories: {} };

// ---------- start-now (NOTES item 19) ----------
// Spawn the driver detached so it outlives the dashboard process. Spawn-level
// output goes to .factory/log/dashboard-run.log (the driver keeps its own
// factory-<date>.log once it's up); the driver's lock file + concurrency
// guard remain the authority on "already running".
const DRIVER = fileURLToPath(new URL("factory.mjs", import.meta.url));

const startRun = (project, mode, sessions) => {
  const args = [DRIVER, mode, "--project", project];
  if (sessions) args.push("--max-sessions", String(sessions));
  const logDir = path.join(stateDir(project), "log");
  fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(path.join(logDir, "dashboard-run.log"), "a");
  fs.writeSync(out, `[${new Date().toISOString()}] dashboard start: ${mode}${sessions ? ` --max-sessions ${sessions}` : ""}\n`);
  const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", out, out] });
  child.unref();
  fs.closeSync(out);
  return child.pid;
};

// Stale-clone mutation gate: a clone KNOWN to be behind origin gives a
// partial picture — refuse run/stop/enabled against it (resume stays open:
// removing a STOP the owner placed needs no current picture). Unknown
// currency (gh down, no origin) never blocks.
const cloneBehind = (project) => ghCache.get(project)?.clone?.behind === true;
const CLONE_BEHIND_MSG = "local clone is behind origin — partial picture; pull the clone before mutating";

const handleRun = (req, res) => {
  const deny = (code, msg) => { res.writeHead(code, { "content-type": "text/plain" }); res.end(msg); };
  if (!token) return deny(403, "starting runs requires the dashboard to be launched with --token");
  const sp = new URL(req.url, "http://x").searchParams;
  const project = path.resolve(sp.get("factory") ?? "");
  const mode = sp.get("mode") ?? "dev";
  const sessions = sp.get("sessions") ? Number(sp.get("sessions")) : null;
  if (!(project in (registry().factories ?? {}))) return deny(404, "unknown factory");
  if (cloneBehind(project)) return deny(409, CLONE_BEHIND_MSG);
  if (!["dev", "triage"].includes(mode)) return deny(400, "mode must be dev or triage");
  if (sessions !== null && (!Number.isInteger(sessions) || sessions < 1)) return deny(400, "sessions must be a positive integer");
  if (fs.existsSync(path.join(stateDir(project), "STOP"))) return deny(409, "STOP file present — remove it first");
  if (readJson(path.join(stateDir(project), "config.json"))?.enabled === false) {
    return deny(409, 'factory is disabled (config.json "enabled": false) — set it true to start runs');
  }
  const lock = readJson(path.join(stateDir(project), "log", "window.lock"));
  if (lock && pidAlive(lock.pid)) return deny(409, `already running (pid ${lock.pid}, mode ${lock.mode})`);
  const pid = startRun(project, mode, sessions);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, pid }));
};

// ---------- file-state mutations (stop / resume / enable) ----------
// Every mutation the dashboard performs is a file the driver already honors:
// `.factory/STOP` (graceful stop at the next session boundary) and
// `config.json → enabled` (the declared OFF switch). No process is ever
// killed, no systemd unit touched, nothing interpolated into a shell.

// Resolve + registry-check the ?factory= param shared by every mutation.
const resolveFactory = (req) => {
  const project = path.resolve(new URL(req.url, "http://x").searchParams.get("factory") ?? "");
  if (!(project in (registry().factories ?? {}))) return { error: { code: 404, msg: "unknown factory" } };
  return { project };
};

// Shared preamble: token gate (403 when the dashboard has no token) then
// registry validation. Returns the factory dir, or null after replying.
const mutationTarget = (req, res) => {
  const deny = (code, msg) => { res.writeHead(code, { "content-type": "text/plain" }); res.end(msg); };
  if (!token) { deny(403, "mutations require the dashboard to be launched with a token"); return null; }
  const { project, error } = resolveFactory(req);
  if (error) { deny(error.code, error.msg); return null; }
  // Every mutation is a machine-side file — the dashboard never writes a repo.
  return { project, deny, F: stateDir(project) };
};

const handleStop = (req, res) => {
  const t = mutationTarget(req, res);
  if (!t) return;
  if (cloneBehind(t.project)) return t.deny(409, CLONE_BEHIND_MSG);
  const stopFile = path.join(t.F, "STOP");
  if (fs.existsSync(stopFile)) return t.deny(409, "STOP already present");
  fs.writeFileSync(stopFile, `stopped from dashboard at ${new Date().toISOString()}\n`);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, stopped: true }));
};

const handleResume = (req, res) => {
  const t = mutationTarget(req, res);
  if (!t) return;
  const stopFile = path.join(t.F, "STOP");
  if (!fs.existsSync(stopFile)) return t.deny(409, "no STOP file to remove");
  fs.rmSync(stopFile);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, resumed: true }));
};

const handleEnabled = (req, res) => {
  const t = mutationTarget(req, res);
  if (!t) return;
  if (cloneBehind(t.project)) return t.deny(409, CLONE_BEHIND_MSG);
  const value = new URL(req.url, "http://x").searchParams.get("value");
  if (value !== "true" && value !== "false") return t.deny(400, "value must be true or false");
  const cfgPath = path.join(t.F, "config.json");
  let conf; // never invent a config file — 409 if it's missing or unparseable
  try { conf = JSON.parse(fs.readFileSync(cfgPath, "utf8")); }
  catch { return t.deny(409, "config.json is missing or unparseable — the dashboard never invents one"); }
  if (conf === null || typeof conf !== "object" || Array.isArray(conf)) return t.deny(409, "config.json is not a JSON object");
  conf.enabled = value === "true"; // preserve every other key + init.mjs formatting
  const tmp = cfgPath + ".tmp"; // atomic: write tmp in the same dir, rename over
  fs.writeFileSync(tmp, JSON.stringify(conf, null, 2) + "\n");
  fs.renameSync(tmp, cfgPath);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, enabled: conf.enabled }));
};

const state = () => ({
  generatedAt: new Date().toISOString(),
  host: os.hostname(),
  canRun: Boolean(token), // mutations are disabled without a token
  version: versionCache, // checkout currency (background-cached; may be null early)
  factories: Object.entries(registry().factories ?? {}).map(([p, meta]) => factoryState(p, meta)),
});

// Driver log grouped into session blocks, newest first — registered factories only.
const driverLogSessions = (project, maxLines = 800) => {
  if (!(project in (registry().factories ?? {}))) return null;
  const logDir = path.join(stateDir(project), "log");
  if (!fs.existsSync(logDir)) return { file: null, sessions: [] };
  const newest = fs.readdirSync(logDir)
    .filter((f) => f.startsWith("factory-") && f.endsWith(".log"))
    .map((f) => ({ f, m: fs.statSync(path.join(logDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)[0];
  if (!newest) return { file: null, sessions: [] };
  const lines = fs.readFileSync(path.join(logDir, newest.f), "utf8").trimEnd().split("\n").slice(-maxLines);

  const blocks = [];
  let current = { title: "window", lines: [] };
  const ts = (line) => line.match(/^\[([^\]]+)\]/)?.[1]?.slice(11, 16) ?? "";
  for (const line of lines) {
    const start = line.match(/(session \d+) starting|((?:dev|triage|report)) (?:window |session )?starting/);
    if (start) {
      if (current.lines.length) blocks.push(current);
      current = { title: `${start[1] ?? start[2]} · ${ts(line)}`, lines: [line] };
      continue;
    }
    current.lines.push(line);
    // Outcome lines enrich the block title.
    const done = line.match(/session \d+ (done|ended) \(([^)]*)\)(?::? (.*))?/);
    if (done) current.title += ` — ${done[1]} (${done[2]})${done[3] ? " " + done[3].slice(0, 90) : ""}`;
    const usage = line.match(/session usage: (\$[\d.]+, \d+ turns)/);
    if (usage) current.title += ` · ${usage[1]}`;
    if (line.includes("merge-gate: checks green")) current.title += " · ⛙ gate-merged";
  }
  if (current.lines.length) blocks.push(current);
  return { file: newest.f, sessions: blocks.reverse() };
};

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>code4food · factory</title>
<style>
:root{
  --canvas:#f6f7f9;--surface:#fff;--elev:#fff;--hair:#e8e9ec;--hair2:#dcdee3;
  --ink:#16181d;--body:#565a63;--mute:#888d97;--mark:#16181d;
  --accent:#3b6fe6;--accent-soft:#5b8cff;--accent-dim:rgba(59,111,230,.10);
  --good:#1a7f37;--warn:#9a6700;--danger:#cf222e;
  --display:"Nunito",ui-rounded,"SF Pro Rounded","Segoe UI",system-ui,sans-serif;
  --sans:"Inter",system-ui,-apple-system,"Segoe UI",sans-serif;
  --mono:"JetBrains Mono",ui-monospace,Menlo,monospace}
@media(prefers-color-scheme:dark){:root{
  --canvas:#0a0a0a;--surface:#141414;--elev:#191919;--hair:#222;--hair2:#2e2e2e;
  --ink:#efefef;--body:#8c8c8c;--mute:#6f6f6f;--mark:#1c1c1c;
  --accent:#5b8cff;--accent-soft:#83a6ff;--accent-dim:rgba(91,140,255,.14);
  --good:#3fb950;--warn:#d29922;--danger:#f85149}}
*{box-sizing:border-box;margin:0}
body{font-family:var(--sans);font-size:13px;line-height:1.5;background:var(--canvas);color:var(--ink);-webkit-font-smoothing:antialiased}
.mono{font-family:var(--mono)}.mute{color:var(--mute)}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.app{display:grid;grid-template-columns:230px 1fr;min-height:100vh}
.side{position:sticky;top:0;height:100vh;border-right:1px solid var(--hair);background:var(--surface);display:flex;flex-direction:column;padding:16px 14px;gap:3px}
.brand{display:flex;align-items:center;gap:9px;padding:4px 6px 14px}
.brand .wm{font-family:var(--display);font-weight:800;font-size:16px;letter-spacing:-.01em}
.brand .wm b{color:var(--accent);font-weight:800}
.brand .tag2{font-family:var(--mono);font-size:10px;color:var(--mute);border:1px solid var(--hair2);border-radius:5px;padding:2px 5px}
.navlbl{font-size:10px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--mute);padding:14px 8px 5px}
.nav{display:flex;align-items:center;gap:9px;padding:7px 9px;border-radius:8px;color:var(--body);font-weight:500;cursor:pointer;user-select:none}
.nav:hover{background:var(--accent-dim);color:var(--ink)}
.nav.on{background:var(--accent-dim);color:var(--accent);font-weight:600}
.nav .ni{width:15px;height:15px;flex:none;opacity:.85}
.nav .ct{margin-left:auto;font-family:var(--mono);font-size:11px;color:var(--mute)}
.nav.on .ct{color:var(--accent)}
.sfoot{margin-top:auto;padding:10px 8px 2px;border-top:1px solid var(--hair);font-size:11px;color:var(--mute);display:flex;flex-direction:column;gap:3px}
.sfoot .mono{color:var(--body)}
.main{min-width:0;padding:20px 26px 60px}
.top{display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap;margin-bottom:20px}
.top h1{font-family:var(--display);font-weight:800;font-size:22px;letter-spacing:-.02em}
.crumb{color:var(--mute);font-size:12.5px;margin-top:3px}
.rt{margin-left:auto;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ver{font-family:var(--mono);font-size:11.5px;font-weight:500;padding:5px 10px;border-radius:99px;border:1px solid var(--hair2);color:var(--body);display:inline-flex;align-items:center;gap:7px}
.ver.behind{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 45%,var(--hair2))}
.ver.ok{color:var(--good)}
.ver .vd{width:6px;height:6px;border-radius:99px;background:currentColor}
.upd{font-size:11.5px;color:var(--mute)}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:18px}
.kpi{background:var(--surface);border:1px solid var(--hair);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:2px;min-width:0}
.kpi .kl{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--mute)}
.kpi .kn{font-family:var(--display);font-weight:800;font-size:26px;line-height:1.12;letter-spacing:-.01em}
.kpi .ks{font-size:11.5px;color:var(--body)}
.kpi.alert .kn{color:var(--danger)}
.sparkwrap{margin-top:4px}
.spark{display:block;width:100%;height:40px}
.panel{background:var(--surface);border:1px solid var(--hair);border-radius:12px;overflow:hidden}
.ptitle{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--hair)}
.ptitle h2{font-family:var(--display);font-weight:700;font-size:14px}
.pcount{margin-left:auto;font-size:11.5px;color:var(--mute);font-family:var(--mono)}
.thead,.rg{display:grid;grid-template-columns:minmax(180px,1.5fr) 108px 128px 128px 58px 70px minmax(140px,1fr) 28px;align-items:center;gap:12px}
.nw{display:block;font-size:11px;color:var(--mute);margin-top:2px;white-space:nowrap}
.thead{padding:9px 16px;border-bottom:1px solid var(--hair);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--mute)}
.thead .r{text-align:right}
.row{border-bottom:1px solid var(--hair)}
.row:last-child{border-bottom:none}
.rg{padding:11px 16px;cursor:pointer;list-style:none}
.rg::-webkit-details-marker{display:none}
.row:hover>.rg{background:var(--accent-dim)}
.row[open]>.rg{background:color-mix(in srgb,var(--accent-dim) 60%,transparent)}
.c-fac{display:flex;align-items:center;gap:8px;min-width:0}
.sd{width:7px;height:7px;border-radius:99px;background:var(--mute);flex:none}
.running .sd{background:var(--good);box-shadow:0 0 0 3px color-mix(in srgb,var(--good) 22%,transparent)}
.idle .sd{background:var(--accent)}.stopped .sd{background:var(--warn)}.disabled .sd{background:var(--mute);opacity:.5}.missing .sd{background:var(--danger)}
.fn{font-weight:650;font-size:13.5px;white-space:nowrap}
.fp{font-family:var(--mono);font-size:11px;color:var(--mute);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.c-se,.c-td{text-align:right;font-size:12.5px}
.c-pr{display:flex;align-items:center;gap:9px;font-size:12px}
.pbar{height:5px;width:66px;border-radius:99px;background:var(--hair2);overflow:hidden;flex:none}
.pbar>i{display:block;height:100%;background:var(--accent);border-radius:99px}
.c-he{display:flex;gap:5px;flex-wrap:wrap;align-items:center}
.c-ex{display:flex;justify-content:center;color:var(--mute)}
.chev{transition:transform .15s}.row[open] .chev{transform:rotate(90deg);color:var(--accent)}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;padding:3px 9px 3px 7px;border-radius:99px;border:1px solid var(--hair2);color:var(--body)}
.pill .pd{width:6px;height:6px;border-radius:99px;background:currentColor}
.pill.running{color:var(--good);border-color:color-mix(in srgb,var(--good) 40%,var(--hair2));background:color-mix(in srgb,var(--good) 9%,transparent)}
.pill.idle{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 40%,var(--hair2))}
.pill.stopped{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 40%,var(--hair2));background:color-mix(in srgb,var(--warn) 9%,transparent)}
.pill.disabled{color:var(--mute)}
.pill.missing{color:var(--danger);border-color:color-mix(in srgb,var(--danger) 40%,var(--hair2))}
.chip{font-family:var(--mono);font-size:10.5px;padding:2px 7px;border-radius:6px;border:1px solid var(--hair2);color:var(--body)}
.tag{font-size:10px;font-weight:600;padding:3px 7px;border-radius:6px;border:1px solid var(--hair2);color:var(--body);white-space:nowrap}
.tag.good{color:var(--good);border-color:color-mix(in srgb,var(--good) 35%,var(--hair2))}
.tag.warn{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 40%,var(--hair2));background:color-mix(in srgb,var(--warn) 8%,transparent)}
.tag.danger{color:var(--danger);border-color:color-mix(in srgb,var(--danger) 40%,var(--hair2));background:color-mix(in srgb,var(--danger) 8%,transparent)}
.detail{padding:2px 16px 16px 33px;background:color-mix(in srgb,var(--canvas) 55%,var(--surface))}
.dtop{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 0}
.dmeta{font-size:12px;color:var(--body)}.dot2{color:var(--hair2)}.dmeta .sub{color:var(--mute)}
.ctl{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.btn{font-family:var(--sans);font-size:12px;font-weight:600;padding:6px 12px;border-radius:8px;border:1px solid var(--hair2);background:var(--surface);color:var(--ink);cursor:pointer}
.btn:hover{border-color:var(--accent);color:var(--accent)}
.btn:disabled{opacity:.55;cursor:wait}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}.btn.primary:hover{background:var(--accent-soft);color:#fff}
.btn.danger{color:var(--danger)}.btn.danger:hover{border-color:var(--danger);color:var(--danger)}
.lnk{font-size:12px;color:var(--body)}
.attn{display:flex;flex-direction:column;gap:5px;padding:4px 0 8px}
.ar{display:flex;align-items:center;gap:8px;font-size:12.5px;flex-wrap:wrap}.ar a{color:var(--ink)}
.ic{font-weight:700;font-size:11px;width:13px;text-align:center}.ic.fail{color:var(--danger)}.ic.pass{color:var(--good)}.ic.pending{color:var(--warn)}.ic.none{color:var(--mute)}
.last{font-size:12px;color:var(--body);padding:2px 0 10px}
.subs{display:flex;flex-direction:column;gap:1px;border-top:1px solid var(--hair);padding-top:6px}
.subs summary{cursor:pointer;font-size:11.5px;font-weight:600;color:var(--body);list-style:none;display:inline-flex;align-items:center;gap:6px;padding:6px 0}
.subs summary::-webkit-details-marker{display:none}
.subs summary::before{content:"\\203A";font-size:14px;color:var(--mute);transition:transform .12s;display:inline-block}
.subs details[open]>summary::before{transform:rotate(90deg)}
.tiles{display:flex;gap:9px;flex-wrap:wrap;padding:4px 0 10px}
.tile{border:1px solid var(--hair);border-radius:9px;padding:9px 13px;min-width:94px;background:var(--surface)}
.tv{font-family:var(--display);font-weight:800;font-size:17px}.tv.sm{font-family:var(--mono);font-weight:500;font-size:12px}.tv.warnc{color:var(--warn)}
.tl{font-size:10px;color:var(--mute);margin-top:3px;text-transform:uppercase;letter-spacing:.03em;white-space:nowrap}
.tile.wide{min-width:230px;flex:1}
.tt{border-collapse:collapse;width:100%;font-size:12px;margin-bottom:8px}
.tt th{text-align:left;font-size:9.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--mute);font-weight:600;padding:0 12px 5px 0}
.tt td{padding:5px 12px 5px 0;border-top:1px solid var(--hair);vertical-align:top}
.tpill{font-size:10px;font-weight:600;padding:2px 7px;border-radius:99px;border:1px solid var(--hair2);color:var(--mute);white-space:nowrap}
.tpill.done{color:var(--good)}.tpill.in-progress{color:var(--accent)}.tpill.review{color:var(--warn)}.tpill.blocked{color:var(--danger)}.tpill.needs-human{color:var(--danger);border-color:var(--danger)}
.log{background:var(--canvas);border:1px solid var(--hair);border-radius:8px;padding:9px 11px;font-family:var(--mono);font-size:10.5px;line-height:1.65;color:var(--body);white-space:pre;overflow-x:auto;margin-bottom:8px}
.twrap{overflow-x:auto;-webkit-overflow-scrolling:touch}.twrap .tt{min-width:480px}
.empty{padding:40px;text-align:center;color:var(--mute)}
@media(max-width:900px){
  .app{grid-template-columns:1fr}
  .side{position:static;height:auto;flex-direction:row;align-items:center;flex-wrap:wrap;gap:6px;padding:10px 14px}
  .side .navlbl,.sfoot{display:none}.brand{padding:0 8px 0 0}
  .nav{padding:6px 10px}
  .kpis{grid-template-columns:repeat(2,1fr)}
  .thead{display:none}
  .rg{grid-template-columns:1fr auto;gap:6px 10px}
  .c-sc,.c-pr,.c-se,.c-td{display:none}
  .c-he{grid-column:1/-1}
  .detail{padding-left:16px}
}
@media(max-width:560px){.kpis{grid-template-columns:1fr 1fr}.top h1{font-size:19px}}
</style></head><body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><linearGradient id="c4fspark" x1="0" x2="0" y1="0" y2="1"><stop offset="0" style="stop-color:var(--accent);stop-opacity:.28"/><stop offset="1" style="stop-color:var(--accent);stop-opacity:0"/></linearGradient></defs></svg>
<div class="app">
  <aside class="side">
    <div class="brand">
      <svg width="26" height="26" viewBox="0 0 64 64" fill="none" aria-hidden="true"><rect width="64" height="64" rx="16" style="fill:var(--mark)"></rect><path d="M20 24L28 32L20 40" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"></path><path d="M34 41H46" stroke="#fff" stroke-width="3.5" stroke-linecap="round"></path></svg>
      <span class="wm">code<b>4</b>food</span><span class="tag2">factory</span>
    </div>
    <div class="navlbl">Filter</div>
    <div id="filters"></div>
    <div class="sfoot" id="sfoot"></div>
  </aside>
  <main class="main">
    <div class="top">
      <div><h1>Fleet overview</h1><div class="crumb" id="crumb">loading&#8230;</div></div>
      <div class="rt" id="topright"></div>
    </div>
    <div class="kpis" id="kpis"></div>
    <div class="panel">
      <div class="ptitle"><h2>Factories</h2><span class="pcount" id="pcount"></span></div>
      <div class="thead"><span>Factory</span><span>Status</span><span>Schedule</span><span>Progress</span><span class="r">Sess.</span><span class="r">Today</span><span>Health</span><span></span></div>
      <div id="rows"><div class="empty">loading&#8230;</div></div>
    </div>
  </main>
</div>
<script>
var esc = function(s){ return String(s==null?"":s).replace(/[&<>"]/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]; }); };
var fmtTok = function(n){ return n>=1e6 ? (n/1e6).toFixed(1)+"M" : n>=1e3 ? (n/1e3).toFixed(1)+"k" : String(n); };
var hm = function(t){ return new Date(t||0).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}); };
var CK = {pass:"\\u2713", fail:"\\u2717", pending:"\\u25cf", none:"\\u25cb"};
var ICO = {
  grid:'<svg class="ni" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.8"/><rect x="14" y="3" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.8"/><rect x="3" y="14" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.8"/><rect x="14" y="14" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.8"/></svg>',
  play:'<svg class="ni" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M10 9l5 3-5 3V9z" fill="currentColor"/></svg>',
  bell:'<svg class="ni" viewBox="0 0 24 24" fill="none"><path d="M6 9a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M10 20a2 2 0 004 0" stroke="currentColor" stroke-width="1.8"/></svg>',
  pause:'<svg class="ni" viewBox="0 0 24 24" fill="none"><rect x="6" y="5" width="4" height="14" rx="1" stroke="currentColor" stroke-width="1.8"/><rect x="14" y="5" width="4" height="14" rx="1" stroke="currentColor" stroke-width="1.8"/></svg>'
};
var CHEV = '<svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
var openState = {}, activeFilter = "all", lastState = null;
var tOpen = function(k, d){ return k in openState ? openState[k] : d; };
var FILTERS = {
  all: function(){ return true; },
  running: function(f){ return f.status==="running"; },
  needs: function(f){ return ((f.gh && f.gh.needsHuman) ? f.gh.needsHuman.length : 0) > 0; },
  paused: function(f){ return f.status==="stopped" || f.status==="disabled"; }
};

function sparkline(arr, w, h){
  if(!arr || arr.length < 2) return "";
  var max = Math.max.apply(null, arr.concat([0.01])), n = arr.length;
  var X = function(i){ return (i/(n-1))*w; };
  var Y = function(v){ return h - 3 - (v/max)*(h-6); };
  var pts = arr.map(function(v,i){ return X(i).toFixed(1)+","+Y(v).toFixed(1); });
  var line = "M"+pts.join(" L");
  var area = line+" L"+w+","+h+" L0,"+h+" Z";
  var lx = X(n-1).toFixed(1), ly = Y(arr[n-1]).toFixed(1);
  return '<svg viewBox="0 0 '+w+' '+h+'" class="spark" preserveAspectRatio="none" aria-hidden="true">'
    + '<path d="'+area+'" fill="url(#c4fspark)"/>'
    + '<path d="'+line+'" fill="none" style="stroke:var(--accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'
    + '<circle cx="'+lx+'" cy="'+ly+'" r="2.4" style="fill:var(--accent)"/></svg>';
}
function pill(s){ return '<span class="pill '+esc(s)+'"><span class="pd"></span>'+esc(s)+'</span>'; }
function pbar(done,total){ var p = total ? Math.round(100*done/total) : 0; return '<span class="pbar"><i style="width:'+p+'%"></i></span>'; }
function tpill(s){ return '<span class="tpill '+esc(s)+'">'+esc(s)+'</span>'; }

function versionChip(v){
  if(!v) return '<span class="ver" title="checking\\u2026"><span class="vd"></span>version \\u2026</span>';
  var dep = v.lastDeploy ? " \\u00b7 last deploy "+new Date(v.lastDeploy).toLocaleString() : "";
  if(!v.sha) return '<span class="ver" title="'+esc((v.error||"")+dep)+'"><span class="vd"></span>version unknown</span>';
  if(v.error) return '<span class="ver" title="git: '+esc(v.error+dep)+'"><span class="vd"></span>factory '+esc(v.sha)+' \\u00b7 unknown</span>';
  if(v.behind > 0) return '<span class="ver behind" title="run deploy-runtime.mjs to advance'+esc(dep)+'"><span class="vd"></span>factory '+esc(v.sha)+' \\u00b7 '+v.behind+' behind \\u2014 deploy to update</span>';
  return '<span class="ver ok" title="up to date'+esc(dep)+'"><span class="vd"></span>factory '+esc(v.sha)+' \\u00b7 up to date</span>';
}

// Schedule cell: the kind chip, plus the soonest declared fire. Disabled
// wins (no next window will actually run); manual and legacy kind-only
// declarations have nothing to compute.
function schedCell(f){
  if(!f.schedule) return "\\u2014";
  var chip = '<span class="chip"'+(f.schedule==="manual"?' title="no next window"':'')+'>'+esc(f.schedule)+'</span>';
  if(f.status==="disabled" || !f.nextWindow) return chip;
  var at = new Date(f.nextWindow.at);
  var day = f.nextWindow.inMinutes >= 24*60 ? at.toLocaleDateString([], {weekday:"short"})+" " : "";
  return chip+'<span class="nw">next '+esc(f.nextWindow.mode)+' '+day+hm(at)+'</span>';
}

function controls(f, canRun){
  if(!canRun || f.status==="missing") return "";
  // A clone known to be behind origin gives a partial picture — the server
  // refuses run/stop/enabled (409), so don't offer them. Resume is the one
  // survivor: it stays open server-side (removing a STOP needs no current
  // picture), so hiding it here would be exactly the lockout the fail-open
  // rule exists to prevent.
  var behind = !!(f.gh && f.gh.clone && f.gh.clone.behind);
  var b = function(act,label,cls,extra){ return '<button class="btn'+(cls?" "+cls:"")+'" data-act="'+act+'" data-f="'+esc(f.path)+'"'+(extra?" "+extra:"")+'>'+label+'</button>'; };
  if(f.status==="stopped") return b("resume","\\u25b6 resume","primary","")+(behind?"":b("enabled","\\u23fb disable","danger",'data-v="false"'));
  if(behind) return "";
  if(f.status==="idle") return b("run","\\u25b6 dev window","primary",'data-m="dev"')+b("run","\\u25b6 next task","",'data-m="dev" data-s="1"')+b("run","triage","",'data-m="triage"')+b("stop","\\u23f8 pause","danger","")+b("enabled","\\u23fb disable","danger",'data-v="false"');
  if(f.status==="running") return b("stop","\\u23f8 stop after session","danger",'data-running="1"');
  if(f.status==="disabled") return b("enabled","\\u23fb enable","primary",'data-v="true"');
  return "";
}
function links(f){
  var tok = location.search ? "&"+location.search.slice(1) : "";
  var out = f.status!=="missing" ? '<a class="lnk" href="/log?f='+encodeURIComponent(f.path)+tok+'">log \\u2197</a>' : "";
  if(f.gh && f.gh.dailyLogUrl) out += '<a class="lnk" href="'+esc(f.gh.dailyLogUrl)+'" target="_blank">daily log \\u2197</a>';
  if(f.repoUrl) out += '<a class="lnk" href="'+esc(f.repoUrl)+'" target="_blank">repo \\u2197</a> <a class="lnk" href="'+esc(f.repoUrl)+'/pulls" target="_blank">PRs \\u2197</a>';
  return out;
}
function attention(f){
  var gh = f.gh; if(!gh) return "";
  var nh = (gh.needsHuman||[]).map(function(i){ return '<div class="ar"><span class="ic fail">\\u2717</span><a href="'+esc(i.url)+'" target="_blank">#'+i.number+' '+esc(i.title)+'</a></div>'; }).join("");
  var prs = (gh.prs||[]).map(function(p){ return '<div class="ar"><span class="ic '+esc(p.checks)+'" title="checks: '+esc(p.checks)+'">'+(CK[p.checks]||"\\u25cb")+'</span><a href="'+esc(p.url)+'" target="_blank">#'+p.number+' '+esc(p.title)+'</a>'+(p.draft?'<span class="chip">draft</span>':"")+'<span class="mono mute">'+esc(p.branch)+'</span></div>'; }).join("");
  if(!nh && !prs) return "";
  return '<div class="attn">'+nh+prs+'</div>';
}
function usageTiles(f){
  var u = f.usage||{}, t = "";
  t += '<div class="tile"><div class="tv">$'+(u.todayCost||0).toFixed(2)+'</div><div class="tl">cost today</div></div>';
  t += '<div class="tile"><div class="tv">'+fmtTok(u.todayTokens||0)+'</div><div class="tl">tokens today</div></div>';
  if(f.gate && (f.gate.merged||f.gate.left)) t += '<div class="tile" title="'+esc(f.gate.last||"")+'"><div class="tv" style="color:var(--good)">\\u26d9 '+f.gate.merged+'</div><div class="tl">gate merges'+(f.gate.left?" \\u00b7 "+f.gate.left+" left":"")+'</div></div>';
  if(u.todayTurnCapped) t += '<div class="tile"><div class="tv warnc">\\u25d4 '+u.todayTurnCapped+'</div><div class="tl">turn-capped</div></div>';
  if(u.todayDied) t += '<div class="tile"><div class="tv" style="color:var(--danger)">\\u2717 '+u.todayDied+'</div><div class="tl">died today</div></div>';
  var models = Object.keys(u.todayModels||{});
  if(models.length) t += '<div class="tile"><div class="tv sm">'+models.map(function(m){ return esc(m)+"\\u00d7"+u.todayModels[m]; }).join(" ")+'</div><div class="tl">models today</div></div>';
  var unh = (f.tasks||[]).filter(function(x){ return !(x.status==="done"||x.status==="review") && (!x.model||!x.effort); }).length;
  if(unh) t += '<div class="tile"><div class="tv warnc">\\u270e '+unh+'</div><div class="tl">missing model/effort</div></div>';
  t += '<div class="tile"><div class="tv">$'+(u.totalCost||0).toFixed(2)+'</div><div class="tl">all-time</div></div>';
  var days = u.days||[];
  if(days.length>1){ var tot = days.reduce(function(a,d){ return a+d.cost; },0); t += '<div class="tile wide"><div class="tl">spend \\u00b7 '+days.length+' days \\u00b7 $'+tot.toFixed(2)+'</div>'+sparkline(days.map(function(d){ return d.cost; }),240,40)+'</div>'; }
  return t;
}
function tasksTable(f){
  var rows = (f.tasks||[]).map(function(t){
    var model = (t.model&&t.effort) ? '<span class="mono mute">'+esc(t.model)+'\\u00b7'+esc(t.effort)+'</span>' : ((t.status==="done"||t.status==="review")?"":'<span class="tag warn">\\u270e unset</span>');
    var lk = (t.links||[]).map(function(l){ return '<a href="'+esc(l)+'" target="_blank">\\u2197</a>'; }).join(" ");
    // needs-human pill links the question issue the session filed — the pill
    // IS the "what does the owner do about it" affordance.
    var st = (t.status==="needs-human" && t.question) ? '<a href="'+esc(t.question)+'" target="_blank" title="open the question issue">'+tpill(t.status)+'</a>' : tpill(t.status);
    return '<tr><td class="mono">'+esc(t.id)+'</td><td>'+esc(t.title)+'</td><td class="mono mute">'+esc(t.epic)+'</td><td>'+st+'</td><td>'+model+'</td><td>'+lk+'</td></tr>';
  }).join("");
  return '<div class="twrap"><table class="tt"><tr><th>id</th><th>task</th><th>epic</th><th>status</th><th>model</th><th>links</th></tr>'+rows+'</table></div>';
}

function row(f, s){
  if(f.status==="missing"){
    return '<div class="row missing"><div class="rg">'
      + '<span class="c-fac"><span class="sd"></span><span class="fn">'+esc(f.name)+'</span><span class="fp">'+esc(f.path)+'</span></span>'
      + '<span class="c-st">'+pill("missing")+'</span><span class="c-sc">\\u2014</span>'
      + '<span class="c-pr mute">no .factory/</span><span class="c-se">\\u2014</span><span class="c-td">\\u2014</span>'
      + '<span class="c-he mute">run init.mjs</span><span class="c-ex"></span></div></div>';
  }
  var u = f.usage||{};
  var done = (f.tasks||[]).filter(function(t){ return t.status==="done"; }).length;
  var total = (f.tasks||[]).length;
  var inprog = (f.tasks||[]).filter(function(t){ return t.status==="in-progress"; }).length;
  var active = (f.milestones||[]).filter(function(m){ return m.status==="active"; })[0];
  var cfg = f.config ? f.config.autonomy+" \\u00b7 "+f.config.windowHours+"h \\u00b7 \\u2264"+f.config.maxSessionsPerWindow+" \\u00b7 base "+f.config.baseBranch+(f.config.model?" \\u00b7 "+f.config.model:"") : "";
  var docAge = f.doctor ? (Date.now()-Date.parse(f.doctor.ts))/3600000 : null;
  var docTag = !f.doctor ? ""
    : docAge>36 ? '<span class="tag warn" title="last doctor '+esc(f.doctor.ts)+' \\u2014 watchdog not running?">\\ud83e\\ude7a stale</span>'
    : f.doctor.ok ? '<span class="tag good" title="doctor ok \\u00b7 '+esc(f.doctor.ts)+'">\\ud83e\\ude7a ok</span>'
    : '<span class="tag danger" title="'+esc((f.doctor.fails||[]).join("\\n"))+'">\\ud83e\\ude7a '+(f.doctor.fails||[]).length+'\\u2717</span>';
  var nhLen = (f.gh && f.gh.needsHuman) ? f.gh.needsHuman.length : 0;
  var nhTag = nhLen ? '<span class="tag danger">'+nhLen+' needs-human</span>' : "";
  var enWarn = (typeof f.enabled !== "boolean") ? '<span class="tag warn" title="config.json enabled is missing or not a boolean \\u2014 enable/disable will write a proper value">\\u26a0 enabled?</span>' : "";
  var scaf = (f.scaffold && f.scaffold.stale) ? '<span class="tag warn" title="re-run init.mjs on this project to refresh copies: '+esc((f.scaffold.files||[]).join(", "))+'">scaffold stale</span>' : "";
  // Derived factory status (PR-C): idle-with-only-gated-work must never read
  // as plain idle.
  var derTag = "";
  if(f.derived && f.derived.status==="waiting-on-owner") derTag = '<span class="tag warn" title="'+esc(f.derived.detail||"")+'">waiting on owner</span>';
  else if(f.derived && f.derived.status==="deadlocked") derTag = '<span class="tag danger" title="'+esc(f.derived.detail||"")+'">deadlocked</span>';
  var cloneTag = (f.gh && f.gh.clone && f.gh.clone.behind) ? '<span class="tag danger" title="local clone behind origin \\u2014 partial picture \\u00b7 mutations disabled until the clone is pulled">clone behind</span>' : "";
  var maxS = f.config ? f.config.maxSessionsPerWindow : null;
  var leftMs = f.lock ? Date.parse(f.lock.windowEndsAt||0) - Date.now() : 0;
  var left = leftMs > 0 ? (leftMs >= 3600000 ? Math.floor(leftMs/3600000)+"h "+Math.floor((leftMs%3600000)/60000)+"m left" : Math.floor(leftMs/60000)+"m left") : "past window end";
  var runbit = f.lock ? '<span class="sub">'+esc(f.lock.mode)+' \\u00b7 session '+(f.lock.currentSession||"?")+(maxS?"/"+maxS:"")+' \\u00b7 '+left+'</span>' : "";
  var last = f.lastSession ? '<div class="last"><span class="mute">last session</span> '+esc(f.lastSession.taskId||"\\u2014")+' '+esc(f.lastSession.status||"")+' \\u2014 '+esc(f.lastSession.summary||"")+(f.lastSession.pr?' \\u00b7 <a href="'+esc(f.lastSession.pr)+'" target="_blank">PR \\u2197</a>':"")+'</div>' : "";
  var rk = f.path+":row", uk = f.path+":usage", tk = f.path+":tasks", lk = f.path+":log";
  var subs = '<div class="subs">'
    + '<details data-k="'+esc(uk)+'"'+(tOpen(uk,false)?" open":"")+'><summary>usage &amp; spend</summary><div class="tiles">'+usageTiles(f)+'</div></details>'
    + (total ? '<details data-k="'+esc(tk)+'"'+(tOpen(tk,false)?" open":"")+'><summary>tasks \\u00b7 '+done+' done'+(inprog?" \\u00b7 "+inprog+" in-progress":"")+' \\u00b7 '+(total-done-inprog)+' left</summary>'+tasksTable(f)+'</details>' : "")
    + ((f.logTail||[]).length ? '<details data-k="'+esc(lk)+'"'+(tOpen(lk,false)?" open":"")+'><summary>driver log (today)</summary><pre class="log">'+esc(f.logTail.join("\\n"))+'</pre></details>' : "")
    + '</div>';
  var ghErr = (f.gh && f.gh.error) ? '<div class="last mute">gh: '+esc(f.gh.error)+'</div>' : "";
  return '<details class="row '+esc(f.status)+'" data-k="'+esc(rk)+'"'+(tOpen(rk,false)?" open":"")+'>'
    + '<summary class="rg">'
    + '<span class="c-fac"><span class="sd"></span><span class="fn">'+esc(f.name)+'</span><span class="fp">'+esc(f.path)+'</span></span>'
    + '<span class="c-st">'+pill(f.status)+'</span>'
    + '<span class="c-sc">'+schedCell(f)+'</span>'
    + '<span class="c-pr">'+pbar(done,total)+'<span class="mono">'+done+'/'+total+'</span></span>'
    + '<span class="c-se mono">'+(u.todaySessions||0)+'</span>'
    + '<span class="c-td mono">$'+(u.todayCost||0).toFixed(2)+'</span>'
    + '<span class="c-he">'+derTag+cloneTag+docTag+nhTag+enWarn+scaf+'</span>'
    + '<span class="c-ex">'+CHEV+'</span>'
    + '</summary>'
    + '<div class="detail">'
    + '<div class="dtop"><div class="dmeta"><span class="mono mute">'+esc(f.path)+'</span> <span class="dot2">\\u00b7</span> '+esc(cfg)+' <span class="dot2">\\u00b7</span> '+(active?esc(active.id)+" "+esc(active.name):"no active milestone")+' '+runbit+'</div>'
    + '<div class="ctl">'+controls(f,s.canRun)+links(f)+'</div></div>'
    + attention(f) + ghErr + last + subs
    + '</div></details>';
}

function kpis(s, fl){
  var spark = fl.days.length>1 ? sparkline(fl.days,200,40) : "";
  return ''
    + '<div class="kpi"><div class="kl">Factories</div><div class="kn">'+s.factories.length+'</div><div class="ks">'+fl.active+' active \\u00b7 '+fl.missing+' missing</div></div>'
    + '<div class="kpi"><div class="kl">Running now</div><div class="kn">'+fl.running+'</div><div class="ks">'+(fl.running?fl.running+' window open':'none open')+'</div></div>'
    + '<div class="kpi'+(fl.needs?' alert':'')+'"><div class="kl">Needs human</div><div class="kn">'+fl.needs+'</div><div class="ks">'+(fl.needs?fl.needs+' open':'all clear')+'</div></div>'
    + '<div class="kpi"><div class="kl">Spend today</div><div class="kn">$'+fl.spent.toFixed(2)+'</div>'+(spark?'<div class="sparkwrap">'+spark+'</div>':'<div class="ks">$'+fl.allTime.toFixed(2)+' all-time</div>')+'</div>';
}
function filtersNav(total, fl){
  var item = function(key,label,icon,count){ return '<div class="nav'+(activeFilter===key?" on":"")+'" data-filter="'+key+'">'+icon+'<span>'+label+'</span>'+(count!=null?'<span class="ct">'+count+'</span>':"")+'</div>'; };
  return item("all","All factories",ICO.grid,total)+item("running","Running",ICO.play,fl.running)+item("needs","Needs human",ICO.bell,fl.needs)+item("paused","Paused / disabled",ICO.pause,fl.paused);
}
function sfoot(s){
  var v = s.version||{};
  var rt = v.sha ? "factory "+esc(v.sha)+(v.behind>0?" \\u00b7 "+v.behind+" behind \\u2014 deploy to update":v.error?" \\u00b7 unknown":" \\u00b7 up to date") : "factory \\u2014";
  return '<span>machine <span class="mono">'+esc(s.host)+'</span></span><span>'+rt+'</span><span>'+(s.canRun?"mutations enabled":"read-only \\u2014 no token")+'</span>';
}

function render(s){
  lastState = s;
  var facs = s.factories||[];
  document.querySelectorAll(".main details, #rows details").forEach(function(d){ if(d.dataset.k) openState[d.dataset.k]=d.open; });
  var missing = facs.filter(function(f){ return f.status==="missing"; }).length;
  var days = [];
  facs.forEach(function(f){ ((f.usage&&f.usage.days)||[]).forEach(function(d,i){ days[i]=(days[i]||0)+d.cost; }); });
  var fl = {
    running: facs.filter(function(f){ return f.status==="running"; }).length,
    needs: facs.reduce(function(a,f){ return a+((f.gh&&f.gh.needsHuman)?f.gh.needsHuman.length:0); },0),
    paused: facs.filter(function(f){ return f.status==="stopped"||f.status==="disabled"; }).length,
    missing: missing, active: facs.length-missing,
    spent: facs.reduce(function(a,f){ return a+((f.usage&&f.usage.todayCost)||0); },0),
    allTime: facs.reduce(function(a,f){ return a+((f.usage&&f.usage.totalCost)||0); },0),
    days: days
  };
  document.getElementById("crumb").textContent = s.host+" \\u00b7 "+facs.length+" factories \\u00b7 mutations "+(s.canRun?"enabled":"read-only");
  document.getElementById("topright").innerHTML = versionChip(s.version)+'<span class="upd">updated '+new Date(s.generatedAt).toLocaleTimeString()+'</span>';
  document.getElementById("kpis").innerHTML = kpis(s, fl);
  document.getElementById("filters").innerHTML = filtersNav(facs.length, fl);
  document.getElementById("sfoot").innerHTML = sfoot(s);
  var shown = facs.filter(FILTERS[activeFilter]||FILTERS.all);
  document.getElementById("pcount").textContent = shown.length===facs.length ? facs.length+" total" : shown.length+" of "+facs.length;
  document.getElementById("rows").innerHTML = shown.length ? shown.map(function(f){ return row(f,s); }).join("") : (facs.length ? '<div class="empty">No factories match this filter.</div>' : '<div class="empty">No factories registered. Run init.mjs on a project.</div>');
}

function doAction(btn){
  var f = btn.dataset.f, act = btn.dataset.act, name = f.split("/").pop();
  var params = new URLSearchParams(location.search); params.set("factory", f);
  var url, msg;
  if(act==="run"){ var mode = btn.dataset.m, sessions = btn.dataset.s||null; var label = mode==="triage" ? "a triage session" : sessions ? "the next task (one session)" : "a full dev window"; msg = "Start "+label+" for "+name+"?"; params.set("mode",mode); if(sessions) params.set("sessions",sessions); url = "/api/run?"+params; }
  else if(act==="stop"){ msg = btn.dataset.running==="1" ? "Stop "+name+"? It finishes the current session, then stops." : "Pause "+name+"? This blocks runs until you resume."; url = "/api/stop?"+params; }
  else if(act==="resume"){ msg = "Resume "+name+"? Runs become possible again."; url = "/api/resume?"+params; }
  else if(act==="enabled"){ var v = btn.dataset.v; msg = v==="false" ? "Disable "+name+"? Timers stay installed, but scheduled fires exit silently and dev/triage refuse \\u2014 until re-enabled." : "Enable "+name+"? It runs again in its declared state."; params.set("value",v); url = "/api/enabled?"+params; }
  else return;
  if(!confirm(msg)) return;
  btn.disabled = true;
  fetch(url, {method:"POST"}).then(function(r){ if(!r.ok) return r.text().then(function(t){ alert("action failed: "+t); }); }).catch(function(e){ alert("action failed: "+e); }).then(function(){ tick(); });
}

document.addEventListener("click", function(e){
  var fbtn = e.target.closest("[data-filter]");
  if(fbtn){ activeFilter = fbtn.dataset.filter; if(lastState) render(lastState); return; }
  var abtn = e.target.closest("button[data-act]");
  if(abtn){ doAction(abtn); }
});

function tick(){
  fetch("/api/state"+location.search).then(function(r){
    if(r.status===401){ document.getElementById("crumb").textContent = "unauthorized \\u2014 open with ?token=<secret>"; return null; }
    return r.json();
  }).then(function(s){ if(s) render(s); }).catch(function(){ var c = document.getElementById("crumb"); if(c) c.textContent = "dashboard server unreachable \\u2014 retrying\\u2026"; });
}
tick(); setInterval(tick, 5000);
</script></body></html>
`;
const LOG_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Factory log</title>
<style>
:root{--page:#f6f7f9;--surface:#fff;--ink:#16181d;--muted:#888d97;--border:#e8e9ec;--accent:#3b6fe6;--mark:#16181d;
--display:"Nunito",ui-rounded,"SF Pro Rounded","Segoe UI",system-ui,sans-serif;--sans:"Inter",system-ui,-apple-system,sans-serif;--mono:"JetBrains Mono",ui-monospace,Menlo,monospace}
@media (prefers-color-scheme: dark){:root{--page:#0a0a0a;--surface:#141414;--ink:#efefef;--muted:#8c8c8c;--border:#222;--accent:#5b8cff;--mark:#1c1c1c}}
*{box-sizing:border-box;margin:0}
body{background:var(--page);color:var(--ink);font:13px/1.5 var(--sans);height:100dvh;display:flex;flex-direction:column;-webkit-font-smoothing:antialiased}
header{padding:11px 16px;display:flex;gap:11px;align-items:center;border-bottom:1px solid var(--border);flex-shrink:0}
header a{color:var(--accent);text-decoration:none;font-size:13px;font-weight:500}
header .t{font-family:var(--display);font-weight:800;font-size:15px;letter-spacing:-.01em}
header .s{color:var(--muted);font-size:11px;margin-left:auto;font-family:var(--mono)}
#log{flex:1;overflow-y:auto;padding:12px 16px}
details{border:1px solid var(--border);border-radius:10px;margin-bottom:10px;background:var(--surface)}
summary{cursor:pointer;padding:9px 13px;font-size:12px;font-weight:600;overflow-wrap:anywhere;list-style:none}
summary::-webkit-details-marker{display:none}
details pre{padding:4px 13px 11px;font:11px/1.65 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;color:var(--muted)}
</style></head><body>
<header><svg width="20" height="20" viewBox="0 0 64 64" fill="none" aria-hidden="true"><rect width="64" height="64" rx="16" style="fill:var(--mark)"></rect><path d="M20 24L28 32L20 40" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></path><path d="M34 41H46" stroke="#fff" stroke-width="4" stroke-linecap="round"></path></svg><a href="#" id="back">← board</a><span class="t" id="name">log</span><span class="s" id="meta">loading…</span></header>
<div id="log"></div>
<script>
const q = new URLSearchParams(location.search);
document.getElementById("back").href = "/" + (q.get("token") ? "?token=" + encodeURIComponent(q.get("token")) : "");
document.getElementById("name").textContent = (q.get("f") ?? "").split("/").pop() + " — driver log";
const el = document.getElementById("log");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
let openState = {};
async function tick(){
  try{
    const r = await fetch("/api/log" + location.search);
    if(!r.ok){ document.getElementById("meta").textContent = r.status === 401 ? "unauthorized" : "unavailable"; return; }
    const j = await r.json();
    // remember which blocks the user opened/closed between refreshes
    el.querySelectorAll("details").forEach(d => { openState[d.dataset.k] = d.open; });
    el.innerHTML = (j.sessions ?? []).map((s, i) => {
      const k = s.title;
      const open = k in openState ? openState[k] : i === 0; // newest open by default
      return \`<details data-k="\${esc(k)}" \${open ? "open" : ""}><summary>\${esc(s.title)}</summary><pre>\${esc(s.lines.join("\\n"))}</pre></details>\`;
    }).join("") || '<p style="color:var(--muted);padding:20px">(log is empty)</p>';
    document.getElementById("meta").textContent = (j.file ?? "no log yet") + " · refreshed " + new Date().toLocaleTimeString();
  } catch { document.getElementById("meta").textContent = "server unreachable — retrying…"; }
}
tick(); setInterval(tick, 10000);
</script></body></html>
`;

const server = http.createServer((req, res) => {
  if (req.url === "/favicon.ico") {
    // No data here — keep it outside auth so browsers don't log 401 noise.
    res.writeHead(204);
    res.end();
    return;
  }
  if (!tokenOk(req)) {
    res.writeHead(401, { "content-type": "text/plain" });
    res.end("unauthorized");
    return;
  }
  if (req.method === "POST" && req.url?.startsWith("/api/run")) {
    handleRun(req, res);
  } else if (req.method === "POST" && req.url?.startsWith("/api/stop")) {
    handleStop(req, res);
  } else if (req.method === "POST" && req.url?.startsWith("/api/resume")) {
    handleResume(req, res);
  } else if (req.method === "POST" && req.url?.startsWith("/api/enabled")) {
    handleEnabled(req, res);
  } else if (req.url?.startsWith("/api/state")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(state()));
  } else if (req.url?.startsWith("/api/log")) {
    const f = new URL(req.url, "http://x").searchParams.get("f") ?? "";
    const tail = driverLogSessions(path.resolve(f));
    if (!tail) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("unknown factory");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(tail));
  } else if (req.url?.startsWith("/log")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(LOG_PAGE);
  } else {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  }
});

// Report the resolved config + its source before binding (so a bad bind still
// leaves a trace of what was configured); the token value never appears.
process.stdout.write(`config: port=${port} (${src.port}), listen=${listen} (${src.listen}), token=${token ? src.token : "absent"}\n`);

server.listen(port, listen, () => {
  refreshAllGh();
  setInterval(refreshAllGh, GH_REFRESH_MS).unref();
  refreshVersion();
  setInterval(refreshVersion, VERSION_REFRESH_MS).unref();
  const real = server.address().port; // resolves --port 0 to the real port
  process.stdout.write(`Factory dashboard: http://${listen}:${real}${token ? "/?token=***" : ""}\n` +
    `(factories from ~/.factory/registry.json — mutations ${token ? "enabled (token required)" : "DISABLED (no token)"})\n`);
});
