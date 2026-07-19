// Jira board sync (jira-board.mjs): the backlog mirrored as issues in a
// Jira project (or under one anchor epic of a shared project) — files stay
// source of truth, factory wins on status, humans win on new work. These
// tests pin init's status-vocabulary mapping, the outbound mirror, the
// two-observation inbound rule, and the no-deletion contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { jiraTracker } from "../jira.mjs";
import { jiraBoardInit, syncJiraBoard } from "../jira-board.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "jira-board-test-"));
const binDir = path.join(root, "bin");
fs.mkdirSync(binDir);
// Programmable stub curl: canned responses per endpoint, argv log for
// asserting which writes happened (creds themselves ride stdin).
fs.writeFileSync(
  path.join(binDir, "curl"),
  `#!/bin/sh
ROOT="$(dirname "$0")"
printf '%s\\n' "$*" >> "$ROOT/calls.log"
cat > /dev/null
for a in "$@"; do url="$a"; done
case "$url" in
  *"/rest/api/3/search/jql"*) cat "$ROOT/search.json" ;;
  *"/rest/api/3/project/"*"/statuses"*) cat "$ROOT/project-statuses.json" ;;
  *"/rest/api/3/issue/"*"/transitions"*)
    case "$*" in
      *"-X POST"*) echo '' ;;
      *) cat "$ROOT/transitions.json" ;;
    esac ;;
  *"/rest/api/3/issue/"*) echo '{}' ;;
  *"/rest/api/3/issue"*) cat "$ROOT/issue-create.json" ;;
  *) echo '{}' ;;
esac
exit 0
`
);
fs.chmodSync(path.join(binDir, "curl"), 0o755);
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;

const set = (name, content) => fs.writeFileSync(path.join(binDir, name), JSON.stringify(content));
const calls = () => {
  const p = path.join(binDir, "calls.log");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean) : [];
};
const clearCalls = () => fs.rmSync(path.join(binDir, "calls.log"), { force: true });

const ENV = { JIRA_BASE_URL: "https://acme.atlassian.net", JIRA_EMAIL: "m@x.co", JIRA_API_TOKEN: "tok" };
const CFG = { jiraProject: "FACT" };
const jira = jiraTracker({ cfg: CFG, env: ENV });

const mkState = () => {
  const d = fs.mkdtempSync(path.join(root, "state-"));
  return d;
};
const boardFile = (stateD) => JSON.parse(fs.readFileSync(path.join(stateD, "jira-board.json"), "utf8"));
const seedBoard = (stateD, board) =>
  fs.writeFileSync(path.join(stateD, "jira-board.json"), JSON.stringify(board, null, 2));
const BASE_BOARD = {
  statusMap: { todo: "To Do", "in-progress": "In Progress", review: "In Review", done: "Done" },
  missing: ["blocked", "needs-human"],
  items: {}, pendingMoves: {},
};

const TASKS = [
  { id: "T-001", title: "sample task", epic: "e1", status: "todo", model: "sonnet", effort: "medium", links: [] },
];

const quiet = () => {};

// ---------- init ----------

test("init maps the project's statuses onto the backlog vocabulary (aliases applied) and reports the missing ones", () => {
  const stateD = mkState();
  set("project-statuses.json", [
    { name: "Task", statuses: [{ id: "1", name: "To Do" }, { id: "2", name: "In Progress" }, { id: "3", name: "Code Review" }, { id: "4", name: "Done" }] },
  ]);
  const out = [];
  jiraBoardInit({ jira, stateD, say: (m) => out.push(m) });
  const b = boardFile(stateD);
  assert.deepEqual(b.statusMap, { todo: "To Do", "in-progress": "In Progress", review: "Code Review", done: "Done" });
  assert.deepEqual(b.missing, ["blocked", "needs-human"]);
  assert.match(out.join("\n"), /blocked.*needs-human|missing/i, "missing columns must be reported loudly");
});

test("re-init keeps the tracked items map (same lesson as the GitHub board's phantom-cards incident)", () => {
  const stateD = mkState();
  seedBoard(stateD, { ...BASE_BOARD, items: { "T-001": { key: "FACT-21", status: "todo" } } });
  set("project-statuses.json", [{ name: "Task", statuses: [{ id: "1", name: "To Do" }, { id: "4", name: "Done" }] }]);
  jiraBoardInit({ jira, stateD, say: quiet });
  assert.deepEqual(boardFile(stateD).items, { "T-001": { key: "FACT-21", status: "todo" } });
});

// ---------- outbound ----------

