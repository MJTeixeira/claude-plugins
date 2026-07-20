// Driver-side forge access for triage/report (factory 1.8.0): the driver
// pre-collects forge/tracker reads into a "## Forge inputs" prompt section
// and posts the daily log itself from post_daily_log MCP events — sessions
// never shell out with credentials (the live-disproven leg, NOTES item 62).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeFactory, queueSessions, runDriver } from "./helpers.mjs";

const RESULT_EVENT = { type: "result", subtype: "success", result: "ok", total_cost_usd: 0.01, num_turns: 3, usage: { input_tokens: 10, output_tokens: 20 } };
const SETTLE = (mode) => `printf '%s\\n' '{"ts":"t","event":"report_status","taskId":null,"status":"completed","summary":"${mode} done","pr":null}' >> "$FACTORY_MCP_EVENTS"`;
const OK_SESSION = (mode) => ({ script: SETTLE(mode), stdout: RESULT_EVENT, exit: 0 });

// Programmable gh handed off via STUB_GH_DIR (the world's PATH stub execs it
// after answering `auth status` itself). Canned answers per subcommand.
const withGh = (world, files = {}) => {
  const dir = path.join(world.root, "stub-gh");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "gh"), `#!/bin/sh
ROOT="$(dirname "$0")"
printf '%s\\n' "$*" >> "$ROOT/calls.log"
case "$1 $2" in
  "pr list")
    case "$*" in
      *"--state merged"*) cat "$ROOT/pr-merged.json" ;;
      *"--json"*) cat "$ROOT/pr-list.json" ;;
      *) echo "" ;;
    esac ;;
  "pr view")
    case "$*" in
      *"--json comments"*) cat "$ROOT/pr-comments.json" ;;
      *) cat "$ROOT/pr-view.json" ;;
    esac ;;
  "issue list")
    if [ -s "$ROOT/issues-fail" ]; then echo "gh boom" >&2; exit 1; fi
    case "$*" in
      *"--state closed"*) cat "$ROOT/issue-closed.json" ;;
      *) cat "$ROOT/issue-list.json" ;;
    esac ;;
  "issue view") cat "$ROOT/issue-comments.json" ;;
  "issue create") echo "https://github.com/o/r/issues/50" ;;
  "issue comment") echo "" ;;
  *) echo "" ;;
esac
exit 0
`);
  fs.chmodSync(path.join(dir, "gh"), 0o755);
  const defaults = {
    "pr-list.json": "[]",
    "pr-merged.json": "[]",
    "pr-comments.json": JSON.stringify({ comments: [] }),
    "pr-view.json": JSON.stringify({ state: "OPEN", statusCheckRollup: [] }),
    "issue-list.json": "[]",
    "issue-closed.json": "[]",
    "issue-comments.json": JSON.stringify({ comments: [] }),
    "issues-fail": "",
  };
  for (const [k, v] of Object.entries({ ...defaults, ...files })) fs.writeFileSync(path.join(dir, k), v);
  world.extraEnv = { ...(world.extraEnv ?? {}), STUB_GH_DIR: dir };
  return { calls: () => (fs.existsSync(path.join(dir, "calls.log")) ? fs.readFileSync(path.join(dir, "calls.log"), "utf8") : "") };
};

const invocation = (world, n) => JSON.parse(fs.readFileSync(path.join(world.stubDir, `invocation-${n}.json`), "utf8"));
const readState = (world) => JSON.parse(fs.readFileSync(path.join(world.stateDir, "log", "state.json"), "utf8"));

