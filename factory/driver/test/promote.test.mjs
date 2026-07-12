// `factory.mjs promote <milestone>` — milestone promotion as a driver verb
// (PR-F). Flips the milestone heading in .factory/backlog/index.md from
// `— not-started` (or `— gated`) to `— active`, committed and pushed as the
// driver via the meta worktree. Replaces the hand-edited `factory/ops-*`
// PR that tripped the merge-gate's "task branches are code-only" warning.
// Keep-prior-active is the default: other milestones are never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeFactory, runDriver, gitIn } from "./helpers.mjs";

const INDEX = `# Backlog index — Test

Milestones in delivery order.

## M1 Foundations — active
Walking skeleton. (REQ-1)
- [e1](e1.md) — backlog/e1.md — 0/1 done

## M2 Gray-box — not-started
Playable loop. (REQ-2)
- [e2](e2.md) — backlog/e2.md — 0/2 done

## M3 Ship it — gated
Owner gate. (REQ-3)

## M0 Spike — done
Proven throwaway.
`;

const setIndex = (world) => {
  fs.writeFileSync(path.join(world.factoryDir, "backlog", "index.md"), INDEX);
  gitIn(world.project, "add", "-A", ".factory");
  gitIn(world.project, "commit", "-q", "-m", "milestone-shaped index");
  gitIn(world.project, "push", "-q", "origin", "main");
};

const originIndex = (world) =>
  gitIn(world.origin, "show", "main:.factory/backlog/index.md");

test("promote flips a not-started milestone to active, committed as the driver", (t) => {
  const world = makeFactory(t);
  setIndex(world);

  const r = runDriver(world, "promote", ["M2"]);

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const idx = originIndex(world);
  assert.match(idx, /^## M2 Gray-box — active$/m, `M2 not promoted on origin:\n${idx}`);
  // keep-prior-active: M1 stays active, M0 stays done
  assert.match(idx, /^## M1 Foundations — active$/m, "prior active milestone must be kept");
  assert.match(idx, /^## M0 Spike — done$/m);
  const msg = gitIn(world.origin, "log", "-1", "--format=%s", "main");
  assert.match(msg, /promote M2/i, `commit message: ${msg}`);
});

test("promote also opens a gated milestone", (t) => {
  const world = makeFactory(t);
  setIndex(world);

  const r = runDriver(world, "promote", ["M3"]);

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(originIndex(world), /^## M3 Ship it — active$/m);
});

test("promoting an already-active milestone is an idempotent no-op", (t) => {
  const world = makeFactory(t);
  setIndex(world);
  const head = gitIn(world.origin, "rev-parse", "main");

  const r = runDriver(world, "promote", ["M1"]);

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /already active/i);
  assert.equal(gitIn(world.origin, "rev-parse", "main"), head, "no commit for a no-op");
});

test("promote refuses a done milestone and an unknown one", (t) => {
  const world = makeFactory(t);
  setIndex(world);

  const done = runDriver(world, "promote", ["M0"]);
  assert.equal(done.code, 1);
  assert.match(done.stderr, /done/i, `stderr: ${done.stderr}`);

  const unknown = runDriver(world, "promote", ["M9"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /M9/, `stderr: ${unknown.stderr}`);
  assert.match(unknown.stderr, /M1|M2|M3/, "must list the milestones it can see");
});

test("promote without a milestone argument fails with usage", (t) => {
  const world = makeFactory(t);
  setIndex(world);

  const r = runDriver(world, "promote", []);

  assert.equal(r.code, 1);
  assert.match(r.stderr, /promote <milestone>/);
});
