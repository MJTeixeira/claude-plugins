#!/usr/bin/env node
// Factory driver — portable (macOS/Linux; Windows is not a factory host), Node >= 18, zero deps.
//
//   node factory.mjs dev    --project <path>   # session loop for the daily window
//   node factory.mjs triage --project <path>   # one session: inputs -> backlog
//   node factory.mjs report --project <path>   # one session: window summary out
//
// The driver is deliberately dumb: it spawns fresh `claude -p` sessions and
// enforces limits (window, per-session timeout, session cap, STOP file).
// All intelligence lives in the prompts and the project's skills. The
// session<->driver contract is .factory/log/last-session.json.

import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { factoryKey, stateDir, writeJsonAtomic, readEnvFile } from "./paths.mjs";
import { materializeWorkspace, isInjectedPath, factorySkillNames, stripFactorySettings, buildSessionSettings, detectStack, detectEngines, missingGitignoreEntries, stampFactoryGitignore, stampFactoryReadme } from "./workspace.mjs";
import { healConfigSchema } from "./config.mjs";
import { SCHEDULE_KINDS, SCHEDULE_MODES, normalizeSchedule, validateDeclaration, generateUnits, parseInstalled, compareInstalled, defaultPathLine } from "./schedule.mjs";
import { deriveFactoryStatus } from "./status.mjs";
import { createForge, createTracker, nativeTrackerCheck } from "./forge.mjs";
import { parseMilestones, unparsedMilestoneHeadings, parseBacklogTasks as parseTasksInDir } from "./backlog-index.mjs";
import { jiraTracker } from "./jira.mjs";
import { jiraBoardInit, syncJiraBoard } from "./jira-board.mjs";
import { expectedOrigin, sameOrigin } from "./distribution.mjs";

// The checkout this driver runs from IS the runtime (deployed machines:
// ~/.factory/runtime, gated by deploy-runtime.mjs) — session tooling is
// injected into worktrees from here, never from the project repo.
const RUNTIME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// What every generated scheduler execs — the one gated machine runtime,
// never this checkout: schedule --install may run from any copy, but the
// units it writes must survive that copy disappearing.
const RUNTIME_DRIVER = path.join(os.homedir(), ".factory", "runtime", "factory", "driver", "factory.mjs");

const CONFIG_DEFAULTS = {
  enabled: true, // false = declared OFF: dev/triage/report refuse, everything else works
  windowHours: 4,
  autonomy: "pr-only",
  baseBranch: "dev",
  maxTurnsPerSession: 80,
  sessionTimeoutMin: 45,
  maxSessionsPerWindow: 12,
  mergeGateMinutes: 10,
  permissionMode: "dontAsk", // or "bypassPermissions" (sandboxed machines only)
  claudeCmd: "claude",
};

// ---------- helpers ----------

const fail = (msg) => {
  process.stderr.write(`factory: ${msg}\n`);
  process.exit(1);
};

const parseArgs = (argv) => {
  const [mode, ...rest] = argv;
  if (!["dev", "triage", "report", "doctor", "sync-board", "prep", "mcp-server", "migrate", "schedule", "promote"].includes(mode ?? "")) {
    fail("usage: node factory.mjs <dev|triage|report|doctor|sync-board|prep|mcp-server|migrate|schedule|promote> --project <path> [--max-sessions <n>] [--init] [--scheduled]");
  }
  let project = null;
  let maxSessions = null;
  let init = false;
  let scheduled = false;
  let milestone = null; // promote's positional argument
  // schedule-mode flags: one action + the --declare inputs. Times/days
  // flags double as "non-interactive" markers for --declare.
  const sched = { action: null, yes: false, kind: null, timezone: null, days: null, times: {}, modeDays: {}, gaveFlags: false };
  const schedAction = (a) => {
    if (sched.action && sched.action !== a) fail(`--${sched.action} and --${a} are mutually exclusive`);
    sched.action = a;
  };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--project") project = rest[++i];
    else if (rest[i] === "--max-sessions") maxSessions = Number(rest[++i]);
    else if (rest[i] === "--init") init = true;
    else if (rest[i] === "--scheduled") scheduled = true;
    else if (["--status", "--declare", "--adopt", "--install", "--uninstall"].includes(rest[i])) schedAction(rest[i].slice(2));
    else if (rest[i] === "--yes") sched.yes = true;
    else if (rest[i] === "--kind") { sched.kind = rest[++i]; sched.gaveFlags = true; }
    else if (rest[i] === "--timezone") { sched.timezone = rest[++i]; sched.gaveFlags = true; }
    else if (rest[i] === "--days") { sched.days = rest[++i]; sched.gaveFlags = true; }
    else if (["--triage", "--dev", "--report"].includes(rest[i])) { sched.times[rest[i].slice(2)] = rest[++i]; sched.gaveFlags = true; }
    else if (["--triage-days", "--dev-days", "--report-days"].includes(rest[i])) { sched.modeDays[rest[i].slice(2).replace(/-days$/, "")] = rest[++i]; sched.gaveFlags = true; }
    else if (mode === "promote" && !rest[i].startsWith("--") && !milestone) milestone = rest[i];
  }
  if (!project) fail("--project <path> is required");
  if (mode === "promote" && !milestone) fail("usage: node factory.mjs promote <milestone> --project <path>  (e.g. promote M3)");
  if (maxSessions !== null && (!Number.isInteger(maxSessions) || maxSessions < 1)) {
    fail("--max-sessions must be a positive integer");
  }
  return { mode, project: path.resolve(project), maxSessions, init, scheduled, sched, milestone };
};

const loadConfig = (stateRoot) => {
  const p = path.join(stateRoot, "config.json");
  if (!fs.existsSync(p)) {
    fail(`missing ${p} — run init.mjs (new factory) or \`factory.mjs migrate --project <path>\` (factory with legacy repo-side config)`);
  }
  return { ...CONFIG_DEFAULTS, ...JSON.parse(fs.readFileSync(p, "utf8")) };
};


const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
};

const nowStamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const today = () => new Date().toISOString().slice(0, 10);

const makeLogger = (logDir) => {
  fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, `factory-${today()}.log`);
  return (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    fs.appendFileSync(file, line + "\n");
    process.stdout.write(line + "\n");
  };
};

// ---------- session spawning ----------

// Feature-probe the CLI once per flag (--effort ~2.x, --mcp-config): a
// feature asking for a flag on an older CLI degrades to a logged warning
// instead of a dead session.
const cliFlags = new Map();
const cliSupports = (claudeCmd, flag) => {
  if (!cliFlags.has(flag)) {
    try {
      // shell on Windows for the same reason runSession spawns with one:
      // npm .cmd shims throw EINVAL under plain execFileSync (Node ≥18.20).
      cliFlags.set(flag, execFileSync(claudeCmd, ["--help"],
        { timeout: 30_000, encoding: "utf8", shell: process.platform === "win32" }).includes(flag));
    } catch {
      cliFlags.set(flag, false);
    }
  }
  return cliFlags.get(flag);
};

// overrides: per-session {model, effort, maxTurns} from the triage plan;
// anything unset falls back to config, then the machine default.
// mode (dev|triage|report) reaches the session env as FACTORY_MODE — the
// PreToolUse guard hook is a no-op without it (interactive sessions).
const runSession = ({ project, cfg, env, promptText, sessionLogPath, log, mode, overrides = {} }) =>
  new Promise((resolve) => {
    const args = [
      "-p",
      "--output-format",
      "stream-json", // per-message events: usage survives a killed session (NOTES item 29)
      "--verbose", // required by -p stream-json
      "--permission-mode",
      cfg.permissionMode,
      "--max-turns",
      String(overrides.maxTurns ?? cfg.maxTurnsPerSession),
    ];
    const model = overrides.model ?? cfg.model;
    if (model) args.push("--model", model);
    const effort = overrides.effort ?? cfg.effort;
    if (effort) {
      if (cliSupports(cfg.claudeCmd, "--effort")) args.push("--effort", effort);
      else log(`effort '${effort}' requested but this claude CLI has no --effort — running without it`);
    }
    // factory-v2 O2: every session gets the reporting MCP server — claude
    // spawns a fresh instance of THIS driver file per session. Events land
    // next to the session log on the PROJECT side (absolute path), so they
    // outlive the session's worktree and are readable mid-run.
    let mcpEventsPath = null;
    if (cliSupports(cfg.claudeCmd, "--mcp-config")) {
      mcpEventsPath = sessionLogPath.replace(/\.out$/, ".mcp.jsonl");
      const mcpConfigPath = sessionLogPath.replace(/\.out$/, ".mcp-config.json");
      fs.writeFileSync(mcpConfigPath, JSON.stringify({
        mcpServers: {
          factory: {
            command: process.execPath,
            args: [fileURLToPath(import.meta.url), "mcp-server", "--project", project],
            env: { FACTORY_MCP_EVENTS: mcpEventsPath },
          },
        },
      }, null, 2));
      // The one non-flag arg in a shell:true spawn (Windows) — quote it, or
      // a project path with spaces tokenizes into garbage. `"` is illegal in
      // Windows paths, so plain wrapping is safe.
      args.push("--mcp-config", process.platform === "win32" ? `"${mcpConfigPath}"` : mcpConfigPath);
    } else {
      log("this claude CLI has no --mcp-config — sessions fall back to last-session.json reporting");
    }
    const isWin = process.platform === "win32";
    // Prompt goes via stdin: avoids arg-quoting differences across OSes.
    const child = spawn(cfg.claudeCmd, args, {
      cwd: project,
      env: {
        ...process.env, ...env, FACTORY_MODE: mode ?? "dev", FACTORY_BASE_BRANCH: cfg.baseBranch,
        ...(mcpEventsPath ? { FACTORY_MCP_EVENTS: mcpEventsPath } : {}),
      },
      // .cmd shims on Windows need a shell; args are flag-only, so this is safe.
      shell: isWin,
      // POSIX: own process group, so a timeout kill reaches claude's children too.
      detached: !isWin,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // stdout is the session's JSON result — keep stderr out of it.
    const out = fs.createWriteStream(sessionLogPath);
    child.stdout.pipe(out);
    child.stderr.pipe(fs.createWriteStream(sessionLogPath.replace(/\.out$/, ".err")));

    const killTree = (signal) => {
      if (!isWin && child.pid) {
        try {
          process.kill(-child.pid, signal); // whole process group
          return;
        } catch {
          /* group already gone — fall through */
        }
      }
      child.kill(signal);
    };

    let timedOut = false;
    const timeoutMs = cfg.sessionTimeoutMin * 60 * 1000;
    const timer = setTimeout(() => {
      timedOut = true;
      log(`session timeout (${cfg.sessionTimeoutMin}min) — terminating`);
      killTree("SIGTERM");
      setTimeout(() => killTree("SIGKILL"), 15_000).unref();
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      log(`failed to spawn ${cfg.claudeCmd}: ${err.message}`);
      resolve({ exitCode: -1, timedOut, mcpEventsPath });
    });
    // 'exit', not 'close': a killed child's orphans can hold the stdio pipes
    // open forever, and 'close' would never fire.
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, timedOut, mcpEventsPath });
    });

    child.stdin.write(promptText);
    child.stdin.end();
  });

