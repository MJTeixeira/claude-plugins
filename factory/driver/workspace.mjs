// Session workspace materialization (machine-product refactor P2): the repo
// carries only work data, so every session/meta worktree gets its tooling —
// .claude/settings.local.json (allowlist + guard hook), skills, agents —
// INJECTED at spawn/refresh from the gated runtime, never from git. Claude
// Code merges settings.local.json over the project's settings.json, so an
// owner-committed settings file coexists with the injection untouched.
//
// Shared by factory.mjs (materialization, migrate cleanup), config.mjs
// (schema healing), and init.mjs (stack detection) so the allowlist presets
// and stack detection can never drift between them.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const ALLOW_BASE = ["Read", "Edit", "Write", "Glob", "Grep", "TodoWrite",
  "Bash(git:*)", "Bash(gh:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(mkdir:*)", "Bash(node:*)",
  // Audited additions (PR-F): the top deny offenders across the 2026-07
  // session logs (~1,100 dontAsk denials, most costing several turns each) —
  // inspect/search, workspace file ops, and asset fetch/unpack. `cd` matters
  // because compound `cd X && <allowed>` is permission-checked per segment.
  // rm stays OFF the list as FRICTION against the reflexive cleanup habit
  // (sessions are told the driver wipes scratch), NOT as a security boundary:
  // node:* above already grants arbitrary fs access, and find/mv below can
  // delete/clobber too — dontAsk sessions are trusted with the machine.
  "Bash(find:*)", "Bash(grep:*)", "Bash(echo:*)", "Bash(sed:*)", "Bash(awk:*)",
  "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)", "Bash(sort:*)", "Bash(diff:*)",
  "Bash(which:*)", "Bash(pwd)", "Bash(cd:*)", "Bash(cp:*)", "Bash(mv:*)",
  "Bash(touch:*)", "Bash(chmod:*)", "Bash(rmdir:*)",
  "Bash(curl:*)", "Bash(unzip:*)", "Bash(tar:*)",
  "mcp__factory"]; // the driver's reporting MCP server (factory-v2 O2) — dontAsk denies unlisted tools
export const ALLOW_STACK = {
  node: ["Bash(npm:*)", "Bash(npx:*)"],
  python: ["Bash(python:*)", "Bash(python3:*)", "Bash(pip:*)", "Bash(pytest:*)", "Bash(uv:*)"],
  rust: ["Bash(cargo:*)"],
  go: ["Bash(go:*)"],
  dotnet: ["Bash(dotnet:*)"],
  other: [],
};
// Engine binaries are invoked by a bare command resolved from a PATH wrapper
// (~/bin/godot, ~/bin/unity) so the allowlist can match Bash(<engine>:*)
// rather than a per-machine absolute app path. The C# side is separately
// covered by the dotnet stack preset when a root .sln/.csproj exists.
export const ALLOW_ENGINE = {
  godot: ["Bash(godot:*)"],
  unity: ["Bash(unity:*)"],
};

// Canonical .factory/.gitignore — the runtime state the driver writes (or
// symlinks, in the meta worktree) next to the work data. Without it, one
// `git add -A .factory` tracks logs and plan.json (modelwars 2026-07-11).
// `log` deliberately unslashed: `log/` matches only directories, never the
// meta worktree's log SYMLINK, and a committed symlink loops the fleet.
// Shared by init (scaffold stamp), migrate (healing), and doctor (drift).
export const FACTORY_GITIGNORE = [".env", "log", "tmp/", "plan.json", "board.json", "STOP"];

// Entry comparison ignores a trailing slash: `log/` in a live fleet file
// counts as covering `log` for drift purposes — commitMetadata's reset belt
// handles the symlink case, and healing must not nag every healthy project.
const ignoreKey = (l) => l.trim().replace(/\/$/, "");
export const missingGitignoreEntries = (text) => {
  const have = new Set(String(text ?? "").split("\n").map(ignoreKey).filter(Boolean));
  return FACTORY_GITIGNORE.filter((e) => !have.has(ignoreKey(e)));
};

// Create or heal .factory/.gitignore in place; owner lines are never touched,
// missing canonical entries are appended. Returns what was added.
export const stampFactoryGitignore = (projectDir) => {
  const p = path.join(projectDir, ".factory", ".gitignore");
  const cur = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  const missing = missingGitignoreEntries(cur);
  if (!missing.length) return [];
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, cur.replace(/\n*$/, cur ? "\n" : "") + missing.join("\n") + "\n");
  return missing;
};

