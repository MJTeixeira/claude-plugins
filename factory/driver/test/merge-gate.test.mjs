// Merge-gate check classification + PR sweeps at session boundaries.
// The gate must judge checks by the PR's statusCheckRollup (evidence),
// never by `gh pr checks` exit codes (misread in-flight CI as failing —
// runtime lesson, seen ~5×/night); green PRs left by earlier sessions or
// windows must land at the next session boundary, not wait for window end
// (rpg-solo #64/#65 needed a manual kill→prep to merge).
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

// Programmable gh for gate tests: canned `pr list` / `pr view` JSON and a
// forced `pr checks` exit code (the old gate judged by it — a correct gate
// never calls it). Everything else answers empty-and-ok.
const installGateGh = (world, { prList = [], prView = null, prChecksExit = 0 } = {}) => {
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
  "pr checks") exit ${prChecksExit} ;;
  "issue list") echo '[]' ;;
  *) echo "" ;;
esac
exit 0
`
  );
  fs.chmodSync(path.join(ghDir, "gh"), 0o755);
  fs.appendFileSync(path.join(world.stateDir, ".env"), `STUB_GH_DIR=${ghDir}\n`);
};

test("in-flight checks read as wait, never FAILING — whatever gh pr checks exits", (t) => {
  const world = makeFactory(t, {
    config: { autonomy: "auto-merge-dev", mergeGateMinutes: 0.1, maxSessionsPerWindow: 1 },
  });
  installGateGh(world, {
    prView: {
      state: "OPEN", number: 5, title: "[factory] T-001: sample task",
      headRefName: "factory/T-001", mergeable: "MERGEABLE",
      statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: null }],
    },
    prChecksExit: 1, // the misread source: nonzero while CI is still running
  });
  queueSessions(world, [
    {
      script: report({ taskId: "T-001", status: "review", summary: "opened PR", pr: "https://github.com/o/r/pull/5" }),
      stdout: RESULT, exit: 0,
    },
  ]);

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.doesNotMatch(r.stdout, /checks FAILING/, "in-flight CI must never read as failing");
  assert.doesNotMatch(r.stdout, /merged https/, "a pending PR must not merge");
  assert.match(r.stdout, /still pending/);
});

test("a concrete failure conclusion leaves the fix instruction for the next session", (t) => {
  const world = makeFactory(t, {
    config: { autonomy: "auto-merge-dev", mergeGateMinutes: 0.1, maxSessionsPerWindow: 2 },
  });
  installGateGh(world, {
    prView: {
      state: "OPEN", number: 5, title: "[factory] T-001: sample task",
      headRefName: "factory/T-001", mergeable: "MERGEABLE",
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }],
    },
  });
  queueSessions(world, [
    {
      script: report({ taskId: "T-001", status: "review", summary: "opened PR", pr: "https://github.com/o/r/pull/5" }),
      stdout: RESULT, exit: 0,
    },
    {
      script: report({ taskId: null, status: "no-tasks", summary: "n" }),
      stdout: RESULT, exit: 0,
    },
  ]);

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /checks FAILING on/);
  const inv2 = JSON.parse(fs.readFileSync(path.join(world.stubDir, "invocation-2.json"), "utf8"));
  assert.match(inv2.prompt, /has FAILING checks on branch factory\/T-001/);
});

test("a green factory PR from an earlier window merges at the session boundary, not window end", (t) => {
  const world = makeFactory(t, {
    config: { autonomy: "auto-merge-dev", mergeGateMinutes: 0.1, maxSessionsPerWindow: 2 },
    tasks: `# Epic 1

## T-001: sample task

- Status: todo
- Reqs: REQ-1
- Acceptance: it works
- Verify: true

## T-777: stuck green PR from last window

- Status: review
- Reqs: REQ-1
- Acceptance: it works
- Verify: true
`,
  });
  // The real branch behind the stuck PR — the gate lands it with a local merge.
  gitIn(world.project, "checkout", "-b", "factory/T-777");
  fs.writeFileSync(path.join(world.project, "extra.txt"), "from the stuck PR\n");
  gitIn(world.project, "add", "-A");
  gitIn(world.project, "commit", "-m", "T-777 work");
  gitIn(world.project, "push", "origin", "factory/T-777");
  gitIn(world.project, "checkout", "main");
  installGateGh(world, {
    prList: [{ number: 7, url: "https://github.com/o/r/pull/7", title: "[factory] T-777: stuck green PR from last window", headRefName: "factory/T-777" }],
    prView: {
      state: "OPEN", number: 7, title: "[factory] T-777: stuck green PR from last window",
      headRefName: "factory/T-777", mergeable: "MERGEABLE",
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    },
  });
  queueSessions(world, [
    {
      script: report({ taskId: "T-001", status: "completed", summary: "done, no PR needed" }),
      stdout: RESULT, exit: 0,
    },
    {
      script: report({ taskId: null, status: "no-tasks", summary: "n" }),
      stdout: RESULT, exit: 0,
    },
  ]);

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const merged = r.stdout.indexOf("merged https://github.com/o/r/pull/7");
  const s2 = r.stdout.indexOf("session 2 starting");
  assert.ok(merged !== -1, `PR 7 never merged\nstdout:\n${r.stdout}`);
  assert.ok(s2 !== -1, `session 2 never started\nstdout:\n${r.stdout}`);
  assert.ok(merged < s2, `PR 7 merged only after session 2 — boundary sweep missing\nstdout:\n${r.stdout}`);
  assert.match(gitIn(world.origin, "log", "main", "--oneline"), /Merge PR #7/);
  // The stuck task's status flip rode the merge commit.
  const epic = gitIn(world.origin, "show", "main:.factory/backlog/e1.md");
  assert.match(epic, /## T-777:[^]*?- Status: done/);
});

test("a green PR for a human-gated task waits for owner review instead of auto-merging", (t) => {
  const world = makeFactory(t, {
    config: { autonomy: "auto-merge-dev", mergeGateMinutes: 0.1, maxSessionsPerWindow: 1 },
    tasks: `# Epic 1

