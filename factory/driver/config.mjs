// The canonical machine-side config.json schema — the single source of truth
// for a fresh factory (init.mjs) and for schema healing (`factory.mjs
// migrate`, the standing verb for factories whose config predates a key).
// Shared so the schema can never drift between what init writes and what
// migrate heals.
import * as fs from "node:fs";
import * as path from "node:path";
import { stateDir, writeJsonAtomic } from "./paths.mjs";
import { detectStack, parseAnswerFile } from "./workspace.mjs";
import { declarationFromAnswers } from "./schedule.mjs";

export const PLATFORM_SCHEDULER = { darwin: "launchd", linux: "systemd" };

export const DEFAULTS = {
  stack: "node",           // node | python | rust | go | dotnet | other
  autonomy: "pr-only",     // pr-only | auto-merge-dev | milestone-gates
  baseBranch: "dev",
  model: "sonnet",         // per-session default; plan entries override
  windowHours: 4,
  // "manual" is a first-class choice: no independent runs, on purpose
  // (NOTES item 25). Doctor verifies the declaration matches reality.
  schedule: PLATFORM_SCHEDULER[process.platform] ?? "manual",
  triageTime: "08:30",
  devTime: "09:00",
  reportTime: "13:30",
  workDays: "Mon-Fri",
  mirrors: "",             // comma list: notion,jira
};

// Add a new key here and old factories self-heal it on their next migrate.
export const buildConfig = (a) => ({
  enabled: true, // false = declared OFF switch: dev/triage/report refuse to run
  stack: a.stack, // drives the allowlist preset the driver injects into worktrees
  windowHours: Number(a.windowHours),
  autonomy: a.autonomy,
  baseBranch: a.baseBranch,
  tracker: "github", // = the forge's native tracker; "jira" routes needs-human + daily log to the Jira project in `jiraProject` (hand-set, like board)
  mirrors: a.mirrors ? a.mirrors.split(",").map((s) => s.trim()).filter(Boolean) : [],
  model: a.model,
  triageModel: a.model, // triage-only override; dev sessions keep `model`
  // The full declaration block (kind + per-mode time/days) — doctor verifies
  // installed units against it, `factory.mjs schedule --install` writes them.
  schedule: declarationFromAnswers(a),
  maxTurnsPerSession: 80,
  sessionTimeoutMin: 45,
  maxSessionsPerWindow: 12,
  permissionMode: "dontAsk",
  claudeCmd: "claude",
});

// Keys whose VALUE encodes owner intent and has no source of truth outside
// config.json, so healing must never invent one. `enabled` is the OFF switch
// (NOTES item 47): it lives ONLY here — not in an answerfile or DEFAULTS — so
// a missing key cannot be recovered; the owner must declare it. Auto-defaulting
// `true` would silently re-enable a factory the owner paused (blacklist,
// 2026-07-09). Contrast the rest of the schema, which is recoverable from a
// transition-era answerfile, detection, or a constant.
export const CONFIG_AMBIGUOUS_KEYS = new Set(["enabled"]);

// Schema healing (NOTES item 47 / blacklist 2026-07-09): a factory whose
// config predates a schema key would ride runtime updates without it. This
// adds any MISSING canonical key, NEVER overwriting an existing value.
// Detected stack beats the "node" default, and a transition-era factory.yaml
// (still on disk pre-cleanup) beats both — never invent from DEFAULTS what
// the owner or the project can still tell us. Value-ambiguous keys are not
// written; they are returned for the caller to warn about loudly.
export const healConfigSchema = (project) => {
  const p = path.join(stateDir(project), "config.json");
  const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  const answerPath = path.join(project, "factory.yaml");
  const a = { ...DEFAULTS, stack: detectStack(project) ?? "other",
    ...(fs.existsSync(answerPath) ? parseAnswerFile(answerPath) : {}) };
  const canonical = buildConfig(a);
  // triageModel heals from the factory's own declared model — the answerfile
  // default could silently downgrade a factory the owner runs on a higher tier.
  if (cfg.model) canonical.triageModel = cfg.model;
  const added = [];
  const missingAmbiguous = [];
  for (const [k, v] of Object.entries(canonical)) {
    if (k in cfg) continue; // never overwrite an owner's value
    if (CONFIG_AMBIGUOUS_KEYS.has(k)) { missingAmbiguous.push(k); continue; }
    cfg[k] = v;
    added.push(k);
  }
  if (added.length) writeJsonAtomic(p, cfg);
  return { added, missingAmbiguous };
};