test("triage prompt carries driver-collected forge inputs — issues+comments, PR comments, merged PRs", (t) => {
  const world = makeFactory(t);
  withGh(world, {
    "issue-list.json": JSON.stringify([{ number: 9, title: "[factory] question: pick a color", url: "u9" }]),
    "issue-comments.json": JSON.stringify({ comments: [{ author: { login: "owner1" }, body: "answer: blue", createdAt: "2026-07-20T10:00:00Z" }] }),
    "pr-list.json": JSON.stringify([{ number: 7, url: "u7", title: "[factory] T-010: x", headRefName: "factory/T-010", isDraft: false }]),
    "pr-comments.json": JSON.stringify({ comments: [{ author: { login: "owner1" }, body: "please target develop", createdAt: "2026-07-20T11:00:00Z" }] }),
    "pr-merged.json": JSON.stringify([{ number: 6, url: "u6", title: "[factory] T-002: y", headRefName: "factory/T-002" }]),
    "issue-closed.json": JSON.stringify([{ number: 2, title: "[factory] question: which db", url: "u2" }]),
  });
  queueSessions(world, [OK_SESSION("triage")]);
  const r = runDriver(world, "triage");
  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const prompt = invocation(world, 1).prompt;
  assert.match(prompt, /## Forge inputs/);
  assert.match(prompt, /pick a color/, "open tracker issues must be listed");
  assert.match(prompt, /answer: blue/, "issue comments must be inlined");
  assert.match(prompt, /please target develop/, "factory PR comments must be inlined");
  assert.match(prompt, /\[factory\] T-002: y/, "merged PRs must be listed (status safety net)");
  assert.match(prompt, /which db/, "recently closed issues must be listed (answers live there)");
});

test("report prompt gets the same forge inputs section", (t) => {
  const world = makeFactory(t);
  withGh(world, {
    "pr-list.json": JSON.stringify([{ number: 7, url: "u7", title: "[factory] T-010: x", headRefName: "factory/T-010", isDraft: false }]),
  });
  queueSessions(world, [OK_SESSION("report")]);
  const r = runDriver(world, "report");
  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const prompt = invocation(world, 1).prompt;
  assert.match(prompt, /## Forge inputs/);
  assert.match(prompt, /\[factory\] T-010: x/);
  // report.md tells the session to include check status — the collector
  // must supply it (empty rollup reads "none": no CI, not pending).
  assert.match(prompt, /checks: none/);
});

test("a failing forge read degrades its block to (unavailable) — the session still runs", (t) => {
  const world = makeFactory(t);
  withGh(world, { "issues-fail": "yes" });
  queueSessions(world, [OK_SESSION("triage")]);
  const r = runDriver(world, "triage");
  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const prompt = invocation(world, 1).prompt;
  assert.match(prompt, /## Forge inputs/);
  assert.match(prompt, /\(unavailable/, "a failed block must say so, not vanish");
});

test("driver creates the daily-log issue from a post_daily_log event when none exists", (t) => {
  const world = makeFactory(t);
  const gh = withGh(world);
  queueSessions(world, [{
    script: `printf '%s\\n' '{"ts":"t","event":"daily_log","body":"## Plan of day: nothing new"}' >> "$FACTORY_MCP_EVENTS"\n${SETTLE("triage")}`,
    stdout: RESULT_EVENT, exit: 0,
  }]);
  const r = runDriver(world, "triage");
  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(gh.calls(), /issue create.*\[factory\] daily log/, "must create the daily-log issue");
  assert.match(r.stdout, /daily log/i);
});

test("driver comments on the existing daily-log issue instead of creating a duplicate", (t) => {
  const world = makeFactory(t);
  const gh = withGh(world, {
    "issue-list.json": JSON.stringify([{ number: 5, title: "[factory] daily log", url: "u5" }]),
  });
  queueSessions(world, [{
    script: `printf '%s\\n' '{"ts":"t","event":"daily_log","body":"## Plan of day: T-003 next"}' >> "$FACTORY_MCP_EVENTS"\n${SETTLE("triage")}`,
    stdout: RESULT_EVENT, exit: 0,
  }]);
  const r = runDriver(world, "triage");
  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const calls = gh.calls();
  assert.match(calls, /issue comment 5/, "must comment on the existing issue");
  assert.doesNotMatch(calls, /issue create/, "must not create a duplicate");
});

test("two daily-log entries in one batch create the issue once and comment for the rest — no duplicates", (t) => {
  const world = makeFactory(t);
  const gh = withGh(world);
  queueSessions(world, [{
    script: [
      `printf '%s\\n' '{"ts":"t","event":"daily_log","body":"yesterday (queued retry)"}' >> "$FACTORY_MCP_EVENTS"`,
      `printf '%s\\n' '{"ts":"t","event":"daily_log","body":"today"}' >> "$FACTORY_MCP_EVENTS"`,
      SETTLE("triage"),
    ].join("\n"),
    stdout: RESULT_EVENT, exit: 0,
  }]);
  const r = runDriver(world, "triage");
  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const calls = gh.calls();
  assert.equal((calls.match(/issue create/g) ?? []).length, 1, "the daily-log issue must be created exactly once");
  assert.match(calls, /issue comment 50/, "the second entry must comment on the issue just created (url #50)");
});

test("an unpostable daily log queues in state and announces — never silently lost", (t) => {
  const world = makeFactory(t);
  withGh(world, { "issues-fail": "yes" });
  queueSessions(world, [{
    script: `printf '%s\\n' '{"ts":"t","event":"daily_log","body":"## Plan of day: stranded"}' >> "$FACTORY_MCP_EVENTS"\n${SETTLE("triage")}`,
    stdout: RESULT_EVENT, exit: 0,
  }]);
  const r = runDriver(world, "triage");
  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const pending = readState(world).pendingDailyLogs ?? [];
  assert.equal(pending.length, 1);
  assert.match(pending[0].body, /stranded/);
  assert.match(r.stdout, /daily log.*(queued|could not)/i, "failure must be announced out-of-band");
});
