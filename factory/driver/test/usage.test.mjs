import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFactory, queueSessions, runDriver, readUsageRows } from "./helpers.mjs";

const streamEvent = (o) => JSON.stringify(o) + "\n";
const assistantEvent = (usage) =>
  streamEvent({ type: "assistant", message: { role: "assistant", usage } });
const resultEvent = (extra) =>
  streamEvent({ type: "result", subtype: "success", result: "done", ...extra });

test("killed session records summed per-message tokens instead of a null row", (t) => {
  const world = makeFactory(t, { config: { sessionTimeoutMin: 0.15 } }); // 9s timeout — roomy for loaded CI, far under the 30s hang
  queueSessions(world, [
    {
      // Emits real usage, then hangs past the timeout — the driver kills it.
      stdout:
        assistantEvent({ input_tokens: 5, output_tokens: 100, cache_read_input_tokens: 4000, cache_creation_input_tokens: 1000 }) +
        assistantEvent({ input_tokens: 3, output_tokens: 250, cache_read_input_tokens: 6000, cache_creation_input_tokens: 500 }),
      sleepMs: 30_000,
      exit: 0,
    },
    // Second session reports no-tasks so the window ends.
    {
      script: `mkdir -p .factory/log && echo '{"taskId":null,"status":"no-tasks","summary":"none"}' > .factory/log/last-session.json`,
      stdout: resultEvent({ total_cost_usd: 0.01, num_turns: 2, usage: { input_tokens: 1, output_tokens: 2 } }),
      exit: 0,
    },
  ]);

  const r = runDriver(world, "dev");
  assert.equal(r.code, 0, `driver exited ${r.code}\n${r.stdout}\n${r.stderr}`);
  const rows = readUsageRows(world);
  assert.equal(rows.length, 2, JSON.stringify(rows, null, 2));
  const killed = rows[0];
  assert.equal(killed.status, "timeout");
  assert.equal(killed.costUsd, null); // cost is only known from a final result event
  assert.equal(killed.outputTokens, 350, "per-message output tokens not summed");
  assert.equal(killed.inputTokens, 8);
  assert.equal(killed.cacheReadTokens, 10_000);
  assert.equal(killed.cacheCreateTokens, 1_500);
});

test("turn-capped stream session is classified as unfinished wrap-up, not a death", (t) => {
  const world = makeFactory(t);
  queueSessions(world, [
    {
      // Turn cap: exits 1 with an error_max_turns result event, no last-session.json.
      stdout:
        assistantEvent({ input_tokens: 2, output_tokens: 10 }) +
        streamEvent({ type: "result", subtype: "error_max_turns", result: "ran out of turns mid-wrap-up", total_cost_usd: 0.5, num_turns: 80, usage: { input_tokens: 2, output_tokens: 10 } }),
      exit: 1,
    },
    {
      script: `mkdir -p .factory/log && echo '{"taskId":null,"status":"no-tasks","summary":"none"}' > .factory/log/last-session.json`,
      stdout: resultEvent({ total_cost_usd: 0.01, num_turns: 2, usage: { input_tokens: 1, output_tokens: 2 } }),
      exit: 0,
    },
  ]);

  const r = runDriver(world, "dev");
  assert.equal(r.code, 0, `driver exited ${r.code}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /turn cap — treating as unfinished wrap-up, not a death/);
  const rows = readUsageRows(world);
  assert.equal(rows[0].status, "turn-capped");
  assert.equal(rows[0].costUsd, 0.5);
  // The next session gets the capped session's final output in its handoff.
  assert.doesNotMatch(r.stdout, /two consecutive sessions died/);
});
