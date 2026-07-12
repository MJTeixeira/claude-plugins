import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeFactory, queueSessions, runDriver, gitIn } from "./helpers.mjs";

const NO_TASKS_SESSION = {
  script: `mkdir -p .factory/log && echo '{"taskId":null,"status":"no-tasks","summary":"none"}' > .factory/log/last-session.json`,
  stdout: JSON.stringify({ type: "result", subtype: "success", result: "no tasks", total_cost_usd: 0.01, num_turns: 2, usage: { input_tokens: 1, output_tokens: 2 } }) + "\n",
  exit: 0,
};

test("a dev window never touches the human checkout: branch, WIP, and no quarantine", (t) => {
  const world = makeFactory(t);
  // The owner's state: parked on a WIP branch with an uncommitted file.
  gitIn(world.project, "checkout", "-b", "owner-wip");
  fs.writeFileSync(path.join(world.project, "owner-notes.txt"), "half-written thought\n");

  queueSessions(world, [NO_TASKS_SESSION]);
  const r = runDriver(world, "dev");
  assert.equal(r.code, 0, `driver exited ${r.code}\n${r.stdout}\n${r.stderr}`);

  assert.equal(gitIn(world.project, "branch", "--show-current"), "owner-wip", "window flipped the owner's branch");
  assert.equal(fs.readFileSync(path.join(world.project, "owner-notes.txt"), "utf8"), "half-written thought\n", "owner WIP was touched");
  const logDir = path.join(world.stateDir, "log");
  assert.ok(!fs.readdirSync(logDir).some((f) => f.startsWith("quarantine-")), "owner WIP was quarantined");
  assert.equal(gitIn(world.project, "stash", "list"), "", "owner WIP was stashed");
});

test("sessions run in a throwaway worktree cut from origin, removed afterwards", (t) => {
  const world = makeFactory(t);
  queueSessions(world, [NO_TASKS_SESSION]);
  const r = runDriver(world, "dev");
  assert.equal(r.code, 0, `driver exited ${r.code}\n${r.stdout}\n${r.stderr}`);

  const inv = JSON.parse(fs.readFileSync(path.join(world.stubDir, "invocation-1.json"), "utf8"));
  assert.notEqual(inv.cwd, fs.realpathSync(world.project), "session ran in the project checkout, not a worktree");
  assert.ok(inv.cwd.includes(path.join(".factory", "worktrees")), `session cwd is not under ~/.factory/worktrees: ${inv.cwd}`);
  assert.ok(!fs.existsSync(inv.cwd), "session worktree was not removed after the session");
  // The worktree path was trusted so the session's tools actually work (NOTES
  // item 11) — BOTH flags: hasCompletedProjectOnboarding is what makes Claude
  // Code apply the project allowlist under dontAsk (NOTES item 42).
  const trust = JSON.parse(fs.readFileSync(path.join(world.home, ".claude.json"), "utf8"));
  const entry = Object.entries(trust.projects).find(([k]) => path.basename(k) === path.basename(inv.cwd))?.[1];
  assert.ok(entry, `worktree path missing from ~/.claude.json trust: ${Object.keys(trust.projects)}`);
  assert.equal(entry.hasTrustDialogAccepted, true, "worktree missing hasTrustDialogAccepted");
  assert.equal(entry.hasCompletedProjectOnboarding, true, "worktree missing hasCompletedProjectOnboarding — allowlist won't apply under dontAsk");
});

