// Backlog index parsing. Every dialect pinned here is one that a real
// compile-spec session actually wrote into a fleet factory — the format was
// never specified, so three of them exist and the parser must read all
// three (2026-07-19: `promote` and the dashboard both assumed `## M1 …`,
// so 4 of 6 factories parsed to zero milestones and nothing said so).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseMilestones, unparsedMilestoneHeadings, parseTaskFile, parseBacklogTasks } from "../backlog-index.mjs";

// --- the three dialects found on disk ---------------------------------

test("canonical dialect: h2, colon, em-dash status", () => {
  const ms = parseMilestones(`# Backlog

## Milestones

## M1: Login & browse — active
- [e1-scaffolding](e1-scaffolding.md) — 4 tasks
- [e2-oauth](e2-oauth.md) — 5 tasks

## M2: Account management — not-started
- [e8-schema-forms](e8-schema-forms.md) — 3 tasks
`);
  assert.deepEqual(ms.map((m) => [m.id, m.title, m.status]), [
    ["M1", "Login & browse", "active"],
    ["M2", "Account management", "not-started"],
  ]);
  assert.deepEqual(ms[0].epics.map((e) => e.id), ["e1-scaffolding", "e2-oauth"]);
  assert.equal(ms[0].epics[0].file, "e1-scaffolding.md");
});

test("h3 + colon dialect (two fleet projects) parses — it did not before", () => {
  const ms = parseMilestones(`## Milestones

### M1: Core upgrades — done

### M2: Daily life — active
- [e3-habits](e3-habits.md) — 2/4 done
`);
  assert.deepEqual(ms.map((m) => [m.id, m.status]), [["M1", "done"], ["M2", "active"]]);
  assert.equal(ms[1].epics[0].id, "e3-habits");
});

test("spelled-out id with a parenthesized status (a fleet project) parses — it did not before", () => {
  const ms = parseMilestones(`## Milestone 1 — Phase 0: Foundations (active)
- e0-skeleton — 6/6 done
- e1-api — 0/6 done
`);
  assert.equal(ms.length, 1);
  assert.equal(ms[0].id, "M1");
  assert.equal(ms[0].status, "active");
  assert.equal(ms[0].title, "Phase 0: Foundations", "the em-dash here separates id from title, not title from status");
  assert.deepEqual(ms[0].epics.map((e) => e.id), ["e0-skeleton", "e1-api"]);
});

test("h2 without a colon (two more fleet projects) still parses", () => {
  const ms = parseMilestones("## M1 Foundations — done\n## M3 Voyage & prestige — active\n");
  assert.deepEqual(ms.map((m) => [m.id, m.title, m.status]), [
    ["M1", "Foundations", "done"],
    ["M3", "Voyage & prestige", "active"],
  ]);
});

// --- the traps --------------------------------------------------------

test("a hyphenated title with no status does NOT donate its last word as the status", () => {
  const ms = parseMilestones("## M1: Multi-player\n");
  assert.equal(ms[0].status, null, "'player' must not be read as a status");
  assert.equal(ms[0].title, "Multi-player");
});

test("a hyphenated title WITH a status keeps both apart", () => {
  const ms = parseMilestones("## M2 Gray-box loop — done\n");
  assert.equal(ms[0].title, "Gray-box loop");
  assert.equal(ms[0].status, "done");
});

test("statusStart/statusEnd address the status token in place, whatever the dialect", () => {
  for (const line of ["## M1: Login — not-started", "## Milestone 1 — Foundations (not-started)"]) {
    const m = parseMilestones(line)[0];
    assert.equal(line.slice(m.statusStart, m.statusEnd), "not-started",
      `offsets must isolate the status token in: ${line}`);
    // What `promote` does with them.
    const flipped = line.slice(0, m.statusStart) + "active" + line.slice(m.statusEnd);
    assert.equal(parseMilestones(flipped)[0].status, "active");
    assert.equal(parseMilestones(flipped)[0].title, m.title, "flipping the status must not disturb the title");
  }
});

