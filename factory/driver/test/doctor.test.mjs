import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeFactory, runDriver, gitIn } from "./helpers.mjs";

test("doctor stays green with no .claude in git — session tooling is injected, not committed (P2)", (t) => {
  const world = makeFactory(t);
  // The post-migration shape: nothing under .claude tracked. Sessions get
  // allowlist + guard injected into their worktrees from the runtime, so
  // the old "untracked allowlist strands worktree sessions" failure
  // (witchhat 2026-07-09, NOTES item 44) no longer exists.
  fs.writeFileSync(path.join(world.project, ".gitignore"), ".claude/\n");
  gitIn(world.project, "rm", "-r", "-q", "--cached", ".claude");
  gitIn(world.project, "add", ".gitignore");
  gitIn(world.project, "commit", "-q", "-m", "ignore .claude");
  gitIn(world.project, "push", "-q", "origin", "main");

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /✓ scaffold committed/);
});

test("doctor(dontAsk) is green with no settings.json at all — the allowlist is injected at session spawn", (t) => {
  const world = makeFactory(t, { config: { permissionMode: "dontAsk" } });
  // Post-migrate shape when the settings file was entirely factory-owned:
  // migrate removed it outright. Scheduled preflights run this same doctor —
  // a fail here would abort every timer-fired window on a migrated factory.
  fs.rmSync(path.join(world.project, ".claude"), { recursive: true });
  gitIn(world.project, "rm", "-r", "-q", "--cached", ".claude");
  gitIn(world.project, "commit", "-q", "-m", "migrated: settings leave the repo");
  gitIn(world.project, "push", "-q", "origin", "main");

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /✓ allowlist.*injected/i);
});

test("missing .factory/.gitignore is scaffold drift — warn (advisory), never fail (PR-F)", (t) => {
  const world = makeFactory(t);
  // The meta worktree carries a log symlink and plan.json next to the work
  // data, so the ignore file IS scaffold even with all state machine-side
  // (modelwars 2026-07-11 tracked both). Missing = drift migrate stamps;
  // only actually-tracked runtime state fails.
  fs.rmSync(path.join(world.factoryDir, ".gitignore"));
  gitIn(world.project, "rm", "-q", "--cached", ".factory/.gitignore");
  gitIn(world.project, "commit", "-q", "-m", "drop the ignore file");
  gitIn(world.project, "push", "-q", "origin", "main");

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /! \.factory\/\.gitignore — scaffold drift.*migrate/);
});

test("tracked runtime state (.factory/log, plan.json) fails doctor — the modelwars shape (PR-F)", (t) => {
  const world = makeFactory(t);
  fs.rmSync(path.join(world.factoryDir, ".gitignore"));
  gitIn(world.project, "rm", "-q", "--cached", ".factory/.gitignore");
  fs.mkdirSync(path.join(world.factoryDir, "log"), { recursive: true });
  fs.writeFileSync(path.join(world.factoryDir, "log", "factory-2026-07-11.log"), "runtime log\n");
  fs.writeFileSync(path.join(world.factoryDir, "plan.json"), JSON.stringify({ generatedAt: "2026-07-11T00:00:00Z", queue: [] }) + "\n");
  gitIn(world.project, "add", "-A", ".factory");
  gitIn(world.project, "commit", "-q", "-m", "accidentally track runtime state");
  gitIn(world.project, "push", "-q", "origin", "main");

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /✗ runtime state in git — .*\.factory\/log.*migrate/);
});

test("doctor fails when repo-side legacy state exists and is not ignored", (t) => {
  const world = makeFactory(t);
  fs.rmSync(path.join(world.factoryDir, ".gitignore"));
  gitIn(world.project, "rm", "-q", "--cached", ".factory/.gitignore");
  gitIn(world.project, "commit", "-q", "-m", "drop ignore file");
  gitIn(world.project, "push", "-q", "origin", "main");
  // A pre-migration leftover: secrets on disk with nothing keeping them out
  // of git — one `git add -A` away from a leaked token.
  fs.writeFileSync(path.join(world.factoryDir, ".env"), "GH_TOKEN=leftover\n");

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /✗ \.factory\/\.gitignore/);
});

test("doctor still fails when the backlog index is not tracked (work data must ride the repo)", (t) => {
  const world = makeFactory(t);
  gitIn(world.project, "rm", "-q", "--cached", ".factory/backlog/index.md");
  gitIn(world.project, "commit", "-q", "-m", "untrack backlog index");
  gitIn(world.project, "push", "-q", "origin", "main");

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /✗ scaffold committed — .*\.factory\/backlog\/index\.md/);
});

// ---------- O6 machine runtime (NOTES item 46) ----------

test("doctor passes when the project carries no .factory/prompts/ — prompts ship with the runtime", (t) => {
  const world = makeFactory(t); // fixture carries no prompts, like a migrated project

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /✓ \.factory scaffold/);
});

