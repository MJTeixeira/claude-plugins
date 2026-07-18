import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeFactory, queueSessions, runDriver, gitIn } from "./helpers.mjs";
import { factoryKey } from "../paths.mjs";

test("triage runs in the meta worktree but its plan.json reaches the project", (t) => {
  const world = makeFactory(t);
  queueSessions(world, [
    {
      // The triage prompt says "write .factory/plan.json" — relative to the
      // session's cwd (the meta worktree). The runtime symlink must land it
      // in the project's .factory, where the dev window reads it.
      script: `cat > .factory/plan.json <<'EOF'
{"generatedAt":"2026-07-09T08:30:00Z","queue":[{"taskId":"T-001","model":"sonnet","effort":"medium","maxTurns":40}]}
EOF`,
      stdout: JSON.stringify({ type: "result", subtype: "success", result: "plan posted", total_cost_usd: 0.05, num_turns: 5, usage: { input_tokens: 2, output_tokens: 9 } }) + "\n",
      exit: 0,
    },
  ]);

  const r = runDriver(world, "triage");
  assert.equal(r.code, 0, `triage exited ${r.code}\n${r.stdout}\n${r.stderr}`);

  const planPath = path.join(world.stateDir, "plan.json");
  assert.ok(fs.existsSync(planPath), "plan.json did not land in the project's .factory");
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  assert.equal(plan.queue[0].taskId, "T-001");

  // The session saw the project's runtime logs through the meta worktree.
  const inv = JSON.parse(fs.readFileSync(path.join(world.stubDir, "invocation-1.json"), "utf8"));
  assert.ok(inv.cwd.endsWith(path.join("meta")), `triage cwd is not the meta worktree: ${inv.cwd}`);
  assert.ok(
    fs.existsSync(path.join(inv.cwd, ".factory", "log", "usage.jsonl")) ||
      fs.lstatSync(path.join(inv.cwd, ".factory", "log")).isSymbolicLink(),
    "meta worktree has no log link to the project's runtime logs"
  );
});

test("triage drops overlay entries the backlog files disagree with", (t) => {
  const world = makeFactory(t, {
    tasks:
      "# Epic 1\n\n## T-001: sample task\n\n- Status: todo\n- Reqs: REQ-1\n- Acceptance: it works\n- Verify: true\n\n" +
      "## T-002: second task\n\n- Status: blocked\n- Reqs: REQ-2\n- Acceptance: it works\n- Verify: true\n",
  });
  // Stale runtime overlay: the files re-opened T-001 (todo) but the machine
  // still remembers it blocked — dev sessions would skip valid work forever
  // (the rpg-solo T-043/T-047 no-task bug). T-002 agrees with its file.
  const logDir = path.join(world.stateDir, "log");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, "state.json"), JSON.stringify({
    tasks: {
      "T-001": { status: "blocked", pr: null, updatedAt: "2026-07-10T00:00:00Z" },
      "T-002": { status: "blocked", pr: null, updatedAt: "2026-07-10T00:00:00Z" },
    },
    pendingFlips: [],
  }));
  queueSessions(world, [
    {
      stdout: JSON.stringify({ type: "result", subtype: "success", result: "triage done", total_cost_usd: 0.05, num_turns: 5, usage: { input_tokens: 2, output_tokens: 9 } }) + "\n",
      exit: 0,
    },
  ]);

  const r = runDriver(world, "triage");
  assert.equal(r.code, 0, `triage exited ${r.code}\n${r.stdout}\n${r.stderr}`);

  const state = JSON.parse(fs.readFileSync(path.join(logDir, "state.json"), "utf8"));
  assert.equal(state.tasks["T-001"], undefined,
    "stale overlay entry must be dropped — files are authoritative post-triage");
  assert.equal(state.tasks["T-002"]?.status, "blocked", "an entry the files agree with is kept");
});

test("reconciliation keeps runtime-only statuses the files cannot express", (t) => {
  const world = makeFactory(t);
  // T-001 is in review with an open PR — a status only state.json carries
  // (files never say review; the PR is the durable record). Dropping it would
  // make the next triage re-plan a task that is already sitting in a PR.
  const logDir = path.join(world.stateDir, "log");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, "state.json"), JSON.stringify({
    tasks: { "T-001": { status: "review", pr: "https://github.com/x/y/pull/9", updatedAt: "2026-07-10T00:00:00Z" } },
    pendingFlips: [],
  }));
  queueSessions(world, [
    {
      stdout: JSON.stringify({ type: "result", subtype: "success", result: "triage done", total_cost_usd: 0.05, num_turns: 5, usage: { input_tokens: 2, output_tokens: 9 } }) + "\n",
      exit: 0,
    },
  ]);

  const r = runDriver(world, "triage");
  assert.equal(r.code, 0, `triage exited ${r.code}\n${r.stdout}\n${r.stderr}`);

  const state = JSON.parse(fs.readFileSync(path.join(logDir, "state.json"), "utf8"));
  assert.equal(state.tasks["T-001"]?.status, "review",
    "a review entry must survive reconciliation — files can never agree with a runtime-only status");
});

test("a failed triage session leaves the overlay untouched", (t) => {
  const world = makeFactory(t);
  // The premise "files are triage's output" does not hold when the session
  // crashed — reconciling against pre-triage files would erase valid state.
  const logDir = path.join(world.stateDir, "log");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, "state.json"), JSON.stringify({
    tasks: { "T-001": { status: "blocked", pr: null, updatedAt: "2026-07-10T00:00:00Z" } },
    pendingFlips: [],
  }));
  queueSessions(world, [{ stdout: "", exit: 1 }]);

  const r = runDriver(world, "triage");
  assert.equal(r.code, 1, `triage should propagate the session failure\n${r.stdout}\n${r.stderr}`);

  const state = JSON.parse(fs.readFileSync(path.join(logDir, "state.json"), "utf8"));
  assert.equal(state.tasks["T-001"]?.status, "blocked",
    "a failed triage must not prune the overlay — its files are not triage's decision");
});