export const detectStack = (dir) => {
  if (fs.existsSync(path.join(dir, "package.json"))) return "node";
  if (fs.existsSync(path.join(dir, "pyproject.toml")) || fs.existsSync(path.join(dir, "requirements.txt"))) return "python";
  if (fs.existsSync(path.join(dir, "Cargo.toml"))) return "rust";
  if (fs.existsSync(path.join(dir, "go.mod"))) return "go";
  if (fs.readdirSync(dir).some((f) => f.endsWith(".sln") || f.endsWith(".csproj"))) return "dotnet";
  return null;
};

// Engine detection gates the engine ALLOWLIST presets (skills all come from
// the machine-installed plugins; their descriptions gate themselves). Marker
// anywhere ≤2 dirs deep — Unity/Godot projects often sit in a subdir like
// unity/<Name>/ or game/.
export const detectEngines = (dir) => {
  const SKIP = new Set([".git", "node_modules", "Library", ".factory", ".claude", ".docs"]);
  const engines = new Set();
  const checkDir = (d) => {
    if (fs.existsSync(path.join(d, "ProjectSettings", "ProjectVersion.txt"))) engines.add("unity");
    if (fs.existsSync(path.join(d, "project.godot"))) engines.add("godot");
  };
  const subdirs = (d) => {
    try {
      return fs.readdirSync(d, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !SKIP.has(e.name))
        .map((e) => path.join(d, e.name));
    } catch { return []; }
  };
  checkDir(dir);
  for (const d1 of subdirs(dir)) {
    checkDir(d1);
    for (const d2 of subdirs(d1)) checkDir(d2);
  }
  return [...engines];
};

