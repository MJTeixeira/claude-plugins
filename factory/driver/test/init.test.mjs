// init.mjs — machine-side registration (P4): machine config + repo work-data
// dirs + trust + registry + doctor, and NOTHING else in the repo. The
// project-side scaffold (CLAUDE.md block, .claude/, guard copy, answerfile)
// died with the machine-product refactor — sessions get tooling injected at
// worktree spawn, and updates ship only through deploy-runtime.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { stateDir } from "../paths.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const initPath = path.join(here, "..", "init.mjs");

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// A plain project the owner already works in: one commit, no factory anywhere.
const makeWorld = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "init-test-"));
  t?.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  git(project, "init", "-b", "main");
  git(project, "config", "user.email", "init-test@example.com");
  git(project, "config", "user.name", "init-test");
  fs.writeFileSync(path.join(project, "package.json"), "{}\n"); // stack: node
  fs.writeFileSync(path.join(project, "README.md"), "# Owner project\n");
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "owner baseline");
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  return { root, project, home, stateDir: stateDir(project, home) };
};

const runInit = (world, args = ["--yes"]) => {
  const r = spawnSync(process.execPath, [initPath, ...args, "--project", world.project], {
    encoding: "utf8",
    timeout: 240_000,
    env: { ...process.env, HOME: world.home },
  });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

const readConfig = (world) => JSON.parse(fs.readFileSync(path.join(world.stateDir, "config.json"), "utf8"));

test("--update died in P4 — refuses and points at deploy-runtime and migrate", (t) => {
  const world = makeWorld(t);

  const r = runInit(world, ["--update"]);

  assert.equal(r.code, 1);
  assert.match(r.stderr, /deploy-runtime/, "must point at the one update verb");
  assert.match(r.stderr, /migrate/, "must point at the schema-heal verb");
});

test("--from died in P4 — refuses and says config is machine state", (t) => {
  const world = makeWorld(t);

  const r = runInit(world, ["--from", "factory.yaml"]);

  assert.equal(r.code, 1);
  assert.match(r.stderr, /machine/i);
});

test("init writes machine state and puts ONLY work-data dirs in the repo", (t) => {
  const world = makeWorld(t);

  const r = runInit(world);

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  // machine side: config + .env under ~/.factory/projects/<key>/
  const cfg = readConfig(world);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.stack, "node", "stack detected from the project");
  assert.equal(cfg.schedule.modes.dev.time, "09:00", "schedule declared as a block");
  assert.ok(fs.existsSync(path.join(world.stateDir, ".env")), ".env template machine-side");
  // registry
  const reg = JSON.parse(fs.readFileSync(path.join(world.home, ".factory", "registry.json"), "utf8"));
  assert.ok(world.project in reg.factories, "registered for the dashboard");
  // repo side: the three work-data dirs and NOTHING else
  for (const d of ["spec", "backlog", "inbox"]) {
    assert.ok(fs.statSync(path.join(world.project, ".factory", d)).isDirectory(), `.factory/${d} exists`);
  }
  for (const rel of ["CLAUDE.md", ".claude", "factory.yaml", ".factory/hooks",
    ".factory/spec-template.md", ".factory/config.json",
    ".factory/.env", ".factory/schedulers"]) {
    assert.equal(fs.existsSync(path.join(world.project, rel)), false, `${rel} must not be written to the repo`);
  }
  // .factory/.gitignore is stamped (PR-F): runtime state — meta-worktree log
  // symlink, plan.json — must never ride a `git add -A .factory` (modelwars).
  const gi = fs.readFileSync(path.join(world.project, ".factory", ".gitignore"), "utf8");
  for (const entry of [".env", "log", "plan.json", "board.json", "STOP"]) {
    assert.ok(gi.split("\n").some((l) => l.trim().replace(/\/$/, "") === entry), `.factory/.gitignore missing ${entry}:\n${gi}`);
  }
  // .factory/README.md is stamped (team affordances): teammates without the
  // skillset get the contract — who edits what, and the draft-PR task claim —
  // from inside the repo.
  const readme = fs.readFileSync(path.join(world.project, ".factory", "README.md"), "utf8");
  assert.match(readme, /draft pull request/i, "README must carry the draft-PR claim convention");
  assert.match(readme, /Status:/, "README must explain the status-line ownership rule");
  // and nothing committed — the gitignore rides normal commits with the rest
  // of the work data, like the backlog will
  assert.equal(git(world.project, "rev-list", "--count", "HEAD"), "1", "init must not create commits");
  // (git collapses an all-untracked dir to `?? .factory/`)
  assert.match(git(world.project, "status", "--porcelain"), /^\?\? \.factory\/(\.gitignore)?$/,
    "init leaves exactly the stamped gitignore for the owner's next commit");
});

test("init keeps an owner-customized .factory/README.md byte-for-byte", (t) => {
  const world = makeWorld(t);
  fs.mkdirSync(path.join(world.project, ".factory"), { recursive: true });
  const custom = "# Our team's factory\n\nHouse rules live here.\n";
  fs.writeFileSync(path.join(world.project, ".factory", "README.md"), custom);

  const r = runInit(world);

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.equal(fs.readFileSync(path.join(world.project, ".factory", "README.md"), "utf8"), custom,
    "an existing README is the owner's — init must never rewrite it");
});

test("init is idempotent — an existing machine config's values are kept", (t) => {
  const world = makeWorld(t);
  assert.equal(runInit(world).code, 0);
  const cfg = readConfig(world);
  cfg.windowHours = 7;
  fs.writeFileSync(path.join(world.stateDir, "config.json"), JSON.stringify(cfg, null, 2) + "\n");

  const r = runInit(world);

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.equal(readConfig(world).windowHours, 7, "re-running init must never clobber config values");
});

test("init trusts the project in ~/.claude.json when it exists", (t) => {
  const world = makeWorld(t);
  fs.writeFileSync(path.join(world.home, ".claude.json"), "{}\n");

  const r = runInit(world);

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const claudeJson = JSON.parse(fs.readFileSync(path.join(world.home, ".claude.json"), "utf8"));
  assert.equal(claudeJson.projects[world.project].hasTrustDialogAccepted, true);
});

test("wizard answers over piped stdin land in the machine config", (t) => {
  const world = makeWorld(t);
  // stack, autonomy, baseBranch, model, schedule, windowHours, devTime,
  // triageTime, reportTime, workDays, mirrors
  const answers = ["python", "pr-only", "main", "opus", "manual", "6", "", "", "", "", ""].join("\n");
  const r = spawnSync(process.execPath, [initPath, "--project", world.project], {
    encoding: "utf8",
    timeout: 240_000,
    input: answers,
    env: { ...process.env, HOME: world.home },
  });

  assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const cfg = readConfig(world);
  assert.equal(cfg.stack, "python");
  assert.equal(cfg.model, "opus");
  assert.equal(cfg.windowHours, 6);
  assert.deepEqual(cfg.schedule, { kind: "manual" });
});
