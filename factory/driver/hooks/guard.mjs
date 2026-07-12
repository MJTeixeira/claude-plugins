#!/usr/bin/env node
// Factory PreToolUse guard (factory-v2-architecture.md O3, NOTES items 24/28/37).
//
// Converts the rules that used to be prompt discipline into mechanical
// denials at the tool layer. Wired into .claude/settings.json by init.mjs;
// claude runs it before Edit/Write/NotebookEdit/Bash calls with the event
// JSON on stdin. Empty stdout = allow; a permissionDecision JSON = deny.
//
// The guard is a NO-OP unless FACTORY_MODE is set — the driver sets it
// (dev|triage|report) when spawning sessions, so the owner's interactive
// sessions in the same checkout are never restricted.
import { execFileSync } from "node:child_process";
import * as path from "node:path";

const mode = process.env.FACTORY_MODE;
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
if (!mode) process.exit(0);

let event;
try { event = JSON.parse(raw); } catch { process.exit(0); } // unreadable event — stay out of the way

const deny = (reason) => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `factory guard: ${reason}`,
    },
  }));
  process.exit(0);
};

const cwd = event.cwd || process.cwd();
const tool = event.tool_name ?? "";
const input = event.tool_input ?? {};

// Tooling is deployed from the dev-skills repo — a merged local edit dies at
// the next --update (NOTES item 37). Backlog Status edits belong to the
// driver alone; task branches are code-only (item 24).
const TOOLING = new Set(["driver.mjs", "prompts", "schedulers", "hooks"]);

if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(tool)) {
  const p = input.file_path ?? input.notebook_path ?? "";
  const segments = path.resolve(cwd, p).split(path.sep);
  const i = segments.lastIndexOf(".factory");
  if (i !== -1) {
    const child = segments[i + 1] ?? "";
    if (TOOLING.has(child)) {
      deny(`${p} is deployed factory tooling (read-only for sessions) — propose the change via the open_question tool instead`);
    }
    if (child === "backlog" && mode === "dev") {
      deny(`${p}: dev sessions never edit the backlog — report via the report_status MCP tool (last-session.json only if the tools are missing); the driver owns every Status edit`);
    }
  }
}

if (tool === "Bash") {
  const cmd = String(input.command ?? "");
  if (/\bgh\s+pr\s+merge\b/.test(cmd)) {
    deny("sessions never merge PRs — the driver's merge gate merges when checks are green");
  }
  // The git SUBCOMMAND decides the rule: reading history (log/diff/show/…)
  // is always fine — the report prompt greps backlog history daily. Only
  // mutating subcommands are policed.
  const sub = cmd.match(/\bgit\b(?:\s+-[^\s]+)*\s+([a-z-]+)/)?.[1] ?? null;
  const MUTATING = new Set(["add", "commit", "push", "rm", "mv", "restore", "checkout", "switch", "stash", "reset", "apply", "clean", "merge", "rebase", "cherry-pick"]);
  // .claude is session tooling the driver INJECTS into worktrees (P2) plus
  // owner-level config — neither belongs in a session commit. The exclude
  // block already hides injected paths from git; this denial is the belt.
  if (sub && MUTATING.has(sub) && /\.factory[\\/](backlog|driver\.mjs|prompts|schedulers|hooks)|\.claude[\\/]/.test(cmd)) {
    deny("mutating git on .factory metadata/tooling or .claude paths is driver/owner-only — task branches are code-only");
  }
  if (sub === "commit" || sub === "push") {
    if (mode !== "dev") {
      deny(`${mode} sessions never commit or push — the driver commits their output`);
    }
    const base = process.env.FACTORY_BASE_BRANCH;
    if (base) {
      let branch = "";
      try {
        branch = execFileSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
      } catch { /* not a repo / detached — branch check not applicable */ }
      if (branch === base) {
        deny(`refusing git ${sub} on the base branch (${base}) — work on a task branch; the driver owns ${base}`);
      }
      // Push targets only matter for `push` — a commit message that happens
      // to contain "push … <base>" must not trip this.
      if (sub === "push") {
        const pushesToBase = new RegExp(`\\bpush\\b[^|;&]*[\\s:/]${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(cmd);
        if (pushesToBase) {
          deny(`refusing a push targeting the base branch (${base}) — open a PR; the driver's gate lands it`);
        }
      }
    }
  }
}

process.exit(0);
