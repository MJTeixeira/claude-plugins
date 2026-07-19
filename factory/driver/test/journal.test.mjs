import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeFactory, queueSessions, runDriver } from "./helpers.mjs";

const journalFiles = (world) =>
  fs.readdirSync(path.join(world.stateDir, "log")).filter((f) => /^journal-.*\.jsonl$/.test(f)).sort();

const readJournal = (world, file) =>
  fs.readFileSync(path.join(world.stateDir, "log", file), "utf8")
    .trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

const NO_TASKS_SESSION = {
  script: `mkdir -p .factory/log && echo '{"taskId":null,"status":"no-tasks","summary":"none"}' > .factory/log/last-session.json`,
  stdout: JSON.stringify({ type: "result", subtype: "success", result: "no tasks", total_cost_usd: 0.01, num_turns: 2, usage: { input_tokens: 1, output_tokens: 2 } }) + "\n",
  exit: 0,
};

test("a window writes a per-window journal: start, sessions, finalization, complete", (t) => {
  const world = makeFactory(t);
  queueSessions(world, [NO_TASKS_SESSION]);

  const r = runDriver(world, "dev");
  assert.equal(r.code, 0, `driver exited ${r.code}\n${r.stdout}\n${r.stderr}`);

  const files = journalFiles(world);
  assert.equal(files.length, 1, `expected one journal file, got: ${files}`);
  const steps = readJournal(world, files[0]).map((x) => x.step);
  assert.ok(steps.includes("window-start"), `no window-start in ${steps}`);
  assert.ok(steps.includes("session"), `no session record in ${steps}`);
  for (const s of ["finalize:repo", "finalize:scratch", "finalize:board-sync", "finalize:lock", "finalize:complete"]) {
    assert.ok(steps.includes(s), `missing ${s} in ${steps}`);
  }
  assert.equal(steps.indexOf("finalize:complete"), steps.length - 1, "complete marker is not last");
});

test("an unfinished window's finalization is replayed by the next prep run, missing steps only", (t) => {
  const world = makeFactory(t);
  const logDir = path.join(world.stateDir, "log");
  fs.mkdirSync(logDir, { recursive: true });

  // Forge the post-crash state the fleet EACCES crash left behind (NOTES 33):
  // window started, sweep done, then death — no board sync, lock never
  // released, scratch never removed.
  const stamp = "2026-07-08T09-00-00-000Z";
  fs.writeFileSync(
    path.join(logDir, `journal-${stamp}.jsonl`),
    [
      JSON.stringify({ ts: "2026-07-08T09:00:00.000Z", step: "window-start", status: "done" }),
      JSON.stringify({ ts: "2026-07-08T09:10:00.000Z", step: "session", status: "done", detail: "1 T-001 review" }),
      JSON.stringify({ ts: "2026-07-08T13:00:00.000Z", step: "finalize:sweep", status: "done" }),
    ].join("\n") + "\n"
  );
  fs.writeFileSync(path.join(logDir, "window.lock"), JSON.stringify({ pid: 99999999, mode: "dev" }));
  fs.mkdirSync(path.join(world.stateDir, "tmp"), { recursive: true });
  fs.writeFileSync(path.join(world.stateDir, "tmp", "leftover.txt"), "scratch");

  const r = runDriver(world, "prep");
  assert.equal(r.code, 0, `prep exited ${r.code}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /unfinished window .* completing/i);

  const steps = readJournal(world, `journal-${stamp}.jsonl`);
  const names = steps.map((x) => x.step);
  assert.equal(names.filter((s) => s === "finalize:sweep").length, 1, "sweep was re-run despite being journaled done");
  for (const s of ["finalize:repo", "finalize:scratch", "finalize:board-sync", "finalize:lock", "finalize:complete"]) {
    assert.ok(names.includes(s), `replay did not complete ${s}: ${names}`);
  }
  assert.ok(!fs.existsSync(path.join(world.stateDir, "tmp", "leftover.txt")), "scratch not cleaned by replay");

  // A second prep run must not replay again — the journal is complete.
  const r2 = runDriver(world, "prep");
  assert.equal(r2.code, 0);
  assert.doesNotMatch(r2.stdout, /unfinished window/i);
});
