import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { makeFactory } from "./helpers.mjs";
import { stateDir } from "../paths.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const watchdogPath = path.join(here, "..", "watchdog.mjs");

// A fake sibling driver whose doctor mode just sleeps, then records its
// start/end timestamps in the target project so the test can prove overlap.
const FAKE_SIBLING_DRIVER = `
import * as fs from "node:fs";
import * as path from "node:path";
const start = Date.now();
await new Promise((r) => setTimeout(r, 700));
const project = process.argv[process.argv.indexOf("--project") + 1];
fs.writeFileSync(path.join(project, ".factory", "doctor-timing.json"), JSON.stringify({ start, end: Date.now() }));
process.exit(0);
`;

test("watchdog doctors registered factories concurrently through its sibling driver", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".factory"), { recursive: true });

  // The watchdog runs the driver that ships BESIDE it — copy it next to a
  // fake driver so the test controls what "doctor" does.
  const binDir = path.join(root, "runtime-driver");
  fs.mkdirSync(binDir);
  fs.copyFileSync(watchdogPath, path.join(binDir, "watchdog.mjs"));
  fs.copyFileSync(path.join(here, "..", "paths.mjs"), path.join(binDir, "paths.mjs"));
  fs.writeFileSync(path.join(binDir, "factory.mjs"), FAKE_SIBLING_DRIVER);

  const factories = {};
  for (let i = 1; i <= 4; i++) {
    const project = path.join(root, `proj${i}`);
    fs.mkdirSync(path.join(project, ".factory"), { recursive: true });
    factories[project] = { name: `proj${i}` };
  }
  fs.writeFileSync(
    path.join(home, ".factory", "registry.json"),
    JSON.stringify({ factories }, null, 2)
  );

  const r = spawnSync(process.execPath, [path.join(binDir, "watchdog.mjs")], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, HOME: home },
  });
  assert.equal(r.status, 0, `watchdog exited ${r.status}\n${r.stdout}\n${r.stderr}`);

  const timings = Object.keys(factories).map((p) => {
    const tp = path.join(p, ".factory", "doctor-timing.json");
    assert.ok(fs.existsSync(tp), `sibling doctor never ran for ${p}`);
    return JSON.parse(fs.readFileSync(tp, "utf8"));
  });
  for (const p of Object.keys(factories)) {
    const dj = JSON.parse(fs.readFileSync(path.join(stateDir(p, home), "log", "doctor.json"), "utf8"));
    assert.equal(dj.ok, true, `doctor.json not ok for ${p}`);
  }
  // Concurrency: with 4 doctors of ~700ms each, at least two must overlap —
  // some run must start before the earliest one finished.
  const earliestEnd = Math.min(...timings.map((x) => x.end));
  const overlapping = timings.filter((x) => x.start < earliestEnd).length;
  assert.ok(overlapping >= 2, `doctors ran sequentially (no overlap): ${JSON.stringify(timings)}`);
});

test("watchdog needs no per-project driver copy: real doctor runs, failures recorded", (t) => {
  const healthy = makeFactory(t);
  const broken = makeFactory(t);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".factory"), { recursive: true });
  // The healthy fixture's machine state, mirrored into the watchdog's HOME;
  // the broken one gets NO machine config there — the doctor-killing state.
  fs.cpSync(healthy.stateDir, stateDir(healthy.project, home), { recursive: true });
  // Both fixtures' workspace trust, merged into this HOME.
  const projects = {};
  for (const w of [healthy, broken]) {
    Object.assign(projects, JSON.parse(fs.readFileSync(path.join(w.home, ".claude.json"), "utf8")).projects);
  }
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ projects }, null, 2));
  fs.writeFileSync(path.join(home, ".factory", "registry.json"), JSON.stringify({
    factories: {
      [healthy.project]: { name: "healthy" },
      [broken.project]: { name: "broken" },
    },
  }, null, 2));

  const r = spawnSync(process.execPath, [watchdogPath], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, HOME: home, PATH: `${path.join(healthy.root, "bin")}:${process.env.PATH}` },
  });

  assert.equal(r.status, 1, `expected exit 1 (one factory failing)\n${r.stdout}\n${r.stderr}`);
  const healthyDj = JSON.parse(fs.readFileSync(path.join(stateDir(healthy.project, home), "log", "doctor.json"), "utf8"));
  assert.equal(healthyDj.ok, true, `healthy factory not ok: ${JSON.stringify(healthyDj)}\n${r.stdout}`);
  const brokenDj = JSON.parse(fs.readFileSync(path.join(stateDir(broken.project, home), "log", "doctor.json"), "utf8"));
  assert.equal(brokenDj.ok, false);
  assert.match(r.stdout, /broken: FAIL/);
});
