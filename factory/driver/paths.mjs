// Machine-side state layout (the machine-product premise): every factory's
// mutable state — config, secrets, logs, plan, board, STOP — lives under
// ~/.factory/projects/<name>-<hash8>/, outside the repo. Git can't clean it
// there, and a clone on another machine carries none of it. The project repo
// keeps only work data (.factory/spec|backlog|inbox).
//
// Shared by factory.mjs, init.mjs, dashboard.mjs, watchdog.mjs, and
// deploy-runtime.mjs so the key derivation can never drift between them.
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

// <state>/.env: KEY=VALUE lines, # comments. No expansion. Shared by the
// driver (session env, forge credentials) and the dashboard (per-project
// forge credentials) so the parse can't drift.
export const readEnvFile = (stateRoot) => {
  const p = path.join(stateRoot, ".env");
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

// Atomic JSON write: tmp file in the same dir, then rename over. For state
// files whose corruption is expensive (~/.claude.json, config.json,
// state.json, registry.json) — a crash mid-write must never leave a torn file.
export const writeJsonAtomic = (p, value) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, p);
};
