import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeFactory, queueSessions, runDriver, gitIn } from "./helpers.mjs";
import { factoryKey } from "../paths.mjs";

// The persistent meta worktree, located the way the driver locates it.
const metaDir = (world) =>
  path.join(world.home, ".factory", "worktrees", factoryKey(world.project), "meta");

// Drive a project into the item-50 wedge: its meta worktree stranded at a
// commit that TRACKS .claude/settings.local.json (which materialization then
// skip-worktree's) while the base branch has since dropped the file. The
// stranded skip-worktree'd copy makes `checkout base` throw "local changes
// would be overwritten" — the exact 4-day fleet failure.
const strandMetaOnDroppedTooling = (world) => {
  const local = path.join(world.project, ".claude", "settings.local.json");
  // 1. base branch tracks settings.local.json (force-add: it's conventionally
  //    in a global gitignore, but a pre-migrate scaffold committed it anyway) …
  fs.writeFileSync(local, "{}\n");
  gitIn(world.project, "add", "-f", ".claude/settings.local.json");
  gitIn(world.project, "commit", "-m", "track settings.local.json");
  gitIn(world.project, "push", "origin", "main");
  // 2. … prep builds the meta worktree at that commit (tracked → skip-worktree) …
  const first = runDriver(world, "prep");
  assert.equal(first.code, 0, `setup prep failed\n${first.stdout}\n${first.stderr}`);
  // 3. … then a migrate-style strip drops it from base, but the meta worktree
  //    stays stranded at the old commit that still tracks it.
  gitIn(world.project, "rm", ".claude/settings.local.json");
  gitIn(world.project, "commit", "-m", "drop settings.local.json (migrate strip)");
  gitIn(world.project, "push", "origin", "main");
};

test("refreshMeta self-heals a meta worktree stranded on tooling the base branch dropped", (t) => {
  const world = makeFactory(t);
  strandMetaOnDroppedTooling(world);

  const r = runDriver(world, "prep");
  assert.equal(r.code, 0, `prep did not recover from the wedge — repo stayed 'not ready'\n${r.stdout}\n${r.stderr}`);

  const meta = metaDir(world);
  assert.equal(
    gitIn(meta, "rev-parse", "HEAD"),
    gitIn(world.origin, "rev-parse", "main"),
    "meta worktree did not advance to the base tip after recovery"
  );
  assert.equal(gitIn(meta, "ls-files", "--", ".claude/settings.local.json"), "", "meta still tracks the dropped tooling file");
  assert.equal(gitIn(meta, "status", "--porcelain"), "", "meta worktree left dirty after recovery");
});

test("recovery preserves an unpushed metadata commit — parked on a rescue branch, not lost", (t) => {
  const world = makeFactory(t);
  strandMetaOnDroppedTooling(world);

  // A committed-but-unpushed metadata commit on the stranded (detached) meta
  // HEAD — the failed-push-at-boundary case that must never be reset away.
  const meta = metaDir(world);
  fs.writeFileSync(path.join(meta, "carry.txt"), "carry me\n");
  gitIn(meta, "add", "carry.txt");
  gitIn(meta, "commit", "-m", "unpushed metadata commit");
  const carried = gitIn(meta, "rev-parse", "HEAD");

  const r = runDriver(world, "prep");
  assert.equal(r.code, 0, `prep did not recover from the wedge\n${r.stdout}\n${r.stderr}`);

  // The unpushed commit survived: parked on a rescue branch pointing at it.
  const listed = gitIn(world.project, "branch", "--list", "factory/meta-rescue-*");
  const rescue = listed.replace(/^[*+ ]+/, "").split("\n")[0].trim();
  assert.ok(rescue, `no rescue branch created — the unpushed commit was lost\n${r.stdout}`);
  assert.equal(gitIn(world.project, "rev-parse", rescue), carried, "rescue branch does not point at the carried commit");
});