const readSessionResult = (factoryDir) => {
  const p = path.join(factoryDir, "log", "last-session.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

// The session .out is stream-json (one event per line): assistant events
// carry per-message usage, a final `result` event carries cost/turns. A
// killed session has no result event but its assistant events survive —
// the whole point (NOTES item 29). Also tolerates the old single-JSON
// .out format (pre-stream files, older CLIs).
const parseSessionStream = (sessionLogPath) => {
  const sum = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, messages: 0 };
  let result = null;
  let lastAssistantText = "";
  try {
    for (const line of fs.readFileSync(sessionLogPath, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let e;
      try { e = JSON.parse(t); } catch { continue; }
      if (e.type === "result" || (e.type === undefined && (e.result !== undefined || e.subtype !== undefined))) {
        result = e;
      } else if (e.type === "assistant" && e.message?.usage) {
        const u = e.message.usage;
        sum.messages += 1;
        sum.input += u.input_tokens ?? 0;
        sum.output += u.output_tokens ?? 0;
        sum.cacheRead += u.cache_read_input_tokens ?? 0;
        sum.cacheCreate += u.cache_creation_input_tokens ?? 0;
        if (Array.isArray(e.message.content)) {
          const text = e.message.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
          if (text) lastAssistantText = text;
        }
      }
    }
  } catch { /* unreadable/absent .out — caller sees no result, no messages */ }
  const finalText = typeof result?.result === "string" && result.result ? result.result : lastAssistantText;
  return { result, sum, finalText };
};

// A session that ends without last-session.json is not necessarily dead:
// `claude -p` exits 1 on the turn cap too, even when the work landed
// (NOTES item 12 — all three factories hit this on 2026-07-05). Read the
// raw session output to tell "ran out of turns mid-wrap-up" from a crash.
const classifySessionEnd = (sessionLogPath) => {
  const { result, finalText } = parseSessionStream(sessionLogPath);
  if (!result) return { kind: "no-json", finalText }; // killed before the result event — a real death
  const capped =
    result.subtype === "error_max_turns" ||
    result.terminal_reason === "max_turns" ||
    (result.errors ?? []).some((e) => /maximum number of turns/i.test(String(e)));
  return { kind: capped ? "turn-capped" : "errored", finalText };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- state the driver gathers for sessions ----------

// Cheap deterministic snapshot so a session after an unreported one lands
// the leftovers instead of spending paid turns re-discovering what happened.
const repoSnapshot = ({ project, env, forge }) => {
  const run = (cmd, args) => {
    try {
      return execFileSync(cmd, args, { cwd: project, env: { ...process.env, ...env }, timeout: 30_000, encoding: "utf8" }).trim();
    } catch {
      return "(unavailable)";
    }
  };
  let prs;
  try { prs = forge.prListText().trim() || "(none)"; } catch { prs = "(unavailable)"; }
  return [
    `current branch: ${run("git", ["branch", "--show-current"])}`,
    `working tree:\n${run("git", ["status", "--short"]) || "(clean)"}`,
    `recent commits:\n${run("git", ["log", "--oneline", "-8", "--all"])}`,
    `open PRs:\n${prs}`,
  ].join("\n\n");
};

// Append cost/token facts to usage.jsonl. Three cases: a result event
// (normal end — exact cost), assistant events only (killed session — sum
// the per-message usage; a lower bound, but a 45-min killed session must
// not vanish from spend tracking, NOTES item 29), or nothing parseable
// (null row so the session at least EXISTS in usage.jsonl).
const recordUsage = ({ factoryDir, sessionLogPath, mode, taskId, status, model, log }) => {
  const { result, sum } = parseSessionStream(sessionLogPath);
  const base = { ts: new Date().toISOString(), mode, taskId: taskId ?? null, status: status ?? null, model: model ?? null };
  let row;
  if (result) {
    const u = result.usage ?? {};
    row = {
      ...base,
      costUsd: result.total_cost_usd ?? null,
      turns: result.num_turns ?? null,
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheCreateTokens: u.cache_creation_input_tokens ?? 0,
    };
  } else if (sum.messages) {
    row = {
      ...base, costUsd: null, turns: null,
      inputTokens: sum.input, outputTokens: sum.output,
      cacheReadTokens: sum.cacheRead, cacheCreateTokens: sum.cacheCreate,
      partial: true, // killed mid-run: summed from the events streamed so far (lower bound)
    };
  } else {
    row = {
      ...base, costUsd: null, turns: null,
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreateTokens: null,
    };
  }
  fs.appendFileSync(path.join(factoryDir, "log", "usage.jsonl"), JSON.stringify(row) + "\n");
  if (row.costUsd != null) log(`session usage: $${row.costUsd.toFixed(2)}, ${row.turns} turns${row.model ? ` [${row.model}]` : ""}`);
  else if (row.partial) log(`session usage (killed mid-run, lower bound): ${row.outputTokens} output tokens over ${sum.messages} message(s)${row.model ? ` [${row.model}]` : ""}`);
  else log(`session usage unknown (no parseable output at all)${model ? ` [${model}]` : ""}`);
  return row;
};

// First non-empty of stderr/stdout/message: git puts the interesting text
// on either stream depending on the failure (one fleet sweep logged three
// bare "attempt failed ()" retries because "nothing to commit" is stdout).
const firstLine = (e) =>
  String([e?.stderr, e?.stdout, e?.message].find((s) => s && String(s).trim()) ?? e)
    .trim().split("\n")[0].slice(0, 200);

// ---------- backlog parsing (shared by doctor, board sync, status ledger) ----------

// `blocked` is machine-clearable (dependency/technical — triage re-opens it);
// `needs-human` only the owner clears (visual judgment, product decisions).
const BOARD_STATUSES = ["todo", "in-progress", "review", "blocked", "needs-human", "done"];

// Model tiers for pin enforcement: haiku < sonnet < opus < fable. Substring
// match so aliases and full model ids both rank; anything else (custom ids)
// is unrankable → null, and enforcement stays out of the way.
const MODEL_TIERS = ["haiku", "sonnet", "opus", "fable"];
const tierOf = (m) => {
  const i = MODEL_TIERS.findIndex((k) => String(m ?? "").toLowerCase().includes(k));
  return i === -1 ? null : i;
};

// root: which .factory to read — the project checkout (doctor, read-only
// callers) or the meta worktree (runtime callers; see runtimeFactoryDir).
// The parsing itself lives in backlog-index.mjs, shared with the dashboard.
const parseBacklogTasks = (root = dataDir) => parseTasksInDir(path.join(root, "backlog"));

// ---------- repo state machine (NOTES item 23) ----------
// The working tree is a driver-owned resource: clean, on the base branch,
// at origin tip at every boundary (window start, between sessions, window
// end, before triage). Dirty state is quarantined — bytes copied to
// .factory/log/quarantine-<ts>/ AND stashed — never destroyed, never left
// to poison the next session or a human deploy (a real deploy race on the fleet, 2026-07-07).

const isGitRepo = () => fs.existsSync(path.join(project, ".git"));
const gitRaw = (args, cwd = project) =>
  execFileSync("git", args, {
    cwd, env: { ...process.env, ...env }, timeout: 120_000,
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
const git = (args, cwd) => gitRaw(args, cwd).trim();
const gitOk = (args, cwd) => { try { git(args, cwd); return true; } catch { return false; } };
const hasOrigin = () => gitOk(["remote", "get-url", "origin"]);

// -z: NUL-separated, no quoting. Rename records carry a second NUL field
// (the original path) — consume it. gitRaw: a leading " M" space in the
// first record must survive (trim() would shift every offset).
const statusRecords = (cwd) => {
  const records = gitRaw(["status", "--porcelain", "-z"], cwd).split("\0").filter(Boolean);
  const out = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const status = rec.slice(0, 2);
    if (status[0] === "R" || status[0] === "C") i++; // skip origin-path field
    out.push({ status, rel: rec.slice(3) });
  }
  return out;
};

// skipInjected: worktree copies leave materialized tooling behind — it is
// runtime property, not a session's lost work (and a repo that TRACKS an
// injected path would otherwise put it in every quarantine). The owner-
// checkout quarantine never sets it: nothing is injected there.
const copyDirtyBytes = (cwd, stamp, { skipInjected = false } = {}) => {
  const qdir = path.join(logDir, `quarantine-${stamp}`);
  let copied = 0;
  for (const { rel } of statusRecords(cwd)) {
    if (skipInjected && isInjectedPath(rel)) continue;
    const src = path.join(cwd, rel);
    if (!fs.existsSync(src)) continue; // deletions live on in the stash
    const dest = path.join(qdir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try { fs.cpSync(src, dest, { recursive: true }); copied++; } catch { /* copy is belt, stash is suspenders */ }
  }
  return { qdir, copied };
};

const quarantineDirty = () => {
  if (!git(["status", "--porcelain"])) return null;
  const stamp = nowStamp();
  const { qdir, copied } = copyDirtyBytes(project, stamp);
  try { git(["stash", "push", "--include-untracked", "-m", `factory quarantine ${stamp}`]); } catch { /* e.g. nothing stashable */ }
  git(["reset", "--hard"]);
  git(["clean", "-fd"]);
  return { qdir, copied };
};

// Throws when the tree cannot be brought to a known-good state (missing
// base branch, checkout failure) — callers decide whether that kills the
// run. Everything recoverable is handled + logged here.
const ensureCleanBase = async (context) => {
  if (!isGitRepo()) return;
  const base = cfg.baseBranch;
  const origin = hasOrigin();
  if (origin && !gitOk(["fetch", "origin", "--prune"])) {
    log(`repo(${context}): git fetch failed — continuing with local refs`);
  }
  const q = quarantineDirty();
  if (q) {
    log(`repo(${context}): dirty tree — ${q.copied} path(s) quarantined to ${q.qdir} (also stashed), tree reset`);
    await notify(`⚠ dirty tree at ${context} — quarantined to .factory/log/${path.basename(q.qdir)}, window continues`);
  }
  const cur = git(["branch", "--show-current"]);
  if (cur !== base) {
    git(["checkout", base]); // throws if base doesn't exist — fatal, caller handles
    log(`repo(${context}): checked out ${base} (was ${cur || "detached HEAD"})`);
  }
  if (origin && gitOk(["rev-parse", "--verify", `origin/${base}`])) {
    const ahead = Number(git(["rev-list", "--count", `origin/${base}..${base}`]));
    const behind = Number(git(["rev-list", "--count", `${base}..origin/${base}`]));
    if (ahead && behind) {
      // Never destroy committed work: park it on a rescue branch, then align.
      const rescue = `factory/rescue-${nowStamp()}`;
      git(["branch", rescue, base]);
      try { git(["push", "origin", rescue]); } catch { /* rescue stays local */ }
      git(["reset", "--hard", `origin/${base}`]);
      log(`repo(${context}): ${base} DIVERGED from origin (${ahead} local / ${behind} remote) — local commits saved to ${rescue}, reset to origin/${base}`);
      await notify(`⚠ ${base} diverged from origin — local commits saved to branch ${rescue}`);
    } else if (ahead) {
      // Our own metadata commits (or trunk commits made in this checkout) —
      // the trunk is shared state, publish it.
      try {
        git(["push", "origin", base]);
        log(`repo(${context}): pushed ${ahead} local commit(s) on ${base}`);
      } catch (e) {
        log(`repo(${context}): push of ${ahead} local ${base} commit(s) failed (${firstLine(e)}) — retrying next boundary`);
      }
    } else if (behind) {
      git(["reset", "--hard", `origin/${base}`]);
      log(`repo(${context}): fast-forwarded ${base} to origin (+${behind})`);
    }
  }
};

// ---------- worktrees (factory-v2 O9) ----------
// Sessions and all driver git work run in worktrees under
// ~/.factory/worktrees/<name>/ — the owner's checkout is theirs: the driver
// never flips its branch, never quarantines its WIP mid-window (that
// machinery survives in ensureCleanBase for `prep`, the explicit
// make-it-clean command). Origin is the rendezvous point: sessions start
// from origin/<base>, and owner work is invisible until pushed.

// Keyed by basename + a short path hash: two same-named projects on one
// machine must not share a meta worktree (silent cross-repo corruption).
const worktreesRoot = () =>
  path.join(os.homedir(), ".factory", "worktrees",
    factoryKey(project));
const startRef = () =>
  hasOrigin() && gitOk(["rev-parse", "--verify", `origin/${cfg.baseBranch}`]) ? `origin/${cfg.baseBranch}` : cfg.baseBranch;

// A worktree is a NEW workspace path — without a trust entry the session
// silently loses every mutating tool (NOTES item 11). BOTH flags are
// required: hasTrustDialogAccepted alone lets the session run, but Claude
// Code only applies the project's `.claude/settings.json` allowlist (and
// its hooks) once hasCompletedProjectOnboarding is also set — without it a
// dontAsk session in the worktree denies even `echo`, and heavy-Bash
// sessions (triage's gh calls) thrash on the denials (NOTES item 42).
const TRUST_FLAGS = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true };
const trustWorkspace = (p) => {
  const cj = path.join(os.homedir(), ".claude.json");
  let j = {};
  try { j = JSON.parse(fs.readFileSync(cj, "utf8")); } catch { /* first write */ }
  j.projects ??= {};
  const keys = new Set([p]);
  try { keys.add(fs.realpathSync(p)); } catch { /* not created yet */ }
  let changed = false;
  for (const k of keys) {
    if (Object.entries(TRUST_FLAGS).some(([f, v]) => j.projects[k]?.[f] !== v)) {
      j.projects[k] = { ...(j.projects[k] ?? {}), ...TRUST_FLAGS };
      changed = true;
    }
  }
  // Atomic on purpose: ~/.claude.json is ALL of Claude Code's user state —
  // a torn write here breaks every session on the machine, not just ours.
  if (changed) writeJsonAtomic(cj, j);
};

const addWorktree = (name) => {
  fs.mkdirSync(worktreesRoot(), { recursive: true });
  const p = path.join(worktreesRoot(), name);
  if (hasOrigin() && !gitOk(["fetch", "origin", "--prune"])) log("worktree add: fetch failed — using local refs");
  gitOk(["worktree", "prune"]); // stale registrations from force-removed dirs
  git(["worktree", "add", "--detach", p, startRef()]);
  // Throws on failure, ending the window: a session without its injected
  // allowlist runs dontAsk with every mutating tool denied and thrashes on
  // the denials (NOTES item 42) — better no session than that.
  const injected = materializeWorkspace({ worktree: p, runtimeRoot: RUNTIME_ROOT, config: cfg });
  log(`worktree ${name}: ${injected.length} tooling path(s) injected from the runtime`);
  trustWorkspace(p);
  return p;
};

const removeWorktree = (p, context) => {
  if (!p) return;
  // A dirty throwaway worktree is a capped/killed session's uncommitted
  // work — copy the bytes to log/quarantine-* before --force destroys them
  // (NOTES item 45: fleet task T-034 lost 121 turns this way; the checkout
  // had this protection since item 23, worktrees never did).
  try {
    // Injected tooling doesn't count as dirt — see copyDirtyBytes.
    if (statusRecords(p).some(({ rel }) => !isInjectedPath(rel))) {
      const q = copyDirtyBytes(p, nowStamp(), { skipInjected: true });
      log(`${context}: dirty worktree — ${q.copied} path(s) copied to ${q.qdir} before removal`);
    }
  } catch { /* not a live worktree — nothing to save */ }
  try {
    git(["worktree", "remove", "--force", p]);
  } catch (e) {
    // Root-owned docker leftovers etc. (NOTES item 33's family) — best effort.
    log(`${context}: worktree remove failed (${firstLine(e)}) — pruning`);
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* leave for manual cleanup */ }
    gitOk(["worktree", "prune"]);
  }
};

// prep-only: a LOCKED registered worktree whose locker died lingers forever —
// `worktree prune` skips locked entries, and quarantine can't remove a
// registered worktree (git resurrects it). A bridge/cloud session crash left
// one in a fleet repo for days (2026-07-14): permanent dirty tree, window-end
// ff refused. Only locks whose reason carries a DEAD pid are pruned; a lock
// with no parsable pid is a deliberate hold — preserved, but logged so it
// never lingers invisibly. Any throw on the liveness probe counts as dead,
// matching the window-lock check (same-user machine).
const pruneStaleLockedWorktrees = () => {
  let out;
  try { out = git(["worktree", "list", "--porcelain"]); } catch { return; }
  for (const block of out.split("\n\n")) {
    const wtPath = block.match(/^worktree (.+)$/m)?.[1];
    const locked = block.match(/^locked(?: (.*))?$/m);
    if (!wtPath || !locked || path.resolve(wtPath) === path.resolve(project)) continue;
    const pid = Number(locked[1]?.match(/\bpid[ =:]*(\d+)\b/i)?.[1] ?? (/^\s*(\d+)\s*$/.exec(locked[1] ?? "")?.[1]));
    if (!pid) {
      log(`prep: locked worktree ${wtPath} — no pid in lock reason ("${(locked[1] ?? "").trim()}"), leaving it`);
      continue;
    }
    try { process.kill(pid, 0); continue; } catch { /* locker is dead */ }
    try {
      if (fs.existsSync(wtPath) && statusRecords(wtPath).some(({ rel }) => !isInjectedPath(rel))) {
        const q = copyDirtyBytes(wtPath, nowStamp(), { skipInjected: true });
        log(`prep: stale-locked worktree ${wtPath} — ${q.copied} dirty path(s) copied to ${q.qdir} before removal`);
      }
    } catch { /* unreadable worktree — the registration still has to go */ }
    try {
      git(["worktree", "remove", "--force", "--force", wtPath]);
      log(`prep: removed stale-locked worktree ${wtPath} (locker pid ${pid} is dead)`);
    } catch (e) {
      log(`prep: stale-locked worktree ${wtPath} could not be removed (${firstLine(e)}) — remove it by hand`);
    }
  }
  gitOk(["worktree", "prune"]);
};

// The driver's own working copy for tracked metadata (backlog flips, gate
// merges, triage output): one persistent DETACHED worktree, refreshed from
// origin at every boundary. Detached because the owner's checkout may hold
// the base branch, and git refuses the same branch in two worktrees;
// commits land on origin via `push HEAD:<base>`.
const metaPath = () => path.join(worktreesRoot(), "meta");
const metaDir = () => path.join(metaPath(), ".factory");
const runtimeFactoryDir = () => (isGitRepo() ? metaDir() : dataDir);

const pushMetaBase = () => git(["push", "origin", `HEAD:${cfg.baseBranch}`], metaPath());

// Triage/report sessions run in meta but must see the project's runtime
// state: log/ for facts (report reads the day's sessions, triage corrects
// against usage.jsonl) and plan.json as triage's output channel. Both are
// gitignored, so the links survive refresh (clean -fd skips ignored paths)
// and never reach metadata commits (add -A skips ignored paths too).
const linkMetaRuntime = () => {
  try {
    fs.mkdirSync(metaDir(), { recursive: true });
    for (const [target, name] of [[logDir, "log"], [path.join(stateD, "plan.json"), "plan.json"]]) {
      const linkPath = path.join(metaDir(), name);
      const st = fs.lstatSync(linkPath, { throwIfNoEntry: false });
      if (st?.isSymbolicLink()) {
        if (fs.readlinkSync(linkPath) === target) continue; // already correct
        // Pre-migration links point at the repo-side paths migrate moved
        // away — writing through such a dangling link would silently
        // recreate state INSIDE the repo. Re-point it. unlinkSync, not
        // rmSync: rmSync follows a symlink-to-directory and throws EISDIR.
        fs.unlinkSync(linkPath);
      } else if (st) {
        continue; // a real file/dir — not ours to destroy
      }
      fs.symlinkSync(target, linkPath);
    }
  } catch (e) {
    log(`meta runtime links failed (${firstLine(e)}) — triage/report sessions may not see logs/plan`);
  }
};

// Build the persistent meta worktree fresh at the base tip. Used for the
// first-ever refresh and as the recovery path when an in-place advance can't
// be salvaged.
const createMetaWorktree = () => {
  fs.mkdirSync(worktreesRoot(), { recursive: true });
  gitOk(["worktree", "prune"]);
  git(["worktree", "add", "--detach", metaPath(), startRef()]);
  linkMetaRuntime();
  materializeWorkspace({ worktree: metaPath(), runtimeRoot: RUNTIME_ROOT, config: cfg });
};

const refreshMeta = () => {
  if (!isGitRepo()) return;
  if (hasOrigin() && !gitOk(["fetch", "origin", "--prune"])) log("meta: fetch failed — using local refs");
  if (!fs.existsSync(path.join(metaPath(), ".git"))) {
    createMetaWorktree();
    return;
  }
  // Unpushed metadata commits (a failed push at the last boundary): retry,
  // park on a rescue branch if the push still fails — never silently reset
  // committed work away. This runs BEFORE any reset/recreate below, so the
  // recovery path can never discard committed work.
  if (hasOrigin() && !gitOk(["merge-base", "--is-ancestor", "HEAD", startRef()], metaPath())) {
    try {
      pushMetaBase();
      log("meta: pushed metadata commit(s) left over from a failed push");
    } catch (e) {
      const rescue = `factory/meta-rescue-${nowStamp()}`;
      gitOk(["branch", rescue], metaPath());
      log(`meta: unpushed commits could not be pushed (${firstLine(e)}) — parked on ${rescue}`);
    }
  }
  // Advance the persistent worktree in place. Reset FIRST so a dirty tree (a
  // died triage session's edits) can't make the checkout fail. But `reset
  // --hard` can't clear a skip-worktree'd path (item 50: materialization sets
  // skip-worktree on a TRACKED settings.local.json), so a meta worktree
  // stranded at a commit that still tracks tooling the base branch has since
  // dropped throws "local changes would be overwritten" on checkout — and
  // stays stranded, wedging every window (a fleet project, 4 days). The meta worktree
  // is disposable derived state (committed work was pushed/parked above), so
  // on ANY advance failure, drop it and recreate fresh rather than throw
  // "repo not ready" forever — refreshMeta must self-heal, not wedge nightly.
  try {
    gitOk(["reset", "--hard"], metaPath());
    git(["checkout", "--detach", startRef()], metaPath());
    git(["reset", "--hard", startRef()], metaPath());
    gitOk(["clean", "-fd"], metaPath());
    linkMetaRuntime();
    // Injected tooling survives clean -fd (it's excluded = ignored), and
    // re-materializing keeps the persistent meta worktree current across
    // runtime deploys. Triage/report sessions run in meta.
    materializeWorkspace({ worktree: metaPath(), runtimeRoot: RUNTIME_ROOT, config: cfg });
  } catch (e) {
    log(`meta: worktree wedged (${firstLine(e)}) — recreating from ${startRef()}`);
    removeWorktree(metaPath(), "meta recreate");
    createMetaWorktree();
  }
};

// The one thing the driver still does to the owner's checkout: fast-forward
// it when it is clean AND on base AND strictly behind — so dashboards and
// walk-up reads stay fresh. Anything else about that tree is the owner's.
const ffOwnerCheckout = () => {
  if (!isGitRepo() || !hasOrigin()) return;
  try {
    if (git(["status", "--porcelain"])) return;
    if (git(["branch", "--show-current"]) !== cfg.baseBranch) return;
    if (!gitOk(["rev-parse", "--verify", `origin/${cfg.baseBranch}`])) return;
    const ahead = Number(git(["rev-list", "--count", `origin/${cfg.baseBranch}..${cfg.baseBranch}`]));
    const behind = Number(git(["rev-list", "--count", `${cfg.baseBranch}..origin/${cfg.baseBranch}`]));
    if (behind && !ahead) {
      git(["merge", "--ff-only", `origin/${cfg.baseBranch}`]);
      log(`owner checkout fast-forwarded to origin/${cfg.baseBranch} (+${behind})`);
    }
  } catch (e) {
    log(`owner checkout fast-forward skipped (${firstLine(e)})`);
  }
};

// ---------- status ledger (NOTES item 24) ----------
// Sessions report status ONLY via last-session.json; the driver owns every
// backlog Status: edit. Ephemeral states (in-progress, review) live here in
// state.json — the open PR is the durable record of "review". Durable flips
// (done, blocked) are folded into commits the driver already makes; a flip
// that can't land immediately waits in pendingFlips for the next one.

const statePath = () => path.join(logDir, "state.json");
const readState = () => {
  const s = readJson(statePath());
  return { tasks: {}, pendingFlips: [], ...(s ?? {}) };
};
const writeState = (s) => writeJsonAtomic(statePath(), s);

const noteRuntimeStatus = (taskId, status, prUrl) => {
  if (!taskId || !status) return;
  const s = readState();
  s.tasks[taskId] = {
    status,
    pr: prUrl ?? s.tasks[taskId]?.pr ?? null,
    updatedAt: new Date().toISOString(),
  };
  writeState(s);
};

// Edit the Status: line of one task in its epic file (in the meta worktree —
// tracked metadata is written there and pushed, never in the owner's
// checkout). Idempotent.
const setTaskStatusInFiles = (taskId, status) => {
  const dir = path.join(runtimeFactoryDir(), "backlog");
  if (!fs.existsSync(dir)) return { ok: false, reason: "no backlog dir" };
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "index.md")) {
    const p = path.join(dir, f);
    const text = fs.readFileSync(p, "utf8");
    const m = text.match(new RegExp(`^## ${taskId}:.*$`, "m"));
    if (!m) continue;
    const start = m.index;
    const nextHead = text.indexOf("\n## ", start + 1);
    const end = nextHead === -1 ? text.length : nextHead;
    const block = text.slice(start, end);
    const cur = block.match(/^-\s*Status:\s*(\S+)/m)?.[1];
    if (!cur) return { ok: false, reason: `no Status line under ${taskId} in ${f}` };
    if (cur === status) return { ok: true, unchanged: true, file: f };
    const updated = block.replace(/^(-\s*Status:\s*)\S+/m, `$1${status}`);
    fs.writeFileSync(p, text.slice(0, start) + updated + text.slice(end));
    return { ok: true, file: f };
  }
  return { ok: false, reason: `${taskId} not found in any epic file` };
};

// Link a filed question issue on its task (`- Question: <url>` under the
// Status line) so the owner and the board can jump to it. Idempotent.
const addTaskLinkInFiles = (taskId, url) => {
  const dir = path.join(runtimeFactoryDir(), "backlog");
  if (!fs.existsSync(dir)) return false;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "index.md")) {
    const p = path.join(dir, f);
    const text = fs.readFileSync(p, "utf8");
    const m = text.match(new RegExp(`^## ${taskId}:.*$`, "m"));
    if (!m) continue;
    const start = m.index;
    const nextHead = text.indexOf("\n## ", start + 1);
    const end = nextHead === -1 ? text.length : nextHead;
    const block = text.slice(start, end);
    if (block.includes(url)) return false; // already linked
    const updated = block.replace(/^(-\s*Status:.*)$/m, `$1\n- Question: ${url}`);
    if (updated === block) return false; // no Status line to anchor on
    fs.writeFileSync(p, text.slice(0, start) + updated + text.slice(end));
    return true;
  }
  return false;
};

// Keep index.md's "n/m done" counters honest after flips. Only lines that
// already carry the `backlog/<epic>.md — n/m done` shape are rewritten.
const refreshIndexCounts = () => {
  const dir = path.join(runtimeFactoryDir(), "backlog");
  const ip = path.join(dir, "index.md");
  if (!fs.existsSync(ip)) return;
  const counts = {};
  for (const t of parseBacklogTasks(runtimeFactoryDir())) {
    counts[`${t.epic}.md`] ??= { done: 0, total: 0 };
    counts[`${t.epic}.md`].total++;
    if (t.status === "done") counts[`${t.epic}.md`].done++;
  }
  const out = fs.readFileSync(ip, "utf8").split("\n").map((line) => {
    const m = line.match(/^(.*backlog\/([\w.-]+\.md)\s*—\s*)(\d+)\/(\d+)( done.*)$/);
    if (!m || !counts[m[2]]) return line;
    return `${m[1]}${counts[m[2]].done}/${counts[m[2]].total}${m[5]}`;
  }).join("\n");
  fs.writeFileSync(ip, out);
};

// Apply flips (given + pending) to the backlog files. Returns descriptions
// of real changes; failures stay pending for the next attempt. Assumes the
// tree is on the base branch — callers go through ensureCleanBase first.
const applyFlips = (flips) => {
  const s = readState();
  const queue = [...(s.pendingFlips ?? []), ...flips];
  const stillPending = [];
  const applied = [];
  for (const f of queue) {
    const r = setTaskStatusInFiles(f.taskId, f.status);
    if (r.ok) {
      if (!r.unchanged) applied.push(`${f.taskId} → ${f.status}`);
      s.tasks[f.taskId] = { ...(s.tasks[f.taskId] ?? {}), status: f.status, updatedAt: new Date().toISOString() };
    } else {
      stillPending.push(f);
      log(`status flip ${f.taskId} → ${f.status} failed (${r.reason}) — kept pending`);
    }
  }
  s.pendingFlips = stillPending;
  writeState(s);
  if (applied.length) refreshIndexCounts();
  return applied;
};

// Commit whatever changed under .factory (backlog/spec/inbox — .gitignore
// keeps log/tmp/plan/board/.env out) in the meta worktree and push
// HEAD:<base>. Metadata is exempt from PR-gating at every autonomy level
// (owner decision, NOTES item 24); product code never goes through here.
const commitMetadata = (message) => {
  if (!isGitRepo()) return false;
  git(["add", "-A", ".factory"], metaPath());
  // Belt over the .gitignore braces: the runtime links (log, plan.json) must
  // never ride a metadata commit — a pushed log symlink loops every checkout.
  gitOk(["reset", "-q", "--", ".factory/log", ".factory/plan.json"], metaPath());
  if (gitOk(["diff", "--cached", "--quiet"], metaPath())) return false; // nothing staged
  git(["commit", "-m", message], metaPath());
  if (hasOrigin()) {
    try { pushMetaBase(); }
    catch (e) { log(`metadata push failed (${firstLine(e)}) — next boundary will push`); }
  }
  return true;
};

// Backlog tasks with runtime statuses overlaid — what the board and the
// dashboard should show. File-status `done` always wins (the ledger and the
// files agree the moment a flip lands).
const effectiveTasks = () => {
  const s = readState();
  return parseBacklogTasks(runtimeFactoryDir()).map((t) => {
    const rt = s.tasks[t.id];
    if (rt && rt.status !== t.status && t.status !== "done") return { ...t, status: rt.status };
    return t;
  });
};

// Short prompt section so sessions trust runtime state over lagging files.
const stateOverlayNote = () => {
  const s = readState();
  const fileStatus = new Map(parseBacklogTasks(runtimeFactoryDir()).map((t) => [t.id, t.status]));
  const lines = [];
  for (const [id, rec] of Object.entries(s.tasks)) {
    const fileS = fileStatus.get(id);
    if (fileS && fileS !== rec.status && fileS !== "done") {
      lines.push(`- ${id}: ${rec.status}${rec.pr ? ` (${rec.pr})` : ""} — the backlog file still says ${fileS}; this runtime status is authoritative`);
    }
  }
  for (const f of s.pendingFlips ?? []) lines.push(`- ${f.taskId}: flip to ${f.status} pending (driver will commit it)`);
  return lines.length ? lines.join("\n") : null;
};

// Post-triage the files are authoritative — triage saw the overlay in its own
// prompt, so any runtime memory it chose not to carry into the files is stale
// by construction. Entries the files disagree with are dropped; keeping them
// made dev sessions skip work triage had just re-opened (fleet tasks T-043/T-047).
// Only statuses the driver writes to files can disagree with them — runtime-
// only statuses (in-progress, review: the open PR is their durable record)
// have no file representation, so a file can never "agree" with one and they
// must survive. Callers guard on a SUCCESSFUL triage: a crashed session's
// files are not triage's decision.
const FILE_STATUSES = new Set(["todo", "blocked", "needs-human", "done"]);
const reconcileOverlayToFiles = () => {
  const s = readState();
  const fileStatus = new Map(parseBacklogTasks(runtimeFactoryDir()).map((t) => [t.id, t.status]));
  const dropped = [];
  for (const [id, rec] of Object.entries(s.tasks)) {
    const fileS = fileStatus.get(id);
    if (fileS && FILE_STATUSES.has(rec.status) && fileS !== rec.status) {
      delete s.tasks[id];
      dropped.push(`${id} (${rec.status} → ${fileS})`);
    }
  }
  if (dropped.length) writeState(s);
  return dropped;
};

// Same premise for the flip queue: a pending flip predates triage (the
// overlay note showed it), so one that contradicts triage's fresh files is
// older judgment and must not clobber a task triage just re-opened. Flips
// the files agree with (or whose task the files don't carry yet) stay for
// applyFlips as usual.
const dropContradictedFlips = () => {
  const s = readState();
  const fileStatus = new Map(parseBacklogTasks(runtimeFactoryDir()).map((t) => [t.id, t.status]));
  const dropped = [];
  s.pendingFlips = (s.pendingFlips ?? []).filter((f) => {
    const fileS = fileStatus.get(f.taskId);
    if (fileS && fileS !== f.status) {
      dropped.push(`${f.taskId} → ${f.status} (files say ${fileS})`);
      return false;
    }
    return true;
  });
  if (dropped.length) writeState(s);
  return dropped;
};

// ---------- preflight ----------
// Fail loudly BEFORE spawning sessions, with the exact fix, instead of
// burning paid sessions into the silent-death breaker (NOTES items 10, 11).

const resolveCmd = (cmd, pathStr = process.env.PATH) => {
  if (/[\\/]/.test(cmd)) {
    try { fs.accessSync(cmd, fs.constants.X_OK); return cmd; } catch { return null; }
  }
  const exts = process.platform === "win32" ? [".cmd", ".exe", ".bat"] : [""];
  for (const dir of (pathStr ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* keep looking */ }
    }
  }
  return null;
};

const projectTrusted = (project) => {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8"));
    const keys = [project];
    try { keys.push(fs.realpathSync(project)); } catch { /* gone paths checked as-is */ }
    return keys.some((k) => j.projects?.[k]?.hasTrustDialogAccepted === true);
  } catch {
    return false; // no ~/.claude.json = claude never ran for this user
  }
};

