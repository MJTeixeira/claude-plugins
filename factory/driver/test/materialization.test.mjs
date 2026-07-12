// Worktree materialization (machine-product refactor P2, slimmed by G3): the
// driver injects .claude/settings.local.json (allowlist + guard hook wired to
// the runtime by absolute path) into every session and meta worktree at
// spawn/refresh. Skills and agents are NOT copied anymore — sessions get them
// from the machine-installed code4food plugins (provisioned from the runtime
// clone; see deploy-runtime). Injected paths are excluded from git via a
// managed block in the repo's SHARED .git/info/exclude (git resolves
// info/exclude to the common dir; per-worktree exclude files are ignored),
// so they never ride commits or quarantines.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { makeFactory, queueSessions, runDriver, gitIn } from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// The runtime in tests IS this repo checkout — the driver under test lives in it.
const runtimeGuard = path.join(here, "..", "hooks", "guard.mjs");

const REPORT = (obj) =>
  `mkdir -p .factory/log && echo '${JSON.stringify(obj)}' > .factory/log/last-session.json`;
const RESULT_OK = JSON.stringify({ type: "result", subtype: "success", result: "ok", total_cost_usd: 0.01, num_turns: 2, usage: { input_tokens: 1, output_tokens: 2 } }) + "\n";

const readSeen = (world, name) => {
  const p = path.join(world.stubDir, name);
  assert.ok(fs.existsSync(p), `session never captured ${name} — injection missing?`);
  return fs.readFileSync(p, "utf8");
};

test("session worktrees get settings.local.json: allowlist presets + guard wired to the runtime by absolute path", (t) => {
  const world = makeFactory(t, { config: { stack: "node" } });
  queueSessions(world, [{
    script: `cp .claude/settings.local.json "$STUB_DIR/seen-settings.json" &&
(ls .claude/skills 2>/dev/null || echo ABSENT) > "$STUB_DIR/seen-skills.txt" &&
(ls .claude/agents 2>/dev/null || echo ABSENT) > "$STUB_DIR/seen-agents.txt" &&
${REPORT({ taskId: null, status: "no-tasks", summary: "none" })}`,
    stdout: RESULT_OK,
    exit: 0,
  }]);

  const r = runDriver(world, "dev");
  assert.equal(r.code, 0, `driver exited ${r.code}\n${r.stdout}\n${r.stderr}`);

  const settings = JSON.parse(readSeen(world, "seen-settings.json"));
  const allow = settings.permissions?.allow ?? [];
  assert.ok(allow.includes("mcp__factory"), `allowlist missing mcp__factory: ${allow}`);
  assert.ok(allow.includes("Bash(npm:*)"), `config stack "node" preset not applied: ${allow}`);
  assert.ok(allow.includes("Bash(git:*)"), `base allowlist not applied: ${allow}`);
  // PR-F: top deny offenders from the 2026-07 session-log audit joined the
  // base preset — a session must be able to inspect, move files, and fetch
  // assets without burning turns on denials.
  for (const rule of ["Bash(find:*)", "Bash(curl:*)", "Bash(unzip:*)", "Bash(cd:*)", "Bash(cp:*)", "Bash(sed:*)"]) {
    assert.ok(allow.includes(rule), `audited base rule ${rule} missing: ${allow}`);
  }
  const guardEntry = (settings.hooks?.PreToolUse ?? []).find((e) =>
    (e.hooks ?? []).some((h) => String(h.command ?? "").includes("guard.mjs")));
  assert.ok(guardEntry, `no guard hook in injected settings: ${JSON.stringify(settings.hooks)}`);
  assert.match(guardEntry.matcher, /Bash/);
  const cmd = guardEntry.hooks[0].command;
  assert.ok(cmd.includes(runtimeGuard), `guard not wired to the runtime by absolute path: ${cmd}`);
  assert.ok(fs.existsSync(runtimeGuard), "runtime guard file itself is missing");

  // G3: skills and agents come from the machine-installed plugins, never
  // from worktree copies — a copy would shadow/duplicate the plugin versions.
  assert.equal(readSeen(world, "seen-skills.txt").trim(), "ABSENT",
    "skills were copied into the worktree — plugins provide them now");
  assert.equal(readSeen(world, "seen-agents.txt").trim(), "ABSENT",
    "agents were copied into the worktree — plugins provide them now");
});