test("a later non-milestone heading ends the epic list — stray bullets are not adopted", () => {
  const ms = parseMilestones(`## M1: Start — active
- [e1-a](e1-a.md) — 1 task

## Notes
- not an epic, just prose
`);
  assert.deepEqual(ms[0].epics.map((e) => e.id), ["e1-a"]);
});

test("bullets before any milestone heading belong to no milestone", () => {
  const ms = parseMilestones("- [e0-orphan](e0-orphan.md) — 1 task\n## M1: Start — active\n");
  assert.equal(ms.length, 1);
  assert.deepEqual(ms[0].epics, []);
});

// --- the drift signal doctor reads ------------------------------------

test("a backlog with no milestones at all is legal and silent", () => {
  assert.deepEqual(unparsedMilestoneHeadings("# Backlog\n\nJust epics here.\n- [e1-a](e1-a.md)\n"), []);
});

test("every dialect the parser handles is silent to the drift check", () => {
  const text = "## M1 A — done\n### M2: B — active\n## Milestone 3 — C (not-started)\n";
  assert.deepEqual(unparsedMilestoneHeadings(text), []);
});

test("a NEW dialect the parser cannot read is reported, not silently dropped", () => {
  const text = "## Phase 1: Foundations — active\n## Sprint 2 — not-started\n";
  assert.equal(parseMilestones(text).length, 0);
  assert.deepEqual(unparsedMilestoneHeadings(text), [
    "## Phase 1: Foundations — active",
    "## Sprint 2 — not-started",
  ]);
});

test("the '## Milestones' section header above the real headings is not itself drift", () => {
  const text = "## Milestones\n\n### M1: Login — active\n";
  assert.equal(parseMilestones(text).length, 1);
  assert.deepEqual(unparsedMilestoneHeadings(text), [],
    "the section header has no number — it is scaffolding, not a broken milestone");
});

// --- review findings: the guard must not have the bug it guards against ---

test("a heading that parses but whose status is unreadable counts as DRIFT, not clean", () => {
  // The 2026-07-19 incident wearing the guard's uniform: these all match the
  // heading shape, so an "unparsed headings" check that only looks at the
  // heading would call them clean while promote and the dashboard both fail.
  for (const line of ["## M1: Foo — in progress", "## M1: Foo — **active**", "## M1: Foo — active ##"]) {
    assert.equal(parseMilestones(line)[0].status, null, `precondition: ${line} has no readable status`);
    assert.deepEqual(unparsedMilestoneHeadings(line), [line],
      `a milestone nothing can act on must be reported: ${line}`);
  }
});

test("an off-vocabulary status counts as drift — promote only acts on the known four", () => {
  assert.deepEqual(unparsedMilestoneHeadings("## M1: Foo — inprogress"), ["## M1: Foo — inprogress"]);
  for (const s of ["active", "not-started", "gated", "done"]) {
    assert.deepEqual(unparsedMilestoneHeadings(`## M1: Foo — ${s}`), [], `${s} is vocabulary`);
  }
});

test("CRLF line endings parse — the regexes this replaced tolerated them", () => {
  const ms = parseMilestones("## Milestones\r\n\r\n## M1: Login — active\r\n- [e1-a](e1-a.md) — 2 tasks\r\n");
  assert.equal(ms.length, 1, "a CRLF index must not read as zero milestones");
  assert.equal(ms[0].status, "active");
  assert.equal(ms[0].title, "Login");
  assert.deepEqual(ms[0].epics.map((e) => e.id), ["e1-a"]);
  assert.deepEqual(unparsedMilestoneHeadings("## M1: Login — active\r\n"), []);
});

test("promote's splice offsets stay correct on a CRLF file", () => {
  const text = "## M1: Login — not-started\r\n";
  const m = parseMilestones(text)[0];
  const flipped = m.line.slice(0, m.statusStart) + "active" + m.line.slice(m.statusEnd);
  const out = text.slice(0, m.index) + flipped + text.slice(m.index + m.line.length);
  assert.equal(out, "## M1: Login — active\r\n", "the CR must survive the splice, not be swallowed or duplicated");
});

