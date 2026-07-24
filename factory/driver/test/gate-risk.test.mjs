// Risk tiers (autonomy epic chunk 2): a PR touching a configured high-risk
// path prefix (config `riskTiers.high`) never auto-merges — it parks for
// owner review exactly like `Gate: human`, and the owner's own merge flips
// the task done. Question-parked tasks keep their contract: a merge does
// not answer an open question.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeFactory, queueSessions, runDriver, gitIn } from "./helpers.mjs";

const RESULT = {
  type: "result", subtype: "success", result: "done",
  total_cost_usd: 0.02, num_turns: 5, usage: { input_tokens: 10, output_tokens: 20 },
};

const report = (obj) =>
  `mkdir -p .factory/log && printf '%s' '${JSON.stringify(obj)}' > .factory/log/last-session.json`;

const installGateGh = (world, { prList = [], prView = null } = {}) => {
  const ghDir = path.join(world.root, "stub-gh");
  fs.mkdirSync(ghDir, { recursive: true });
  fs.writeFileSync(path.join(ghDir, "pr-list.json"), JSON.stringify(prList));
  fs.writeFileSync(path.join(ghDir, "pr-view.json"), prView ? JSON.stringify(prView) : "{}");
  fs.writeFileSync(
    path.join(ghDir, "gh"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "${ghDir}/calls.log"
case "$1 $2" in
  "pr list") cat "${ghDir}/pr-list.json" ;;
  "pr view") cat "${ghDir}/pr-view.json" ;;
  "issue list") echo '[]' ;;
  *) echo "" ;;
esac
exit 0
`
  );
  fs.chmodSync(path.join(ghDir, "gh"), 0o755);
  fs.appendFileSync(path.join(world.stateDir, ".env"), `STUB_GH_DIR=${ghDir}\n`);
};

// A green factory PR whose branch touches `files`, one session that reports it.
const setupGreenPr = (world, files) => {
  gitIn(world.project, "checkout", "-b", "factory/T-001");
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(world.project, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  gitIn(world.project, "add", "-A");
  gitIn(world.project, "commit", "-m", "T-001 work");
  gitIn(world.project, "push", "origin", "factory/T-001");
  gitIn(world.project, "checkout", "main");
  const prView = {
    state: "OPEN", number: 5, title: "[factory] T-001: sample task",
    headRefName: "factory/T-001", mergeable: "MERGEABLE",
    statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
  };
  // The PR also shows up in the window-end sweep list: parking must not
  // re-request the owner's review on every pass.
  installGateGh(world, { prView, prList: [{ number: 5, url: "https://github.com/o/r/pull/5", title: prView.title, headRefName: prView.headRefName }] });
  queueSessions(world, [
    {
      script: report({ taskId: "T-001", status: "review", summary: "opened PR", pr: "https://github.com/o/r/pull/5" }),
      stdout: RESULT, exit: 0,
    },
  ]);
};

test("a green PR touching a high-risk path parks for owner review instead of auto-merging", (t) => {
  const world = makeFactory(t, {
    config: {
      autonomy: "auto-merge-dev", mergeGateMinutes: 0.1, maxSessionsPerWindow: 1,
      riskTiers: { high: ["src/auth/", "db/migrations/"] },
    },
  });
  setupGreenPr(world, { "src/auth/token.mjs": "export const t = 1;\n" });

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /high-risk/);
  assert.doesNotMatch(r.stdout, /merged http|gh fallback/, "a high-risk PR must never auto-merge on green");
  assert.doesNotMatch(gitIn(world.origin, "log", "main", "--oneline"), /Merge PR #5/);
  const epic = fs.readFileSync(path.join(world.factoryDir, "backlog", "e1.md"), "utf8");
  assert.match(epic, /- Status: needs-human/, "the task parks for the owner while the PR waits");
  const calls = fs.readFileSync(path.join(world.root, "stub-gh", "calls.log"), "utf8");
  const comments = calls.split("\n").filter((l) => l.startsWith("pr comment"));
  assert.equal(comments.length, 1, `owner review must be requested exactly once, got:\n${calls}`);
});

test("a green PR clear of high-risk paths merges normally with riskTiers configured", (t) => {
  const world = makeFactory(t, {
    config: {
      autonomy: "auto-merge-dev", mergeGateMinutes: 0.1, maxSessionsPerWindow: 1,
      riskTiers: { high: ["src/auth/", "db/migrations/"] },
    },
  });
  setupGreenPr(world, { "src/ui/button.mjs": "export const b = 1;\n" });

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /merged https:\/\/github\.com\/o\/r\/pull\/5/);
  assert.match(gitIn(world.origin, "log", "main", "--oneline"), /Merge PR #5/);
});

test("the owner merging a risk-parked PR flips the task done at the next window", (t) => {
  const world = makeFactory(t, {
    config: { autonomy: "auto-merge-dev", mergeGateMinutes: 0.1, riskTiers: { high: ["src/auth/"] } },
    tasks: `# Epic 1

## T-001: sample task