const preflight = ({ project, cfg, log }) => {
  const problems = [];
  const claudeBin = resolveCmd(cfg.claudeCmd);
  if (!claudeBin) {
    problems.push(
      `'${cfg.claudeCmd}' not found on PATH. Schedulers get a minimal PATH (no .bashrc) — ` +
        `add ~/.local/bin (and node's bin) via Environment=PATH= in the systemd unit, ` +
        `EnvironmentVariables in the plist, or a PATH= line in the crontab.`
    );
  }
  if (!projectTrusted(project)) {
    problems.push(
      `${project} is not trusted in ~/.claude.json, so sessions ignore their injected allowlist ` +
        `and deny every mutating tool. Fix: node ~/.factory/runtime/factory/driver/init.mjs ` +
        `--project ${project}  (idempotent — or run claude interactively there once).`
    );
  }
  if (!resolveCmd(forge.bin)) log(`preflight warning: '${forge.bin}' not on PATH — PRs and issues will fail`);
  if (problems.length) {
    for (const p of problems) log(`preflight: ${p}`);
    log("preflight failed — no sessions started");
    process.exit(1);
  }
};

// Heartbeat for dashboards: exists while a driver run is active.
const lockPath = (factoryDir) => path.join(factoryDir, "log", "window.lock");
const writeLock = (factoryDir, data) =>
  fs.writeFileSync(lockPath(factoryDir), JSON.stringify({ pid: process.pid, ...data }, null, 2));
const clearLock = (factoryDir) => fs.rmSync(lockPath(factoryDir), { force: true });

// ---------- main ----------

const { mode, project, maxSessions, init, scheduled, sched: schedOpts, milestone } = parseArgs(process.argv.slice(2));
// Two roots, deliberately separate (the machine-product premise):
// dataDir  — work data in the REPO (.factory/spec|backlog|inbox), the only
//            thing the factory keeps in a project.
// stateD   — this factory's mutable state on the MACHINE (config, .env,
//            log/, plan.json, board.json, STOP, tmp/). Git never sees it,
//            clones never carry it.
const dataDir = path.join(project, ".factory");
const stateD = stateDir(project);
if (!fs.existsSync(dataDir)) fail(`${dataDir} not found`);

// ---------- migrate (machine-product refactor) ----------
// One-shot mover for factories created under the old per-project layout:
// state files leave the repo for the machine state dir, and config.json
// leaves git. Idempotent; never overwrites machine-side files that already
// exist. Runs BEFORE loadConfig on purpose — the machine config it creates
// is the thing loadConfig needs.
if (mode === "migrate") {
  // Refuse under a live window: migrate renames log/ (and the window lock
  // inside it) out from under a running driver — and a PRE-migration driver
  // holds its lock at the legacy repo-side path, so check there too.
  for (const lockFile of [path.join(dataDir, "log", "window.lock"), path.join(stateD, "log", "window.lock")]) {
    const lock = readJson(lockFile);
    if (!lock?.pid) continue;
    try { process.kill(lock.pid, 0); } catch { continue; } // stale lock from a crash
    fail(`a driver is running (pid ${lock.pid}, mode ${lock.mode ?? "?"}) — migrate after the window finishes`);
  }
  const legacyState = ["config.json", ".env", "plan.json", "board.json", "STOP", "log", "tmp"];
  const present = legacyState.filter((f) => fs.existsSync(path.join(dataDir, f)));
  const say = (m) => process.stdout.write(m + "\n");

  // Move preserving anything already machine-side: files/dirs are moved
  // entry-by-entry; an existing destination wins and the legacy copy stays
  // on disk for the owner to reconcile (never destroy a config).
  const kept = [];
  const moveEntry = (src, dest) => {
    if (fs.existsSync(dest)) {
      if (fs.statSync(src).isDirectory() && fs.statSync(dest).isDirectory()) {
        for (const e of fs.readdirSync(src)) moveEntry(path.join(src, e), path.join(dest, e));
        try { fs.rmdirSync(src); } catch { /* leftovers kept — reported below */ }
        return;
      }
      kept.push(path.relative(project, src));
      return;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      fs.renameSync(src, dest);
    } catch {
      // cross-device (state dir on another filesystem): copy, then remove
      fs.cpSync(src, dest, { recursive: true });
      fs.rmSync(src, { recursive: true, force: true });
    }
  };

  if (!present.length) {
    if (fs.existsSync(path.join(stateD, "config.json"))) {
      say(`already migrated — state lives at ${stateD}`);
    } else {
      say(`nothing to migrate in ${dataDir} and no machine config at ${stateD} — run init.mjs for a new factory`);
      process.exit(1);
    }
  } else {
    fs.mkdirSync(stateD, { recursive: true });
    for (const f of present) moveEntry(path.join(dataDir, f), path.join(stateD, f));
    say(`moved to ${stateD}: ${present.join(", ")}`);
    for (const k of kept) say(`  ! ${k} kept in place — machine-side copy already exists and wins; reconcile by hand`);
  }

  // Schema healing — migrate is the standing schema verb (init --update died
  // in P4): add missing canonical keys, keep every existing value. Runs BEFORE
  // the cleanup below on purpose: a transition-era factory.yaml is still on
  // disk here, and it is the only owner-declared source for stack and the
  // schedule times about to leave the repo.
  const missingAmbiguous = (() => {
    if (!fs.existsSync(path.join(stateD, "config.json"))) return []; // doctor flags the missing config below
    const { added, missingAmbiguous } = healConfigSchema(project);
    if (added.length) say(`config.json: added missing schema key${added.length > 1 ? "s" : ""} ${added.join(", ")} (existing values kept)`);
    return missingAmbiguous;
  })();

  // Repo cleanup — the other half of the machine-product premise: sessions
  // get tooling INJECTED from the runtime now (P2), so the committed
  // project-side scaffold (guard copy, schedulers, skills, allowlist
  // entries, answerfile) leaves git. Owner-added content stays; CLAUDE.md
  // is untouched (P4 owns docs). Runs on the already-migrated path too:
  // a P1-migrated repo still carries the scaffold.
  if (fs.existsSync(path.join(project, ".git"))) {
    const g = (args) => execFileSync("git", args, { cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    try {
      const staged = [];
      const tracked = (rel) => g(["ls-files", "--", rel]) !== "";
      // Machine state leaves git: config/.env and any runtime state a
      // missing .factory/.gitignore let in (fleet incident: log/, plan.json) —
      // their disk copies just moved machine-side, so only the deletion is
      // staged. A tracked copy STILL on disk (machine-side copy existed, so
      // the move kept it) is the owner's to reconcile: a pathspec'd commit
      // would just re-add the working-tree bytes (verified), so say it loudly
      // instead — doctor fails on it until it's gone.
      for (const rel of [".factory/config.json", ".factory/.env",
        ".factory/log", ".factory/plan.json", ".factory/board.json", ".factory/STOP", ".factory/tmp"]) {
        if (!tracked(rel)) continue;
        if (fs.existsSync(path.join(project, rel))) {
          say(`  ! ${rel} tracked but still on disk — reconcile, then untrack it yourself: git rm -r --cached ${rel}`);
        } else {
          g(["add", "-A", "--", rel]);
          staged.push(rel);
        }
      }
      // Stamp (or heal) the ignore file that keeps runtime state out for
      // good — the factory-setup omission that created the tracked-runtime-state shape.
      const addedIgnore = stampFactoryGitignore(project);
      if (addedIgnore.length) {
        g(["add", "--", ".factory/.gitignore"]);
        staged.push(".factory/.gitignore");
        say(`.factory/.gitignore: stamped ${addedIgnore.join(", ")}`);
      }
      // Stamp the teammate contract file the same way (team affordances) —
      // create-only, an owner-customized copy is never rewritten.
      if (stampFactoryReadme(project)) {
        g(["add", "--", ".factory/README.md"]);
        staged.push(".factory/README.md");
        say(".factory/README.md: stamped (the in-repo contract for teammates)");
      }
      // driver.mjs + prompts are the v3-era stamped copies (init --update
      // used to remove them; migrate owns all legacy cleanup now).
      for (const rel of [".factory/hooks", ".factory/spec-template.md", ".factory/schedulers", "factory.yaml",
        ".factory/driver.mjs", ".factory/prompts",
        ...factorySkillNames(RUNTIME_ROOT).map((n) => `.claude/skills/${n}`),
        ".claude/agents/code-reviewer.md",
        // install.sh-era per-project tooling — the plugins ship all of it
        // now (G3); the statusline deliberately stays (not plugin-provided).
        ".claude/commands/commit.md", ".claude/hooks/protected-branch-guard.mjs",
        // settings.local.json is machine-injected per spawn — tracked copies
        // are the leak hazard materialization has to skip-worktree around.
        ".claude/settings.local.json"]) {
        if (!tracked(rel)) continue;
        // No -f: git refuses when the copy has local modifications — an
        // owner's customization must be kept (loudly), never destroyed.
        try {
          g(["rm", "-r", "-q", "--", rel]);
          staged.push(rel);
        } catch {
          say(`  ! ${rel} kept — local modifications; reconcile and remove it yourself`);
        }
      }
      const settingsRel = ".claude/settings.json";
      if (tracked(settingsRel)) {
        const p = path.join(project, settingsRel);
        const before = fs.readFileSync(p, "utf8");
        let settings = null;
        try { settings = JSON.parse(before); } catch { /* unparseable = owner's problem, not ours to rewrite */ }
        if (settings) {
          const stripped = stripFactorySettings(settings);
          if (!Object.keys(stripped).length) {
            // No -f for the same keep-don't-destroy reason as the loop above.
            try {
              g(["rm", "-q", "--", settingsRel]);
              staged.push(settingsRel);
            } catch {
              say(`  ! ${settingsRel} kept — local modifications; reconcile and remove it yourself`);
            }
          } else if (JSON.stringify(stripped) !== JSON.stringify(settings)) {
            fs.writeFileSync(p, JSON.stringify(stripped, null, 2) + "\n");
            g(["add", "--", settingsRel]);
            staged.push(settingsRel);
          }
        }
      }
      // The LEAN-WORKFLOW managed block in CLAUDE.md is install.sh-era text
      // whose bare skill names went stale when skills moved into the plugins
      // (G3: they are namespaced now) — refresh it from the runtime copy.
      // The markers license exactly this: only text between them changes,
      // everything outside is the owner's. No markers → not ours to touch.
      {
        const cmRel = "CLAUDE.md";
        const blockSrc = path.join(RUNTIME_ROOT, "claude-md-block.md");
        const cmPath = path.join(project, cmRel);
        if (tracked(cmRel) && fs.existsSync(cmPath) && fs.existsSync(blockSrc)) {
          const text = fs.readFileSync(cmPath, "utf8");
          const B = "<!-- BEGIN LEAN-WORKFLOW MANAGED BLOCK";
          const E = "<!-- END LEAN-WORKFLOW MANAGED BLOCK -->";
          const b = text.indexOf(B);
          const e = text.indexOf(E);
          if (b !== -1 && e > b) {
            const block = fs.readFileSync(blockSrc, "utf8").replace(/\n+$/, "");
            const next = text.slice(0, b) + block + text.slice(e + E.length);
            if (next !== text) {
              fs.writeFileSync(cmPath, next);
              g(["add", "--", cmRel]);
              staged.push(cmRel);
              say("CLAUDE.md: managed workflow block refreshed from the runtime (namespaced skills)");
            }
          }
        }
      }
      if (staged.length) {
        // Pathspec'd commit: migrate runs in the owner's live checkout —
        // whatever THEY had staged must not ride this commit.
        g(["commit", "-m", `factory: migrate to machine-side state and tooling (repo cleanup: ${staged.join(", ")})`, "--", ...staged]);
        const branch = g(["branch", "--show-current"]) || "HEAD";
        let pushed = false;
        try { g(["remote", "get-url", "origin"]); g(["push", "origin", branch]); pushed = true; } catch { /* no origin / rejected */ }
        say(`removal committed on ${branch}${pushed ? " and pushed" : " (NOT pushed — push it yourself)"}`);
      }
    } catch (e) {
      say(`! git cleanup failed (${String(e.message ?? e).split("\n")[0]}) — remove the factory scaffold from git yourself`);
    }
  }

  // Register so the dashboard/watchdog find it (init used to do this).
  {
    const regPath = path.join(os.homedir(), ".factory", "registry.json");
    let reg = { factories: {} };
    try { reg = JSON.parse(fs.readFileSync(regPath, "utf8")); } catch { /* first factory on this machine */ }
    reg.factories ??= {};
    reg.factories[project] = { name: path.basename(project), registeredAt: reg.factories[project]?.registeredAt ?? new Date().toISOString() };
    writeJsonAtomic(regPath, reg);
  }

  // Doctor as a child (module-level cfg/env aren't loaded in this mode) —
  // advisory, like init's closing doctor: the migration itself succeeded,
  // and some checks only go green after human steps.
  try {
    execFileSync(process.execPath, [fileURLToPath(import.meta.url), "doctor", "--project", project],
      { stdio: "inherit", timeout: 180_000 });
  } catch {
    say("\n! doctor found problems (above) — fix them before the next window");
  }
  if (missingAmbiguous.length) {
    say(
      `\n⚠  config.json is MISSING owner-declared key${missingAmbiguous.length > 1 ? "s" : ""}: ${missingAmbiguous.join(", ")}\n` +
      `   These encode run-state and have no safe default — migrate will NOT guess them.\n` +
      `   Declare explicitly in ${path.join(stateD, "config.json")} (e.g. "enabled": true|false).\n` +
      `   Until then the runtime reads a missing "enabled" as true and the dashboard shows the ⚠ enabled? chip.`);
  }
  process.exit(0);
}

// The MCP server dispatches BEFORE loadConfig on purpose: sessions pass
// their throwaway worktree as --project (it is their cwd), which has no
// machine-side state of its own. The server's only real input is the
// FACTORY_MCP_EVENTS env var — it must never depend on project state.
// ---------- MCP reporting server (factory-v2 O2) ----------
// `mcp-server` mode: claude spawns one instance per session (via the
// per-session --mcp-config the driver writes) and talks newline-delimited
// JSON-RPC over stdio. Tools validate their arguments and append events to
// the session's file in the PROJECT's log dir (absolute path via env, so it
// outlives the session worktree). The driver derives the session result,
// needs-human issues, and journal facts from that file at session end —
// sessions report at the moment of truth instead of only at exit.

// "in-progress" is a breadcrumb, never a final state; everything else is a
// settled report the driver can act on (same vocabulary as last-session.json).
const REPORT_STATUSES = ["in-progress", "review", "completed", "incomplete", "blocked", "no-tasks"];
const SETTLED_STATUSES = REPORT_STATUSES.filter((s) => s !== "in-progress");

if (mode === "mcp-server") {
  const eventsPath = process.env.FACTORY_MCP_EVENTS;
  if (!eventsPath) fail("mcp-server: FACTORY_MCP_EVENTS not set — this mode is spawned by the driver's --mcp-config, not by hand");
  const record = (event, fields) => {
    fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
    fs.appendFileSync(eventsPath, JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + "\n");
  };
  const str = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  const TOOLS = {
    report_status: {
      description:
        "Report this session's status to the factory driver. Call it at task selection (in-progress), " +
        "the moment you open a PR (review, with the url), and as your final act (the settled status). " +
        "The driver acts on your LAST settled report: it watches the PR, flips the backlog, and decides the next session.",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: ["string", "null"], description: "backlog task id, e.g. T-010 (null only for no-tasks)" },
          status: { type: "string", enum: REPORT_STATUSES },
          summary: { type: "string", description: "2-3 sentences: what happened, what's next" },
          pr: { type: ["string", "null"], description: "PR url once one exists" },
        },
        required: ["status", "summary"],
      },
      call: (a) => {
        if (!REPORT_STATUSES.includes(a.status)) return { error: `status must be one of: ${REPORT_STATUSES.join(", ")}` };
        const summary = str(a.summary, 2000);
        if (!summary) return { error: "summary (non-empty string) is required" };
        const row = { taskId: str(a.taskId, 80), status: a.status, summary, pr: str(a.pr, 300) };
        record("report_status", row);
        return { text: `recorded: ${row.taskId ?? "(no task)"} → ${row.status}` };
      },
    },
    open_question: {
      description:
        "Ask the human owner a question that blocks or shapes work (needs-human). The DRIVER dedupes it " +
        "against open questions and files/updates the GitHub issue itself at session end — never file " +
        "needs-human issues with gh yourself.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "one-line question (issue title)" },
          body: { type: "string", description: "context: what you found, what you tried, why it needs a human" },
          taskId: { type: ["string", "null"], description: "backlog task this blocks, if any" },
        },
        required: ["title"],
      },
      call: (a) => {
        const title = str(a.title, 200);
        if (!title) return { error: "title (non-empty string) is required" };
        record("open_question", { title, body: str(a.body, 5000) ?? "", taskId: str(a.taskId, 80) });
        return { text: "question recorded — the driver will file or update the GitHub issue at session end" };
      },
    },
    log_progress: {
      description: "Leave a one-line breadcrumb in the factory journal (visible on the dashboard). Cheap — use at each milestone.",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
      call: (a) => {
        const message = str(a.message, 500);
        if (!message) return { error: "message (non-empty string) is required" };
        record("log_progress", { message });
        return { text: "logged" };
      },
    },
  };
  const respond = (id, body, isErr = false) =>
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...(isErr ? { error: body } : { result: body }) }) + "\n");
  let buf = "";
  // Decode at the stream layer: a chunk boundary inside a multi-byte UTF-8
  // character must not corrupt the line (per-chunk toString would).
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; } // not ours to fix — skip the line
      const { id, method, params } = msg;
      if (method === "initialize") {
        respond(id, {
          protocolVersion: params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "factory", version: "1.0.0" },
        });
      } else if (method === "tools/list") {
        respond(id, { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) });
      } else if (method === "tools/call") {
        const tool = TOOLS[params?.name];
        if (!tool) { respond(id, { code: -32602, message: `unknown tool: ${params?.name}` }, true); continue; }
        let r;
        try { r = tool.call(params?.arguments ?? {}); } catch (e) { r = { error: firstLine(e) }; }
        respond(id, r.error
          ? { content: [{ type: "text", text: `invalid arguments: ${r.error}` }], isError: true }
          : { content: [{ type: "text", text: r.text }] });
      } else if (method === "ping") {
        respond(id, {});
      } else if (id !== undefined) {
        respond(id, { code: -32601, message: `method not supported: ${method}` }, true);
      } // notifications (no id): nothing to do
    }
  });
  process.stdin.on("end", () => process.exit(0));
  await new Promise(() => {}); // serve until claude closes stdin
}


const cfg = loadConfig(stateD);
// --max-sessions 1 = "run just the next task": the dev loop already ends at
// the session cap, so overriding it is the whole feature (NOTES item 19).
if (maxSessions) cfg.maxSessionsPerWindow = maxSessions;
const env = readEnvFile(stateD);

// One forge instance per cwd the driver talks from (owner checkout vs meta
// worktree — same origin, so the same repo either way). `cfg.forge` is an
// internal key, documented the day a second forge ships.
const makeForge = (cwd = project) => createForge({ kind: cfg.forge ?? "github", project: cwd, env });
const forge = makeForge();
// Where needs-human questions and the daily log live: the forge's native
// tracker by default, a Jira project when cfg.tracker is "jira" (repos
// whose own tracker is off — the Bitbucket-plus-Jira shape).
const tracker = createTracker({ cfg, forge, env });

