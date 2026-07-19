// Schedule engine (P3, machine-product refactor). The declaration — kind +
// timezone + per-mode time/days — lives in machine config (config.json
// "schedule"); this module turns it into scheduler artifacts and back:
//
//   generateUnits    declaration -> unit files (systemd/cron/launchd)
//   parseInstalled   installed artifacts -> declaration (schedule --adopt)
//   compareInstalled declaration vs installed, semantically (doctor drift)
//
// Pure: no filesystem, no process state — callers pass paths in and install
// the results. Shared by factory.mjs (schedule mode, doctor) and init.mjs
// (declaration from wizard answers), so generation and verification can
// never drift apart.

export const SCHEDULE_KINDS = ["systemd", "cron", "launchd", "manual"];
export const SCHEDULE_MODES = ["triage", "dev", "report"];

// Mon-first (ISO) everywhere a human reads days; converters map to each
// scheduler's own numbering (cron/launchd count Sun=0).
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SUNDAY_FIRST = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const dayIndex = (name) => {
  const i = DAY_NAMES.findIndex((d) => d.toLowerCase() === String(name).toLowerCase().slice(0, 3));
  if (i === -1) throw new Error(`unknown day "${name}"`);
  return i;
};

// "Mon-Fri", "Mon,Wed,Fri", "Mon-Wed,Sat" (also accepts systemd's "Mon..Fri")
// -> canonical Mon-first array of day names.
export const parseDaysSpec = (spec) => {
  const parts = String(spec ?? "").replace(/\.\./g, "-").split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error(`empty days spec "${spec}"`);
  const set = new Set();
  for (const part of parts) {
    const [a, b, extra] = part.split("-");
    if (extra !== undefined) throw new Error(`bad days spec "${part}"`);
    if (b === undefined) {
      set.add(dayIndex(a));
      continue;
    }
    const from = dayIndex(a), to = dayIndex(b);
    if (from > to) throw new Error(`wrapping day range "${part}" is not supported — list the days instead`);
    for (let i = from; i <= to; i++) set.add(i);
  }
  return DAY_NAMES.filter((_, i) => set.has(i));
};

// Canonical rendering: contiguous runs become "A-B", the rest a comma list.
export const formatDaysSpec = (days) => {
  const idx = days.map(dayIndex).sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1] === idx[j] + 1) j++;
    parts.push(j > i ? `${DAY_NAMES[idx[i]]}-${DAY_NAMES[idx[j]]}` : DAY_NAMES[idx[i]]);
    i = j + 1;
  }
  return parts.join(",");
};

const normTime = (t) => {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(t).trim());
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
};

// config.json "schedule" is either the legacy string (kind only — times were
// never declared machine-side before P3) or the full block. Both normalize
// to { kind, timezone, modes }; modes === null means "no times declared".
export const normalizeSchedule = (raw) => {
  if (raw == null) return null;
  if (typeof raw === "string") return { kind: raw, timezone: null, modes: null };
  return { kind: raw.kind ?? null, timezone: raw.timezone ?? null, modes: raw.modes ?? null };
};

export const validateDeclaration = (decl) => {
  const problems = [];
  if (!SCHEDULE_KINDS.includes(decl.kind)) {
    problems.push(`kind "${decl.kind}" is not one of ${SCHEDULE_KINDS.join("|")}`);
  }
  if (decl.timezone) {
    try { new Intl.DateTimeFormat("en", { timeZone: decl.timezone }); }
    catch { problems.push(`timezone "${decl.timezone}" is not a valid IANA zone (e.g. Europe/Lisbon)`); }
  }
  for (const [mode, spec] of Object.entries(decl.modes ?? {})) {
    if (!SCHEDULE_MODES.includes(mode)) {
      problems.push(`"${mode}" is not a schedulable mode (${SCHEDULE_MODES.join("|")})`);
      continue;
    }
    if (!normTime(spec?.time)) problems.push(`${mode}: time "${spec?.time}" is not HH:MM`);
    else if (Number(spec.time.split(":")[0]) > 23 || Number(spec.time.split(":")[1]) > 59) {
      problems.push(`${mode}: time "${spec.time}" is not a valid clock time`);
    }
    try { parseDaysSpec(spec?.days); }
    catch (e) { problems.push(`${mode}: days "${spec?.days}" — ${e.message}`); }
  }
  return problems;
};

