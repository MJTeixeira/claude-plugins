// dev --until-done (autonomy epic chunk 6): chain triage→dev→report cycles
// until the backlog is done or only human-parked work remains. Exits on STOP
// and on a no-progress breaker: a task that burns noProgressSessions (default
// 3) sessions without settling is parked needs-human mid-window; when nothing
// actionable remains, the loop ends. Two consecutive cycles landing nothing
// end the loop too — until-done must never grind sessions against a wall.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeFactory, queueSessions, runDriver } from "./helpers.mjs";

const RESULT = {
  type: "result", subtype: "success", result: "done",
  total_cost_usd: 0.02, num_turns: 5, usage: { input_tokens: 10, output_tokens: 20 },
};

const planEvent = (queue) =>
  `printf '%s\\n' '${JSON.stringify({ ts: "t", event: "submit_plan", queue })}' >> "$FACTORY_MCP_EVENTS"`;
const triageStub = (queue) => ({
  script: planEvent(queue),
  stdout: JSON.stringify({ ...RESULT, result: "plan posted" }) + "\n",
  exit: 0,
});
const reportStub = () => ({ stdout: JSON.stringify({ ...RESULT, result: "reported" }) + "\n", exit: 0 });
const devStub = (taskId, status, summary = "worked") => ({
  script: `mkdir -p .factory/log && printf '%s' '${JSON.stringify({ taskId, status, summary })}' > .factory/log/last-session.json`,
  stdout: JSON.stringify(RESULT) + "\n",
  exit: 0,
});

const TWO_TASKS = `# Epic 1

## T-001: first task
- Status: todo
- Reqs: REQ-1
- Acceptance: it works
- Verify: true

## T-002: second task
- Status: todo
- Reqs: REQ-1
- Acceptance: it works
- Verify: true
`;

const invocations = (world) => {
  let n = 0;
  while (fs.existsSync(path.join(world.stubDir, `invocation-${n + 1}.json`))) n += 1;
  return n;
};
const invocation = (world, n) =>
  JSON.parse(fs.readFileSync(path.join(world.stubDir, `invocation-${n}.json`), "utf8"));

test("until-done runs triage→dev→report per cycle and stops when the backlog completes", (t) => {
  const world = makeFactory(t, { config: { maxSessionsPerWindow: 1 }, plan: null });
  queueSessions(world, [
    triageStub([{ taskId: "T-001", model: "sonnet", effort: "low" }]),
    devStub("T-001", "completed", "built T-001"),
    reportStub(),
  ]);

  const r = runDriver(world, "dev", ["--until-done"]);

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /until-done cycle 1:/);
  assert.match(r.stdout, /backlog complete/);
  assert.equal(invocations(world), 3, "expected exactly triage, dev, report sessions");
  assert.equal(invocation(world, 1).factoryMode, "triage");
  assert.equal(invocation(world, 2).factoryMode, "dev");
  assert.equal(invocation(world, 3).factoryMode, "report");
});

test("work left after a window rolls into a second cycle with a fresh triage", (t) => {
  const world = makeFactory(t, { config: { maxSessionsPerWindow: 1 }, plan: null, tasks: TWO_TASKS });
  queueSessions(world, [
    triageStub([{ taskId: "T-001", model: "sonnet", effort: "low" }, { taskId: "T-002", model: "sonnet", effort: "low" }]),
    devStub("T-001", "completed", "built T-001"),
    reportStub(),
    triageStub([{ taskId: "T-002", model: "sonnet", effort: "low" }]),
    devStub("T-002", "completed", "built T-002"),
    reportStub(),
  ]);

  const r = runDriver(world, "dev", ["--until-done"]);

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /until-done cycle 2:/);
  assert.match(r.stdout, /backlog complete/);
  assert.equal(invocations(world), 6);
  assert.equal(invocation(world, 4).factoryMode, "triage", "cycle 2 must start with its own triage");
  assert.match(invocation(world, 5).prompt, /Your task this session: T-002/);
});

