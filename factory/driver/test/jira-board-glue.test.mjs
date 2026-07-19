// Driver glue for the Jira board (cfg.board.jira): the sync-board verb,
// doctor rows, and the manual sync path end-to-end through the real driver
// against a stub Jira API. The sync logic itself is pinned by
// jira-board.test.mjs; these tests pin the wiring.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { makeFactory, runDriver } from "./helpers.mjs";

const JIRA_ENV = "JIRA_BASE_URL=https://acme.atlassian.net\nJIRA_EMAIL=m@x.co\nJIRA_API_TOKEN=tok\n";

// Stub curl into the world's PATH bin (helpers put world.root/bin first).
const stubJira = (world, { search = { issues: [] }, statuses, create = { key: "FACT-21" }, transitions = { transitions: [] } } = {}) => {
  const dataDir = path.join(world.root, "jira-data");
  fs.mkdirSync(dataDir, { recursive: true });
  const put = (n, v) => fs.writeFileSync(path.join(dataDir, n), JSON.stringify(v));
  put("search.json", search);
  put("project-statuses.json", statuses ?? [{ name: "Task", statuses: [
    { id: "1", name: "To Do" }, { id: "2", name: "In Progress" }, { id: "3", name: "In Review" },
    { id: "5", name: "Blocked" }, { id: "6", name: "Needs Human" }, { id: "4", name: "Done" },
  ] }]);
  put("issue-create.json", create);
  put("transitions.json", transitions);
  fs.writeFileSync(path.join(world.root, "bin", "curl"), `#!/bin/sh
DATA="${dataDir}"
printf '%s\\n' "$*" >> "$DATA/calls.log"
cat > /dev/null
for a in "$@"; do url="$a"; done
case "$url" in
  *"/rest/api/3/search/jql"*) cat "$DATA/search.json" ;;
  *"/rest/api/3/project/"*"/statuses"*) cat "$DATA/project-statuses.json" ;;
  *"/rest/api/3/issue/"*"/transitions"*)
    case "$*" in
      *"-X POST"*) echo '' ;;
      *) cat "$DATA/transitions.json" ;;
    esac ;;
  *"/rest/api/3/issue/"*) echo '{}' ;;
  *"/rest/api/3/issue"*) cat "$DATA/issue-create.json" ;;
  *"/rest/api/3/myself"*) echo '{"displayName": "Marcos T"}' ;;
  *) echo '{}' ;;
esac
exit 0
`);
  fs.chmodSync(path.join(world.root, "bin", "curl"), 0o755);
  return { calls: () => {
    const p = path.join(dataDir, "calls.log");
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean) : [];
  } };
};

test("doctor: board.jira without JIRA keys fails, naming them", (t) => {
  const world = makeFactory(t, { config: { board: { jira: true }, jiraProject: "FACT" } });

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /JIRA_BASE_URL/);
});

test("doctor: board.jira with keys probes jira auth even when the tracker is native", (t) => {
  const world = makeFactory(t, { config: { board: { jira: true }, jiraProject: "FACT" } });
  stubJira(world);
  fs.appendFileSync(path.join(world.stateDir, ".env"), JIRA_ENV);

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /✓ jira auth.*Marcos T/);
});

test("sync-board --init with board.jira maps the workflow and writes jira-board.json", (t) => {
  const world = makeFactory(t, { config: { board: { jira: true }, jiraProject: "FACT" } });
  stubJira(world);
  fs.appendFileSync(path.join(world.stateDir, ".env"), JIRA_ENV);

  const r = runDriver(world, "sync-board", ["--init"]);

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const board = JSON.parse(fs.readFileSync(path.join(world.stateDir, "jira-board.json"), "utf8"));
  assert.equal(board.statusMap["needs-human"], "Needs Human");
  assert.deepEqual(board.missing, []);
});

test("manual sync-board pushes the backlog as cards and lands a newcomer delta in the committed inbox", (t) => {
  const world = makeFactory(t, { config: { board: { jira: true }, jiraProject: "FACT" } });
  const stub = stubJira(world, {
    search: { issues: [
      { key: "FACT-30", fields: { summary: "please add dark mode", status: { name: "To Do" }, labels: [] } },
    ] },
    transitions: { transitions: [{ id: "11", name: "Start", to: { name: "To Do" } }] },
  });
  fs.appendFileSync(path.join(world.stateDir, ".env"), JIRA_ENV);
  fs.writeFileSync(path.join(world.stateDir, "jira-board.json"), JSON.stringify({
    statusMap: { todo: "To Do", "in-progress": "In Progress", review: "In Review", blocked: "Blocked", "needs-human": "Needs Human", done: "Done" },
    missing: [], items: {}, pendingMoves: {},
  }, null, 2));

  const r = runDriver(world, "sync-board");

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.ok(stub.calls().some((l) => /-X POST/.test(l) && /rest\/api\/3\/issue$/.test(l)), "T-001 card must be created");
  const board = JSON.parse(fs.readFileSync(path.join(world.stateDir, "jira-board.json"), "utf8"));
  assert.equal(board.items["T-001"].key, "FACT-21");
  // The newcomer delta is committed metadata: it must be on origin's main.
  execFileSync("git", ["-C", world.project, "pull", "-q"]);
  const delta = fs.readFileSync(path.join(world.project, ".factory", "inbox", "board-delta.md"), "utf8");
  assert.match(delta, /FACT-30/);
  assert.match(delta, /dark mode/);
});
