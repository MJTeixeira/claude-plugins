// Operational-state model (NOTES item 47): a factory is scheduled,
// manual-only, or disabled — all three doctor green and take updates;
// disabled refuses only the session-running modes.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeFactory, runDriver } from "./helpers.mjs";

test("doctor stays green on a disabled factory", (t) => {
  const world = makeFactory(t, { config: { enabled: false } });

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /✓ enabled — DISABLED/);
});

test("doctor fails on a malformed enabled value", (t) => {
  const world = makeFactory(t, { config: { enabled: "yes" } });

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /✗ enabled — .*must declare "enabled"/);
});

test("manual dev and triage runs are refused when disabled", (t) => {
  const world = makeFactory(t, { config: { enabled: false } });

  for (const mode of ["dev", "triage"]) {
    const r = runDriver(world, mode);
    assert.equal(r.code, 1, `${mode} should refuse\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stderr, /factory is disabled/);
  }
});

test("a scheduled fire into a disabled factory exits 0 with one log line and no lock", (t) => {
  const world = makeFactory(t, { config: { enabled: false } });

  const r = runDriver(world, "dev", ["--scheduled"]);

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const logDir = path.join(world.stateDir, "log");
  const logFile = fs.readdirSync(logDir).find((f) => f.startsWith("factory-") && f.endsWith(".log"));
  assert.ok(logFile, "driver log should exist");
  assert.match(fs.readFileSync(path.join(logDir, logFile), "utf8"), /dev run skipped — factory disabled/);
  assert.ok(!fs.existsSync(path.join(logDir, "window.lock")), "no lock for a skipped run");
});

test("prep still works on a disabled factory — updates never depend on state", (t) => {
  const world = makeFactory(t, { config: { enabled: false } });

  const r = runDriver(world, "prep");

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
});