test("an untracked task becomes a Jira card with the factory-task and epic labels", () => {
  const stateD = mkState();
  seedBoard(stateD, BASE_BOARD);
  set("search.json", { issues: [] });
  set("issue-create.json", { key: "FACT-21" });
  set("transitions.json", { transitions: [{ id: "11", name: "Start", to: { name: "To Do" } }] });
  clearCalls();
  syncJiraBoard({ jira, stateD, tasks: TASKS, log: quiet });
  const create = calls().find((l) => /-X POST/.test(l) && /rest\/api\/3\/issue$/.test(l));
  const body = JSON.parse(create.match(/--data (\{.*\}) https/)[1]);
  assert.equal(body.fields.summary, "T-001 — sample task");
  assert.deepEqual(body.fields.labels, ["factory-task", "epic:e1"]);
  assert.equal(boardFile(stateD).items["T-001"].key, "FACT-21");
});

test("a backlog status change transitions the card to the mapped column", () => {
  const stateD = mkState();
  seedBoard(stateD, { ...BASE_BOARD, items: { "T-001": { key: "FACT-21", status: "todo" } } });
  set("search.json", { issues: [{ key: "FACT-21", fields: { summary: "T-001 — sample task", status: { name: "To Do" }, labels: ["factory-task", "epic:e1"] } }] });
  set("transitions.json", { transitions: [
    { id: "11", name: "Start", to: { name: "In Progress" } },
    { id: "31", name: "Finish", to: { name: "Done" } },
  ] });
  clearCalls();
  syncJiraBoard({ jira, stateD, tasks: [{ ...TASKS[0], status: "in-progress" }], log: quiet });
  const post = calls().find((l) => /-X POST/.test(l) && /FACT-21\/transitions/.test(l));
  assert.equal(JSON.parse(post.match(/--data (\{.*\}) https/)[1]).transition.id, "11");
  assert.equal(boardFile(stateD).items["T-001"].status, "in-progress");
});

test("a status with no mapped column is skipped with a log line, never guessed", () => {
  const stateD = mkState();
  seedBoard(stateD, { ...BASE_BOARD, items: { "T-001": { key: "FACT-21", status: "todo" } } });
  set("search.json", { issues: [{ key: "FACT-21", fields: { summary: "T-001 — sample task", status: { name: "To Do" }, labels: ["factory-task", "epic:e1"] } }] });
  const logs = [];
  clearCalls();
  syncJiraBoard({ jira, stateD, tasks: [{ ...TASKS[0], status: "needs-human" }], log: (m) => logs.push(m) });
  assert.ok(!calls().some((l) => /transitions/.test(l) && /-X POST/.test(l)), "no transition may fire for an unmapped status");
  assert.match(logs.join("\n"), /needs-human/);
});

test("a sync where the board already matches makes no write calls", () => {
  const stateD = mkState();
  seedBoard(stateD, { ...BASE_BOARD, items: { "T-001": { key: "FACT-21", status: "todo" } } });
  set("search.json", { issues: [{ key: "FACT-21", fields: { summary: "T-001 — sample task", status: { name: "To Do" }, labels: ["factory-task", "epic:e1"] } }] });
  clearCalls();
  syncJiraBoard({ jira, stateD, tasks: TASKS, log: quiet });
  assert.ok(!calls().some((l) => /-X (POST|PUT)/.test(l)), `writes fired on a no-op sync:\n${calls().join("\n")}`);
});

// ---------- inbound: human moves (two-observation rule) ----------

test("a human drag is held on first sight and reported + reverted on the second consecutive sight", () => {
  const stateD = mkState();
  seedBoard(stateD, { ...BASE_BOARD, items: { "T-001": { key: "FACT-21", status: "todo" } } });
  // Board says In Progress; backlog and last-pushed say todo → human suspect.
  set("search.json", { issues: [{ key: "FACT-21", fields: { summary: "T-001 — sample task", status: { name: "In Progress" }, labels: ["factory-task", "epic:e1"] } }] });
  set("transitions.json", { transitions: [{ id: "9", name: "Reopen", to: { name: "To Do" } }] });
  clearCalls();
  const first = syncJiraBoard({ jira, stateD, tasks: TASKS, log: quiet });
  assert.deepEqual(first.humanMoves, [], "one observation proves nothing — stale reads heal");
  assert.ok(!calls().some((l) => /-X POST/.test(l)), "no revert on the first sight");
  assert.equal(boardFile(stateD).pendingMoves["T-001"], "in progress",
    "pendingMoves holds the normalized RAW status name — off-vocabulary drags must be trackable too");

  clearCalls();
  const second = syncJiraBoard({ jira, stateD, tasks: TASKS, log: quiet });
  assert.deepEqual(second.humanMoves, [{ taskId: "T-001", boardStatus: "In Progress", backlogStatus: "todo", restored: true }]);
  const revert = calls().find((l) => /-X POST/.test(l) && /FACT-21\/transitions/.test(l));
  assert.equal(JSON.parse(revert.match(/--data (\{.*\}) https/)[1]).transition.id, "9", "factory wins on status — card goes back");
  assert.equal(boardFile(stateD).pendingMoves["T-001"], undefined);
});

