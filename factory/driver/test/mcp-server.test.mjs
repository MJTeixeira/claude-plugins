// factory-v2 O2: the driver's `mcp-server` mode — the stdio MCP reporting
// server each session gets via --mcp-config. Tests speak newline-delimited
// JSON-RPC to a real server child process and assert on the events file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeFactory, queueSessions, runDriver, readUsageRows, driverPath, startTelegramStub } from "./helpers.mjs";

const eventsPathFor = (world) => path.join(world.stateDir, "log", "mcp-test-session.jsonl");

// Send the requests, close stdin, return parsed responses (order preserved).
const runMcp = async (world, requests, extraEnv = {}) => {
  const child = spawn(process.execPath, [driverPath, "mcp-server", "--project", world.project], {
    env: { ...process.env, HOME: world.home, FACTORY_MCP_EVENTS: eventsPathFor(world), ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  child.stdin.write(requests.map((r) => JSON.stringify(r)).join("\n") + "\n");
  child.stdin.end();
  const code = await new Promise((r) => child.on("exit", r));
  assert.equal(code, 0, `mcp-server exited ${code}\nstderr:\n${err}`);
  return out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
};

const readEvents = (world) => {
  const p = eventsPathFor(world);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
};

const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } };
const call = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

test("mcp-server initializes and lists the four session tools", async (t) => {
  const world = makeFactory(t);
  const rs = await runMcp(world, [init, { jsonrpc: "2.0", id: 2, method: "tools/list" }]);
  const initR = rs.find((r) => r.id === 1);
  assert.equal(initR.result.protocolVersion, "2025-06-18"); // echoes the client's version
  assert.ok(initR.result.serverInfo.name);
  const list = rs.find((r) => r.id === 2);
  assert.deepEqual(
    list.result.tools.map((tl) => tl.name).sort(),
    ["create_pr", "log_progress", "open_question", "report_status"]
  );
  for (const tl of list.result.tools) assert.equal(tl.inputSchema.type, "object");
});

test("valid report_status appends a validated row to the events file", async (t) => {
  const world = makeFactory(t);
  const rs = await runMcp(world, [init, call(2, "report_status", { taskId: "T-010", status: "review", summary: "PR opened, checks running", pr: "https://example.com/pr/6" })]);
  const r = rs.find((x) => x.id === 2);
  assert.ok(!r.result.isError, `unexpected tool error: ${JSON.stringify(r.result)}`);
  assert.match(r.result.content[0].text, /T-010/);
  const events = readEvents(world);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "report_status");
  assert.equal(events[0].taskId, "T-010");
  assert.equal(events[0].status, "review");
  assert.equal(events[0].pr, "https://example.com/pr/6");
  assert.ok(events[0].ts);
});

test("unknown status is a tool error and writes no event", async (t) => {
  const world = makeFactory(t);
  const rs = await runMcp(world, [init, call(2, "report_status", { taskId: "T-010", status: "donezo", summary: "x" })]);
  const r = rs.find((x) => x.id === 2);
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /status/);
  assert.equal(readEvents(world).length, 0);
});

test("open_question without a title is a tool error and writes no event", async (t) => {
  const world = makeFactory(t);
  const rs = await runMcp(world, [init, call(2, "open_question", { body: "who owns the API key?" })]);
  const r = rs.find((x) => x.id === 2);
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /title/);
  assert.equal(readEvents(world).length, 0);
});

