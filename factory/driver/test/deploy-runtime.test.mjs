import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { makeFactory } from "./helpers.mjs";
import { stateDir } from "../paths.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, "..", "..", "..");

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// A machine-runtime world: a bare "GitHub" origin seeded with this repo's
// factory/ tree, a ~/.factory/runtime clone under a fake HOME, and a
// registry. deploy-runtime is exercised as the runtime's own copy — the
// deployed version runs the deploy of the next one.
const makeRuntimeWorld = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-test-"));
  t?.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const seed = path.join(root, "seed");
  fs.mkdirSync(seed);
  git(seed, "init", "-b", "main");
  git(seed, "config", "user.email", "runtime-test@example.com");
  git(seed, "config", "user.name", "runtime-test");
  fs.cpSync(path.join(REPO, "factory"), path.join(seed, "factory"), {
    recursive: true,
    filter: (src) => !src.split(path.sep).includes("test"),
  });
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "seed runtime");

  const origin = path.join(root, "runtime-origin.git");
  fs.mkdirSync(origin);
  git(origin, "init", "--bare", "--initial-branch=main");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");

  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".factory"), { recursive: true });
  const runtime = path.join(home, ".factory", "runtime");
  git(root, "clone", "-q", origin, runtime);
  git(runtime, "config", "user.email", "runtime-test@example.com");
  git(runtime, "config", "user.name", "runtime-test");
  fs.writeFileSync(path.join(home, ".factory", "registry.json"),
    JSON.stringify({ factories: {} }, null, 2) + "\n");
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ projects: {} }, null, 2));

  return { root, seed, origin, home, runtime };
};

// Publish a new commit on the origin (what a merged PR does to main).
const commitOnOrigin = (world, mutate, msg = "advance") => {
  mutate(world.seed);
  git(world.seed, "add", "-A");
  git(world.seed, "commit", "-q", "-m", msg);
  git(world.seed, "push", "-q", "origin", "main");
  return git(world.seed, "rev-parse", "HEAD");
};

// Register a makeFactory project in the runtime world's HOME (registry +
// workspace trust + machine-side state + its stub-gh bin dir on PATH).
const registerFactory = (world, factoryWorld) => {
  const regPath = path.join(world.home, ".factory", "registry.json");
  const reg = JSON.parse(fs.readFileSync(regPath, "utf8"));
  reg.factories[factoryWorld.project] = { name: path.basename(factoryWorld.project) };
  fs.writeFileSync(regPath, JSON.stringify(reg, null, 2) + "\n");
  const trustPath = path.join(world.home, ".claude.json");
  const trust = JSON.parse(fs.readFileSync(trustPath, "utf8"));
  const theirs = JSON.parse(fs.readFileSync(path.join(factoryWorld.home, ".claude.json"), "utf8"));
  Object.assign(trust.projects, theirs.projects);
  fs.writeFileSync(trustPath, JSON.stringify(trust, null, 2));
  // The factory's machine-side state was created under ITS fake HOME —
  // mirror it into the runtime world's HOME, where deploy's doctor looks.
  fs.cpSync(factoryWorld.stateDir, stateDir(factoryWorld.project, world.home), { recursive: true });
  return path.join(factoryWorld.root, "bin");
};

const runDeploy = (world, { extraPath = "" } = {}) => {
  const r = spawnSync(
    process.execPath,
    [path.join(world.runtime, "factory", "driver", "deploy-runtime.mjs")],
    {
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        HOME: world.home,
        PATH: extraPath ? `${extraPath}:${process.env.PATH}` : process.env.PATH,
      },
    }
  );
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

const runtimeHead = (world) => git(world.runtime, "rev-parse", "HEAD");

test("runtime already at origin tip → no-op, exit 0", (t) => {
  const world = makeRuntimeWorld(t);
  const before = runtimeHead(world);

  const r = runDeploy(world);

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /up to date/i);
  assert.equal(runtimeHead(world), before);
});

test("advances to origin tip when gates pass and stamps the deploy", (t) => {
  const world = makeRuntimeWorld(t);
  const factory = makeFactory(t);
  const binDir = registerFactory(world, factory);
  const target = commitOnOrigin(world, (seed) => {
    fs.appendFileSync(path.join(seed, "factory", "driver", "factory.mjs"), "// deploy-test marker\n");
  });

  const r = runDeploy(world, { extraPath: binDir });

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.equal(runtimeHead(world), target);
  const stamp = JSON.parse(fs.readFileSync(path.join(world.home, ".factory", "runtime-deploy.json"), "utf8"));
  assert.equal(stamp.to, target);
  assert.notEqual(stamp.from, target);
});

