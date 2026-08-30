// The driver's preflight checklist (NOTES items 21, 25) — the `doctor`
// verb's implementation, also run as the silent preflight of every
// --scheduled window and as prep's closing summary. Read-only: every check
// here burned a real night or window once (scheduler PATH, trust flag,
// token scopes, config loss, …). Never writes the repo, never takes the
// lock — safe while a window is open.
//
// Interface: runDoctor(ctx) runs every check and returns
// [{ level: "ok"|"warn"|"fail"|"skip", name, detail }]; the caller owns
// what a fail means (doctor mode prints and exits 1, the scheduled
// preflight aborts the run, prep folds it into its summary line). No argv,
// env-var or config parsing lives here — factory.mjs loads everything and
// hands it over in the context:
//   project, cfg, env, stateD, dataDir — the loaded factory (post-loadConfig)
//   forge, tracker — the forge/tracker adapters (authCheck, repoIsPublic)
//   collectSchedulers, resolveCmd, projectTrustState, projectTrusted,
//   isGitRepo — shared driver probes (they also serve schedule/prep/spawn)
//   RUNTIME_ROOT, RUNTIME_DRIVER — runtime checkout root + machine driver path
//   BOARD_STATUSES — backlog status vocabulary (shared with board sync)
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { readJson, readEnvLines, machineEnvFile, firstLine } from "./paths.mjs";
import { buildSessionSettings, detectStack, detectEngines, missingGitignoreEntries, misspelledGitignoreEntries } from "./workspace.mjs";
import { SCHEDULE_KINDS, normalizeSchedule, validateDeclaration, compareInstalled } from "./schedule.mjs";
import { nativeTrackerCheck } from "./forge.mjs";
import { parseMilestones, unparsedMilestoneHeadings, parseBacklogTasks as parseTasksInDir, lintVerify } from "./backlog-index.mjs";
import { jiraTracker } from "./jira.mjs";
import { expectedOrigin, sameOrigin } from "./distribution.mjs";

