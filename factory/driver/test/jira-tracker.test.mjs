// Jira tracker: the issue surface of the forge contract (issueListOpen /
// issueCreate / issueComment / authCheck / async.issueList) backed by Jira
// Cloud REST v3, for factories whose repo tracker is off (cfg.tracker:
// "jira"). These tests pin the shape mapping — Jira's API answers in,
// gh-shaped contract values out — and the security property that
// credentials ride stdin, never argv (same transport as bitbucket.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createForge, createTracker } from "../forge.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "jira-tracker-test-"));

// Programmable stub curl: dispatches on the request URL (last argv), canned
// responses live next to it. Captures argv (calls.log) and stdin
// (last-stdin) so tests can assert what crossed which channel.
const binDir = path.join(root, "bin");
fs.mkdirSync(binDir);
fs.writeFileSync(
  path.join(binDir, "curl"),
  `#!/bin/sh
ROOT="$(dirname "$0")"
printf '%s\\n' "$*" >> "$ROOT/calls.log"
cat > "$ROOT/last-stdin"
for a in "$@"; do url="$a"; done
case "$url" in
  *"/rest/api/3/search/jql"*)
    if [ -s "$ROOT/search-fail" ]; then cat "$ROOT/search-fail" >&2; exit 22; fi
    cat "$ROOT/search.json" ;;
  *"/rest/api/3/project/"*"/statuses"*) cat "$ROOT/project-statuses.json" ;;
  *"/rest/api/3/issue/"*"/transitions"*)
    case "$*" in
      *"-X POST"*) echo '' ;;
      *) cat "$ROOT/transitions.json" ;;
    esac ;;
  *"/rest/api/3/issue/"*"/comment"*)
    case "$*" in
      *"-X POST"*) echo '{}' ;;
      *) cat "$ROOT/comments.json" ;;
    esac ;;
  *"/rest/api/3/issue"*) cat "$ROOT/issue-create.json" ;;
  *"/rest/api/3/myself"*)
    if [ -s "$ROOT/auth-fail" ]; then cat "$ROOT/auth-fail" >&2; exit 22; fi
    cat "$ROOT/myself.json" ;;
  *) echo '{}' ;;
esac
exit 0
`
);
fs.chmodSync(path.join(binDir, "curl"), 0o755);
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;

const set = (name, content) => fs.writeFileSync(path.join(binDir, name), content);
const calls = () => {
  const p = path.join(binDir, "calls.log");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim().split("\n") : [];
};
const clearCalls = () => fs.rmSync(path.join(binDir, "calls.log"), { force: true });
const lastStdin = () => fs.readFileSync(path.join(binDir, "last-stdin"), "utf8");

// The tracker falls back to process.env for credentials — the host machine's
// keys must not bleed into the missing-credential tests.
delete process.env.JIRA_BASE_URL;
delete process.env.JIRA_EMAIL;
delete process.env.JIRA_API_TOKEN;

const ENV = {
  JIRA_BASE_URL: "https://acme.atlassian.net",
  JIRA_EMAIL: "m@example.com",
  JIRA_API_TOKEN: "sekret-jira-tok",
};
const CFG = { tracker: "jira", jiraProject: "FACT" };
const tracker = createTracker({ cfg: CFG, env: ENV });

test("createTracker returns the forge itself unless the config says jira", () => {
  const forge = createForge({ kind: "github", project: root });
  assert.equal(createTracker({ cfg: { tracker: "github" }, forge }), forge);
  assert.equal(createTracker({ cfg: {}, forge }), forge, "missing key = native tracker");
  assert.notEqual(createTracker({ cfg: CFG, forge }), forge);
  assert.equal(createTracker({ cfg: CFG, forge }).kind, "jira");
  assert.throws(() => createTracker({ cfg: { tracker: "linear" }, forge }), /linear/);
});

