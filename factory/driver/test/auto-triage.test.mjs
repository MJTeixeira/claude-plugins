// Dev-window auto-triage: a missing, stale, or malformed plan means triage
// hasn't seen the current state — the window re-plans first instead of
// letting sessions guess. Self-select survives only as the fallback when
// that triage itself fails; a fresh-but-empty queue is triage's real answer
// ("nothing eligible") and keeps its probe path untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeFactory, queueSessions, runDriver } from "./helpers.mjs";

const RESULT = {
  type: "result", subtype: "success", result: "done",
  total_cost_usd: 0.02, num_turns: 5, usage: { input_tokens: 10, output_tokens: 20 },
};

// Triage stub: writes a fresh single-task plan through the meta worktree's
// plan.json runtime link (generatedAt stamped at run time so it reads fresh).
const triageStub = () => ({
  script: `cat > .factory/plan.json <<EOF
{"generatedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","queue":[{"taskId":"T-001","model":"sonnet","effort":"low"}]}
EOF`,
  stdout: JSON.stringify({ ...RESULT, result: "plan posted" }) + "\n",
  exit: 0,
});

const devStub = () => ({
  script: `mkdir -p .factory/log && cat > .factory/log/last-session.json <<'EOF'
{"taskId": "T-001", "status": "completed", "summary": "built T-001"}
EOF`,
  stdout: JSON.stringify(RESULT) + "\n",
  exit: 0,
});

test("missing plan: dev window triages first, then follows the fresh plan", (t) => {
  const world = makeFactory(t, { config: { maxSessionsPerWindow: 1 }, plan: null });
  queueSessions(world, [triageStub(), devStub()]);

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /plan\.json missing — running triage before the first session/);
  assert.match(r.stdout, /plan: 1 task\(s\) queued by triage — T-001/);
  // Invocation 1 is the triage (meta worktree), invocation 2 the planned dev session.
  const inv1 = JSON.parse(fs.readFileSync(path.join(world.stubDir, "invocation-1.json"), "utf8"));
  assert.ok(inv1.cwd.endsWith(path.join("meta")), `auto-triage cwd is not the meta worktree: ${inv1.cwd}`);
  const inv2 = JSON.parse(fs.readFileSync(path.join(world.stubDir, "invocation-2.json"), "utf8"));
  assert.match(inv2.prompt, /Your task this session: T-001/);
});

test("stale plan: re-triage, not self-select", (t) => {
  const world = makeFactory(t, {
    config: { maxSessionsPerWindow: 1 },
    plan: {
      generatedAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
      queue: [{ taskId: "T-001", model: "sonnet", effort: "low" }],
    },
  });
  queueSessions(world, [triageStub(), devStub()]);

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /plan\.json stale or malformed — running triage before the first session/);
  const inv2 = JSON.parse(fs.readFileSync(path.join(world.stubDir, "invocation-2.json"), "utf8"));
  assert.match(inv2.prompt, /Your task this session: T-001/);
});

test("fresh empty queue is triage's real answer — probe, no auto-triage", (t) => {
  const world = makeFactory(t, { config: { maxSessionsPerWindow: 1 } }); // harness default: fresh empty plan
  queueSessions(world, [devStub()]);

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /plan: triage queued 0 tasks/);
  assert.doesNotMatch(r.stdout, /running triage before the first session/);
  // The one session is the probe dev session, not a triage.
  const inv1 = JSON.parse(fs.readFileSync(path.join(world.stubDir, "invocation-1.json"), "utf8"));
  assert.doesNotMatch(inv1.prompt, /plan\.json/i);
});

test("auto-triage failure falls back to self-select — the window still runs", (t) => {
  const world = makeFactory(t, { config: { maxSessionsPerWindow: 1 }, plan: null });
  queueSessions(world, [
    { script: "true", stdout: JSON.stringify({ type: "result", subtype: "error", result: "boom" }) + "\n", exit: 1 },
    devStub(),
  ]);

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /auto-triage failed — sessions will self-select/);
  // Session 2 exists and is a plain self-select dev session.
  const inv2 = JSON.parse(fs.readFileSync(path.join(world.stubDir, "invocation-2.json"), "utf8"));
  assert.doesNotMatch(inv2.prompt, /Your task this session:/);
});
