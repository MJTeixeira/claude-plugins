import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { makeFactory, startTelegramStub } from "./helpers.mjs";
import { stateDir } from "../paths.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, "..", "..", "..");

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// A machine-runtime world: a bare "GitHub" origin seeded with this repo's
// factory/ tree, a ~/.factory/runtime clone under a fake HOME, and a
// registry. deploy-runtime is exercised as the runtime's own copy — the
// deployed version runs the deploy of the next one.
const makeRuntimeWorld = (t, { withPlugins = false } = {}) => {
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
  // withPlugins: the runtime ships the plugin marketplace (post-G3 shape) —
  // deploy's plugin sync only engages on such runtimes.
  if (withPlugins) {
    fs.cpSync(path.join(REPO, ".claude-plugin"), path.join(seed, ".claude-plugin"), { recursive: true });
  }
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

// expectedOrigin: what the deploy treats as the canonical distribution repo
// (FACTORY_RUNTIME_ORIGIN). Defaults to the world's own bare origin; pass
// null to leave the env unset and exercise the real hardcoded canonical URL.
// telegramApi: FACTORY_TELEGRAM_API override pointing at a startTelegramStub.
const runDeploy = (world, { extraPath = "", pathOverride = null, expectedOrigin = world.origin, telegramApi = null } = {}) => {
  const r = spawnSync(
    process.execPath,
    [path.join(world.runtime, "factory", "driver", "deploy-runtime.mjs")],
    {
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        HOME: world.home,
        CLAUDE_STUB_LOG: path.join(world.root, "claude-calls.log"),
        PATH: pathOverride ?? (extraPath ? `${extraPath}:${process.env.PATH}` : process.env.PATH),
        ...(expectedOrigin ? { FACTORY_RUNTIME_ORIGIN: expectedOrigin } : {}),
        ...(telegramApi ? { FACTORY_TELEGRAM_API: telegramApi } : {}),
      },
    }
  );
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

// A stub `claude` CLI for the plugin-sync step: records every invocation,
// exits per a scenario table keyed on "<subcommand words>".
const stubClaude = (world, failing = []) => {
  const dir = path.join(world.root, "claude-bin");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "claude");
  fs.writeFileSync(p, `#!/bin/sh
echo "$@" >> "$CLAUDE_STUB_LOG"
case "$*" in
${failing.map((f) => `  "${f}"*) exit 1 ;;`).join("\n")}
  *) exit 0 ;;
esac
`);
  fs.chmodSync(p, 0o755);
  return dir;
};

const claudeCalls = (world) => {
  const p = path.join(world.root, "claude-calls.log");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim().split("\n") : [];
};

const runtimeHead = (world) => git(world.runtime, "rev-parse", "HEAD");

// A wrong or retired origin fetches fine and reports "up to date" forever —
// the frozen-fleet failure (migration runbook Phase 0). The check must fire
// BEFORE the up-to-date early exit, which is the path a frozen machine takes.
test("runtime pointed at a non-canonical origin refuses, never reports up to date", (t) => {
  const world = makeRuntimeWorld(t);
  const before = runtimeHead(world);

  const r = runDeploy(world, { expectedOrigin: path.join(world.root, "elsewhere", "claude-plugins.git") });

  assert.equal(r.code, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout + r.stderr, /origin/i);
  assert.match(r.stdout + r.stderr, /remote set-url/, "the fix must be spelled out");
  assert.doesNotMatch(r.stdout, /up to date/i);
  assert.equal(runtimeHead(world), before);
});

test("without an override the real canonical URL is enforced — a local-path origin refuses", (t) => {
  const world = makeRuntimeWorld(t);

  const r = runDeploy(world, { expectedOrigin: null });

  assert.equal(r.code, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout + r.stderr, /claude-plugins/, "the canonical repo must be named in the refusal");
});

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

