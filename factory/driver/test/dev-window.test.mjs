import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeFactory, queueSessions, runDriver, readUsageRows } from "./helpers.mjs";

test("stale plan entries already settled in the backlog are skipped, not re-assigned", (t) => {
  const world = makeFactory(t, {
    config: { maxSessionsPerWindow: 1 },
    tasks: `# Epic 1

## T-001: merged last window
- Status: done
- Reqs: REQ-1
- Acceptance: it works
- Verify: true

## T-002: waiting on a human
- Status: blocked
- Reqs: REQ-1
- Acceptance: it works
- Verify: true

## T-003: still open
- Status: todo
- Reqs: REQ-1
- Acceptance: it works
- Verify: true
`,
  });
  // A fresh plan from this morning's triage — T-001/T-002 settled since.
  fs.writeFileSync(
    path.join(world.stateDir, "plan.json"),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      queue: [
        { taskId: "T-001", model: "sonnet", effort: "low" },
        { taskId: "T-002", model: "sonnet", effort: "low" },
        { taskId: "T-003", model: "sonnet", effort: "low" },
      ],
    })
  );
  queueSessions(world, [
    {
      script: `mkdir -p .factory/log && cat > .factory/log/last-session.json <<'EOF'
{"taskId": "T-003", "status": "completed", "summary": "built T-003"}
EOF`,
      stdout: { type: "result", subtype: "success", result: "done", total_cost_usd: 0.02, num_turns: 5, usage: { input_tokens: 10, output_tokens: 20 } },
      exit: 0,
    },
  ]);

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /plan: skipping T-001 \(backlog says done\)/);
  assert.match(r.stdout, /plan: skipping T-002 \(backlog says blocked\)/);
  assert.match(r.stdout, /session 1 starting \(plan: T-003/);
  const inv = JSON.parse(fs.readFileSync(path.join(world.stubDir, "invocation-1.json"), "utf8"));
  assert.match(inv.prompt, /Your task this session: T-003/);
  const rows = readUsageRows(world);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].taskId, "T-003");
});

test("a task's Model: pin raises the session launch model — never lowers it (PR-F)", (t) => {
  const world = makeFactory(t, {
    config: { maxSessionsPerWindow: 3, model: "sonnet" },
    tasks: `# Epic 1

## T-001: behavior-defining task
- Status: todo
- Reqs: REQ-1
- Acceptance: it works
- Verify: true
- Model: opus
- Effort: high

## T-002: rubric task triage forgot to plan a model for
- Status: todo
- Reqs: REQ-1
- Acceptance: it works
- Verify: true
- Model: fable
- Effort: high

## T-003: mechanical task the plan deliberately runs higher
- Status: todo
- Reqs: REQ-1
- Acceptance: it works
- Verify: true
- Model: sonnet
- Effort: low
`,
  });
  fs.writeFileSync(
    path.join(world.stateDir, "plan.json"),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      queue: [
        { taskId: "T-001", model: "sonnet", effort: "high" }, // below the pin — must be raised
        { taskId: "T-002", effort: "high" }, // no model — the pin fills it
        { taskId: "T-003", model: "opus", effort: "low" }, // above the pin — plan's correction wins
      ],
    })
  );
  const REPORT = (id) => `mkdir -p .factory/log && cat > .factory/log/last-session.json <<'EOF'
{"taskId": "${id}", "status": "completed", "summary": "done"}
EOF`;
  const OK = { type: "result", subtype: "success", result: "done", total_cost_usd: 0.01, num_turns: 2, usage: { input_tokens: 1, output_tokens: 1 } };
  queueSessions(world, [
    { script: REPORT("T-001"), stdout: OK, exit: 0 },
    { script: REPORT("T-002"), stdout: OK, exit: 0 },
    { script: REPORT("T-003"), stdout: OK, exit: 0 },
  ]);

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const modelOf = (n) => {
    const args = JSON.parse(fs.readFileSync(path.join(world.stubDir, `invocation-${n}.json`), "utf8")).args;
    return args[args.indexOf("--model") + 1];
  };
  assert.equal(modelOf(1), "opus", "plan below the pin must launch with the pin");
  assert.match(r.stdout, /model pin: T-001 .*opus/);
  // The session must be TOLD it runs the raised model — the config dump
  // still says sonnet, and the prompt's tier rule would otherwise make a
  // rule-compliant session refuse its own assignment.
  const prompt1 = JSON.parse(fs.readFileSync(path.join(world.stubDir, "invocation-1.json"), "utf8")).prompt;
  assert.match(prompt1, /Your session model: opus/, "assignment must state the raised launch model");
  assert.equal(modelOf(2), "fable", "missing plan model must fall back to the pin");
  assert.equal(modelOf(3), "opus", "a pin never lowers a deliberately higher plan model");
  // usage rows record what actually launched
  const rows = readUsageRows(world);
  assert.deepEqual(rows.map((x) => x.model), ["opus", "fable", "opus"]);
});

