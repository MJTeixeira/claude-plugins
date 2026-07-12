#!/usr/bin/env node
// Factory registration wizard — repo-side tool (not copied into projects).
// Registers a project as a factory ON THIS MACHINE (the machine-product
// premise): machine config + .env under ~/.factory/projects/<key>/, the three
// work-data dirs in the repo, workspace trust, a registry entry, and a
// closing doctor. It writes NOTHING else to the repo — session tooling
// (allowlist, skills, guard hook) is injected into worktrees at spawn from
// the machine runtime, and updates ship only through deploy-runtime.mjs.
//
//   node init.mjs --project <path>          # interactive wizard
//   node init.mjs --project <path> --yes    # all defaults, no questions
//
// Idempotent: re-running never clobbers existing machine config or .env
// values. Dead flags from the per-project era: --update (runtime updates are
// deploy-runtime.mjs; schema healing is `factory.mjs migrate`) and --from
// (config is machine state now — answerfiles are gone).

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline/promises";
import { stateDir, writeJsonAtomic } from "./paths.mjs";
import { detectStack, stampFactoryGitignore } from "./workspace.mjs";
import { PLATFORM_SCHEDULER, DEFAULTS, buildConfig } from "./config.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FACTORY_SRC = path.join(REPO, "factory");
// What every scheduler execs — a fixed per-machine path on purpose: init may
// run from any checkout, but units must point at the one gated runtime.
const RUNTIME_DRIVER = path.join(os.homedir(), ".factory", "runtime", "factory", "driver", "factory.mjs");

const fail = (msg) => {
  process.stderr.write(`factory-init: ${msg}\n`);
  process.exit(1);
};

if (!fs.existsSync(path.join(FACTORY_SRC, "prompts"))) {
  fail("must run from the claude-plugins repo (or the ~/.factory/runtime clone) (factory/prompts/ not found)");
}

// ---------- args ----------
const argv = process.argv.slice(2);
let projectArg = null, yes = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--project") projectArg = argv[++i];
  else if (argv[i] === "--yes") yes = true;
  else if (argv[i] === "--update") fail("--update died with the machine-product refactor: the runtime updates only through deploy-runtime.mjs, and config schema healing is `factory.mjs migrate --project <path>`");
  else if (argv[i] === "--from") fail("--from died with the machine-product refactor: config is machine state (~/.factory/projects/<key>/), not a committed answerfile — run the wizard, or copy the config.json from another machine yourself");
  else fail(`unknown flag ${argv[i]} — usage: init.mjs --project <path> [--yes]`);
}
if (!projectArg) fail("--project <path> is required");
const project = path.resolve(projectArg);
if ([os.homedir(), path.join(os.homedir(), ".claude"), REPO].includes(project)) {
  fail(`refusing to set up ${project}`);
}

// ---------- answers ----------
// Piped stdin (tests, scripting): consume all lines up-front as an answer
// queue — readline's question() races pre-buffered lines and drops answers.
// Read lazily: only interactive question flows may touch stdin — an eager
// read would hang --yes runs whose stdin is open but silent (e.g. over ssh).
let pipedAnswers = null;
const initPipedAnswers = () => {
  if (!process.stdin.isTTY) {
    pipedAnswers = fs.readFileSync(0, "utf8").split("\n").map((s) => s.trim());
  }
};

const ask = async (rl, q, def) => {
  let a;
  if (pipedAnswers) {
    a = pipedAnswers.shift() ?? "";
    process.stdout.write(`${q} [${def}]: ${a}\n`);
  } else {
    a = (await rl.question(`${q} [${def}]: `)).trim();
  }
  return a || String(def);
};

