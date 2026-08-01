#!/usr/bin/env node
// Fleet watchdog (NOTES item 26) — repo-side tool, one per machine.
//
//   node watchdog.mjs                # doctor every factory in the registry
//
// A dead factory must be noticed by machinery, not by the owner wondering
// why there were no PRs (blacklist, 2026-07-07: config lost + scheduler
// never installed = silently dead). Runs the driver that ships BESIDE this
// file (the machine runtime — O6, NOTES item 46) in doctor mode against
// each registered factory, writes doctor.json into each factory's machine
// state dir (the dashboard tile reads it), and Telegrams one summary when
// anything fails. Read-only apart from those doctor.json files and its
// own log.
//
// Schedule via factory-watchdog.timer (see factory/schedulers/).

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { stateDir, writeJsonAtomic, readJson } from "./paths.mjs";
import { telegramCreds, sendTelegram } from "./notify.mjs";

const execFileP = promisify(execFile);
const DRIVER = fileURLToPath(new URL("factory.mjs", import.meta.url));

const regPath = path.join(os.homedir(), ".factory", "registry.json");
const logPath = path.join(os.homedir(), ".factory", "watchdog.log");
const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`;
  fs.appendFileSync(logPath, line + "\n");
  process.stdout.write(line + "\n");
};

const reg = readJson(regPath);
if (!reg?.factories || !Object.keys(reg.factories).length) {
  log("no factories in ~/.factory/registry.json — nothing to check");
  process.exit(0);
}

const failures = [];
let telegram = null;

const doctorOne = async ([project, meta]) => {
  const name = meta?.name ?? path.basename(project);
  const sd = stateDir(project);

  let ok = false;
  let fails = [];
  if (!fs.existsSync(path.join(project, ".factory"))) {
    fails = ["no .factory/ — factory work data missing or moved"];
  } else {
    try {
      await execFileP(process.execPath, [DRIVER, "doctor", "--project", project], {
        timeout: 180_000, encoding: "utf8",
      });
      ok = true;
    } catch (e) {
      // doctor exits 1 on problems and prints " ✗ name — detail" lines
      const out = `${e.stdout ?? ""}`;
      fails = out.split("\n").filter((l) => l.trim().startsWith("✗")).map((l) => l.trim().slice(1).trim());
      if (!fails.length) fails = [`doctor did not run: ${String(e.message ?? e).split("\n")[0].slice(0, 160)}`];
    }
  }

  try {
    writeJsonAtomic(path.join(sd, "log", "doctor.json"), {
      ts: new Date().toISOString(), ok, source: "watchdog", fails,
    });
  } catch { /* unwritable state dir is itself a failure state, already reported */ }

  // A disabled factory doctors green by design — tag it in the daily log so
  // the pause stays visible without telegram noise (NOTES item 47).
  let disabled = false;
  try { disabled = JSON.parse(fs.readFileSync(path.join(sd, "config.json"), "utf8")).enabled === false; } catch { /* missing config already fails doctor */ }
  log(`${name}: ${ok ? "ok" : `FAIL (${fails.length}) — ${fails.join("; ").slice(0, 300)}`}${disabled ? " (disabled)" : ""}`);
  if (!ok) failures.push({ name, fails });
};

// Doctors are read-only per project and independent — run them through a
// small pool (7 sequential doctors made the fleet check take 7× one doctor).
{
  const entries = Object.entries(reg.factories);
  telegram = telegramCreds(reg.factories);
  const POOL = 4;
  const queue = [...entries];
  await Promise.all(
    Array.from({ length: Math.min(POOL, queue.length) }, async () => {
      while (queue.length) await doctorOne(queue.shift());
    })
  );
}

if (failures.length && telegram) {
  const text =
    `🩺 watchdog: ${failures.length}/${Object.keys(reg.factories).length} factory(ies) failing doctor\n` +
    failures.map((f) => `• ${f.name}: ${f.fails.slice(0, 3).join("; ").slice(0, 250)}`).join("\n");
  await sendTelegram(telegram, `[fleet] ${text}`, { log });
} else if (failures.length) {
  log("failures found but no Telegram creds in any factory's .env — log only");
}

process.exit(failures.length ? 1 : 0);
