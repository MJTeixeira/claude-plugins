// Dashboard v2 (spec factory/specs/dashboard-v2.md): config file, mutation
// controls (stop/resume/enable/disable), version + scaffold currency. The
// dashboard has no other tests — this spawns the real server against a fake
// HOME + temp factory (helpers.mjs world) on an ephemeral port and drives it
// over HTTP. GIT_ALLOW_PROTOCOL=none keeps the background version fetch off
// the network (and off the real repo), so version currency lands in {error}.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeFactory } from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboardPath = path.join(here, "..", "dashboard.mjs");
const templatesDir = path.join(here, "..", "..", "templates");

// Register `world.project` in the fake HOME's registry so the dashboard finds
// it. init.mjs writes exactly this shape.
const register = (world) => {
  const dir = path.join(world.home, ".factory");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "registry.json"),
    JSON.stringify({ factories: { [world.project]: { name: "dash-test", registeredAt: "2026-01-01T00:00:00Z" } } }, null, 2) + "\n"
  );
};

// Give the fixture a spec-template.md matching the running checkout so the
// scaffold-currency baseline is "current" (makeFactory ships guard.mjs but not
// the template).
const seedTemplate = (world) => {
  fs.copyFileSync(path.join(templatesDir, "spec-template.md"), path.join(world.factoryDir, "spec-template.md"));
};

// Spawn the real dashboard; resolve once `waitFor` matches stdout+stderr.
// `out()` returns everything seen so far. By default an ephemeral port is
// forced with `--port 0`; pass `bare: true` to source the port from the config
// file or defaults instead (so precedence-by-source can be asserted).
const startDashboard = (t, world, { token, args = [], waitFor, bare = false, env = {} } = {}) => {
  const pattern = waitFor ?? /http:\/\/127\.0\.0\.1:(\d+)/;
  const proc = spawn(
    process.execPath,
    [dashboardPath, ...(bare ? [] : ["--port", "0"]), ...(token ? ["--token", token] : []), ...args],
    {
      env: {
        ...process.env,
        HOME: world.home,
        PATH: `${path.join(world.root, "bin")}:${process.env.PATH}`,
        GIT_ALLOW_PROTOCOL: "none",
        GIT_TERMINAL_PROMPT: "0",
        ...env,
      },
    }
  );
  t.after(() => { try { proc.kill("SIGKILL"); } catch { /* already gone */ } });

  let out = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dashboard did not start in time:\n${out}`)), 10_000);
    const onData = (d) => {
      out += d;
      const m = out.match(pattern);
      if (m) { clearTimeout(timer); resolve({ proc, match: m, port: m[1] ? Number(m[1]) : null, base: m[1] ? `http://127.0.0.1:${m[1]}` : null, out: () => out }); }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("exit", () => { const m = out.match(pattern); if (m) { clearTimeout(timer); resolve({ proc, match: m, port: null, base: null, out: () => out }); } });
  });
};

const req = (base, method, urlPath) => fetch(base + urlPath, { method });
const getState = async (base, qs = "") => (await fetch(base + "/api/state" + qs)).json();

// ---------- config file + precedence ----------

test("config: defaults when neither file nor flags set them", async (t) => {
  const world = makeFactory(t);
  register(world);
  // No file, no flags → defaults. Bind may fail if 7788 is taken, but the
  // config line prints before listen, so wait for it and kill regardless.
  const { out } = await startDashboard(t, world, { bare: true, waitFor: /config: port=(\d+) \((default|file|flag)\)/ });
  const line = out();
  assert.match(line, /port=7788 \(default\)/);
  assert.match(line, /listen=127\.0\.0\.1 \(default\)/);
  assert.match(line, /token=absent/);
});