// Every scheduler artifact on this machine that references this project,
// by kind — shared by doctor (presence/drift checks) and the schedule mode
// (status/adopt/uninstall). Gated on what EXISTS (unit dir, LaunchAgents,
// a crontab binary), not on process.platform: the fake-$HOME test harness
// exercises every kind on any OS, and a real machine simply has one.
const collectSchedulers = () => {
  const found = { systemd: [], launchd: [], cron: [] };
  // Path-boundary match everywhere, same rule as the cron matcher below:
  // /a/app must never claim /a/app2's artifacts — a substring match would
  // let --uninstall delete a sibling factory's units (the sibling-factories
  // class). Every artifact carries the path followed by whitespace, a
  // quote, an XML tag, or end-of-line — never another path character.
  const projectRef = new RegExp(`${project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[\\s"'<]|$)`, "m");
  const refsProject = (text) => projectRef.test(text);
  const unitDir = path.join(os.homedir(), ".config", "systemd", "user");
  if (fs.existsSync(unitDir)) {
    // Services reference the project by path. Timers reference it only via
    // Unit=<name>-factory@<mode>.service — resolve that back to the template
    // service file (…@dev.service -> …@.service) and keep timers whose
    // service is one of ours.
    const files = new Map();
    for (const f of fs.readdirSync(unitDir)) {
      if (!f.endsWith(".service") && !f.endsWith(".timer")) continue;
      try { files.set(f, fs.readFileSync(path.join(unitDir, f), "utf8")); } catch { /* unreadable — not ours to judge */ }
    }
    const serviceNames = new Set();
    for (const [f, text] of files) {
      if (f.endsWith(".service") && refsProject(text)) {
        found.systemd.push({ name: f, text });
        serviceNames.add(f);
      }
    }
    for (const [f, text] of files) {
      if (!f.endsWith(".timer")) continue;
      const ref = text.match(/^Unit=(\S+)/m)?.[1] ?? "";
      const template = ref.replace(/@[^.]+\.service$/, "@.service");
      if (serviceNames.has(ref) || serviceNames.has(template) || refsProject(text)) found.systemd.push({ name: f, text });
    }
  }
  const la = path.join(os.homedir(), "Library", "LaunchAgents");
  if (fs.existsSync(la)) {
    for (const f of fs.readdirSync(la)) {
      if (!f.endsWith(".plist")) continue;
      try {
        const text = fs.readFileSync(path.join(la, f), "utf8");
        if (refsProject(text)) found.launchd.push({ name: f, text });
      } catch { /* unreadable */ }
    }
  }
  if (resolveCmd("crontab")) {
    let out = "";
    try { out = execFileSync("crontab", ["-l"], { timeout: 15_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
    catch { /* no crontab for this user */ }
    // boundary after the path: `--project /a/app` must not match /a/app2
    const ours = out.split("\n").some((l) => !l.trim().startsWith("#") &&
      (l.includes(`--project ${project} `) || l.trimEnd().endsWith(`--project ${project}`)));
    if (ours) found.cron.push({ name: "crontab", text: out });
  }
  return found;
};

// ---------- doctor (NOTES items 21, 25) ----------
// Read-only preflight checklist. Every check below burned a real night or
// window once (scheduler PATH, trust flag, token scopes, config loss, …).
// `doctor` mode prints ✓/!/✗ per check and exits 1 if anything is ✗;
// `--scheduled` runs use the same checks as a silent preflight. Never
// writes the repo, never takes the lock — safe while a window is open.
const runDoctor = () => {
  const results = [];
  const check = (level, name, detail = "") => results.push({ level, name, detail });
  const sh = (cmd, args) => {
    try { return { out: execFileSync(cmd, args, { timeout: 15_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
    catch (e) { return { out: null, err: (String(e.stderr ?? "").trim() || e.message).split("\n")[0].slice(0, 160) }; }
  };

  // 0. host platform — Windows was dropped as a factory host (2026-07-18):
  //    speccing and live piloting stay supported there, the machine-resident
  //    factory (schedulers, supervisor, worktree sessions) does not.
  if (process.platform === "win32") {
    check("fail", "host platform", "Windows is not a supported factory host — run the factory on macOS/Linux (spec + pilot on Windows stay supported)");
  }

  // 1. binaries on the CURRENT path (what a manual run sees)
  const claudeBin = resolveCmd(cfg.claudeCmd);
  check(claudeBin ? "ok" : "fail", `claude on PATH`, claudeBin ?? `'${cfg.claudeCmd}' not found`);
  const forgeBin = resolveCmd(forge.bin);
  check(forgeBin ? "ok" : "fail", `${forge.bin} on PATH`, forgeBin ?? "not found — PRs and issues will fail");

  // 2. binaries under the SCHEDULER's PATH (what a timer-fired run sees —
  //    the 2026-07-04 lost-night trap: .bashrc PATH is invisible to systemd)
  const installedSched = collectSchedulers();
  const units = installedSched.systemd.map(({ name, text }) => ({ f: name, text }));
  {
    const services = units.filter((u) => u.f.endsWith(".service"));
    if (!services.length) check("skip", "systemd service PATH", "no unit in ~/.config/systemd/user references this project");
    for (const u of services) {
      const m = u.text.match(/^Environment=PATH=(.+)$/m);
      if (!m) { check("warn", `systemd service PATH (${u.f})`, "no Environment=PATH= line — timer runs get the minimal systemd PATH"); continue; }
      const missing = [cfg.claudeCmd, forge.bin].filter((c) => !resolveCmd(c, m[1]));
      check(missing.length ? "fail" : "ok", `systemd service PATH (${u.f})`,
        missing.length ? `${missing.join(", ")} not resolvable under the unit's PATH` : "claude and gh resolve");
    }
  }

  // 3. workspace trust — untrusted projects deny every mutating tool
  check(projectTrusted(project) ? "ok" : "fail", "workspace trust (~/.claude.json)",
    projectTrusted(project) ? "" : `re-run init.mjs --project ${project}, or claude interactively once`);

  // 4. scaffold (prompts are NOT project scaffold anymore — they ship with
  //    the runtime, next to this driver)
  const wanted = ["backlog/index.md", "spec"];
  const absent = wanted.filter((w) => !fs.existsSync(path.join(dataDir, w)));
  check(absent.length ? "fail" : "ok", ".factory scaffold", absent.length ? `missing: ${absent.join(", ")}` : "complete");
  if (cfg.permissionMode === "dontAsk") {
    if (isGitRepo()) {
      // Sessions run in worktrees whose allowlist is INJECTED at spawn (P2)
      // — report what they will get, computed from machine config; a repo
      // settings.json is the owner's business, not a session requirement.
      const stack = cfg.stack ?? detectStack(project) ?? "other";
      const n = buildSessionSettings({ stack, engines: detectEngines(project), extraAllow: cfg.allow ?? [], runtimeRoot: RUNTIME_ROOT }).permissions.allow.length;
      check("ok", "allowlist", `injected into session worktrees at spawn (${stack} preset, ${n} rules)`);
    } else {
      // Non-git projects run sessions in place with no injection — the
      // init-written settings.json is still the only allowlist they have.
      const allow = readJson(path.join(project, ".claude", "settings.json"))?.permissions?.allow;
      check(Array.isArray(allow) && allow.length ? "ok" : "fail", "allowlist (.claude/settings.json)",
        Array.isArray(allow) && allow.length ? `${allow.length} rules` : "dontAsk with no allowlist denies every tool");
    }
  } else check("skip", "allowlist", `permissionMode ${cfg.permissionMode}`);

  // 5. machine runtime (O6, NOTES item 46) — schedulers, watchdog, and
  //    dashboard all run ~/.factory/runtime, advanced only through
  //    deploy-runtime's gates. The per-project driver copies and their
  //    sha256 drift stamps (item 22) died with the migration.
  {
    const RUNTIME = path.join(os.homedir(), ".factory", "runtime");
    if (!fs.existsSync(path.join(RUNTIME, ".git"))) {
      check("skip", "machine runtime", `none at ${RUNTIME} (dev-checkout run) — bootstrap: git clone <repo-url> ${RUNTIME}`);
    } else {
      const dirty = (sh("git", ["-C", RUNTIME, "status", "--porcelain"]).out ?? "").trim();
      const sha = (sh("git", ["-C", RUNTIME, "rev-parse", "--short", "HEAD"]).out ?? "?").trim();
      check(dirty ? "fail" : "ok", "machine runtime",
        dirty ? `${RUNTIME} tree is dirty — the runtime only ever advances via deploy-runtime.mjs; restore it (git -C ${RUNTIME} status)` : `clean at ${sha}`);
      // 5a. runtime origin (migration runbook Phase 0) — a wrong or retired
      //     remote fetches fine and deploys report "up to date" forever: a
      //     silently frozen machine. URL comparison only, no network —
      //     liveness is deploy-runtime's fetch refusal.
      const origin = (sh("git", ["-C", RUNTIME, "remote", "get-url", "origin"]).out ?? "").trim();
      if (!origin) {
        check("fail", "runtime origin", `no origin remote — the runtime can never advance; git -C ${RUNTIME} remote set-url origin ${expectedOrigin()} (adding it if missing)`);
      } else if (!sameOrigin(origin, expectedOrigin())) {
        check("fail", "runtime origin", `${origin} is not the distribution repo — deploys report "up to date" forever while the fleet advances; fix: git -C ${RUNTIME} remote set-url origin ${expectedOrigin()}`);
      } else {
        check("ok", "runtime origin", origin);
      }
    }
    if (fs.existsSync(path.join(dataDir, "driver.mjs"))) {
      check("warn", "legacy driver copy", ".factory/driver.mjs is the retired v3 per-project copy — nothing should run it; git rm it");
    }
  }

  // 5b. code4food plugins (G3) — sessions load their skills from the
  //     machine-installed plugins, provisioned from the runtime clone by
  //     deploy-runtime. Missing or version-drifted plugins mean sessions run
  //     with no (or stale) skills, so this fails with the fix spelled out.
  {
    const RUNTIME = path.join(os.homedir(), ".factory", "runtime");
    if (!fs.existsSync(path.join(RUNTIME, ".git"))) {
      check("skip", "code4food plugins", "no machine runtime (dev-checkout run)");
    } else if (!fs.existsSync(path.join(RUNTIME, ".claude-plugin", "marketplace.json"))) {
      check("skip", "code4food plugins", "runtime ships no plugin marketplace (pre-G3)");
    } else if (process.env.FACTORY_DEPLOY_GATE) {
      check("skip", "code4food plugins", "provisioned by the running deploy after the gate");
    } else {
      const provisionHint = `claude plugin marketplace add ${RUNTIME} && claude plugin install code4food-skillset@code4food code4food-factory@code4food`;
      const mkt = readJson(path.join(os.homedir(), ".claude", "plugins", "known_marketplaces.json"))?.code4food;
      const installed = readJson(path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json"))?.plugins;
      const mktPath = mkt?.source?.path ?? mkt?.installLocation;
      if (!mkt) {
        check("fail", "code4food plugins", `marketplace not registered — provision: ${provisionHint}`);
      } else if (path.resolve(String(mktPath ?? "")) !== path.resolve(RUNTIME)) {
        check("fail", "code4food plugins", `marketplace points at ${mktPath ?? "?"}, not the runtime — remove it, then provision: ${provisionHint}`);
      } else {
        for (const [name, rel] of [
          ["code4food-skillset", path.join(".claude-plugin", "plugin.json")],
          ["code4food-factory", path.join("factory", ".claude-plugin", "plugin.json")],
        ]) {
          const want = readJson(path.join(RUNTIME, rel))?.version;
          const rec = installed?.[`${name}@code4food`]?.[0];
          if (!rec) check("fail", `plugin ${name}`, `not installed — run deploy-runtime.mjs (or: ${provisionHint})`);
          else if (want && rec.version !== want) check("fail", `plugin ${name}`, `installed ${rec.version}, runtime ships ${want} — run deploy-runtime.mjs`);
          else check("ok", `plugin ${name}`, String(rec.version ?? ""));
        }
      }
    }
  }

  // 6. .env keys required by enabled features
  const needed = [];
  if (cfg.notify?.telegram) needed.push("TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID");
  if ((cfg.mirrors ?? []).includes("notion")) needed.push("NOTION_TOKEN");
  if ((cfg.mirrors ?? []).includes("jira") || cfg.tracker === "jira" || cfg.board?.jira) needed.push("JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN");
  if (needed.length) {
    const unset = needed.filter((k) => !env[k]);
    check(unset.length ? "fail" : "ok", ".factory/.env keys", unset.length ? `enabled features need: ${unset.join(", ")}` : `${needed.join(", ")} set`);
  } else check("skip", ".factory/.env keys", "no feature needs one");

  // 7. forge auth (+ scopes when the token lists them)
  if (forgeBin) for (const r of forge.authCheck({ wantBoard: !!cfg.board?.github })) check(r.level, r.name, r.detail);
  else check("skip", `${forge.bin} auth`, `${forge.bin} not installed`);
  // A non-native tracker has its own auth surface (jira: env keys, project
  // key, live probe) — the forge rows above don't cover it. A Jira BOARD
  // needs the same surface even when the tracker is native, but never
  // duplicate the rows when both point at Jira.
  if (tracker !== forge) for (const r of tracker.authCheck()) check(r.level, r.name, r.detail);
  else if (cfg.board?.jira) for (const r of jiraTracker({ cfg, env }).authCheck()) check(r.level, r.name, r.detail);
  // The NATIVE tracker's own auth row above says nothing about whether the
  // repo's issue tracker is even turned on — probe it (forge.mjs).
  if (tracker === forge && forgeBin) {
    const r = nativeTrackerCheck(forge);
    check(r.level, r.name, r.detail);
  }

  // 8. timers active + linger (Linux)
  if (process.platform === "linux" && resolveCmd("systemctl")) {
    const timers = units.filter((u) => u.f.endsWith(".timer")).map((u) => u.f);
    if (!timers.length) check("skip", "systemd timers", "no timer file references this project");
    else if (cfg.enabled === false) {
      check("skip", "systemd timers", `factory disabled — ${timers.length} timer(s) may be active or not; fires exit silently`);
    } else {
      const listed = sh("systemctl", ["--user", "list-timers", "--all", "--no-pager", "--no-legend"]).out ?? "";
      const dead = timers.filter((t) => !listed.includes(t));
      check(dead.length ? "fail" : "ok", "systemd timers", dead.length ? `${dead.join(", ")} not scheduled — systemctl --user enable --now <timer>` : timers.join(", "));
    }
    const linger = sh("loginctl", ["show-user", os.userInfo().username, "--property=Linger"]).out ?? "";
    check(linger.includes("Linger=yes") ? "ok" : "warn", "linger",
      linger.includes("Linger=yes") ? "enabled" : "user units stop at logout — loginctl enable-linger");
  } else check("skip", "systemd timers", "not Linux/systemd");

  // 9. docker when the project uses compose
  const compose = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"].find((f) => fs.existsSync(path.join(project, f)));
  if (compose) {
    const d = sh("docker", ["info"]);
    check(d.out !== null ? "ok" : "fail", `docker (${compose} present)`, d.out !== null ? "daemon reachable" : d.err);
  } else check("skip", "docker", "no compose file");

  // 10. plan freshness (missing is fine — the next dev window re-triages first)
  const planD = readJson(path.join(stateD, "plan.json"));
  if (!planD) check("skip", "plan.json", "none — next dev window triages first");
  else {
    const fresh = planD.generatedAt && Date.now() - Date.parse(planD.generatedAt) < 24 * 3600 * 1000;
    check(fresh ? "ok" : "warn", "plan.json", fresh ? `${planD.queue?.length ?? 0} task(s) queued` : "stale (>24h) — next dev window re-triages first");
  }

  // 11. dashboard registry
  const reg = readJson(path.join(os.homedir(), ".factory", "registry.json"));
  check(reg?.factories?.[project] ? "ok" : "warn", "dashboard registry", reg?.factories?.[project] ? "registered" : "not in ~/.factory/registry.json — re-run init.mjs (or factory.mjs migrate) to register it");

  // 11b. enabled — the declared OFF switch (NOTES item 47). All three
  //      operational states (scheduled, manual-only, disabled) are
  //      legitimate and doctor-green; a missing or malformed value fails.
  //      Read the RAW file: cfg merges CONFIG_DEFAULTS, which would mask a
  //      missing key as `true` — the one declared-state drift this check
  //      exists to catch.
  const rawEnabled = readJson(path.join(stateD, "config.json"))?.enabled;
  if (typeof rawEnabled !== "boolean") {
    check("fail", "enabled", `config.json must declare "enabled": true|false (got ${JSON.stringify(rawEnabled)})`);
  } else {
    check("ok", "enabled", rawEnabled ? "active" : "DISABLED — dev/triage/report refuse; scheduled fires exit silently");
  }

  // 12. schedule contract (NOTES item 25) — "no independent runs" must be a
  //     DECLARED state (schedule: "manual"), never an accident. Drift fails
  //     in both directions: declared-but-missing and installed-but-undeclared.
  //     Since P3 the declaration can carry times/days/timezone (block form);
  //     the legacy kind-only string stays valid until the factory adopts.
  {
    const decl = normalizeSchedule(cfg.schedule);
    const installed = [];
    if (installedSched.systemd.some((a) => a.name.endsWith(".timer"))) installed.push("systemd");
    if (installedSched.cron.length) installed.push("cron");
    if (installedSched.launchd.length) installed.push("launchd");
    if (!decl) {
      check("fail", "schedule declared", `config.json has no "schedule" — declare one of ${SCHEDULE_KINDS.join("|")} (manual = no independent runs, on purpose)`);
    } else if (!SCHEDULE_KINDS.includes(decl.kind)) {
      check("fail", "schedule declared", `"${decl.kind}" is not one of ${SCHEDULE_KINDS.join("|")}`);
    } else if (decl.kind === "manual") {
      check(installed.length ? "fail" : "ok", "schedule: manual",
        installed.length ? `declared manual but ${installed.join("+")} scheduler(s) reference this project — remove them or declare the real schedule` : "no independent runs (declared)");
    } else {
      const present = installed.includes(decl.kind);
      const extras = installed.filter((k) => k !== decl.kind);
      // Declared-but-missing artifacts on a DISABLED factory are dormant
      // drift, not an active failure — the factory can't run anyway. Warn
      // so it's fixed before re-enabling instead of blocking updates now.
      check(present ? "ok" : cfg.enabled === false ? "warn" : "fail", `schedule: ${decl.kind}`,
        present ? `installed${extras.length ? ` (also found: ${extras.join("+")} — remove the extra)` : ""}`
                : `declared but nothing installed — ${cfg.enabled === false ? "dormant while disabled; fix before re-enabling" : "the factory will NEVER run on its own"}${extras.length ? ` (found ${extras.join("+")} instead)` : ""}`);
      if (present && extras.length) check("fail", "schedule drift", `${extras.join("+")} scheduler(s) also reference this project — one scheduler per factory`);
      // 12c. semantic drift (P3) — installed units must fire exactly what
      //      the declaration says: schedule (time/days/tz) and contract
      //      (machine-runtime exec, --scheduled, a PATH line). PATH content
      //      is deliberately NOT compared — hand-tuned unit PATHs are legal;
      //      check 2 already proves claude/gh resolve under them.
      if (present) {
        if (!decl.modes) {
          check("warn", "schedule matches declaration",
            "declaration is kind-only (no times) — `schedule --adopt` imports the installed units into machine config");
        } else {
          const bad = validateDeclaration(decl);
          const mismatches = bad.length ? bad : compareInstalled(decl, installedSched[decl.kind], { project, runtimeDriver: RUNTIME_DRIVER });
          check(mismatches.length ? "fail" : "ok", "schedule matches declaration",
            mismatches.length ? mismatches.slice(0, 4).join("; ") + (mismatches.length > 4 ? ` (+${mismatches.length - 4} more)` : "")
                              : "installed units fire what config.json declares");
        }
      }
    }
  }

  // 12b. schedulers must exec the machine runtime (O6) — a unit, cron line,
  //      plist, or generated file still pointing at the deleted per-project
  //      driver is a half-migrated factory whose timers will fire into
  //      nothing (or into a stale v3 copy).
  {
    const legacyDriver = path.join(project, ".factory", "driver.mjs");
    const texts = [];
    const sdir = path.join(dataDir, "schedulers");
    if (fs.existsSync(sdir)) {
      for (const f of fs.readdirSync(sdir)) {
        try { texts.push([`.factory/schedulers/${f}`, fs.readFileSync(path.join(sdir, f), "utf8")]); } catch { /* unreadable */ }
      }
    }
    for (const u of units) texts.push([u.f, u.text]);
    for (const { text } of installedSched.cron) {
      for (const l of text.split("\n")) {
        if (!l.trim().startsWith("#") && l.includes(project)) texts.push(["crontab", l]);
      }
    }
    for (const { name, text } of installedSched.launchd) texts.push([name, text]);
    const legacy = [...new Set(texts.filter(([, t]) => t.includes(legacyDriver)).map(([n]) => n))];
    if (!texts.length) check("skip", "schedulers on runtime", "no scheduler files reference this project");
    else check(legacy.length ? "fail" : "ok", "schedulers on runtime",
      legacy.length ? `legacy per-project driver path in: ${legacy.join(", ")} — reinstall from the declaration: factory.mjs schedule --install`
                    : "all exec the machine runtime");
  }

  // 13. git contract — the repo carries WORK DATA, nothing else: sessions
  //     get allowlist/guard/skills INJECTED into their worktrees from the
  //     runtime (P2), and config and secrets are machine-side. A repo that
  //     still tracks state is un-migrated; secrets in git are always a
  //     failure.
  if (fs.existsSync(path.join(project, ".git"))) {
    const tracked = (rel) => sh("git", ["-C", project, "ls-files", "--error-unmatch", rel]).out !== null;
    const mustTrack = [".factory/backlog/index.md"];
    const untracked = mustTrack.filter((f) => fs.existsSync(path.join(project, f)) && !tracked(f));
    check(untracked.length ? "fail" : "ok", "scaffold committed",
      untracked.length ? `not in git: ${untracked.join(", ")} — work data is the collaboration surface; commit it (check the project .gitignore)` : "work data tracked");
    if (tracked(".factory/config.json")) {
      check("fail", "config in repo", "legacy repo-side config.json — config lives on the machine now; run: factory.mjs migrate --project " + project);
    } else if (fs.existsSync(path.join(dataDir, "config.json"))) {
      check("warn", "config in repo", "stray .factory/config.json on disk (the driver reads the machine copy) — remove it to avoid confusion");
    }
    if (fs.existsSync(path.join(dataDir, ".env"))) {
      check(tracked(".factory/.env") ? "fail" : "warn", ".env in repo", tracked(".factory/.env")
        ? "SECRETS ARE IN GIT — git rm --cached .factory/.env and rotate the tokens"
        : "legacy .factory/.env in the project — secrets live machine-side now; run migrate (or move it) and delete this copy");
    }
    // Runtime state must never be tracked: it is machine-only (and in the
    // meta worktree, a log SYMLINK a pushed commit would loop the fleet on).
    // The tracked-runtime-state shape (fleet, 2026-07-11) — no ignore file, log/ + plan.json
    // committed. Tracked state = fail; a merely missing/partial ignore file
    // = scaffold drift migrate stamps (warn, so a healthy-but-unstamped
    // fleet project still runs its windows).
    const trackedState = [".factory/log", ".factory/plan.json", ".factory/board.json", ".factory/STOP", ".factory/tmp"]
      .filter((rel) => tracked(rel));
    if (trackedState.length) {
      check("fail", "runtime state in git", `${trackedState.join(", ")} tracked — machine-only runtime state; run: factory.mjs migrate --project ${project}`);
    }
    {
      const fgi = path.join(dataDir, ".gitignore");
      const missing = missingGitignoreEntries(fs.existsSync(fgi) ? fs.readFileSync(fgi, "utf8") : "");
      // Legacy transition: state still on disk repo-side with nothing keeping
      // it out of `git add -A` is one command from a leak — that stays a fail.
      const exposed = [".env", "log"].filter((e) => fs.existsSync(path.join(dataDir, e)) && missing.includes(e === "log" ? "log" : ".env"));
      check(exposed.length ? "fail" : missing.length ? "warn" : "ok", ".factory/.gitignore",
        exposed.length ? `repo-side ${exposed.join(", ")} not ignored — one \`git add -A\` from a leak; run migrate`
          : missing.length ? `scaffold drift — missing ${missing.join(", ")}; run factory.mjs migrate to stamp it`
            : "covers the runtime state");
    }
    // The teammate contract file (team affordances): its absence only costs
    // discoverability, never a window — drift migrate stamps.
    check(fs.existsSync(path.join(dataDir, "README.md")) ? "ok" : "warn", ".factory/README.md",
      fs.existsSync(path.join(dataDir, "README.md"))
        ? "in-repo teammate contract present"
        : "scaffold drift — teammates have no in-repo contract; run factory.mjs migrate to stamp it");
  } else check("skip", "git contract", "not a git repo");

  // 14. backlog format — the status ledger edits Status: lines mechanically,
  //     so the format has to parse (NOTES item 24).
  {
    const tasks = parseBacklogTasks();
    if (!tasks.length) check("warn", "backlog format", "no tasks parsed from .factory/backlog/*.md");
    else {
      const bad = tasks.filter((t) => !BOARD_STATUSES.includes(t.status));
      check(bad.length ? "warn" : "ok", "backlog format",
        bad.length ? `${tasks.length} task(s); off-vocabulary status: ${bad.map((t) => `${t.id}=${t.status}`).join(", ")}` : `${tasks.length} task(s) parse clean`);
    }
  }

  // 14b. milestone headings in backlog/index.md — `promote` flips them and
  //      the dashboard shows the active one, so a heading dialect neither
  //      can read costs both silently. That is exactly what happened: the
  //      index format was never specified, three dialects grew, and 4 of 6
  //      factories read as having no milestones at all (2026-07-19). The
  //      parser tolerates the known dialects; this row catches the NEXT one.
  //      Warn, not fail — a backlog with no milestones is legal.
  {
    const indexPath = path.join(dataDir, "backlog", "index.md");
    const text = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf8") : "";
    const drift = unparsedMilestoneHeadings(text);
    const parsed = parseMilestones(text);
    if (drift.length) {
      check("warn", "milestone headings",
        `${drift.length} heading(s) in backlog/index.md do not parse, so promote and the dashboard cannot see them — use \`## M<n>: <title> — <status>\`: ${drift.map((d) => d.trim()).join(" | ").slice(0, 120)}`);
    } else if (parsed.length) {
      const active = parsed.filter((m) => m.status === "active").map((m) => m.id);
      check("ok", "milestone headings", `${parsed.length} parse clean${active.length ? ` (active: ${active.join(", ")})` : " (none active)"}`);
    } else check("skip", "milestone headings", "backlog/index.md declares no milestones");
  }

  // 15. auto-merge needs CI — with no checks, the gate merges on nothing
  //     (fleet incident 2026-07-07: 12 sessions merged into dev totally ungated).
  if ((cfg.autonomy ?? "").startsWith("auto-merge") || cfg.autonomy === "milestone-gates") {
    const wf = path.join(project, ".github", "workflows");
    const has = fs.existsSync(wf) && fs.readdirSync(wf).some((f) => /\.ya?ml$/.test(f));
    check(has ? "ok" : "warn", "CI under auto-merge", has ? "workflows present" : "no .github/workflows — the merge gate has nothing to check");
  }

  return results;
};

if (mode === "doctor") {
  const results = runDoctor();
  const icon = { ok: "✓", warn: "!", fail: "✗", skip: "–" };
  console.log(`factory doctor — ${project}\n`);
  for (const r of results) console.log(` ${icon[r.level]} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  const fails = results.filter((r) => r.level === "fail").length;
  const warns = results.filter((r) => r.level === "warn").length;
  console.log(`\n${fails ? `${fails} problem(s)` : "no problems"}${warns ? `, ${warns} warning(s)` : ""}`);
  process.exit(fails ? 1 : 0);
}

// Driver-side read of a session's MCP events. `report` is the LAST settled
// report_status — it stands in for last-session.json (a session killed at
// minute 40 already reported everything up to minute 40). `inProgress` is
// the last breadcrumb report: never a result, but it turns a silent death
// into a handoff with facts. Questions are filed by the driver at session
// end (Decision 1); progress lines are already in the file for post-mortems.
const readMcpEvents = (eventsPath) => {
  const out = { report: null, inProgress: null, questions: [], progress: [] };
  if (!eventsPath) return out;
  let text;
  try { text = fs.readFileSync(eventsPath, "utf8"); } catch { return out; }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let e;
    try { e = JSON.parse(t); } catch { continue; }
    if (e.event === "report_status") {
      const rec = { taskId: e.taskId ?? null, status: e.status, summary: e.summary ?? "", pr: e.pr ?? null };
      if (SETTLED_STATUSES.includes(e.status)) out.report = rec;
      else out.inProgress = rec;
    } else if (e.event === "open_question") {
      out.questions.push({ title: e.title, body: e.body ?? "", taskId: e.taskId ?? null });
    } else if (e.event === "log_progress") {
      out.progress.push(e.message);
    }
  }
  return out;
};

// The window journal's write primitive (O4) — defined before every mode
// dispatch because triage/report question filing journals mid-module-eval;
// no-op until the dev loop opens a window's journal file.
let journalFile = null;
const journal = (step, status = "done", detail = null) => {
  if (!journalFile) return;
  try {
    fs.appendFileSync(journalFile, JSON.stringify({ ts: new Date().toISOString(), step, status, ...(detail != null ? { detail } : {}) }) + "\n");
  } catch { /* journaling must never kill the run */ }
};

const logDir = path.join(stateD, "log");
const log = makeLogger(logDir);
const stopFile = path.join(stateD, "STOP");

// ---------- enabled gate (NOTES item 47) ----------
// `"enabled": false` in config.json is the declared OFF switch. A factory is
// in one of three legitimate states — scheduled, manual-only, or disabled —
// and all three doctor green and take runtime updates. Disabled refuses only
// the session-running modes: doctor/prep/sync-board/mcp-server keep working
// so health checks and deploys never depend on operational state.
if (cfg.enabled === false && ["dev", "triage", "report"].includes(mode)) {
  if (scheduled) {
    // A timer firing into a disabled factory is expected during a pause —
    // one log line, exit 0, no telegram (daily nagging would defeat the
    // pause); the watchdog log and dashboard badge keep it visible.
    log(`${mode} run skipped — factory disabled (config.json "enabled": false)`);
    process.exit(0);
  }
  fail(`factory is disabled (config.json "enabled": false) — set it true to run ${mode}`);
}

// One driver per project: refuse to start if another run's lock is alive
// (e.g. a manual babysit run overlapping the scheduled window).
{
  const existing = (() => {
    try { return JSON.parse(fs.readFileSync(lockPath(stateD), "utf8")); } catch { return null; }
  })();
  if (existing?.pid) {
    let alive = false;
    try { process.kill(existing.pid, 0); alive = true; } catch { /* stale */ }
    if (alive) fail(`another driver (pid ${existing.pid}, mode ${existing.mode}) is already running for this project`);
  }
}

// ---------- schedule (P3, machine-product refactor) ----------
// The schedule lives in machine config; installed units are a projection of
// it. --declare/--adopt write the declaration, --install/--uninstall project
// it onto this machine's scheduler, --status shows both sides. Works while
// the factory is disabled (that is exactly when fleets get migrated).
if (mode === "schedule") {
  const say = (m) => process.stdout.write(m + "\n");
  const cfgPath = path.join(stateD, "config.json");
  const ctxS = {
    project,
    projectName: path.basename(project),
    stateDir: stateD,
    runtimeDriver: RUNTIME_DRIVER,
    nodeBin: process.execPath,
    windowHours: cfg.windowHours,
    pathLine: defaultPathLine(process.execPath, os.homedir()),
  };
  const compareCtx = { project, runtimeDriver: RUNTIME_DRIVER };
  const run = (cmd, args, opts = {}) =>
    execFileSync(cmd, args, { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"], ...opts });

  // Piped stdin (tests, scripting) is consumed as an answer queue, same as
  // init.mjs — readline races pre-buffered lines. Empty stdin answers "".
  let pipedAnswers = null;
  const askLine = async (q, def = "") => {
    let a;
    if (!process.stdin.isTTY) {
      if (pipedAnswers === null) {
        try { pipedAnswers = fs.readFileSync(0, "utf8").split("\n").map((s) => s.trim()); } catch { pipedAnswers = []; }
      }
      a = pipedAnswers.shift() ?? "";
      process.stdout.write(`${q}${def ? ` [${def}]` : ""}: ${a}\n`);
    } else {
      const readline = await import("node:readline/promises");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      a = (await rl.question(`${q}${def ? ` [${def}]` : ""}: `)).trim();
      rl.close();
    }
    return a || def;
  };
  const confirmOr = async (what) => {
    if (schedOpts.yes) return;
    const a = await askLine(`${what} [y/N]`);
    if (!/^y(es)?$/i.test(a)) fail("aborted — nothing changed (rerun with --yes to skip the confirmation)");
  };
  const writeDecl = (decl) => {
    const raw = readJson(cfgPath);
    if (!raw) fail(`cannot read ${cfgPath}`);
    writeJsonAtomic(cfgPath, { ...raw, schedule: decl });
    say(`schedule declared in ${cfgPath}`);
  };
  // Set-based line diff — unit files never repeat meaningful lines, so
  // showing removed-then-added lines is exact enough for a confirm prompt.
  const diffLines = (oldText, newText) => {
    const o = oldText.split("\n"), n = newText.split("\n");
    const oSet = new Set(o), nSet = new Set(n);
    return [...o.filter((l) => l && !nSet.has(l)).map((l) => `- ${l}`),
            ...n.filter((l) => l && !oSet.has(l)).map((l) => `+ ${l}`)];
  };
  const cronRefsProject = (l) => !l.trim().startsWith("#") &&
    (l.includes(`--project ${project} `) || l.trimEnd().endsWith(`--project ${project}`));
  const CRON_BEGIN = `# BEGIN factory ${project} `;
  const CRON_END = `# END factory ${project}`;
  const readCrontab = () => { try { return run("crontab", ["-l"]); } catch { return ""; } };
  const stripCronBlock = (text) => {
    const out = [];
    let inBlock = false;
    for (const l of text.split("\n")) {
      if (!inBlock && (l.startsWith(CRON_BEGIN) || l.trim() === CRON_BEGIN.trim())) { inBlock = true; continue; }
      if (inBlock) { if (l.trim() === CRON_END) inBlock = false; continue; }
      out.push(l);
    }
    // A hand-broken block must fail loudly — treating everything after
    // BEGIN as ours would silently eat foreign crontab lines.
    if (inBlock) fail(`crontab managed block is missing its "${CRON_END}" marker — restore it (or delete the whole block), then re-run`);
    return out.join("\n");
  };
  const writeCrontab = (text) => run("crontab", ["-"], { stdio: ["pipe", "pipe", "pipe"], input: text });

  // Shared by systemd and launchd installs: plan file writes against what is
  // already installed; "unchanged everywhere" must cost zero side effects.
  const planFiles = (dir, files) => Object.entries(files).map(([name, content]) => {
    const dest = path.join(dir, name);
    const old = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : null;
    return { name, dest, content, old, status: old === null ? "new" : old === content ? "unchanged" : "changed" };
  });
  const sayPlan = (plan, stale) => {
    for (const p of plan) {
      say(`  ${p.status === "new" ? "+" : p.status === "changed" ? "~" : "="} ${p.name} (${p.status})`);
      if (p.status === "changed") for (const l of diffLines(p.old, p.content)) say(`      ${l}`);
    }
    for (const f of stale) say(`  - ${f} (mode no longer declared — will be removed)`);
  };

  const installSystemd = async (files, decl) => {
    if (!resolveCmd("systemctl")) fail("declared systemd but systemctl is not on this machine");
    const dir = path.join(os.homedir(), ".config", "systemd", "user");
    const plan = planFiles(dir, files);
    const stale = SCHEDULE_MODES.filter((m) => !decl.modes[m])
      .map((m) => `${ctxS.projectName}-${m}.timer`).filter((f) => fs.existsSync(path.join(dir, f)));
    // The OnFailure companion is machine-level (one per machine, shared by
    // every factory) — installed when absent, never overwritten.
    const companionSrc = path.join(RUNTIME_ROOT, "factory", "schedulers", "factory-onfailure@.service");
    const companion = !fs.existsSync(path.join(dir, "factory-onfailure@.service")) && fs.existsSync(companionSrc);
    if (!plan.some((p) => p.status !== "unchanged") && !stale.length && !companion) {
      say("systemd units are up to date — nothing to do");
      return;
    }
    sayPlan(plan, stale);
    if (companion) say("  + factory-onfailure@.service (machine-level notifier companion)");
    await confirmOr("install these units and enable the timers?");
    fs.mkdirSync(dir, { recursive: true });
    for (const p of plan) if (p.status !== "unchanged") fs.writeFileSync(p.dest, p.content);
    if (companion) fs.copyFileSync(companionSrc, path.join(dir, "factory-onfailure@.service"));
    for (const f of stale) {
      try { run("systemctl", ["--user", "disable", "--now", f]); } catch { /* never enabled */ }
      fs.rmSync(path.join(dir, f), { force: true });
    }
    run("systemctl", ["--user", "daemon-reload"]);
    const timers = SCHEDULE_MODES.filter((m) => decl.modes[m]).map((m) => `${ctxS.projectName}-${m}.timer`);
    run("systemctl", ["--user", "enable", "--now", ...timers]);
    say(`installed and enabled: ${timers.join(", ")}`);
  };

  const installLaunchd = async (files, decl) => {
    if (!resolveCmd("launchctl")) fail("declared launchd but launchctl is not on this machine");
    const dir = path.join(os.homedir(), "Library", "LaunchAgents");
    const plan = planFiles(dir, files);
    const stale = SCHEDULE_MODES.filter((m) => !decl.modes[m])
      .map((m) => `com.factory.${ctxS.projectName}.${m}.plist`).filter((f) => fs.existsSync(path.join(dir, f)));
    if (!plan.some((p) => p.status !== "unchanged") && !stale.length) {
      say("launchd agents are up to date — nothing to do");
      return;
    }
    sayPlan(plan, stale);
    await confirmOr("install these launch agents?");
    fs.mkdirSync(dir, { recursive: true });
    for (const f of stale) {
      try { run("launchctl", ["unload", path.join(dir, f)]); } catch { /* was not loaded */ }
      fs.rmSync(path.join(dir, f), { force: true });
    }
    for (const p of plan) {
      if (p.status === "unchanged") continue;
      if (p.old !== null) { try { run("launchctl", ["unload", p.dest]); } catch { /* was not loaded */ } }
      fs.writeFileSync(p.dest, p.content);
      run("launchctl", ["load", p.dest]);
    }
    say(`installed: ${plan.filter((p) => p.status !== "unchanged").map((p) => p.name).join(", ") || "(no file changes)"}`);
  };

  const installCron = async (files) => {
    if (!resolveCmd("crontab")) fail("declared cron but crontab is not on this machine");
    const current = readCrontab();
    const kept = stripCronBlock(current).replace(/\n+$/, "");
    // Block goes at the END: its CRON_TZ/PATH lines apply to every entry
    // below them, so nothing foreign may follow it.
    const next = (kept ? kept + "\n\n" : "") + files["crontab-block"] + "\n";
    if (next === current) {
      say("crontab managed block is up to date — nothing to do");
      return;
    }
    say("this project's managed crontab block will become:");
    for (const l of files["crontab-block"].split("\n")) say(`  ${l}`);
    await confirmOr("replace the managed crontab block?");
    writeCrontab(next);
    say("crontab updated (managed block kept at the end of the file)");
  };

  const doStatus = () => {
    const decl = normalizeSchedule(cfg.schedule);
    if (!decl) {
      say('declared: none — config.json has no "schedule"; run schedule --declare (or --adopt from installed units)');
    } else if (!decl.modes) {
      say(`declared: ${decl.kind} (kind only — no times/days declared)`);
      if (decl.kind !== "manual") say("  schedule --adopt imports the installed units; schedule --declare writes times by hand");
    } else {
      say(`declared: ${decl.kind}${decl.timezone ? ` — timezone ${decl.timezone}` : ""}`);
      for (const m of SCHEDULE_MODES) if (decl.modes[m]) say(`  ${m.padEnd(6)} ${decl.modes[m].time}  ${decl.modes[m].days}`);
    }
    const inst = collectSchedulers();
    const kinds = Object.keys(inst).filter((k) => inst[k].length);
    if (!kinds.length) say("installed: nothing on this machine references this project");
    for (const k of kinds) say(`installed: ${k} — ${inst[k].map((a) => a.name).join(", ")}`);
    if (decl?.modes && inst[decl.kind]?.length) {
      const mm = compareInstalled(decl, inst[decl.kind], compareCtx);
      if (mm.length) { say("drift vs declaration:"); for (const m of mm) say(`  ✗ ${m}`); }
      else say("installed units match the declaration");
    }
  };

  const doDeclare = async () => {
    let decl;
    const platformKind = { darwin: "launchd", linux: "systemd" }[process.platform] ?? "manual";
    if (schedOpts.gaveFlags) {
      const kind = schedOpts.kind ?? platformKind;
      if (kind === "manual") decl = { kind: "manual" };
      else {
        const days = schedOpts.days ?? "Mon-Fri";
        const times = { triage: "08:30", dev: "09:00", report: "13:30", ...schedOpts.times };
        decl = {
          kind,
          ...(schedOpts.timezone ? { timezone: schedOpts.timezone } : {}),
          modes: Object.fromEntries(SCHEDULE_MODES.map((m) => [m, { time: times[m], days: schedOpts.modeDays[m] ?? days }])),
        };
      }
    } else {
      const kind = await askLine(`Schedule kind (${SCHEDULE_KINDS.join("/")} — manual = you start windows yourself)`, platformKind);
      if (kind === "manual") decl = { kind: "manual" };
      else {
        const timezone = await askLine("Timezone (IANA, empty = this machine's)", "");
        const days = await askLine("Work days (e.g. Mon-Fri, Mon-Sun, Mon,Wed,Fri)", "Mon-Fri");
        const modes = {};
        for (const [m, def] of [["triage", "08:30"], ["dev", "09:00"], ["report", "13:30"]]) {
          modes[m] = { time: await askLine(`${m} time (HH:MM)`, def), days };
        }
        decl = { kind, ...(timezone ? { timezone } : {}), modes };
      }
    }
    const problems = validateDeclaration(normalizeSchedule(decl));
    if (problems.length) fail(`invalid schedule declaration:\n  - ${problems.join("\n  - ")}`);
    writeDecl(decl);
    if (decl.kind !== "manual") say("next: schedule --install projects it onto this machine (shows a diff first)");
  };

  const doAdopt = async () => {
    const inst = collectSchedulers();
    const kinds = Object.keys(inst).filter((k) => inst[k].length);
    if (!kinds.length) fail("nothing to adopt — no scheduler on this machine references this project; write one with schedule --declare");
    if (kinds.length > 1) fail(`${kinds.join(" and ")} schedulers both reference this project — one scheduler per factory; remove the extra, then re-run --adopt`);
    const kind = kinds[0];
    const { decl, problems } = parseInstalled(kind, inst[kind], compareCtx);
    if (problems.length) fail(`cannot adopt the installed ${kind} schedule:\n  - ${problems.join("\n  - ")}\nadopt by hand with schedule --declare`);
    if (!Object.keys(decl.modes).length) fail(`no installed ${kind} artifact maps to a factory mode (${SCHEDULE_MODES.join("/")}) — write the declaration with schedule --declare`);
    // What parses can still be nonsense (cron "5-1" wraps into an empty day
    // set) — never write a declaration doctor would immediately reject.
    const bad = validateDeclaration(normalizeSchedule(decl));
    if (bad.length) fail(`the installed ${kind} schedule parses but is not a valid declaration:\n  - ${bad.join("\n  - ")}\nadopt by hand with schedule --declare`);
    say(`adopting the installed ${kind} schedule into machine config:`);
    if (decl.timezone) say(`  timezone ${decl.timezone}`);
    for (const m of SCHEDULE_MODES) if (decl.modes[m]) say(`  ${m.padEnd(6)} ${decl.modes[m].time}  ${decl.modes[m].days}`);
    await confirmOr("write this declaration into config.json?");
    writeDecl(decl);
  };

  const doInstall = async () => {
    const decl = normalizeSchedule(cfg.schedule);
    if (!decl) fail('no schedule declared in machine config — run schedule --declare (or --adopt from installed units)');
    if (decl.kind === "manual") { say("schedule is manual — nothing to install (windows start by hand, on purpose)"); return; }
    if (!decl.modes) fail("declaration is kind-only (no times) — run schedule --declare, or schedule --adopt to import the installed units first");
    const problems = validateDeclaration(decl);
    if (problems.length) fail(`invalid schedule declaration:\n  - ${problems.join("\n  - ")}`);
    const { files, notes } = generateUnits(decl, ctxS);
    for (const n of notes) say(`note: ${n}`);
    if (!fs.existsSync(RUNTIME_DRIVER)) {
      say(`note: no machine runtime at ${RUNTIME_DRIVER} — the units exec it; bootstrap it (git clone) before the first fire`);
    }
    if (decl.kind === "systemd") await installSystemd(files, decl);
    else if (decl.kind === "cron") await installCron(files);
    else await installLaunchd(files, decl);
  };

  const doUninstall = async () => {
    const inst = collectSchedulers();
    if (!inst.systemd.length && !inst.launchd.length && !inst.cron.length) {
      say("nothing installed on this machine references this project");
      return;
    }
    for (const k of ["systemd", "launchd"]) {
      for (const a of inst[k]) say(`  - ${a.name}`);
    }
    if (inst.cron.length) say("  - crontab: this project's managed block and entries");
    await confirmOr("remove every scheduler artifact for this project?");
    if (inst.systemd.length) {
      const dir = path.join(os.homedir(), ".config", "systemd", "user");
      for (const a of inst.systemd) {
        if (a.name.endsWith(".timer")) { try { run("systemctl", ["--user", "disable", "--now", a.name]); } catch { /* not enabled */ } }
        fs.rmSync(path.join(dir, a.name), { force: true });
      }
      try { run("systemctl", ["--user", "daemon-reload"]); } catch { /* no systemctl — files are gone, which is what counts */ }
    }
    if (inst.launchd.length) {
      const dir = path.join(os.homedir(), "Library", "LaunchAgents");
      for (const a of inst.launchd) {
        try { run("launchctl", ["unload", path.join(dir, a.name)]); } catch { /* not loaded */ }
        fs.rmSync(path.join(dir, a.name), { force: true });
      }
    }
    if (inst.cron.length) {
      const kept = stripCronBlock(readCrontab()).split("\n").filter((l) => !cronRefsProject(l));
      writeCrontab(kept.join("\n").replace(/\n+$/, "") + "\n");
    }
    say("removed — the declaration in config.json is untouched (schedule --install brings it back)");
  };

  const action = schedOpts.action ?? "status";
  if (action === "status") doStatus();
  else if (action === "declare") await doDeclare();
  else if (action === "adopt") await doAdopt();
  else if (action === "install") await doInstall();
  else await doUninstall();
  process.exit(0);
}

preflight({ project, cfg, log });

// ---------- notifications (NOTES item 18) ----------
// Telegram push for the events a human wants on their phone. Opt-in:
// `"notify": {"telegram": true}` in config.json + TELEGRAM_BOT_TOKEN /
// TELEGRAM_CHAT_ID in .factory/.env. One bot serves all factories — every
// message is prefixed with the factory name. Failures log and never
// affect the run: the factory must behave identically with this broken.
const factoryName = path.basename(project);
let notifyWarned = false;
const notify = async (text) => {
  if (!cfg.notify?.telegram) return;
  const token = env.TELEGRAM_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID ?? process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    if (!notifyWarned) log("notify: telegram enabled but TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID missing in .factory/.env — notifications off");
    notifyWarned = true;
    return;
  }
  try {
    // FACTORY_TELEGRAM_API: test double (helpers.mjs startTelegramStub).
    const res = await fetch(`${process.env.FACTORY_TELEGRAM_API ?? "https://api.telegram.org"}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: `[${factoryName}] ${text}`, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) log(`notify: telegram HTTP ${res.status} — continuing`);
  } catch (e) {
    log(`notify: telegram failed (${String(e.message).split("\n")[0]}) — continuing`);
  }
};

// ---------- --scheduled preflight (NOTES item 25) ----------
// Timer/cron-fired runs pass --scheduled: a misconfigured factory must
// refuse to run unattended and say so on the phone, not half-run. Manual
// runs skip this — a human is present to read the doctor output.
if (scheduled) {
  const results = runDoctor();
  const fails = results.filter((r) => r.level === "fail");
  fs.writeFileSync(path.join(logDir, "doctor.json"), JSON.stringify({
    ts: new Date().toISOString(), ok: !fails.length, source: "scheduled-preflight",
    fails: fails.map((r) => `${r.name}${r.detail ? ` — ${r.detail}` : ""}`),
  }, null, 2) + "\n");
  if (fails.length) {
    for (const r of fails) log(`scheduled preflight: ✗ ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    log(`scheduled ${mode} run aborted — doctor found ${fails.length} problem(s)`);
    await notify(`✗ scheduled ${mode} run ABORTED — doctor: ${fails.map((r) => r.name).join("; ")}`);
    process.exit(1);
  }
}

// ---------- board sync, outbound (NOTES item 20) ----------
// Mirrors the backlog to a GitHub Projects v2 board — deterministic driver
// code, no model tokens, backlog markdown stays the source of truth.
// Same rule as notify: sync failures log and never affect the run.
// GitHub-only by design: it rides the github forge's escape hatch, never
// the forge contract (a non-GitHub forge simply has no board).

const boardPath = path.join(stateD, "board.json");
const ghOut = (args) => forge.github.out(args);
const ghJsonOut = (args) => forge.github.jsonOut(args);

const taskBody = (t) =>
  [t.model || t.effort ? `Model: ${t.model ?? "?"} · Effort: ${t.effort ?? "?"}` : null, ...(t.links ?? [])]
    .filter(Boolean)
    .join("\n") || "(no links yet)";

// One-time --init: find-or-create the board, set the Status options to the
// backlog vocabulary, add an Epic field, cache every id in board.json.
const boardInit = () => {
  const owner = ghJsonOut(["repo", "view", "--json", "owner"]).owner.login;
  const title = cfg.board?.title ?? factoryName;
  const say = (m) => process.stdout.write(m + "\n");
  let proj = (ghJsonOut(["project", "list", "--owner", owner, "--format", "json"]).projects ?? []).find((p) => p.title === title);
  if (proj) say(`found existing project #${proj.number} "${title}"`);
  else {
    proj = ghJsonOut(["project", "create", "--owner", owner, "--title", title, "--format", "json"]);
    say(`created project #${proj.number} "${title}"`);
  }
  try { ghOut(["project", "link", String(proj.number), "--owner", owner]); } catch { /* already linked */ }

  const fields = () => ghJsonOut(["project", "field-list", String(proj.number), "--owner", owner, "--format", "json"]).fields ?? [];
  let status = fields().find((f) => f.name === "Status");
  if (!status) fail("board has no Status field — Projects v2 creates one by default; check gh version");
  if (!BOARD_STATUSES.every((s) => (status.options ?? []).some((o) => o.name === s))) {
    // Replace the default Todo/In Progress/Done with the backlog vocabulary.
    // Every BOARD_STATUSES entry needs a color here — a missing one renders
    // as `color: undefined` in the GraphQL literal and the mutation fails.
    const colors = { todo: "GRAY", "in-progress": "BLUE", review: "YELLOW", blocked: "RED", "needs-human": "PURPLE", done: "GREEN" };
    const opts = BOARD_STATUSES.map((s) => `{name: "${s}", color: ${colors[s]}, description: ""}`).join(", ");
    ghOut(["api", "graphql", "-f",
      `query=mutation { updateProjectV2Field(input: {fieldId: "${status.id}", singleSelectOptions: [${opts}]}) { projectV2Field { ... on ProjectV2SingleSelectField { id } } } }`]);
    status = fields().find((f) => f.name === "Status");
    say(`status options set: ${BOARD_STATUSES.join(", ")}`);
  }

  const epics = [...new Set(parseBacklogTasks().map((t) => t.epic))];
  let epicField = fields().find((f) => f.name === "Epic");
  if (!epicField && epics.length) {
    ghOut(["project", "field-create", String(proj.number), "--owner", owner, "--name", "Epic",
      "--data-type", "SINGLE_SELECT", "--single-select-options", epics.join(",")]);
    epicField = fields().find((f) => f.name === "Epic");
    say(`epic field created: ${epics.join(", ")}`);
  }

  // Re-init over the SAME board must keep the tracked-items map — clobbering
  // it orphans every existing card: the next sync re-creates them all as
  // duplicates and reports the originals as a bogus human board-delta
  // (one fleet board got 58 phantom cards this way, 2026-07-12). A different board
  // starts fresh: the old item ids belong to the old project.
  const prev = readJson(boardPath);
  const keepItems = prev?.projectId === proj.id;
  fs.writeFileSync(boardPath, JSON.stringify({
    owner,
    projectNumber: proj.number,
    projectId: proj.id,
    statusFieldId: status.id,
    statusOptions: Object.fromEntries((status.options ?? []).filter((o) => BOARD_STATUSES.includes(o.name)).map((o) => [o.name, o.id])),
    epicFieldId: epicField?.id ?? null,
    epicOptions: Object.fromEntries((epicField?.options ?? []).map((o) => [o.name, o.id])),
    items: keepItems ? (prev.items ?? {}) : {},
  }, null, 2) + "\n");
  say(`wrote ${boardPath}${keepItems ? ` (kept ${Object.keys(prev.items ?? {}).length} tracked item(s))` : ""}`);
};

// Draft-issue content ids (needed to edit item bodies) — one paginated
// GraphQL query, fetched lazily only when a body actually changed.
const draftIds = (board) => {
  const map = {};
  let cursor = null;
  do {
    const after = cursor ? `, after: "${cursor}"` : "";
    const q = `query { node(id: "${board.projectId}") { ... on ProjectV2 { items(first: 100${after}) { pageInfo { hasNextPage endCursor } nodes { id content { ... on DraftIssue { id } } } } } } }`;
    const r = JSON.parse(ghOut(["api", "graphql", "-f", `query=${q}`]));
    const items = r.data.node.items;
    for (const n of items.nodes ?? []) if (n.content?.id) map[n.id] = n.content.id;
    cursor = items.pageInfo.hasNextPage ? items.pageInfo.endCursor : null;
  } while (cursor);
  return map;
};

// Jira twin (jira-board.mjs): same call sites, same never-affect-the-run
// rule. The module returns the delta; the inbox write + meta commit happen
// here because they are meta-worktree machinery.
const syncJiraBoardGlue = (why) => {
  try {
    const r = syncJiraBoard({ jira: jiraTracker({ cfg, env }), stateD, tasks: effectiveTasks(), log });
    if (!r || (!r.newcomers.length && !r.humanMoves.length)) return;
    const inboxDir = path.join(runtimeFactoryDir(), "inbox");
    fs.mkdirSync(inboxDir, { recursive: true });
    const deltaPath = path.join(inboxDir, "board-delta.md");
    const lines = [];
    if (!fs.existsSync(deltaPath)) lines.push("# Board delta — human edits on the board (generated by sync-board)");
    lines.push(`\n## ${new Date().toISOString()} (${why})`);
    for (const n of r.newcomers) {
      lines.push(`\n### New Jira issue: ${n.key} — ${n.summary}`);
      lines.push(`_(read its description via the Jira REST API, add it to the backlog as a task per the backlog skill — or reject with a reason in the daily log — then close ${n.key} with a comment naming the task id. The issue is labeled factory-captured and stays on the board until you do.)_`);
    }
    for (const m of r.humanMoves) {
      lines.push(`\n### Human move: ${m.taskId} dragged to \`${m.boardStatus}\` (backlog says \`${m.backlogStatus}\`)`);
      lines.push(m.restored
        ? "_(seen on two consecutive syncs, so probably real — factory status restored on the board; judge the intent: a done task dragged back usually means a re-open request → new bug task; when in doubt ask via open_question. If the owner denies moving it, treat as a board glitch and drop it.)_"
        : "_(seen on two consecutive syncs, so probably real — the factory could NOT move it back (no transition or no mapped column), so the card stays where the human put it; judge the intent AND reconcile: either the backlog status or the Jira workflow needs to change. When in doubt ask via open_question.)_");
    }
    fs.appendFileSync(deltaPath, lines.join("\n") + "\n");
    commitMetadata(`jira board delta (${why}): ${r.newcomers.length} new issue(s), ${r.humanMoves.length} human move(s)`);
    log(`jira board delta: ${r.newcomers.length} new issue(s), ${r.humanMoves.length} human move(s) → inbox/board-delta.md (committed)`);
  } catch (e) {
    log(`jira board sync failed (${String(e.message).split("\n")[0]}) — continuing`);
  }
};

const syncBoard = (why) => {
  if (cfg.board?.jira) syncJiraBoardGlue(why);
  if (!cfg.board?.github) return;
  if (!forge.github) { log(`board sync: skipped — board.github is set but the forge is ${forge.kind} (the GitHub board needs a github forge; a Jira board via "board": {"jira": true} works on any forge)`); return; }
  const board = readJson(boardPath);
  if (!board) { log("board sync: no board.json — run sync-board --init once"); return; }
  try {
    // items map: taskId -> {itemId, status} where status is what WE last
    // pushed — a board value differing from it means a human moved the card.
    // (v1 stored bare item-id strings; normalize on the fly.)
    for (const [k, v] of Object.entries(board.items)) {
      if (typeof v === "string") board.items[k] = { itemId: v, status: null };
    }
    const tasks = effectiveTasks(); // backlog files + runtime overlay (NOTES item 24)
    const num = String(board.projectNumber);
    const listed = ghJsonOut(["project", "item-list", num, "--owner", board.owner, "--limit", "500", "--format", "json"]).items ?? [];
    const byItemId = new Map(listed.map((i) => [i.id, i]));
    const trackedIds = new Set(Object.values(board.items).map((v) => v.itemId));
    const bodyEdits = [];
    const humanMoves = [];
    let created = 0, moved = 0, archived = 0;
    for (const t of tasks) {
      let rec = board.items[t.id];
      if (!rec || !byItemId.has(rec.itemId)) {
        const item = ghJsonOut(["project", "item-create", num, "--owner", board.owner,
          "--title", `${t.id} — ${t.title}`, "--body", taskBody(t), "--format", "json"]);
        rec = board.items[t.id] = { itemId: item.id, status: null };
        // status/epic start EMPTY on a new item — leave them null here so the
        // field edits below always fire for fresh cards.
        byItemId.set(item.id, { id: item.id, status: null, epic: null, content: { body: taskBody(t) } });
        trackedIds.add(item.id);
        created += 1;
      }
      const cur = byItemId.get(rec.itemId);
      // Inbound: board differs both from what we last pushed AND from the
      // backlog — MAYBE a human dragged the card. Projects reads are
      // eventually consistent (NOTES item 31: fleet task T-022 earned three
      // phantom "dragged back to todo" issues from one stale item-list),
      // so a single observation proves nothing: hold the restore, remember
      // what we saw, and only report a human move when the SAME value is
      // still there on the next sync. Stale reads heal in between; real
      // drags persist.
      board.pendingMoves ??= {};
      let holdOff = false;
      if (cur.status && rec.status && cur.status !== rec.status && cur.status !== t.status) {
        if (board.pendingMoves[t.id] === cur.status) {
          humanMoves.push({ taskId: t.id, boardStatus: cur.status, backlogStatus: t.status });
          delete board.pendingMoves[t.id];
          // fall through: the outbound write below restores factory status
        } else {
          board.pendingMoves[t.id] = cur.status;
          holdOff = true; // no edit, no rec update — re-observe next sync
        }
      } else if (board.pendingMoves[t.id]) {
        delete board.pendingMoves[t.id]; // discrepancy healed itself — stale read
      }
      if (!holdOff && board.statusOptions[t.status]) {
        if (cur.status !== t.status) {
          ghOut(["project", "item-edit", "--id", rec.itemId, "--project-id", board.projectId,
            "--field-id", board.statusFieldId, "--single-select-option-id", board.statusOptions[t.status]]);
          moved += 1;
        }
        rec.status = t.status; // board now reflects the backlog
      }
      if (board.epicFieldId && board.epicOptions[t.epic] && cur.epic !== t.epic) {
        ghOut(["project", "item-edit", "--id", rec.itemId, "--project-id", board.projectId,
          "--field-id", board.epicFieldId, "--single-select-option-id", board.epicOptions[t.epic]]);
      }
      if (cur.content?.body != null && cur.content.body !== taskBody(t)) bodyEdits.push({ itemId: rec.itemId, t });
    }
    if (bodyEdits.length) {
      const di = draftIds(board);
      for (const { itemId, t } of bodyEdits) {
        if (!di[itemId]) continue; // item is a real issue/PR, not a draft — body isn't ours
        ghOut(["project", "item-edit", "--id", di[itemId], "--title", `${t.id} — ${t.title}`, "--body", taskBody(t)]);
      }
    }
    // Inbound: cards a human added to the board (drafts or issues). Their
    // content is captured for triage BEFORE anything is archived — archiving
    // first would make a crash between the two steps destroy the human's
    // card without a trace. Once triage folds them into the backlog as real
    // tasks, the next sync creates proper cards, so the originals are
    // archived after capture to avoid duplicates.
    const newcomers = listed.filter((i) => !trackedIds.has(i.id));
    // Deltas land in the inbox — triage already processes every file there.
    // The inbox is TRACKED metadata, so it must go through the meta worktree
    // and be committed immediately: meta is reset from origin at every
    // boundary, and an uncommitted delta would be wiped (an owner-checkout
    // delta would be invisible to triage and dirty the checkout forever).
    if (newcomers.length || humanMoves.length) {
      const inboxDir = path.join(runtimeFactoryDir(), "inbox");
      fs.mkdirSync(inboxDir, { recursive: true });
      const deltaPath = path.join(inboxDir, "board-delta.md");
      const lines = [];
      if (!fs.existsSync(deltaPath)) lines.push("# Board delta — human edits on the GitHub Project board (generated by sync-board)");
      lines.push(`\n## ${new Date().toISOString()} (${why})`);
      for (const n of newcomers) {
        lines.push(`\n### New card: ${n.title}`);
        if (n.content?.body) lines.push(n.content.body);
        lines.push("_(card archived on the board — add it to the backlog as a task per the backlog skill, or reject with a reason in the daily log)_");
      }
      for (const m of humanMoves) {
        lines.push(`\n### Human move: ${m.taskId} dragged to \`${m.boardStatus}\` (backlog says \`${m.backlogStatus}\`)`);
        lines.push("_(seen on two consecutive syncs, so probably real — factory status restored on the board; judge the intent: a done task dragged back usually means a re-open request → new bug task; when in doubt file needs-human — ONE issue, after checking for an existing open question. If the owner denies moving it, treat as a board glitch and drop it.)_");
      }
      fs.appendFileSync(deltaPath, lines.join("\n") + "\n");
      commitMetadata(`board delta (${why}): ${newcomers.length} new card(s), ${humanMoves.length} human move(s)`);
      log(`board delta: ${newcomers.length} new card(s), ${humanMoves.length} human move(s) → inbox/board-delta.md (committed)`);
    }
    for (const n of newcomers) {
      try { ghOut(["project", "item-archive", num, "--owner", board.owner, "--id", n.id]); } catch { /* leave it */ }
    }
    const live = new Set(tasks.map((t) => t.id));
    for (const [taskId, rec] of Object.entries(board.items)) {
      if (live.has(taskId)) continue;
      if (byItemId.has(rec.itemId)) {
        try { ghOut(["project", "item-archive", num, "--owner", board.owner, "--id", rec.itemId]); archived += 1; } catch { /* keep it */ }
      }
      delete board.items[taskId];
    }
    fs.writeFileSync(boardPath, JSON.stringify(board, null, 2) + "\n");
    if (created || moved || archived || bodyEdits.length) {
      log(`board sync (${why}): ${created} created, ${moved} moved, ${bodyEdits.length} bodies, ${archived} archived`);
    }
  } catch (e) {
    log(`board sync failed (${String(e.message).split("\n")[0]}) — continuing`);
  }
};

if (mode === "sync-board") {
  if (!cfg.board?.github && !cfg.board?.jira) fail('config.json does not enable a board — add "board": {"github": true} or {"jira": true}');
  if (cfg.board?.github && !forge.github) fail(`the GitHub board needs a github forge — this factory's forge is ${forge.kind}; use "board": {"jira": true} instead`);
  if (init) {
    if (cfg.board?.github) boardInit();
    if (cfg.board?.jira) jiraBoardInit({ jira: jiraTracker({ cfg, env }), stateD, say: (m) => process.stdout.write(m + "\n") });
  } else {
    refreshMeta(); // syncBoard reads the backlog from the meta worktree
    syncBoard("manual");
  }
  process.exit(0);
}

// ---------- promote (PR-F) ----------
// Milestone promotion as a driver verb: flip the milestone heading in
// backlog/index.md from `— not-started` (or `— gated`) to `— active`,
// committed and pushed as the driver. Replaces the hand-edited
// `factory/ops-*` PR that tripped the merge-gate's code-only warning.
// Keep-prior-active by default: no other heading is touched — closing a
// finished milestone stays a separate, explicit (human or triage) edit.
if (mode === "promote") {
  const say = (m) => process.stdout.write(m + "\n");
  if (isGitRepo()) refreshMeta(); // edit where the driver commits: meta at origin tip
  const indexPath = path.join(runtimeFactoryDir(), "backlog", "index.md");
  if (!fs.existsSync(indexPath)) fail(`no ${indexPath} — nothing to promote`);
  const text = fs.readFileSync(indexPath, "utf8");
  // Shared parser (backlog-index.mjs): the local regex this replaced read
  // only `## M1 …`, so promote failed with "milestone not found" on the 4
  // fleet factories whose index used another dialect (2026-07-19).
  const headings = parseMilestones(text);
  const hit = headings.find((h) => h.id.toLowerCase() === milestone.toLowerCase());
  if (!hit) {
    fail(`milestone ${milestone} not found in backlog/index.md — headings there: ${
      headings.map((h) => `${h.id} (${h.status ?? "no status"})`).join(", ") || "none"}`);
  }
  if (hit.status === "active") {
    say(`${hit.id} is already active — nothing to do`);
    process.exit(0);
  }
  if (!["not-started", "gated"].includes(hit.status ?? "")) {
    fail(`${hit.id} is ${hit.status ?? "missing its status suffix"} — promote only opens not-started/gated milestones (a ${hit.status} heading is yours to edit by hand)`);
  }
  // Splice the status token in place, by offset — the heading's dialect
  // (`— active` vs `(active)`) is the author's and must survive the flip.
  const flipped = hit.line.slice(0, hit.statusStart) + "active" + hit.line.slice(hit.statusEnd);
  fs.writeFileSync(indexPath, text.slice(0, hit.index) + flipped + text.slice(hit.index + hit.line.length));
  if (isGitRepo()) {
    if (!commitMetadata(`promote ${hit.id}: milestone → active`)) fail(`flip produced no staged change in ${indexPath} — index format drift?`);
    say(`${hit.id} promoted to active — committed and pushed as the driver (prior actives kept)`);
  } else {
    say(`${hit.id} promoted to active in ${indexPath}`);
  }
  process.exit(0);
}

// ---------- needs-human questions (factory-v2 O2, Decision 1) ----------
// Sessions ask via the open_question MCP tool; the DRIVER files the tracker
// issue — one mechanical writer instead of three sessions filing the same
// question (NOTES item 28). Dedupe by normalized title against a plain
// open-issue list (never a search index: it lags, item 31's lesson) — a
// closed question asked again is a new issue on purpose (the answer didn't
// take, or it recurred). Filing failures queue in state.json and retry at
// the next session end.

const QUESTION_PREFIX = "[factory] question: ";
const normTitle = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Returns the questions that reached GitHub (with their issue url) — a
// question tied to a taskId is the session saying it cannot proceed without
// the owner, and the caller parks that task needs-human.
const processQuestions = async (newQuestions, context) => {
  const s = readState();
  const queue = [...(s.pendingQuestions ?? []), ...(newQuestions ?? [])];
  const filed = [];
  if (!queue.length) return filed;
  s.pendingQuestions = [];
  const attribution = (q) => `— asked by a factory ${context} session${q.taskId ? ` working ${q.taskId}` : ""} on ${today()}. Close this issue with an answer; triage reads closed answers daily.`;
  let openByTitle = null; // one tracker round-trip, only when there is a queue
  const seen = new Set(); // same title twice in one batch = a session retrying itself
  for (const q of queue) {
    const key = normTitle(q.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    try {
      if (!openByTitle) {
        openByTitle = new Map();
        for (const i of tracker.issueListOpen()) {
          if (i.title.startsWith(QUESTION_PREFIX)) openByTitle.set(normTitle(i.title.slice(QUESTION_PREFIX.length)), { number: i.number, url: i.url ?? null });
        }
      }
      const existing = openByTitle.get(key);
      if (existing) {
        tracker.issueComment(existing.number, `${q.body || "(same question, no new context)"}\n\n${attribution(q)}`);
        journal("question:comment", "done", `#${existing.number} ${q.title.slice(0, 80)}`);
        log(`question: commented on open #${existing.number} — ${q.title}`);
        filed.push({ taskId: q.taskId ?? null, url: existing.url });
      } else {
        const url = tracker.issueCreate({ title: `${QUESTION_PREFIX}${q.title}`, body: `${q.body || "(no additional context provided)"}\n\n${attribution(q)}` });
        const num = Number(url.match(/\/issues\/(\d+)/)?.[1]);
        if (num) openByTitle.set(key, { number: num, url });
        journal("question:filed", "done", q.title.slice(0, 80));
        log(`question: filed — ${q.title}`);
        filed.push({ taskId: q.taskId ?? null, url: /^https?:\/\//.test(url) ? url : null });
        await notify(`❓ needs-human: ${q.title}${url ? `\n${url}` : ""}`);
      }
    } catch (e) {
      openByTitle = null; // the list itself may have failed — refetch next time
      s.pendingQuestions.push(q);
      log(`question: filing failed (${firstLine(e)}) — kept pending: ${q.title}`);
    }
  }
  // The tracker is the channel that just failed, so say it somewhere else.
  // Without this the only trace is the per-question line above, which scrolls
  // past inside a window and appears on no dashboard — that is how the first
  // Bitbucket pilot stranded two real diagnoses in silence.
  if (s.pendingQuestions.length) {
    const summary = `${s.pendingQuestions.length} question(s) could not be filed — the tracker rejected them; queued, will retry next session: ${s.pendingQuestions.map((q) => q.title).join("; ")}`;
    log(`questions: ${summary}`);
    await notify(`⚠ ${summary}`);
  }
  writeState(s);
  return filed;
};

// Park tasks whose session filed a task-tied question: it cannot self-judge,
// so the task waits on the owner (fail toward the owner — the T-017 twins
// made opposite calls on the same gate). Exception: the session settled the
// task anyway (completed/review) — the question shapes future work, the task
// is not stuck on it. Writes flips + issue links into the meta worktree;
// the caller commits.
const parkNeedsHuman = (filed, result = null) => {
  const park = (filed ?? []).filter((q) =>
    q.taskId && !(result?.taskId === q.taskId && ["completed", "review"].includes(result?.status)));
  if (!park.length) return { applied: [], touched: false };
  const applied = applyFlips(park.map((q) => ({ taskId: q.taskId, status: "needs-human" })));
  let linked = false;
  for (const q of park) if (q.url && addTaskLinkInFiles(q.taskId, q.url)) linked = true;
  // touched: an uncommitted meta edit dies at the next refreshMeta — the
  // caller must commit even when only the link line changed.
  return { applied, touched: applied.length > 0 || linked };
};

// Prompts ship with the driver (O6): one source in the machine runtime,
// nothing per-project to drift, and worktree sessions can't even see them.
const promptFor = (name) => {
  const p = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts", `${name}.md`);
  if (!fs.existsSync(p)) fail(`missing prompt ${p} — the runtime checkout is incomplete`);
  return fs.readFileSync(p, "utf8");
};

// Sessions run in throwaway worktrees (dev) or the meta worktree (triage/
// report) — neither carries a config file (the machine-product premise:
// config never enters a checkout), so the config facts sessions act on
// (autonomy, base branch, tracker, mirrors, limits) ride the prompt itself.
const configPromptNote = () =>
  `\n\n## Factory config (machine-side — this checkout has no .factory/config.json)\n\n` +
  "```json\n" + JSON.stringify(cfg, null, 2) + "\n```\n";

const runSingle = async (name) => {
  log(`${name} session starting`);
  writeLock(stateD, { mode: name, startedAt: new Date().toISOString() });
  const sessionLog = path.join(logDir, `${name}-${nowStamp()}.out`);
  let promptText = promptFor(name) + configPromptNote();
  if (name === "triage") {
    const overlay = stateOverlayNote();
    if (overlay) promptText += `\n\n## Driver state overlay (runtime statuses — authoritative over backlog files)\n\n${overlay}\n`;
  }
  // Triage/report run in the meta worktree: triage edits tracked metadata
  // exactly where the driver commits it; the owner's checkout stays theirs.
  const cwd = isGitRepo() ? metaPath() : project;
  if (isGitRepo()) trustWorkspace(metaPath());
  const { exitCode, timedOut, mcpEventsPath } = await runSession({
    project: cwd,
    cfg,
    env,
    promptText,
    sessionLogPath: sessionLog,
    log,
    mode: name,
    overrides: name === "triage" ? { model: cfg.triageModel } : {},
  });
  const row = recordUsage({ factoryDir: stateD, sessionLogPath: sessionLog, mode: name, status: exitCode === 0 ? "completed" : "failed", log });
  const filedQuestions = await processQuestions(readMcpEvents(mcpEventsPath).questions, name);
  if (name === "triage") {
    // The triage session edits backlog/spec/inbox but never commits — the
    // driver owns metadata commits (NOTES item 24).
    try {
      if (isGitRepo()) {
        if (exitCode === 0) {
          const droppedFlips = dropContradictedFlips();
          if (droppedFlips.length) log(`triage end: discarded stale pending flips ${droppedFlips.join(", ")}`);
        }
        // Triage's own task-tied questions park their tasks too — the flips
        // and links ride the triage commit below.
        const parked = parkNeedsHuman(filedQuestions);
        const applied = [...parked.applied, ...applyFlips([])];
        // Daily counter true-up: triage adds tasks (total changes) and live
        // sessions flip their own shipped tasks between windows — neither
        // goes through applyFlips, so refresh unconditionally here.
        refreshIndexCounts();
        if (commitMetadata(`triage: backlog update ${today()}${applied.length ? ` (${applied.join(", ")})` : ""}`)) {
          log(`triage output committed to ${cfg.baseBranch}`);
        }
        refreshMeta();
        ffOwnerCheckout();
      }
      // Reconcile only after a triage that succeeded AND landed (a refreshMeta
      // failure above skips this) — otherwise the files are not its decision.
      if (exitCode === 0) {
        const dropped = reconcileOverlayToFiles();
        if (dropped.length) log(`overlay reconciled to triage's files: dropped ${dropped.join(", ")}`);
      }
    } catch (e) {
      log(`triage end: repo restore failed (${firstLine(e)})`);
    }
    syncBoard("triage"); // triage rewrites the backlog
  }
  clearLock(stateD);
  log(`${name} session done (exit ${exitCode}${timedOut ? ", timed out" : ""}) — ${sessionLog}`);
  await notify(
    exitCode === 0
      ? `✔ ${name} done${row?.costUsd != null ? ` ($${row.costUsd.toFixed(2)})` : ""}`
      : `⚠ ${name} FAILED (exit ${exitCode}${timedOut ? ", timed out" : ""})`
  );
  return exitCode;
};

const single = async (name) => process.exit((await runSingle(name)) === 0 ? 0 : 1);

if (mode === "triage" || mode === "report") {
  try {
    refreshMeta();
  } catch (e) {
    log(`${mode}: repo not ready (${firstLine(e)}) — aborting`);
    await notify(`✗ ${mode} aborted — repo not ready: ${firstLine(e)}`);
    process.exit(1);
  }
  await single(mode);
}

// Merge-gate (NOTES items 13, 27): when a session reports `review` with a
// PR url under auto-merge-dev, the driver — not a paid session — watches
// checks and merges on green. v2 merges LOCALLY (git merge + push) so the
// task's `done` flip rides inside the merge commit (zero extra commits,
// NOTES item 24) and a conflict surfaces as an exact instruction for the
// next session instead of an opaque `gh pr merge` failure.
// Returns a note for the next session's prompt, or null when there is
// nothing left to do.

const conflictNote = ({ pr, taskId, head }) =>
  `PR ${pr}${taskId ? ` (task ${taskId})` : ""} cannot merge: branch ${head} CONFLICTS with ${cfg.baseBranch}. ` +
  `Your first job: checkout ${head}, merge ${cfg.baseBranch} into it, resolve the conflicts ` +
  `(${cfg.baseBranch} wins on files your task didn't change; your branch wins on its own code), ` +
  `re-verify, push. The driver merges once checks are green — do NOT merge yourself.`;

const failingNote = ({ pr, taskId, head }) =>
  `PR ${pr}${taskId ? ` (task ${taskId})` : ""} has FAILING checks on branch ${head}. ` +
  `Your first job: checkout ${head}, reproduce and fix the failures, push. ` +
  `The driver merges once checks are green — do NOT merge yourself.`;

// The actual landing: local merge with the status flip folded into the
// merge commit. Retries on push races; falls back to `gh pr merge` (flip
// goes to pendingFlips) if local landing keeps failing.
const landMerge = async ({ pr, view, taskId }) => {
  const head = view.headRefName;
  // A blocked task's PR may still land (design docs, partial work), but the
  // merge must not overwrite `blocked` with `done` — the needs-human
  // question is still open (fleet task T-032, 2026-07-07).
  const blocked = taskId && ["blocked", "needs-human"].includes(readState().tasks[taskId]?.status);
  if (blocked) log(`merge-gate: ${taskId} is parked (blocked/needs-human) — landing ${pr} without a status flip`);
  const flips = taskId && !blocked ? [{ taskId, status: "done" }] : [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // All gate git work happens in the driver's meta worktree (detached at
      // origin/<base>; the merge commit reaches origin via push HEAD:<base>).
      // The owner's checkout is never touched.
      refreshMeta();
      git(["fetch", "origin", head], metaPath());
      // gh's PR list/view lag a just-pushed merge; the sweep once re-landed
      // a PR its own session had merged seconds earlier (fleet PR #53).
      if (gitOk(["merge-base", "--is-ancestor", `origin/${head}`, "HEAD"], metaPath())) {
        log(`merge-gate: ${pr} is already contained in ${cfg.baseBranch} — nothing to land`);
        return null;
      }
      const touched = git(["diff", "--name-only", `HEAD...origin/${head}`], metaPath());
      if (touched.split("\n").some((f) => f.startsWith(".factory/backlog/"))) {
        // Live/piloting PRs (no taskId) legitimately carry their own tasks'
        // Status flips (piloting contract); factory task branches stay code-only.
        if (taskId) log(`merge-gate: WARNING — ${pr} touches .factory/backlog (factory task branches are code-only; outdated prompts?) — merging anyway, driver stays status authority`);
        else log(`merge-gate: ${pr} touches .factory/backlog — live/piloting sessions ship their own tasks' status flips; merging`);
      }
      // Deployed tooling is owned upstream — a merged local edit dies
      // silently at the next --update (fleet task T-039 landed 67 lines in
      // driver.mjs this way). Refuse; the note tells a session to split it.
      const tooling = touched.split("\n").filter((f) =>
        f === ".factory/driver.mjs" || f.startsWith(".factory/prompts/") || f.startsWith(".factory/schedulers/") || f.startsWith(".factory/hooks/"));
      if (tooling.length) {
        log(`merge-gate: ${pr} touches deployed factory tooling (${tooling.join(", ")}) — refusing to auto-merge`);
        return `PR ${pr}${taskId ? ` (task ${taskId})` : ""} touches deployed factory tooling ` +
          `(${tooling.join(", ")}), which every tooling refresh silently overwrites — the change cannot ` +
          `survive there. Your first job: remove the tooling edits from branch ${head} (keep the in-repo ` +
          `parts), push, and raise the removed change via the open_question tool so the owner can apply ` +
          `it upstream. The driver merges once the branch is tooling-clean and checks are green.`;
      }
      git(["merge", "--no-ff", "--no-commit", `origin/${head}`], metaPath());
      const applied = applyFlips(flips);
      // A live/piloting PR carries its own Status flips (piloting contract);
      // true up the index counters from the merged files so they ride this
      // commit — applyFlips only refreshes when the driver itself flipped.
      if (!applied.length && touched.split("\n").some((f) => f.startsWith(".factory/backlog/"))) refreshIndexCounts();
      git(["add", "-A", ".factory"], metaPath());
      git(["commit", "-m", `Merge PR #${view.number}${taskId ? ` (${taskId})` : ""}: ${view.title}`,
        "-m", `${applied.length ? `Status: ${applied.join(", ")}. ` : ""}Merged by the factory driver (checks green).`], metaPath());
      pushMetaBase();
      log(`merge-gate: checks green — merged ${pr}${applied.length ? ` (${applied.join(", ")})` : ""}`);
      journal("gate:merge", "done", `${pr}${applied.length ? ` (${applied.join(", ")})` : ""}`);
      await notify(`✚ merged ${pr}${taskId ? ` (${taskId})` : ""}`);
      return null; // status handled — nothing for the next session
    } catch (e) {
      // git prints "CONFLICT (content): …" on STDOUT — stderr alone misses
      // it (fleet PR #47 burned 3 retries + the gh fallback before this).
      const msg = `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}`;
      try { git(["merge", "--abort"], metaPath()); } catch { /* no merge in progress */ }
      if (/CONFLICT|not something we can merge|conflict/i.test(msg)) {
        log(`merge-gate: ${pr} CONFLICTS with ${cfg.baseBranch} on local merge — leaving for the next session`);
        return conflictNote({ pr, taskId, head });
      }
      log(`merge-gate: local merge attempt ${attempt}/3 failed (${firstLine(e)})${attempt < 3 ? " — retrying" : ""}`);
    }
  }
  // Local landing kept failing (e.g. branch protection) — let GitHub merge
  // and queue the flip for the next driver commit.
  try {
    forge.prMerge(pr);
    if (flips.length) {
      const s = readState();
      s.pendingFlips.push({ ...flips[0], ts: new Date().toISOString() });
      writeState(s);
    }
    log(`merge-gate: merged ${pr} via gh fallback${flips.length ? ` (${taskId} flip pending)` : ""}`);
    await notify(`✚ merged ${pr}${taskId ? ` (${taskId})` : ""} (gh fallback)`);
    return null;
  } catch (e) {
    log(`merge-gate: gh pr merge fallback also failed (${firstLine(e)}) — leaving ${pr} for the next session`);
    return `PR ${pr}${taskId ? ` (task ${taskId})` : ""} has green checks but the driver could not merge it (${firstLine(e)}). Diagnose and land it first.`;
  }
};

// Check verdict from the PR's statusCheckRollup — evidence, not exit codes.
// `gh pr checks` misread in-flight CI as failing (~5×/night runtime lesson:
// the gate left a fix-note, the next session found checks green, a whole
// session wasted). Only a concrete failure conclusion is "fail"; anything
// not clearly settled — in-flight, queued, unknown states — is "wait".
const ROLLUP_FAIL = new Set(["FAILURE", "ERROR", "TIMED_OUT", "STARTUP_FAILURE", "CANCELLED", "ACTION_REQUIRED"]);
const ROLLUP_PASS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const rollupState = (checks) => {
  if (!checks?.length) return "none"; // repo without CI — nothing to wait for
  let pending = false;
  for (const c of checks) {
    const s = String(c.conclusion ?? c.state ?? "").toUpperCase(); // CheckRun.conclusion | StatusContext.state
    if (ROLLUP_FAIL.has(s)) return "fail";
    if (!ROLLUP_PASS.has(s)) pending = true;
  }
  return pending ? "pending" : "pass";
};

const mergeGate = async ({ pr, taskId }, budgetMs = cfg.mergeGateMinutes * 60 * 1000) => {
  const deadline = Date.now() + budgetMs;
  while (true) { // always at least one pass — zero-budget callers (no-wait sweeps) still get a verdict
    let view;
    try {
      view = forge.prView(pr);
    } catch (e) {
      log(`merge-gate: gh pr view failed (${firstLine(e)}) — leaving ${pr} for the next session`);
      return null;
    }
    if (view.state !== "OPEN") {
      log(`merge-gate: ${pr} is already ${view.state}`);
      const parkedStatus = taskId ? readState().tasks[taskId]?.status : null;
      const parked = ["blocked", "needs-human"].includes(parkedStatus);
      // A human-gated task at needs-human is the exception: that status MEANS
      // "awaiting owner review of this PR" — the owner merging IS the
      // approval. A blocked one keeps its status even with the gate: the
      // dependency problem isn't answered by the PR landing.
      const humanGate = taskId && parseBacklogTasks(runtimeFactoryDir()).find((x) => x.id === taskId)?.gate === "human";
      if (view.state === "MERGED" && taskId && (!parked || (humanGate && parkedStatus === "needs-human"))) {
        // Merged outside the gate (human, or a session on old prompts) —
        // land the flip as its own metadata commit. Blocked tasks keep
        // their status; the PR landing doesn't answer the open question.
        try {
          refreshMeta();
          const applied = applyFlips([{ taskId, status: "done" }]);
          if (applied.length) commitMetadata(`${taskId} done (PR merged externally)`);
        } catch (e) {
          log(`merge-gate: flip after external merge failed (${firstLine(e)}) — kept pending`);
        }
      }
      return null;
    }
    if (view.mergeable === "CONFLICTING") {
      log(`merge-gate: ${pr} is CONFLICTING with ${cfg.baseBranch} — leaving for the next session`);
      return conflictNote({ pr, taskId, head: view.headRefName });
    }
    const checks = rollupState(view.statusCheckRollup);
    if (checks === "fail") {
      // A failing PR needs a session to fix it, same as a conflicting one
      // (a fleet PR, #50, sat failing with no instruction to anyone).
      log(`merge-gate: checks FAILING on ${pr} — leaving for the next session`);
      return failingNote({ pr, taskId, head: view.headRefName });
    }
    if (checks === "pending") {
      if (Date.now() + 20_000 <= deadline) {
        await sleep(20_000); // checks still running
        continue;
      }
      log(`merge-gate: checks still pending on ${pr} — leaving it for a later gate pass`);
      return null;
    }
    // Green — but a human-gated task's PR never auto-merges: the owner is
    // the acceptance check. Park the task, ask once (the flip landing is the
    // dedupe: repeat sweeps find needs-human already set and stay silent),
    // and let the owner's own merge land it (external-merge path flips done).
    if (taskId && parseBacklogTasks(runtimeFactoryDir()).find((x) => x.id === taskId)?.gate === "human") {
      log(`merge-gate: ${taskId} is human-gated — ${pr} waits for owner review, not auto-merge`);
      try {
        refreshMeta();
        // Dedupe on THIS task's flip landing — applyFlips also drains
        // unrelated pendingFlips, so a bare applied.length would re-comment
        // on every sweep that happens to carry one.
        const applied = applyFlips([{ taskId, status: "needs-human" }]);
        if (applied.some((a) => a.startsWith(`${taskId} `))) {
          commitMetadata(`${taskId} needs-human: green PR awaits owner review`);
          forge.prComment(pr,
            `Checks are green, but ${taskId} is marked \`Gate: human\` — the factory will not auto-merge. ` +
            `Review and merge it yourself (your merge marks the task done), or comment what to change.`);
          journal("gate:human", "done", `${pr} (${taskId})`);
          await notify(`👀 owner review requested: ${pr} (${taskId} is human-gated)`);
        }
      } catch (e) {
        log(`merge-gate: human-gate handling failed (${firstLine(e)}) — ${pr} stays open`);
      }
      return null;
    }
    return await landMerge({ pr, view, taskId }); // "pass", or "none" = repo without CI
  }
};

// PR sweep (NOTES item 27): a green factory PR must not sit orphaned — not
// until tomorrow because the cap ended the window, and not until window end
// because it wasn't this session's own PR (fleet PRs #64/#65 waited stuck-but-
// green until a manual kill→prep landed them). Window end and prep sweep
// with the full gate budget; session boundaries sweep with a single no-wait
// pass per PR (other PRs' pending checks are not worth window time — the
// next boundary retries). Returns the gate notes for the caller to route
// (next session's prompt mid-window, carryNotes at window end), or null
// when the PR list couldn't be read (keep prior notes — nothing was swept).
// Human-gated tasks park at needs-human with their green PR recorded; the
// owner's merge is the approval, but a merged PR leaves the open list and
// nothing else ever re-reads it. Close the loop mechanically at every sweep:
// check each parked gate-human PR and flip done on merge. Question-parked
// tasks (no Gate: human) are NOT closed — the merge doesn't answer the issue.
const closeOwnerMergedGates = () => {
  const s = readState();
  const parked = Object.entries(s.tasks).filter(([, r]) => r.status === "needs-human" && r.pr);
  if (!parked.length) return;
  const tasks = parseBacklogTasks(runtimeFactoryDir());
  for (const [id, rec] of parked) {
    if (tasks.find((t) => t.id === id)?.gate !== "human") continue;
    try {
      if (forge.prState(rec.pr) !== "MERGED") continue;
      refreshMeta();
      const applied = applyFlips([{ taskId: id, status: "done" }]);
      if (applied.length) {
        commitMetadata(`${id} done (owner merged ${rec.pr})`);
        log(`sweep: ${id} approved — owner merged ${rec.pr}`);
        journal("gate:human-approved", "done", `${rec.pr} (${id})`);
      }
    } catch (e) {
      log(`sweep: could not check parked PR ${rec.pr} (${firstLine(e)}) — next sweep retries`);
    }
  }
};

const sweepOpenPRs = async ({ waitForChecks = true, excludePr = null, context = "window-end" } = {}) => {
  try {
    closeOwnerMergedGates();
  } catch (e) {
    log(`sweep: gate-approval check failed (${firstLine(e)}) — continuing with the open-PR pass`);
  }
  let open;
  try {
    open = forge.prListOpen();
  } catch (e) {
    log(`sweep: gh pr list failed (${firstLine(e)}) — skipping`);
    return null;
  }
  // Drafts are human task claims (team affordances) — factory sessions never
  // open drafts, so even one on a factory/ branch is a teammate's and not the
  // gate's to touch (merging a claim would ship half-done work).
  const claimed = open.filter((p) => p.isDraft && (p.headRefName.startsWith("factory/") || p.title.startsWith("[factory]")));
  for (const p of claimed) log(`${context} sweep: #${p.number} is a draft — a human's claim, leaving it alone`);
  const mine = open.filter((p) => !p.isDraft && (p.headRefName.startsWith("factory/") || p.title.startsWith("[factory]")) && p.url !== excludePr);
  if (!mine.length) return [];
  log(`${context} sweep: ${mine.length} open factory PR(s)`);
  const deadline = Date.now() + cfg.mergeGateMinutes * 60 * 1000;
  const notes = [];
  for (const p of mine) {
    const left = deadline - Date.now();
    if (waitForChecks && left <= 0) { log("sweep: gate budget exhausted — remaining PRs wait for the next pass"); break; }
    const taskId = p.title.match(/T-[\w-]+/)?.[0] ?? null;
    const note = await mergeGate({ pr: p.url, taskId }, waitForChecks ? left : 0);
    if (note) notes.push(note);
  }
  return notes;
};

// Window-end/prep sweeps persist their notes: there is no next session to
// hand them to, so the next window's first session reads carryNotes
// (fleet PR #47 sat CONFLICTING across windows because the sweep dropped
// its instruction). Overwrite semantics: still-stuck PRs regenerate their
// note every sweep; a swept-clean list clears stale notes.
const sweepAndCarryNotes = async (context) => {
  const notes = await sweepOpenPRs({ context });
  if (!notes) return; // list unreadable — keep whatever notes we had
  const s = readState();
  s.carryNotes = notes;
  writeState(s);
};

// Sessions that use docker can leave root-owned files in the scratch dir;
// EACCES here must not kill the window (a fleet window 2026-07-07 died on the
// final cleanup and skipped the board sync + lock release).
const scratchDir = path.join(stateD, "tmp");
const rmScratch = (context) => {
  try { fs.rmSync(scratchDir, { recursive: true, force: true }); }
  catch (e) { log(`${context}: could not fully remove ${scratchDir} (${firstLine(e)}) — remove manually (likely root-owned docker leftovers)`); }
};

// ---------- window journal (factory-v2 O4) ----------
// One journal-<window-ts>.jsonl per window, one line per driver step. Its
// load-bearing job: window-end finalization runs as idempotent journaled
// steps, so a crash halfway (the 2026-07-07 EACCES skipped board sync,
// notify, and the lock release — NOTES item 33) is completed by the next
// dev/prep run instead of silently dropped.
// (The journal/journalFile primitives live up next to readMcpEvents:
// processQuestions journals from `await single(mode)`, which runs before
// module evaluation reaches this section — a const here would be TDZ.)

const latestJournalPath = () => {
  let files = [];
  try { files = fs.readdirSync(logDir).filter((f) => /^journal-.+\.jsonl$/.test(f)).sort(); } catch { /* no log dir yet */ }
  return files.length ? path.join(logDir, files[files.length - 1]) : null;
};
const readJournalSteps = (p) => {
  try {
    return fs.readFileSync(p, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
};

const finalizeWindow = async (context, doneSteps = new Set(), notifyText = null) => {
  const steps = [
    ["sweep", async () => { if (cfg.autonomy === "auto-merge-dev") await sweepAndCarryNotes("window-end"); }],
    ["repo", () => { refreshMeta(); ffOwnerCheckout(); }],
    ["scratch", () => rmScratch(context)],
    ["board-sync", () => syncBoard(context)],
    ["notify", async () => { if (notifyText) await notify(notifyText); }],
    ["lock", () => clearLock(stateD)],
  ];
  for (const [name, fn] of steps) {
    if (doneSteps.has(name)) continue;
    try {
      await fn();
      journal(`finalize:${name}`);
    } catch (e) {
      journal(`finalize:${name}`, "failed", firstLine(e));
      log(`${context}: finalize ${name} failed (${firstLine(e)}) — continuing`);
    }
  }
  journal("finalize:complete");
};

// A journal with a window-start but no finalize:complete is a window that
// died mid-flight — finish its missing finalization steps (all idempotent)
// before doing anything else.
const replayUnfinishedFinalization = async () => {
  const p = latestJournalPath();
  if (!p) return;
  const recs = readJournalSteps(p);
  if (!recs.some((r) => r.step === "window-start")) return;
  if (recs.some((r) => r.step === "finalize:complete")) return;
  const done = new Set(
    recs.filter((r) => r.step.startsWith("finalize:") && r.status === "done").map((r) => r.step.slice("finalize:".length))
  );
  log(`unfinished window ${path.basename(p)} — completing its finalization (${done.size} step(s) were already done)`);
  journalFile = p;
  await finalizeWindow("finalize replay", done, "■ window finalization recovered by a later run");
  journalFile = null;
};

// ---------- prep (NOTES item 32) ----------
// "I worked in this checkout — make it safe for the next factory window,
// now." Runs the exact machinery a window start would, spawns no sessions,
// costs nothing: fetch + quarantine dirty state (copied to
// .factory/log/quarantine-<ts>/ AND stashed — recover with `git stash pop`)
// + checkout base at origin tip + push anything unpushed + drain pending
// status flips + give leftover green factory PRs one gate pass, then a
// doctor summary. Safe to run anytime the driver isn't (lock guard above).
if (mode === "prep") {
  await replayUnfinishedFinalization(); // may clear a stale lock — before taking our own
  writeLock(stateD, { mode: "prep", startedAt: new Date().toISOString() });
  try {
    log("prep: making the repo safe for the next factory window");
    if (isGitRepo()) pruneStaleLockedWorktrees();
    await ensureCleanBase("prep");
    refreshMeta(); // flips edit the meta worktree — it must exist and be at origin tip
    const applied = applyFlips([]);
    if (applied.length && commitMetadata(`status sync (prep): ${applied.join(", ")}`)) {
      log(`prep: committed pending status flips — ${applied.join(", ")}`);
    }
    if (cfg.autonomy === "auto-merge-dev") await sweepAndCarryNotes("prep");
    await ensureCleanBase("prep end"); // sweep may have moved base — re-sync
    const results = runDoctor();
    const fails = results.filter((r) => r.level === "fail");
    log(`prep: done — tree clean on ${cfg.baseBranch} at origin tip; doctor: ${
      fails.length ? `${fails.length} problem(s) — ${fails.map((r) => r.name).join("; ")}` : "no problems"}`);
    clearLock(stateD);
    process.exit(fails.length ? 1 : 0);
  } catch (e) {
    log(`prep: FAILED (${firstLine(e)}) — fix manually before the next window`);
    clearLock(stateD);
    process.exit(1);
  }
}

// dev: the window loop
await replayUnfinishedFinalization(); // a crashed window's tail lands before a new one starts
const windowMs = cfg.windowHours * 60 * 60 * 1000;
const windowEnd = Date.now() + windowMs;
const promptText = promptFor("dev-task") + configPromptNote();
rmScratch("window start"); // leftovers from a killed window
// A killed driver strands its session worktree — sweep old ones before
// starting new (disk hygiene; git registrations are pruned on next add).
if (isGitRepo() && fs.existsSync(worktreesRoot())) {
  for (const d of fs.readdirSync(worktreesRoot()).filter((d) => /^s\d+-/.test(d))) {
    removeWorktree(path.join(worktreesRoot(), d), "window start sweep");
  }
}
journalFile = path.join(logDir, `journal-${nowStamp()}.jsonl`);
journal("window-start", "done", `${cfg.windowHours}h, cap ${cfg.maxSessionsPerWindow}, autonomy ${cfg.autonomy}`);
let sessions = 0;
let nextSessionNote = null; // driver-gathered context injected into the next session's prompt
{
  // Conflict/failing-checks instructions persisted by the previous window's
  // sweep (or a prep run) — hand them to this window's first session.
  const s = readState();
  if (s.carryNotes?.length) {
    log(`carrying ${s.carryNotes.length} gate note(s) from the previous window into session 1`);
    nextSessionNote = s.carryNotes.join("\n\n");
    s.carryNotes = [];
    writeState(s);
  }
}

// Session plan from triage: ordered {taskId, model, effort, maxTurns} queue.
// Missing, malformed, or >24h old means triage hasn't seen the current state:
// the window runs a triage first (below, once the repo is ready) and sessions
// self-select only if that triage fails. A fresh-but-empty queue is triage
// saying "nothing eligible" — not a defect (NOTES item 30) — and keeps its
// probe path. When the queue runs out mid-window, sessions self-select: the
// plan was fresh at window start and the backlog reflects its own sessions.
const loadPlan = () => {
  const raw = readJson(path.join(stateD, "plan.json"));
  const fresh = raw?.generatedAt && Date.now() - Date.parse(raw.generatedAt) < 24 * 3600 * 1000;
  return {
    raw,
    queue: fresh && Array.isArray(raw.queue) && raw.queue.length ? raw.queue : null,
    answered: Boolean(fresh && Array.isArray(raw.queue)), // fresh plan, even an empty one
  };
};
let { raw: planRaw, queue: plan, answered: planAnswered } = loadPlan();
let planIdx = 0;

// Sessions start from origin tip in fresh worktrees (O9) — the window's
// known-good state is the meta worktree, not the owner's checkout.
try {
  refreshMeta();
} catch (e) {
  log(`window start: repo not ready (${firstLine(e)}) — aborting`);
  await notify(`✗ dev window ABORTED — repo not ready: ${firstLine(e)}`);
  process.exit(1);
}

// Zero actionable tasks → the window would only burn a paid probe session
// confirming what the statuses already say. Skip it BEFORE spawning (an empty
// backlog keeps today's probe — statuses prove nothing about a bare project).
// This also runs before any auto-triage: statuses are driver-maintained and
// don't need a triage to be trusted, so a settled factory skips for free.
{
  const pool = effectiveTasks();
  const derived = pool.length ? deriveFactoryStatus(pool) : { status: "normal" };
  if (derived.status !== "normal") {
    log(`window skipped: ${derived.detail}`);
    journal("window-skipped", "done", derived.detail);
    await finalizeWindow("window skipped", new Set(), `∅ dev window skipped — ${derived.detail}`);
    process.exit(0);
  }
}

// No usable plan → re-plan now instead of letting sessions guess against a
// state triage never saw (out-of-band merges made this the worst failure
// mode: sessions picked settled tasks or missed unblocked ones). STOP means
// the owner halted this factory: don't burn a triage (or land its metadata
// commit) on a window the loop's first STOP check will end anyway.
if (!planAnswered && !fs.existsSync(stopFile)) {
  log(`plan.json ${planRaw ? "stale or malformed" : "missing"} — running triage before the first session`);
  let triageExit = 1;
  try {
    triageExit = await runSingle("triage");
  } catch (e) {
    log(`auto-triage errored (${firstLine(e)})`);
  }
  ({ raw: planRaw, queue: plan, answered: planAnswered } = loadPlan());
  if (triageExit !== 0) log("auto-triage failed — sessions will self-select");
  else if (!planAnswered) log("auto-triage wrote no usable plan — sessions will self-select");
}
if (plan) log(`plan: ${plan.length} task(s) queued by triage — ${plan.map((e) => e.taskId).join(", ")}`);
else if (planAnswered) log("plan: triage queued 0 tasks (backlog blocked or empty) — one probe session will confirm");

log(
  `dev window starting: ${cfg.windowHours}h, cap ${cfg.maxSessionsPerWindow} sessions, ` +
    `timeout ${cfg.sessionTimeoutMin}min/session, autonomy ${cfg.autonomy}`
);
await notify(`▶ dev window starting (${cfg.windowHours}h, ≤${cfg.maxSessionsPerWindow} sessions${plan ? `, plan: ${plan.map((e) => e.taskId).join(" ")}` : ""})`);
syncBoard("window start");

while (true) {
  if (fs.existsSync(stopFile)) {
    log("STOP file present — ending window");
    break;
  }
  if (Date.now() >= windowEnd) {
    log("window time elapsed — ending window");
    break;
  }
  if (sessions >= cfg.maxSessionsPerWindow) {
    log("session cap reached — ending window");
    break;
  }
  // Don't start a session the window can't reasonably hold (min 5 minutes).
  if (Date.now() + 5 * 60 * 1000 > windowEnd) {
    log("not enough window time left for another session — ending window");
    break;
  }

  sessions += 1;
  fs.rmSync(path.join(logDir, "last-session.json"), { force: true }); // legacy location, stale copies confuse nothing

  // Each session gets a throwaway worktree cut from origin tip — clean by
  // construction, and the owner's checkout never feels the session (O9).
  let sessionWt = null;
  if (isGitRepo()) {
    try {
      sessionWt = addWorktree(`s${sessions}-${nowStamp()}`);
    } catch (e) {
      log(`session ${sessions}: worktree create failed (${firstLine(e)}) — ending window`);
      await notify(`✗ window ended — cannot create session worktree: ${firstLine(e)}`);
      break;
    }
  }
  const sessionCwd = sessionWt ?? project;

  writeLock(stateD, {
    mode: "dev",
    startedAt: new Date(windowEnd - windowMs).toISOString(),
    windowEndsAt: new Date(windowEnd).toISOString(),
    currentSession: sessions,
  });

  const sessionLog = path.join(logDir, `dev-${nowStamp()}.out`);
  // Human PRs are task claims (team affordances): a teammate's open PR with
  // the task id in its title reserves that task — draft while they work, and
  // STILL once marked ready: their Status: done flip rides the PR and only
  // lands at merge, so until then the backlog says todo and only the open PR
  // holds the task (review can take days against nightly windows). Factory-
  // branded non-drafts are the driver's own work — the status ledger already
  // settles those (a draft on a factory/ branch is a human's: sessions never
  // open drafts). Re-read every session — claims come and go mid-window.
  // Unreadable list = no claim info, never a stopped window (the human's
  // draft still protects the task at merge time: the sweep skips drafts).
  const claims = new Map();
  try {
    for (const p of forge.prListOpen()) {
      const factoryOwn = !p.isDraft && (p.headRefName.startsWith("factory/") || p.title.startsWith("[factory]"));
      const id = factoryOwn ? null : p.title.match(/T-[\w-]+/)?.[0];
      if (id && !claims.has(id)) claims.set(id, { number: p.number, draft: p.isDraft });
    }
  } catch (e) {
    log(`claims: pr list failed (${firstLine(e)}) — proceeding without claim info`);
  }
  // planIdx is per-window but plan.json lives until triage rewrites it, so
  // entries settled since it was written (done via an earlier window's merge,
  // blocked awaiting a human) would each burn a session re-verifying (NOTES
  // item 43). Skip them — and claimed entries — a fully-settled plan falls
  // back to self-selection like an exhausted one.
  if (plan) {
    const settled = new Map(effectiveTasks().map((t) => [t.id, t.status]));
    while (planIdx < plan.length) {
      const st = settled.get(plan[planIdx].taskId);
      if (st === "done" || st === "blocked" || st === "needs-human") {
        log(`plan: skipping ${plan[planIdx].taskId} (backlog says ${st})`);
        planIdx += 1;
        continue;
      }
      if (claims.has(plan[planIdx].taskId)) {
        const c = claims.get(plan[planIdx].taskId);
        log(`plan: skipping ${plan[planIdx].taskId} (claimed by ${c.draft ? "draft " : ""}PR #${c.number})`);
        planIdx += 1;
        continue;
      }
      break;
    }
  }
  const entry = plan?.[planIdx] ? { ...plan[planIdx] } : null;
  if (entry && (!entry.model || !entry.effort)) {
    log(`plan entry ${entry.taskId} is missing ${!entry.model ? "model" : "effort"} — triage should have assigned it from the spec; falling back to config/machine default`);
  }
  // Tier enforcement (PR-F): never launch a session below its task's Model:
  // pin — the twins made opposite calls on the same opus-pinned T-017, and a
  // sonnet session flailing on a fable-pinned rubric wastes the session. The
  // dev-task prompt rule is the belt; this is the fix. Only ever raises: a
  // plan model ABOVE the pin is triage correcting against observed usage.
  if (entry?.taskId) {
    const pin = effectiveTasks().find((tk) => tk.id === entry.taskId)?.model ?? null;
    const launch = entry.model ?? cfg.model ?? null;
    if (pin && tierOf(pin) !== null &&
        (launch === null || (tierOf(launch) !== null && tierOf(pin) > tierOf(launch)))) {
      log(`model pin: ${entry.taskId} is pinned ${pin} — launching with it (plan/config said ${launch ?? "machine default"})`);
      entry.model = pin;
    }
  }
  log(`session ${sessions} starting${entry ? ` (plan: ${entry.taskId}${entry.model ? ", " + entry.model : ""}${entry.effort ? ", effort " + entry.effort : ""})` : ""} — ${sessionLog}`);
  if (entry?.taskId) noteRuntimeStatus(entry.taskId, "in-progress");
  let extra = "";
  if (nextSessionNote) extra += `\n\n## Driver handoff (auto-generated — read before Startup)\n\n${nextSessionNote}\n`;
  // The assignment names the session's launch model: the config dump says
  // cfg.model, which is a lie after a pin raise — and the prompt's tier rule
  // would then make a rule-compliant session refuse its own assignment.
  if (entry) extra += `\n\n## Driver assignment (from today's triage plan)\n\nYour task this session: ${entry.taskId}${entry.why ? ` — ${entry.why}` : ""}.\nYour session model: ${entry.model ?? cfg.model ?? "the machine default"} — the driver already honored the task's Model: pin; the tier rule is satisfied for this assignment.\n`;
  {
    const overlay = stateOverlayNote();
    if (overlay) extra += `\n\n## Driver state overlay (runtime statuses — authoritative over backlog files)\n\n${overlay}\n`;
  }
  if (claims.size) {
    extra += `\n\n## Claimed tasks (a human holds each via an open PR — NOT eligible, even if the backlog says todo)\n\n${[...claims].map(([id, c]) => `- ${id} — ${c.draft ? "draft " : ""}PR #${c.number}`).join("\n")}\n`;
  }
  nextSessionNote = null;
  const { exitCode, timedOut, mcpEventsPath } = await runSession({
    project: sessionCwd,
    cfg,
    env,
    promptText: extra ? promptText + extra : promptText,
    sessionLogPath: sessionLog,
    log,
    mode: "dev",
    overrides: entry ?? {},
  });

  // Session result: a settled MCP report (validated, made at the moment of
  // truth — O2) wins over last-session.json, which stays as the fallback
  // chain's second link; an in-progress-only MCP trail is context, not a
  // result. The file report was written inside the session's worktree.
  const mcp = readMcpEvents(mcpEventsPath);
  const result = mcp.report ?? readSessionResult(path.join(sessionCwd, ".factory"));
  removeWorktree(sessionWt, `session ${sessions} end`);
  const end = result ? null : classifySessionEnd(sessionLog);
  const status = result?.status ?? (timedOut ? "timeout" : end.kind === "turn-capped" ? "turn-capped" : "died");
  const row = recordUsage({ factoryDir: stateD, sessionLogPath: sessionLog, mode: "dev", taskId: result?.taskId, status,
    model: entry?.model ?? cfg.model, log });
  journal("session", "done",
    `${sessions} ${result?.taskId ?? entry?.taskId ?? "?"} → ${status}${row?.costUsd != null ? ` $${row.costUsd.toFixed(2)}` : ""}${result?.pr ? ` ${result.pr}` : ""}`);
  const alert = ["blocked", "timeout", "died"].includes(status);
  await notify(
    `${alert ? "⚠" : "✔"} session ${sessions}: ${result?.taskId ?? entry?.taskId ?? "?"} → ${status}` +
      (row?.costUsd != null ? ` ($${row.costUsd.toFixed(2)})` : "") +
      (result?.pr ? `\n${result.pr}` : "") +
      (status === "blocked" && result?.summary ? `\n${result.summary}` : "")
  );
  // Questions before any repo work: filing needs only gh, and a repo
  // failure below must not swallow a session's needs-human asks.
  const filedQuestions = await processQuestions(mcp.questions, "dev");
  // Session boundary: meta worktree back at origin tip before any driver
  // git work (flips, gate). The session's worktree is already gone; the
  // owner's checkout was never involved.
  try {
    refreshMeta();
  } catch (e) {
    log(`session ${sessions} end: repo not recoverable (${firstLine(e)}) — ending window`);
    await notify(`✗ window ended — repo not recoverable after session ${sessions}: ${firstLine(e)}`);
    break;
  }
  if (result?.taskId && result.status) noteRuntimeStatus(result.taskId, result.status, result.pr ?? null);
  // Durable flips the driver owns (NOTES item 24): blocked and reconciled-
  // done get their own (rare) metadata commits; done-via-merge rides the
  // gate's merge commit below.
  // needs-human outranks blocked: a task-tied question refines "blocked"
  // into "only the owner clears it" — don't write blocked first just to
  // overwrite it below.
  const parkedIds = new Set(filedQuestions.filter((q) =>
    q.taskId && !(result?.taskId === q.taskId && ["completed", "review"].includes(result?.status))).map((q) => q.taskId));
  if (result?.taskId && result.status === "blocked" && !parkedIds.has(result.taskId)) {
    const applied = applyFlips([{ taskId: result.taskId, status: "blocked" }]);
    if (applied.length) commitMetadata(`${result.taskId} blocked: ${(result.summary ?? "").split(/[.\n]/)[0].slice(0, 120)}`);
  }
  {
    const { applied, touched } = parkNeedsHuman(filedQuestions, result);
    if (touched) commitMetadata(`needs-human: ${applied.length ? applied.join(", ") : "question link"} (question filed)`);
  }
  if (result?.taskId && result.status === "completed" && !result.pr) {
    const applied = applyFlips([{ taskId: result.taskId, status: "done" }]);
    if (applied.length) commitMetadata(`${result.taskId} done (reconciled by session ${sessions})`);
  }
  // Advance the plan when its task reached a settled state; on incomplete /
  // turn-capped / died the same entry is re-assigned so the next session
  // resumes it (with the handoff note above).
  if (entry && result && ["completed", "review", "blocked"].includes(result.status)) planIdx += 1;
  if (result) {
    log(
      `session ${sessions} done (exit ${exitCode}): task=${result.taskId ?? "?"} ` +
        `status=${result.status ?? "?"} — ${result.summary ?? ""}`
    );
    if (result.status === "no-tasks") {
      syncBoard(`session ${sessions}`);
      log("backlog has no eligible tasks — ending window");
      break;
    }
    if (result.pr && ["review", "completed"].includes(result.status) && cfg.autonomy === "auto-merge-dev") {
      nextSessionNote = await mergeGate({ pr: result.pr, taskId: result.taskId });
    }
  } else {
    // No last-session.json. A turn-capped session usually finished real work
    // and ran out of turns mid-wrap-up (NOTES item 12) — hand its state to
    // the next session instead of counting it as a death. Only real deaths
    // (crash, timeout, no parseable output) arm the two-strike breaker.
    log(
      `session ${sessions} ended (exit ${exitCode}${timedOut ? ", timed out" : ""}) ` +
        `without writing last-session.json` +
        (end.kind === "turn-capped" ? " (turn cap — treating as unfinished wrap-up, not a death)" : "")
    );
    const reason = timedOut
      ? `was killed at the ${cfg.sessionTimeoutMin}min timeout`
      : end.kind === "turn-capped"
        ? "hit the max-turns cap during wrap-up"
        : "died before finishing";
    const snapProject = isGitRepo() ? metaPath() : project;
    nextSessionNote =
      `The previous session ${reason} and never reported a settled status. ` +
      `Reconcile before picking new work: finish or hand off its task (push the branch, open the PR per ` +
      `autonomy — the driver handles merging and backlog status), then continue.\n\n` +
      (mcp.inProgress
        ? `Its last mid-run report (factory MCP, trustworthy): task ${mcp.inProgress.taskId ?? "?"} — ` +
          `${mcp.inProgress.summary}${mcp.inProgress.pr ? ` (PR ${mcp.inProgress.pr})` : ""}\n\n`
        : "") +
      `Repo state right now:\n\n${repoSnapshot({ project: snapProject, env, forge: makeForge(snapProject) })}` +
      (end.finalText ? `\n\nIts final output (may be mid-thought):\n\n${end.finalText.slice(0, 1500)}` : "");
    const realDeath = end.kind !== "turn-capped" || timedOut;
    if (realDeath && exitCode !== 0) {
      const prev = path.join(logDir, `.silent-death`);
      if (fs.existsSync(prev)) {
        log("two consecutive sessions died without reporting — ending window");
        await notify("⚠ two consecutive sessions died — window ended early");
        fs.rmSync(prev, { force: true });
        break;
      }
      fs.writeFileSync(prev, "");
      syncBoard(`session ${sessions}`);
      continue;
    }
  }
  // Session-boundary sweep: green PRs left by earlier sessions or windows
  // land NOW, not at window end. No waiting on other PRs' pending checks —
  // the next boundary retries; the just-gated own PR is excluded. Notes
  // (conflicts, failing checks) go to the next session's prompt.
  if (cfg.autonomy === "auto-merge-dev") {
    const notes = await sweepOpenPRs({ waitForChecks: false, excludePr: result?.pr ?? null, context: `session ${sessions} boundary` });
    if (notes?.length) nextSessionNote = [nextSessionNote, ...notes].filter(Boolean).join("\n\n");
  }
  syncBoard(`session ${sessions}`);
  fs.rmSync(path.join(logDir, `.silent-death`), { force: true });
}

// Window-end finalization: sweep (NOTES item 27), repo restore (item 23),
// scratch, board sync, notify, lock — as journaled idempotent steps, so a
// crash here is completed by the next run (O4).
await finalizeWindow("window end", new Set(), `■ dev window finished: ${sessions} session(s)`);
log(`dev window finished: ${sessions} session(s)`);