test("dev window ends cleanly when a session reports no-tasks", (t) => {
  const world = makeFactory(t);
  queueSessions(world, [
    {
      script: `mkdir -p .factory/log && cat > .factory/log/last-session.json <<'EOF'
{"taskId": null, "status": "no-tasks", "summary": "backlog empty or blocked"}
EOF`,
      stdout: { type: "result", subtype: "success", result: "no eligible tasks", total_cost_usd: 0.01, num_turns: 3, usage: { input_tokens: 10, output_tokens: 20 } },
      exit: 0,
    },
  ]);

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /no eligible tasks — ending window/);
  assert.match(r.stdout, /dev window finished: 1 session/);
  const rows = readUsageRows(world);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "no-tasks");
  assert.equal(rows[0].costUsd, 0.01);
  // Sessions carry the guard-hook env: mode + base branch (O3).
  const inv = JSON.parse(fs.readFileSync(path.join(world.stubDir, "invocation-1.json"), "utf8"));
  assert.equal(inv.factoryMode, "dev");
  assert.equal(inv.factoryBaseBranch, "main");
});

test("session prompts come from the runtime checkout, not the project (O6)", (t) => {
  const world = makeFactory(t); // fixture carries no .factory/prompts/ at all
  queueSessions(world, [
    {
      stdout: { type: "result", subtype: "success", result: "nothing to do", total_cost_usd: 0.01, num_turns: 2, usage: { input_tokens: 5, output_tokens: 5 } },
      exit: 0,
    },
  ]);

  const r = runDriver(world, "dev", ["--max-sessions", "1"]);

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const inv = JSON.parse(fs.readFileSync(path.join(world.stubDir, "invocation-1.json"), "utf8"));
  // The real repo prompt, resolved beside the driver.
  assert.match(inv.prompt, /You are one session in an unattended Factory window/);
});

test("session prompts carry the machine config — worktrees have no .factory/config.json to read", (t) => {
  const world = makeFactory(t);
  queueSessions(world, [
    {
      stdout: { type: "result", subtype: "success", result: "nothing to do", total_cost_usd: 0.01, num_turns: 2, usage: { input_tokens: 5, output_tokens: 5 } },
      exit: 0,
    },
  ]);

  const r = runDriver(world, "dev", ["--max-sessions", "1"]);

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const inv = JSON.parse(fs.readFileSync(path.join(world.stubDir, "invocation-1.json"), "utf8"));
  assert.match(inv.prompt, /## Factory config/, "config section appended to the prompt");
  assert.match(inv.prompt, /"autonomy": "pr-only"/, "config values ride the prompt");
  assert.match(inv.prompt, /"baseBranch": "main"/);
});

test("two consecutive silent deaths end the window — even when the first is session 1", (t) => {
  const world = makeFactory(t);
  // Three dead sessions queued: no result event, no last-session.json,
  // exit 1 — the breaker must fire after the SECOND, never spending a third.
  queueSessions(world, [
    { stdout: "", exit: 1 },
    { stdout: "", exit: 1 },
    { stdout: "", exit: 1 },
  ]);

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /two consecutive sessions died/);
  assert.ok(fs.existsSync(path.join(world.stubDir, "invocation-2.json")), "second session should have run");
  assert.ok(!fs.existsSync(path.join(world.stubDir, "invocation-3.json")), "breaker must trip before a third session");
});

