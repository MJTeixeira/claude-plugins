// The gate floor (autonomy epic chunk 1): under auto-merge the driver runs
// the repo's own suite (config `gateCommand`) on the MERGED result before
// pushing, and refuses to auto-merge when it has neither CI checks nor a
// gateCommand — "no verification" must never read as "green". Sessions'
// own tests don't count: they ran on the branch, not on the merge.
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

// Patch machine config after makeFactory — gateCommand often needs
// world-absolute paths the fixture can't know in advance.
const patchConfig = (world, patch) => {
  const p = path.join(world.stateDir, "config.json");
  fs.writeFileSync(p, JSON.stringify({ ...JSON.parse(fs.readFileSync(p, "utf8")), ...patch }, null, 2) + "\n");
};

// A green factory PR on a real origin branch, one session that reports it.
const setupGreenPr = (world) => {
  gitIn(world.project, "checkout", "-b", "factory/T-001");
  fs.writeFileSync(path.join(world.project, "extra.txt"), "from the PR branch\n");
  gitIn(world.project, "add", "-A");
  gitIn(world.project, "commit", "-m", "T-001 work");
  gitIn(world.project, "push", "origin", "factory/T-001");
  gitIn(world.project, "checkout", "main");
  installGateGh(world, {
    prView: {
      state: "OPEN", number: 5, title: "[factory] T-001: sample task",
      headRefName: "factory/T-001", mergeable: "MERGEABLE",
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
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
};

test("a red gate suite aborts the merge and leaves the fix instruction for the next session", (t) => {
  const world = makeFactory(t, {
    config: { autonomy: "auto-merge-dev", mergeGateMinutes: 0.1, maxSessionsPerWindow: 2, gateCommand: "exit 1" },
  });
  setupGreenPr(world);

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /gate suite FAILED/);
  assert.doesNotMatch(r.stdout, /merged https/, "a suite-red PR must not merge");
  assert.doesNotMatch(gitIn(world.origin, "log", "main", "--oneline"), /Merge PR #5/);
  const inv2 = JSON.parse(fs.readFileSync(path.join(world.stubDir, "invocation-2.json"), "utf8"));
  assert.match(inv2.prompt, /gate suite FAILED on the merged result/);
  assert.match(inv2.prompt, /do NOT merge yourself/);
});

test("a green gate suite runs on the MERGED tree and the merge lands", (t) => {
  const world = makeFactory(t, {
    config: { autonomy: "auto-merge-dev", mergeGateMinutes: 0.1, maxSessionsPerWindow: 2 },
  });
  setupGreenPr(world);
  // base.txt lands on main AFTER the branch forked: only the merged tree
  // holds both files, so a suite that requires both proves it ran post-merge.
  fs.writeFileSync(path.join(world.project, "base.txt"), "landed on main after the fork\n");
  gitIn(world.project, "add", "-A");
  gitIn(world.project, "commit", "-m", "base moves ahead");
  gitIn(world.project, "push", "origin", "main");
  const sentinel = path.join(world.root, "suite-ran");
  patchConfig(world, { gateCommand: `test -f extra.txt -a -f base.txt && touch ${sentinel}` });

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /gate suite passed/);
  assert.match(r.stdout, /merged https:\/\/github\.com\/o\/r\/pull\/5/);
  assert.match(gitIn(world.origin, "log", "main", "--oneline"), /Merge PR #5/);
  assert.ok(fs.existsSync(sentinel), "gateCommand never ran (or ran on a tree missing a side of the merge)");
});

test("no checks and no gateCommand under auto-merge refuses to merge instead of merging on nothing", (t) => {
  const world = makeFactory(t, {
    config: { autonomy: "auto-merge-dev", mergeGateMinutes: 0.1, maxSessionsPerWindow: 1 },
  });
  setupGreenPr(world);
  // Same PR, but the repo has no CI at all: empty rollup.
  const ghDir = path.join(world.root, "stub-gh");
  const view = JSON.parse(fs.readFileSync(path.join(ghDir, "pr-view.json"), "utf8"));
  view.statusCheckRollup = [];
  fs.writeFileSync(path.join(ghDir, "pr-view.json"), JSON.stringify(view));

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /refusing to auto-merge.*no checks and no gateCommand|no checks and no gateCommand.*refusing to auto-merge/);
  assert.doesNotMatch(r.stdout, /merged https/, "merging on zero verification is the exact hole this closes");
  assert.doesNotMatch(gitIn(world.origin, "log", "main", "--oneline"), /Merge PR #5/);
});

test("no checks but a green gateCommand merges — the suite IS the verification", (t) => {
  const world = makeFactory(t, {
    config: { autonomy: "auto-merge-dev", mergeGateMinutes: 0.1, maxSessionsPerWindow: 1, gateCommand: "true" },
  });
  setupGreenPr(world);
  const ghDir = path.join(world.root, "stub-gh");
  const view = JSON.parse(fs.readFileSync(path.join(ghDir, "pr-view.json"), "utf8"));
  view.statusCheckRollup = [];
  fs.writeFileSync(path.join(ghDir, "pr-view.json"), JSON.stringify(view));

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /gate suite passed/);
  assert.match(gitIn(world.origin, "log", "main", "--oneline"), /Merge PR #5/);
});

test("a gate suite that hangs counts as a failure, not a merge", (t) => {
  const world = makeFactory(t, {
    config: {
      autonomy: "auto-merge-dev", mergeGateMinutes: 0.1, maxSessionsPerWindow: 1,
      gateCommand: "sleep 60", gateSuiteTimeoutMin: 0.02,
    },
  });
  setupGreenPr(world);

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /gate suite FAILED/);
  assert.match(r.stdout, /timed out/);
  assert.doesNotMatch(gitIn(world.origin, "log", "main", "--oneline"), /Merge PR #5/);
});

test("a suite-gated PR whose local landing keeps failing never falls back to a server-side merge", (t) => {
  const world = makeFactory(t, {
    config: { autonomy: "auto-merge-dev", mergeGateMinutes: 0.1, maxSessionsPerWindow: 1, gateCommand: "true" },
  });
  setupGreenPr(world);
  // The branch vanishes from origin after the PR was reported: every local
  // landing attempt dies at `git fetch origin <head>` BEFORE the suite can
  // run — the exact path that used to fall through to `gh pr merge` and
  // land server-side with zero verification.
  gitIn(world.project, "push", "origin", "--delete", "factory/T-001");

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const calls = fs.readFileSync(path.join(world.root, "stub-gh", "calls.log"), "utf8");
  assert.doesNotMatch(calls, /^pr merge/m, "server-side merge must not run when the gate suite never passed");
  assert.doesNotMatch(r.stdout, /via gh fallback/);
  assert.match(r.stdout, /gate suite (never|has not) passed|not falling back/i);
});

test("a green suite with multi-megabyte output still merges (spawn buffer must not misread green as red)", (t) => {
  const world = makeFactory(t, {
    config: { autonomy: "auto-merge-dev", mergeGateMinutes: 0.1, maxSessionsPerWindow: 1 },
  });
  setupGreenPr(world);
  patchConfig(world, { gateCommand: `node -e "process.stdout.write('x'.repeat(3 * 1024 * 1024))"` });

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /gate suite passed/);
  assert.match(gitIn(world.origin, "log", "main", "--oneline"), /Merge PR #5/);
});

test("doctor fails auto-merge factories that have neither CI nor a gateCommand", (t) => {
  const world = makeFactory(t, { config: { autonomy: "auto-merge-dev" } });

  const r = runDriver(world, "doctor");

  assert.match(r.stdout, /✗ CI under auto-merge/, `expected a hard fail row\nstdout:\n${r.stdout}`);
  assert.notEqual(r.code, 0, "a factory that would merge on nothing must not pass doctor");
});

test("doctor accepts a gateCommand as the auto-merge verification floor", (t) => {
  const world = makeFactory(t, { config: { autonomy: "auto-merge-dev", gateCommand: "npm test" } });

  const r = runDriver(world, "doctor");

  assert.match(r.stdout, /✓ CI under auto-merge/, `expected the row to pass on gateCommand\nstdout:\n${r.stdout}`);
  assert.doesNotMatch(r.stdout, /✗ CI under auto-merge/);
});
