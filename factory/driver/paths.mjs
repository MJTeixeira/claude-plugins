// Machine-side state layout (the machine-product premise): every factory's
// mutable state — config, secrets, logs, plan, board, STOP — lives under
// ~/.factory/projects/<name>-<hash8>/, outside the repo. Git can't clean it
// there, and a clone on another machine carries none of it. The project repo
// keeps only work data (.factory/spec|backlog|inbox).
//
// Also the one home for the small machine primitives every module needs
// (state reads, process liveness, git exec): five drivers each grew their
// own copies and the copies drifted (2026-07-31 trash sweep) — shared by
// factory.mjs, init.mjs, dashboard.mjs, watchdog.mjs, supervisor.mjs, and
// deploy-runtime.mjs so none of it can drift again.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// basename + short path hash: two same-named projects on one machine must
// not share state (same rule as the worktrees root).
export const factoryKey = (project) =>
  `${path.basename(project)}-${createHash("sha256").update(project).digest("hex").slice(0, 8)}`;

// `home` is overridable for tests only — production callers pass nothing.
export const stateDir = (project, home = os.homedir()) =>
  path.join(home, ".factory", "projects", factoryKey(project));

// Tolerant JSON state read: absent, torn, or malformed all read as null —
// callers treat "no state" and "unreadable state" identically.
export const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
};

// KEY=VALUE lines, # comments. No expansion. One parser for every env-shaped
// file (<state>/.env, ~/.factory/telegram.env) so the format can't fork.
export const readEnvLines = (file) => {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0) env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return env;
};

// <state>/.env. Shared by the driver (session env, forge credentials) and
// the dashboard (per-project forge credentials) so the parse can't drift.
export const readEnvFile = (stateRoot) => readEnvLines(path.join(stateRoot, ".env"));

// Is this pid a RUNNING process? Zombies count as dead (owner decision
// 2026-07-31): a zombie can do no work, so a lock or dashboard tile backed
// by one must read as stopped, not running. kill(0) alone says "pid
// exists" — only ps exposes the Z state.
export const pidAlive = (pid) => {
  try { process.kill(pid, 0); } catch { return false; }
  try {
    const stat = execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8", timeout: 30_000 }).trim();
    return !!stat && !stat.startsWith("Z");
  } catch { return false; }
};

// One git exec shape (five modules had drifted timeouts and arg orders):
// pipes only, utf8, trimmed by default. Callers own cwd and timeout; `env`
// merges over process.env (the driver injects forge credentials this way).
export const execGit = (cwd, args, { timeoutMs, env, trim = true } = {}) => {
  const out = execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  return trim ? out.trim() : out;
};

// Atomic JSON write: tmp file in the same dir, then rename over. For state
// files whose corruption is expensive (~/.claude.json, config.json,
// state.json, registry.json) — a crash mid-write must never leave a torn file.
export const writeJsonAtomic = (p, value) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Per-process temp name: several drivers write the same machine-global
  // targets concurrently (every factory's trustWorkspace rewrites
  // ~/.claude.json on each addWorktree) — a shared temp path lets one
  // writer rename another's half-written file over the target.
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, p);
};

// Workspace trust (~/.claude.json): BOTH flags are required for a session
// to actually work — hasTrustDialogAccepted alone lets it run, but Claude
// Code only applies the project's `.claude/settings.json` allowlist (and
// its hooks) once hasCompletedProjectOnboarding is also set; without it a
// dontAsk session denies even `echo` (NOTES item 42). One home for the
// pair: the driver's trustWorkspace, init's trust step, and doctor's
// projectTrusted all read THIS object — stamping one flag while checking
// the other is how the half-trusted legacy state grew (review S12).
export const TRUST_FLAGS = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true };
