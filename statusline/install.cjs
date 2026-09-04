#!/usr/bin/env node
// code4food statusline — one-command installer.
//
// Fetches statusline.cjs, writes it to ~/.claude/statusline.cjs, and merges
// the statusLine key into ~/.claude/settings.json — creating the file if it
// doesn't exist, preserving every other key if it does, and refusing to
// clobber a statusLine you've already configured differently.
//
// Self-contained: no npm dependencies, works identically on macOS, Linux
// and Windows. Safe to run more than once (re-fetches, re-merges).
//
//   curl -fsSL <raw-url>/install.cjs -o /tmp/cf-statusline-install.cjs && node /tmp/cf-statusline-install.cjs
//   iwr <raw-url>/install.cjs -OutFile "$env:TEMP\cf-statusline-install.cjs"; node "$env:TEMP\cf-statusline-install.cjs"

"use strict";

const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const SCRIPT_URL = "https://raw.githubusercontent.com/MJTeixeira/claude-plugins/main/statusline/statusline.cjs";
const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const SCRIPT_DEST = path.join(CLAUDE_DIR, "statusline.cjs");
const SETTINGS_PATH = path.join(CLAUDE_DIR, "settings.json");

function fetch(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(fetch(res.headers.location));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`GET ${url} → ${res.statusCode}`));
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve(body));
      })
      .on("error", reject);
  });
}

const WANT = { type: "command", command: "node ~/.claude/statusline.cjs" };
const sameStatusLine = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  console.log(`code4food statusline installer\n  fetching ${SCRIPT_URL}`);
  const script = await fetch(SCRIPT_URL);
  if (!script.startsWith("#!/usr/bin/env node")) {
    throw new Error("fetched content doesn't look like the statusline script — aborting, nothing written");
  }

  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.writeFileSync(SCRIPT_DEST, script, { mode: 0o755 });
  console.log(`  wrote ${SCRIPT_DEST}`);

  let settings = {};
  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
    } catch (e) {
      throw new Error(
        `${SETTINGS_PATH} exists but isn't valid JSON (${e.message}) — fix or remove it, then re-run this installer`
      );
    }
  }

  if (settings.statusLine && !sameStatusLine(settings.statusLine, WANT)) {
    console.log(
      `\n  ${SETTINGS_PATH} already has a different "statusLine" configured — leaving it alone.\n` +
        `  Script is installed at ${SCRIPT_DEST} if you want to point at it yourself:\n` +
        `  ${JSON.stringify({ statusLine: WANT }, null, 2).split("\n").join("\n  ")}`
    );
    return;
  }

  settings.statusLine = WANT;
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
  console.log(`  merged "statusLine" into ${SETTINGS_PATH} (everything else in that file is untouched)`);
  console.log("\nDone. Start a new Claude Code session (or restart this one) to see it.");
}

main().catch((e) => {
  console.error(`\ncode4food statusline installer FAILED: ${e.message}`);
  process.exit(1);
});
