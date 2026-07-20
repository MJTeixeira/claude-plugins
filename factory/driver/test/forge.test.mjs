// Forge adapter contract: the capability surface and return shapes every
// forge implementation must honor (GitHub today, Bitbucket later). These
// tests pin the shapes the driver and dashboard rely on — a second impl
// passes by producing the SAME shapes, whatever its transport looks like.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createForge, nativeTrackerCheck } from "../forge.mjs";

// One programmable stub gh for the whole file: dispatch on "$1 $2", canned
// responses live in files each test rewrites. Tests in a file run
// sequentially, so rewrites can't race.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-test-"));
const ghDir = path.join(root, "bin");
fs.mkdirSync(ghDir);
fs.writeFileSync(
  path.join(ghDir, "gh"),
  `#!/bin/sh
ROOT="$(dirname "$0")"
printf '%s\\n' "$*" >> "$ROOT/calls.log"
case "$1 $2" in
  "auth status")
    if [ -s "$ROOT/auth-err" ]; then cat "$ROOT/auth-err" >&2; exit 1; fi
    cat "$ROOT/auth.txt"; exit 0 ;;
  "pr view") cat "$ROOT/pr-view.json" ;;
  "pr list") cat "$ROOT/pr-list.out" ;;
  "issue list")
    if [ -s "$ROOT/issues-err" ]; then cat "$ROOT/issues-err" >&2; exit 1; fi
    cat "$ROOT/issue-list.json" ;;
  "issue create") echo "https://github.com/o/r/issues/12" ;;
  "pr create") echo "https://github.com/o/r/pull/33" ;;
  "pr merge") echo "merge blocked" >&2; exit 1 ;;
  "api repos/o/r/branches/main"|"api repos/{owner}/{repo}/branches/main") cat "$ROOT/branch.json" ;;
  *) echo "" ;;
esac
exit 0
`
);
fs.chmodSync(path.join(ghDir, "gh"), 0o755);
process.env.PATH = `${ghDir}${path.delimiter}${process.env.PATH}`;

// The stub resolves $ROOT to its own directory — canned files live there.
const set = (name, content) => fs.writeFileSync(path.join(ghDir, name), content);
const calls = () => {
  const p = path.join(ghDir, "calls.log");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim().split("\n") : [];
};
const clearCalls = () => fs.rmSync(path.join(ghDir, "calls.log"), { force: true });

// The stub answers regardless of cwd; any dir works as the "project".
const forge = createForge({ project: root, env: {} });

test("kind defaults to github and exposes the binary name for PATH checks", () => {
  assert.equal(forge.kind, "github");
  assert.equal(forge.bin, "gh");
});

test("unknown forge kind fails fast, naming the kind", () => {
  assert.throws(() => createForge({ kind: "sourcehut", project: root, env: {} }), /sourcehut/);
});

test("prView fetches the full merge-gate field set and returns the parsed view", () => {
  clearCalls();
  const view = {
    state: "OPEN", number: 7, title: "[factory] T-002: x",
    headRefName: "factory/T-002", mergeable: "MERGEABLE",
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
  };
  set("pr-view.json", JSON.stringify(view));
  assert.deepEqual(forge.prView("https://github.com/o/r/pull/7"), view);
  const line = calls().find((l) => l.startsWith("pr view"));
  for (const f of ["state", "number", "title", "headRefName", "mergeable", "statusCheckRollup"]) {
    assert.match(line, new RegExp(f), `pr view must request ${f}`);
  }
});

test("prState is a cheap state-only read — never the flaky check-rollup query", () => {
  clearCalls();
  set("pr-view.json", JSON.stringify({ state: "MERGED" }));
  assert.equal(forge.prState("https://github.com/o/r/pull/7"), "MERGED");
  const line = calls().find((l) => l.startsWith("pr view"));
  assert.match(line, /state/);
  assert.doesNotMatch(line, /statusCheckRollup/, "gate-approval sweeps must not depend on the rollup query");
});

test("prListOpen returns the parsed open-PR rows for the sweep, draft flag included", () => {
  clearCalls();
  const rows = [{ number: 5, url: "u", title: "[factory] T-001: t", headRefName: "factory/T-001", isDraft: false },
    { number: 6, url: "u6", title: "T-002: claimed by a human", headRefName: "anything", isDraft: true }];
  set("pr-list.out", JSON.stringify(rows));
  assert.deepEqual(forge.prListOpen(), rows);
  // isDraft is how the sweep tells a human's claim from mergeable work —
  // the query must actually request it.
  assert.match(calls().find((l) => l.startsWith("pr list")), /isDraft/);
});

test("prListText returns the human-readable list untouched (repo snapshot)", () => {
  set("pr-list.out", "5\t[factory] T-001\tfactory/T-001\n");
  assert.equal(forge.prListText(), "5\t[factory] T-001\tfactory/T-001\n");
});

test("issueListOpen returns the parsed open issues (needs-human dedupe)", () => {
  const rows = [{ number: 3, title: "[factory] question: pick a color", url: "u3" }];
  set("issue-list.json", JSON.stringify(rows));
  assert.deepEqual(forge.issueListOpen(), rows);
});

