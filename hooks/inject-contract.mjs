#!/usr/bin/env node
// SessionStart hook: inject the workflow contract into sessions whose
// project has opted in — the opt-in signal is a `.docs/index.md` at the
// project root (created by /setup). Delivery is global (the contract ships
// with the plugin and versions with it); activation is per-project, so the
// contract never reaches unrelated repos, other people's projects, or
// non-dev sessions.
//
// Fail-quiet by design: any error or ambiguity means NO injection. A
// missing contract degrades politely (the session just lacks the workflow);
// a wrongly injected one pollutes a foreign session.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { optedInRoot } from "./lib/project-root.mjs";

let cwd = null;
try {
  const stdin = fs.readFileSync(0, "utf8");
  if (stdin.trim()) {
    const parsed = JSON.parse(stdin);
    if (typeof parsed.cwd === "string" && parsed.cwd) cwd = parsed.cwd;
  }
  // Fallback inside the try: process.cwd() throws when the inherited
  // working directory was deleted (a removed worktree), and fail-quiet
  // must survive that too.
  if (!cwd) cwd = process.cwd();
} catch {
  process.exit(0);
}

let root = null;
try {
  root = optedInRoot(cwd);
} catch {
  process.exit(0);
}
if (!root) process.exit(0);

let contract = null;
try {
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "claude-md-block.md");
  contract = fs.readFileSync(src, "utf8")
    .split("\n")
    .filter((line) => !line.includes("LEAN-WORKFLOW MANAGED BLOCK"))
    .join("\n")
    .trim();
} catch {
  process.exit(0);
}
if (!contract) process.exit(0);

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: contract },
}));