// G3: skills reach sessions through the machine-installed code4food plugins,
// so a deploy must leave plugins synced with the runtime it just advanced —
// and a plain run on an already-current runtime must provision them too
// (bootstrap idempotence). Sync failures WARN loudly but never fail the
// deploy: the runtime has already advanced, and doctor flags version drift.
test("advance syncs plugins from the runtime marketplace via the claude CLI", (t) => {
  const world = makeRuntimeWorld(t, { withPlugins: true });
  const factory = makeFactory(t);
  const binDir = registerFactory(world, factory);
  const claudeBin = stubClaude(world);
  commitOnOrigin(world, (seed) => {
    fs.appendFileSync(path.join(seed, "factory", "driver", "factory.mjs"), "// deploy-test marker\n");
  });

  const r = runDeploy(world, { extraPath: `${claudeBin}:${binDir}` });

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const calls = claudeCalls(world);
  assert.ok(calls.some((c) => c.includes("plugin marketplace update code4food")),
    `marketplace not refreshed: ${calls.join(" | ")}`);
  assert.ok(calls.some((c) => c.includes("plugin update code4food-skillset@code4food")),
    `skillset plugin not updated: ${calls.join(" | ")}`);
  assert.ok(calls.some((c) => c.includes("plugin update code4food-factory@code4food")),
    `factory plugin not updated: ${calls.join(" | ")}`);
  assert.match(r.stdout, /plugins synced/i);
});

test("an up-to-date runtime still syncs plugins — deploy-runtime is the bootstrap verb", (t) => {
  const world = makeRuntimeWorld(t, { withPlugins: true });
  const claudeBin = stubClaude(world);

  const r = runDeploy(world, { extraPath: claudeBin });

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /up to date/i);
  assert.ok(claudeCalls(world).some((c) => c.includes("plugin update code4food-skillset@code4food")),
    `plugins not synced on the no-op path: ${claudeCalls(world).join(" | ")}`);
});

test("unknown marketplace / uninstalled plugins fall back to add + install", (t) => {
  const world = makeRuntimeWorld(t, { withPlugins: true });
  const claudeBin = stubClaude(world, [
    "plugin marketplace update code4food",
    "plugin update code4food-skillset@code4food",
    "plugin update code4food-factory@code4food",
  ]);

  const r = runDeploy(world, { extraPath: claudeBin });

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const calls = claudeCalls(world);
  assert.ok(calls.some((c) => c.includes("plugin marketplace add") && c.includes(world.runtime)),
    `marketplace add fallback missing: ${calls.join(" | ")}`);
  assert.ok(calls.some((c) => c.includes("plugin install code4food-skillset@code4food")),
    `plugin install fallback missing: ${calls.join(" | ")}`);
  assert.ok(calls.some((c) => c.includes("plugin install code4food-factory@code4food")),
    `plugin install fallback missing: ${calls.join(" | ")}`);
});

test("missing claude CLI warns loudly but the deploy still succeeds", (t) => {
  const world = makeRuntimeWorld(t, { withPlugins: true });

  // PATH without any real claude: system dirs only (git/sh live there;
  // node is invoked by absolute path).
  const r = runDeploy(world, { pathOverride: "/usr/bin:/bin" });

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /plugins NOT synced/i);
});

test("a failing plugin sync warns but never fails an already-advanced deploy", (t) => {
  const world = makeRuntimeWorld(t, { withPlugins: true });
  const factory = makeFactory(t);
  const binDir = registerFactory(world, factory);
  const claudeBin = stubClaude(world, [
    "plugin marketplace update code4food",
    "plugin marketplace add",
  ]);
  const target = commitOnOrigin(world, (seed) => {
    fs.appendFileSync(path.join(seed, "factory", "driver", "factory.mjs"), "// deploy-test marker\n");
  });

  const r = runDeploy(world, { extraPath: `${claudeBin}:${binDir}` });

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.equal(runtimeHead(world), target, "sync failure must not roll back or block the advance");
  assert.match(r.stdout, /plugins NOT synced/i);
});