## T-001: sample task

- Status: todo
- Gate: human (art direction — owner judges the look)
- Reqs: REQ-1
- Acceptance: owner approves the visuals
- Verify: true
`,
  });
  const prView = {
    state: "OPEN", number: 5, title: "[factory] T-001: sample task",
    headRefName: "factory/T-001", mergeable: "MERGEABLE",
    statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
  };
  // The PR also shows up in the window-end sweep list: the gate must not
  // re-request the owner's review on every pass.
  installGateGh(world, { prView, prList: [{ number: 5, url: "https://github.com/o/r/pull/5", title: prView.title, headRefName: prView.headRefName }] });
  queueSessions(world, [
    {
      script: report({ taskId: "T-001", status: "review", summary: "opened PR", pr: "https://github.com/o/r/pull/5" }),
      stdout: RESULT, exit: 0,
    },
  ]);

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.doesNotMatch(r.stdout, /merged http|gh fallback/, "a human-gated PR must never auto-merge on green");
  assert.match(r.stdout, /human-gated/);
  const epic = fs.readFileSync(path.join(world.factoryDir, "backlog", "e1.md"), "utf8");
  assert.match(epic, /- Status: needs-human/, "the task parks for the owner while the PR waits");
  const calls = fs.readFileSync(path.join(world.root, "stub-gh", "calls.log"), "utf8");
  const comments = calls.split("\n").filter((l) => l.startsWith("pr comment"));
  assert.equal(comments.length, 1, `owner review must be requested exactly once, got:\n${calls}`);
});

test("the owner merging a parked human-gated PR flips the task done at the next sweep", (t) => {
  const world = makeFactory(t, {
    config: { autonomy: "auto-merge-dev", mergeGateMinutes: 0.1 },
    tasks: `# Epic 1

## T-001: sample task

- Status: needs-human
- Gate: human (owner judges the look)
- Reqs: REQ-1
- Acceptance: owner approves the visuals
- Verify: true
`,
  });
  // The gate parked T-001 with its PR in a previous window; the owner has
  // since merged that PR. Nothing lists it anymore (pr list = open only).
  const logDir = path.join(world.stateDir, "log");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, "state.json"), JSON.stringify({
    tasks: { "T-001": { status: "needs-human", pr: "https://github.com/o/r/pull/5", updatedAt: "2026-07-10T00:00:00Z" } },
    pendingFlips: [],
  }));
  installGateGh(world, { prView: { state: "MERGED" }, prList: [] });
  queueSessions(world, []); // the window skips (only needs-human left) — no session runs

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const epic = fs.readFileSync(path.join(world.factoryDir, "backlog", "e1.md"), "utf8");
  assert.match(epic, /- Status: done/,
    "the owner's merge is the approval — the sweep must close the loop mechanically");
});

test("a draft PR is a human's task claim — the sweep leaves it alone, never gates or merges it", (t) => {
  const world = makeFactory(t, {
    config: { autonomy: "auto-merge-dev", mergeGateMinutes: 0.1, maxSessionsPerWindow: 1 },
  });
  // A teammate claimed T-002 by opening a draft PR (team affordances). Even
  // on a factory/ branch with green checks it is not the gate's to touch —
  // factory sessions never open drafts, so any draft is a human's.
  installGateGh(world, {
    prList: [{ number: 6, url: "https://github.com/o/r/pull/6", title: "[factory] T-002: claimed rework", headRefName: "factory/T-002", isDraft: true }],
    prView: {
      state: "OPEN", number: 6, title: "[factory] T-002: claimed rework",
      headRefName: "factory/T-002", mergeable: "MERGEABLE",
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    },
  });
  queueSessions(world, [
    { script: report({ taskId: null, status: "no-tasks", summary: "n" }), stdout: RESULT, exit: 0 },
  ]);

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.doesNotMatch(r.stdout, /merged https/, "a draft claim must never merge");
  assert.doesNotMatch(r.stdout, /1 open factory PR/, "a draft claim is not the sweep's work");
});
