// Tests for the SessionEnd metrics writer. Run:
//   node --test "hooks/test/*.test.mjs"
// The hook parses the session transcript and appends one row to
// $CODE4FOOD_METRICS_DIR/metrics.jsonl — only for opted-in projects,
// never breaking a session (exit 0 always).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HOOK = new URL("../session-metrics.mjs", import.meta.url).pathname;

const makeDir = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "metrics-test-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return fs.realpathSync(d);
};

const optIn = (root) => {
  fs.mkdirSync(path.join(root, ".docs"), { recursive: true });
  fs.writeFileSync(path.join(root, ".docs", "index.md"), "# map\n");
};

// Mirrors the real CLI transcript shape: every assistant line carries a
// message.id, and one message may span several lines (one per content
// block) sharing id and usage. context === null models a usage-less line.
const assistant = (id, context, ...toolNames) => JSON.stringify({
  type: "assistant",
  message: {
    id,
    ...(context === null ? {} : {
      usage: { input_tokens: context, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 },
    }),
    content: toolNames.map((name) => ({ type: "tool_use", name, input: {} })),
  },
});

const DENIAL_LINE = JSON.stringify({
  type: "user",
  message: { content: [{ type: "tool_result", content: "The user doesn't want to proceed with this tool use. The tool use was rejected." }] },
});

const writeTranscript = (dir, lines) => {
  const p = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(p, lines.join("\n") + "\n");
  return p;
};

const run = (project, metricsDir, input) => spawnSync(process.execPath, [HOOK], {
  input: JSON.stringify(input),
  encoding: "utf8",
  env: { ...process.env, CODE4FOOD_METRICS_DIR: metricsDir },
});

const readRows = (metricsDir) => {
  const p = path.join(metricsDir, "metrics.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));
};

test("opted-in session → one schema-aligned row", (t) => {
  const project = makeDir(t);
  optIn(project);
  const out = makeDir(t);
  const transcript = writeTranscript(project, [
    assistant("m1", 1000, "Bash"),
    "not json at all",
    DENIAL_LINE,
    assistant("m2", 5000, "Edit", "Bash"),
    assistant("m3", 3000),
  ]);
  const r = run(project, out, {
    hook_event_name: "SessionEnd", cwd: project, transcript_path: transcript,
    session_id: "sess-1", reason: "exit",
  });
  assert.equal(r.status, 0, `stderr:\n${r.stderr}`);
  const rows = readRows(out);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.mode, "piloted");
  assert.equal(row.project, path.basename(project));
  assert.equal(row.sessionId, "sess-1");
  assert.equal(row.endReason, "exit");
  assert.equal(row.turns, 3);
  assert.equal(row.peakContext, 5000);
  assert.equal(row.denials, 1);
  assert.deepEqual(row.tools, { Bash: 2, Edit: 1 });
  assert.ok(Array.isArray(row.trajectory) && row.trajectory.length === 3);
  assert.ok(row.ts, "row must carry a timestamp");
});

test("split-message transcripts count messages, not lines — and usage-less lines never count a turn", (t) => {
  const project = makeDir(t);
  optIn(project);
  const out = makeDir(t);
  const transcript = writeTranscript(project, [
    assistant("a", 1000, "Bash"),
    assistant("a", 1000, "Edit"),
    assistant("a", 1000),
    assistant("b", 2000, "Bash"),
    assistant("c", null, "Grep"),
  ]);
  const r = run(project, out, { cwd: project, transcript_path: transcript });
  assert.equal(r.status, 0, `stderr:\n${r.stderr}`);
  const row = readRows(out)[0];
  assert.equal(row.turns, 2, "three lines of message 'a' are ONE turn; usage-less 'c' is none");
  assert.equal(row.peakContext, 2000);
  assert.deepEqual(row.tools, { Bash: 2, Edit: 1, Grep: 1 }, "tools count across all lines regardless");
});

test("factory session worktrees are the driver's territory → no row (driver metrics already cover them)", (t) => {
  const base = makeDir(t);
  const project = path.join(base, ".factory", "worktrees", "someproj", "task-branch");
  fs.mkdirSync(project, { recursive: true });
  optIn(project);
  const out = makeDir(t);
  const transcript = writeTranscript(project, [assistant("m1", 1000)]);
  const r = run(project, out, { cwd: project, transcript_path: transcript });
  assert.equal(r.status, 0);
  assert.equal(readRows(out).length, 0);
});

test("non-opted project → no row, exit 0", (t) => {
  const project = makeDir(t);
  const out = makeDir(t);
  const transcript = writeTranscript(project, [assistant("m1", 1000)]);
  const r = run(project, out, { cwd: project, transcript_path: transcript });
  assert.equal(r.status, 0);
  assert.equal(readRows(out).length, 0);
});

test("missing transcript → no row, exit 0 (metrics never break a session)", (t) => {
  const project = makeDir(t);
  optIn(project);
  const out = makeDir(t);
  const r = run(project, out, { cwd: project, transcript_path: path.join(project, "nope.jsonl") });
  assert.equal(r.status, 0);
  assert.equal(readRows(out).length, 0);
});

test("malformed stdin → silent, exit 0", (t) => {
  const out = makeDir(t);
  const r = spawnSync(process.execPath, [HOOK], {
    input: "garbage", encoding: "utf8",
    env: { ...process.env, CODE4FOOD_METRICS_DIR: out },
  });
  assert.equal(r.status, 0);
  assert.equal(readRows(out).length, 0);
});

test("rows append across sessions", (t) => {
  const project = makeDir(t);
  optIn(project);
  const out = makeDir(t);
  const transcript = writeTranscript(project, [assistant("m1", 100)]);
  const input = { cwd: project, transcript_path: transcript, session_id: "s", reason: "clear" };
  assert.equal(run(project, out, input).status, 0);
  assert.equal(run(project, out, input).status, 0);
  assert.equal(readRows(out).length, 2);
});

test("long sessions decimate the trajectory to ≤101 points; peak stays exact", (t) => {
  const project = makeDir(t);
  optIn(project);
  const out = makeDir(t);
  const lines = [];
  for (let i = 0; i < 500; i++) lines.push(assistant(`m${i}`, i === 371 ? 99999 : 1000 + i));
  const transcript = writeTranscript(project, lines);
  const r = run(project, out, { cwd: project, transcript_path: transcript });
  assert.equal(r.status, 0);
  const row = readRows(out)[0];
  assert.equal(row.turns, 500);
  assert.equal(row.peakContext, 99999);
  assert.ok(row.trajectory.length <= 101, `trajectory has ${row.trajectory.length} points`);
  assert.equal(row.trajectory[row.trajectory.length - 1].t, 499, "last point must be the final turn");
});