test("a healthy meta worktree advances in place — no needless recreate", (t) => {
  const world = makeFactory(t);
  const first = runDriver(world, "prep");
  assert.equal(first.code, 0, `first prep failed\n${first.stdout}\n${first.stderr}`);

  // Advance the base branch by an ordinary commit — a clean fast-forward.
  fs.writeFileSync(path.join(world.project, "README.md"), "hello\n");
  gitIn(world.project, "add", "-A");
  gitIn(world.project, "commit", "-m", "ordinary base advance");
  gitIn(world.project, "push", "origin", "main");

  const r = runDriver(world, "prep");
  assert.equal(r.code, 0, `healthy prep failed\n${r.stdout}\n${r.stderr}`);
  assert.doesNotMatch(r.stdout, /recreat/i, "healthy advance recreated the meta worktree instead of advancing in place");
  assert.equal(
    gitIn(metaDir(world), "rev-parse", "HEAD"),
    gitIn(world.origin, "rev-parse", "main"),
    "meta worktree did not advance to the base tip"
  );
});

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
      // no settled report of any kind (fleet task T-034, 2026-07-09).
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
  // gateCommand: this world has no CI, and the floor (gate-suite.test.mjs)
  // refuses to merge on nothing — the landing mechanics under test need a
  // passing verification to reach.
  const world = makeFactory(t, { config: { autonomy: "auto-merge-dev", gateCommand: "true" } });
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

// ---------- prep prunes stale-locked worktrees (ops backlog item 4) ----------
// A LOCKED registered worktree whose locker died lingers forever: `worktree
// prune` skips locked entries, and quarantine can't remove a registered
// worktree (git resurrects it). A bridge/cloud session crash left one in a
// fleet repo for days (2026-07-14): permanent dirty tree, window-end ff
// refused. Only locks whose reason carries a DEAD pid are pruned — a human
// lock (no pid in the reason) is preserved and logged, never broken.

const addLockedWorktree = (world, name, reason) => {
  const p = path.join(world.project, ".claude", "worktrees", name);
  gitIn(world.project, "worktree", "add", "--detach", p);
  gitIn(world.project, "worktree", "lock", "--reason", reason, p);
  return p;
};

const worktreeList = (world) => gitIn(world.project, "worktree", "list", "--porcelain");

// A pid that is certainly dead: a child that already exited.
const deadPid = () => spawnSync("true").pid;

test("prep removes a locked worktree whose lock pid is dead, quarantining its dirty bytes", (t) => {
  const world = makeFactory(t);
  // Mirror the fleet mitigation: bridge worktrees are globally gitignored.
  fs.mkdirSync(path.join(world.home, ".config", "git"), { recursive: true });
  fs.writeFileSync(path.join(world.home, ".config", "git", "ignore"), "**/.claude/worktrees/\n");
  const wt = addLockedWorktree(world, "bridge-dead", `claude bridge session pid ${deadPid()}`);
  fs.writeFileSync(path.join(wt, "uncommitted.txt"), "unsaved work\n");

  const r = runDriver(world, "prep");

  assert.equal(r.code, 0, `prep failed\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /stale-locked worktree/);
  assert.ok(!worktreeList(world).includes(wt), "stale-locked worktree still registered");
  assert.ok(!fs.existsSync(wt), "stale-locked worktree dir still on disk");
  const logDir = path.join(world.stateDir, "log");
  const qdirs = fs.readdirSync(logDir).filter((d) => d.startsWith("quarantine-"));
  assert.ok(qdirs.some((d) => fs.existsSync(path.join(logDir, d, "uncommitted.txt"))),
    "dirty bytes were not quarantined before removal");
});

test("prep leaves a locked worktree whose lock pid is alive", (t) => {
  const world = makeFactory(t);
  const wt = addLockedWorktree(world, "bridge-live", `claude bridge session pid ${process.pid}`);

  const r = runDriver(world, "prep");

  assert.equal(r.code, 0, `prep failed\n${r.stdout}\n${r.stderr}`);
  assert.ok(worktreeList(world).includes(wt), "live-locked worktree was removed");
});

test("prep preserves a human lock (no pid in the reason) and says so", (t) => {
  const world = makeFactory(t);
  const wt = addLockedWorktree(world, "held", "manual hold for review");

  const r = runDriver(world, "prep");

  assert.equal(r.code, 0, `prep failed\n${r.stdout}\n${r.stderr}`);
  assert.ok(worktreeList(world).includes(wt), "human-locked worktree was removed");
  assert.match(r.stdout, /no pid in lock reason|leaving/i);
});