test("config: dashboard.json supplies values (source=file)", async (t) => {
  const world = makeFactory(t);
  register(world);
  fs.writeFileSync(path.join(world.home, ".factory", "dashboard.json"), JSON.stringify({ port: 0, token: "filetok" }));
  const { base, out } = await startDashboard(t, world, { bare: true }); // port 0 comes from the file
  assert.match(out(), /port=0 \(file\)/);
  assert.match(out(), /token=file/);
  // token from the file actually gates: the dashboard has a token, so a
  // request that omits it → 401.
  assert.equal((await req(base, "POST", "/api/stop?factory=" + encodeURIComponent(world.project))).status, 401);
});

test("config: CLI flags override the file (source=flag)", async (t) => {
  const world = makeFactory(t);
  register(world);
  fs.writeFileSync(path.join(world.home, ".factory", "dashboard.json"), JSON.stringify({ port: 6000 }));
  const { out } = await startDashboard(t, world, {}); // --port 0 passed by helper
  assert.match(out(), /port=0 \(flag\)/);
});

// ---------- token gating ----------

test("token gating: mutations 403 when dashboard has no token", async (t) => {
  const world = makeFactory(t);
  register(world);
  const { base } = await startDashboard(t, world, {}); // no token
  const f = encodeURIComponent(world.project);
  for (const p of [`/api/stop?factory=${f}`, `/api/resume?factory=${f}`, `/api/enabled?factory=${f}&value=false`, `/api/run?factory=${f}`]) {
    assert.equal((await req(base, "POST", p)).status, 403, `${p} should be 403 without a token`);
  }
});

test("token gating: wrong token is 401 everywhere; correct token passes", async (t) => {
  const world = makeFactory(t);
  register(world);
  const { base } = await startDashboard(t, world, { token: "sekret" });
  const f = encodeURIComponent(world.project);
  // wrong token → 401 on reads and mutations
  assert.equal((await fetch(base + "/api/state?token=nope")).status, 401);
  assert.equal((await req(base, "POST", `/api/stop?factory=${f}&token=nope`)).status, 401);
  // correct token → mutation succeeds
  assert.equal((await req(base, "POST", `/api/stop?factory=${f}&token=sekret`)).status, 200);
});

// ---------- stop / resume ----------

test("stop writes STOP with content, blocks runs, and double-stop is 409", async (t) => {
  const world = makeFactory(t);
  register(world);
  const { base } = await startDashboard(t, world, { token: "t" });
  const f = encodeURIComponent(world.project);
  const stopPath = path.join(world.stateDir, "STOP");

  const r1 = await req(base, "POST", `/api/stop?factory=${f}&token=t`);
  assert.equal(r1.status, 200);
  assert.ok(fs.existsSync(stopPath), "STOP file should exist");
  assert.match(fs.readFileSync(stopPath, "utf8"), /stopped from dashboard at \d{4}-\d\d-\d\dT/);

  // /api/run now refuses because STOP is present
  assert.equal((await req(base, "POST", `/api/run?factory=${f}&token=t`)).status, 409);

  // double stop → 409
  assert.equal((await req(base, "POST", `/api/stop?factory=${f}&token=t`)).status, 409);
});

test("resume removes STOP; resume without STOP is 409", async (t) => {
  const world = makeFactory(t);
  register(world);
  const { base } = await startDashboard(t, world, { token: "t" });
  const f = encodeURIComponent(world.project);
  const stopPath = path.join(world.stateDir, "STOP");

  // resume with no STOP present → 409
  assert.equal((await req(base, "POST", `/api/resume?factory=${f}&token=t`)).status, 409);

  await req(base, "POST", `/api/stop?factory=${f}&token=t`);
  const r = await req(base, "POST", `/api/resume?factory=${f}&token=t`);
  assert.equal(r.status, 200);
  assert.ok(!fs.existsSync(stopPath), "STOP file should be gone after resume");
});

test("GET on a mutation route has no side effect", async (t) => {
  const world = makeFactory(t);
  register(world);
  const { base } = await startDashboard(t, world, { token: "t" });
  const f = encodeURIComponent(world.project);
  await req(base, "GET", `/api/stop?factory=${f}&token=t`);
  assert.ok(!fs.existsSync(path.join(world.stateDir, "STOP")), "GET must not create STOP");
});

