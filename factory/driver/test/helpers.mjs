// Test harness for the factory driver: builds a throwaway factory project
// with a file:// bare origin, a stub `claude`, and a fake $HOME (trust,
// registry), then runs the real driver against it as a child process.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { stateDir } from "../paths.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const driverPath = path.join(here, "..", "factory.mjs");
export const stubClaudePath = path.join(here, "stub-claude.mjs");

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// One temp world per test: { root, project, origin, home, stubDir, stateDir }
// The world is post-migration shaped: work data committed in the project
// repo, config/.env/log machine-side under the fake $HOME.
export const makeFactory = (t, { config = {}, tasks, plan } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-test-"));
  t?.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const origin = path.join(root, "origin.git");
  fs.mkdirSync(origin);
  git(origin, "init", "--bare", "--initial-branch=main");

  const project = path.join(root, "project");
  git(root, "clone", origin, project);
  git(project, "checkout", "-b", "main");
  git(project, "config", "user.email", "factory-test@example.com");
  git(project, "config", "user.name", "factory-test");

  const stubDir = path.join(root, "stub");
  fs.mkdirSync(stubDir);

  // Stub gh on PATH: doctor's `gh auth status` must pass without network,
  // and pr-only fixtures only ever need empty-but-successful answers.
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, "gh"),
    `#!/bin/sh
if [ "$1 $2" = "auth status" ]; then echo "Token scopes: 'repo', 'project'"; exit 0; fi
if [ -n "$STUB_GH_DIR" ] && [ -x "$STUB_GH_DIR/gh" ]; then exec "$STUB_GH_DIR/gh" "$@"; fi
echo ""
exit 0
`
  );
  fs.chmodSync(path.join(binDir, "gh"), 0o755);

  const f = path.join(project, ".factory");
  fs.mkdirSync(path.join(f, "backlog"), { recursive: true });
  fs.mkdirSync(path.join(f, "spec"));
  fs.writeFileSync(path.join(f, "spec", "goal.md"), "# Goal\nTest fixture.\n");
  // No .factory/prompts/ and no .factory/hooks/ — prompts ship with the
  // runtime (O6), and the guard + allowlist are INJECTED into worktrees at
  // spawn (P2). The repo carries only work data plus the owner's own
  // .claude/settings.json below (injection must coexist with it).
  fs.writeFileSync(
    path.join(f, "backlog", "index.md"),
    "# Backlog\n\n- [e1](e1.md) — backlog/e1.md — 0/1 done\n"
  );
  fs.writeFileSync(
    path.join(f, "backlog", "e1.md"),
    tasks ??
      "# Epic 1\n\n## T-001: sample task\n\n- Status: todo\n- Reqs: REQ-1\n- Acceptance: it works\n- Verify: true\n"
  );
  // `log` unslashed: it must also match the meta worktree's log SYMLINK —
  // `log/` matches only directories, and a committed symlink loops the fleet.
  fs.writeFileSync(path.join(f, ".gitignore"), ".env\nlog\ntmp/\nplan.json\nboard.json\nSTOP\n");
  // Healthy migrated factories carry the teammate contract file (team
  // affordances) — doctor treats a missing one as scaffold drift.
  fs.writeFileSync(path.join(f, "README.md"), "# Factory work data (test fixture)\n");
  fs.mkdirSync(path.join(project, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(project, ".claude", "settings.json"),
    JSON.stringify({ permissions: { allow: ["Bash", "Read", "Edit", "Write"] } }, null, 2) + "\n"
  );
  git(project, "add", "-A");
  git(project, "commit", "-m", "factory scaffold (test fixture)");
  git(project, "push", "origin", "main");

  // Fake $HOME: workspace trust for the project (and its realpath — macOS
  // tmpdirs live behind /private) so preflight passes.
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  const trusted = {};
  for (const k of new Set([project, fs.realpathSync(project)])) {
    trusted[k] = { hasTrustDialogAccepted: true };
  }
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ projects: trusted }, null, 2));

  // Machine-side state under the fake $HOME — the driver reads config/.env
  // from here, never from the repo.
  const sd = stateDir(project, home);
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(
    path.join(sd, "config.json"),
    JSON.stringify(
      {
        enabled: true,
        baseBranch: "main",
        claudeCmd: stubClaudePath,
        schedule: "manual",
        autonomy: "pr-only",
        permissionMode: "acceptEdits",
        windowHours: 1,
        sessionTimeoutMin: 1,
        maxSessionsPerWindow: 3,
        mergeGateMinutes: 1,
        ...config,
      },
      null,
      2
    ) + "\n"
  );
  fs.writeFileSync(path.join(sd, ".env"), `STUB_DIR=${stubDir}\n`);

  // Default: a fresh empty plan ("triage answered: nothing eligible") so dev
  // windows keep the pre-plan self-select behavior most fixtures rely on and
  // never auto-triage. `plan: null` = no plan.json (exercises auto-triage);
  // an object = written verbatim.
  if (plan !== null) {
    fs.writeFileSync(
      path.join(sd, "plan.json"),
      JSON.stringify(plan ?? { generatedAt: new Date().toISOString(), queue: [] })
    );
  }

  return { root, project, origin, home, stubDir, factoryDir: f, stateDir: sd };
};

// Queue the stub's next sessions: scenario({...}) or an array of scenarios.
export const queueSessions = (world, scenarios) => {
  for (const [i, s] of scenarios.entries()) {
    fs.writeFileSync(path.join(world.stubDir, `session-${i + 1}.json`), JSON.stringify(s));
  }
};

export const runDriver = (world, mode, extraArgs = [], { timeoutMs = 120_000, input, nodeArgs = [] } = {}) => {
  const r = spawnSync(
    process.execPath,
    [...nodeArgs, driverPath, mode, "--project", world.project, ...extraArgs],
    {
      encoding: "utf8",
      timeout: timeoutMs,
      // input undefined leaves stdin closed (non-TTY, empty) — confirm
      // prompts must then abort, never hang.
      input: input ?? "",
      env: { ...process.env, HOME: world.home, PATH: `${path.join(world.root, "bin")}:${process.env.PATH}` },
    }
  );
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", signal: r.signal };
};

export const readUsageRows = (world) => {
  const p = path.join(world.stateDir, "log", "usage.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
};

export const gitIn = (dir, ...args) => git(dir, ...args);