// The block init writes into machine config from its wizard answers.
// Timezone is deliberately omitted: absent = the machine's own timezone.
export const declarationFromAnswers = (a) => {
  if (a.schedule === "manual") return { kind: "manual" };
  const days = a.workDays ?? "Mon-Fri";
  return {
    kind: a.schedule,
    modes: {
      triage: { time: a.triageTime, days },
      dev: { time: a.devTime, days },
      report: { time: a.reportTime, days },
    },
  };
};

const toSystemdDays = (days) => formatDaysSpec(days).replace(/-/g, "..");
const toCronDays = (days) => {
  if (days.length === 7) return "*";
  const idx = days.map((d) => SUNDAY_FIRST.indexOf(d)).sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1] === idx[j] + 1) j++;
    parts.push(j > i ? `${idx[i]}-${idx[j]}` : String(idx[i]));
    i = j + 1;
  }
  return parts.join(",");
};
const toLaunchdDays = (days) => days.map((d) => SUNDAY_FIRST.indexOf(d)).sort((a, b) => a - b);

const declaredModes = (decl) => SCHEDULE_MODES.filter((m) => decl.modes?.[m]);

// declaration -> { files: {name: content}, notes: [] }. Pure — the caller
// owns install locations and side effects.
export const generateUnits = (decl, ctx) => {
  const { project, projectName, stateDir, runtimeDriver, nodeBin, windowHours, pathLine } = ctx;
  const files = {};
  const notes = [];
  const modes = declaredModes(decl).map((m) => ({
    mode: m,
    time: normTime(decl.modes[m].time),
    days: parseDaysSpec(decl.modes[m].days),
  }));

  if (decl.kind === "systemd") {
    files[`${projectName}-factory@.service`] = `[Unit]
Description=Factory %i run (${projectName})
# Dumb outer net (O6): if this unit fails in any way — including a runtime
# too broken to reach its own Telegram code — a plain-curl notifier fires.
# %n = this unit's full name, so the notifier's journalctl hint is exact.
OnFailure=factory-onfailure@%n.service

[Service]
Type=oneshot
WorkingDirectory=${project}
# systemd user services get a minimal PATH (no ~/.local/bin, no .bashrc) —
# NOTES item 10: without this, timer runs die with "spawn claude ENOENT".
Environment=PATH=${pathLine}
ExecStart=${nodeBin} ${runtimeDriver} %i --project ${project} --scheduled
TimeoutStartSec=${Math.max(Number(windowHours) * 2, 8)}h
`;
    for (const { mode, time, days } of modes) {
      files[`${projectName}-${mode}.timer`] = `[Unit]
Description=Factory ${mode} schedule (${projectName})

[Timer]
OnCalendar=${toSystemdDays(days)} ${time}${decl.timezone ? ` ${decl.timezone}` : ""}
Persistent=false
Unit=${projectName}-factory@${mode}.service

[Install]
WantedBy=timers.target
`;
    }
  } else if (decl.kind === "cron") {
    const lines = modes.map(({ mode, time, days }) => {
      const [h, m] = time.split(":").map(Number);
      return `${m} ${h} * * ${toCronDays(days)} ${nodeBin} ${runtimeDriver} ${mode} --project ${project} --scheduled >> ${stateDir}/log/cron.out 2>&1`;
    });
    // CRON_TZ and PATH apply to every entry BELOW them in the crontab, so
    // the install step keeps this block at the end of the file.
    files["crontab-block"] = `# BEGIN factory ${project} (managed by factory.mjs schedule — do not edit inside)
${decl.timezone ? `CRON_TZ=${decl.timezone}\n` : ""}PATH=${pathLine}
${lines.join("\n")}
# END factory ${project}`;
  } else if (decl.kind === "launchd") {
    for (const { mode, time, days } of modes) {
      const [h, m] = time.split(":").map(Number);
      const label = `com.factory.${projectName}.${mode}`;
      const cal = toLaunchdDays(days).map((d) =>
        `        <dict><key>Weekday</key><integer>${d}</integer><key>Hour</key><integer>${h}</integer><key>Minute</key><integer>${m}</integer></dict>`).join("\n");
      files[`${label}.plist`] = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${label}</string>
    <key>ProgramArguments</key>
    <array><string>${nodeBin}</string><string>${runtimeDriver}</string><string>${mode}</string><string>--project</string><string>${project}</string><string>--scheduled</string></array>
    <key>StartCalendarInterval</key>
    <array>
${cal}
    </array>
    <key>WorkingDirectory</key><string>${project}</string>
    <key>StandardOutPath</key><string>${stateDir}/log/launchd-${mode}.out</string>
    <key>StandardErrorPath</key><string>${stateDir}/log/launchd-${mode}.err</string>
    <key>EnvironmentVariables</key>
    <dict><key>PATH</key><string>${pathLine}</string></dict>
</dict>
</plist>
`;
    }
    if (decl.timezone) {
      notes.push(`launchd fires in the SYSTEM timezone — the declared ${decl.timezone} cannot be applied per-job; set the machine's timezone or switch to cron`);
    }
  } else {
    notes.push(`kind "${decl.kind}" has no generated files`);
  }
  return { files, notes };
};

