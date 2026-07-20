// Bitbucket Cloud forge: same capability contract as the github forge
// (forge.test.mjs), REST-over-curl transport. These tests pin the shape
// MAPPING — Bitbucket's API answers in, gh-shaped contract values out —
// and the security property that credentials ride stdin, never argv.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createForge, nativeTrackerCheck } from "../forge.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bb-forge-test-"));

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
post=0
case "$*" in *"-X POST"*) post=1 ;; esac
case "$url" in
  *"/2.0/user"*)
    if [ -s "$ROOT/auth-fail" ]; then cat "$ROOT/auth-fail" >&2; exit 22; fi
    cat "$ROOT/user.json" ;;
  */statuses*) cat "$ROOT/pr-statuses.json" ;;
  */pullrequests/*/merge*) echo '{}' ;;
  */pullrequests/*/comments*)
    if [ "$post" = 1 ]; then echo '{}'; else cat "$ROOT/pr-comments.json"; fi ;;
  *"state=MERGED"*) cat "$ROOT/pr-merged.json" ;;
  *"/pullrequests?"*) cat "$ROOT/pr-list.json" ;;
  */pullrequests/*) cat "$ROOT/pr.json" ;;
  */pullrequests) cat "$ROOT/pr-create.json" ;;
  */issues/*/comments*)
    if [ "$post" = 1 ]; then echo '{}'; else cat "$ROOT/issue-comments.json"; fi ;;
  *resolved*) cat "$ROOT/issue-closed.json" ;;
  */issues*)
    if [ "$post" = 1 ]; then cat "$ROOT/issue-create.json"
    elif [ -s "$ROOT/issues-fail" ]; then cat "$ROOT/issues-fail" >&2; exit 22
    else cat "$ROOT/issue-list.json"; fi ;;
  */refs/branches/*) cat "$ROOT/branch.json" ;;
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

// Fixture project: the forge derives workspace/slug from the origin remote.
const makeProject = (origin) => {
  const p = fs.mkdtempSync(path.join(root, "proj-"));
  execFileSync("git", ["init", "-q", p]);
  execFileSync("git", ["-C", p, "remote", "add", "origin", origin]);
  return p;
};

// The forge falls back to process.env for credentials — the host machine's
// keys must not bleed into the missing-credential tests.
delete process.env.BITBUCKET_EMAIL;
delete process.env.BITBUCKET_API_TOKEN;

const project = makeProject("git@bitbucket.org:acme/widget.git");
const ENV = { BITBUCKET_EMAIL: "m@example.com", BITBUCKET_API_TOKEN: "sekret-tok" };
const forge = createForge({ kind: "bitbucket", project, env: ENV });

const PR_URL = "https://bitbucket.org/acme/widget/pull-requests/7";

test("kind is bitbucket; bin is curl (doctor/preflight PATH checks)", () => {
  assert.equal(forge.kind, "bitbucket");
  assert.equal(forge.bin, "curl");
  assert.equal(forge.github, undefined, "board escape hatch must not exist on bitbucket");
});

test("credentials ride stdin, never argv", () => {
  clearCalls();
  set("pr-list.json", JSON.stringify({ values: [] }));
  forge.prListOpen();
  const argv = calls().join("\n");
  assert.doesNotMatch(argv, /sekret-tok/, "token must not be visible to ps");
  assert.doesNotMatch(argv, /m@example\.com/, "email must not be visible to ps");
  assert.match(lastStdin(), /user = "m@example\.com:sekret-tok"/);
});

test("prListOpen hits the workspace/slug from origin and maps to contract rows", () => {
  clearCalls();
  set("pr-list.json", JSON.stringify({ values: [{
    id: 5, title: "[factory] T-001: t", draft: false,
    links: { html: { href: "https://bitbucket.org/acme/widget/pull-requests/5" } },
    source: { branch: { name: "factory/T-001" } },
  }, {
    id: 6, title: "T-002: claimed by a human", draft: true,
    links: { html: { href: "https://bitbucket.org/acme/widget/pull-requests/6" } },
    source: { branch: { name: "teammate-branch" } },
  }] }));
  assert.deepEqual(forge.prListOpen(), [{
    number: 5, url: "https://bitbucket.org/acme/widget/pull-requests/5",
    title: "[factory] T-001: t", headRefName: "factory/T-001", isDraft: false,
  }, {
    number: 6, url: "https://bitbucket.org/acme/widget/pull-requests/6",
    title: "T-002: claimed by a human", headRefName: "teammate-branch", isDraft: true,
  }]);
  assert.match(calls().join("\n"), /repositories\/acme\/widget\/pullrequests\?state=OPEN/);
});

test("workspace/slug also parses from an https origin", () => {
  clearCalls();
  const f = createForge({ kind: "bitbucket", project: makeProject("https://bitbucket.org/foo/bar.git"), env: ENV });
  set("pr-list.json", JSON.stringify({ values: [] }));
  f.prListOpen();
  assert.match(calls().join("\n"), /repositories\/foo\/bar\/pullrequests/);
});

test("prView maps state, branch, and the status enum into the gh-shaped view", () => {
  set("pr.json", JSON.stringify({ id: 7, title: "[factory] T-002: x", state: "OPEN",
    source: { branch: { name: "factory/T-002" } } }));
  set("pr-statuses.json", JSON.stringify({ values: [
    { state: "SUCCESSFUL" }, { state: "FAILED" }, { state: "STOPPED" }, { state: "INPROGRESS" },
  ] }));
  const v = forge.prView(PR_URL);
  assert.equal(v.state, "OPEN");
  assert.equal(v.number, 7);
  assert.equal(v.headRefName, "factory/T-002");
  assert.equal(v.mergeable, "UNKNOWN");
  assert.deepEqual(v.statusCheckRollup, [
    { conclusion: "SUCCESS", status: "COMPLETED" },
    { conclusion: "FAILURE", status: "COMPLETED" },
    { conclusion: "CANCELLED", status: "COMPLETED" },
    { conclusion: null, status: "IN_PROGRESS" },
  ]);
});

test("prState maps DECLINED to CLOSED and never touches the statuses endpoint", () => {
  clearCalls();
  set("pr.json", JSON.stringify({ id: 7, state: "DECLINED" }));
  assert.equal(forge.prState(PR_URL), "CLOSED");
  assert.doesNotMatch(calls().join("\n"), /statuses/);
});

test("prMerge posts to the merge endpoint of the PR parsed from its url", () => {
  clearCalls();
  forge.prMerge(PR_URL);
  assert.match(calls().join("\n"), /-X POST.*pullrequests\/7\/merge/);
});

test("prCreate posts source/destination branches and returns the new PR url — creds stay off argv", () => {
  clearCalls();
  set("pr-create.json", JSON.stringify({ id: 9, links: { html: { href: "https://bitbucket.org/acme/widget/pull-requests/9" } } }));
  const url = forge.prCreate({ title: "[factory] T-9: add x", body: "what/why", head: "factory/T-9", base: "develop" });
  assert.equal(url, "https://bitbucket.org/acme/widget/pull-requests/9");
  const argv = calls().join("\n");
  assert.match(argv, /-X POST/);
  assert.match(argv, /repositories\/acme\/widget\/pullrequests(\s|$)/);
  assert.match(argv, /"title":"\[factory\] T-9: add x"/);
  assert.match(argv, /"description":"what\/why"/);
  assert.match(argv, /"source":\{"branch":\{"name":"factory\/T-9"\}\}/);
  assert.match(argv, /"destination":\{"branch":\{"name":"develop"\}\}/);
  assert.doesNotMatch(argv, /sekret-tok/, "token must not be visible to ps");
  assert.match(lastStdin(), /user = "m@example\.com:sekret-tok"/);
});

test("prComments maps PR comments to {author, body, createdAt}", () => {
  clearCalls();
  set("pr-comments.json", JSON.stringify({ values: [
    { user: { display_name: "Owner One" }, content: { raw: "use develop" }, created_on: "2026-07-20T10:00:00Z" },
  ] }));
  assert.deepEqual(forge.prComments(PR_URL), [
    { author: "Owner One", body: "use develop", createdAt: "2026-07-20T10:00:00Z" },
  ]);
  assert.match(calls().join("\n"), /pullrequests\/7\/comments/);
});

test("issueComments maps issue comments to {author, body, createdAt}", () => {
  clearCalls();
  set("issue-comments.json", JSON.stringify({ values: [
    { user: { display_name: "Owner One" }, content: { raw: "answer: option 2" }, created_on: "2026-07-20T11:00:00Z" },
  ] }));
  assert.deepEqual(forge.issueComments(3), [
    { author: "Owner One", body: "answer: option 2", createdAt: "2026-07-20T11:00:00Z" },
  ]);
  assert.match(calls().join("\n"), /issues\/3\/comments/);
});

test("issueListClosed queries the closed states and maps to issue rows", () => {
  clearCalls();
  set("issue-closed.json", JSON.stringify({ values: [
    { id: 4, state: "resolved", title: "[factory] question: which db", links: { html: { href: "u4" } } },
  ] }));
  assert.deepEqual(forge.issueListClosed(), [{ number: 4, title: "[factory] question: which db", url: "u4" }]);
  const line = calls().find((l) => /\/issues\?/.test(l) && /resolved/.test(l));
  assert.ok(line, "must query closed-ish states server-side");
});

test("prListMerged hits state=MERGED and maps to the open-list row shape", () => {
  clearCalls();
  set("pr-merged.json", JSON.stringify({ values: [{
    id: 2, title: "[factory] T-002: fe scaffold",
    links: { html: { href: "https://bitbucket.org/acme/widget/pull-requests/2" } },
    source: { branch: { name: "factory/T-002" } },
  }] }));
  assert.deepEqual(forge.prListMerged(), [{
    number: 2, url: "https://bitbucket.org/acme/widget/pull-requests/2",
    title: "[factory] T-002: fe scaffold", headRefName: "factory/T-002",
  }]);
  assert.match(calls().join("\n"), /pullrequests\?state=MERGED/);
});

test("prComment posts content.raw", () => {
  clearCalls();
  forge.prComment(PR_URL, "gate says hi");
  const line = calls().find((l) => /pullrequests\/7\/comments/.test(l));
  assert.match(line, /gate says hi/);
  assert.match(line, /content/);
});

test("issue lists filter open states SERVER-side — the 100-issue page must hold open issues, not history", () => {
  clearCalls();
  set("issue-list.json", JSON.stringify({ values: [] }));
  forge.issueListOpen();
  const line = calls().find((l) => /\/issues\?/.test(l));
  assert.match(line, /q=state/, "must pass a q= state filter, not fetch all states");
});

test("async with missing credentials resolves the real error immediately, not a curl timeout", async () => {
  const f = createForge({ kind: "bitbucket", project, env: {} });
  const t0 = Date.now();
  const r = await f.async.prList();
  assert.match(r.error, /BITBUCKET_EMAIL/);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0}ms — must not wait out the curl timeout`);
});

test("issueListOpen keeps only open-ish tracker states", () => {
  set("issue-list.json", JSON.stringify({ values: [
    { id: 1, state: "new", title: "[factory] question: a", links: { html: { href: "https://bitbucket.org/acme/widget/issues/1" } } },
    { id: 2, state: "resolved", title: "old", links: { html: { href: "u2" } } },
    { id: 3, state: "on hold", title: "[factory] question: b", links: { html: { href: "u3" } } },
  ] }));
  assert.deepEqual(forge.issueListOpen().map((i) => i.number), [1, 3]);
});

test("issueCreate posts title + content.raw and returns the html url", () => {
  clearCalls();
  set("issue-create.json", JSON.stringify({ id: 9, links: { html: { href: "https://bitbucket.org/acme/widget/issues/9" } } }));
  const url = forge.issueCreate({ title: "[factory] question: pick", body: "which one?" });
  assert.equal(url, "https://bitbucket.org/acme/widget/issues/9");
  const line = calls().find((l) => /-X POST.*\/issues/.test(l));
  assert.match(line, /pick/);
  assert.match(line, /which one\?/);
});

test("issueComment posts to the issue's comments endpoint", () => {
  clearCalls();
  forge.issueComment(3, "same question");
  assert.match(calls().join("\n"), /issues\/3\/comments/);
});

test("a disabled issue tracker (HTTP error) throws — the question queue absorbs and retries", () => {
  set("issues-fail", '{"type": "error"}');
  assert.throws(() => forge.issueListOpen());
  set("issues-fail", "");
});

test("authCheck: missing env keys → fail row naming both keys, no network call", () => {
  clearCalls();
  const f = createForge({ kind: "bitbucket", project, env: {} });
  const rows = f.authCheck({ wantBoard: false });
  assert.equal(rows[0].level, "fail");
  assert.match(rows[0].detail, /BITBUCKET_EMAIL/);
  assert.match(rows[0].detail, /BITBUCKET_API_TOKEN/);
  assert.equal(calls().length, 0);
});

test("authCheck: valid token → ok row; wantBoard warns that the GitHub board needs a github forge", () => {
  set("user.json", JSON.stringify({ display_name: "Marcos" }));
  const rows = forge.authCheck({ wantBoard: true });
  assert.equal(rows[0].level, "ok");
  assert.match(rows[0].detail, /Marcos/);
  const board = rows.find((r) => r.name === "board");
  assert.equal(board.level, "warn");
  assert.match(board.detail, /github forge/);
  assert.match(board.detail, /"jira"/, "the warn must point at the Jira board alternative");
});

test("authCheck: rejected token → fail row", () => {
  set("auth-fail", "401 unauthorized");
  const rows = forge.authCheck({});
  assert.equal(rows[0].level, "fail");
  set("auth-fail", "");
});

test("prListText renders one line per open PR", () => {
  set("pr-list.json", JSON.stringify({ values: [{
    id: 5, title: "[factory] T-001: t",
    links: { html: { href: "u" } }, source: { branch: { name: "factory/T-001" } },
  }] }));
  const text = forge.prListText();
  assert.match(text, /#5/);
  assert.match(text, /\[factory\] T-001: t/);
});

test("async prList maps dashboard rows and resolves {error} on garbage", async () => {
  set("pr-list.json", JSON.stringify({ values: [{
    id: 5, title: "t", draft: true,
    links: { html: { href: "u" } }, source: { branch: { name: "b" } },
  }] }));
  const r = await forge.async.prList();
  assert.deepEqual(r.data, [{ number: 5, title: "t", url: "u", isDraft: true, headRefName: "b", statusCheckRollup: [] }]);
  set("pr-list.json", "not json");
  const bad = await forge.async.prList();
  assert.ok(bad.error);
});

test("async issueList maps open issues with empty labels (title convention carries needs-human)", async () => {
  set("issue-list.json", JSON.stringify({ values: [
    { id: 1, state: "new", title: "[factory] question: a", links: { html: { href: "u1" } } },
    { id: 2, state: "resolved", title: "old", links: { html: { href: "u2" } } },
  ] }));
  const r = await forge.async.issueList();
  assert.deepEqual(r.data, [{ number: 1, title: "[factory] question: a", url: "u1", labels: [] }]);
});

test("async remoteBranchSha resolves the branch head hash, null when unknown", async () => {
  set("branch.json", JSON.stringify({ name: "main", target: { hash: "bb123" } }));
  assert.equal(await forge.async.remoteBranchSha("main"), "bb123");
  set("branch.json", "garbage");
  assert.equal(await forge.async.remoteBranchSha("main"), null);
});

test("a non-bitbucket origin fails loudly, naming the url", () => {
  const f = createForge({ kind: "bitbucket", project: makeProject("git@github.com:o/r.git"), env: ENV });
  assert.throws(() => f.prListOpen(), /github\.com/);
});

// nativeTrackerCheck on Bitbucket — the client shape that exposed it: issues are OFF by
// default and the API answers 410 Gone, while every PR call keeps working.
test("nativeTrackerCheck: 410 Gone (issues off — the Bitbucket default) → WARN naming both ways out", () => {
  set("issues-fail", "curl: (22) The requested URL returned error: 410");
  const row = nativeTrackerCheck(forge);
  assert.equal(row.level, "warn");
  assert.equal(row.name, "bitbucket issue tracker");
  assert.match(row.detail, /queue silently/, "the cost must be spelled out — filings vanish, nothing else shows it");
  assert.match(row.detail, /enable it in the repo settings/i);
  assert.match(row.detail, /"tracker": "jira"/);
  set("issues-fail", "");
});

test("nativeTrackerCheck: a reachable Bitbucket tracker is one ok row", () => {
  set("issues-fail", "");
  set("issue-list.json", JSON.stringify({ values: [] }));
  const row = nativeTrackerCheck(forge);
  assert.equal(row.level, "ok");
});

test("nativeTrackerCheck: a transient 503 only WARNS — a blip must not abort a scheduled window", () => {
  set("issues-fail", "curl: (22) The requested URL returned error: 503");
  const row = nativeTrackerCheck(forge);
  assert.equal(row.level, "warn");
  set("issues-fail", "");
});