test("credentials ride stdin, never argv", () => {
  clearCalls();
  set("search.json", JSON.stringify({ issues: [] }));
  tracker.issueListOpen();
  const argv = calls().join("\n");
  assert.doesNotMatch(argv, /sekret-jira-tok/, "token must not be visible to ps");
  assert.doesNotMatch(argv, /m@example\.com/, "email must not be visible to ps");
  assert.match(lastStdin(), /user = "m@example\.com:sekret-jira-tok"/);
});

test("issueListOpen queries open issues of the configured project and maps keys to contract rows", () => {
  clearCalls();
  set("search.json", JSON.stringify({ issues: [
    { key: "FACT-3", fields: { summary: "[factory] question: pick a color" } },
    { key: "FACT-1", fields: { summary: "[factory] daily log" } },
  ] }));
  assert.deepEqual(tracker.issueListOpen(), [
    { number: "FACT-3", title: "[factory] question: pick a color", url: "https://acme.atlassian.net/browse/FACT-3" },
    { number: "FACT-1", title: "[factory] daily log", url: "https://acme.atlassian.net/browse/FACT-1" },
  ]);
  const line = calls().find((l) => /search\/jql/.test(l));
  assert.match(line, /project%20%3D%20%22FACT%22/, "JQL must scope to the configured project");
  assert.match(line, /statusCategory%20!%3D%20Done/, "JQL must filter to open issues server-side");
  assert.match(line, /fields=summary/, "v3 search returns no fields unless asked");
});

test("issueCreate posts summary + ADF description to the project and returns the browse url", () => {
  clearCalls();
  set("issue-create.json", JSON.stringify({ key: "FACT-9" }));
  const url = tracker.issueCreate({ title: "[factory] question: pick", body: "which one?\nsecond line" });
  assert.equal(url, "https://acme.atlassian.net/browse/FACT-9");
  const line = calls().find((l) => /-X POST/.test(l) && /rest\/api\/3\/issue/.test(l));
  const body = JSON.parse(line.match(/--data (\{.*\}) https/)[1]);
  assert.equal(body.fields.project.key, "FACT");
  assert.equal(body.fields.issuetype.name, "Task");
  assert.equal(body.fields.summary, "[factory] question: pick");
  assert.equal(body.fields.description.type, "doc", "v3 descriptions are ADF documents");
  const text = JSON.stringify(body.fields.description);
  assert.match(text, /which one\?/);
  assert.match(text, /second line/);
});

test("issueListClosed searches Done issues in scope (answered questions live there)", () => {
  clearCalls();
  set("search.json", JSON.stringify({ issues: [{ key: "FACT-4", fields: { summary: "[factory] question: which db" } }] }));
  assert.deepEqual(tracker.issueListClosed(), [
    { number: "FACT-4", title: "[factory] question: which db", url: "https://acme.atlassian.net/browse/FACT-4" },
  ]);
  const line = calls().find((l) => /search\/jql/.test(l) && /Done/.test(decodeURIComponent(l)));
  assert.ok(line, "must query statusCategory = Done");
});

test("issueComments flattens ADF comment bodies to plain text {author, body, createdAt}", () => {
  clearCalls();
  set("comments.json", JSON.stringify({ comments: [{
    author: { displayName: "Owner One" },
    created: "2026-07-20T11:00:00Z",
    body: { type: "doc", version: 1, content: [
      { type: "paragraph", content: [{ type: "text", text: "answer: " }, { type: "text", text: "option 2" }] },
      { type: "paragraph", content: [{ type: "text", text: "second line" }] },
      // Owners answer with lists — nested content must survive, not just
      // top-level paragraphs (list → listItem → paragraph → text).
      { type: "bulletList", content: [
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "use postgres" }] }] },
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "skip redis" }] }] },
      ] },
    ] },
  }] }));
  assert.deepEqual(tracker.issueComments("FACT-3"), [
    { author: "Owner One", body: "answer: option 2\nsecond line\nuse postgres skip redis", createdAt: "2026-07-20T11:00:00Z" },
  ]);
  assert.ok(calls().find((l) => /issue\/FACT-3\/comment/.test(l)), "must hit the comment endpoint");
});