// --- PR-C: derived factory status skips windows with no actionable work ---

const gatedTask = (id, status) => `## ${id}: task ${id}

- Status: ${status}
- Reqs: REQ-1
- Acceptance: it works
- Verify: true
`;

test("a window with only needs-human tasks is skipped before any paid session", (t) => {
  const world = makeFactory(t, {
    tasks: `# Epic 1\n\n${gatedTask("T-001", "needs-human")}\n${gatedTask("T-002", "blocked")}`,
  });
  queueSessions(world, [
    { script: `mkdir -p .factory/log && printf '%s' '{"taskId":null,"status":"no-tasks","summary":"n"}' > .factory/log/last-session.json`, stdout: JSON.stringify({ type: "result", subtype: "success", result: "n", total_cost_usd: 0.01, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } }) + "\n", exit: 0 },
  ]);

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.ok(!fs.existsSync(path.join(world.stubDir, "invocation-1.json")),
    "no session may spawn when every open task waits on the owner");
  assert.match(r.stdout, /window skipped/);
  assert.match(r.stdout, /waiting on owner \(1\): T-001/);
});

test("a window where every open task is dependency-blocked reports deadlocked", (t) => {
  const world = makeFactory(t, {
    tasks: `# Epic 1\n\n${gatedTask("T-001", "blocked")}`,
  });
  queueSessions(world, [
    { script: `mkdir -p .factory/log && printf '%s' '{"taskId":null,"status":"no-tasks","summary":"n"}' > .factory/log/last-session.json`, stdout: JSON.stringify({ type: "result", subtype: "success", result: "n", total_cost_usd: 0.01, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } }) + "\n", exit: 0 },
  ]);

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.ok(!fs.existsSync(path.join(world.stubDir, "invocation-1.json")),
    "no session may spawn when nothing is machine-actionable");
  assert.match(r.stdout, /deadlocked/);
});

test("a fully-done backlog skips the window instead of burning a probe session", (t) => {
  const world = makeFactory(t, {
    tasks: `# Epic 1\n\n${gatedTask("T-001", "done")}`,
  });
  queueSessions(world, [
    { script: `mkdir -p .factory/log && printf '%s' '{"taskId":null,"status":"no-tasks","summary":"n"}' > .factory/log/last-session.json`, stdout: JSON.stringify({ type: "result", subtype: "success", result: "n", total_cost_usd: 0.01, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } }) + "\n", exit: 0 },
  ]);

  const r = runDriver(world, "dev");

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.ok(!fs.existsSync(path.join(world.stubDir, "invocation-1.json")),
    "a complete backlog needs no probe session");
  assert.match(r.stdout, /window skipped/);
  assert.match(r.stdout, /backlog complete/);
});

