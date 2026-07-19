// `factory.mjs migrate --project <p>` — moves a legacy factory's repo-side
// state (config.json, .env, log/, plan.json, board.json, STOP) to the
// machine-side state dir and removes the config from git. The repo keeps
// only work data afterwards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { stateDir } from "../paths.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const driverPath = path.join(here, "..", "factory.mjs");

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// A pre-migration world: state committed/living in the project repo, the
// way every factory looked before the machine-product refactor.
const makeLegacyWorld = (t, { config = {} } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-test-"));
  t?.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const origin = path.join(root, "origin.git");
  fs.mkdirSync(origin);
  git(origin, "init", "--bare", "--initial-branch=main");
  const project = path.join(root, "project");
  git(root, "clone", origin, project);
  git(project, "checkout", "-b", "main");
  git(project, "config", "user.email", "migrate-test@example.com");
  git(project, "config", "user.name", "migrate-test");

  const f = path.join(project, ".factory");
  fs.mkdirSync(path.join(f, "backlog"), { recursive: true });
  fs.mkdirSync(path.join(f, "spec"));
  fs.writeFileSync(path.join(f, "spec", "goal.md"), "# Goal\n");
  fs.writeFileSync(path.join(f, "backlog", "index.md"), "# Backlog\n");
  fs.writeFileSync(path.join(f, ".gitignore"), ".env\nlog\ntmp/\nplan.json\nboard.json\nSTOP\n");

  // The committed project-side tooling scaffold init used to deploy — P2
  // injects all of it into worktrees from the runtime, so migrate removes it.
  fs.mkdirSync(path.join(f, "hooks"));
  fs.writeFileSync(path.join(f, "hooks", "guard.mjs"), "// deployed guard copy\n");
  fs.writeFileSync(path.join(f, "spec-template.md"), "# Spec template\n");
  fs.mkdirSync(path.join(f, "schedulers"));
  fs.writeFileSync(path.join(f, "schedulers", "com.factory.project.dev.plist"), "<plist/>\n");
  fs.writeFileSync(path.join(project, "factory.yaml"), "# answerfile\nstack: node\nbaseBranch: main\n");
  // v3-era stamped copies (the melkaia twins still carry these): dead weight
  // nothing runs — init --update used to remove them, migrate owns it now.
  fs.writeFileSync(path.join(f, "driver.mjs"), "// stale v3 stamped copy\n");
  fs.mkdirSync(path.join(f, "prompts"));
  fs.writeFileSync(path.join(f, "prompts", "dev-task.md"), "# dev-task (stale copy)\n");
  const skills = path.join(project, ".claude", "skills");
  for (const s of ["tdd", "backlog", "owners-own"]) {
    fs.mkdirSync(path.join(skills, s), { recursive: true });
    fs.writeFileSync(path.join(skills, s, "SKILL.md"), `# ${s}\n`);
  }
  fs.mkdirSync(path.join(project, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(path.join(project, ".claude", "agents", "code-reviewer.md"), "# reviewer\n");
  // install.sh-era per-project tooling (G3: the plugins ship all of it now,
  // except the statusline — that stays project-side by design).
  fs.mkdirSync(path.join(project, ".claude", "commands"), { recursive: true });
  fs.writeFileSync(path.join(project, ".claude", "commands", "commit.md"), "# /commit\n");
  fs.mkdirSync(path.join(project, ".claude", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(project, ".claude", "hooks", "protected-branch-guard.mjs"), "// install.sh-era guard copy\n");
  fs.writeFileSync(path.join(project, ".claude", "statusline.sh"), "#!/bin/sh\necho status\n");
  fs.writeFileSync(path.join(project, ".claude", "settings.local.json"), JSON.stringify({ machineInjected: true }) + "\n");
  // Forced: dev machines commonly global-gitignore settings.local.json — the
  // transition-era repos this models (witchhat/blacklist) force-added it.
  git(project, "add", "-f", "--", ".claude/settings.local.json");
  fs.writeFileSync(path.join(project, ".claude", "settings.json"), JSON.stringify({
    permissions: { allow: ["Read", "Bash(git:*)", "mcp__factory", "Bash(npm:*)", "Bash(make:*)"] },
    statusLine: { type: "command", command: ".claude/statusline.sh", padding: 0 },
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "echo owner-hook" }] },
        { matcher: "Edit|MultiEdit|Write|NotebookEdit|Bash", hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.factory/hooks/guard.mjs"' }] },
        { matcher: "Bash", hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/protected-branch-guard.mjs"' }] },
      ],
    },
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(project, "CLAUDE.md"), "# Owner notes\n\n<!-- BEGIN LEAN-WORKFLOW MANAGED BLOCK -->\nblock\n<!-- END LEAN-WORKFLOW MANAGED BLOCK -->\n");
  fs.writeFileSync(path.join(f, "config.json"), JSON.stringify({
    enabled: false, // a paused factory must STAY paused through migration
    baseBranch: "main",
    schedule: "manual",
    autonomy: "pr-only",
    windowHours: 4,
    ...config,
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(f, ".env"), "GH_TOKEN=legacy-secret\n");
  fs.mkdirSync(path.join(f, "log"));
  fs.writeFileSync(path.join(f, "log", "usage.jsonl"), JSON.stringify({ ts: "2026-07-01T00:00:00Z", costUsd: 1.5 }) + "\n");
  fs.writeFileSync(path.join(f, "plan.json"), JSON.stringify({ generatedAt: "2026-07-01T00:00:00Z", queue: [] }) + "\n");
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "legacy scaffold");
  git(project, "push", "-q", "origin", "main");

  const home = path.join(root, "home");
  fs.mkdirSync(home);
  return { root, project, home, factoryDir: f, stateDir: stateDir(project, home) };
};

const runMigrate = (world) => {
  const r = spawnSync(process.execPath, [driverPath, "migrate", "--project", world.project], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, HOME: world.home },
  });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

test("migrate moves repo-side state to the machine and removes config from git", (t) => {
  const world = makeLegacyWorld(t);

  const r = runMigrate(world);

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  // state landed machine-side, values intact (enabled:false preserved)
  const cfg = JSON.parse(fs.readFileSync(path.join(world.stateDir, "config.json"), "utf8"));
  assert.equal(cfg.enabled, false, "a paused factory must stay paused");
  assert.equal(cfg.windowHours, 4);
  assert.match(fs.readFileSync(path.join(world.stateDir, ".env"), "utf8"), /legacy-secret/);
  assert.match(fs.readFileSync(path.join(world.stateDir, "log", "usage.jsonl"), "utf8"), /costUsd/);
  assert.ok(fs.existsSync(path.join(world.stateDir, "plan.json")), "plan.json moved");
  // gone from the project dir and from git
  assert.equal(fs.existsSync(path.join(world.factoryDir, "config.json")), false, "config left the repo dir");
  assert.equal(fs.existsSync(path.join(world.factoryDir, ".env")), false, ".env left the repo dir");
  assert.equal(fs.existsSync(path.join(world.factoryDir, "log")), false, "log/ left the repo dir");
  assert.equal(git(world.project, "ls-files", ".factory/config.json"), "", "config removed from the index");
  // the removal is committed (work-data style), not left dirty
  assert.equal(git(world.project, "status", "--porcelain", ".factory/config.json"), "");
  assert.match(git(world.project, "log", "-1", "--pretty=%s"), /migrate/i);
  // work data untouched
  assert.ok(fs.existsSync(path.join(world.factoryDir, "backlog", "index.md")));
  assert.ok(fs.existsSync(path.join(world.factoryDir, "spec", "goal.md")));
});

test("migrate is idempotent — second run is a clean no-op", (t) => {
  const world = makeLegacyWorld(t);
  assert.equal(runMigrate(world).code, 0);

  const r = runMigrate(world);

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /already migrated/i);
});

test("migrate never clobbers existing machine-side state", (t) => {
  const world = makeLegacyWorld(t);
  // a machine-side config already exists (e.g. a half-finished earlier run)
  fs.mkdirSync(world.stateDir, { recursive: true });
  fs.writeFileSync(path.join(world.stateDir, "config.json"), JSON.stringify({ enabled: true, windowHours: 9 }) + "\n");

  const r = runMigrate(world);

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const cfg = JSON.parse(fs.readFileSync(path.join(world.stateDir, "config.json"), "utf8"));
  assert.equal(cfg.windowHours, 9, "existing machine config must win");
  assert.match(r.stdout, /kept|skip/i);
  // the losing legacy copy is preserved on disk for the owner, not deleted
  assert.ok(fs.existsSync(path.join(world.factoryDir, "config.json")), "conflicting legacy file must not be destroyed");
});

test("migrate registers the factory in the machine registry", (t) => {
  const world = makeLegacyWorld(t);

  const r = runMigrate(world);

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const reg = JSON.parse(fs.readFileSync(path.join(world.home, ".factory", "registry.json"), "utf8"));
  assert.ok(world.project in reg.factories, "project registered");
});

test("migrate commits only its own deletions — pre-staged owner work stays staged", (t) => {
  const world = makeLegacyWorld(t);
  fs.writeFileSync(path.join(world.project, "wip.txt"), "half-finished owner work\n");
  git(world.project, "add", "wip.txt");

  const r = runMigrate(world);

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const committed = git(world.project, "show", "--name-only", "--pretty=format:", "HEAD");
  assert.match(committed, /\.factory\/config\.json/);
  assert.doesNotMatch(committed, /wip\.txt/, "owner's staged WIP must not ride the migrate commit");
  assert.match(git(world.project, "diff", "--cached", "--name-only"), /wip\.txt/, "owner's WIP stays staged");
});

test("migrate removes the project-side tooling scaffold from the repo (work data stays)", (t) => {
  const world = makeLegacyWorld(t);
  const claudeMdBefore = fs.readFileSync(path.join(world.project, "CLAUDE.md"), "utf8");

  const r = runMigrate(world);

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  for (const rel of [".factory/hooks/guard.mjs", ".factory/spec-template.md",
    ".factory/schedulers/com.factory.project.dev.plist", "factory.yaml",
    ".claude/skills/tdd/SKILL.md", ".claude/skills/backlog/SKILL.md",
    ".claude/agents/code-reviewer.md"]) {
    assert.equal(git(world.project, "ls-files", "--", rel), "", `${rel} still tracked`);
    assert.equal(fs.existsSync(path.join(world.project, rel)), false, `${rel} still on disk`);
  }
  // The owner's own skill is not the factory's to remove.
  assert.notEqual(git(world.project, "ls-files", "--", ".claude/skills/owners-own"), "");
  // Work data untouched; owner text in CLAUDE.md untouched (the managed
  // block between markers is refreshed — covered by its own test below).
  assert.notEqual(git(world.project, "ls-files", "--", ".factory/backlog/index.md"), "");
  assert.notEqual(git(world.project, "ls-files", "--", ".factory/spec/goal.md"), "");
  assert.match(fs.readFileSync(path.join(world.project, "CLAUDE.md"), "utf8"), /^# Owner notes/,
    "owner text outside the managed block must survive");
  void claudeMdBefore;
  // Removal is committed, not left dirty.
  assert.equal(git(world.project, "status", "--porcelain"), "");
});

test("migrate retires install.sh-era .claude tooling — the plugins ship it now; statusline stays", (t) => {
  const world = makeLegacyWorld(t);

  const r = runMigrate(world);

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  for (const rel of [".claude/commands/commit.md", ".claude/hooks/protected-branch-guard.mjs", ".claude/settings.local.json"]) {
    assert.equal(git(world.project, "ls-files", "--", rel), "", `${rel} still tracked`);
    assert.equal(fs.existsSync(path.join(world.project, rel)), false, `${rel} still on disk`);
  }
  // The statusline is NOT plugin-provided — it stays, file and settings key.
  assert.notEqual(git(world.project, "ls-files", "--", ".claude/statusline.sh"), "", "statusline.sh must stay tracked");
  const settings = JSON.parse(fs.readFileSync(path.join(world.project, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.statusLine?.command, ".claude/statusline.sh", "statusLine settings key must survive the strip");
  // The install.sh guard wiring left settings.json along with the file.
  const cmds = (settings.hooks?.PreToolUse ?? []).flatMap((e) => (e.hooks ?? []).map((h) => h.command));
  assert.ok(!cmds.some((c) => String(c).includes("protected-branch-guard.mjs")),
    `install.sh guard wiring survived the strip: ${cmds}`);
  assert.equal(git(world.project, "status", "--porcelain"), "");
});

test("migrate refreshes the LEAN-WORKFLOW managed block from the runtime — owner text untouched", (t) => {
  const world = makeLegacyWorld(t);

  const r = runMigrate(world);

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const text = fs.readFileSync(path.join(world.project, "CLAUDE.md"), "utf8");
  assert.match(text, /^# Owner notes/, "owner text before the block must survive");
  assert.match(text, /code4food-skillset/, "block not refreshed to the namespaced runtime copy");
  assert.doesNotMatch(text, /^block$/m, "stale block content survived the refresh");
  assert.equal(git(world.project, "status", "--porcelain", "CLAUDE.md"), "", "the refresh must be committed");
});

test("a CLAUDE.md without the managed markers is never touched", (t) => {
  const world = makeLegacyWorld(t);
  fs.writeFileSync(path.join(world.project, "CLAUDE.md"), "# Owner-only instructions\nno markers here\n");
  git(world.project, "add", "CLAUDE.md");
  git(world.project, "commit", "-q", "-m", "owner claude.md");
  git(world.project, "push", "-q", "origin", "main");

  const r = runMigrate(world);

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.equal(fs.readFileSync(path.join(world.project, "CLAUDE.md"), "utf8"),
    "# Owner-only instructions\nno markers here\n");
});

test("migrate strips factory entries from settings.json — owner entries stay", (t) => {
  const world = makeLegacyWorld(t);

  const r = runMigrate(world);

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const settings = JSON.parse(fs.readFileSync(path.join(world.project, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(settings.permissions.allow, ["Bash(make:*)"],
    "factory allowlist entries must go, owner entries must stay");
  const hooks = settings.hooks.PreToolUse;
  assert.equal(hooks.length, 1, `guard hook must go, owner hook must stay: ${JSON.stringify(hooks)}`);
  assert.equal(hooks[0].hooks[0].command, "echo owner-hook");
  assert.equal(git(world.project, "status", "--porcelain", ".claude/settings.json"), "");
});

test("a settings.json that is entirely factory-owned is removed outright", (t) => {
  const world = makeLegacyWorld(t);
  fs.writeFileSync(path.join(world.project, ".claude", "settings.json"), JSON.stringify({
    permissions: { allow: ["Read", "mcp__factory"] },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.factory/hooks/guard.mjs"' }] }] },
  }, null, 2) + "\n");
  git(world.project, "add", "-A");
  git(world.project, "commit", "-q", "-m", "factory-only settings");
  git(world.project, "push", "-q", "origin", "main");

  const r = runMigrate(world);

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.equal(git(world.project, "ls-files", "--", ".claude/settings.json"), "");
  assert.equal(fs.existsSync(path.join(world.project, ".claude", "settings.json")), false);
});

test("migrate recovers the stack from factory.yaml into machine config before removing it", (t) => {
  const world = makeLegacyWorld(t);

  const r = runMigrate(world);

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const cfg = JSON.parse(fs.readFileSync(path.join(world.stateDir, "config.json"), "utf8"));
  assert.equal(cfg.stack, "node", "stack declared in factory.yaml must survive the answerfile's removal");
});

test("repo cleanup also runs for an already-migrated factory (P1-shaped repo)", (t) => {
  const world = makeLegacyWorld(t);
  // P1 shape: state already machine-side, config gone from git — but the
  // tooling scaffold still committed.
  fs.mkdirSync(world.stateDir, { recursive: true });
  fs.renameSync(path.join(world.factoryDir, "config.json"), path.join(world.stateDir, "config.json"));
  fs.renameSync(path.join(world.factoryDir, ".env"), path.join(world.stateDir, ".env"));
  fs.renameSync(path.join(world.factoryDir, "log"), path.join(world.stateDir, "log"));
  fs.rmSync(path.join(world.factoryDir, "plan.json"));
  git(world.project, "rm", "-q", "--cached", ".factory/config.json");
  git(world.project, "commit", "-q", "-m", "factory: migrate state to the machine");
  git(world.project, "push", "-q", "origin", "main");

  const r = runMigrate(world);

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.equal(git(world.project, "ls-files", "--", ".factory/hooks"), "", "scaffold survived the already-migrated path");
  assert.equal(git(world.project, "ls-files", "--", "factory.yaml"), "");

  // And a THIRD run has nothing left to do — no new commit.
  const head = git(world.project, "rev-parse", "HEAD");
  assert.equal(runMigrate(world).code, 0);
  assert.equal(git(world.project, "rev-parse", "HEAD"), head, "idempotent cleanup must not stack commits");
});

test("migrate untracks committed runtime state and stamps .factory/.gitignore — the modelwars shape (PR-F)", (t) => {
  const world = makeLegacyWorld(t);
  // modelwars 2026-07-11: no .factory/.gitignore, so log/ and plan.json were
  // committed. factory-setup missed the stamp; migrate is the standing fix.
  fs.rmSync(path.join(world.factoryDir, ".gitignore"));
  git(world.project, "rm", "-q", "--cached", ".factory/.gitignore");
  git(world.project, "add", "-f", "--", ".factory/log", ".factory/plan.json");
  git(world.project, "commit", "-q", "-m", "runtime state accidentally tracked");
  git(world.project, "push", "-q", "origin", "main");

  const r = runMigrate(world);

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.equal(git(world.project, "ls-files", "--", ".factory/log"), "", "log stayed tracked");
  assert.equal(git(world.project, "ls-files", "--", ".factory/plan.json"), "", "plan.json stayed tracked");
  const gi = fs.readFileSync(path.join(world.factoryDir, ".gitignore"), "utf8");
  for (const entry of [".env", "log", "plan.json", "board.json", "STOP"]) {
    assert.ok(gi.split("\n").some((l) => l.trim().replace(/\/$/, "") === entry), `stamped gitignore missing ${entry}:\n${gi}`);
  }
  assert.ok(git(world.project, "ls-files", "--", ".factory/.gitignore"), "stamped gitignore must be committed");
});

test("migrate stamps a missing .factory/README.md and commits it — teammates get the contract in-repo", (t) => {
  const world = makeLegacyWorld(t);
  assert.equal(fs.existsSync(path.join(world.factoryDir, "README.md")), false, "legacy world starts without it");

  const r = runMigrate(world);

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const readme = fs.readFileSync(path.join(world.factoryDir, "README.md"), "utf8");
  assert.match(readme, /draft pull request/i, "stamped README carries the claim convention");
  assert.ok(git(world.project, "ls-files", "--", ".factory/README.md"), "stamped README must be committed");
});

test("migrate heals a partial .factory/.gitignore — owner lines kept, missing entries appended (PR-F)", (t) => {
  const world = makeLegacyWorld(t);
  fs.writeFileSync(path.join(world.factoryDir, ".gitignore"), "# owner comment\nowner-scratch/\n.env\nlog/\n");
  git(world.project, "add", "--", ".factory/.gitignore");
  git(world.project, "commit", "-q", "-m", "partial ignore file");
  git(world.project, "push", "-q", "origin", "main");

  const r = runMigrate(world);

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const gi = fs.readFileSync(path.join(world.factoryDir, ".gitignore"), "utf8");
  assert.match(gi, /owner comment/, "owner lines must survive the stamp");
  assert.match(gi, /owner-scratch/, "owner entries must survive the stamp");
  for (const entry of ["plan.json", "board.json", "STOP", "tmp"]) {
    assert.ok(gi.split("\n").some((l) => l.trim().replace(/\/$/, "") === entry), `healed gitignore missing ${entry}:\n${gi}`);
  }
  assert.ok(gi.split("\n").filter((l) => l.trim().replace(/\/$/, "") === "log").length >= 1, "log entry present");
});

test("migrate keeps an owner-modified skill copy (loudly) instead of destroying the edits", (t) => {
  const world = makeLegacyWorld(t);
  // Uncommitted owner customization of a factory-shipped skill: migrate must
  // not be the one command in the driver that destroys bytes.
  fs.appendFileSync(path.join(world.project, ".claude", "skills", "tdd", "SKILL.md"), "owner customization\n");

  const r = runMigrate(world);

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const kept = path.join(world.project, ".claude", "skills", "tdd", "SKILL.md");
  assert.ok(fs.existsSync(kept), "owner-modified skill was destroyed");
  assert.match(fs.readFileSync(kept, "utf8"), /owner customization/);
  assert.match(r.stdout, /kept/i);
  // Pristine factory copies still leave the repo.
  assert.equal(git(world.project, "ls-files", "--", ".claude/skills/backlog"), "");
});

test("migrate removes the v3 stamped driver and prompt copies (init --update's old job)", (t) => {
  const world = makeLegacyWorld(t);

  const r = runMigrate(world);

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  for (const rel of [".factory/driver.mjs", ".factory/prompts"]) {
    assert.equal(git(world.project, "ls-files", "--", rel), "", `${rel} still tracked`);
    assert.equal(fs.existsSync(path.join(world.project, rel)), false, `${rel} still on disk`);
  }
});

// --- config schema migration (moved here from init.mjs --update in P4:
// migrate is the standing schema verb for factories that predate a key) ---

const readMachineConfig = (world) =>
  JSON.parse(fs.readFileSync(path.join(world.stateDir, "config.json"), "utf8"));
const writeLegacyConfig = (world, cfg) =>
  fs.writeFileSync(path.join(world.factoryDir, "config.json"), JSON.stringify(cfg, null, 2) + "\n");

test("migrate heals missing safe schema keys — existing values kept", (t) => {
  const world = makeLegacyWorld(t); // fixture config lacks tracker, mirrors, model

  const r = runMigrate(world);

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const after = readMachineConfig(world);
  assert.equal(after.tracker, "github");
  assert.deepEqual(after.mirrors, []);
  assert.equal(after.model, "sonnet");
  // existing owner values are preserved, never overwritten
  assert.equal(after.windowHours, 4);
  assert.equal(after.schedule, "manual");
  assert.equal(after.enabled, false, "a declared-off factory must stay off");
  assert.doesNotMatch(r.stdout, /missing[^\n]*enabled/i, "no false alarm when enabled is declared");
});

test("migrate heals a missing triageModel from the factory's own model", (t) => {
  const world = makeLegacyWorld(t, { config: { model: "opus" } });

  const r = runMigrate(world);

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.equal(readMachineConfig(world).triageModel, "opus",
    "triageModel must inherit the factory's declared model, not the answerfile default");
});

test("migrate never invents `enabled` and warns loudly that it must be declared", (t) => {
  const world = makeLegacyWorld(t);
  writeLegacyConfig(world, { baseBranch: "main", schedule: "manual", autonomy: "pr-only", windowHours: 4 });

  const r = runMigrate(world);

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.equal("enabled" in readMachineConfig(world), false, "enabled must not be auto-added");
  assert.match(r.stdout, /missing[^\n]*enabled/i);
});

test("migrate heals a missing schedule key into the block form, from the answerfile", (t) => {
  const world = makeLegacyWorld(t);
  fs.writeFileSync(path.join(world.project, "factory.yaml"), [
    "stack: node", "schedule: systemd", "triageTime: 07:15",
    "devTime: 09:45", "reportTime: 14:00", "workDays: Mon-Sat",
  ].join("\n") + "\n");
  writeLegacyConfig(world, { enabled: false, baseBranch: "main", autonomy: "pr-only", windowHours: 4 });

  const r = runMigrate(world);

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.deepEqual(readMachineConfig(world).schedule, {
    kind: "systemd",
    modes: {
      triage: { time: "07:15", days: "Mon-Sat" },
      dev: { time: "09:45", days: "Mon-Sat" },
      report: { time: "14:00", days: "Mon-Sat" },
    },
  }, "schedule must heal from the answerfile's declared times before it leaves the repo");
});

test("migrate heals a missing stack from detection, never from the node default", (t) => {
  const world = makeLegacyWorld(t);
  // no stack anywhere: not in config, not in the answerfile, no stack markers
  fs.writeFileSync(path.join(world.project, "factory.yaml"), "baseBranch: main\n");

  const r = runMigrate(world);

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.equal(readMachineConfig(world).stack, "other",
    "stack must be healed from detection, not invented from the defaults");
});

test("a second migrate run heals schema drift on an already-migrated factory", (t) => {
  const world = makeLegacyWorld(t);
  assert.equal(runMigrate(world).code, 0);
  // a schema key added to the driver AFTER this factory migrated
  const cfg = readMachineConfig(world);
  delete cfg.tracker;
  fs.writeFileSync(path.join(world.stateDir, "config.json"), JSON.stringify(cfg, null, 2) + "\n");

  const r = runMigrate(world);

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.equal(readMachineConfig(world).tracker, "github", "migrate must stay the schema-heal verb after migration");
});

test("migrate refuses while a window lock is held by a live driver", (t) => {
  const world = makeLegacyWorld(t);
  fs.writeFileSync(path.join(world.factoryDir, "log", "window.lock"),
    JSON.stringify({ pid: process.pid, mode: "dev" }));

  const r = runMigrate(world);

  assert.equal(r.code, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stderr, /running|window/i);
  assert.ok(fs.existsSync(path.join(world.factoryDir, "config.json")), "nothing moved under a live window");
});