test("a discrepancy that heals between syncs clears the pending move silently", () => {
  const stateD = mkState();
  seedBoard(stateD, { ...BASE_BOARD, items: { "T-001": { key: "FACT-21", status: "todo" } }, pendingMoves: { "T-001": "in-progress" } });
  set("search.json", { issues: [{ key: "FACT-21", fields: { summary: "T-001 — sample task", status: { name: "To Do" }, labels: ["factory-task", "epic:e1"] } }] });
  const r = syncJiraBoard({ jira, stateD, tasks: TASKS, log: quiet });
  assert.deepEqual(r.humanMoves, []);
  assert.deepEqual(boardFile(stateD).pendingMoves, {});
});

// ---------- inbound: newcomers ----------

test("a human-filed issue is returned as a newcomer and labeled factory-captured; tracker issues and processed captures are not", () => {
  const stateD = mkState();
  seedBoard(stateD, { ...BASE_BOARD, items: { "T-001": { key: "FACT-21", status: "todo" } } });
  set("search.json", { issues: [
    { key: "FACT-21", fields: { summary: "T-001 — sample task", status: { name: "To Do" }, labels: ["factory-task", "epic:e1"] } },
    { key: "FACT-30", fields: { summary: "please add dark mode", status: { name: "To Do" }, labels: [] } },
    { key: "FACT-3", fields: { summary: "[factory] question: pick a color", status: { name: "To Do" }, labels: [] } },
    { key: "FACT-8", fields: { summary: "old ask", status: { name: "To Do" }, labels: ["factory-captured"] } },
  ] });
  clearCalls();
  const r = syncJiraBoard({ jira, stateD, tasks: TASKS, log: quiet });
  assert.deepEqual(r.newcomers.map((n) => n.key), ["FACT-30"]);
  const label = calls().find((l) => /-X PUT/.test(l) && /FACT-30/.test(l));
  assert.match(label, /factory-captured/);
  assert.ok(!calls().some((l) => /-X PUT/.test(l) && /FACT-3\b/.test(l)), "tracker questions are not the board's to touch");
});

// ---------- prune ----------

test("a task gone from the backlog gets the factory-archived label and leaves the map — its issue is never deleted", () => {
  const stateD = mkState();
  seedBoard(stateD, { ...BASE_BOARD, items: { "T-001": { key: "FACT-21", status: "todo" }, "T-099": { key: "FACT-40", status: "done" } } });
  set("search.json", { issues: [
    { key: "FACT-21", fields: { summary: "T-001 — sample task", status: { name: "To Do" }, labels: ["factory-task", "epic:e1"] } },
    { key: "FACT-40", fields: { summary: "T-099 — retired", status: { name: "Done" }, labels: ["factory-task"] } },
  ] });
  clearCalls();
  syncJiraBoard({ jira, stateD, tasks: TASKS, log: quiet });
  const label = calls().find((l) => /-X PUT/.test(l) && /FACT-40/.test(l));
  assert.match(label, /factory-archived/);
  assert.ok(!calls().some((l) => /DELETE/.test(l)), "no deletion, ever");
  assert.equal(boardFile(stateD).items["T-099"], undefined);
});

// ---------- review findings (2026-07-18 pass) ----------

test("an orphaned factory card (state lost) is adopted by summary, not recreated or captured", () => {
  const stateD = mkState();
  seedBoard(stateD, BASE_BOARD); // empty items — the crash-lost-state shape
  set("search.json", { issues: [
    { key: "FACT-21", fields: { summary: "T-001 — sample task", status: { name: "To Do", statusCategory: { key: "new" } }, labels: ["factory-task", "epic:e1"] } },
  ] });
  clearCalls();
  const r = syncJiraBoard({ jira, stateD, tasks: TASKS, log: quiet });
  assert.ok(!calls().some((l) => /-X POST/.test(l) && /rest\/api\/3\/issue$/.test(l)), "no duplicate card may be created");
  assert.equal(boardFile(stateD).items["T-001"].key, "FACT-21", "the existing card must be adopted");
  assert.deepEqual(r.newcomers, [], "a factory-task-labeled card is never human work");
});