test("a Unity project marker injects the unity engine allowlist (skills come from plugins)", (t) => {
  const world = makeFactory(t, { config: { stack: "dotnet" } });
  // detectEngines keys off ProjectSettings/ProjectVersion.txt (Unity) —
  // must be committed so the worktree, cloned from origin, carries it.
  fs.mkdirSync(path.join(world.project, "ProjectSettings"));
  fs.writeFileSync(
    path.join(world.project, "ProjectSettings", "ProjectVersion.txt"),
    "m_EditorVersion: 6000.4.11f1\n"
  );
  gitIn(world.project, "add", "-A");
  gitIn(world.project, "commit", "-m", "unity project marker");
  gitIn(world.project, "push", "origin", "main");

  queueSessions(world, [{
    script: `cp .claude/settings.local.json "$STUB_DIR/seen-settings.json" &&
${REPORT({ taskId: null, status: "no-tasks", summary: "none" })}`,
    stdout: RESULT_OK,
    exit: 0,
  }]);

  const r = runDriver(world, "dev");
  assert.equal(r.code, 0, `driver exited ${r.code}\n${r.stdout}\n${r.stderr}`);

  const allow = JSON.parse(readSeen(world, "seen-settings.json")).permissions?.allow ?? [];
  assert.ok(allow.includes("Bash(unity:*)"), `unity engine preset not injected on a Unity project: ${allow}`);
});

test("injected tooling is invisible to git and never rides session commits", (t) => {
  const world = makeFactory(t);
  queueSessions(world, [{
    // `test -f` first: this test only proves anything if injection happened.
    script: `test -f .claude/settings.local.json &&
git checkout -b factory/t-001 &&
echo "the feature" > feature.txt &&
git add -A &&
git status --porcelain > "$STUB_DIR/seen-status.txt" &&
git commit -q -m "T-001: add feature" &&
git push -q -u origin factory/t-001 &&
${REPORT({ taskId: "T-001", status: "review", summary: "built", pr: "https://github.com/o/r/pull/9" })}`,
    stdout: RESULT_OK,
    exit: 0,
  }]);

  const r = runDriver(world, "dev");
  assert.equal(r.code, 0, `driver exited ${r.code}\n${r.stdout}\n${r.stderr}`);

  // `git add -A` inside the session staged the work, not the injected tooling.
  const staged = readSeen(world, "seen-status.txt");
  assert.match(staged, /feature\.txt/);
  assert.doesNotMatch(staged, /\.claude\/settings\.local\.json|\.claude\/skills|\.claude\/agents/,
    "injected tooling visible to git inside the session worktree");

  const tree = gitIn(world.origin, "ls-tree", "-r", "--name-only", "factory/t-001");
  assert.match(tree, /feature\.txt/);
  assert.doesNotMatch(tree, /settings\.local\.json|\.claude\/skills|\.claude\/agents/,
    `injected tooling rode the session commit:\n${tree}`);
});

test("repo-tracked skill copies are left alone and nothing is injected beside them", (t) => {
  const world = makeFactory(t);
  // Transition shape: the repo still carries a committed copy of a skill.
  const tracked = path.join(world.project, ".claude", "skills", "tdd");
  fs.mkdirSync(tracked, { recursive: true });
  fs.writeFileSync(path.join(tracked, "SKILL.md"), "OWNER COPY\n");
  gitIn(world.project, "add", "-A");
  gitIn(world.project, "commit", "-q", "-m", "tracked skill copy");
  gitIn(world.project, "push", "-q", "origin", "main");

  queueSessions(world, [{
    script: `cat .claude/skills/tdd/SKILL.md > "$STUB_DIR/seen-tdd.md" &&
ls .claude/skills > "$STUB_DIR/seen-skills.txt" &&
${REPORT({ taskId: null, status: "no-tasks", summary: "none" })}`,
    stdout: RESULT_OK,
    exit: 0,
  }]);

  const r = runDriver(world, "dev");
  assert.equal(r.code, 0, `driver exited ${r.code}\n${r.stdout}\n${r.stderr}`);

  assert.equal(readSeen(world, "seen-tdd.md"), "OWNER COPY\n",
    "materialization touched a repo-tracked skill copy");
  assert.equal(readSeen(world, "seen-skills.txt").trim(), "tdd",
    "materialization injected skills beside the tracked copy");
});