// Supervisor daemon unit (PR-D): machine-level, one per machine, no project.
// The OS keeps it alive (systemd Restart=always / launchd KeepAlive) — a
// supervisor that dies silently is the exact failure it exists to prevent.
// Only kinds with a keep-alive process manager can host it; cron/manual get
// a note instead of files.
export const generateSupervisorUnits = (kind, ctx) => {
  const { runtimeSupervisor, nodeBin, pathLine, logDir } = ctx;
  const files = {};
  const notes = [];
  if (kind === "systemd") {
    files["factory-supervisor.service"] = `[Unit]
Description=Factory fleet supervisor (hung-window killer, relaunch directives, escalations)
# Dumb outer net (O6): fires when restarts give up (start-limit), so a
# supervisor stuck in a crash loop still reaches the phone. The explicit
# start-limit matters: with Restart=always and systemd's default 10s burst
# window, RestartSec=10 restarts would never trip it and OnFailure would
# never fire.
OnFailure=factory-onfailure@%n.service
StartLimitIntervalSec=600
StartLimitBurst=5

[Service]
Environment=PATH=${pathLine}
ExecStart=${nodeBin} ${runtimeSupervisor}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
  } else if (kind === "launchd") {
    files["com.factory.supervisor.plist"] = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.factory.supervisor</string>
    <key>ProgramArguments</key>
    <array><string>${nodeBin}</string><string>${runtimeSupervisor}</string></array>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key><string>${logDir}/launchd.out</string>
    <key>StandardErrorPath</key><string>${logDir}/launchd.err</string>
    <key>EnvironmentVariables</key>
    <dict><key>PATH</key><string>${pathLine}</string></dict>
</dict>
</plist>
`;
  } else {
    notes.push(`kind "${kind}" has no keep-alive process manager — the supervisor needs systemd or launchd`);
  }
  return { files, notes };
};

const modeFromText = (s) => SCHEDULE_MODES.find((m) => new RegExp(`[@./ "']${m}(?:\\.|['" ]|$)`).test(s));

