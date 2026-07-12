#!/usr/bin/env node
// Stub `claude` CLI for driver tests. The driver spawns this instead of the
// real CLI. Scenarios live in $STUB_DIR as session-<n>.json, consumed in
// invocation order (counter file in the same dir):
//
//   { "stdout": <string | object>,   // written to stdout (objects JSON.stringify'd)
//     "exit": <number>,              // exit code (default 0)
//     "script": <string>,            // optional: bash run in cwd before exiting
//     "sleepMs": <number> }          // optional: delay before exiting
//
// Reads stdin fully first (the driver pipes the prompt and waits on 'exit').
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// The driver feature-probes `claude --help` for flags — answer like a
// current CLI, without consuming a scenario or the invocation counter.
if (process.argv.includes("--help")) {
  process.stdout.write("stub claude: --effort --mcp-config supported\n");
  process.exit(0);
}

const dir = process.env.STUB_DIR;
if (!dir) { process.stderr.write("stub-claude: STUB_DIR not set\n"); process.exit(1); }

let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;

const counterPath = path.join(dir, "counter");
const n = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, "utf8")) + 1 : 1;
fs.writeFileSync(counterPath, String(n));
fs.writeFileSync(path.join(dir, `invocation-${n}.json`), JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  prompt: stdin,
  factoryMode: process.env.FACTORY_MODE ?? null,
  factoryBaseBranch: process.env.FACTORY_BASE_BRANCH ?? null,
  factoryMcpEvents: process.env.FACTORY_MCP_EVENTS ?? null,
}, null, 2));

const scenarioPath = path.join(dir, `session-${n}.json`);
if (!fs.existsSync(scenarioPath)) {
  process.stderr.write(`stub-claude: no scenario ${scenarioPath}\n`);
  process.exit(1);
}
const s = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));

if (s.script) execSync(s.script, { cwd: process.cwd(), stdio: ["ignore", "inherit", "inherit"] });
if (s.stdout != null) process.stdout.write(typeof s.stdout === "string" ? s.stdout : JSON.stringify(s.stdout));
if (s.sleepMs) await new Promise((r) => setTimeout(r, s.sleepMs)); // hang AFTER emitting, so kill tests see partial output
process.exit(s.exit ?? 0);