test("doctor fails when a scheduler file references the legacy per-project driver", (t) => {
  const world = makeFactory(t);
  const sdir = path.join(world.factoryDir, "schedulers");
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, "project-factory@.service"),
    `[Service]\nExecStart=/usr/bin/env node ${world.project}/.factory/driver.mjs %i --project ${world.project} --scheduled\n`);

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /✗ .*legacy .*driver/i);
});

test("a stray untracked .factory/hooks/guard.mjs no longer fails doctor — the guard runs from the runtime", (t) => {
  const world = makeFactory(t);
  const guard = path.join(world.factoryDir, "hooks", "guard.mjs");
  fs.mkdirSync(path.dirname(guard), { recursive: true });
  fs.writeFileSync(guard, "// legacy guard copy\n");

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
});

test("legacy .factory/driver.mjs copy warns but does not fail", (t) => {
  const world = makeFactory(t);
  fs.writeFileSync(path.join(world.factoryDir, "driver.mjs"), "// stale v3 copy\n");

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /! .*legacy .*driver copy/i);
});

test("doctor skips runtime checks when no machine runtime is installed", (t) => {
  const world = makeFactory(t);
  const r = runDriver(world, "doctor");
  assert.match(r.stdout, /– machine runtime/, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
});

// ---------- schedule declaration and drift (P3) ----------

const stubSystemctl = (world) => {
  const p = path.join(world.root, "bin", "systemctl");
  fs.writeFileSync(p, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(p, 0o755);
};

const SYSTEMD_BLOCK = {
  kind: "systemd",
  modes: {
    triage: { time: "08:30", days: "Mon-Fri" },
    dev: { time: "09:00", days: "Mon-Fri" },
    report: { time: "13:30", days: "Mon-Fri" },
  },
};

test("doctor accepts the block form of the schedule declaration (manual)", (t) => {
  const world = makeFactory(t, { config: { schedule: { kind: "manual" } } });

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /✓ schedule: manual/);
});

test("doctor verifies installed units against a full declaration — green when they match", (t) => {
  const world = makeFactory(t, { config: { schedule: SYSTEMD_BLOCK } });
  stubSystemctl(world);
  assert.equal(runDriver(world, "schedule", ["--install", "--yes"]).code, 0);

  const r = runDriver(world, "doctor");

  assert.match(r.stdout, /✓ schedule: systemd/, `stdout:\n${r.stdout}`);
  assert.match(r.stdout, /✓ schedule matches declaration/, `stdout:\n${r.stdout}`);
});

test("doctor fails on semantic drift: an installed timer firing at a different time", (t) => {
  const world = makeFactory(t, { config: { schedule: SYSTEMD_BLOCK } });
  stubSystemctl(world);
  assert.equal(runDriver(world, "schedule", ["--install", "--yes"]).code, 0);
  const timer = path.join(world.home, ".config", "systemd", "user", "project-dev.timer");
  fs.writeFileSync(timer, fs.readFileSync(timer, "utf8").replace("09:00", "10:15"));

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /✗ schedule matches declaration — .*dev.*10:15.*09:00/, `stdout:\n${r.stdout}`);
});