test("a request split mid-multibyte-character across stdin chunks still gets served", async (t) => {
  const world = makeFactory(t);
  const child = spawn(process.execPath, [driverPath, "mcp-server", "--project", world.project], {
    env: { ...process.env, HOME: world.home, FACTORY_MCP_EVENTS: eventsPathFor(world) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  const gotResponse = (id) =>
    new Promise((resolve) => {
      const check = () => {
        if (out.split("\n").filter(Boolean).some((l) => { try { return JSON.parse(l).id === id; } catch { return false; } })) resolve();
        else setTimeout(check, 20);
      };
      check();
    });
  child.stdout.on("data", (d) => (out += d));
  // Handshake first and WAIT for it — proves the server's stdin loop is
  // live, so the two writes below arrive as genuinely separate chunks.
  child.stdin.write(JSON.stringify(init) + "\n");
  await gotResponse(1);
  const line = Buffer.from(JSON.stringify(call(2, "log_progress", { message: "café ouvert — étape franchie" })) + "\n", "utf8");
  const splitAt = line.indexOf(Buffer.from("é", "utf8")[0]) + 1; // inside the two-byte é
  child.stdin.write(line.subarray(0, splitAt));
  await new Promise((r) => setTimeout(r, 80));
  child.stdin.write(line.subarray(splitAt));
  child.stdin.end();
  await new Promise((r) => child.on("exit", r));
  const rs = out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const r = rs.find((x) => x.id === 2);
  assert.ok(r && !r.result?.isError, `no clean response to the split request: ${out}`);
  const events = readEvents(world);
  assert.equal(events.length, 1);
  assert.equal(events[0].message, "café ouvert — étape franchie");
});

// ---------- create_pr (driver-side PR creation — sessions never touch creds) ----------

// Programmable stub gh on PATH: `pr create` and `pr list` answers come from
// canned files so each test scripts the forge's behavior.
const withGh = (world, { createOut, createFail = false, listJson = "[]" } = {}) => {
  const dir = path.join(world.root, "mcp-gh-bin");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "gh"), `#!/bin/sh
ROOT="$(dirname "$0")"
printf '%s\\n' "$*" >> "$ROOT/calls.log"
case "$1 $2" in
  "pr create")
    if [ -s "$ROOT/create-fail" ]; then echo "GraphQL: something broke" >&2; exit 1; fi
    echo "${createOut ?? ""}" ;;
  "pr list") cat "$ROOT/pr-list.json" ;;
  *) echo "" ;;
esac
exit 0
`);
  fs.chmodSync(path.join(dir, "gh"), 0o755);
  fs.writeFileSync(path.join(dir, "create-fail"), createFail ? "yes" : "");
  fs.writeFileSync(path.join(dir, "pr-list.json"), listJson);
  return {
    env: { FACTORY_STATE_DIR: world.stateDir, PATH: `${dir}${path.delimiter}${process.env.PATH}` },
    calls: () => (fs.existsSync(path.join(dir, "calls.log")) ? fs.readFileSync(path.join(dir, "calls.log"), "utf8") : ""),
  };
};

const CREATE_ARGS = { taskId: "T-001", title: "[factory] T-001: sample", body: "what/why", branch: "factory/T-001" };

test("create_pr opens the PR on the configured forge — base branch from config, never the session", async (t) => {
  const world = makeFactory(t);
  const gh = withGh(world, { createOut: "https://github.com/o/r/pull/41" });
  const rs = await runMcp(world, [init, call(2, "create_pr", CREATE_ARGS)], gh.env);
  const r = rs.find((x) => x.id === 2);
  assert.ok(!r.result.isError, `unexpected tool error: ${JSON.stringify(r.result)}`);
  assert.match(r.result.content[0].text, /https:\/\/github\.com\/o\/r\/pull\/41/);
  const createLine = gh.calls().split("\n").find((l) => l.startsWith("pr create"));
  assert.ok(createLine.includes("--head factory/T-001"), `head branch missing: ${createLine}`);
  assert.ok(createLine.includes("--base main"), `config base branch missing: ${createLine}`);
  const events = readEvents(world);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "create_pr");
  assert.equal(events[0].taskId, "T-001");
  assert.equal(events[0].branch, "factory/T-001");
  assert.equal(events[0].url, "https://github.com/o/r/pull/41");
});

test("create_pr without FACTORY_STATE_DIR (older driver spawn) is a clean tool error, not a crash", async (t) => {
  const world = makeFactory(t);
  const rs = await runMcp(world, [init, call(2, "create_pr", CREATE_ARGS)]);
  const r = rs.find((x) => x.id === 2);
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /state dir|FACTORY_STATE_DIR/);
  assert.equal(readEvents(world).length, 0);
});

test("create_pr without a branch is a validation error and writes no event", async (t) => {
  const world = makeFactory(t);
  const gh = withGh(world, { createOut: "https://github.com/o/r/pull/41" });
  const rs = await runMcp(world, [init, call(2, "create_pr", { title: "t", body: "b" })], gh.env);
  const r = rs.find((x) => x.id === 2);
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /branch/);
  assert.equal(readEvents(world).length, 0);
});