// A repo that TRACKS an injected path (someone committed settings.local.json)
// is the one case where materialization dirties tracked content — the
// quarantine machinery must treat that dirt as runtime property, not as a
// session's lost work.
const commitTrackedLocalSettings = (world) => {
  const p = path.join(world.project, ".claude", "settings.local.json");
  fs.writeFileSync(p, JSON.stringify({ owner: true }) + "\n");
  gitIn(world.project, "add", "-f", "--", ".claude/settings.local.json");
  gitIn(world.project, "commit", "-q", "-m", "tracked local settings");
  gitIn(world.project, "push", "-q", "origin", "main");
};

test("injected-only dirt never triggers a quarantine at worktree removal", (t) => {
  const world = makeFactory(t);
  commitTrackedLocalSettings(world);
  queueSessions(world, [{
    script: REPORT({ taskId: null, status: "no-tasks", summary: "none" }),
    stdout: RESULT_OK,
    exit: 0,
  }]);

  const r = runDriver(world, "dev");
  assert.equal(r.code, 0, `driver exited ${r.code}\n${r.stdout}\n${r.stderr}`);

  const logDir = path.join(world.stateDir, "log");
  assert.ok(!fs.readdirSync(logDir).some((f) => f.startsWith("quarantine-")),
    "injected tooling was quarantined as if it were session work");
  assert.doesNotMatch(r.stdout, /dirty worktree/);
});

test("quarantine of a genuinely dirty worktree carries the work, not the injected tooling", (t) => {
  const world = makeFactory(t, { config: { maxSessionsPerWindow: 1 } });
  commitTrackedLocalSettings(world);
  queueSessions(world, [{
    script: `mkdir -p src && echo "half-finished feature" > src/wip.txt`,
    stdout: JSON.stringify({ type: "result", subtype: "error_max_turns", total_cost_usd: 0.03, num_turns: 4, usage: { input_tokens: 1, output_tokens: 2 } }) + "\n",
    exit: 1,
  }]);

  const r = runDriver(world, "dev");
  assert.equal(r.code, 0, `driver exited ${r.code}\n${r.stdout}\n${r.stderr}`);

  const logDir = path.join(world.stateDir, "log");
  const qdirs = fs.readdirSync(logDir).filter((f) => f.startsWith("quarantine-"));
  const saved = qdirs.find((d) => fs.existsSync(path.join(logDir, d, "src", "wip.txt")));
  assert.ok(saved, `wip.txt not saved in any quarantine dir (${qdirs.join(", ")})\n${r.stdout}`);
  assert.ok(!qdirs.some((d) => fs.existsSync(path.join(logDir, d, ".claude", "settings.local.json"))),
    "injected settings.local.json rode the quarantine");
});

test("a tracked settings.local.json never leaks machine settings through session commits", (t) => {
  const world = makeFactory(t);
  commitTrackedLocalSettings(world);
  queueSessions(world, [{
    script: `test -f .claude/settings.local.json &&
git checkout -b factory/t-002 &&
echo "work" > work.txt &&
git add -A &&
git commit -q -m "T-002: work" &&
git push -q -u origin factory/t-002 &&
${REPORT({ taskId: "T-002", status: "review", summary: "built", pr: "https://github.com/o/r/pull/10" })}`,
    stdout: RESULT_OK,
    exit: 0,
  }]);

  const r = runDriver(world, "dev");
  assert.equal(r.code, 0, `driver exited ${r.code}\n${r.stdout}\n${r.stderr}`);

  const tree = gitIn(world.origin, "ls-tree", "-r", "--name-only", "factory/t-002");
  assert.match(tree, /work\.txt/, "the session's actual work must ride the commit");
  const pushed = gitIn(world.origin, "show", "factory/t-002:.claude/settings.local.json");
  assert.equal(pushed.trim(), JSON.stringify({ owner: true }),
    "machine-injected settings (with absolute runtime paths) leaked into a pushed commit");
});