// The deploy message must lead with the ANSWER — the sha the runtime is at
// NOW. The old "advanced <from> → <to>" shape was read backwards in practice
// (the owner took the FROM sha as the new one on 2026-07-19; technically
// accurate but misread is a real defect). The Telegram leg is asserted
// through the stub, not inferred from the log line.
test("deploy Telegram and log lead with the new sha, old sha in parentheses", (t) => {
  const world = makeRuntimeWorld(t);
  const factory = makeFactory(t);
  const binDir = registerFactory(world, factory);
  const tg = startTelegramStub(t);
  fs.writeFileSync(path.join(world.home, ".factory", "telegram.env"),
    "TELEGRAM_BOT_TOKEN=stub-token\nTELEGRAM_CHAT_ID=42\n");
  const before = runtimeHead(world);
  const target = commitOnOrigin(world, (seed) => {
    fs.appendFileSync(path.join(seed, "factory", "driver", "factory.mjs"), "// deploy-test marker\n");
  });

  const r = runDeploy(world, { extraPath: binDir, telegramApi: tg.url });

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const now = target.slice(0, 7), was = before.slice(0, 7);
  assert.match(r.stdout, new RegExp(`runtime now at ${now} \\(was ${was}`), "log line must answer first");
  const msgs = tg.messages();
  assert.equal(msgs.length, 1, `exactly one Telegram message for a clean advance\nstdout:\n${r.stdout}`);
  assert.equal(msgs[0].chat_id, "42");
  assert.match(msgs[0].text, new RegExp(`✓ runtime now at ${now} \\(was ${was}, 1 commit\\(s\\), 1 factory doctor\\(s\\) green\\)`),
    "Telegram must answer first: the sha the runtime is at NOW");
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

// Gate 0 — cached plugins only refresh on a version bump, so plugin-content
// changes without one would deploy green while sessions keep stale skills.
test("plugin content changed without a version bump is refused", (t) => {
  const world = makeRuntimeWorld(t, { withPlugins: true });
  const claudeBin = stubClaude(world);
  const before = runtimeHead(world);
  commitOnOrigin(world, (seed) => {
    fs.mkdirSync(path.join(seed, "skills", "tdd"), { recursive: true });
    fs.writeFileSync(path.join(seed, "skills", "tdd", "SKILL.md"), "# changed\n");
  });

  const r = runDeploy(world, { extraPath: claudeBin });

  assert.equal(r.code, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout + r.stderr, /without a version bump/i);
  assert.equal(runtimeHead(world), before);
});

test("plugin content change WITH a version bump deploys", (t) => {
  const world = makeRuntimeWorld(t, { withPlugins: true });
  const factory = makeFactory(t);
  const binDir = registerFactory(world, factory);
  const claudeBin = stubClaude(world);
  const target = commitOnOrigin(world, (seed) => {
    fs.mkdirSync(path.join(seed, "skills", "tdd"), { recursive: true });
    fs.writeFileSync(path.join(seed, "skills", "tdd", "SKILL.md"), "# changed\n");
    const mf = path.join(seed, ".claude-plugin", "plugin.json");
    const m = JSON.parse(fs.readFileSync(mf, "utf8"));
    m.version = "99.0.0";
    fs.writeFileSync(mf, JSON.stringify(m, null, 2) + "\n");
  });

  const r = runDeploy(world, { extraPath: `${claudeBin}:${binDir}` });

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.equal(runtimeHead(world), target);
});

test("factory-only bump (skill + factory manifest + marketplace entry) deploys without a skillset bump", (t) => {
  // A factory release must touch root marketplace.json (its version entry).
  // That file is marketplace metadata, not skillset content — gate 0 must
  // not demand a skillset bump for it (first hit: factory 1.1.5, 2026-07-18).
  const world = makeRuntimeWorld(t, { withPlugins: true });
  const factory = makeFactory(t);
  const binDir = registerFactory(world, factory);
  const claudeBin = stubClaude(world);
  const target = commitOnOrigin(world, (seed) => {
    fs.writeFileSync(path.join(seed, "factory", "skills", "backlog", "SKILL.md"), "# changed\n");
    const fmf = path.join(seed, "factory", ".claude-plugin", "plugin.json");
    const fm = JSON.parse(fs.readFileSync(fmf, "utf8"));
    fm.version = "99.0.0";
    fs.writeFileSync(fmf, JSON.stringify(fm, null, 2) + "\n");
    const mp = path.join(seed, ".claude-plugin", "marketplace.json");
    const m = JSON.parse(fs.readFileSync(mp, "utf8"));
    for (const p of m.plugins ?? []) if (p.name === "code4food-factory") p.version = "99.0.0";
    fs.writeFileSync(mp, JSON.stringify(m, null, 2) + "\n");
  });

  const r = runDeploy(world, { extraPath: `${claudeBin}:${binDir}` });

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.equal(runtimeHead(world), target);
});

test("driver-only changes need no version bump — gate 0 stays out of the way", (t) => {
  const world = makeRuntimeWorld(t, { withPlugins: true });
  const factory = makeFactory(t);
  const binDir = registerFactory(world, factory);
  const claudeBin = stubClaude(world);
  const target = commitOnOrigin(world, (seed) => {
    fs.appendFileSync(path.join(seed, "factory", "driver", "factory.mjs"), "// driver change\n");
  });

  const r = runDeploy(world, { extraPath: `${claudeBin}:${binDir}` });

  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.equal(runtimeHead(world), target);
});
