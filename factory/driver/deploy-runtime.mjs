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

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stateDir, readJson, execGit } from "./paths.mjs";
import { telegramCreds, sendTelegram } from "./notify.mjs";
import { expectedOrigin, sameOrigin } from "./distribution.mjs";

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

const git = (args, cwd = RUNTIME) => execGit(cwd, args, { timeoutMs: 120_000 });

const notify = async (registry, text) => {
  const creds = telegramCreds(registry?.factories ?? {});
  if (!creds) return;
  await sendTelegram(creds, `[runtime] ${text}`, { log });
};

const registry = readJson(path.join(os.homedir(), ".factory", "registry.json"));

const refuse = async (why) => {
  log(`deploy REFUSED — ${why}`);
  await notify(registry, `✗ deploy REFUSED — ${why}`);
  process.exit(1);
};

// ---------- plugins (G3) ----------
// Sessions get their skills from the machine-installed code4food plugins,
// sourced from THIS runtime clone as a local marketplace — so every deploy
// (and every plain run: this is also the bootstrap verb) leaves the plugins
// synced with the runtime. `plugin update` is a no-op unless a plugin.json
// version was bumped; unknown marketplace / uninstalled plugins fall back to
// add/install. Failures only WARN: by this point the runtime has already
// advanced (or was current), and doctor flags version drift until a sync
// lands.
const PLUGINS = ["code4food-skillset", "code4food-factory"];
const syncPlugins = () => {
  // A runtime that ships no marketplace manifest (pre-G3) has nothing to
  // provision from — stay quiet rather than churn the claude CLI.
  if (!fs.existsSync(path.join(RUNTIME, ".claude-plugin", "marketplace.json"))) return;
  const claude = (...args) =>
    spawnSync("claude", ["plugin", ...args], { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
  const firstLine = (r) => (r.stderr || r.stdout || String(r.error?.message ?? "")).split("\n").find((l) => l.trim()) ?? "";

  const refresh = claude("marketplace", "update", "code4food");
  if (refresh.error?.code === "ENOENT") {
    log(`⚠ plugins NOT synced — claude CLI not on PATH; by hand: claude plugin marketplace add ${RUNTIME} && claude plugin install ${PLUGINS.map((p) => `${p}@code4food`).join(" ")}`);
    return;
  }
  if (refresh.status !== 0) {
    const add = claude("marketplace", "add", RUNTIME);
    if (add.status !== 0) {
      log(`⚠ plugins NOT synced — marketplace add failed: ${firstLine(add)}`);
      return;
    }
  }
  for (const p of PLUGINS) {
    const upd = claude("update", `${p}@code4food`);
    if (upd.status === 0) continue;
    const inst = claude("install", `${p}@code4food`);
    if (inst.status !== 0) {
      log(`⚠ plugins NOT synced — ${p}: ${firstLine(inst)}`);
      return;
    }
  }
  log(`plugins synced with the runtime (${PLUGINS.join(", ")})`);
};

// ---------- resolve the candidate ----------
if (!fs.existsSync(path.join(RUNTIME, ".git"))) {
  log(`no runtime at ${RUNTIME} — bootstrap it first: git clone <repo-url> ${RUNTIME}`);
  process.exit(1);
}

// A machine declared unattended (unattended-skillset GA) carries deliberate
// runtime overlays and a different plugin install — a deploy would clobber
// the overlays and reinstall the shipped pair.
{
  const declaration = path.join(os.homedir(), ".factory", "unattended.json");
  if (fs.existsSync(declaration)) {
    await refuse(`machine is declared unattended (${declaration}) — a deploy would clobber the runtime overlays and reinstall the shipped plugin pair; remove the declaration first if this machine is returning to the shipped runtime`);
  }
}

// A wrong or retired origin fetches fine and the up-to-date exit below then
// reports success forever — a silently frozen machine. Verify the remote
// BEFORE trusting anything the fetch says (migration runbook Phase 0).
{
  let origin = null;
  try { origin = git(["remote", "get-url", "origin"]); } catch { /* no origin remote */ }
  if (!sameOrigin(origin, expectedOrigin())) {
    await refuse(`runtime origin is ${origin ?? "MISSING"} — not the distribution repo (${expectedOrigin()}); this machine would never advance again. Fix: git -C ${RUNTIME} remote set-url origin ${expectedOrigin()}`);
  }
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
  syncPlugins();
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

// Best-effort provisioning from the CURRENT runtime before gating: a
// never-provisioned machine becomes usable even if the advance below is
// refused. Not load-bearing for the gate — the candidate's doctor skips
// the plugin check under FACTORY_DEPLOY_GATE (this deploy provisions
// plugins itself right after the advance).
syncPlugins();

// Gate 0 — plugin-content honesty: cached plugins only refresh on a
// version bump (`plugin update` is a no-op at the same version), so a
// candidate that changes plugin content without bumping the owning
// plugin.json would deploy green while every session keeps running the
// old cached skills, forever and silently. Refuse it instead.
{
  const versionAt = (rev, manifest) => {
    try { return JSON.parse(git(["show", `${rev}:${manifest}`])).version ?? null; }
    catch { return null; /* manifest absent at that rev (pre-plugins) */ }
  };
  const changed = git(["diff", "--name-only", `${head}..${candidate}`]).split("\n").filter(Boolean);
  const PLUGIN_CONTENT = [
    { manifest: ".claude-plugin/plugin.json", owns: /^(skills|commands|agents|hooks|statusline)\/|^\.claude-plugin\// },
    { manifest: "factory/.claude-plugin/plugin.json", owns: /^factory\/(skills|commands)\/|^factory\/\.claude-plugin\// },
  ];
  const stale = [];
  for (const { manifest, owns } of PLUGIN_CONTENT) {
    const before = versionAt(head, manifest);
    const after = versionAt(candidate, manifest);
    if (after === null) continue; // candidate ships no such plugin — nothing cached to go stale
    // marketplace.json is marketplace metadata served fresh from the runtime
    // clone, never cached plugin content — a factory-only bump edits it and
    // must not trip the skillset gate (same rule as tools/publish.mjs).
    const touched = changed.filter((f) => owns.test(f) && f !== manifest && f !== ".claude-plugin/marketplace.json");
    if (touched.length && before === after) stale.push(`${manifest} stays at ${after} while its content changed (${touched[0]}${touched.length > 1 ? ` +${touched.length - 1}` : ""})`);
  }
  if (stale.length) {
    await refuse(`plugin content changed without a version bump — sessions would keep the old cached skills: ${stale.join("; ")}`);
  }
}

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
        // FACTORY_DEPLOY_GATE: the candidate's doctor must not judge plugin
        // provisioning — that is THIS deploy's own next step (post-advance
        // sync), so gating on it would be circular. Every later doctor run
        // checks it for real.
        execFileSync(process.execPath, [path.join(wt, "factory", "driver", "factory.mjs"), "doctor", "--project", project],
          { encoding: "utf8", timeout: 180_000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FACTORY_DEPLOY_GATE: "1" } });
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
// Answer first: the sha the runtime is at NOW. The old "advanced <from> →
// <to>" shape led with the sha it came FROM and was read as the new one in
// practice (2026-07-19) — technically accurate but misread is a defect.
log(`runtime now at ${candidate.slice(0, 7)} (was ${head.slice(0, 7)}, ${count} commit(s))`);
syncPlugins();
// A deploy advances the files under a long-lived process, but that process
// keeps running the OLD code until someone restarts it (timers re-exec per
// fire and self-heal, so they need no hint). This used to name the dashboard
// alone — "the one long-lived process running this checkout", true when it
// was written. factory-supervisor shipped later, and the 2026-08-29 deploy of
// 2.3.0 changed supervisor.mjs and left both the VPS and zeroone running the
// old supervisor, silently (T-041).
//
// So ASK the machine rather than carrying a list: every --user unit whose
// ExecStart runs a module out of this runtime is a candidate, and the ones
// whose code this deploy changed are stale. A service added later is found
// the same way, with no edit here.
// BOTH managers, because the fleet uses both: the VPS and zeroone run these
// as systemd --user services, this Mac runs com.factory.supervisor under
// launchd. Covering only systemd would reproduce T-041's exact defect on the
// other platform.
const out = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
  } catch { return null; } // manager absent, or no user bus — nothing to discover
};
// The module a unit executes, as the repo-relative path `git diff
// --name-only` prints, so the two can be compared directly.
const moduleOf = (text) => (text?.includes(RUNTIME) ? text.match(/(factory\/driver\/[\w-]+\.mjs)/)?.[1] : null) ?? null;

// Only a RUNNING process can be running old code. The per-factory
// `<name>-factory@dev|triage|report` units exec factory.mjs and are oneshots
// that have already exited — they re-exec per fire and pick the new code up
// by themselves, which is the "timers self-heal" case above. Naming them
// would be worse than noise: their restart command LAUNCHES A FACTORY WINDOW.
// Measured on the VPS 2026-08-30: 12 units exec a driver module and 9 are
// exactly these oneshots, so without the SubState filter almost every deploy
// would print nine instructions that must not be followed.
const systemdUnits = () => {
  const listed = out("systemctl", ["--user", "list-units", "--type=service", "--all", "--no-legend", "--plain", "--no-pager"]);
  if (listed === null) return [];
  const found = [];
  for (const line of listed.split("\n")) {
    // UNIT LOAD ACTIVE SUB DESCRIPTION — SUB is the one that separates a live
    // daemon from an exited oneshot ("running" vs "dead"/"exited").
    const [unit, , , sub] = line.trim().split(/\s+/);
    if (!unit?.endsWith(".service") || sub !== "running") continue;
    const entry = moduleOf(out("systemctl", ["--user", "show", unit, "-p", "ExecStart", "--value"]));
    if (entry) found.push({ entry, name: unit, restart: `systemctl --user restart ${unit}` });
  }
  return found;
};

const launchdUnits = () => {
  const loaded = out("launchctl", ["list"]);
  if (loaded === null) return [];
  // PID<TAB>Status<TAB>Label — a loaded agent with no pid ("-") is not a
  // running process, same rule as systemd's SubState above.
  const labels = new Set(loaded.split("\n").slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter(([pid, , label]) => label && /^\d+$/.test(pid))
    .map(([, , label]) => label));
  const dir = path.join(os.homedir(), "Library", "LaunchAgents");
  let plists = [];
  try { plists = fs.readdirSync(dir).filter((f) => f.endsWith(".plist")); } catch { return []; }
  const found = [];
  for (const f of plists) {
    const label = f.replace(/\.plist$/, "");
    if (!labels.has(label)) continue; // on disk but not loaded — nothing running to be stale
    // Read the plist as text: it may be XML or binary, and `plutil -p`
    // normalises both without adding a dependency.
    const entry = moduleOf(out("plutil", ["-p", path.join(dir, f)]));
    // unload+load is what this driver already uses for launchd elsewhere
    // (factory.mjs's schedule --install), so the hint stays consistent.
    if (entry) {
      found.push({ entry, name: label, restart: `launchctl unload ${path.join(dir, f)} && launchctl load ${path.join(dir, f)}` });
    }
  }
  return found;
};

// A unit runs its entry module AND everything that module imports, so
// matching the entry alone is the same defect one level down: the 2026-08-30
// deploy of b077aa1 changed status.mjs, left dashboard.mjs untouched, said
// nothing — and both dashboards kept serving the old derivation, because
// dashboard.mjs imports deriveFactoryStatus from it (T-043).
//
// The driver is zero-dependency and every local import is a `./`-relative
// single-line statement, so a regex plus a visited set is the whole graph —
// no parser, no package resolution. Anything else (`node:` builtins, bare
// specifiers) resolves outside the runtime and so can never be in a deploy's
// diff. The graph is read from the runtime as it stands NOW — post-advance,
// the candidate — because that is the code the unit will run once restarted.
const LOCAL_IMPORT = /(?:^|[\s;(])(?:import|export)\s[^;\n]*?["'](\.\/[^"']+)["']|import\s*\(\s*["'](\.\/[^"']+)["']\s*\)/g;

const reachableFrom = (entry) => {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue; // cycles terminate here
    seen.add(rel);
    let src;
    try { src = fs.readFileSync(path.join(RUNTIME, rel), "utf8"); } catch { continue; } // deleted, or not a file we ship
    for (const m of src.matchAll(LOCAL_IMPORT)) {
      queue.push(path.posix.join(path.posix.dirname(rel), m[1] ?? m[2]));
    }
  }
  return seen;
};

const changed = git(["diff", "--name-only", `${head}..${candidate}`]).split("\n").filter(Boolean);
const hints = [];
for (const { entry, name, restart } of [...systemdUnits(), ...launchdUnits()]) {
  // Name every changed module the unit reaches, not just one: after a
  // multi-commit deploy the reason it is stale is usually more than one file.
  const stale = [...reachableFrom(entry)].filter((m) => changed.includes(m)).sort();
  if (!stale.length) continue;
  hints.push(`${stale.map((m) => path.basename(m)).join(", ")} changed — ${name} still runs the OLD code; restart it (${restart})`);
}
for (const h of hints) log(`⚠ ${h}`);
const hintText = hints.map((h) => `\n⚠ ${h}`).join("");
await notify(registry, `✓ runtime now at ${candidate.slice(0, 7)} (was ${head.slice(0, 7)}, ${count} commit(s), ${Object.keys(registry?.factories ?? {}).length} factory doctor(s) green)${hintText}`);