// ---------- enable / disable ----------

test("enabled flip toggles the value, preserves siblings and formatting", async (t) => {
  const world = makeFactory(t, { config: { enabled: true, autonomy: "pr-only", windowHours: 3 } });
  register(world);
  const { base } = await startDashboard(t, world, { token: "t" });
  const f = encodeURIComponent(world.project);
  const cfgPath = path.join(world.stateDir, "config.json");

  const r = await req(base, "POST", `/api/enabled?factory=${f}&value=false&token=t`);
  assert.equal(r.status, 200);
  const raw = fs.readFileSync(cfgPath, "utf8");
  const cfg = JSON.parse(raw);
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.autonomy, "pr-only", "sibling keys survive");
  assert.equal(cfg.windowHours, 3, "sibling keys survive");
  assert.ok(raw.endsWith("\n"), "trailing newline preserved");
  assert.match(raw, /\n  "enabled"/, "2-space indent preserved");

  // flip back on
  assert.equal((await req(base, "POST", `/api/enabled?factory=${f}&value=true&token=t`)).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(cfgPath, "utf8")).enabled, true);
});

test("enabled on a missing/corrupt config.json is 409 and creates no file", async (t) => {
  const world = makeFactory(t);
  register(world);
  const cfgPath = path.join(world.stateDir, "config.json");
  fs.writeFileSync(cfgPath, "{ not json");
  const { base } = await startDashboard(t, world, { token: "t" });
  const f = encodeURIComponent(world.project);

  const r = await req(base, "POST", `/api/enabled?factory=${f}&value=false&token=t`);
  assert.equal(r.status, 409);
  assert.equal(fs.readFileSync(cfgPath, "utf8"), "{ not json", "corrupt config left untouched");
  assert.ok(!fs.existsSync(cfgPath + ".tmp"), "no tmp file left behind");
});

// ---------- unknown factory ----------

test("unknown factory is 404 on every route that takes one", async (t) => {
  const world = makeFactory(t);
  register(world);
  const { base } = await startDashboard(t, world, { token: "t" });
  const bogus = encodeURIComponent("/no/such/factory");
  for (const p of [
    `/api/stop?factory=${bogus}&token=t`,
    `/api/resume?factory=${bogus}&token=t`,
    `/api/enabled?factory=${bogus}&value=false&token=t`,
    `/api/run?factory=${bogus}&token=t`,
  ]) {
    assert.equal((await req(base, "POST", p)).status, 404, `${p} should be 404`);
  }
});

// ---------- /docs static pages ----------

test("/docs serves the shipped product docs; unknown names 404; token gates", async (t) => {
  const world = makeFactory(t);
  register(world);
  const { base } = await startDashboard(t, world, { token: "sekret" });
  // known pages come from factory/docs/ beside the driver
  for (const [p, marker] of [["/docs", "guide"], ["/docs/qa", "qa"]]) {
    const r = await fetch(base + p + "?token=sekret");
    assert.equal(r.status, 200, `${p} should be 200`);
    assert.match(r.headers.get("content-type"), /text\/html/);
    assert.ok((await r.text()).length > 0, `${p} (${marker}) should have content`);
  }
  // fixed name map — only mapped names resolve; the pathname is never used
  // as a filename, so there is no traversal surface to probe.
  assert.equal((await fetch(base + "/docs/nope?token=sekret")).status, 404);
  // reads are token-gated like everything else
  assert.equal((await fetch(base + "/docs")).status, 401);
});

// ---------- /api/state new fields ----------