test("create_pr failure falls back to an already-open PR for the same branch (turn-cap retry)", async (t) => {
  const world = makeFactory(t);
  const gh = withGh(world, {
    createFail: true,
    listJson: JSON.stringify([{ number: 7, url: "https://github.com/o/r/pull/7", title: "[factory] T-001: sample", headRefName: "factory/T-001", isDraft: false }]),
  });
  const rs = await runMcp(world, [init, call(2, "create_pr", CREATE_ARGS)], gh.env);
  const r = rs.find((x) => x.id === 2);
  assert.ok(!r.result.isError, `unexpected tool error: ${JSON.stringify(r.result)}`);
  assert.match(r.result.content[0].text, /https:\/\/github\.com\/o\/r\/pull\/7/);
  const events = readEvents(world);
  assert.equal(events[0].url, "https://github.com/o/r/pull/7");
});

test("create_pr failure with no existing PR reports the forge error and records it — never asks for shell creds", async (t) => {
  const world = makeFactory(t);
  const gh = withGh(world, { createFail: true, listJson: "[]" });
  const rs = await runMcp(world, [init, call(2, "create_pr", CREATE_ARGS)], gh.env);
  const r = rs.find((x) => x.id === 2);
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /GraphQL: something broke/);
  const events = readEvents(world);
  assert.equal(events.length, 1);
  assert.match(events[0].error, /GraphQL: something broke/);
});

// ---------- driver wiring (dev window × MCP) ----------

const RESULT_EVENT = { type: "result", subtype: "success", result: "ok", total_cost_usd: 0.01, num_turns: 3, usage: { input_tokens: 10, output_tokens: 20 } };
const NO_TASKS_SESSION = {
  script: `mkdir -p .factory/log && printf '%s' '{"taskId": null, "status": "no-tasks", "summary": "nothing eligible"}' > .factory/log/last-session.json`,
  stdout: RESULT_EVENT,
  exit: 0,
};
const invocation = (world, n) => JSON.parse(fs.readFileSync(path.join(world.stubDir, `invocation-${n}.json`), "utf8"));

test("dev sessions get --mcp-config wired to this driver and a per-session events file", (t) => {
  const world = makeFactory(t);
  queueSessions(world, [NO_TASKS_SESSION]);
  const r = runDriver(world, "dev");
  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const inv = invocation(world, 1);
  const i = inv.args.indexOf("--mcp-config");
  assert.notEqual(i, -1, `--mcp-config not passed: ${inv.args.join(" ")}`);
  const mcpCfg = JSON.parse(fs.readFileSync(inv.args[i + 1], "utf8"));
  const srv = mcpCfg.mcpServers.factory;
  assert.equal(srv.command, process.execPath);
  assert.equal(srv.args[1], "mcp-server");
  assert.ok(fs.existsSync(srv.args[0]), `server entrypoint missing: ${srv.args[0]}`);
  const events = srv.env.FACTORY_MCP_EVENTS;
  assert.ok(events.startsWith(path.join(world.stateDir, "log")), `events file outside project log dir: ${events}`);
  assert.ok(events.endsWith(".mcp.jsonl"));
  // create_pr needs machine-side state (forge config + .env) — the driver
  // hands the state dir over explicitly; the server never derives it.
  assert.equal(srv.env.FACTORY_STATE_DIR, world.stateDir);
  // The session's own env carries the path too (guard visibility, stub scripts).
  assert.equal(inv.factoryMcpEvents, events);
});

test("a settled MCP report stands in for a missing last-session.json", (t) => {
  const world = makeFactory(t);
  queueSessions(world, [
    {
      script: `printf '%s\\n' '{"ts":"t","event":"report_status","taskId":"T-001","status":"review","summary":"PR open","pr":null}' >> "$FACTORY_MCP_EVENTS"`,
      stdout: RESULT_EVENT,
      exit: 0,
    },
    NO_TASKS_SESSION,
  ]);
  const r = runDriver(world, "dev");
  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /session 1 done \(exit 0\): task=T-001 status=review/);
  assert.doesNotMatch(r.stdout, /without writing last-session\.json/);
  const rows = readUsageRows(world);
  assert.equal(rows[0].taskId, "T-001");
  assert.equal(rows[0].status, "review");
});

