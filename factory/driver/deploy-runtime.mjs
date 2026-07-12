#!/usr/bin/env node
// Gated runtime deploy (factory-v2 O6, NOTES item 46) — repo-side tool, one
// per machine, always run as the CURRENT runtime's own copy:
//
//   node ~/.factory/runtime/factory/driver/deploy-runtime.mjs [--ref origin/main]
//
// The machine runtime (~/.factory/runtime — the checkout every scheduler,
// watchdog, and dashboard runs from) advances ONLY through this step: fetch,
// then gate the candidate on a syntax check of every driver module and a
// read-only doctor pass over every registered factory, then fast-forward.
// A failed gate leaves the runtime exactly where it was — the merge-gate
// principle applied to the runtime itself. Bootstrap is a plain clone:
//
//   git clone <repo-url> ~/.factory/runtime

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stateDir } from "./paths.mjs";

const RUNTIME = path.join(os.homedir(), ".factory", "runtime");
const logPath = path.join(os.homedir(), ".factory", "deploy.log");
const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { fs.appendFileSync(logPath, line + "\n"); } catch { /* first run before ~/.factory exists */ }
  process.stdout.write(line + "\n");
};

// ---------- args ----------
const argv = process.argv.slice(2);
let ref = "origin/main";
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--ref") ref = argv[++i];
  else { process.stderr.write(`deploy-runtime: unknown flag ${argv[i]} — usage: deploy-runtime.mjs [--ref <ref>]\n`); process.exit(1); }
}

const git = (args, cwd = RUNTIME) =>
  execFileSync("git", args, { cwd, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] }).trim();

const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
};

// KEY=VALUE lines, # comments — same format as .factory/.env.
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

// ~/.factory/telegram.env first (the machine-level creds the OnFailure unit
// uses), then any registered factory's .env — one bot serves the fleet.
const telegramCreds = (registry) => {
  const candidates = [
    path.join(os.homedir(), ".factory", "telegram.env"),
    ...Object.keys(registry?.factories ?? {}).map((p) => path.join(stateDir(p), ".env")),
  ];
  for (const p of candidates) {
    const env = loadEnv(p);
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) return { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID };
  }
  return null;
};

const notify = async (registry, text) => {
  const creds = telegramCreds(registry);
  if (!creds) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${creds.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: creds.chatId, text: `[runtime] ${text}`, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) log(`telegram HTTP ${res.status}`);
  } catch (e) {
    log(`telegram failed: ${String(e.message ?? e).split("\n")[0]}`);
  }
};

const registry = readJson(path.join(os.homedir(), ".factory", "registry.json"));

const refuse = async (why) => {
  log(`deploy REFUSED — ${why}`);
  await notify(registry, `✗ deploy REFUSED — ${why}`);
  process.exit(1);
};

// ---------- resolve the candidate ----------
if (!fs.existsSync(path.join(RUNTIME, ".git"))) {
  log(`no runtime at ${RUNTIME} — bootstrap it first: git clone <repo-url> ${RUNTIME}`);
  process.exit(1);
}

try { git(["fetch", "origin", "--quiet"]); } catch (e) {
  await refuse(`fetch failed: ${String(e.stderr ?? e.message ?? e).split("\n")[0]}`);
}

const head = git(["rev-parse", "HEAD"]);
let candidate;
try { candidate = git(["rev-parse", "--verify", `${ref}^{commit}`]); } catch {
  await refuse(`ref ${ref} does not resolve`);
}

if (candidate === head) {
  log(`runtime up to date at ${head.slice(0, 7)} (${ref})`);
  process.exit(0);
}

if (git(["status", "--porcelain"]) !== "") {
  await refuse(`runtime tree at ${RUNTIME} is dirty (uncommitted changes) — the runtime only ever advances by deploy; restore it (git -C ${RUNTIME} status)`);
}

try { git(["merge-base", "--is-ancestor", "HEAD", candidate]); } catch {
  let behind = false;
  try { git(["merge-base", "--is-ancestor", candidate, "HEAD"]); behind = true; } catch { /* diverged */ }
  await refuse(behind
    ? `candidate ${ref} is BEHIND the runtime — rollbacks don't go through the deploy gate; git -C ${RUNTIME} reset --hard ${ref} by hand if you mean it`
    : `runtime has local commits not on ${ref} — not fast-forwardable; the runtime only ever advances by deploy`);
}