test("/api/state carries declared state, scaffold currency, and a version cache", async (t) => {
  const world = makeFactory(t, { config: { enabled: false, schedule: "manual" } });
  register(world);
  seedTemplate(world);
  const { base } = await startDashboard(t, world, {});

  // version cache populates in the background; poll briefly for shape.
  let s;
  for (let i = 0; i < 30; i++) {
    s = await getState(base);
    if (s.version) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok("version" in s, "state carries a version field");
  assert.ok(s.version && typeof s.version === "object", "version is an object");
  assert.ok("sha" in s.version || "error" in s.version, "version has sha or error shape");
  // The chip shows a human semver, not the git sha — the plugin manifest's
  // version rides in the cache whenever the checkout resolved a HEAD.
  if ("sha" in s.version) assert.match(s.version.version, /^\d+\.\d+\.\d+$/, "plugin semver surfaced for the chip");

  const fac = s.factories.find((x) => x.path === world.project);
  assert.ok(fac, "factory present in state");
  assert.equal(fac.enabled, false, "declared enabled surfaced");
  assert.equal(fac.schedule, "manual", "declared schedule surfaced");
  assert.ok(fac.scaffold && typeof fac.scaffold === "object", "scaffold currency present");
  assert.equal(fac.scaffold.stale, false, "matching scaffold is current");
});

test("/api/state surfaces the schedule KIND from a block-form declaration (P3)", async (t) => {
  const world = makeFactory(t, {
    config: { schedule: { kind: "launchd", modes: { dev: { time: "09:00", days: "Mon-Fri" } } } },
  });
  register(world);
  seedTemplate(world);
  const { base } = await startDashboard(t, world, {});

  const s = await getState(base);

  const fac = s.factories.find((x) => x.path === world.project);
  assert.equal(fac.schedule, "launchd", "chip gets the kind, not [object Object]");
});

test("/api/state marks scaffold stale when a transition-era scaffold copy differs", async (t) => {
  const world = makeFactory(t);
  register(world);
  seedTemplate(world);
  // A project still carrying a pre-migrate guard copy that drifted from the
  // runtime stays flagged until migrate removes it. Projects with NO copies
  // are the post-P2 shape — current by definition (previous test's fixture).
  fs.mkdirSync(path.join(world.factoryDir, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(world.factoryDir, "hooks", "guard.mjs"), "// stale legacy copy\n");
  const { base } = await startDashboard(t, world, {});
  const s = await getState(base);
  const fac = s.factories.find((x) => x.path === world.project);
  assert.equal(fac.scaffold.stale, true, "byte drift makes scaffold stale");
  assert.ok(fac.scaffold.files.includes("guard.mjs"), "stale file named");
});

// ---------- PR-E: derived status, next window, question links ----------

test("/api/state derives waiting-on-owner and surfaces per-task question links", async (t) => {
  const world = makeFactory(t, {
    tasks: `# Epic 1

## T-001: pick the art style

- Status: needs-human
- Question: https://github.com/o/r/issues/7
- Acceptance: owner approves

## T-002: blocked on T-001

- Status: blocked

## T-003: hostile question link

- Status: needs-human
- Question: javascript:alert(1)
`,
  });
  register(world);
  seedTemplate(world);
  const { base } = await startDashboard(t, world, {});
  const s = await getState(base);
  const fac = s.factories.find((x) => x.path === world.project);
  assert.equal(fac.derived.status, "waiting-on-owner");
  assert.match(fac.derived.detail, /T-001/);
  const t1 = fac.tasks.find((x) => x.id === "T-001");
  assert.equal(t1.question, "https://github.com/o/r/issues/7", "question issue link surfaced on the task");
  assert.equal(fac.tasks.find((x) => x.id === "T-002").question, null);
  // The value lands in an href and backlog files are session-written: only
  // http(s) may surface.
  assert.equal(fac.tasks.find((x) => x.id === "T-003").question, null, "non-http question schemes never surface");
});

test("/api/state derives deadlocked when only dependency-blocked work remains", async (t) => {
  const world = makeFactory(t, {
    tasks: "# Epic 1\n\n## T-001: stuck\n\n- Status: blocked\n",
  });
  register(world);
  seedTemplate(world);
  const { base } = await startDashboard(t, world, {});
  const s = await getState(base);
  const fac = s.factories.find((x) => x.path === world.project);
  assert.equal(fac.derived.status, "deadlocked");
});

test("/api/state computes nextWindow from a block declaration; manual has none", async (t) => {
  const world = makeFactory(t, {
    config: { schedule: { kind: "launchd", modes: { dev: { time: "09:00", days: "Mon-Sun" } } } },
  });
  register(world);
  seedTemplate(world);
  const { base } = await startDashboard(t, world, {});
  const s = await getState(base);
  const fac = s.factories.find((x) => x.path === world.project);
  assert.equal(fac.nextWindow.mode, "dev");
  assert.match(fac.nextWindow.at, /^\d{4}-\d\d-\d\dT/, "absolute fire instant");
  assert.ok(fac.nextWindow.inMinutes >= 0 && fac.nextWindow.inMinutes <= 7 * 1440);

  const manual = makeFactory(t, { config: { schedule: "manual" } });
  register(manual);
  seedTemplate(manual);
  const d2 = await startDashboard(t, manual, {});
  const s2 = await getState(d2.base);
  assert.equal(s2.factories.find((x) => x.path === manual.project).nextWindow, null);
});

test("/api/state exposes nextDev + windowHours so cards can show the dev fire and duration", async (t) => {
  // Triage earlier than dev: nextWindow is triage (nearest), nextDev is the
  // dev mode specifically — the phone card renders "next triage 01:30 ·
  // dev 02:00 · 4h".
  const world = makeFactory(t, {
    config: {
      windowHours: 4,
      schedule: { kind: "systemd", modes: { triage: { time: "01:30", days: "Mon-Sun" }, dev: { time: "02:00", days: "Mon-Sun" } } },
    },
  });
  register(world);
  seedTemplate(world);
  const { base } = await startDashboard(t, world, {});
  const s = await getState(base);
  const fac = s.factories.find((x) => x.path === world.project);
  assert.equal(fac.nextDev.mode, "dev");
  assert.equal(fac.nextDev.time, "02:00");
  assert.ok(fac.nextDev.inMinutes >= 0 && fac.nextDev.inMinutes <= 7 * 1440);
  assert.equal(fac.windowHours, 4);

  // Manual: no fires to compute, but the declared duration still surfaces.
  const manual = makeFactory(t, { config: { schedule: "manual", windowHours: 3 } });
  register(manual);
  seedTemplate(manual);
  const d2 = await startDashboard(t, manual, {});
  const s2 = await getState(d2.base);
  const mfac = s2.factories.find((x) => x.path === manual.project);
  assert.equal(mfac.nextDev, null);
  assert.equal(mfac.windowHours, 3);
});

// ---------- PR-E: stale-clone guard ----------

// A gh stub the dashboard's background refresh hits via STUB_GH_DIR: PR and
// issue lists are empty, and the branch-head probe answers a fixed sha.
const ghCloneStub = (world, remoteSha) => {
  const dir = path.join(world.root, "ghstub");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "gh"), `#!/bin/sh
case "$1" in
  api) echo '{"commit":{"sha":"${remoteSha}"}}';;
  *) echo "[]";;
esac
exit 0
`);
  fs.chmodSync(path.join(dir, "gh"), 0o755);
  return dir;
};

