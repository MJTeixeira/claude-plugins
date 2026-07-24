// The acceptance grader (autonomy epic chunk 4): before the gate may merge a
// task PR, an INDEPENDENT grader session — spawned by the driver, briefed
// from the task's own Acceptance:/Verify: lines, never by the implementer —
// must record a passing grade_verdict for the PR's exact head SHA. Fail or
// no verdict = no merge (fail-closed); verdicts are cached by SHA so a sweep
// never pays for the same grade twice; prep spawns no sessions, so ungraded
// PRs wait there for the next dev window.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeFactory, queueSessions, runDriver, readUsageRows, gitIn } from "./helpers.mjs";

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

// A green factory PR on a real origin branch, one session that reports it.
const setupGreenPr = (world, { title = "[factory] T-001: sample task", branch = "factory/T-001" } = {}) => {
  gitIn(world.project, "checkout", "-b", branch);
  fs.writeFileSync(path.join(world.project, "extra.txt"), "from the PR branch\n");
  gitIn(world.project, "add", "-A");
  gitIn(world.project, "commit", "-m", "task work");
  gitIn(world.project, "push", "origin", branch);
  gitIn(world.project, "checkout", "main");
  installGateGh(world, {
    prList: [{ number: 5, url: "https://github.com/o/r/pull/5", title, headRefName: branch, isDraft: false }],
    prView: {
      state: "OPEN", number: 5, title,
      headRefName: branch, mergeable: "MERGEABLE",
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    },
  });
};

const reviewSession = { script: report({ taskId: "T-001", status: "review", summary: "opened PR", pr: "https://github.com/o/r/pull/5" }), stdout: RESULT, exit: 0 };
const noTasksSession = { script: report({ taskId: null, status: "no-tasks", summary: "n" }), stdout: RESULT, exit: 0 };
const verdictEvent = (criteria, summary = "graded") =>
  `printf '%s\\n' '${JSON.stringify({ ts: "t", event: "grade_verdict", criteria, summary })}' >> "$FACTORY_MCP_EVENTS"`;
