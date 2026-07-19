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
  // (fleet incident 2026-07-09, NOTES item 44) no longer exists.
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
  // (fleet incident 2026-07-11 tracked both). Missing = drift migrate stamps;
  // only actually-tracked runtime state fails.
  fs.rmSync(path.join(world.factoryDir, ".gitignore"));
  gitIn(world.project, "rm", "-q", "--cached", ".factory/.gitignore");
  gitIn(world.project, "commit", "-q", "-m", "drop the ignore file");
  gitIn(world.project, "push", "-q", "origin", "main");

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /! \.factory\/\.gitignore — scaffold drift.*migrate/);
});

test("missing .factory/README.md is scaffold drift — warn (advisory), never fail (team affordances)", (t) => {
  const world = makeFactory(t);
  // Teammates without the skillset discover the contract through this file;
  // its absence is drift migrate stamps, never a window-blocking failure.
  fs.rmSync(path.join(world.factoryDir, "README.md"));
  gitIn(world.project, "rm", "-q", "--cached", ".factory/README.md");
  gitIn(world.project, "commit", "-q", "-m", "drop the contract file");
  gitIn(world.project, "push", "-q", "origin", "main");

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /! \.factory\/README\.md — scaffold drift.*migrate/);
});

test("doctor is green on .factory/README.md when the contract file is present", (t) => {
  const world = makeFactory(t);

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /✓ \.factory\/README\.md/);
});

test("tracked runtime state (.factory/log, plan.json) fails doctor — the tracked-runtime-state shape (PR-F)", (t) => {
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

// Real runtimes are clones — give the fixture an origin remote and point the
// expected-origin override at it so only the check under test can fail.
const setRuntimeOrigin = (world, runtime, origin = path.join(world.home, "claude-plugins.git")) => {
  gitIn(runtime, "remote", "add", "origin", origin);
  world.extraEnv = { ...(world.extraEnv ?? {}), FACTORY_RUNTIME_ORIGIN: origin };
  return origin;
};

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
  setRuntimeOrigin(world, runtime);
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
  setRuntimeOrigin(world, runtime);
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

// ---------- runtime origin (migration runbook Phase 0) ----------
// A runtime pointed at a wrong or retired remote fetches fine and deploys
// report "up to date" forever — this row is what turns a silently frozen
// machine into a loud one.

test("doctor is green on a runtime tracking the expected origin", (t) => {
  const world = makeFactory(t);
  const runtime = fakeRuntime(world);
  installPluginRecords(world, runtime, { skillset: "1.1.0", factory: "1.1.0" });

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /✓ runtime origin/);
});

test("a runtime tracking the wrong origin fails doctor with the set-url fix", (t) => {
  const world = makeFactory(t);
  const runtime = fakeRuntime(world);
  installPluginRecords(world, runtime, { skillset: "1.1.0", factory: "1.1.0" });
  gitIn(runtime, "remote", "set-url", "origin", path.join(world.home, "retired-mirror.git"));

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /✗ runtime origin — .*remote set-url/);
});