const gatherAnswers = async () => {
  const a = { ...DEFAULTS, projectName: path.basename(project) };
  const detected = detectStack(project);
  if (detected) a.stack = detected;
  if (yes) return a;
  initPipedAnswers();
  const rl = pipedAnswers ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  process.stdout.write(`Factory setup for ${project}\n(enter = accept default)\n\n`);
  a.stack = await ask(rl, "Stack (node/python/rust/go/dotnet/other)", a.stack);
  a.autonomy = await ask(rl, "Autonomy (pr-only/auto-merge-dev/milestone-gates)", a.autonomy);
  a.baseBranch = await ask(rl, "Base branch for factory PRs", a.baseBranch);
  a.model = await ask(rl, "Default session model (sonnet/opus/haiku)", a.model);
  a.schedule = await ask(rl, `Schedule (${PLATFORM_SCHEDULER[process.platform] ?? "manual"}/cron/manual — manual = you start windows yourself)`, a.schedule);
  a.windowHours = await ask(rl, "Dev window length, hours", a.windowHours);
  a.devTime = await ask(rl, "Dev window start (HH:MM)", a.devTime);
  a.triageTime = await ask(rl, "Triage time (HH:MM)", a.triageTime);
  a.reportTime = await ask(rl, "Report time (HH:MM)", a.reportTime);
  a.workDays = await ask(rl, "Work days (Mon-Fri or Mon-Sun)", a.workDays);
  a.mirrors = await ask(rl, "Mirrors (notion,jira or empty)", a.mirrors || "none");
  if (a.mirrors === "none") a.mirrors = "";
  rl?.close();
  return a;
};

// ---------- steps ----------
const done = (msg) => process.stdout.write(`  ✓ ${msg}\n`);
const skip = (msg) => process.stdout.write(`  - ${msg}\n`);

const step_git = (a) => {
  if (!fs.existsSync(project)) fs.mkdirSync(project, { recursive: true });
  if (!fs.existsSync(path.join(project, ".git"))) {
    execFileSync("git", ["init", "-b", "main"], { cwd: project });
    done("git init (branch main)");
  }
  const branches = execFileSync("git", ["branch", "--list", "--format=%(refname:short)"], { cwd: project }).toString();
  if (a.baseBranch !== "main" && !branches.split("\n").includes(a.baseBranch)) {
    try {
      execFileSync("git", ["branch", a.baseBranch], { cwd: project, stdio: "pipe" });
      done(`created branch ${a.baseBranch}`);
    } catch {
      skip(`branch ${a.baseBranch} (repo has no commits yet — create it after the first commit)`);
    }
  }
};

// The repo gets ONLY the work-data dirs — the factory's collaboration
// surface (specs in, backlog state, inbox deltas). They ride normal commits
// once they have content; there is no scaffold to commit at init time.
const step_workdata = () => {
  for (const d of ["spec", "backlog", "inbox"]) {
    fs.mkdirSync(path.join(project, ".factory", d), { recursive: true });
  }
  done(".factory/{spec,backlog,inbox} (work data — all the factory ever puts in the repo)");
  // The one non-dir scaffold file: without it a `git add -A .factory` tracks
  // runtime state — the meta worktree's log symlink and plan.json (modelwars
  // 2026-07-11). Rides a normal commit with the rest of the work data.
  if (stampFactoryGitignore(project).length) done(".factory/.gitignore (keeps runtime state out of commits)");
  else skip(".factory/.gitignore (already covers the runtime state)");
};

// Config and secrets are MACHINE state: they live under
// ~/.factory/projects/<key>/, never in the repo, never in a commit.
const step_machine_config = (a) => {
  const S = stateDir(project);
  const cfgPath = path.join(S, "config.json");
  if (!fs.existsSync(cfgPath)) {
    writeJsonAtomic(cfgPath, buildConfig(a));
    done(`config.json (machine-side: ${cfgPath})`);
  } else skip("config.json (machine-side copy exists — values kept)");

  const envPath = path.join(S, ".env");
  if (!fs.existsSync(envPath)) {
    fs.mkdirSync(S, { recursive: true });
    fs.writeFileSync(envPath, "# Fill me. Loaded into every factory session.\nGH_TOKEN=\nNOTION_TOKEN=\nJIRA_BASE_URL=\nJIRA_EMAIL=\nJIRA_API_TOKEN=\n# Telegram notifications (config.json → \"notify\": {\"telegram\": true})\nTELEGRAM_BOT_TOKEN=\nTELEGRAM_CHAT_ID=\n");
    done(`.env (machine-side: ${envPath} — fill GH_TOKEN if needed)`);
  } else skip(".env (machine-side copy exists — values kept)");
};