test("doctor only warns on a kind-only declaration with installed units — adopt imports them", (t) => {
  const world = makeFactory(t, { config: { schedule: "systemd" } }); // legacy string form
  const ud = path.join(world.home, ".config", "systemd", "user");
  fs.mkdirSync(ud, { recursive: true });
  // PATH must resolve claude+gh (check 2 verifies it wherever units exist)
  fs.writeFileSync(path.join(ud, "project-factory@.service"),
    `[Service]\nEnvironment=PATH=${path.join(world.root, "bin")}:/usr/bin:/bin\nExecStart=/usr/bin/node ${path.join(world.home, ".factory", "runtime", "factory", "driver", "factory.mjs")} %i --project ${world.project} --scheduled\n`);
  fs.writeFileSync(path.join(ud, "project-dev.timer"),
    "[Timer]\nOnCalendar=Mon..Fri 09:00\nUnit=project-factory@dev.service\n");

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 0, `the un-adopted fleet must stay deployable:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /! schedule matches declaration — .*adopt/i, `stdout:\n${r.stdout}`);
});

test("doctor fails on a dirty machine runtime tree", (t) => {
  const world = makeFactory(t);
  const runtime = path.join(world.home, ".factory", "runtime");
  fs.mkdirSync(runtime, { recursive: true });
  gitIn(world.root, "init", "-b", "main", runtime);
  gitIn(runtime, "config", "user.email", "t@example.com");
  gitIn(runtime, "config", "user.name", "t");
  fs.writeFileSync(path.join(runtime, "seed.txt"), "committed\n");
  gitIn(runtime, "add", "-A");
  gitIn(runtime, "commit", "-q", "-m", "seed");
  fs.writeFileSync(path.join(runtime, "local-edit.txt"), "dirty\n");

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /✗ machine runtime — .*dirty/i);
});

// ---------- code4food plugins (G3) ----------
// Sessions load skills from the machine-installed plugins, provisioned from
// the runtime clone. Doctor fails on a machine whose plugins are missing or
// version-drifted from the runtime — sessions there run stale (or no) skills.
const fakeRuntime = (world, versions = { skillset: "1.1.0", factory: "1.1.0" }) => {
  const runtime = path.join(world.home, ".factory", "runtime");
  fs.mkdirSync(path.join(runtime, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(runtime, "factory", ".claude-plugin"), { recursive: true });
  gitIn(runtime, "init", "-b", "main");
  fs.writeFileSync(path.join(runtime, ".claude-plugin", "marketplace.json"),
    JSON.stringify({ name: "code4food", plugins: [] }) + "\n");
  fs.writeFileSync(path.join(runtime, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "code4food-skillset", version: versions.skillset }) + "\n");
  fs.writeFileSync(path.join(runtime, "factory", ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "code4food-factory", version: versions.factory }) + "\n");
  gitIn(runtime, "add", "-A");
  gitIn(runtime, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "runtime");
  return runtime;
};

const installPluginRecords = (world, runtime, versions) => {
  const dir = path.join(world.home, ".claude", "plugins");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "known_marketplaces.json"), JSON.stringify({
    code4food: { source: { source: "directory", path: runtime }, installLocation: runtime },
  }) + "\n");
  fs.writeFileSync(path.join(dir, "installed_plugins.json"), JSON.stringify({
    plugins: {
      "code4food-skillset@code4food": [{ scope: "user", version: versions.skillset }],
      "code4food-factory@code4food": [{ scope: "user", version: versions.factory }],
    },
  }) + "\n");
};

test("doctor is green when installed plugins match the runtime versions", (t) => {
  const world = makeFactory(t);
  const runtime = fakeRuntime(world);
  installPluginRecords(world, runtime, { skillset: "1.1.0", factory: "1.1.0" });

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /✓ plugin code4food-skillset/);
  assert.match(r.stdout, /✓ plugin code4food-factory/);
});

test("plugin version drift from the runtime fails doctor with the deploy hint", (t) => {
  const world = makeFactory(t);
  const runtime = fakeRuntime(world, { skillset: "1.2.0", factory: "1.1.0" });
  installPluginRecords(world, runtime, { skillset: "1.0.0", factory: "1.1.0" });

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /✗ plugin code4food-skillset — installed 1\.0\.0.*1\.2\.0.*deploy-runtime/);
  assert.match(r.stdout, /✓ plugin code4food-factory/);
});

test("unprovisioned plugins on a runtime machine fail doctor with the manual provisioning hint", (t) => {
  const world = makeFactory(t);
  fakeRuntime(world);

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /✗ code4food plugins — .*claude plugin marketplace add/);
});

test("a marketplace pointing anywhere but the runtime fails doctor", (t) => {
  const world = makeFactory(t);
  const runtime = fakeRuntime(world);
  installPluginRecords(world, path.join(world.home, "somewhere-else"), { skillset: "1.1.0", factory: "1.1.0" });

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /✗ code4food plugins — marketplace points at/);
});

test("no machine runtime → plugin check skips (dev-checkout run)", (t) => {
  const world = makeFactory(t);

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /– code4food plugins/);
});

// ---------- jira tracker (cfg.tracker: "jira") ----------

test("tracker jira without JIRA_* env keys fails doctor, naming the keys", (t) => {
  const world = makeFactory(t, { config: { tracker: "jira", jiraProject: "FACT" } });

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /JIRA_BASE_URL/);
  assert.match(r.stdout, /JIRA_EMAIL/);
  assert.match(r.stdout, /JIRA_API_TOKEN/);
});

test("tracker jira with keys probes Jira auth and reports the account", (t) => {
  const world = makeFactory(t, { config: { tracker: "jira", jiraProject: "FACT" } });
  fs.writeFileSync(path.join(world.root, "bin", "curl"), `#!/bin/sh
for a in "$@"; do url="$a"; done
case "$url" in
  *"/rest/api/3/myself"*) cat > /dev/null; echo '{"displayName": "Marcos T"}' ;;
  *) cat > /dev/null; echo '{}' ;;
esac
exit 0
`);
  fs.chmodSync(path.join(world.root, "bin", "curl"), 0o755);
  fs.appendFileSync(path.join(world.stateDir, ".env"),
    "JIRA_BASE_URL=https://acme.atlassian.net\nJIRA_EMAIL=m@example.com\nJIRA_API_TOKEN=tok\n");

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /✓ jira auth.*Marcos T/);
});
