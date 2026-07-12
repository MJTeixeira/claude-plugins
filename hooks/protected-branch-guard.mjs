#!/usr/bin/env node
// Lean Dev Skillset PreToolUse guard — mechanical enforcement of the
// branch-first rule: no `git commit`/`git push` on protected branches
// (main/master/dev). Installed by install.sh into .claude/hooks/ and wired
// into .claude/settings.json; claude runs it before Bash calls with the
// event JSON on stdin. Empty stdout = allow; a permissionDecision JSON =
// deny. Factory sessions have their own guard (.factory/hooks/guard.mjs)
// with base-branch rules; this one covers interactive work and stays
// silent on task branches.
import { execFileSync } from "node:child_process";
import * as path from "node:path";

const PROTECTED = new Set(["main", "master", "dev"]);

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

let event;
try { event = JSON.parse(raw); } catch { process.exit(0); } // unreadable event — stay out of the way
if ((event.tool_name ?? "") !== "Bash") process.exit(0);

const deny = (reason) => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `branch guard: ${reason}`,
    },
  }));
  process.exit(0);
};

// Strip quoted strings first, so literal text like a commit message or a
// grep pattern containing "git push origin main" never trips the rules.
const cmd = String(event.tool_input?.command ?? "").replace(/"[^"]*"|'[^']*'/g, '""');
// EVERY git invocation in the command decides (chains like
// `git add -A && git commit` must not slip through on the first
// subcommand), and each is judged with ITS OWN -C target: `git -C /repo
// commit` acts on /repo, so the shell cwd's branch only matters for
// invocations without -C.
const acting = [];
for (const m of cmd.matchAll(/\bgit((?:\s+(?:-C\s+\S+|-c\s+\S+|--?[^\s]+))*)\s+([a-z][a-z-]*)/g)) {
  const sub = m[2];
  if (sub === "commit" || sub === "push") {
    acting.push({ sub, cPath: m[1].match(/-C\s+(\S+)/)?.[1] ?? null });
  }
}
const wantsCommit = acting.some((i) => i.sub === "commit");
const wantsPush = acting.some((i) => i.sub === "push");
if (!wantsCommit && !wantsPush) process.exit(0);

// A push naming only explicit non-HEAD refspecs (e.g. `push origin
// --delete old-branch`) can't touch a protected branch no matter where the
// shell sits — the target check below polices the names. Only bare/HEAD
// pushes, which push the CURRENT branch, keep the current-branch check.
const ARG_FLAGS = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);
let pushesCurrent = false;
if (wantsPush) {
  for (const seg of cmd.matchAll(/\bpush\b([^|;&]*)/g)) {
    const words = seg[1].trim().split(/\s+/).filter(Boolean);
    const positional = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w === "--delete" || w === "-d") continue; // its ref stays positional
      if (w.startsWith("-")) { if (ARG_FLAGS.has(w)) i++; continue; }
      positional.push(w);
    }
    const refspecs = positional.slice(1); // first positional is the remote
    if (refspecs.length === 0 || refspecs.includes("HEAD")) pushesCurrent = true;
  }
}

// The branch check below sees the branch BEFORE the command runs, so a
// checkout/switch to a protected branch chained with a commit or a
// current-branch push would dodge it — refuse the combination outright.
if ((wantsCommit || pushesCurrent) &&
    /\b(checkout|switch)\b[^|;&]*(?:[\s\/](main|master|dev)(?![\w-]))/.test(cmd)) {
  deny("checkout/switch to a protected branch chained with commit/push — split the command; commits belong on a work branch");
}

// Check each acting invocation's repo: its -C target when it has one, the
// shell cwd otherwise. A command whose every commit/push carries -C never
// touches the cwd repo, so the cwd's branch must not block it.
const cwd = event.cwd || process.cwd();
const dirs = [];
for (const i of acting) {
  const dir = i.cPath ? path.resolve(cwd, i.cPath) : cwd;
  if (!dirs.includes(dir)) dirs.push(dir);
}
for (const dir of dirs) {
  let branch = "";
  try {
    branch = execFileSync("git", ["branch", "--show-current"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch { continue; /* not a repo / detached HEAD / bogus -C match — nothing to guard */ }
  if (PROTECTED.has(branch) && (wantsCommit || pushesCurrent)) {
    const sub = wantsCommit ? "commit" : "push";
    deny(`refusing git ${sub} on protected branch '${branch}' (${dir}) — create a branch first; if this truly belongs on ${branch}, the user runs it themselves`);
  }
}
// Push targets only matter for `push` — a commit message that happens to
// contain "push … main" was already neutralized by the quote-stripping.
if (wantsPush) {
  for (const b of PROTECTED) {
    if (new RegExp(`\\bpush\\b[^|;&]*[\\s:/]${b}(?![\\w-])`).test(cmd)) {
      deny(`push targets protected branch '${b}' — open a PR instead; if this truly belongs on ${b}, the user runs it themselves`);
    }
  }
}

process.exit(0);