// installed artifacts ([{name, text}]) -> { decl, problems }. Best-effort by
// design: anything it cannot read verbatim becomes a problem naming the
// artifact, never a guessed value — adopt must import reality or say why not.
export const parseInstalled = (kind, artifacts, ctx) => {
  const problems = [];
  const modes = {};
  const timezones = new Set();

  if (kind === "systemd") {
    for (const { name, text } of artifacts) {
      if (!name.endsWith(".timer")) continue;
      const mode = modeFromText(text.match(/^Unit=(.+)$/m)?.[1] ?? "") ?? modeFromText(name);
      if (!mode) { problems.push(`${name}: cannot infer which factory mode this timer fires`); continue; }
      const cal = text.match(/^OnCalendar=(.+)$/m)?.[1]?.trim();
      if (!cal) { problems.push(`${name}: no OnCalendar line`); continue; }
      const tokens = cal.split(/\s+/);
      let daysTok = null, timeTok = null, tzTok = null;
      if (normTime(tokens[0])) [timeTok, tzTok] = tokens;
      else [daysTok, timeTok, tzTok] = tokens;
      const time = normTime(timeTok ?? "");
      let days = null;
      try {
        days = daysTok === null || daysTok === "*-*-*" ? [...DAY_NAMES] : parseDaysSpec(daysTok);
      } catch { /* reported below */ }
      if (!time || !days) { problems.push(`${name}: OnCalendar "${cal}" is not a plain weekday+time schedule — adopt it by hand with --declare`); continue; }
      modes[mode] = { time, days: formatDaysSpec(days) };
      if (tzTok) timezones.add(tzTok);
    }
  } else if (kind === "launchd") {
    for (const { name, text } of artifacts) {
      const mode = modeFromText(text.match(/<key>Label<\/key><string>([^<]+)<\/string>/)?.[1] ?? "") ?? modeFromText(name);
      if (!mode) { problems.push(`${name}: cannot infer which factory mode this job runs`); continue; }
      const entries = [...text.matchAll(/<key>Weekday<\/key><integer>(\d+)<\/integer><key>Hour<\/key><integer>(\d+)<\/integer><key>Minute<\/key><integer>(\d+)<\/integer>/g)];
      if (!entries.length) { problems.push(`${name}: no Weekday/Hour/Minute calendar entries found`); continue; }
      const times = new Set(entries.map(([, , h, m]) => `${h.padStart(2, "0")}:${m.padStart(2, "0")}`));
      if (times.size > 1) { problems.push(`${name}: mixed fire times ${[...times].join(", ")} — adopt it by hand with --declare`); continue; }
      const days = entries.map(([, wd]) => SUNDAY_FIRST[Number(wd)]).filter(Boolean);
      modes[mode] = { time: [...times][0], days: formatDaysSpec(days) };
    }
  } else if (kind === "cron") {
    for (const { text } of artifacts) {
      for (const line of text.split("\n")) {
        const tz = line.match(/^\s*CRON_TZ=(\S+)/)?.[1];
        if (tz) timezones.add(tz);
        const m = /^\s*(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+([\d,*-]+)\s+(.+)$/.exec(line);
        if (!m) continue;
        const [, min, hour, dow, cmd] = m;
        if (!new RegExp(`--project ${ctx.project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(cmd)) continue;
        const mode = SCHEDULE_MODES.find((k) => new RegExp(`\\s${k}\\s+--project\\b`).test(cmd));
        if (!mode) { problems.push(`crontab: cannot infer the factory mode of: ${line.trim()}`); continue; }
        let days;
        try {
          days = dow === "*" ? [...DAY_NAMES]
            : dow.split(",").flatMap((part) => {
              const [a, b] = part.split("-").map(Number);
              const span = b === undefined ? [a] : Array.from({ length: b - a + 1 }, (_, i) => a + i);
              return span.map((n) => {
                if (!(n >= 0 && n <= 7)) throw new Error(`day ${n}`);
                return SUNDAY_FIRST[n % 7];
              });
            });
        } catch {
          problems.push(`crontab: day-of-week "${dow}" is not adoptable: ${line.trim()}`);
          continue;
        }
        modes[mode] = { time: `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`, days: formatDaysSpec(days) };
      }
    }
  } else {
    problems.push(`kind "${kind}" cannot be parsed back into a declaration`);
  }

  if (timezones.size > 1) problems.push(`conflicting timezones across artifacts: ${[...timezones].join(", ")}`);
  const decl = { kind, ...(timezones.size === 1 ? { timezone: [...timezones][0] } : {}), modes };
  return { decl, problems };
};

// Semantic drift check for doctor: declared vs installed, compared as
// schedules (times/days/tz) and contracts (runtime exec line, --scheduled,
// a PATH the timer run will actually get) — never as raw text, so owner
// formatting or a hand-tuned PATH can't false-positive.
export const compareInstalled = (decl, artifacts, ctx) => {
  const mismatches = [];
  const { decl: installed, problems } = parseInstalled(decl.kind, artifacts, ctx);
  mismatches.push(...problems);

  for (const mode of declaredModes(decl)) {
    const want = { time: normTime(decl.modes[mode].time), days: formatDaysSpec(parseDaysSpec(decl.modes[mode].days)) };
    const got = installed.modes[mode];
    if (!got) { mismatches.push(`${mode}: declared ${want.time} ${want.days} but the ${decl.kind} artifact is missing`); continue; }
    if (got.time !== want.time) mismatches.push(`${mode}: installed fires at ${got.time}, declaration says ${want.time}`);
    if (got.days !== want.days) mismatches.push(`${mode}: installed runs ${got.days}, declaration says ${want.days}`);
  }
  for (const mode of Object.keys(installed.modes)) {
    if (!decl.modes?.[mode]) mismatches.push(`${mode}: installed but not declared — adopt it (schedule --adopt) or remove it`);
  }
  // launchd cannot express a timezone at all — generateUnits already
  // surfaces that as a note, so comparing it here would fail forever.
  if (decl.kind !== "launchd" && Object.keys(installed.modes).length) {
    const wantTz = decl.timezone ?? null, gotTz = installed.timezone ?? null;
    if (wantTz !== gotTz) mismatches.push(`timezone: installed ${gotTz ?? "(machine default)"}, declaration says ${wantTz ?? "(machine default)"}`);
  }

  const execProblem = (name, text) => {
    if (!text.includes(ctx.runtimeDriver)) return `${name}: does not exec the machine runtime (${ctx.runtimeDriver})`;
    if (!text.includes("--scheduled")) return `${name}: exec line is missing --scheduled — timer fires would skip the doctor preflight`;
    return null;
  };
  if (decl.kind === "systemd") {
    const services = artifacts.filter((a) => /@\.service$/.test(a.name));
    if (!services.length && declaredModes(decl).length) mismatches.push("service template unit is not installed");
    for (const s of services) {
      const p = execProblem(s.name, s.text.match(/^ExecStart=.*$/m)?.[0] ?? "");
      if (p) mismatches.push(p);
      if (!/^Environment=PATH=.+$/m.test(s.text)) mismatches.push(`${s.name}: no Environment=PATH= line — timer runs get the minimal systemd PATH`);
    }
  } else if (decl.kind === "launchd") {
    for (const a of artifacts) {
      const p = execProblem(a.name, a.text);
      if (p) mismatches.push(p);
      if (!/<key>PATH<\/key>/.test(a.text)) mismatches.push(`${a.name}: no PATH in EnvironmentVariables — timer runs may not find claude/gh`);
    }
  } else if (decl.kind === "cron") {
    for (const { text } of artifacts) {
      for (const line of text.split("\n")) {
        if (!line.includes(`--project ${ctx.project}`) || line.trim().startsWith("#")) continue;
        const p = execProblem("crontab", line);
        if (p) mismatches.push(p);
      }
      if (Object.keys(installed.modes).length && !/^PATH=.+$/m.test(text)) {
        mismatches.push("crontab: no PATH= line — cron runs get the minimal default PATH");
      }
    }
  }
  return [...new Set(mismatches)];
};

// Soonest upcoming fire across a declaration's modes, or null when nothing
// is computable (manual, legacy kind-only, bad time/days/timezone — a broken
// declaration must never break a dashboard render; doctor owns validation).
// The wall-clock math runs in the DECLARED timezone; `at` is the absolute
// instant, so callers format it in whatever zone the viewer sits in. DST
// caveat: a fire across a transition can land an hour off — acceptable for
// a "next window" hint, the scheduler itself is the authority.
const zoneClock = (now, timeZone) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    ...(timeZone ? { timeZone } : {}), weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { day: dayIndex(get("weekday")), min: Number(get("hour")) * 60 + Number(get("minute")) };
};

export const nextFire = (decl, now = new Date()) => {
  if (!decl?.modes) return null;
  let clock;
  try { clock = zoneClock(now, decl.timezone ?? null); } catch { return null; }
  let best = null;
  for (const mode of declaredModes(decl)) {
    const time = normTime(decl.modes[mode].time);
    if (!time) continue;
    let days;
    try { days = new Set(parseDaysSpec(decl.modes[mode].days).map(dayIndex)); } catch { continue; }
    const target = Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    for (let off = 0; off <= 7; off++) {
      if (!days.has((clock.day + off) % 7)) continue;
      const delta = off * 1440 + target - clock.min;
      if (delta < 0) continue; // earlier today — the next declared day wins
      if (!best || delta < best.inMinutes) {
        best = { mode, time, inMinutes: delta, at: new Date(now.getTime() + delta * 60_000).toISOString() };
      }
      break;
    }
  }
  return best;
};

// The PATH baked into generated schedulers — a curated superset of where
// claude/gh/node live on our machines, NEVER the calling shell's PATH.
export const defaultPathLine = (nodeBin, home) =>
  [`${home}/.local/bin`, nodeBin.replace(/\/[^/]+$/, ""), "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"].join(":");