- Status: needs-human
- Reqs: REQ-1
- Acceptance: it works
- Verify: true
`,
  });
  // The gate risk-parked T-001 with its PR in a previous window; the owner
  // has since merged that PR. Nothing lists it anymore (pr list = open only).
  const logDir = path.join(world.stateDir, "log");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, "state.json"), JSON.stringify({
    tasks: { "T-001": { status: "needs-human", pr: "https://github.com/o/r/pull/5", parkedBy: "risk", updatedAt: "2026-07-10T00:00:00Z" } },
    pendingFlips: [],
  }));
  installGateGh(world, { prView: { state: "MERGED" }, prList: [] });
  queueSessions(world, []); // the window skips (only needs-human left) — no session runs

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const epic = fs.readFileSync(path.join(world.factoryDir, "backlog", "e1.md"), "utf8");
  assert.match(epic, /- Status: done/,
    "the owner's merge is the approval — the sweep must close a risk-parked task mechanically");
});

test("a question-parked task is not closed by its PR merging", (t) => {
  const world = makeFactory(t, {
    config: { autonomy: "auto-merge-dev", mergeGateMinutes: 0.1, riskTiers: { high: ["src/auth/"] } },
    tasks: `# Epic 1

## T-001: sample task

- Status: needs-human
- Reqs: REQ-1
- Acceptance: it works
- Verify: true
`,
  });
  // Same shape, but the park came from an open question (no parkedBy marker):
  // the PR landing does not answer the question, so the task must stay parked.
  const logDir = path.join(world.stateDir, "log");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, "state.json"), JSON.stringify({
    tasks: { "T-001": { status: "needs-human", pr: "https://github.com/o/r/pull/5", updatedAt: "2026-07-10T00:00:00Z" } },
    pendingFlips: [],
  }));
  installGateGh(world, { prView: { state: "MERGED" }, prList: [] });
  queueSessions(world, []);

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const epic = fs.readFileSync(path.join(world.factoryDir, "backlog", "e1.md"), "utf8");
  assert.match(epic, /- Status: needs-human/, "a merge must not clear an open question");
});

test("a PR with no task id touching a high-risk path is refused, not merged", (t) => {
  const world = makeFactory(t, {
    config: {
      autonomy: "auto-merge-dev", mergeGateMinutes: 0.1, maxSessionsPerWindow: 1,
      riskTiers: { high: ["src/auth/"] },
    },
  });
  // A factory-branch PR whose title carries no task id — only the sweep
  // sees it. There is no task to park, but it still must not merge.
  gitIn(world.project, "checkout", "-b", "factory/hotfix");
  fs.mkdirSync(path.join(world.project, "src", "auth"), { recursive: true });
  fs.writeFileSync(path.join(world.project, "src", "auth", "keys.mjs"), "export const k = 1;\n");
  gitIn(world.project, "add", "-A");
  gitIn(world.project, "commit", "-m", "rotate keys");
  gitIn(world.project, "push", "origin", "factory/hotfix");
  gitIn(world.project, "checkout", "main");
  installGateGh(world, {
    prList: [{ number: 9, url: "https://github.com/o/r/pull/9", title: "[factory] hotfix: rotate keys", headRefName: "factory/hotfix" }],
    prView: {
      state: "OPEN", number: 9, title: "[factory] hotfix: rotate keys",
      headRefName: "factory/hotfix", mergeable: "MERGEABLE",
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    },
  });
  queueSessions(world, [
    { script: report({ taskId: null, status: "no-tasks", summary: "n" }), stdout: RESULT, exit: 0 },
  ]);

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /high-risk/);
  assert.doesNotMatch(gitIn(world.origin, "log", "main", "--oneline"), /Merge PR #9/);
  const calls = fs.readFileSync(path.join(world.root, "stub-gh", "calls.log"), "utf8");
  assert.doesNotMatch(calls, /^pr comment/m, "no task to park — refuse quietly, don't spam the PR");
});

test("a blocked task's risky PR is refused without overwriting its status", (t) => {
  const world = makeFactory(t, {
    config: {
      autonomy: "auto-merge-dev", mergeGateMinutes: 0.1, maxSessionsPerWindow: 1,
      riskTiers: { high: ["src/auth/"] },
    },
    tasks: `# Epic 1

## T-001: sample task

- Status: blocked
- Reqs: REQ-1
- Acceptance: it works
- Verify: true

## T-002: keep the window running