test("issueComment posts an ADF body to the issue's comment endpoint by key", () => {
  clearCalls();
  tracker.issueComment("FACT-3", "same question");
  const line = calls().find((l) => /issue\/FACT-3\/comment/.test(l));
  assert.ok(line, "must hit /rest/api/3/issue/FACT-3/comment");
  const body = JSON.parse(line.match(/--data (\{.*\}) https/)[1]);
  assert.equal(body.body.type, "doc", "v3 comment bodies are ADF documents");
  assert.match(JSON.stringify(body.body), /same question/);
});

test("a failing Jira call throws — the question queue absorbs and retries", () => {
  set("search-fail", '{"errorMessages": ["project down"]}');
  assert.throws(() => tracker.issueListOpen());
  set("search-fail", "");
});

test("authCheck fails fast on missing env keys, naming them", () => {
  const rows = createTracker({ cfg: CFG, env: { JIRA_BASE_URL: "https://x.atlassian.net" } }).authCheck();
  assert.equal(rows[0].level, "fail");
  assert.match(rows[0].detail, /JIRA_EMAIL/);
  assert.match(rows[0].detail, /JIRA_API_TOKEN/);
});

test("authCheck fails when the config names no Jira project", () => {
  const rows = createTracker({ cfg: { tracker: "jira" }, env: ENV }).authCheck();
  assert.ok(rows.some((r) => r.level === "fail" && /jiraProject/.test(r.detail)));
});

test("authCheck probes myself and reports who authenticated", () => {
  set("myself.json", JSON.stringify({ displayName: "Marcos T" }));
  const rows = tracker.authCheck();
  assert.deepEqual(rows.map((r) => r.level), ["ok"]);
  assert.match(rows[0].detail, /Marcos T/);
});

test("authCheck reports a live auth refusal as a fail row", () => {
  set("auth-fail", '{"message": "Basic auth with password is not allowed"}');
  const rows = tracker.authCheck();
  assert.equal(rows[0].level, "fail");
  set("auth-fail", "");
});