const step_trust = () => {
  const p = path.join(os.homedir(), ".claude.json");
  if (!fs.existsSync(p)) return skip("workspace trust (~/.claude.json not found — run claude once first)");
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  j.projects ??= {};
  if (j.projects[project]?.hasTrustDialogAccepted === true) return skip("workspace trust (already trusted)");
  const bak = p + ".bak-factory-init";
  if (!fs.existsSync(bak)) fs.copyFileSync(p, bak);
  j.projects[project] = { ...(j.projects[project] ?? {}), hasTrustDialogAccepted: true };
  writeJsonAtomic(p, j); // atomic: a torn ~/.claude.json breaks every session on the machine
  done("workspace trusted for headless allowlist use");
};

// The declaration written by buildConfig is the source of truth for units;
// `factory.mjs schedule --install` projects it onto the machine (diff +
// confirm + enable). Init only points there — "manual" remains a
// first-class, doctor-green choice (NOTES item 25).
const scheduleInstructions = (a) => {
  if (a.schedule === "manual") {
    done("schedule: manual — no independent runs (start windows yourself)");
    return [`(schedule is "manual" — run windows with: node ${RUNTIME_DRIVER} dev --project ${project})`];
  }
  done(`schedule: ${a.schedule} declared in machine config (dev ${a.devTime}, ${a.workDays}) — install it below`);
  return [`node ${RUNTIME_DRIVER} schedule --install --project ${project}   # shows a diff, then installs + enables`];
};

const step_registry = (a) => {
  const regDir = path.join(os.homedir(), ".factory");
  const regPath = path.join(regDir, "registry.json");
  fs.mkdirSync(regDir, { recursive: true });
  let reg = { factories: {} };
  if (fs.existsSync(regPath)) {
    try { reg = JSON.parse(fs.readFileSync(regPath, "utf8")); } catch { /* rewrite */ }
  }
  reg.factories ??= {};
  reg.factories[project] = { name: a.projectName, registeredAt: reg.factories[project]?.registeredAt ?? new Date().toISOString() };
  writeJsonAtomic(regPath, reg);
  done("registered in ~/.factory/registry.json (dashboard will find it)");
};

// Advisory doctor run — the printed checklist IS the setup contract. Some
// checks only go green after the human steps (runtime clone, scheduler
// install), so init doesn't hard-fail here; the factory-setup skill gates on
// a clean pass. Runs THIS checkout's driver: init and driver ship together.
const step_doctor = () => {
  process.stdout.write("\nDoctor (setup contract — must be all ✓ before you call this factory live):\n\n");
  const driver = path.join(FACTORY_SRC, "driver", "factory.mjs");
  try {
    execFileSync(process.execPath, [driver, "doctor", "--project", project],
      { stdio: "inherit", timeout: 180_000 });
  } catch {
    process.stdout.write("\n  ✗ doctor found problems — fix them (or finish the human steps) and re-run:\n" +
      `    node ${driver} doctor --project ${project}\n`);
  }
};

// ---------- run ----------
const answers = await gatherAnswers();
process.stdout.write(`\nSetting up Factory in ${project}\n`);
step_git(answers);
step_workdata();
step_machine_config(answers);
step_trust();
const schedInstructions = scheduleInstructions(answers);
step_registry(answers);
step_doctor();

process.stdout.write(`\nDone. Remaining human steps:
  0. Machine setup (once per machine — see factory/FACTORY.md "Machine setup"):
       git clone <this-repo-url> ${path.join(os.homedir(), ".factory", "runtime")}
  1. Specs into .factory/spec/  (pattern: ${path.join(FACTORY_SRC, "templates", "spec-template.md")})
  2. GH_TOKEN into ${path.join(stateDir(project), ".env")} (skip if 'gh auth login' is done as the right account)
  3. Compile backlog:   cd ${project} && cat ${path.join(FACTORY_SRC, "prompts", "compile-spec.md")} | claude
  4. Test one window:   node ${path.join(FACTORY_SRC, "driver", "factory.mjs")} dev --project ${project} --max-sessions 2
  5. Schedule it (or keep schedule: manual):
       ${schedInstructions.join("\n       ")}
  6. Re-run doctor until it is fully green — THAT is "setup done":
       node ${path.join(FACTORY_SRC, "driver", "factory.mjs")} doctor --project ${project}
`);