// Poll /api/state until the background gh refresh lands a clone verdict.
// Generous ceiling: under full-suite load the refresh's gh+git spawns can
// take many seconds; the happy path resolves in well under one.
const waitForClone = async (base, project, qs = "") => {
  for (let i = 0; i < 100; i++) {
    const s = await getState(base, qs);
    const fac = s.factories.find((x) => x.path === project);
    if (fac?.gh?.clone) return fac;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("clone verdict never appeared in /api/state");
};

test("clone behind origin: badge data present and every mutation refuses", async (t) => {
  const world = makeFactory(t);
  register(world);
  seedTemplate(world);
  const ghDir = ghCloneStub(world, "1234567890abcdef1234567890abcdef12345678");
  const { base } = await startDashboard(t, world, { token: "t", env: { STUB_GH_DIR: ghDir } });
  const fac = await waitForClone(base, world.project, "?token=t");
  assert.equal(fac.gh.clone.behind, true, "unknown remote head means the local picture is stale");

  const f = encodeURIComponent(world.project);
  for (const p of [`/api/run?factory=${f}&token=t`, `/api/stop?factory=${f}&token=t`, `/api/enabled?factory=${f}&value=false&token=t`]) {
    const r = await req(base, "POST", p);
    assert.equal(r.status, 409, `${p} must refuse on a stale clone`);
    assert.match(await r.text(), /behind origin/);
  }
  assert.ok(!fs.existsSync(path.join(world.stateDir, "STOP")), "no STOP written through the guard");
});

test("clone current with origin: mutations stay available", async (t) => {
  const world = makeFactory(t);
  register(world);
  seedTemplate(world);
  const { execFileSync } = await import("node:child_process");
  const localSha = execFileSync("git", ["rev-parse", "main"], { cwd: world.project, encoding: "utf8" }).trim();
  const ghDir = ghCloneStub(world, localSha);
  const { base } = await startDashboard(t, world, { token: "t", env: { STUB_GH_DIR: ghDir } });
  const fac = await waitForClone(base, world.project, "?token=t");
  assert.equal(fac.gh.clone.behind, false);
  const f = encodeURIComponent(world.project);
  assert.equal((await req(base, "POST", `/api/stop?factory=${f}&token=t`)).status, 200);
});

// ---------- jira tracker routing ----------

test("tracker jira: needs-human pill and daily log come from Jira while PRs stay on the forge", async (t) => {
  const world = makeFactory(t, { config: { tracker: "jira", jiraProject: "FACT" } });
  register(world);
  seedTemplate(world);
  fs.appendFileSync(path.join(world.stateDir, ".env"),
    "JIRA_BASE_URL=https://acme.atlassian.net\nJIRA_EMAIL=m@example.com\nJIRA_API_TOKEN=tok\n");
  // Forge (gh) answers PRs; issues must NOT come from here — its issue list
  // is empty on purpose.
  const ghDir = path.join(world.root, "ghstub-jira");
  fs.mkdirSync(ghDir, { recursive: true });
  fs.writeFileSync(path.join(ghDir, "gh"), `#!/bin/sh
case "$1" in
  pr) echo '[{"number": 5, "title": "[factory] T-001: t", "url": "u", "isDraft": false, "headRefName": "b", "statusCheckRollup": []}]';;
  *) echo "[]";;
esac
exit 0
`);
  fs.chmodSync(path.join(ghDir, "gh"), 0o755);
  // Jira (curl) answers the open-issue search.
  fs.writeFileSync(path.join(world.root, "bin", "curl"), `#!/bin/sh
cat > /dev/null
echo '{"issues": [
  {"key": "FACT-3", "fields": {"summary": "[factory] question: pick a color"}},
  {"key": "FACT-1", "fields": {"summary": "[factory] daily log"}}
]}'
exit 0
`);
  fs.chmodSync(path.join(world.root, "bin", "curl"), 0o755);

  const { base } = await startDashboard(t, world, { token: "t", env: { STUB_GH_DIR: ghDir } });
  let fac = null;
  for (let i = 0; i < 100 && !(fac?.gh?.needsHuman?.length); i++) {
    const s = await getState(base, "?token=t");
    fac = s.factories.find((x) => x.path === world.project);
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.deepEqual(fac.gh.needsHuman, [{ number: "FACT-3", title: "[factory] question: pick a color", url: "https://acme.atlassian.net/browse/FACT-3" }]);
  assert.equal(fac.gh.dailyLogUrl, "https://acme.atlassian.net/browse/FACT-1");
  assert.equal(fac.gh.prs[0].number, 5, "PR list must still come from the forge");
});