const graderPass = (world) => ({
  // Also record where the grader actually ran: HEAD of its cwd = graded SHA.
  script: `git rev-parse HEAD > "${world.root}/graded-sha"\n${verdictEvent([{ criterion: "it works", pass: true, evidence: "ran Verify command true — exit 0" }])}`,
  stdout: RESULT, exit: 0,
});
const invocation = (world, n) => {
  const p = path.join(world.stubDir, `invocation-${n}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
};
const readGrades = (world) => {
  const p = path.join(world.stateDir, "log", "state.json");
  return (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")).grades : null) ?? {};
};

test("a passing grade merges the PR — graded by an independent session at the PR head", (t) => {
  const world = makeFactory(t, {
    config: { autonomy: "auto-merge-dev", mergeGateMinutes: 0.1, maxSessionsPerWindow: 2, gateCommand: "true" },
  });
  setupGreenPr(world);
  queueSessions(world, [reviewSession, graderPass(world), noTasksSession]);

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /acceptance grade passed/);
  assert.match(gitIn(world.origin, "log", "main", "--oneline"), /Merge PR #5/);
  // The grader ran as its own independent session: grade mode, the
  // configured grader model, in a throwaway worktree at the PR's head SHA.
  const grader = invocation(world, 2);
  assert.equal(grader.factoryMode, "grade");
  const mi = grader.args.indexOf("--model");
  assert.equal(grader.args[mi + 1], "opus", "graderModel default must reach the session");
  assert.notEqual(grader.cwd, world.project, "the grader must run in a throwaway worktree, not the checkout");
  const headSha = gitIn(world.origin, "rev-parse", "factory/T-001");
  assert.equal(fs.readFileSync(path.join(world.root, "graded-sha"), "utf8").trim(), headSha);
  // Briefed by the DRIVER from the task's backlog lines, numbered.
  assert.match(grader.prompt, /1\. it works/);
  assert.match(grader.prompt, /T-001/);
  assert.match(grader.prompt, /Verify command\(s\): true/);
  // The verdict is recorded per head SHA, and the spend is visible as its own mode.
  assert.equal(readGrades(world)[headSha]?.pass, true);
  assert.ok(readUsageRows(world).some((row) => row.mode === "grade"), "grader session missing from usage.jsonl");
});

test("a failed criterion blocks the merge, leaves the evidence for the next session, and is not re-graded on the same SHA", (t) => {
  const world = makeFactory(t, {
    config: { autonomy: "auto-merge-dev", mergeGateMinutes: 0.1, maxSessionsPerWindow: 2, gateCommand: "true" },
  });
  setupGreenPr(world);
  queueSessions(world, [
    reviewSession,
    { script: verdictEvent([{ criterion: "it works", pass: false, evidence: "Verify command exited 1 on the merged branch" }], "criterion 1 failed"), stdout: RESULT, exit: 0 },
    noTasksSession,
  ]);

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /acceptance grader FAILED/);
  assert.doesNotMatch(gitIn(world.origin, "log", "main", "--oneline"), /Merge PR #5/);
  // The next session inherits the failed criteria with the grader's evidence.
  const inv3 = invocation(world, 3);
  assert.match(inv3.prompt, /it works/);
  assert.match(inv3.prompt, /Verify command exited 1/);
  assert.match(inv3.prompt, /do NOT merge yourself/);
  // The window-end sweep re-gates the same PR at the same SHA: the cached
  // verdict answers — no second grader session is ever spawned.
  assert.equal(invocation(world, 4), null, "the same SHA must not be graded twice");
  const journalFile = fs.readdirSync(path.join(world.stateDir, "log")).find((f) => f.startsWith("journal-"));
  assert.match(fs.readFileSync(path.join(world.stateDir, "log", journalFile), "utf8"), /gate:grade/);
  // The window-end sweep's regenerated note survives into the next window.
  const state = JSON.parse(fs.readFileSync(path.join(world.stateDir, "log", "state.json"), "utf8"));
  assert.ok((state.carryNotes ?? []).some((n) => /it works/.test(n)), `carryNotes must carry the failed criterion: ${JSON.stringify(state.carryNotes)}`);
});

test("a verdict that covers fewer criteria than briefed fails closed — a truncated grade is not a pass", (t) => {
  const world = makeFactory(t, {
    config: { autonomy: "auto-merge-dev", mergeGateMinutes: 0.1, maxSessionsPerWindow: 2, gateCommand: "true" },
    // Two acceptance criteria; the grader will record a pass for only one.
    tasks: "# Epic 1\n\n## T-001: sample task\n\n- Status: todo\n- Acceptance:\n  - the list renders\n  - an empty list shows the placeholder\n- Verify: true\n",
  });
  setupGreenPr(world);
  queueSessions(world, [
    reviewSession,
    { script: verdictEvent([{ criterion: "the list renders", pass: true, evidence: "saw 3 rows" }], "only graded one"), stdout: RESULT, exit: 0 },
    noTasksSession,
  ]);

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /1\/2 criteria|only 1 of 2|covered only 1/i);
  assert.doesNotMatch(gitIn(world.origin, "log", "main", "--oneline"), /Merge PR #5/);
  const headSha = gitIn(world.origin, "rev-parse", "factory/T-001");
  assert.equal(readGrades(world)[headSha]?.pass, false, "a short verdict must record as a fail");
});

test("a grader that records no verdict fails closed — no merge on ungraded work", (t) => {
  const world = makeFactory(t, {
    config: { autonomy: "auto-merge-dev", mergeGateMinutes: 0.1, maxSessionsPerWindow: 2, gateCommand: "true" },
  });
  setupGreenPr(world);
  queueSessions(world, [
    reviewSession,
    { stdout: RESULT, exit: 0 }, // grader "succeeds" but never calls grade_verdict
    noTasksSession,
  ]);

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /no verdict/);
  assert.doesNotMatch(gitIn(world.origin, "log", "main", "--oneline"), /Merge PR #5/);
  const headSha = gitIn(world.origin, "rev-parse", "factory/T-001");
  assert.equal(readGrades(world)[headSha]?.pass, false, "a verdict-less grade must be recorded as a fail");
});

test("a PR with no task id (live/piloting work) merges ungraded — no grader session is spent on the owner's own work", (t) => {
  const world = makeFactory(t, {
    config: { autonomy: "auto-merge-dev", mergeGateMinutes: 0.1, maxSessionsPerWindow: 1, gateCommand: "true" },
  });
  setupGreenPr(world, { title: "[factory] hotfix: fix the typo", branch: "factory/hotfix" });
  queueSessions(world, [noTasksSession]);

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(gitIn(world.origin, "log", "main", "--oneline"), /Merge PR #5/);
  assert.equal(invocation(world, 2), null, "no grader session for a task-less PR");
});

test("prep never spawns a grader — an ungraded green PR waits for the next dev window", (t) => {
  const world = makeFactory(t, {
    config: { autonomy: "auto-merge-dev", mergeGateMinutes: 0.1, gateCommand: "true" },
  });
  setupGreenPr(world);

  const r = runDriver(world, "prep");

  assert.match(r.stdout, /awaits acceptance grading/);
  assert.doesNotMatch(gitIn(world.origin, "log", "main", "--oneline"), /Merge PR #5/);
  assert.equal(invocation(world, 1), null, "prep must not spawn sessions");
});

test("a task without Acceptance lines is graded against a criterion synthesized from its title", (t) => {
  const world = makeFactory(t, {
    config: { autonomy: "auto-merge-dev", mergeGateMinutes: 0.1, maxSessionsPerWindow: 2, gateCommand: "true" },
    tasks: "# Epic 1\n\n## T-001: sample task\n\n- Status: todo\n- Reqs: REQ-1\n",
  });
  setupGreenPr(world);
  queueSessions(world, [reviewSession, graderPass(world), noTasksSession]);

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const grader = invocation(world, 2);
  assert.match(grader.prompt, /does what the task says.*T-001/);
  assert.match(gitIn(world.origin, "log", "main", "--oneline"), /Merge PR #5/);
});

test("a task PR whose landing dies before grading never falls back to a server-side merge", (t) => {
  const world = makeFactory(t, {
    config: { autonomy: "auto-merge-dev", mergeGateMinutes: 0.1, maxSessionsPerWindow: 2 },
  });
  setupGreenPr(world); // CI checks green, no gateCommand: pre-grader this fell through to `gh pr merge`
  // The branch vanishes from origin after the PR was reported: every local
  // landing attempt dies at `git fetch origin <head>` BEFORE the grader can
  // run — with no recorded pass, a server-side merge would ship ungraded work.
  gitIn(world.project, "push", "origin", "--delete", "factory/T-001");
  queueSessions(world, [reviewSession, noTasksSession]);

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const calls = fs.readFileSync(path.join(world.root, "stub-gh", "calls.log"), "utf8");
  assert.doesNotMatch(calls, /^pr merge/m, "server-side merge must not run when the grade never passed");
  assert.doesNotMatch(r.stdout, /via gh fallback/);
});
