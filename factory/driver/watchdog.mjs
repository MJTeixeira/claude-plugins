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
import { stateDir, writeJsonAtomic } from "./paths.mjs";

const execFileP = promisify(execFile);
const DRIVER = fileURLToPath(new URL("factory.mjs", import.meta.url));

const regPath = path.join(os.homedir(), ".factory", "registry.json");
const logPath = path.join(os.homedir(), ".factory", "watchdog.log");
const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`;
  fs.appendFileSync(logPath, line + "\n");
  process.stdout.write(line + "\n");
};

const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
};

// KEY=VALUE lines, # comments — ~/.factory/telegram.env or a factory's
// machine-side .env.
const loadEnv = (p) => {
  const env = {};
  if (!fs.existsSync(p)) return env;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0) env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return env;
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
  // ~/.factory/telegram.env first (the machine-level creds the OnFailure
  // unit uses — same order as deploy-runtime), then any factory's .env.
  const credFiles = [
    path.join(os.homedir(), ".factory", "telegram.env"),
    ...entries.map(([project]) => path.join(stateDir(project), ".env")),
  ];
  for (const p of credFiles) {
    if (telegram) break;
    const env = loadEnv(p);
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      telegram = { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID };
    }
  }
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
  try {
    // FACTORY_TELEGRAM_API: test double (helpers.mjs startTelegramStub).
    const res = await fetch(`${process.env.FACTORY_TELEGRAM_API ?? "https://api.telegram.org"}/bot${telegram.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: telegram.chatId, text: `[fleet] ${text}`, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) log(`telegram HTTP ${res.status}`);
  } catch (e) {
    log(`telegram failed: ${String(e.message ?? e).split("\n")[0]}`);
  }
} else if (failures.length) {
  log("failures found but no Telegram creds in any factory's .env — log only");
}

process.exit(failures.length ? 1 : 0);