test("a session question carrying a taskId parks the task needs-human with the issue linked", (t) => {
  const world = makeFactory(t);
  // gh stub: filing the question returns an issue URL the task must link.
  const ghDir = path.join(world.root, "stub-gh");
  fs.mkdirSync(ghDir, { recursive: true });
  fs.writeFileSync(path.join(ghDir, "gh"), `#!/bin/sh
case "$1 $2" in
  "issue list") echo '[]' ;;
  "issue create") echo 'https://github.com/o/r/issues/42' ;;
  *) echo "" ;;
esac
exit 0
`);
  fs.chmodSync(path.join(ghDir, "gh"), 0o755);
  fs.appendFileSync(path.join(world.stateDir, ".env"), `STUB_GH_DIR=${ghDir}\n`);
  queueSessions(world, [
    {
      script: `printf '%s\\n' '{"ts":"t","event":"open_question","title":"T-001 rig quality needs owner eyes","body":"cannot judge clips headless","taskId":"T-001"}' >> "$FACTORY_MCP_EVENTS"
printf '%s\\n' '{"ts":"t","event":"report_status","taskId":"T-001","status":"blocked","summary":"cannot self-judge","pr":null}' >> "$FACTORY_MCP_EVENTS"`,
      stdout: JSON.stringify({ type: "result", subtype: "success", result: "blocked", total_cost_usd: 0.02, num_turns: 5, usage: { input_tokens: 1, output_tokens: 1 } }) + "\n",
      exit: 0,
    },
  ]);

  const r = runDriver(world, "dev", ["--max-sessions", "1"]);

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const epic = fs.readFileSync(path.join(world.factoryDir, "backlog", "e1.md"), "utf8");
  assert.match(epic, /- Status: needs-human/,
    "a cannot-self-judge question must park the task for the owner, not leave it machine-blocked");
  assert.match(epic, /- Question: https:\/\/github\.com\/o\/r\/issues\/42/,
    "the filed issue must be linked on the task");
});

test("with tracker jira, a session question files to Jira and never touches the forge tracker", (t) => {
  const world = makeFactory(t, { config: { tracker: "jira", jiraProject: "FACT" } });
  // curl stub answers the Jira API; gh logs would betray a forge-tracker leak.
  const ghDir = path.join(world.root, "stub-gh");
  fs.mkdirSync(ghDir, { recursive: true });
  fs.writeFileSync(path.join(ghDir, "gh"), `#!/bin/sh
printf '%s\\n' "$*" >> "${ghDir}/gh-calls.log"
echo ""
exit 0
`);
  fs.chmodSync(path.join(ghDir, "gh"), 0o755);
  fs.appendFileSync(path.join(world.stateDir, ".env"),
    `STUB_GH_DIR=${ghDir}\nJIRA_BASE_URL=https://acme.atlassian.net\nJIRA_EMAIL=m@example.com\nJIRA_API_TOKEN=tok\n`);
  fs.writeFileSync(path.join(world.root, "bin", "curl"), `#!/bin/sh
printf '%s\\n' "$*" >> "${ghDir}/curl-calls.log"
for a in "$@"; do url="$a"; done
case "$url" in
  *"/rest/api/3/search/jql"*) cat > /dev/null; echo '{"issues": []}' ;;
  *"/rest/api/3/issue"*) cat > /dev/null; echo '{"key": "FACT-7"}' ;;
  *) cat > /dev/null; echo '{}' ;;
esac
exit 0
`);
  fs.chmodSync(path.join(world.root, "bin", "curl"), 0o755);
  queueSessions(world, [
    {
      script: `printf '%s\\n' '{"ts":"t","event":"open_question","title":"T-001 rig quality needs owner eyes","body":"cannot judge clips headless","taskId":"T-001"}' >> "$FACTORY_MCP_EVENTS"
printf '%s\\n' '{"ts":"t","event":"report_status","taskId":"T-001","status":"blocked","summary":"cannot self-judge","pr":null}' >> "$FACTORY_MCP_EVENTS"`,
      stdout: JSON.stringify({ type: "result", subtype: "success", result: "blocked", total_cost_usd: 0.02, num_turns: 5, usage: { input_tokens: 1, output_tokens: 1 } }) + "\n",
      exit: 0,
    },
  ]);

  const r = runDriver(world, "dev", ["--max-sessions", "1"]);

  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const epic = fs.readFileSync(path.join(world.factoryDir, "backlog", "e1.md"), "utf8");
  assert.match(epic, /- Status: needs-human/);
  assert.match(epic, /- Question: https:\/\/acme\.atlassian\.net\/browse\/FACT-7/,
    "the filed Jira issue must be linked on the task");
  const ghCalls = fs.existsSync(path.join(ghDir, "gh-calls.log")) ? fs.readFileSync(path.join(ghDir, "gh-calls.log"), "utf8") : "";
  assert.ok(!/issue/.test(ghCalls), `question leaked to the forge tracker:\n${ghCalls}`);
});