test("STOP between cycles ends the loop before another triage is spent", (t) => {
  const world = makeFactory(t, { config: { maxSessionsPerWindow: 1 }, plan: null, tasks: TWO_TASKS });
  queueSessions(world, [
    triageStub([{ taskId: "T-001", model: "sonnet", effort: "low" }, { taskId: "T-002", model: "sonnet", effort: "low" }]),
    {
      // Completes T-001 AND drops the STOP file, as the owner would mid-run.
      script: `mkdir -p .factory/log && printf '%s' '{"taskId":"T-001","status":"completed","summary":"built"}' > .factory/log/last-session.json && touch "${path.join(world.stateDir, "STOP")}"`,
      stdout: JSON.stringify(RESULT) + "\n",
      exit: 0,
    },
  ]);

  const r = runDriver(world, "dev", ["--until-done"]);

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /STOP file present — until-done ending/);
  assert.equal(invocations(world), 2, "STOP outranks the report leg and the next cycle's triage");
});

test("no-progress breaker parks a task needs-human after 3 fruitless sessions and ends the drained window", (t) => {
  const world = makeFactory(t, { config: { maxSessionsPerWindow: 5 }, plan: null });
  queueSessions(world, [
    triageStub([{ taskId: "T-001", model: "sonnet", effort: "low" }]),
    devStub("T-001", "in-progress", "still fighting it"),
    devStub("T-001", "in-progress", "still fighting it"),
    devStub("T-001", "in-progress", "still fighting it"),
    reportStub(),
  ]);

  const r = runDriver(world, "dev", ["--until-done"]);

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /no-progress breaker: T-001/);
  assert.match(r.stdout, /waiting on owner/);
  assert.equal(invocations(world), 5, "breaker must fire mid-window — no 4th dev session");
  assert.match(
    fs.readFileSync(path.join(world.project, ".factory", "backlog", "e1.md"), "utf8"),
    /Status: needs-human/,
    "the parked status must be durable in the backlog file"
  );
});

test("a pr-only factory that ships its work for review exits as waiting-on-owner, not as stuck", (t) => {
  const world = makeFactory(t, { config: { maxSessionsPerWindow: 1 }, plan: null });
  queueSessions(world, [
    triageStub([{ taskId: "T-001", model: "sonnet", effort: "low" }]),
    devStub("T-001", "review", "PR opened, awaiting owner"),
    reportStub(),
  ]);

  const r = runDriver(world, "dev", ["--until-done"]);

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /shipped T-001 for review/);
  assert.match(r.stdout, /every open task waits on the owner \(T-001\)/);
  assert.doesNotMatch(r.stdout, /landed nothing — ending/);
  assert.equal(invocations(world), 3, "one clean cycle — no second triage against owner-gated work");
});

test("the breaker never parks a task whose session just delivered a review PR", (t) => {
  const world = makeFactory(t, { config: { maxSessionsPerWindow: 3 }, plan: null });
  queueSessions(world, [
    triageStub([{ taskId: "T-001", model: "sonnet", effort: "low" }]),
    devStub("T-001", "in-progress", "still fighting it"),
    devStub("T-001", "in-progress", "still fighting it"),
    devStub("T-001", "review", "third session shipped the PR"),
    reportStub(),
  ]);

  const r = runDriver(world, "dev", ["--until-done"]);

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.doesNotMatch(r.stdout, /no-progress breaker/);
  assert.doesNotMatch(
    fs.readFileSync(path.join(world.project, ".factory", "backlog", "e1.md"), "utf8"),
    /Status: needs-human/,
    "delivered work must never be parked"
  );
  assert.match(r.stdout, /shipped T-001 for review/);
});

test("two consecutive cycles landing nothing end the loop instead of grinding sessions", (t) => {
  const world = makeFactory(t, { config: { maxSessionsPerWindow: 1 }, plan: null });
  queueSessions(world, [
    triageStub([{ taskId: "T-001", model: "sonnet", effort: "low" }]),
    devStub("T-001", "in-progress", "no landing"),
    reportStub(),
    triageStub([{ taskId: "T-001", model: "sonnet", effort: "low" }]),
    devStub("T-001", "in-progress", "no landing"),
    reportStub(),
  ]);

  const r = runDriver(world, "dev", ["--until-done"]);

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /until-done: 2 consecutive cycle\(s\) landed nothing — ending/);
  assert.equal(invocations(world), 6, "no third cycle");
});