test("meta worktree is materialized for triage; metadata commits carry no injected tooling", (t) => {
  const world = makeFactory(t);
  queueSessions(world, [{
    // Triage runs in the persistent meta worktree: it edits work data
    // (driver commits it) and must see the same injected tooling as sessions.
    script: `cp .claude/settings.local.json "$STUB_DIR/seen-settings.json" &&
(ls .claude/skills 2>/dev/null || echo ABSENT) > "$STUB_DIR/seen-skills.txt" &&
echo "- triage note" >> .factory/backlog/index.md`,
    stdout: RESULT_OK,
    exit: 0,
  }]);

  const r = runDriver(world, "triage");
  assert.equal(r.code, 0, `driver exited ${r.code}\n${r.stdout}\n${r.stderr}`);

  const settings = JSON.parse(readSeen(world, "seen-settings.json"));
  assert.ok((settings.permissions?.allow ?? []).includes("mcp__factory"), "meta worktree has no injected allowlist");
  assert.equal(readSeen(world, "seen-skills.txt").trim(), "ABSENT",
    "skills were copied into the meta worktree — plugins provide them now");

  // The triage edit was committed and pushed — without the injected tooling.
  assert.match(gitIn(world.origin, "log", "--format=%s", "main"), /triage: backlog update/);
  const tree = gitIn(world.origin, "ls-tree", "-r", "--name-only", "main");
  assert.match(tree, /\.factory\/backlog\/index\.md/);
  assert.doesNotMatch(tree, /settings\.local\.json|\.claude\/skills/,
    `injected tooling rode the metadata commit:\n${tree}`);
});

test("pre-G3 injected copies in a persistent worktree are scrubbed at the next materialization", (t) => {
  const world = makeFactory(t);
  // First triage creates the persistent meta worktree.
  queueSessions(world, [
    { script: `echo "- note" >> .factory/backlog/index.md`, stdout: RESULT_OK, exit: 0 },
    { script: `(ls .claude/skills 2>/dev/null || echo ABSENT) > "$STUB_DIR/seen-skills.txt" &&
(ls .claude/agents 2>/dev/null || echo ABSENT) > "$STUB_DIR/seen-agents.txt" &&
echo "- note2" >> .factory/backlog/index.md`, stdout: RESULT_OK, exit: 0 },
  ]);
  let r = runDriver(world, "triage");
  assert.equal(r.code, 0, `driver exited ${r.code}\n${r.stdout}\n${r.stderr}`);

  // Plant the pre-G3 shape into the surviving meta worktree: untracked
  // injected skill + agent copies, exactly what the old driver left behind.
  const worktrees = path.join(world.home, ".factory", "worktrees");
  const key = fs.readdirSync(worktrees)[0];
  const meta = path.join(worktrees, key, "meta");
  assert.ok(fs.existsSync(meta), `meta worktree missing under ${worktrees}`);
  fs.mkdirSync(path.join(meta, ".claude", "skills", "backlog"), { recursive: true });
  fs.writeFileSync(path.join(meta, ".claude", "skills", "backlog", "SKILL.md"), "stale pre-G3 copy\n");
  fs.mkdirSync(path.join(meta, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(path.join(meta, ".claude", "agents", "code-reviewer.md"), "stale agent copy\n");

  r = runDriver(world, "triage");
  assert.equal(r.code, 0, `driver exited ${r.code}\n${r.stdout}\n${r.stderr}`);

  assert.equal(readSeen(world, "seen-skills.txt").trim(), "ABSENT",
    "stale pre-G3 skill copies survived materialization in the persistent worktree");
  assert.equal(readSeen(world, "seen-agents.txt").trim(), "ABSENT",
    "stale pre-G3 agent copy survived materialization in the persistent worktree");
});
