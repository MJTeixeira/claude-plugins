// Tests for the SessionStart contract injector. Run:
//   node --test "hooks/test/*.test.mjs"
// Each case feeds a SessionStart event to the hook binary: empty stdout =
// no injection, a hookSpecificOutput JSON with additionalContext = injected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HOOK = new URL("../inject-contract.mjs", import.meta.url).pathname;

const run = (cwd, input) => {
  const r = spawnSync(process.execPath, [HOOK], {
    input: input ?? JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd }),
    encoding: "utf8",
  });
  return r;
};

const makeDir = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "inject-test-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return fs.realpathSync(d);
};

const optIn = (root) => {
  fs.mkdirSync(path.join(root, ".docs"), { recursive: true });
  fs.writeFileSync(path.join(root, ".docs", "index.md"), "# map\n");
};

const injected = (r) => {
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  return out.hookSpecificOutput.additionalContext;
};

test("project without .docs → silent, no injection", (t) => {
  const d = makeDir(t);
  const r = run(d);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
});

test("opted-in project root → injects the contract, markers stripped", (t) => {
  const d = makeDir(t);
  optIn(d);
  const ctx = injected(run(d));
  assert.match(ctx, /code4food-skillset/, "contract content missing");
  assert.doesNotMatch(ctx, /MANAGED BLOCK/, "marker comment lines must be stripped");
});

test("subdirectory of an opted-in project → still injects (walk-up)", (t) => {
  const d = makeDir(t);
  optIn(d);
  fs.mkdirSync(path.join(d, ".git"), { recursive: true });
  const sub = path.join(d, "src", "deep");
  fs.mkdirSync(sub, { recursive: true });
  injected(run(sub));
});

test("the walk stops at the project boundary: a .git root without .docs never inherits a parent's opt-in", (t) => {
  const parent = makeDir(t);
  optIn(parent);
  const child = path.join(parent, "other-repo");
  fs.mkdirSync(path.join(child, ".git"), { recursive: true });
  const r = run(child);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
});

test("malformed stdin → silent, exit 0", (t) => {
  const d = makeDir(t);
  optIn(d);
  const r = run(d, "this is not json");
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
});

test("deleted cwd with no cwd in stdin → silent, exit 0 (fail-quiet survives process.cwd() throwing)", (t) => {
  const d = makeDir(t);
  const dead = path.join(d, "dead");
  fs.mkdirSync(dead);
  const r = spawnSync("/bin/sh",
    ["-c", `cd "${dead}" && rm -rf "${dead}" && "${process.execPath}" "${HOOK}"`],
    { input: JSON.stringify({ hook_event_name: "SessionStart" }), encoding: "utf8" });
  assert.equal(r.status, 0, `stderr:\n${r.stderr}`);
  assert.equal(r.stdout.trim(), "");
});

test("the contract stays well under the 10k-char SessionStart output cap", (t) => {
  const d = makeDir(t);
  optIn(d);
  const ctx = injected(run(d));
  assert.ok(ctx.length < 9000,
    `contract is ${ctx.length} chars — approaching the 10k harness cap; shrink it before it silently degrades`);
});