test("an in-progress-only MCP trail does not override last-session.json", (t) => {
  const world = makeFactory(t);
  queueSessions(world, [
    {
      script: `printf '%s\\n' '{"ts":"t","event":"report_status","taskId":"T-001","status":"in-progress","summary":"picked T-001","pr":null}' >> "$FACTORY_MCP_EVENTS"
mkdir -p .factory/log && printf '%s' '{"taskId": "T-001", "status": "completed", "summary": "done, no PR needed", "pr": null}' > .factory/log/last-session.json`,
      stdout: RESULT_EVENT,
      exit: 0,
    },
    NO_TASKS_SESSION,
  ]);
  const r = runDriver(world, "dev");
  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const rows = readUsageRows(world);
  assert.equal(rows[0].status, "completed"); // the file's settled report won
});

test("a dead session's in-progress MCP breadcrumbs reach the next session's handoff", (t) => {
  const world = makeFactory(t);
  queueSessions(world, [
    {
      script: `printf '%s\\n' '{"ts":"t","event":"report_status","taskId":"T-001","status":"in-progress","summary":"halfway through parser rewrite","pr":null}' >> "$FACTORY_MCP_EVENTS"`,
      stdout: "", // no result event, no last-session.json: a real death
      exit: 1,
    },
    NO_TASKS_SESSION,
  ]);
  const r = runDriver(world, "dev");
  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const inv2 = invocation(world, 2);
  assert.match(inv2.prompt, /Driver handoff/);
  assert.match(inv2.prompt, /halfway through parser rewrite/);
  assert.match(inv2.prompt, /T-001/);
});

// ---------- needs-human questions: the driver files the issues (Decision 1) ----------

// Programmable gh recording every call; `issue create` registers the new
// issue so later `issue list` calls see it (like the real GitHub REST list).
const installQuestionGh = (world, { issues = [], failFirstCreate = false, failAllCreates = false } = {}) => {
  const ghDir = path.join(world.root, "stub-gh");
  fs.mkdirSync(ghDir, { recursive: true });
  fs.writeFileSync(path.join(ghDir, "issues.json"), JSON.stringify(issues));
  fs.writeFileSync(
    path.join(ghDir, "gh"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "${ghDir}/calls.log"
case "$1 $2" in
  "issue list") cat "${ghDir}/issues.json" ;;
  "issue create")
    ${failAllCreates ? `echo "The requested URL returned error: 410" >&2; exit 1;` : ":"}
    ${failFirstCreate ? `if [ ! -f "${ghDir}/failed-once" ]; then touch "${ghDir}/failed-once"; echo "boom" >&2; exit 1; fi` : ":"}
    prev=""; title=""
    for a in "$@"; do [ "$prev" = "--title" ] && title="$a"; prev="$a"; done
    node -e 'const fs=require("fs");const p="${ghDir}/issues.json";const j=JSON.parse(fs.readFileSync(p,"utf8"));j.push({number:12,title:process.argv[1]});fs.writeFileSync(p,JSON.stringify(j))' "$title"
    echo "https://github.com/o/r/issues/12" ;;
  "pr list") echo '[]' ;;
  *) echo "" ;;