test("ordinary index prose does not trip the drift row", () => {
  // A row that cries wolf gets trained out of — which is the failure this
  // whole change exists to prevent.
  for (const line of ["## Milestones (3)", "### e1 — Phase 1 scaffolding",
    "## Open questions for phase 2", "## Sprint retro notes 2026"]) {
    assert.deepEqual(unparsedMilestoneHeadings(line), [], `false positive on: ${line}`);
  }
});

test("a genuinely broken milestone heading is still caught after the prose fix", () => {
  assert.deepEqual(unparsedMilestoneHeadings("## Phase 1: Foundations — active"), ["## Phase 1: Foundations — active"]);
  assert.deepEqual(unparsedMilestoneHeadings("## Sprint 2 — not-started"), ["## Sprint 2 — not-started"]);
  assert.deepEqual(unparsedMilestoneHeadings("## Milestone A — active"), ["## Milestone A — active"]);
});

// --- task parsing (the same one-format-two-parsers shape, closed before
// --- it bit: factory.mjs and dashboard.mjs each carried a private copy) --

test("a full task block yields every field either consumer reads", () => {
  const tasks = parseTaskFile(`# e2-oauth

## T-021: Add OAuth login
- Status: in-progress
- Gate: human (owner reviews the consent screen)
- Model: opus
- Effort: high
- Question: https://github.com/o/r/issues/7
- PR: https://github.com/o/r/pull/12

## T-022: Refresh tokens
- Status: todo
`, "e2-oauth");
  assert.equal(tasks.length, 2);
  const t = tasks[0];
  assert.equal(t.id, "T-021");
  assert.equal(t.title, "Add OAuth login");
  assert.equal(t.status, "in-progress");
  assert.equal(t.gate, "human");
  assert.equal(t.model, "opus");
  assert.equal(t.effort, "high");
  assert.equal(t.epic, "e2-oauth");
  assert.equal(t.question, "https://github.com/o/r/issues/7");
  assert.deepEqual(t.links, ["https://github.com/o/r/issues/7", "https://github.com/o/r/pull/12"]);
  assert.deepEqual(tasks[1], {
    id: "T-022", title: "Refresh tokens", status: "todo", gate: null,
    model: null, effort: null, epic: "e2-oauth", question: null, links: [],
  });
});

test("a task with no Status line defaults to todo", () => {
  const tasks = parseTaskFile("## T-001: Bootstrap\n", "e1");
  assert.equal(tasks[0].status, "todo");
});

test("non-task h2 headings and prose are ignored", () => {
  const tasks = parseTaskFile(`## Context

Some prose about the epic.

## T-002: Real task
- Status: done

## Open questions
- none
`, "e1");
  assert.deepEqual(tasks.map((t) => t.id), ["T-002"]);
});

test("Question: accepts only http(s) URLs — it lands in a dashboard href", () => {
  const tasks = parseTaskFile("## T-003: Risky\n- Status: todo\n- Question: javascript:alert(1)\n", "e1");
  assert.equal(tasks[0].question, null);
});

test("parseBacklogTasks walks the dir, skips index.md, epic = filename minus .md", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backlog-test-"));
  fs.writeFileSync(path.join(dir, "index.md"), "## M1: X — active\n## T-999: not a task, lives in the index\n- Status: todo\n");
  fs.writeFileSync(path.join(dir, "e1-scaffolding.md"), "## T-001: A\n- Status: done\n");
  fs.writeFileSync(path.join(dir, "e2.md.notes.md"), "## T-002: B\n- Status: todo\n");
  fs.writeFileSync(path.join(dir, "notes.txt"), "## T-003: not markdown\n");
  const tasks = parseBacklogTasks(dir);
  assert.deepEqual(tasks.map((t) => [t.id, t.epic]).sort(), [["T-001", "e1-scaffolding"], ["T-002", "e2.md.notes"]]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("parseBacklogTasks on a missing dir returns []", () => {
  assert.deepEqual(parseBacklogTasks("/nonexistent/backlog"), []);
});