test("a deploy that changes dashboard.mjs prints the restart hint — the live process keeps old code", (t) => {
  const world = makeRuntimeWorld(t);
  const factory = makeFactory(t);
  const binDir = registerFactory(world, factory);
  commitOnOrigin(world, (seed) => {
    fs.appendFileSync(path.join(seed, "factory", "driver", "dashboard.mjs"), "// dashboard change marker\n");
  });

  const r = runDeploy(world, { extraPath: binDir });

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /dashboard\.mjs changed[\s\S]*restart/i);
});

test("a driver-only deploy prints no dashboard restart hint", (t) => {
  const world = makeRuntimeWorld(t);
  const factory = makeFactory(t);
  const binDir = registerFactory(world, factory);
  commitOnOrigin(world, (seed) => {
    fs.appendFileSync(path.join(seed, "factory", "driver", "factory.mjs"), "// driver-only marker\n");
  });

  const r = runDeploy(world, { extraPath: binDir });

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.doesNotMatch(r.stdout, /dashboard\.mjs changed/i);
});

test("candidate with a syntax error is refused and the runtime stays put", (t) => {
  const world = makeRuntimeWorld(t);
  const before = runtimeHead(world);
  commitOnOrigin(world, (seed) => {
    fs.writeFileSync(path.join(seed, "factory", "driver", "broken.mjs"), "const x = (;\n");
  });

  const r = runDeploy(world);

  assert.equal(r.code, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout + r.stderr, /broken\.mjs/);
  assert.equal(runtimeHead(world), before);
  // gate worktree cleaned up — only the runtime itself remains
  assert.equal(git(world.runtime, "worktree", "list").split("\n").length, 1);
});

test("candidate failing a registered factory's doctor is refused", (t) => {
  const world = makeRuntimeWorld(t);
  const factory = makeFactory(t);
  const binDir = registerFactory(world, factory);
  fs.rmSync(path.join(stateDir(factory.project, world.home), "config.json")); // kills doctor
  const before = runtimeHead(world);
  commitOnOrigin(world, (seed) => {
    fs.appendFileSync(path.join(seed, "factory", "driver", "factory.mjs"), "// deploy-test marker\n");
  });

  const r = runDeploy(world, { extraPath: binDir });

  assert.equal(r.code, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout + r.stderr, new RegExp(path.basename(factory.project)));
  assert.equal(runtimeHead(world), before);
});

test("dirty runtime tree refuses to deploy", (t) => {
  const world = makeRuntimeWorld(t);
  const before = runtimeHead(world);
  commitOnOrigin(world, (seed) => {
    fs.appendFileSync(path.join(seed, "factory", "driver", "factory.mjs"), "// deploy-test marker\n");
  });
  fs.appendFileSync(path.join(world.runtime, "factory", "driver", "factory.mjs"), "// local edit\n");

  const r = runDeploy(world);

  assert.equal(r.code, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout + r.stderr, /dirty|uncommitted/i);
  assert.equal(runtimeHead(world), before);
});

test("runtime with local commits (not fast-forwardable) refuses", (t) => {
  const world = makeRuntimeWorld(t);
  commitOnOrigin(world, (seed) => {
    fs.appendFileSync(path.join(seed, "factory", "driver", "factory.mjs"), "// deploy-test marker\n");
  });
  fs.appendFileSync(path.join(world.runtime, "README-local.md"), "local\n");
  git(world.runtime, "add", "-A");
  git(world.runtime, "commit", "-q", "-m", "local commit");
  const before = runtimeHead(world);

  const r = runDeploy(world);

  assert.equal(r.code, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout + r.stderr, /local commit|fast-forward/i);
  assert.equal(runtimeHead(world), before);
});

test("a live window in any registered factory blocks the deploy", (t) => {
  const world = makeRuntimeWorld(t);
  const factory = makeFactory(t);
  const binDir = registerFactory(world, factory);
  const before = runtimeHead(world);
  commitOnOrigin(world, (seed) => {
    fs.appendFileSync(path.join(seed, "factory", "driver", "factory.mjs"), "// deploy-test marker\n");
  });
  // A window lock held by a live pid (this test runner) — mid-window deploy
  // would hand the running driver new prompts and a new MCP child.
  const lockDir = path.join(stateDir(factory.project, world.home), "log");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, "window.lock"),
    JSON.stringify({ pid: process.pid, mode: "dev" }));

  const r = runDeploy(world, { extraPath: binDir });

  assert.equal(r.code, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout + r.stderr, /live window/i);
  assert.equal(runtimeHead(world), before);
});
