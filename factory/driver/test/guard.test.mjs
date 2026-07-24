import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const guardPath = path.join(here, "..", "hooks", "guard.mjs");

// Run the guard the way claude runs a PreToolUse hook: event JSON on stdin,
// decision JSON (or nothing) on stdout.
const runGuard = ({ tool, input, cwd, env = {} }) => {
  const r = spawnSync(process.execPath, [guardPath], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, cwd }),
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, FACTORY_MODE: undefined, FACTORY_BASE_BRANCH: undefined, ...env },
  });
  assert.equal(r.status, 0, `guard exited ${r.status}: ${r.stderr}`);
  if (!r.stdout.trim()) return { decision: "allow" };
  const out = JSON.parse(r.stdout);
  return { decision: out.hookSpecificOutput?.permissionDecision ?? "allow", reason: out.hookSpecificOutput?.permissionDecisionReason ?? "" };
};

const makeRepo = (t, { branch = "main" } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "--initial-branch=main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "README.md"), "x\n");
  git("add", "-A");
  git("commit", "-m", "init");
  if (branch !== "main") git("checkout", "-b", branch);
  return dir;
};

const DEV = { FACTORY_MODE: "dev", FACTORY_BASE_BRANCH: "main" };
const TRIAGE = { FACTORY_MODE: "triage", FACTORY_BASE_BRANCH: "main" };

test("guard is a no-op without FACTORY_MODE (interactive sessions untouched)", (t) => {
  const cwd = makeRepo(t);
  const r = runGuard({ tool: "Write", input: { file_path: ".factory/prompts/dev-task.md", content: "x" }, cwd });
  assert.equal(r.decision, "allow");
});

test("dev session is denied editing deployed factory tooling", (t) => {
  const cwd = makeRepo(t);
  for (const p of [".factory/driver.mjs", ".factory/prompts/dev-task.md", ".factory/schedulers/x.service", ".factory/hooks/guard.mjs"]) {
    const r = runGuard({ tool: "Edit", input: { file_path: p }, cwd, env: DEV });
    assert.equal(r.decision, "deny", `${p} was not denied`);
    assert.match(r.reason, /tooling/);
  }
});

test("dev session is denied editing the backlog; triage session is allowed", (t) => {
  const cwd = makeRepo(t);
  const dev = runGuard({ tool: "Write", input: { file_path: ".factory/backlog/e1.md", content: "x" }, cwd, env: DEV });
  assert.equal(dev.decision, "deny");
  const triage = runGuard({ tool: "Write", input: { file_path: ".factory/backlog/e1.md", content: "x" }, cwd, env: TRIAGE });
  assert.equal(triage.decision, "allow");
});

test("grader session is denied editing the backlog — graders read and run, never write", (t) => {
  const cwd = makeRepo(t);
  const r = runGuard({ tool: "Write", input: { file_path: ".factory/backlog/e1.md", content: "x" }, cwd, env: { FACTORY_MODE: "grade", FACTORY_BASE_BRANCH: "main" } });
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /grade_verdict/);
});

test("a session cannot write machine-side factory state — the grades cache is not forgeable", (t) => {
  const cwd = makeRepo(t);
  // The merge gate reads its acceptance verdict from state.json under
  // ~/.factory/projects/<key>/log/; a session that could write there could
  // pre-seed a passing grade for its own PR. Both tool paths are denied.
  const state = `${process.env.HOME}/.factory/projects/proj-abc123/log/state.json`;
  const w = runGuard({ tool: "Write", input: { file_path: state, content: '{"grades":{}}' }, cwd, env: DEV });
  assert.equal(w.decision, "deny", "Write to machine state must be denied");
  assert.match(w.reason, /machine|projects|driver-owned/i);
  const b = runGuard({ tool: "Bash", input: { command: `printf '{}' >> ${state}` }, cwd, env: DEV });
  assert.equal(b.decision, "deny", "Bash write to machine state must be denied");
  // A grader session is under the same rule.
  const g = runGuard({ tool: "Write", input: { file_path: state, content: "x" }, cwd, env: { FACTORY_MODE: "grade", FACTORY_BASE_BRANCH: "main" } });
  assert.equal(g.decision, "deny");
});

