// Toolchain manifest (autonomy epic chunk 7): `toolchain: [{name, check}]`
// in config declares the tools a project's sessions depend on; doctor runs
// each check and fails the row when one is missing. Scheduled runs already
// abort on doctor fails, so a missing tool stops a window BEFORE it burns
// sessions against it — the row is the preflight.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFactory, runDriver } from "./helpers.mjs";

test("doctor greens a toolchain whose checks all pass, one row per tool", (t) => {
  const world = makeFactory(t, {
    config: { toolchain: [{ name: "node", check: "node --version" }, { name: "git", check: "git --version" }] },
  });

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /✓ toolchain: node/);
  assert.match(r.stdout, /✓ toolchain: git/);
});

test("a failing tool check is a doctor FAIL naming the tool — scheduled windows abort on it", (t) => {
  const world = makeFactory(t, {
    config: { toolchain: [{ name: "unicorn-cli", check: "definitely-not-a-real-command-xyz --version" }] },
  });

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 1, "a missing declared tool must fail doctor");
  assert.match(r.stdout, /✗ toolchain: unicorn-cli/);
});

test("a malformed toolchain manifest fails doctor instead of silently skipping checks", (t) => {
  const world = makeFactory(t, {
    config: { toolchain: [{ name: "node" }] }, // missing check — a typo must not turn the preflight off
  });

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 1);
  assert.match(r.stdout, /✗ toolchain/);
  assert.match(r.stdout, /malformed/);
});

test("no toolchain key means no rows — undeclared projects are untouched", (t) => {
  const world = makeFactory(t);

  const r = runDriver(world, "doctor");

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.doesNotMatch(r.stdout, /toolchain/);
});