test("a done pre-existing issue is not captured as a newcomer (first sync against a lived-in epic)", () => {
  const stateD = mkState();
  seedBoard(stateD, { ...BASE_BOARD, items: { "T-001": { key: "FACT-21", status: "todo" } } });
  set("search.json", { issues: [
    { key: "FACT-21", fields: { summary: "T-001 — sample task", status: { name: "To Do", statusCategory: { key: "new" } }, labels: ["factory-task", "epic:e1"] } },
    { key: "FACT-2", fields: { summary: "ancient resolved ask", status: { name: "Done", statusCategory: { key: "done" } }, labels: [] } },
    { key: "FACT-30", fields: { summary: "please add dark mode", status: { name: "To Do", statusCategory: { key: "new" } }, labels: [] } },
  ] });
  const r = syncJiraBoard({ jira, stateD, tasks: TASKS, log: quiet });
  assert.deepEqual(r.newcomers.map((n) => n.key), ["FACT-30"], "closed history is noise, not new work");
});

test("a drag to a status OUTSIDE the vocabulary still gets the two-observation hold and a report", () => {
  const stateD = mkState();
  seedBoard(stateD, { ...BASE_BOARD, items: { "T-001": { key: "FACT-21", status: "todo" } } });
  set("search.json", { issues: [
    { key: "FACT-21", fields: { summary: "T-001 — sample task", status: { name: "QA Check", statusCategory: { key: "indeterminate" } }, labels: ["factory-task", "epic:e1"] } },
  ] });
  set("transitions.json", { transitions: [{ id: "9", name: "Reopen", to: { name: "To Do" } }] });
  clearCalls();
  const first = syncJiraBoard({ jira, stateD, tasks: TASKS, log: quiet });
  assert.deepEqual(first.humanMoves, [], "one observation proves nothing, even off-vocabulary");
  assert.ok(!calls().some((l) => /-X POST/.test(l)), "no single-observation revert");
  const second = syncJiraBoard({ jira, stateD, tasks: TASKS, log: quiet });
  assert.equal(second.humanMoves.length, 1);
  assert.equal(second.humanMoves[0].boardStatus, "QA Check");
});

test("a confirmed move the factory cannot restore is reported ONCE with restored=false, then left alone", () => {
  const stateD = mkState();
  seedBoard(stateD, { ...BASE_BOARD, items: { "T-001": { key: "FACT-21", status: "todo" } } });
  set("search.json", { issues: [
    { key: "FACT-21", fields: { summary: "T-001 — sample task", status: { name: "In Progress", statusCategory: { key: "indeterminate" } }, labels: ["factory-task", "epic:e1"] } },
  ] });
  set("transitions.json", { transitions: [] }); // workflow forbids the way back
  syncJiraBoard({ jira, stateD, tasks: TASKS, log: quiet });
  const second = syncJiraBoard({ jira, stateD, tasks: TASKS, log: quiet });
  assert.equal(second.humanMoves.length, 1);
  assert.equal(second.humanMoves[0].restored, false);
  const third = syncJiraBoard({ jira, stateD, tasks: TASKS, log: quiet });
  const fourth = syncJiraBoard({ jira, stateD, tasks: TASKS, log: quiet });
  assert.deepEqual([...third.humanMoves, ...fourth.humanMoves], [], "an unrestorable move must not re-report forever");
});

test("a restorable confirmed move carries restored=true", () => {
  const stateD = mkState();
  seedBoard(stateD, { ...BASE_BOARD, items: { "T-001": { key: "FACT-21", status: "todo" } } });
  set("search.json", { issues: [
    { key: "FACT-21", fields: { summary: "T-001 — sample task", status: { name: "In Progress", statusCategory: { key: "indeterminate" } }, labels: ["factory-task", "epic:e1"] } },
  ] });
  set("transitions.json", { transitions: [{ id: "9", name: "Reopen", to: { name: "To Do" } }] });
  syncJiraBoard({ jira, stateD, tasks: TASKS, log: quiet });
  const second = syncJiraBoard({ jira, stateD, tasks: TASKS, log: quiet });
  assert.equal(second.humanMoves[0].restored, true);
});

test("an epic name with spaces becomes a legal Jira label", () => {
  const stateD = mkState();
  seedBoard(stateD, BASE_BOARD);
  set("search.json", { issues: [] });
  set("issue-create.json", { key: "FACT-50" });
  clearCalls();
  syncJiraBoard({ jira, stateD, tasks: [{ ...TASKS[0], epic: "user auth" }], log: quiet });
  const body = JSON.parse(calls().find((l) => /-X POST/.test(l) && /rest\/api\/3\/issue$/.test(l)).match(/--data (\{.*\}) https/)[1]);
  assert.deepEqual(body.fields.labels, ["factory-task", "epic:user-auth"], "Jira rejects labels containing spaces");
});