// A deploy mid-window would hand running drivers new prompts and a new MCP
// child (the driver re-execs itself per session) — a mixed-version window.
// Refuse while any registered factory holds a live window lock.
{
  const live = Object.entries(registry?.factories ?? {}).flatMap(([project, meta]) => {
    const lock = readJson(path.join(stateDir(project), "log", "window.lock"));
    if (!lock?.pid) return [];
    try { process.kill(lock.pid, 0); } catch { return []; } // stale lock from a crash
    return [`${meta?.name ?? path.basename(project)} (${lock.mode ?? "?"}, pid ${lock.pid})`];
  });
  if (live.length) {
    await refuse(`live window(s): ${live.join(", ")} — deploy after they finish`);
  }
}

const count = git(["rev-list", "--count", `${head}..${candidate}`]);
log(`candidate ${ref} = ${candidate.slice(0, 7)} (${count} commit(s) ahead of ${head.slice(0, 7)}) — running gates`);

// ---------- gates (against the candidate, in a throwaway worktree) ----------
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "factory-deploy-"));
const wt = path.join(tmpRoot, "candidate");
const gateFails = [];
try {
  git(["worktree", "add", "--detach", wt, candidate]);

  // Gate 1: every driver module must parse. Catches the class where a bad
  // merge would brick the fleet's shared runtime in one step.
  const driverDir = path.join(wt, "factory", "driver");
  const mjsFiles = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name !== "test" && e.name !== "node_modules") walk(path.join(dir, e.name));
      } else if (e.name.endsWith(".mjs")) mjsFiles.push(path.join(dir, e.name));
    }
  };
  walk(driverDir);
  for (const f of mjsFiles) {
    try {
      execFileSync(process.execPath, ["--check", f], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      gateFails.push(`syntax: ${path.relative(wt, f)} — ${String(e.stderr ?? "").split("\n").find((l) => l.trim()) ?? "node --check failed"}`);
    }
  }
  log(`gate: syntax — ${gateFails.length ? `${gateFails.length} failure(s)` : `${mjsFiles.length} module(s) parse`}`);

  // Gate 2: the CANDIDATE driver's doctor must pass on every registered
  // factory (read-only). A candidate that can't doctor the fleet green
  // doesn't get to run it.
  if (!gateFails.length) {
    const factories = Object.entries(registry?.factories ?? {});
    for (const [project, meta] of factories) {
      const name = meta?.name ?? path.basename(project);
      try {
        execFileSync(process.execPath, [path.join(wt, "factory", "driver", "factory.mjs"), "doctor", "--project", project],
          { encoding: "utf8", timeout: 180_000, stdio: ["ignore", "pipe", "pipe"] });
        log(`gate: doctor ${name} — ok`);
      } catch (e) {
        const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
        const detail = out.split("\n").filter((l) => l.trim().startsWith("✗")).map((l) => l.trim()).join("; ")
          || out.split("\n").find((l) => l.trim()) || String(e.message ?? e).split("\n")[0];
        gateFails.push(`doctor ${name}: ${detail.slice(0, 300)}`);
        log(`gate: doctor ${name} — FAIL`);
      }
    }
    if (!factories.length) log("gate: doctor — no registered factories (nothing to check)");
  }
} finally {
  try { git(["worktree", "remove", "--force", wt]); } catch { /* never added */ }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

if (gateFails.length) {
  for (const f of gateFails) log(`  ✗ ${f}`);
  await refuse(`candidate ${candidate.slice(0, 7)} failed ${gateFails.length} gate(s): ${gateFails.map((f) => f.split(":")[0]).join(", ")} — runtime stays at ${head.slice(0, 7)}`);
}

// ---------- advance ----------
git(["merge", "--ff-only", candidate]);
fs.writeFileSync(path.join(os.homedir(), ".factory", "runtime-deploy.json"), JSON.stringify({
  ts: new Date().toISOString(),
  from: head,
  to: candidate,
  ref,
  factoriesChecked: Object.keys(registry?.factories ?? {}).length,
}, null, 2) + "\n");
log(`runtime advanced ${head.slice(0, 7)} → ${candidate.slice(0, 7)} (${count} commit(s))`);
// The dashboard is the one long-lived process running this checkout — a
// deploy advances the files under it, but the process keeps serving the old
// code until someone restarts it (timers re-exec per fire and self-heal).
let dashboardHint = "";
if (git(["diff", "--name-only", `${head}..${candidate}`]).split("\n").includes("factory/driver/dashboard.mjs")) {
  dashboardHint = "dashboard.mjs changed — the running dashboard still serves the OLD code; restart it (systemctl --user restart factory-dashboard)";
  log(`⚠ ${dashboardHint}`);
}
await notify(registry, `✓ runtime advanced ${head.slice(0, 7)} → ${candidate.slice(0, 7)} (${count} commit(s), ${Object.keys(registry?.factories ?? {}).length} factory doctor(s) green)${dashboardHint ? `\n⚠ ${dashboardHint}` : ""}`);