test("async.issueList with missing credentials resolves the real error immediately, not a curl timeout", async () => {
  const t0 = Date.now();
  const r = await createTracker({ cfg: CFG, env: {} }).async.issueList();
  assert.match(r.error, /JIRA_BASE_URL/);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0}ms — must not wait out the curl timeout`);
});

test("async.issueList maps issues with empty labels for the dashboard's title-convention fallback", async () => {
  set("search.json", JSON.stringify({ issues: [
    { key: "FACT-3", fields: { summary: "[factory] question: pick a color" } },
  ] }));
  const r = await tracker.async.issueList();
  assert.deepEqual(r.data, [{
    number: "FACT-3", title: "[factory] question: pick a color",
    url: "https://acme.atlassian.net/browse/FACT-3", labels: [],
  }]);
});

// ---------- jiraEpic anchor (shared ISC-project shape) ----------

test("jiraEpic scopes every search and parents every created issue under the anchor epic", () => {
  const t = createTracker({ cfg: { tracker: "jira", jiraProject: "ISC", jiraEpic: "ISC-40" }, env: ENV });
  clearCalls();
  set("search.json", JSON.stringify({ issues: [] }));
  t.issueListOpen();
  assert.match(calls().find((l) => /search\/jql/.test(l)), /parent%20%3D%20%22ISC-40%22/,
    "a shared Jira project must never be scanned whole");
  clearCalls();
  set("issue-create.json", JSON.stringify({ key: "ISC-77" }));
  t.issueCreate({ title: "[factory] question: x", body: "b" });
  const line = calls().find((l) => /-X POST/.test(l) && /rest\/api\/3\/issue/.test(l));
  assert.equal(JSON.parse(line.match(/--data (\{.*\}) https/)[1]).fields.parent.key, "ISC-40");
});

// ---------- board primitives (jira-board.mjs consumes these) ----------

test("projectStatuses flattens the per-issue-type statuses to a unique name list", () => {
  set("project-statuses.json", JSON.stringify([
    { name: "Task", statuses: [{ id: "1", name: "To Do" }, { id: "3", name: "Done" }] },
    { name: "Bug", statuses: [{ id: "1", name: "To Do" }, { id: "9", name: "Blocked" }] },
  ]));
  assert.deepEqual(tracker.board.projectStatuses(),
    [{ id: "1", name: "To Do" }, { id: "3", name: "Done" }, { id: "9", name: "Blocked" }]);
});

test("transitions lists id, name and target status; transition posts the chosen id", () => {
  set("transitions.json", JSON.stringify({ transitions: [
    { id: "11", name: "Start", to: { name: "In Progress" } },
    { id: "31", name: "Finish", to: { name: "Done" } },
  ] }));
  assert.deepEqual(tracker.board.transitions("FACT-3"), [
    { id: "11", name: "Start", toStatus: "In Progress" },
    { id: "31", name: "Finish", toStatus: "Done" },
  ]);
  clearCalls();
  tracker.board.transition("FACT-3", "31");
  const line = calls().find((l) => /-X POST/.test(l) && /issue\/FACT-3\/transitions/.test(l));
  assert.equal(JSON.parse(line.match(/--data (\{.*\}) https/)[1]).transition.id, "31");
});

test("createCard posts summary, ADF description and labels, returning the key", () => {
  clearCalls();
  set("issue-create.json", JSON.stringify({ key: "FACT-21" }));
  const r = tracker.board.createCard({ summary: "T-001 — sample", description: "Model: sonnet", labels: ["factory-task", "epic:e1"] });
  assert.equal(r.key, "FACT-21");
  const body = JSON.parse(calls().find((l) => /-X POST/.test(l)).match(/--data (\{.*\}) https/)[1]);
  assert.deepEqual(body.fields.labels, ["factory-task", "epic:e1"]);
  assert.equal(body.fields.summary, "T-001 — sample");
  assert.equal(body.fields.description.type, "doc");
});

test("updateCard PUTs changed fields to the issue", () => {
  clearCalls();
  tracker.board.updateCard("FACT-21", { summary: "T-001 — renamed", description: "new" });
  const line = calls().find((l) => /-X PUT/.test(l) && /issue\/FACT-21/.test(l));
  const body = JSON.parse(line.match(/--data (\{.*\}) https/)[1]);
  assert.equal(body.fields.summary, "T-001 — renamed");
  assert.equal(body.fields.description.type, "doc");
});

test("addLabel appends without clobbering existing labels", () => {
  clearCalls();
  tracker.board.addLabel("FACT-9", "factory-captured");
  const line = calls().find((l) => /-X PUT/.test(l) && /issue\/FACT-9/.test(l));
  assert.deepEqual(JSON.parse(line.match(/--data (\{.*\}) https/)[1]).update.labels, [{ add: "factory-captured" }]);
});

test("searchCards returns status, labels, and done-category per issue in scope (no label filter — the board decides)", () => {
  clearCalls();
  set("search.json", JSON.stringify({ issues: [
    { key: "FACT-21", fields: { summary: "T-001 — sample", status: { name: "In Progress" }, labels: ["factory-task", "epic:e1"] } },
  ] }));
  assert.deepEqual(tracker.board.searchCards(), [
    { key: "FACT-21", summary: "T-001 — sample", status: "In Progress", labels: ["factory-task", "epic:e1"], done: false },
  ]);
  const line = calls().find((l) => /search\/jql/.test(l));
  assert.match(line, /fields=summary%2Cstatus%2Clabels|fields=summary,status,labels/);
  assert.doesNotMatch(line, /statusCategory/, "searchCards must NOT filter by statusCategory — done cards are part of the board");
});
