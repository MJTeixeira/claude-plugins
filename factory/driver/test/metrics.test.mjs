// Per-session metrics (autonomy epic chunk 5): every session the driver
// spawns leaves one row in <state>/log/metrics.jsonl — end reason, peak
// context, per-turn token trajectory, permission-denial count and tool
// histogram — extracted from the stream-json .out the driver already keeps.
// The no-progress breaker (chunk 6) and plan correction consume these rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeFactory, queueSessions, runDriver, readMetricsRows } from "./helpers.mjs";

const stream = (events) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

const assistant = ({ output, input, cacheRead, cacheCreate, tools = [], text }) => ({
  type: "assistant",
  message: {
    usage: {
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheCreate,
    },
    content: [
      ...tools.map((name) => ({ type: "tool_use", name, input: {} })),
      ...(text ? [{ type: "text", text }] : []),
    ],
  },
});

const PLAN = {
  generatedAt: new Date().toISOString(),
  queue: [{ taskId: "T-001", model: "sonnet", effort: "low" }],
};

const report = `mkdir -p .factory/log && printf '%s' '{"taskId":"T-001","status":"completed","summary":"built T-001"}' > .factory/log/last-session.json`;

test("a completed session lands one metrics row: end reason, peak context, trajectory, denials, tool histogram", (t) => {
  const world = makeFactory(t, { config: { maxSessionsPerWindow: 1 }, plan: PLAN });
  queueSessions(world, [
    {
      script: report,
      stdout: stream([
        { type: "system", subtype: "init" },
        assistant({ input: 100, output: 50, cacheRead: 1000, cacheCreate: 200, tools: ["Bash", "Read"] }),
        assistant({ input: 150, output: 80, cacheRead: 2000, cacheCreate: 100, tools: ["Bash"], text: "done" }),
        {
          type: "result", subtype: "success", is_error: false, result: "done",
          total_cost_usd: 0.1, num_turns: 7,
          permission_denials: [{ tool_name: "Bash" }, { tool_name: "Write" }],
          usage: { input_tokens: 250, output_tokens: 130 },
        },
      ]),
      exit: 0,
    },
  ]);

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const rows = readMetricsRows(world);
  assert.equal(rows.length, 1);
  const m = rows[0];
  assert.equal(m.mode, "dev");
  assert.equal(m.taskId, "T-001");
  assert.equal(m.endReason, "success");
  assert.equal(m.turns, 7);
  assert.equal(m.peakContext, 2250); // second turn: 150 + 2000 + 100
  assert.deepEqual(m.trajectory, [
    { output: 50, context: 1300 },
    { output: 80, context: 2250 },
  ]);
  assert.equal(m.denials, 2);
  assert.deepEqual(m.tools, { Bash: 2, Read: 1 });
});

test("a killed session (no result event) still lands a row — endReason killed, partial trajectory, unknown denials", (t) => {
  const world = makeFactory(t, { config: { maxSessionsPerWindow: 1 }, plan: PLAN });
  queueSessions(world, [
    {
      stdout: stream([
        { type: "system", subtype: "init" },
        assistant({ input: 100, output: 40, cacheRead: 500, cacheCreate: 0, tools: ["Read"] }),
      ]),
      exit: 1,
    },
  ]);

  runDriver(world, "dev");

  const rows = readMetricsRows(world);
  assert.equal(rows.length, 1);
  const m = rows[0];
  assert.equal(m.endReason, "killed");
  assert.equal(m.turns, null);
  assert.equal(m.denials, null);
  assert.equal(m.peakContext, 600);
  assert.deepEqual(m.trajectory, [{ output: 40, context: 600 }]);
  assert.deepEqual(m.tools, { Read: 1 });
});

test("a session with no parseable output at all still exists in metrics.jsonl — endReason no-output", (t) => {
  const world = makeFactory(t, { config: { maxSessionsPerWindow: 1 }, plan: PLAN });
  queueSessions(world, [{ stdout: "", exit: 1 }]);

  runDriver(world, "dev");

  const rows = readMetricsRows(world);
  assert.equal(rows.length, 1);
  const m = rows[0];
  assert.equal(m.endReason, "no-output");
  assert.equal(m.peakContext, null);
  assert.deepEqual(m.trajectory, []);
  assert.equal(m.denials, null);
  assert.deepEqual(m.tools, {});
});

test("a rate-limited session's end reason surfaces the API error, not success", (t) => {
  const world = makeFactory(t, { config: { maxSessionsPerWindow: 1 }, plan: PLAN });
  queueSessions(world, [
    {
      stdout: stream([
        { type: "system", subtype: "init" },
        {
          type: "result", subtype: "success", is_error: true, api_error_status: 429,
          terminal_reason: "api_error", result: "You've hit your session limit",
          num_turns: 1, usage: { input_tokens: 0, output_tokens: 0 },
        },
      ]),
      exit: 1,
    },
  ]);

  runDriver(world, "dev");

  const rows = readMetricsRows(world);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].endReason, "api_error");
});