test("a pending flip that contradicts triage's files is discarded, not re-applied", (t) => {
  const world = makeFactory(t);
  // A blocked flip queued before triage (it failed to land at session end)
  // must not clobber a task triage just re-opened: triage saw the flip in its
  // overlay note and its files say todo — newer judgment wins.
  const logDir = path.join(world.stateDir, "log");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, "state.json"), JSON.stringify({
    tasks: {},
    pendingFlips: [{ taskId: "T-001", status: "blocked" }],
  }));
  queueSessions(world, [
    {
      stdout: JSON.stringify({ type: "result", subtype: "success", result: "triage done", total_cost_usd: 0.05, num_turns: 5, usage: { input_tokens: 2, output_tokens: 9 } }) + "\n",
      exit: 0,
    },
  ]);

  const r = runDriver(world, "triage");
  assert.equal(r.code, 0, `triage exited ${r.code}\n${r.stdout}\n${r.stderr}`);

  const epic = fs.readFileSync(path.join(world.factoryDir, "backlog", "e1.md"), "utf8");
  assert.match(epic, /- Status: todo/, "the stale blocked flip must not override triage's todo");
  const state = JSON.parse(fs.readFileSync(path.join(logDir, "state.json"), "utf8"));
  assert.deepEqual(state.pendingFlips, [], "the contradicted flip must leave the queue");
});

test("triage launches with triageModel, not the factory-wide model", (t) => {
  const world = makeFactory(t, { config: { model: "haiku", triageModel: "opus" } });
  queueSessions(world, [
    {
      stdout: JSON.stringify({ type: "result", subtype: "success", result: "triage done", total_cost_usd: 0.05, num_turns: 5, usage: { input_tokens: 2, output_tokens: 9 } }) + "\n",
      exit: 0,
    },
  ]);

  const r = runDriver(world, "triage");
  assert.equal(r.code, 0, `triage exited ${r.code}\n${r.stdout}\n${r.stderr}`);

  const inv = JSON.parse(fs.readFileSync(path.join(world.stubDir, "invocation-1.json"), "utf8"));
  const i = inv.args.indexOf("--model");
  assert.equal(inv.args[i + 1], "opus", `triage ran with --model ${inv.args[i + 1]}, expected triageModel`);
});

test("pre-migration meta symlinks are re-pointed at the machine state dir", (t) => {
  const world = makeFactory(t);
  const planScenario = (id) => ({
    script: `cat > .factory/plan.json <<'EOF2'
{"generatedAt":"2026-07-09T08:30:00Z","queue":[{"taskId":"${id}","model":"sonnet","effort":"medium","maxTurns":40}]}
EOF2`,
    stdout: JSON.stringify({ type: "result", subtype: "success", result: "plan posted", total_cost_usd: 0.05, num_turns: 5, usage: { input_tokens: 2, output_tokens: 9 } }) + "\n",
    exit: 0,
  });
  queueSessions(world, [planScenario("T-001"), planScenario("T-002")]);
  assert.equal(runDriver(world, "triage").code, 0);

  // Forge the fleet's post-migrate state: the meta worktree still carries
  // symlinks at the LEGACY repo-side paths (whose targets migrate moved away).
  const meta = path.join(world.home, ".factory", "worktrees", factoryKey(world.project), "meta", ".factory");
  for (const [name, legacyTarget] of [["log", path.join(world.project, ".factory", "log")], ["plan.json", path.join(world.project, ".factory", "plan.json")]]) {
    fs.unlinkSync(path.join(meta, name));
    fs.symlinkSync(legacyTarget, path.join(meta, name));
  }

  assert.equal(runDriver(world, "triage").code, 0);

  // Links healed: point at the machine state dir, and the plan the session
  // wrote landed there — NOT recreated inside the repo through a dangling link.
  assert.equal(fs.readlinkSync(path.join(meta, "plan.json")), path.join(world.stateDir, "plan.json"));
  assert.equal(fs.readlinkSync(path.join(meta, "log")), path.join(world.stateDir, "log"));
  const plan = JSON.parse(fs.readFileSync(path.join(world.stateDir, "plan.json"), "utf8"));
  assert.equal(plan.queue[0].taskId, "T-002");
  assert.ok(!fs.existsSync(path.join(world.project, ".factory", "plan.json")), "plan must not be recreated repo-side");
});

test("triage boundary trues up index counters left stale by a live-shipped flip", (t) => {
  // Piloting contract: a live session flips its own task's Status inside the
  // PR it ships, but never touches index counts (driver-only). The daily
  // triage commit must recompute them from the files.
  const world = makeFactory(t, {
    tasks: "# Epic 1\n\n## T-001: shipped in a live session\n\n- Status: done\n- Reqs: REQ-1\n- Acceptance: it works\n- Verify: true\n",
  });
  queueSessions(world, [
    {
      script: "true",
      stdout: JSON.stringify({ type: "result", subtype: "success", result: "nothing to triage", total_cost_usd: 0.01, num_turns: 2, usage: { input_tokens: 1, output_tokens: 2 } }) + "\n",
      exit: 0,
    },
  ]);

  const r = runDriver(world, "triage");
  assert.equal(r.code, 0, `triage exited ${r.code}\n${r.stdout}\n${r.stderr}`);

  const index = gitIn(world.origin, "show", "main:.factory/backlog/index.md");
  assert.match(index, /backlog\/e1\.md — 1\/1 done/, `index counters not trued up:\n${index}`);
});