esac
exit 0
`
  );
  fs.chmodSync(path.join(ghDir, "gh"), 0o755);
  fs.appendFileSync(path.join(world.stateDir, ".env"), `STUB_GH_DIR=${ghDir}\n`);
  return {
    calls: () => {
      const p = path.join(ghDir, "calls.log");
      return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim().split("\n") : [];
    },
  };
};

const questionEvent = (title, body = "context", taskId = "T-001") =>
  `printf '%s\\n' '${JSON.stringify({ ts: "t", event: "open_question", title, body, taskId })}' >> "$FACTORY_MCP_EVENTS"`;

test("the driver files new questions and comments on an already-open match", (t) => {
  const world = makeFactory(t);
  const gh = installQuestionGh(world, { issues: [{ number: 9, title: "[factory] question: Which payment provider?" }] });
  queueSessions(world, [
    {
      script: `${questionEvent("Which payment provider?")}\n${questionEvent("May I delete the legacy table?")}\nmkdir -p .factory/log && printf '%s' '{"taskId": null, "status": "no-tasks", "summary": "n"}' > .factory/log/last-session.json`,
      stdout: RESULT_EVENT,
      exit: 0,
    },
  ]);
  const r = runDriver(world, "dev");
  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const creates = gh.calls().filter((c) => c.startsWith("issue create"));
  const comments = gh.calls().filter((c) => c.startsWith("issue comment"));
  assert.equal(creates.length, 1, `creates:\n${creates.join("\n")}`);
  assert.match(creates[0], /May I delete the legacy table\?/);
  assert.equal(comments.length, 1, `comments:\n${comments.join("\n")}`);
  assert.match(comments[0], /^issue comment 9 /);
  // Both actions journaled for the post-mortem trail.
  const journalFile = fs.readdirSync(path.join(world.stateDir, "log")).find((f) => f.startsWith("journal-"));
  const journal = fs.readFileSync(path.join(world.stateDir, "log", journalFile), "utf8");
  assert.match(journal, /question:filed/);
  assert.match(journal, /question:comment/);
});

test("a question repeated by a later session becomes a comment, not a second issue", (t) => {
  const world = makeFactory(t);
  const gh = installQuestionGh(world);
  queueSessions(world, [
    {
      script: `${questionEvent("Rotate the API key?")}\nmkdir -p .factory/log && printf '%s' '{"taskId": "T-001", "status": "incomplete", "summary": "wip"}' > .factory/log/last-session.json`,
      stdout: RESULT_EVENT,
      exit: 0,
    },
    {
      script: `${questionEvent("Rotate the API key?")}\nmkdir -p .factory/log && printf '%s' '{"taskId": null, "status": "no-tasks", "summary": "n"}' > .factory/log/last-session.json`,
      stdout: RESULT_EVENT,
      exit: 0,
    },
  ]);
  const r = runDriver(world, "dev");
  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.equal(gh.calls().filter((c) => c.startsWith("issue create")).length, 1);
  assert.equal(gh.calls().filter((c) => c.startsWith("issue comment 12")).length, 1);
});

test("a failed gh create keeps the question pending; the next session end retries it", (t) => {
  const world = makeFactory(t);
  const gh = installQuestionGh(world, { failFirstCreate: true });
  queueSessions(world, [
    {
      script: `${questionEvent("Need prod credentials")}\nmkdir -p .factory/log && printf '%s' '{"taskId": "T-001", "status": "incomplete", "summary": "wip"}' > .factory/log/last-session.json`,
      stdout: RESULT_EVENT,
      exit: 0,
    },
    NO_TASKS_SESSION, // asks nothing — the retry comes from the pending queue
  ]);
  const r = runDriver(world, "dev");
  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /kept pending/);
  assert.equal(gh.calls().filter((c) => c.startsWith("issue create")).length, 2); // failed attempt + successful retry
  const state = JSON.parse(fs.readFileSync(path.join(world.stateDir, "log", "state.json"), "utf8"));
  assert.deepEqual(state.pendingQuestions ?? [], []);
});

// A tracker that is switched off (Bitbucket's default) accepts nothing, so the
// queue only grows. The per-question "kept pending" line scrolls past inside a
// long window: the window must end by saying how many questions are stranded,
// on a channel that does not depend on the tracker (first live Bitbucket pilot,
// 2026-07-19: two real diagnoses queued and nobody saw either).
test("questions that never file announce the stranded count, not just per-question lines", (t) => {
  const world = makeFactory(t, { config: { notify: { telegram: true } } });
  // The Telegram leg is the load-bearing half of the announcement (the log
  // line scrolls past inside a long window) — assert it through the stub,
  // not by inference from the log.
  const tg = startTelegramStub(t);
  fs.appendFileSync(path.join(world.stateDir, ".env"),
    "TELEGRAM_BOT_TOKEN=stub-token\nTELEGRAM_CHAT_ID=7\n");
  world.extraEnv = { ...(world.extraEnv ?? {}), FACTORY_TELEGRAM_API: tg.url };
  installQuestionGh(world, { failAllCreates: true });
  queueSessions(world, [
    {
      script: `${questionEvent("Bitbucket REST is blocked")}\n${questionEvent("curl is denied under dontAsk", "context", null)}\nmkdir -p .factory/log && printf '%s' '{"taskId": null, "status": "no-tasks", "summary": "n"}' > .factory/log/last-session.json`,
      stdout: RESULT_EVENT,
      exit: 0,
    },
  ]);
  const r = runDriver(world, "dev");
  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /2 question\(s\) could not be filed/, "the count must be stated once, not left to per-question lines");
  assert.match(r.stdout, /retry/i, "the owner must be told the questions are queued, not lost");
  assert.match(r.stdout, /Bitbucket REST is blocked/, "the summary names what is stranded");
  const state = JSON.parse(fs.readFileSync(path.join(world.stateDir, "log", "state.json"), "utf8"));
  assert.equal(state.pendingQuestions.length, 2);
  const announcement = tg.messages().find((m) => /could not be filed/.test(m.text ?? ""));
  assert.ok(announcement, `no stranded-count Telegram message; got: ${JSON.stringify(tg.messages().map((m) => m.text))}`);
  assert.equal(announcement.chat_id, "7");
  assert.match(announcement.text, /2 question\(s\)/, "the Telegram text carries the count");
  assert.match(announcement.text, /Bitbucket REST is blocked/, "the Telegram text names what is stranded");
});

test("triage sessions file questions through the driver too", (t) => {
  const world = makeFactory(t);
  const gh = installQuestionGh(world);
  queueSessions(world, [
    { script: questionEvent("Spec contradicts itself on auth", "REQ-2 vs REQ-7", null), stdout: RESULT_EVENT, exit: 0 },
  ]);
  const r = runDriver(world, "triage");
  assert.equal(r.code, 0, `driver exited ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const creates = gh.calls().filter((c) => c.startsWith("issue create"));
  assert.equal(creates.length, 1, `creates:\n${creates.join("\n")}`);
  assert.match(creates[0], /Spec contradicts itself on auth/);
  // Filed means FILED: nothing pending, no swallowed post-create failure that
  // would re-file as a duplicate comment at the next session end.
  assert.doesNotMatch(r.stdout, /kept pending/);
  const state = JSON.parse(fs.readFileSync(path.join(world.stateDir, "log", "state.json"), "utf8"));
  assert.deepEqual(state.pendingQuestions ?? [], []);
});