test("a runtime with no origin remote fails doctor — it can never advance", (t) => {
  const world = makeFactory(t);
  const runtime = fakeRuntime(world);
  installPluginRecords(world, runtime, { skillset: "1.1.0", factory: "1.1.0" });
  gitIn(runtime, "remote", "remove", "origin");

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /✗ runtime origin — no origin remote/);
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

test("doctor fails on a Windows host — factories run on macOS/Linux only", (t) => {
  const world = makeFactory(t);
  const shim = path.join(world.root, "win32-shim.mjs");
  fs.writeFileSync(shim, `Object.defineProperty(process, "platform", { value: "win32" });\n`);

  const r = runDriver(world, "doctor", [], { nodeArgs: ["--import", shim] });

  assert.notEqual(r.code, 0, `doctor must fail on win32\nstdout:\n${r.stdout}`);
  assert.match(r.stdout, /✗ host platform.*not a supported factory host/i);
});

test("a legacy schtasks schedule declaration fails doctor — the kind is retired", (t) => {
  const world = makeFactory(t, { config: { schedule: "schtasks" } });

  const r = runDriver(world, "doctor");

  assert.notEqual(r.code, 0, `stdout:\n${r.stdout}`);
  assert.match(r.stdout, /"schtasks" is not one of/);
  assert.doesNotMatch(r.stdout, /systemd\|cron\|launchd\|schtasks/, "schtasks must be gone from the offered kinds");
});

// Milestone heading drift (2026-07-19): the index format was never written
// down, three dialects grew, and both consumers (promote, dashboard) read
// only one — silently. The parser now tolerates the known dialects; this row
// is what catches the next one.
test("an unreadable milestone heading dialect warns, naming the canonical shape", (t) => {
  const world = makeFactory(t);
  fs.writeFileSync(path.join(world.factoryDir, "backlog", "index.md"),
    "# Backlog\n\n## Phase 1: Foundations — active\n## Sprint 2 — not-started\n");

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 0, "unreadable headings are a warning, not a window-blocking failure");
  assert.match(r.stdout, /! milestone headings/);
  assert.match(r.stdout, /## M<n>: <title> — <status>/, "the warn must name the canonical shape");
});

test("the dialects real factories use all doctor green, active milestone named", (t) => {
  const world = makeFactory(t);
  fs.writeFileSync(path.join(world.factoryDir, "backlog", "index.md"),
    "## Milestones\n\n### M1: Login — active\n\n## Milestone 2 — Phase 1 (not-started)\n\n## M3 Ship — done\n");

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 0, `stdout:\n${r.stdout}`);
  assert.match(r.stdout, /✓ milestone headings — 3 parse clean \(active: M1\)/);
});

test("a backlog that declares no milestones skips the check — milestone-free is legal", (t) => {
  const world = makeFactory(t);
  fs.writeFileSync(path.join(world.factoryDir, "backlog", "index.md"),
    "# Backlog\n\nEpics only, no milestones.\n- [e1-a](e1-a.md) — 2 tasks\n");

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 0);
  assert.match(r.stdout, /– milestone headings/);
});

// The first-live-pilot hole (2026-07-19): a repo whose issue tracker is switched
// off answers every OTHER forge call normally, so the whole preflight stayed
// green while three needs-human questions queued into the void for a full
// window. Doctor must SAY so — but only warn, never fail: doctor is the
// scheduled preflight, and that same pilot window shipped T-001 with its
// tracker off. Killing the window would have cost the work to protect the
// questions. Visibility for the queue itself lives in the driver, which
// announces the stranded count on every session end (mcp-server.test.mjs).
test("a native tracker whose issues are DISABLED warns doctor without failing the window", (t) => {
  const world = makeFactory(t);
  const ghDir = path.join(world.root, "gh-off");
  fs.mkdirSync(ghDir);
  fs.writeFileSync(path.join(ghDir, "gh"), `#!/bin/sh
if [ "$1 $2" = "issue list" ]; then echo "GraphQL: Issues are disabled for this repository" >&2; exit 1; fi
echo ""
exit 0
`);
  fs.chmodSync(path.join(ghDir, "gh"), 0o755);
  fs.appendFileSync(path.join(world.stateDir, ".env"), `STUB_GH_DIR=${ghDir}\n`);

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 0, `a closed question mailbox must not abort the window:\n${r.stdout}`);
  assert.match(r.stdout, /! github issue tracker/);
  assert.match(r.stdout, /"tracker": "jira"/, "the row must name the way out");
});

test("a healthy native tracker is one green doctor row", (t) => {
  const world = makeFactory(t);
  const r = runDriver(world, "doctor");
  assert.equal(r.code, 0, `stdout:\n${r.stdout}`);
  assert.match(r.stdout, /✓ github issue tracker/);
});