- Status: todo
- Reqs: REQ-2
- Acceptance: it works
- Verify: true
`,
  });
  // T-001 parked blocked on an open question, but its PR (partial scaffolding
  // under src/auth/) is still open and green — the exact T-032 shape. The
  // risk gate must neither merge it nor convert `blocked` into a risk park:
  // a later owner merge would flip it done with the question unanswered.
  const logDir = path.join(world.stateDir, "log");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, "state.json"), JSON.stringify({
    tasks: { "T-001": { status: "blocked", pr: "https://github.com/o/r/pull/5", updatedAt: "2026-07-10T00:00:00Z" } },
    pendingFlips: [],
  }));
  gitIn(world.project, "checkout", "-b", "factory/T-001");
  fs.mkdirSync(path.join(world.project, "src", "auth"), { recursive: true });
  fs.writeFileSync(path.join(world.project, "src", "auth", "scaffold.mjs"), "export const s = 1;\n");
  gitIn(world.project, "add", "-A");
  gitIn(world.project, "commit", "-m", "T-001 partial work");
  gitIn(world.project, "push", "origin", "factory/T-001");
  gitIn(world.project, "checkout", "main");
  installGateGh(world, {
    prList: [{ number: 5, url: "https://github.com/o/r/pull/5", title: "[factory] T-001: sample task", headRefName: "factory/T-001" }],
    prView: {
      state: "OPEN", number: 5, title: "[factory] T-001: sample task",
      headRefName: "factory/T-001", mergeable: "MERGEABLE",
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    },
  });
  queueSessions(world, [
    { script: report({ taskId: null, status: "no-tasks", summary: "n" }), stdout: RESULT, exit: 0 },
  ]);

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.doesNotMatch(gitIn(world.origin, "log", "main", "--oneline"), /Merge PR #5/);
  const epic = fs.readFileSync(path.join(world.factoryDir, "backlog", "e1.md"), "utf8");
  assert.match(epic, /## T-001:[^]*?- Status: blocked/, "the open question is not answered by a risk park");
  const calls = fs.readFileSync(path.join(world.root, "stub-gh", "calls.log"), "utf8");
  assert.doesNotMatch(calls, /^pr comment/m, "no review request — the task is not awaiting PR review");
});

test("the owner's merge landing mid-sweep still closes a risk-parked task (MERGED-state path)", (t) => {
  const world = makeFactory(t, {
    config: { autonomy: "auto-merge-dev", mergeGateMinutes: 0.1, maxSessionsPerWindow: 1, riskTiers: { high: ["src/auth/"] } },
    tasks: `# Epic 1

## T-001: sample task

- Status: needs-human
- Reqs: REQ-1
- Acceptance: it works
- Verify: true

## T-002: keep the window running

- Status: todo
- Reqs: REQ-2
- Acceptance: it works
- Verify: true
`,
  });
  const logDir = path.join(world.stateDir, "log");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, "state.json"), JSON.stringify({
    tasks: { "T-001": { status: "needs-human", pr: "https://github.com/o/r/pull/5", parkedBy: "risk", updatedAt: "2026-07-10T00:00:00Z" } },
    pendingFlips: [],
  }));
  installGateGh(world, {
    prList: [{ number: 5, url: "https://github.com/o/r/pull/5", title: "[factory] T-001: sample task", headRefName: "factory/T-001" }],
    prView: { state: "MERGED" },
  });
  // prState (`--json state`, the sweep's cheap pre-check) flakes; the full
  // prView the merge gate does shows the owner's merge landed. The gate's
  // MERGED-state branch is the belt behind closeOwnerMergedGates — it must
  // recognize a risk park as "awaiting THIS PR's review" and flip done.
  const gh = path.join(world.root, "stub-gh", "gh");
  fs.writeFileSync(gh, fs.readFileSync(gh, "utf8").replace(
    'case "$1 $2" in',
    'case "$*" in *"--json state") exit 1 ;; esac\ncase "$1 $2" in'));
  queueSessions(world, [
    { script: report({ taskId: null, status: "no-tasks", summary: "n" }), stdout: RESULT, exit: 0 },
  ]);

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const epic = fs.readFileSync(path.join(world.factoryDir, "backlog", "e1.md"), "utf8");
  assert.match(epic, /## T-001:[^]*?- Status: done/,
    "the owner's merge is the approval even when the sweep's cheap pre-check missed it");
});

test("doctor fails a malformed riskTiers instead of silently disabling the floor", (t) => {
  const world = makeFactory(t, { config: { riskTiers: { high: "src/auth/" } } });

  const r = runDriver(world, "doctor");

  assert.match(r.stdout, /✗ risk tiers/, `expected a hard fail row\nstdout:\n${r.stdout}`);
  assert.notEqual(r.code, 0, "a typo must not silently turn a safety gate off");
});

test("doctor fails a riskTiers whose high key is typo'd, not skip it", (t) => {
  const world = makeFactory(t, { config: { riskTiers: { hihg: ["src/auth/"] } } });

  const r = runDriver(world, "doctor");

  assert.match(r.stdout, /✗ risk tiers/,
    `a misspelled key silently empties the floor — doctor must catch it\nstdout:\n${r.stdout}`);
  assert.notEqual(r.code, 0);
});

test("doctor accepts a well-formed riskTiers", (t) => {
  const world = makeFactory(t, { config: { riskTiers: { high: ["src/auth/"] } } });

  const r = runDriver(world, "doctor");

  assert.match(r.stdout, /✓ risk tiers/, `expected the row to pass\nstdout:\n${r.stdout}`);
  assert.doesNotMatch(r.stdout, /✗ risk tiers/);
});