test("open_question and log_progress record events in order", async (t) => {
  const world = makeFactory(t);
  await runMcp(world, [
    init,
    call(2, "open_question", { title: "Which payment provider?", body: "Spec names none.", taskId: "T-005" }),
    call(3, "log_progress", { message: "tests green, opening PR" }),
  ]);
  const events = readEvents(world);
  assert.equal(events.length, 2);
  assert.equal(events[0].event, "open_question");
  assert.equal(events[0].title, "Which payment provider?");
  assert.equal(events[0].taskId, "T-005");
  assert.equal(events[1].event, "log_progress");
  assert.equal(events[1].message, "tests green, opening PR");
});

test("mcp-server serves from a session-worktree cwd — no machine config needed", async (t) => {
  const world = makeFactory(t);
  // Sessions pass their throwaway worktree as --project; a worktree has the
  // repo's .factory data but NO machine-side state dir of its own. The MCP
  // server must not depend on any project state beyond FACTORY_MCP_EVENTS.
  const wt = path.join(world.root, "s1-fake-worktree");
  fs.mkdirSync(path.join(wt, ".factory"), { recursive: true });
  const child = spawn(process.execPath, [driverPath, "mcp-server", "--project", wt], {
    env: { ...process.env, HOME: world.home, FACTORY_MCP_EVENTS: eventsPathFor(world) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  child.stdin.write(JSON.stringify(init) + "\n" + JSON.stringify(call(2, "log_progress", { message: "alive" })) + "\n");
  child.stdin.end();
  const code = await new Promise((r) => child.on("exit", r));
  assert.equal(code, 0, `mcp-server exited ${code}\nstderr:\n${err}`);
  const rs = out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(rs.find((x) => x.id === 1)?.result, `no initialize response: ${out}`);
  assert.equal(readEvents(world).at(-1)?.message, "alive");
});