test("a dirty session worktree is quarantined to log/ before removal", (t) => {
  const world = makeFactory(t, { config: { maxSessionsPerWindow: 1 } });
  queueSessions(world, [
    {
      // A capped/killed session's shape: uncommitted work in the worktree,
      // no settled report of any kind (rpg-solo T-034, 2026-07-09).
      script: `mkdir -p src && echo "half-finished feature" > src/wip.txt`,
      stdout: JSON.stringify({ type: "result", subtype: "error_max_turns", total_cost_usd: 0.03, num_turns: 4, usage: { input_tokens: 1, output_tokens: 2 } }) + "\n",
      exit: 1,
    },
  ]);

  const r = runDriver(world, "dev");
  assert.equal(r.code, 0, `driver exited ${r.code}\n${r.stdout}\n${r.stderr}`);

  // The worktree is still gone…
  const inv = JSON.parse(fs.readFileSync(path.join(world.stubDir, "invocation-1.json"), "utf8"));
  assert.ok(!fs.existsSync(inv.cwd), "session worktree was not removed");
  // …but its uncommitted bytes survived under log/quarantine-*.
  const logDir = path.join(world.stateDir, "log");
  const qdirs = fs.readdirSync(logDir).filter((f) => f.startsWith("quarantine-"));
  assert.ok(qdirs.length, `no quarantine dir in log/\nstdout:\n${r.stdout}`);
  const saved = qdirs.find((d) => fs.existsSync(path.join(logDir, d, "src", "wip.txt")));
  assert.ok(saved, `wip.txt not saved in any quarantine dir (${qdirs.join(", ")})`);
  assert.equal(fs.readFileSync(path.join(logDir, saved, "src", "wip.txt"), "utf8"), "half-finished feature\n");
  assert.match(r.stdout, /dirty worktree — 1 path\(s\) copied to .*quarantine-/);
});

test("merge gate lands a green PR from the meta worktree: flip rides the merge commit, owner checkout untouched", (t) => {
  const world = makeFactory(t, { config: { autonomy: "auto-merge-dev" } });
  // Owner parked on a branch; must still be there when the gate is done.
  gitIn(world.project, "checkout", "-b", "owner-wip");

  // Programmable gh: the gate asks pr view (open, mergeable) and pr checks (green).
  const ghDir = path.join(world.root, "stub-gh");
  fs.mkdirSync(ghDir);
  fs.writeFileSync(
    path.join(ghDir, "gh"),
    `#!/bin/sh
case "$1 $2" in
  "pr view") echo '{"state":"OPEN","number":7,"title":"[factory] T-001 sample","headRefName":"factory/t-001","mergeable":"MERGEABLE"}' ;;
  "pr checks") exit 0 ;;
  "pr list") echo '[]' ;;
  *) echo "" ;;
esac
exit 0
`
  );
  fs.chmodSync(path.join(ghDir, "gh"), 0o755);
  fs.appendFileSync(path.join(world.stateDir, ".env"), `STUB_GH_DIR=${ghDir}\n`);

  queueSessions(world, [
    {
      // Real dev-session shape, from inside its worktree: task branch with a
      // code commit, pushed; landing report says review + PR url.
      script: `git checkout -b factory/t-001 &&
echo "the feature" > feature.txt &&
git add feature.txt &&
git commit -q -m "T-001: add feature" &&
git push -q -u origin factory/t-001 &&
mkdir -p .factory/log &&
echo '{"taskId":"T-001","status":"review","summary":"built","pr":"https://github.com/o/r/pull/7"}' > .factory/log/last-session.json`,
      stdout: JSON.stringify({ type: "result", subtype: "success", result: "review", total_cost_usd: 0.5, num_turns: 20, usage: { input_tokens: 5, output_tokens: 50 } }) + "\n",
      exit: 0,
    },
    NO_TASKS_SESSION,
  ]);

  const r = runDriver(world, "dev");
  assert.equal(r.code, 0, `driver exited ${r.code}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /merge-gate: checks green — merged .*T-001 → done/);

  // origin/main got ONE merge commit carrying the code AND the backlog flip.
  const originLog = gitIn(world.origin, "log", "--format=%s", "main");
  assert.match(originLog.split("\n")[0], /Merge PR #7/);
  const merged = gitIn(world.origin, "show", "main:feature.txt");
  assert.equal(merged, "the feature");
  const backlog = gitIn(world.origin, "show", "main:.factory/backlog/e1.md");
  assert.match(backlog, /- Status: done/);

  // The owner's checkout: still on their branch, not fast-forwarded into a
  // different branch, no gate droppings.
  assert.equal(gitIn(world.project, "branch", "--show-current"), "owner-wip");
});