test("ordinary project files stay editable in every mode", (t) => {
  const cwd = makeRepo(t);
  for (const env of [DEV, TRIAGE]) {
    const r = runGuard({ tool: "Write", input: { file_path: "src/app.js", content: "x" }, cwd, env });
    assert.equal(r.decision, "allow");
  }
});

test("sessions are denied gh pr merge (the driver's gate merges)", (t) => {
  const cwd = makeRepo(t);
  const r = runGuard({ tool: "Bash", input: { command: "gh pr merge 42 --merge" }, cwd, env: DEV });
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /merge gate|driver/);
});

test("dev session on the base branch is denied git commit/push", (t) => {
  const cwd = makeRepo(t, { branch: "main" });
  for (const cmd of ["git commit -m x", "git push origin main"]) {
    const r = runGuard({ tool: "Bash", input: { command: cmd }, cwd, env: DEV });
    assert.equal(r.decision, "deny", `\`${cmd}\` on base was not denied`);
  }
});

test("dev session on a task branch may commit and push its branch", (t) => {
  const cwd = makeRepo(t, { branch: "factory/t-001-thing" });
  for (const cmd of ["git commit -m x", "git push -u origin factory/t-001-thing"]) {
    const r = runGuard({ tool: "Bash", input: { command: cmd }, cwd, env: DEV });
    assert.equal(r.decision, "allow", `\`${cmd}\` on task branch was denied: ${r.reason}`);
  }
});

test("dev session on a task branch is still denied pushing to the base branch", (t) => {
  const cwd = makeRepo(t, { branch: "factory/t-001-thing" });
  const r = runGuard({ tool: "Bash", input: { command: "git push origin HEAD:main" }, cwd, env: DEV });
  assert.equal(r.decision, "deny");
});

test("triage/report sessions are denied git commit and push entirely", (t) => {
  const cwd = makeRepo(t, { branch: "main" });
  const r = runGuard({ tool: "Bash", input: { command: "git commit -m 'backlog update'" }, cwd, env: TRIAGE });
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /driver commits/);
});

test("dev session is denied git operations that name .factory metadata paths", (t) => {
  const cwd = makeRepo(t, { branch: "factory/t-001-thing" });
  const r = runGuard({ tool: "Bash", input: { command: "git add .factory/backlog/e1.md" }, cwd, env: DEV });
  assert.equal(r.decision, "deny");
});

test("sessions are denied mutating git on .claude paths (injected tooling never rides commits)", (t) => {
  const cwd = makeRepo(t, { branch: "factory/t-001-thing" });
  for (const cmd of [
    "git add .claude/settings.local.json",
    "git add -f .claude/skills/tdd/SKILL.md",
    "git rm -r .claude/agents",
    "git checkout -- .claude/settings.json",
  ]) {
    const r = runGuard({ tool: "Bash", input: { command: cmd }, cwd, env: DEV });
    assert.equal(r.decision, "deny", `\`${cmd}\` was not denied`);
  }
  // Reading .claude history stays fine — only mutation is policed.
  const ro = runGuard({ tool: "Bash", input: { command: "git log --oneline -- .claude" }, cwd, env: DEV });
  assert.equal(ro.decision, "allow", ro.reason);
});

test("read-only git on backlog history stays allowed (the report prompt uses it daily)", (t) => {
  const cwd = makeRepo(t, { branch: "main" });
  const REPORT = { FACTORY_MODE: "report", FACTORY_BASE_BRANCH: "main" };
  const r = runGuard({ tool: "Bash", input: { command: 'git log --since="8 hours ago" --oneline -- .factory/backlog' }, cwd, env: REPORT });
  assert.equal(r.decision, "allow", r.reason);
});

test("a commit message mentioning a push to base is not a push", (t) => {
  const cwd = makeRepo(t, { branch: "factory/t-002-docs" });
  const r = runGuard({ tool: "Bash", input: { command: 'git commit -m "docs: push setup for main environment"' }, cwd, env: DEV });
  assert.equal(r.decision, "allow", r.reason);
});