export const runDoctor = (ctx) => {
  const {
    project, cfg, env, stateD, dataDir, forge, tracker,
    collectSchedulers, resolveCmd, projectTrustState, projectTrusted, isGitRepo,
    RUNTIME_ROOT, RUNTIME_DRIVER, BOARD_STATUSES,
  } = ctx;
  // Same read as factory.mjs's own wrapper: doctor reads work data from the
  // project checkout's .factory, never the meta worktree.
  const parseBacklogTasks = () => parseTasksInDir(path.join(dataDir, "backlog"));
  const results = [];
  const check = (level, name, detail = "") => results.push({ level, name, detail });
  const sh = (cmd, args) => {
    try { return { out: execFileSync(cmd, args, { timeout: 15_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
    catch (e) { return { out: null, err: (String(e.stderr ?? "").trim() || e.message).split("\n")[0].slice(0, 160) }; }
  };

  // 0. host platform — Windows was dropped as a factory host (2026-07-18):
  //    speccing and live piloting stay supported there, the machine-resident
  //    factory (schedulers, supervisor, worktree sessions) does not.
  if (process.platform === "win32") {
    check("fail", "host platform", "Windows is not a supported factory host — run the factory on macOS/Linux (spec + pilot on Windows stay supported)");
  }

  // 1. binaries on the CURRENT path (what a manual run sees)
  const claudeBin = resolveCmd(cfg.claudeCmd);
  check(claudeBin ? "ok" : "fail", `claude on PATH`, claudeBin ?? `'${cfg.claudeCmd}' not found`);
  const forgeBin = resolveCmd(forge.bin);
  check(forgeBin ? "ok" : "fail", `${forge.bin} on PATH`, forgeBin ?? "not found — PRs and issues will fail");

  // 2. binaries under the SCHEDULER's PATH (what a timer-fired run sees —
  //    the 2026-07-04 lost-night trap: .bashrc PATH is invisible to systemd)
  const installedSched = collectSchedulers();
  const units = installedSched.systemd.map(({ name, text }) => ({ f: name, text }));
  {
    const services = units.filter((u) => u.f.endsWith(".service"));
    if (!services.length) check("skip", "systemd service PATH", "no unit in ~/.config/systemd/user references this project");
    for (const u of services) {
      const m = u.text.match(/^Environment=PATH=(.+)$/m);
      if (!m) { check("warn", `systemd service PATH (${u.f})`, "no Environment=PATH= line — timer runs get the minimal systemd PATH"); continue; }
      const missing = [cfg.claudeCmd, forge.bin].filter((c) => !resolveCmd(c, m[1]));
      check(missing.length ? "fail" : "ok", `systemd service PATH (${u.f})`,
        missing.length ? `${missing.join(", ")} not resolvable under the unit's PATH` : "claude and gh resolve");
    }
  }

  // 3. workspace trust — untrusted projects deny every mutating tool. A
  //    half-stamped entry (dialog flag only) is a warn on git projects
  //    (worktrees restamp both flags every spawn) and a fail on non-git
  //    ones, where sessions run in place without the allowlist (S12).
  {
    const ts = projectTrustState(project);
    check(projectTrusted(project) ? (ts === "half" ? "warn" : "ok") : "fail", "workspace trust (~/.claude.json)",
      ts === "full" ? ""
        : ts === "half" && projectTrusted(project)
          ? `half-stamped (dialog flag only) — harmless here (git worktrees restamp), complete it with init.mjs --project ${project}`
          : `re-run init.mjs --project ${project}, or claude interactively once`);
  }

  // 4. scaffold (prompts are NOT project scaffold anymore — they ship with
  //    the runtime, next to this driver)
  const wanted = ["backlog/index.md", "spec"];
  const absent = wanted.filter((w) => !fs.existsSync(path.join(dataDir, w)));
  check(absent.length ? "fail" : "ok", ".factory scaffold", absent.length ? `missing: ${absent.join(", ")}` : "complete");
  if (cfg.permissionMode === "dontAsk") {
    if (isGitRepo()) {
      // Sessions run in worktrees whose allowlist is INJECTED at spawn (P2)
      // — report what they will get, computed from machine config; a repo
      // settings.json is the owner's business, not a session requirement.
      const stack = cfg.stack ?? detectStack(project) ?? "other";
      const n = buildSessionSettings({ stack, engines: detectEngines(project), extraAllow: cfg.allow ?? [], runtimeRoot: RUNTIME_ROOT }).permissions.allow.length;
      check("ok", "allowlist", `injected into session worktrees at spawn (${stack} preset, ${n} rules)`);
    } else {
      // Non-git projects run sessions in place with no injection — the
      // init-written settings.json is still the only allowlist they have.
      const allow = readJson(path.join(project, ".claude", "settings.json"))?.permissions?.allow;
      check(Array.isArray(allow) && allow.length ? "ok" : "fail", "allowlist (.claude/settings.json)",
        Array.isArray(allow) && allow.length ? `${allow.length} rules` : "dontAsk with no allowlist denies every tool");
    }
  } else check("skip", "allowlist", `permissionMode ${cfg.permissionMode}`);

  // 4z. peer client — when wired, sessions get the ask_peer tool
  //     and a dead bin path would silently degrade every window to the old
  //     needs-human-only path (the tool errors, sessions fall back).
  {
    const peer = cfg.peer;
    if (!peer) check("skip", "peer client", "not configured — sessions have no ask_peer tool");
    else if (!peer.enabled) check("skip", "peer client", "disabled (peer.enabled: false)");
    else if (!peer.bin) check("fail", "peer client", 'peer.enabled without "bin" — set peer.bin to the channel CLI path (ask_peer will not register)');
    else if (!fs.existsSync(peer.bin)) check("fail", "peer client", `peer.bin does not exist: ${peer.bin} — ask_peer registers but every ask will fail`);
    else check("ok", "peer client", `ask_peer on — ${peer.bin}`);
  }

  // Unattended machine declaration (unattended-skillset GA): a machine whose
  // runtime carries deliberate overlays and whose sessions load skills from a
  // declared plugin instead of the shipped code4food pair. Written by hand at
  // install time; checks 5 and 5b verify against it instead of failing red.
  const unattendedPath = path.join(os.homedir(), ".factory", "unattended.json");
  const unattended = readJson(unattendedPath);

  // 5. machine runtime (O6, NOTES item 46) — schedulers, watchdog, and
  //    dashboard all run ~/.factory/runtime, advanced only through
  //    deploy-runtime's gates. The per-project driver copies and their
  //    sha256 drift stamps (item 22) died with the migration.
  {
    const RUNTIME = path.join(os.homedir(), ".factory", "runtime");
    if (!fs.existsSync(path.join(RUNTIME, ".git"))) {
      check("skip", "machine runtime", `none at ${RUNTIME} (dev-checkout run) — bootstrap: git clone <repo-url> ${RUNTIME}`);
    } else {
      const porcelain = sh("git", ["-C", RUNTIME, "status", "--porcelain"]).out ?? "";
      const dirty = porcelain.trim();
      const sha = (sh("git", ["-C", RUNTIME, "rev-parse", "--short", "HEAD"]).out ?? "?").trim();
      const overlays = unattended?.overlays;
      if (dirty && overlays && typeof overlays === "object") {
        // Declared unattended machine: the runtime is deliberately overlaid.
        // Green means EXACTLY the declared files differ and each matches its
        // declared checksum — anything else is still ordinary drift.
        const dirtyFiles = porcelain.split("\n").map((l) => l.slice(3)).filter(Boolean);
        const extra = dirtyFiles.filter((f) => !(f in overlays));
        const bad = Object.entries(overlays).filter(([f, want]) => {
          try { return createHash("sha256").update(fs.readFileSync(path.join(RUNTIME, f))).digest("hex") !== want; }
          catch { return true; /* declared file missing */ }
        }).map(([f]) => f);
        if (extra.length) check("fail", "machine runtime", `dirty outside the overlay manifest: ${extra.join(", ")} — restore them or re-declare in ${unattendedPath}`);
        else if (bad.length) check("fail", "machine runtime", `overlay checksum mismatch: ${bad.join(", ")} — re-overlay from the branch and update ${unattendedPath}`);
        else check("ok", "machine runtime", `overlaid for the unattended skillset at ${sha} — ${Object.keys(overlays).length} file(s) checksum-verified`);
      } else {
        check(dirty ? "fail" : "ok", "machine runtime",
          dirty ? `${RUNTIME} tree is dirty — the runtime only ever advances via deploy-runtime.mjs; restore it (git -C ${RUNTIME} status)` : `clean at ${sha}`);
      }
      // 5a. runtime origin (migration runbook Phase 0) — a wrong or retired
      //     remote fetches fine and deploys report "up to date" forever: a
      //     silently frozen machine. URL comparison only, no network —
      //     liveness is deploy-runtime's fetch refusal.
      const origin = (sh("git", ["-C", RUNTIME, "remote", "get-url", "origin"]).out ?? "").trim();
      if (!origin) {
        check("fail", "runtime origin", `no origin remote — the runtime can never advance; git -C ${RUNTIME} remote set-url origin ${expectedOrigin()} (adding it if missing)`);
      } else if (!sameOrigin(origin, expectedOrigin())) {
        check("fail", "runtime origin", `${origin} is not the distribution repo — deploys report "up to date" forever while the fleet advances; fix: git -C ${RUNTIME} remote set-url origin ${expectedOrigin()}`);
      } else {
        check("ok", "runtime origin", origin);
      }
    }
    if (fs.existsSync(path.join(dataDir, "driver.mjs"))) {
      check("warn", "legacy driver copy", ".factory/driver.mjs is the retired v3 per-project copy — nothing should run it; git rm it");
    }
  }

  // 5b. code4food plugins (G3) — sessions load their skills from the
  //     machine-installed plugins, provisioned from the runtime clone by
  //     deploy-runtime. Missing or version-drifted plugins mean sessions run
  //     with no (or stale) skills, so this fails with the fix spelled out.
  {
    const RUNTIME = path.join(os.homedir(), ".factory", "runtime");
    if (!fs.existsSync(path.join(RUNTIME, ".git"))) {
      check("skip", "code4food plugins", "no machine runtime (dev-checkout run)");
    } else if (unattended?.plugin && unattended?.marketplace) {
      // Declared unattended machine: the shipped pair must be ABSENT (the
      // unattended plugin reuses the name — duplicates silently lose skills)
      // and the declared plugin installed at the source's version.
      const installed = readJson(path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json"))?.plugins;
      const shipped = ["code4food-skillset@code4food", "code4food-factory@code4food"].filter((k) => installed?.[k]?.length);
      if (shipped.length) check("fail", "code4food plugins", `unattended machine still has shipped plugin(s) ${shipped.join(", ")} — same-name collision silently loses skills; claude plugin uninstall them`);
      else check("skip", "code4food plugins", `unattended machine (${unattendedPath}) — shipped pair deliberately absent`);
      const { plugin: pname, marketplace: mname, source } = unattended;
      const mkt = readJson(path.join(os.homedir(), ".claude", "plugins", "known_marketplaces.json"))?.[mname];
      const mktPath = mkt?.source?.path ?? mkt?.installLocation;
      const want = readJson(path.join(String(source ?? ""), ".claude-plugin", "plugin.json"))?.version;
      const rec = installed?.[`${pname}@${mname}`]?.[0];
      const provision = `claude plugin marketplace add ${source} && claude plugin install ${pname}@${mname}`;
      if (!mkt) check("fail", `unattended plugin ${pname}`, `marketplace ${mname} not registered — provision: ${provision}`);
      else if (path.resolve(String(mktPath ?? "")) !== path.resolve(String(source ?? ""))) check("fail", `unattended plugin ${pname}`, `marketplace ${mname} points at ${mktPath ?? "?"}, not the declared source ${source}`);
      else if (!rec) check("fail", `unattended plugin ${pname}`, `not installed — ${provision}`);
      else if (want && rec.version !== want) check("fail", `unattended plugin ${pname}`, `installed ${rec.version}, source ships ${want} — claude plugin update ${pname}@${mname}`);
      else check("ok", `unattended plugin ${pname}`, String(rec.version ?? ""));
    } else if (!fs.existsSync(path.join(RUNTIME, ".claude-plugin", "marketplace.json"))) {
      check("skip", "code4food plugins", "runtime ships no plugin marketplace (pre-G3)");
    } else if (process.env.FACTORY_DEPLOY_GATE) {
      check("skip", "code4food plugins", "provisioned by the running deploy after the gate");
    } else {
      const provisionHint = `claude plugin marketplace add ${RUNTIME} && claude plugin install code4food-skillset@code4food code4food-factory@code4food`;
      const mkt = readJson(path.join(os.homedir(), ".claude", "plugins", "known_marketplaces.json"))?.code4food;
      const installed = readJson(path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json"))?.plugins;
      const mktPath = mkt?.source?.path ?? mkt?.installLocation;
      if (!mkt) {
        check("fail", "code4food plugins", `marketplace not registered — provision: ${provisionHint}`);
      } else if (path.resolve(String(mktPath ?? "")) !== path.resolve(RUNTIME)) {
        check("fail", "code4food plugins", `marketplace points at ${mktPath ?? "?"}, not the runtime — remove it, then provision: ${provisionHint}`);
      } else {
        for (const [name, rel] of [
          ["code4food-skillset", path.join(".claude-plugin", "plugin.json")],
          ["code4food-factory", path.join("factory", ".claude-plugin", "plugin.json")],
        ]) {
          const want = readJson(path.join(RUNTIME, rel))?.version;
          const rec = installed?.[`${name}@code4food`]?.[0];
          if (!rec) check("fail", `plugin ${name}`, `not installed — run deploy-runtime.mjs (or: ${provisionHint})`);
          else if (want && rec.version !== want) check("fail", `plugin ${name}`, `installed ${rec.version}, runtime ships ${want} — run deploy-runtime.mjs`);
          else check("ok", `plugin ${name}`, String(rec.version ?? ""));
        }
      }
    }
  }

  // 6. .env keys required by enabled features
  const needed = [];
  if (cfg.notify?.telegram) needed.push("TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID");
  if ((cfg.mirrors ?? []).includes("notion")) needed.push("NOTION_TOKEN");
  if ((cfg.mirrors ?? []).includes("jira") || cfg.tracker === "jira" || cfg.board?.jira) needed.push("JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN");
  if (cfg.tracker === "discord") needed.push("DISCORD_BOT_TOKEN");
  if (needed.length) {
    const unset = needed.filter((k) => !env[k]);
    check(unset.length ? "fail" : "ok", ".factory/.env keys", unset.length ? `enabled features need: ${unset.join(", ")}` : `${needed.join(", ")} set`);
  } else check("skip", ".factory/.env keys", "no feature needs one");

  // 6b. machine credentials (~/secrets/factory-shared.env) — the one home
  //     for creds shared by every factory on the box; sessions see it via
  //     the readEnvFile merge (project wins per key). Absent is fine:
  //     all-project mode stays legitimate. Present, two things matter: the
  //     owner-pattern perms (file 600, dir 700 — the whole point of the
  //     home), and project .env keys byte-identical to the machine file's —
  //     dead duplicates that put rotation back to one-edit-per-project.
  {
    const mFile = machineEnvFile();
    if (!fs.existsSync(mFile)) {
      check("skip", "machine credentials", `no ${mFile} — all creds project-side`);
    } else {
      const mode = (p) => { try { return fs.statSync(p).mode & 0o777; } catch { return null; } };
      const bad = [];
      const fMode = mode(mFile), dMode = mode(path.dirname(mFile));
      if (fMode !== null && fMode !== 0o600) bad.push(`file mode ${fMode.toString(8)} — chmod 600 ${mFile}`);
      if (dMode !== null && dMode !== 0o700) bad.push(`dir mode ${dMode.toString(8)} — chmod 700 ${path.dirname(mFile)}`);
      const mEnv = readEnvLines(mFile);
      check(bad.length ? "warn" : "ok", "machine credentials",
        bad.length ? bad.join("; ") : `${Object.keys(mEnv).length} shared key(s), perms 600/700`);
      const projEnv = readEnvLines(path.join(stateD, ".env"));
      const dup = Object.keys(projEnv).filter((k) => k in mEnv && projEnv[k] === mEnv[k]);
      if (dup.length) check("warn", "machine credential duplicates",
        `${dup.join(", ")} in <state>/.env duplicate the machine file byte-for-byte — delete the project copy (rotation should edit one file)`);
    }
  }

  // 7. forge auth (+ scopes when the token lists them)
  if (forgeBin) for (const r of forge.authCheck({ wantBoard: !!cfg.board?.github })) check(r.level, r.name, r.detail);
  else check("skip", `${forge.bin} auth`, `${forge.bin} not installed`);
  // A non-native tracker has its own auth surface (jira: env keys, project
  // key, live probe) — the forge rows above don't cover it. A Jira BOARD
  // needs the same surface even when the tracker is native, but never
  // duplicate the rows when both point at Jira.
  if (tracker !== forge) for (const r of tracker.authCheck()) check(r.level, r.name, r.detail);
  else if (cfg.board?.jira) for (const r of jiraTracker({ cfg, env }).authCheck()) check(r.level, r.name, r.detail);
  // The NATIVE tracker's own auth row above says nothing about whether the
  // repo's issue tracker is even turned on — probe it (forge.mjs).
  if (tracker === forge && forgeBin) {
    const r = nativeTrackerCheck(forge);
    check(r.level, r.name, r.detail);
  }

  // 8. timers active + linger (Linux)
  if (process.platform === "linux" && resolveCmd("systemctl")) {
    const timers = units.filter((u) => u.f.endsWith(".timer")).map((u) => u.f);
    if (!timers.length) check("skip", "systemd timers", "no timer file references this project");
    else if (cfg.enabled === false) {
      check("skip", "systemd timers", `factory disabled — ${timers.length} timer(s) may be active or not; fires exit silently`);
    } else {
      const listed = sh("systemctl", ["--user", "list-timers", "--all", "--no-pager", "--no-legend"]).out ?? "";
      const dead = timers.filter((t) => !listed.includes(t));
      check(dead.length ? "fail" : "ok", "systemd timers", dead.length ? `${dead.join(", ")} not scheduled — systemctl --user enable --now <timer>` : timers.join(", "));
    }
    const linger = sh("loginctl", ["show-user", os.userInfo().username, "--property=Linger"]).out ?? "";
    check(linger.includes("Linger=yes") ? "ok" : "warn", "linger",
      linger.includes("Linger=yes") ? "enabled" : "user units stop at logout — loginctl enable-linger");
  } else check("skip", "systemd timers", "not Linux/systemd");

  // 9. docker when the project uses compose
  const compose = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"].find((f) => fs.existsSync(path.join(project, f)));
  if (compose) {
    const d = sh("docker", ["info"]);
    check(d.out !== null ? "ok" : "fail", `docker (${compose} present)`, d.out !== null ? "daemon reachable" : d.err);
  } else check("skip", "docker", "no compose file");

  // 10. plan freshness (missing is fine — the next dev window re-triages first)
  const planD = readJson(path.join(stateD, "plan.json"));
  if (!planD) check("skip", "plan.json", "none — next dev window triages first");
  else {
    const fresh = planD.generatedAt && Date.now() - Date.parse(planD.generatedAt) < 24 * 3600 * 1000;
    check(fresh ? "ok" : "warn", "plan.json", fresh ? `${planD.queue?.length ?? 0} task(s) queued` : "stale (>24h) — next dev window re-triages first");
  }

  // 11. dashboard registry
  const reg = readJson(path.join(os.homedir(), ".factory", "registry.json"));
  check(reg?.factories?.[project] ? "ok" : "warn", "dashboard registry", reg?.factories?.[project] ? "registered" : "not in ~/.factory/registry.json — re-run init.mjs (or factory.mjs migrate) to register it");

  // 11b. enabled — the declared OFF switch (NOTES item 47). All three
  //      operational states (scheduled, manual-only, disabled) are
  //      legitimate and doctor-green; a missing or malformed value fails.
  //      Read the RAW file: cfg merges CONFIG_DEFAULTS, which would mask a
  //      missing key as `true` — the one declared-state drift this check
  //      exists to catch.
  const rawEnabled = readJson(path.join(stateD, "config.json"))?.enabled;
  if (typeof rawEnabled !== "boolean") {
    check("fail", "enabled", `config.json must declare "enabled": true|false (got ${JSON.stringify(rawEnabled)})`);
  } else {
    check("ok", "enabled", rawEnabled ? "active" : "DISABLED — dev/triage/report refuse; scheduled fires exit silently");
  }

  // 12. schedule contract (NOTES item 25) — "no independent runs" must be a
  //     DECLARED state (schedule: "manual"), never an accident. Drift fails
  //     in both directions: declared-but-missing and installed-but-undeclared.
  //     Since P3 the declaration can carry times/days/timezone (block form);
  //     the legacy kind-only string stays valid until the factory adopts.
  {
    const decl = normalizeSchedule(cfg.schedule);
    const installed = [];
    if (installedSched.systemd.some((a) => a.name.endsWith(".timer"))) installed.push("systemd");
    if (installedSched.cron.length) installed.push("cron");
    if (installedSched.launchd.length) installed.push("launchd");
    if (!decl) {
      check("fail", "schedule declared", `config.json has no "schedule" — declare one of ${SCHEDULE_KINDS.join("|")} (manual = no independent runs, on purpose)`);
    } else if (!SCHEDULE_KINDS.includes(decl.kind)) {
      check("fail", "schedule declared", `"${decl.kind}" is not one of ${SCHEDULE_KINDS.join("|")}`);
    } else if (decl.kind === "manual") {
      check(installed.length ? "fail" : "ok", "schedule: manual",
        installed.length ? `declared manual but ${installed.join("+")} scheduler(s) reference this project — remove them or declare the real schedule` : "no independent runs (declared)");
    } else {
      const present = installed.includes(decl.kind);
      const extras = installed.filter((k) => k !== decl.kind);
      // Declared-but-missing artifacts on a DISABLED factory are dormant
      // drift, not an active failure — the factory can't run anyway. Warn
      // so it's fixed before re-enabling instead of blocking updates now.
      check(present ? "ok" : cfg.enabled === false ? "warn" : "fail", `schedule: ${decl.kind}`,
        present ? `installed${extras.length ? ` (also found: ${extras.join("+")} — remove the extra)` : ""}`
                : `declared but nothing installed — ${cfg.enabled === false ? "dormant while disabled; fix before re-enabling" : "the factory will NEVER run on its own"}${extras.length ? ` (found ${extras.join("+")} instead)` : ""}`);
      if (present && extras.length) check("fail", "schedule drift", `${extras.join("+")} scheduler(s) also reference this project — one scheduler per factory`);
      // 12c. semantic drift (P3) — installed units must fire exactly what
      //      the declaration says: schedule (time/days/tz) and contract
      //      (machine-runtime exec, --scheduled, a PATH line). PATH content
      //      is deliberately NOT compared — hand-tuned unit PATHs are legal;
      //      check 2 already proves claude/gh resolve under them.
      if (present) {
        if (!decl.modes) {
          check("warn", "schedule matches declaration",
            "declaration is kind-only (no times) — `schedule --adopt` imports the installed units into machine config");
        } else {
          const bad = validateDeclaration(decl);
          const mismatches = bad.length ? bad : compareInstalled(decl, installedSched[decl.kind], { project, runtimeDriver: RUNTIME_DRIVER });
          check(mismatches.length ? "fail" : "ok", "schedule matches declaration",
            mismatches.length ? mismatches.slice(0, 4).join("; ") + (mismatches.length > 4 ? ` (+${mismatches.length - 4} more)` : "")
                              : "installed units fire what config.json declares");
        }
      }
    }
  }

  // 12b. schedulers must exec the machine runtime (O6) — a unit, cron line,
  //      plist, or generated file still pointing at the deleted per-project
  //      driver is a half-migrated factory whose timers will fire into
  //      nothing (or into a stale v3 copy).
  {
    const legacyDriver = path.join(project, ".factory", "driver.mjs");
    const texts = [];
    const sdir = path.join(dataDir, "schedulers");
    if (fs.existsSync(sdir)) {
      for (const f of fs.readdirSync(sdir)) {
        try { texts.push([`.factory/schedulers/${f}`, fs.readFileSync(path.join(sdir, f), "utf8")]); } catch { /* unreadable */ }
      }
    }
    for (const u of units) texts.push([u.f, u.text]);
    for (const { text } of installedSched.cron) {
      for (const l of text.split("\n")) {
        if (!l.trim().startsWith("#") && l.includes(project)) texts.push(["crontab", l]);
      }
    }
    for (const { name, text } of installedSched.launchd) texts.push([name, text]);
    const legacy = [...new Set(texts.filter(([, t]) => t.includes(legacyDriver)).map(([n]) => n))];
    if (!texts.length) check("skip", "schedulers on runtime", "no scheduler files reference this project");
    else check(legacy.length ? "fail" : "ok", "schedulers on runtime",
      legacy.length ? `legacy per-project driver path in: ${legacy.join(", ")} — reinstall from the declaration: factory.mjs schedule --install`
                    : "all exec the machine runtime");
  }

  // 13. git contract — the repo carries WORK DATA, nothing else: sessions
  //     get allowlist/guard/skills INJECTED into their worktrees from the
  //     runtime (P2), and config and secrets are machine-side. A repo that
  //     still tracks state is un-migrated; secrets in git are always a
  //     failure.
  if (fs.existsSync(path.join(project, ".git"))) {
    const tracked = (rel) => sh("git", ["-C", project, "ls-files", "--error-unmatch", rel]).out !== null;
    const mustTrack = [".factory/backlog/index.md"];
    const untracked = mustTrack.filter((f) => fs.existsSync(path.join(project, f)) && !tracked(f));
    check(untracked.length ? "fail" : "ok", "scaffold committed",
      untracked.length ? `not in git: ${untracked.join(", ")} — work data is the collaboration surface; commit it (check the project .gitignore)` : "work data tracked");
    // Sensor for the input path the docs promise: sessions read work data
    // from the base branch (triage runs in the meta worktree, reset to
    // origin at every boundary), so an uncommitted note/spec/task in the
    // owner's checkout is not late input — it is no input at all, and the
    // next dirty-tree sweep quarantines it out of the tree. Warn, never
    // fail: mid-edit work data is a normal state to be caught in.
    {
      // -uall: without it an untracked directory collapses to one
      // ".factory/inbox/" line and the owner never learns which note.
      const dirty = (sh("git", ["-C", project, "status", "--porcelain", "-uall", "--",
        ".factory/spec", ".factory/backlog", ".factory/inbox"]).out ?? "")
        .split("\n").map((l) => l.trim()).filter(Boolean);
      check(dirty.length ? "warn" : "ok", "work data committed",
        dirty.length
          ? `${dirty.length} uncommitted under .factory/{spec,backlog,inbox} — sessions read the base branch, so these are not input until committed and pushed: ${dirty.slice(0, 3).join("; ")}${dirty.length > 3 ? ", …" : ""}`
          : "nothing uncommitted");
    }
    if (tracked(".factory/config.json")) {
      check("fail", "config in repo", "legacy repo-side config.json — config lives on the machine now; run: factory.mjs migrate --project " + project);
    } else if (fs.existsSync(path.join(dataDir, "config.json"))) {
      check("warn", "config in repo", "stray .factory/config.json on disk (the driver reads the machine copy) — remove it to avoid confusion");
    }
    if (fs.existsSync(path.join(dataDir, ".env"))) {
      check(tracked(".factory/.env") ? "fail" : "warn", ".env in repo", tracked(".factory/.env")
        ? "SECRETS ARE IN GIT — git rm --cached .factory/.env and rotate the tokens"
        : "legacy .factory/.env in the project — secrets live machine-side now; run migrate (or move it) and delete this copy");
    }
    // Runtime state must never be tracked: it is machine-only (and in the
    // meta worktree, a log SYMLINK a pushed commit would loop the fleet on).
    // The tracked-runtime-state shape (fleet, 2026-07-11) — no ignore file, log/ + plan.json
    // committed. Tracked state = fail; a merely missing/partial ignore file
    // = scaffold drift migrate stamps (warn, so a healthy-but-unstamped
    // fleet project still runs its windows).
    const trackedState = [".factory/log", ".factory/plan.json", ".factory/board.json", ".factory/STOP", ".factory/tmp"]
      .filter((rel) => tracked(rel));
    if (trackedState.length) {
      check("fail", "runtime state in git", `${trackedState.join(", ")} tracked — machine-only runtime state; run: factory.mjs migrate --project ${project}`);
    }
    {
      const fgi = path.join(dataDir, ".gitignore");
      const fgiText = fs.existsSync(fgi) ? fs.readFileSync(fgi, "utf8") : "";
      const missing = missingGitignoreEntries(fgiText);
      // The legacy log/ spelling covers directories but not the meta log
      // SYMLINK — drift the same as a missing entry, migrate respells it.
      const misspelled = misspelledGitignoreEntries(fgiText);
      // Legacy transition: state still on disk repo-side with nothing keeping
      // it out of `git add -A` is one command from a leak — that stays a fail.
      const exposed = [".env", "log"].filter((e) => fs.existsSync(path.join(dataDir, e)) && missing.includes(e === "log" ? "log" : ".env"));
      const drift = [...(missing.length ? [`missing ${missing.join(", ")}`] : []), ...(misspelled.length ? [`respell ${misspelled.join(", ")}`] : [])];
      check(exposed.length ? "fail" : drift.length ? "warn" : "ok", ".factory/.gitignore",
        exposed.length ? `repo-side ${exposed.join(", ")} not ignored — one \`git add -A\` from a leak; run migrate`
          : drift.length ? `scaffold drift — ${drift.join("; ")}; run factory.mjs migrate to stamp it`
            : "covers the runtime state");
    }
    // The teammate contract file (team affordances): its absence only costs
    // discoverability, never a window — drift migrate stamps.
    check(fs.existsSync(path.join(dataDir, "README.md")) ? "ok" : "warn", ".factory/README.md",
      fs.existsSync(path.join(dataDir, "README.md"))
        ? "in-repo teammate contract present"
        : "scaffold drift — teammates have no in-repo contract; run factory.mjs migrate to stamp it");
  } else check("skip", "git contract", "not a git repo");

  // 14. backlog format — the status ledger edits Status: lines mechanically,
  //     so the format has to parse (NOTES item 24).
  {
    const tasks = parseBacklogTasks();
    if (!tasks.length) check("warn", "backlog format", "no tasks parsed from .factory/backlog/*.md");
    else {
      const bad = tasks.filter((t) => !BOARD_STATUSES.includes(t.status));
      check(bad.length ? "warn" : "ok", "backlog format",
        bad.length ? `${tasks.length} task(s); off-vocabulary status: ${bad.map((t) => `${t.id}=${t.status}`).join(", ")}` : `${tasks.length} task(s) parse clean`);
    }
  }

  // 14b. milestone headings in backlog/index.md — `promote` flips them and
  //      the dashboard shows the active one, so a heading dialect neither
  //      can read costs both silently. That is exactly what happened: the
  //      index format was never specified, three dialects grew, and 4 of 6
  //      factories read as having no milestones at all (2026-07-19). The
  //      parser tolerates the known dialects; this row catches the NEXT one.
  //      Warn, not fail — a backlog with no milestones is legal.
  {
    const indexPath = path.join(dataDir, "backlog", "index.md");
    const text = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf8") : "";
    const drift = unparsedMilestoneHeadings(text);
    const parsed = parseMilestones(text);
    if (drift.length) {
      check("warn", "milestone headings",
        `${drift.length} heading(s) in backlog/index.md do not parse, so promote and the dashboard cannot see them — use \`## M<n>: <title> — <status>\`: ${drift.map((d) => d.trim()).join(" | ").slice(0, 120)}`);
    } else if (parsed.length) {
      const active = parsed.filter((m) => m.status === "active").map((m) => m.id);
      check("ok", "milestone headings", `${parsed.length} parse clean${active.length ? ` (active: ${active.join(", ")})` : " (none active)"}`);
    } else check("skip", "milestone headings", "backlog/index.md declares no milestones");
  }

  // 14c. Verify-line tiers — the acceptance grader executes each task's
  //      `Verify:` line verbatim, so a line that only re-runs the suite (or
  //      repeats gateCommand — the gate already runs that on the merged
  //      tree) proves nothing beyond the diff: it grades the code, never
  //      the task. Warn, never fail: triage's prompt carries this same lint
  //      and fixes the lines with its other backlog edits.
  {
    const all = parseBacklogTasks();
    if (!all.length) check("skip", "Verify lines", "no tasks");
    else {
      const flagged = lintVerify(all, cfg.gateCommand);
      check(flagged.length ? "warn" : "ok", "Verify lines",
        flagged.length
          ? `${flagged.length} non-done task(s) whose Verify/acceptance won't hold the grader to the task — missing, suite-only, skipping the engine tests the acceptance names, or vague acceptance wording; triage should fix them: ${flagged.map((t) => `${t.id}=${t.tier}`).join(", ").slice(0, 120)}`
          : "none flagged (missing, suite-only, engine cross-check, or vague wording)");
    }
  }

  // 15. auto-merge needs verification — with no checks AND no gateCommand the
  //     gate refuses to merge, so this state means the factory silently stops
  //     shipping (fleet incident 2026-07-07: 12 sessions merged into dev
  //     totally ungated; 2026-07-23: live Bitbucket factories, zero CI).
  if ((cfg.autonomy ?? "").startsWith("auto-merge") || cfg.autonomy === "milestone-gates") {
    const wf = path.join(project, ".github", "workflows");
    const hasCi = fs.existsSync(wf) && fs.readdirSync(wf).some((f) => /\.ya?ml$/.test(f));
    const hasSuite = Boolean(cfg.gateCommand);
    check(hasCi || hasSuite ? "ok" : "fail", "CI under auto-merge",
      hasCi ? `workflows present${hasSuite ? " + gateCommand" : ""}`
        : hasSuite ? `gateCommand: ${cfg.gateCommand}`
          : "no CI and no gateCommand — the gate refuses to auto-merge; add workflows or set gateCommand in config.json");
  }

  // 16. risk tiers must be well-formed — the gate reads a malformed shape as
  //     empty, so a config typo (wrong value type OR a misspelled key, which
  //     the shallow config merge lets replace the default wholesale) would
  //     silently turn the safety floor OFF.
  if (cfg.riskTiers !== undefined) {
    const rt = cfg.riskTiers;
    const high = rt?.high;
    const wellFormed = rt === null || (typeof rt === "object" && !Array.isArray(rt) &&
      Object.keys(rt).every((k) => k === "high") &&
      (high === undefined || (Array.isArray(high) && high.every((p) => typeof p === "string" && p))));
    check(wellFormed ? (Array.isArray(high) && high.length ? "ok" : "skip") : "fail", "risk tiers",
      !wellFormed ? `riskTiers is malformed — expected { high: ["path/prefix/", …] } and no other keys; until fixed the risk floor is OFF`
        : Array.isArray(high) && high.length ? `${high.length} high-risk prefix(es) park PRs for owner review`
          : "no high-risk prefixes declared");
  }

  // 17. toolchain manifest — `toolchain: [{name, check}]` declares the tools
  //     this project's sessions depend on; each check runs here and a red row
  //     means the tool is missing. Scheduled runs abort on doctor fails, so
  //     this row IS the preflight that stops a window before it burns
  //     sessions against a missing tool. Malformed = fail, like riskTiers: a
  //     typo must never silently turn the preflight off.
  if (cfg.toolchain !== undefined) {
    const tc = cfg.toolchain;
    const wellFormed = Array.isArray(tc) && tc.every((t) => t !== null && typeof t === "object" && !Array.isArray(t) &&
      typeof t.name === "string" && t.name && typeof t.check === "string" && t.check);
    if (!wellFormed) {
      check("fail", "toolchain", `toolchain is malformed — expected [{name, check}, …] with non-empty strings; until fixed the preflight is OFF`);
    } else {
      for (const t of tc) {
        const r = spawnSync(t.check, { shell: true, cwd: project, timeout: 30_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        const ok = r.status === 0;
        const failLine = ok ? null : firstLine(r.error ?? { stderr: r.stderr, stdout: r.stdout, message: `exit ${r.status}` });
        check(ok ? "ok" : "fail", `toolchain: ${t.name}`,
          ok ? t.check : `\`${t.check}\` failed — ${failLine}; sessions depending on ${t.name} would burn for nothing`);
      }
    }
  }

  // 18. injection surface — under auto-merge, a publicly writable tracker
  //     feeds anyone's text into triage prompts. The posture (forge-inputs
  //     trust labels) marks it UNTRUSTED, but a private tracker removes the
  //     surface entirely; the owner should know it exists. Warn, not fail.
  if ((cfg.autonomy ?? "").startsWith("auto-merge") || cfg.autonomy === "milestone-gates") {
    let pub = null;
    try { pub = (cfg.tracker ?? "github") === "jira" ? false : forge.repoIsPublic(); } catch { pub = null; }
    if (pub === null) check("skip", "injection surface", "repo visibility unprobeable — check yourself whether the tracker is publicly writable");
    else check(pub ? "warn" : "ok", "injection surface",
      pub ? "auto-merge + publicly writable tracker: anyone's issues/comments reach triage prompts (tagged UNTRUSTED there) — consider a private tracker"
        : "tracker is not publicly writable");
  }

  return results;
};