test("issueCreate returns the new issue's trimmed url", () => {
  const url = forge.issueCreate({ title: "[factory] question: x", body: "b" });
  assert.equal(url, "https://github.com/o/r/issues/12");
});

test("prCreate opens a PR with head, base, title and body, returning the trimmed url", () => {
  clearCalls();
  const url = forge.prCreate({ title: "[factory] T-9: add x", body: "what/why", head: "factory/T-9", base: "develop" });
  assert.equal(url, "https://github.com/o/r/pull/33");
  const line = calls().find((l) => l.startsWith("pr create"));
  assert.ok(line, "must call gh pr create");
  for (const frag of ["--head factory/T-9", "--base develop", "--title [factory] T-9: add x", "--body what/why"]) {
    assert.ok(line.includes(frag), `argv must carry '${frag}' (got: ${line})`);
  }
});

test("a failing forge command throws — callers' try/catch stays load-bearing", () => {
  assert.throws(() => forge.prMerge("https://github.com/o/r/pull/9"));
});

test("authCheck: not authenticated → one fail row with the tool's error", () => {
  set("auth-err", "You are not logged into any GitHub hosts.");
  const rows = forge.authCheck({ wantBoard: false });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].level, "fail");
  assert.match(rows[0].detail, /not logged in/i);
  set("auth-err", "");
});

test("authCheck: board enabled but 'project' scope missing → fail with the refresh hint", () => {
  set("auth.txt", "github.com\n  Token scopes: 'repo'\n");
  const rows = forge.authCheck({ wantBoard: true });
  const scopeRow = rows.find((r) => /scopes/.test(r.name));
  assert.equal(scopeRow.level, "fail");
  assert.match(scopeRow.detail, /project/);
  assert.match(scopeRow.detail, /refresh/);
});

test("authCheck: fine-grained token (no scopes listed) → ok", () => {
  set("auth.txt", "github.com\n  Logged in to github.com\n");
  const rows = forge.authCheck({ wantBoard: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].level, "ok");
  assert.match(rows[0].detail, /authenticated/);
});

test("board escape hatch exists on the github forge only", () => {
  assert.equal(typeof forge.github.out, "function");
  assert.equal(typeof forge.github.jsonOut, "function");
});

test("async prList resolves {data} with dashboard fields, never rejects", async () => {
  clearCalls();
  const rows = [{ number: 5, title: "t", url: "u", isDraft: false, headRefName: "b", statusCheckRollup: [] }];
  set("pr-list.out", JSON.stringify(rows));
  const r = await forge.async.prList();
  assert.deepEqual(r.data, rows);
  const line = calls().find((l) => l.startsWith("pr list"));
  for (const f of ["isDraft", "statusCheckRollup"]) assert.match(line, new RegExp(f));
});

test("async prList: unparseable output resolves {error}", async () => {
  set("pr-list.out", "not json");
  const r = await forge.async.prList();
  assert.ok(r.error);
  assert.equal(r.data, undefined);
});

test("async issueList resolves {data} including labels", async () => {
  clearCalls();
  const rows = [{ number: 3, title: "q", url: "u", labels: [{ name: "needs-human" }] }];
  set("issue-list.json", JSON.stringify(rows));
  const r = await forge.async.issueList();
  assert.deepEqual(r.data, rows);
  assert.match(calls().find((l) => l.startsWith("issue list")), /labels/);
});

test("async remoteBranchSha resolves the branch head sha, null when unknown", async () => {
  set("branch.json", JSON.stringify({ name: "main", commit: { sha: "abc123" } }));
  assert.equal(await forge.async.remoteBranchSha("main"), "abc123");
  set("branch.json", "garbage");
  assert.equal(await forge.async.remoteBranchSha("main"), null);
});

// nativeTrackerCheck — a repo whose issue tracker is switched off answers
// every other forge call normally, so nothing else in doctor sees it and
// needs-human filings queue forever (first live Bitbucket pilot, 2026-07-19).
test("nativeTrackerCheck: a reachable tracker is one ok row", () => {
  set("issues-err", "");
  set("issue-list.json", JSON.stringify([]));
  const row = nativeTrackerCheck(forge);
  assert.equal(row.level, "ok");
  assert.match(row.name, /github issue tracker/);
});

// WARN, not FAIL: doctor is the scheduled preflight, and a closed question
// mailbox must not cancel a window that would otherwise ship working code (the
// 2026-07-19 pilot window did exactly that). Questions queue and retry; the
// driver announces the stranded count out-of-band.
test("nativeTrackerCheck: issues disabled → WARN naming both ways out", () => {
  set("issues-err", "GraphQL: Issues are disabled for this repository");
  const row = nativeTrackerCheck(forge);
  assert.equal(row.level, "warn");
  assert.match(row.detail, /enable it in the repo settings/i);
  assert.match(row.detail, /"tracker": "jira"/, "the fix must name the Jira alternative");
  set("issues-err", "");
});

test("nativeTrackerCheck: an unrecognized failure WARNS — doctor is the scheduled preflight, a blip must not cost a window", () => {
  set("issues-err", "error connecting to api.github.com");
  const row = nativeTrackerCheck(forge);
  assert.equal(row.level, "warn");
  assert.match(row.detail, /could not read the issue tracker/);
  set("issues-err", "");
});