// Flat "key: value" answerfile (subset of YAML on purpose — zero deps).
// Lives here because migrate recovers machine-config values (stack) from a
// legacy factory.yaml before removing it from the repo.
export const parseAnswerFile = (p) => {
  const out = {};
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const c = t.indexOf(":");
    if (c > 0) out[t.slice(0, c).trim()] = t.slice(c + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
};

const git = (cwd, args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// Every skill name the factory ever deployed into project repos (engine
// skills and factory-setup included) — the removal list for migrate's repo
// cleanup AND for scrubbing pre-G3 injected copies out of persistent
// worktrees: cleanup must catch copies regardless of provenance.
export const factorySkillNames = (runtimeRoot) => [
  ...fs.readdirSync(path.join(runtimeRoot, "skills"), { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name),
  ...fs.readdirSync(path.join(runtimeRoot, "factory", "skills"), { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name),
];

// Surgical removal of factory-added entries from a project .claude/settings.json
// (migrate's repo cleanup): preset allowlist entries and the guard hook go,
// everything the owner added stays. Returns the stripped copy — {} means the
// file was entirely factory-owned and can be removed outright.
export const stripFactorySettings = (settings) => {
  const FACTORY_ALLOW = new Set([
    ...ALLOW_BASE,
    ...Object.values(ALLOW_STACK).flat(),
    ...Object.values(ALLOW_ENGINE).flat(),
  ]);
  const out = JSON.parse(JSON.stringify(settings));
  if (Array.isArray(out.permissions?.allow)) {
    out.permissions.allow = out.permissions.allow.filter((e) => !FACTORY_ALLOW.has(e));
    if (!out.permissions.allow.length) delete out.permissions.allow;
    if (!Object.keys(out.permissions).length) delete out.permissions;
  }
  if (Array.isArray(out.hooks?.PreToolUse)) {
    // Both guard generations go: the factory's worktree guard wiring and the
    // install.sh-era branch guard (the skillset plugin ships that hook now).
    out.hooks.PreToolUse = out.hooks.PreToolUse.filter(
      (e) => !(e.hooks ?? []).some((h) => String(h.command ?? "").includes(".factory/hooks/guard.mjs")
        || String(h.command ?? "").includes("protected-branch-guard.mjs")));
    if (!out.hooks.PreToolUse.length) delete out.hooks.PreToolUse;
    if (!Object.keys(out.hooks).length) delete out.hooks;
  }
  return out;
};

// Guard wired by ABSOLUTE runtime path: worktrees carry no hook copy, and the
// runtime advances only through deploy-runtime.mjs — so the guard a session
// runs is exactly the one the driver spawning it shipped with.
export const guardCommand = (runtimeRoot) =>
  `node "${path.join(runtimeRoot, "factory", "driver", "hooks", "guard.mjs")}"`;

export const buildSessionSettings = ({ stack, engines, extraAllow = [], runtimeRoot }) => ({
  permissions: {
    allow: [...new Set([
      ...ALLOW_BASE,
      ...(ALLOW_STACK[stack] ?? []),
      ...engines.flatMap((e) => ALLOW_ENGINE[e] ?? []),
      ...extraAllow,
    ])],
  },
  hooks: {
    PreToolUse: [{
      matcher: "Edit|MultiEdit|Write|NotebookEdit|Bash",
      hooks: [{ type: "command", command: guardCommand(runtimeRoot) }],
    }],
  },
});

// Everything materialization may write under a worktree. Used to keep the
// quarantine machinery away from injected files (they are runtime property,
// not session work) — see copyDirtyBytes/removeWorktree in factory.mjs.
export const isInjectedPath = (rel) => {
  const p = rel.split(path.sep).join("/").replace(/\/$/, "");
  return p === ".claude/settings.local.json" ||
    p === ".claude/skills" || p.startsWith(".claude/skills/") ||
    p === ".claude/agents" || p.startsWith(".claude/agents/");
};

const EXCLUDE_BEGIN = "# >>> factory-injected session tooling (managed block — the driver rewrites it)";
const EXCLUDE_END = "# <<< factory-injected";

// Injected paths must be invisible to git — a session's `git add -A` or the
// quarantine sweep must never pick them up. git has NO per-worktree exclude:
// $GIT_DIR/info/exclude always resolves to the COMMON dir (verified — a
// .git/worktrees/<id>/info/exclude file is simply never read), so the block
// lands in the repo's shared .git/info/exclude. That file is machine-local
// and unversioned — exactly where machine-injected tooling belongs; it also
// keeps the owner's checkout from ever showing injected leftovers.
const writeExcludeBlock = (worktree, rels) => {
  const common = git(worktree, ["rev-parse", "--git-common-dir"]);
  const commonAbs = path.isAbsolute(common) ? common : path.resolve(worktree, common);
  const p = path.join(commonAbs, "info", "exclude");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let text = "";
  try { text = fs.readFileSync(p, "utf8"); } catch { /* first write */ }
  const b = text.indexOf(EXCLUDE_BEGIN);
  if (b !== -1) {
    const e = text.indexOf(EXCLUDE_END);
    text = text.slice(0, b) + (e !== -1 ? text.slice(e + EXCLUDE_END.length).replace(/^\n/, "") : "");
  }
  const block = [EXCLUDE_BEGIN, ...rels.map((r) => `/${r}`), EXCLUDE_END].join("\n");
  fs.writeFileSync(p, text.replace(/\n*$/, text ? "\n" : "") + block + "\n");
};

// Materialize session tooling into a worktree. Repo-tracked copies win: a
// tracked skill (transition-era repos, or an owner keeping their own) is
// never overwritten — modifying tracked content would dirty every session's
// tree and leak diffs into commits. Untracked entries are refreshed from the
// runtime on every call (the meta worktree persists across deploys).
export const materializeWorkspace = ({ worktree, runtimeRoot, config = {} }) => {
  const engines = detectEngines(worktree);
  const stack = config.stack ?? detectStack(worktree) ?? "other";
  const tracked = (rel) => { try { return git(worktree, ["ls-files", "--", rel]) !== ""; } catch { return false; } };
  const injected = [];

  fs.mkdirSync(path.join(worktree, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(worktree, ".claude", "settings.local.json"),
    JSON.stringify(buildSessionSettings({ stack, engines, extraAllow: config.allow ?? [], runtimeRoot }), null, 2) + "\n");
  injected.push(".claude/settings.local.json");
  // A repo that TRACKS settings.local.json defeats the exclude block (it
  // only hides untracked paths): the overwrite above would show as a
  // modified tracked file and ride a session's `git add -A` straight into
  // a PR — machine-absolute paths and all. skip-worktree makes git treat
  // the index version as current, so nothing stages and pushes carry the
  // origin bytes. Worktree-local index: dies with the worktree.
  if (tracked(".claude/settings.local.json")) {
    git(worktree, ["update-index", "--skip-worktree", "--", ".claude/settings.local.json"]);
  }

  // G3: skills and the code-reviewer agent come from the machine-installed
  // code4food plugins, never from worktree copies. Persistent worktrees (meta)
  // may still carry pre-G3 injected copies — scrub any untracked ones, or they
  // shadow/duplicate the plugin versions in every triage session.
  for (const name of factorySkillNames(runtimeRoot)) {
    const rel = `.claude/skills/${name}`;
    const dest = path.join(worktree, ".claude", "skills", name);
    if (!tracked(rel) && fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  }
  const agentRel = ".claude/agents/code-reviewer.md";
  if (!tracked(agentRel) && fs.existsSync(path.join(worktree, agentRel))) {
    fs.rmSync(path.join(worktree, agentRel), { force: true });
  }
  for (const dir of [".claude/skills", ".claude/agents"]) {
    try { fs.rmdirSync(path.join(worktree, dir)); } catch { /* non-empty (owner content) or absent */ }
  }

  writeExcludeBlock(worktree, injected);
  return injected;
};
