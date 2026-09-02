// Backlog parsing — milestones and their epics from
// `.factory/backlog/index.md`, and TASK blocks from the per-epic files
// beside it. ONE parser per shape, shared by every consumer (dashboard
// cards, the `promote` verb, doctor's drift row, the driver's task loop).
//
// It lives here because the alternative already cost us: dashboard.mjs and
// factory.mjs each carried their own regex, both assuming `## M1 …`, while
// nothing in the product ever DEFINED the index format — compile-spec tells
// the generator "the format in the backlog skill", and that skill only
// specifies the per-epic TASK block. So setup sessions invented three
// dialects and 4 of 6 fleet factories silently parsed to zero milestones:
// dashboards read "no active milestone" and `promote M2` failed outright
// (2026-07-19).
//
// The canonical shape is now written down (backlog skill, §Index format):
//
//   ## M1: Login & browse — active
//   - [e1-scaffolding](e1-scaffolding.md) — 4 tasks
//
// The parser stays deliberately tolerant of the dialects already on disk —
// these files are owner- and session-authored prose, not generated data, so
// they are read leniently and never rewritten under anyone:
//   `## M1 Foundations — done`                     h2, no colon
//   `### M1: Login & browse — active`              h3, colon
//   `## Milestone 1 — Phase 0: Foundations (active)`  spelled id, ( ) status
// Anything that still fails to parse is surfaced by doctor rather than
// silently dropped — invisibility, not the format itself, was the bug.

import * as fs from "node:fs";
import * as path from "node:path";

// Heading: 2-3 hashes, `M<n>` or `Milestone <n>`, an optional separator,
// then the title. The separator alternatives matter: `M1: Title` uses a
// colon, `Milestone 1 — Title` uses an em-dash for the SAME job the status
// suffix uses one for, so it has to be eaten here or it lands in the title.
const HEADING = /^(#{2,3})[ \t]+M(?:ilestone)?[ \t]*(\d+)[ \t]*[:—–-]?[ \t]*(.*)$/;

// Status suffix, in either dialect. The leading `\s` on the dash form is
// load-bearing: without it a hyphenated title with no status ("## M1
// Multi-player") would read "player" as its status.
const STATUS_DASH = /\s+[—–-][ \t]*([\w-]+)[ \t]*$/;
const STATUS_PAREN = /\s*\([ \t]*([\w-]+)[ \t]*\)[ \t]*$/;

// Headings that smell like milestones: the milestone word (or a bare `M<n>`)
// must OPEN the heading, not merely appear somewhere on it. Anchoring here
// is what keeps ordinary index prose — `## Milestones (3)`,
// `### e1 — Phase 1 scaffolding`, `## Open questions for phase 2` — out of
// the drift row. A row that cries wolf is a row people stop reading, which
// is the exact failure this guard exists to prevent.
const SMELLS_LIKE_MILESTONE = /^#{2,6}[ \t]+(?:milestone|phase|sprint)[ \t]*[\w-]*[ \t]*[:—–-]|^#{2,6}[ \t]+M\d+\b/i;

// The statuses `promote` and the dashboard actually act on. A heading whose
// status is outside this set is as dead as one that does not parse at all —
// see unparsedMilestoneHeadings.
export const MILESTONE_STATUSES = new Set(["active", "not-started", "gated", "done"]);

// One milestone heading → {id, title, status, line, index, statusStart,
// statusEnd}. The status offsets are relative to `line` so `promote` can
// splice the new status in place without re-deriving the dialect.
const parseHeading = (line, index) => {
  const m = HEADING.exec(line);
  if (!m) return null;
  const rest = m[3];
  const restAt = line.length - rest.length; // where group 3 starts within line
  let status = null, statusStart = null, statusEnd = null, title = rest;
  for (const re of [STATUS_DASH, STATUS_PAREN]) {
    const s = re.exec(rest);
    if (!s) continue;
    status = s[1];
    // Offset of the captured token itself, not of the whole suffix match.
    statusStart = restAt + s.index + s[0].indexOf(s[1]);
    statusEnd = statusStart + s[1].length;
    title = rest.slice(0, s.index);
    break;
  }
  return {
    id: `M${m[2]}`,
    title: title.trim(),
    status,
    line,
    index,
    statusStart,
    statusEnd,
    epics: [],
  };
};

// Epic line under a milestone, either dialect:
//   `- [e1-scaffolding](e1-scaffolding.md) — 4 tasks`
//   `- e0-skeleton — 6/6 done`
const EPIC_LINK = /^-[ \t]+\[([^\]]+)\]\(([^)]+)\)[ \t]*(?:[—–-][ \t]*(.*))?$/;
const EPIC_BARE = /^-[ \t]+(\S+)[ \t]*(?:[—–-][ \t]*(.*))?$/;

const parseEpic = (line) => {
  const l = EPIC_LINK.exec(line);
  if (l) return { id: l[1].trim(), file: l[2].trim(), note: (l[3] ?? "").trim() };
  const b = EPIC_BARE.exec(line);
  if (b && /^e\d/i.test(b[1])) return { id: b[1], file: `${b[1]}.md`, note: (b[2] ?? "").trim() };
  return null;
};

// Parse the whole index. Returns milestones in document order; each carries
// the epics listed beneath it.
export const parseMilestones = (text) => {
  const milestones = [];
  let current = null;
  let offset = 0;
  for (const raw of String(text ?? "").split("\n")) {
    // A CRLF file must parse: `.` and `$` never match a trailing \r, so an
    // unstripped line fails every pattern below and the whole index reads as
    // milestone-free. The \r is excluded from `line` but still counted in
    // `offset`, so promote's splice offsets stay true to the original text.
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const ms = parseHeading(line, offset);
    if (ms) { milestones.push(ms); current = ms; }
    else if (current) {
      const e = parseEpic(line);
      if (e) current.epics.push(e);
      // A non-milestone heading closes the current milestone's epic list, so
      // a trailing "## Notes" section can't adopt stray bullets.
      else if (/^#{1,6}[ \t]/.test(line)) current = null;
    }
    offset += raw.length + 1; // +1 for the \n the split consumed
  }
  return milestones;
};

// Headings doctor should complain about: those that look like milestones but
// yield nothing either consumer can act on. That means BOTH the ones the
// heading pattern rejects outright AND the ones it accepts whose status is
// missing or off-vocabulary (`— in progress`, `— **active**`, a closed-ATX
// `— active ##`). Without the second half this check would green-light the
// very failure it exists to catch: promote refusing "missing its status
// suffix" while the dashboard shows no active milestone.
export const unparsedMilestoneHeadings = (text) => {
  const actionable = new Set(
    parseMilestones(text).filter((m) => MILESTONE_STATUSES.has(m.status)).map((m) => m.line)
  );
  return String(text ?? "").split("\n")
    .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))
    .filter((l) => SMELLS_LIKE_MILESTONE.test(l) && !actionable.has(l));
};

// ---------- tasks (the per-epic files beside index.md) ----------
// The TASK block format from the backlog skill:
//
//   ## T-021: Add OAuth login
//   - Status: in-progress
//   - Gate: human (owner reviews the consent screen)
//   - Acceptance:
//     - <observable criterion> (older tasks: inline `- Acceptance: <criterion>`)
//   - Verify: <command(s) that prove it>
//   - Model: opus
//   - Effort: high
//   - Question: https://github.com/o/r/issues/7
//
// factory.mjs and dashboard.mjs each carried a private copy of this parser —
// the exact one-format-two-parsers shape that silently diverged for the
// milestone headings above. Merged here before it bit: the copies already
// disagreed on epic naming (`.md$` anchored vs first-occurrence replace)
// and each read a field the other ignored (Gate: vs Question:).

// Acceptance criteria: the nested-bullet form from the skill, plus the
// inline one-liner older tasks carry (`- Acceptance: it works`). The list is
// what the driver briefs the grader from, so dropping a criterion is a
// fail-open silent-truncation bug — the loop must survive the two shapes
// triage writes routinely: a criterion hard-wrapped across lines (an indented
// non-bullet continuation folds into the criterion above it) and blank lines
// between bullets (skipped, not treated as the end). Only a top-level `-`
// (the next `- Field:`) or unindented prose closes the list.
const parseAcceptance = (block) => {
  const lines = block.split("\n");
  const at = lines.findIndex((l) => /^-[ \t]+Acceptance:/.test(l));
  if (at === -1) return [];
  const acceptance = [];
  const inline = lines[at].replace(/^-[ \t]+Acceptance:/, "").trim();
  if (inline) acceptance.push(inline);
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*$/.test(line)) continue; // a gap between bullets, not the end
    const bullet = line.match(/^[ \t]+-[ \t]+(.*\S)/);
    if (bullet) { acceptance.push(bullet[1].trim()); continue; }
    // Indented non-bullet text is the wrapped tail of the criterion above it.
    if (/^[ \t]+\S/.test(line) && acceptance.length) {
      acceptance[acceptance.length - 1] += ` ${line.trim()}`;
      continue;
    }
    break; // a top-level `- Field:` line or unindented prose ends the list
  }
  return acceptance;
};

// One epic file's text → its tasks. Every field either consumer reads:
// the driver acts on status/gate/model/effort and briefs the acceptance
// grader from acceptance/verify, the dashboard renders
// status/links/model/effort/question.
export const parseTaskFile = (text, epic) => {
  const tasks = [];
  for (const block of String(text ?? "").split(/^## /m).slice(1)) {
    const head = block.match(/^(T-[\w-]+):\s*(.*)/);
    if (!head) continue;
    tasks.push({
      id: head[1],
      title: head[2].trim(),
      status: block.match(/- Status:\s*(\S+)/)?.[1] ?? "todo",
      acceptance: parseAcceptance(block),
      verify: block.match(/^-[ \t]+Verify:[ \t]*(\S.*)/m)?.[1]?.trim() ?? null,
      // `- Gate: human (<reason>)` marks a task whose acceptance needs owner
      // judgment — the merge-gate never auto-merges it on green.
      gate: block.match(/- Gate:\s*human\b/) ? "human" : null,
      epic,
      model: block.match(/- Model:\s*(\S+)/)?.[1] ?? null,
      effort: block.match(/- Effort:\s*(\S+)/)?.[1] ?? null,
      // `- Deps: T-024, T-020` — tasks this one builds on. Read as the task
      // ids anywhere on the line so both list dialects (commas, spaces) and
      // a prose tail parse; the driver's spawn guard refuses a plan entry
      // whose deps aren't done.
      deps: [...(block.match(/^-[ \t]+Deps:[ \t]*(\S.*)/m)?.[1] ?? "").matchAll(/T-[\w-]+/g)].map((x) => x[0]),
      // The issue a session filed for this task (driver writes `- Question:`
      // under the Status line) — the needs-human pill links straight to it.
      // http(s) only: this lands in an href, and backlog files are written
      // by autonomous sessions — a bare \S+ would let a `javascript:` token
      // ride into the owner's click.
      question: block.match(/- Question:\s*(https?:\/\/\S+)/)?.[1] ?? null,
      links: [...block.matchAll(/https?:\/\/\S+/g)].map((x) => x[0].replace(/[).,]$/, "")),
    });
  }
  return tasks;
};

// ---------- Verify-line tiers ----------
// The grader executes a task's `Verify:` line verbatim, so a line that only
// re-runs the test suite proves nothing the merge gate doesn't already prove
// — it grades the diff, never the task (the backlog skill's Verify tiers).
// Classification is deliberately conservative: flag only lines we are SURE
// are weak — missing, or every command a recognizable suite/setup
// invocation. Prose and anything unrecognized pass as "product"; a lint
// that cries wolf is a lint triage stops reading.
//
// Segments are the `&&`/`||`/`;`-separated commands (a single `|` stays
// inside its command — `curl … | grep …` is one probe). Leading env
// assignments and `timeout <n>` are wrappers, not commands: they must not
// rescue `timeout 60 npm test`, and must not hide `timeout 120 godot …`.
const WRAPPER = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+[ \t]+|timeout[ \t]+(?:-\S+[ \t]+)*\d+[smh]?[ \t]+)+/;

const SUITE_RES = [
  /^(?:npm|yarn|pnpm)[ \t]+(?:run[ \t]+)?t(?:est)?\b/,
  /^npx[ \t]+(?:jest|vitest|mocha|ava|tap)\b/,
  /^(?:jest|vitest|mocha|ava|rspec|ctest|tox|pytest)\b/,
  /^node[ \t]+--test\b/,
  /^python3?[ \t]+-m[ \t]+pytest\b/,
  /^(?:go|cargo|dotnet|mvn)[ \t]+test\b/,
  /^make[ \t]+(?:test|check)\b/,
  /^(?:\.\/)?gradlew?[ \t]+(?:test|check)\b/,
  /^rake[ \t]+(?:test|spec)\b/,
  /^bundle[ \t]+exec[ \t]+rspec\b/,
  /^mix[ \t]+test\b/,
];

// Install/chdir preludes: neither proof nor product. A line of ONLY these
// (`npm ci`) proves even less than the suite and lands in the same tier.
// Inert package scripts (`npm run lint`, `npm run build`) sit here too:
// they never drive the product, so they must not buy a suite-only line the
// benefit of the doubt (T-025 — 27 of 321 fleet tasks passed on exactly
// that). Only the named scripts are inert; `e2e`, `smoke`, `start` and any
// other script keep reading as product.
const SETUP_RES = [
  /^cd\b/,
  /^npm[ \t]+(?:ci|i|install)\b/,
  /^(?:npm|yarn|pnpm)[ \t]+run[ \t]+(?:lint|build|typecheck|type-check|format|format:check|check|compile)\b/,
  /^yarn(?:[ \t]+install)?$/,
  /^pnpm[ \t]+(?:i|install)\b/,
  /^pip3?[ \t]+install\b/,
  /^python3?[ \t]+-m[ \t]+pip[ \t]+install\b/,
  /^dotnet[ \t]+restore\b/,
  /^bundle(?:[ \t]+install)?$/,
  /^composer[ \t]+install\b/,
];

const norm = (s) => s.trim().replace(/\s+/g, " ");
const segments = (line) => line.split(/&&|\|\||;/).map(norm).filter(Boolean);

// One Verify line → "missing" | "suite" | "product". `gateCommand` is the
// project's merge-gate suite: its segments count as suite runs whatever they
// look like — the gate already runs them on the merged tree, so a Verify
// line repeating the gateCommand adds nothing (FACTORY.md, its config row).
export const verifyTier = (verify, gateCommand = null) => {
  const line = norm(String(verify ?? ""));
  if (!line) return "missing";
  const gateSegs = new Set(gateCommand ? segments(String(gateCommand)) : []);
  for (const seg of segments(line)) {
    const cmd = seg.replace(WRAPPER, "");
    if (gateSegs.has(seg) || gateSegs.has(cmd)) continue;
    // A parenthetical mid-segment (`dotnet test (serialization, 409 path)`)
    // is prose describing evidence, not a shell command — triage writes
    // these as briefs for engine tests the task will CREATE, so they can't
    // be verbatim-executable yet. Prose keeps the benefit of the doubt
    // even when it opens with a suite token.
    if (/\s\(/.test(cmd)) return "product";
    if (SUITE_RES.some((re) => re.test(cmd)) || SETUP_RES.some((re) => re.test(cmd))) continue;
    return "product"; // one unrecognized command = benefit of the doubt
  }
  return "suite"; // every command a suite/setup/gate run — nothing drove the product
};

// ---------- Acceptance↔Verify cross-check (the split-tier trap, NOTES item 69) ----------
// In a split-tier engine project (godot/unity skill: keep the game project
// out of the root solution so the plain suite stays engine-free), a Verify
// line can drive the product AND run a suite yet still never execute the
// tests its own acceptance names — bare `dotnet test` reads as "the tests
// ran" while silently skipping the engine tier. The solo tier check can't
// see it: the line looks product-tier. So when an acceptance criterion
// couples a test reference with an engine marker, the Verify line must
// couple a test invocation with engine/target scoping somewhere.
//
// Same conservatism as verifyTier, applied edge by edge:
// - acceptance fires only when ONE criterion holds both signals — a test
//   mention in one bullet and a scene in another prove nothing together;
// - "engine"/"headless"/"scene" alone are NOT acceptance markers (rules
//   engines, headless browsers); the `engine test` bigram is;
// - verify side, a test token next to an engine token OR any path argument
//   passes — a scoped target (`dotnet test game/X.csproj`, `pytest
//   tests/engine/`) is the author's deliberate choice the lint can't
//   second-guess — and a `cd` prelude plus a test token anywhere passes too;
// - gateCommand segments never rescue: in the proven incident the gate
//   suite WAS the engine-free tier.
const ACCEPT_TEST_RE = /\btests?\b/i;
const ACCEPT_ENGINE_RE = /\b(?:godot|unity|gdunit4?|gut|autoload|prefab)\b|res:\/\/|\.tscn\b|\.tres\b|engine[- ]tests?\b|in-engine\b/i;
const VERIFY_ENGINE_RE = /\b(?:godot|unity|gdunit4?|gut|engine)\b|res:\/\//i;

const acceptanceNamesEngineTests = (acceptance) =>
  (acceptance ?? []).some((c) => ACCEPT_TEST_RE.test(c) && ACCEPT_ENGINE_RE.test(c));

const invokesEngineTests = (verify) => {
  const segs = segments(norm(String(verify ?? ""))).map((s) => s.replace(WRAPPER, ""));
  const hasTest = (s) => /test/i.test(s);
  if (segs.some((s) => hasTest(s) && (VERIFY_ENGINE_RE.test(s) || s.includes("/")))) return true;
  return segs.some((s) => /^cd[ \t]+\S/.test(s)) && segs.some(hasTest);
};

// ---------- vague-acceptance check (the strictness dial) ----------
// The grader judges each criterion AS WRITTEN, so wording is the strictness
// setting (grader battery 2026-08-01: borderline PRs graded lenient 2-in-3
// until the criterion said "byte length" literally). A mood adjective with
// no measurable anchor delegates strictness to per-run grader mood. Same
// conservatism as the tiers above: flag only when BOTH hold — adjective
// present AND no anchor. Anchors are generous on purpose: any number, any
// backticked token, any path, or a comparison verb keeps the benefit of
// the doubt ("matching `wc -w`" passes; "handles errors gracefully" flags).
// Hyphenated compounds are not the adjective ("fast-forward" ≠ "fast").
const VAGUE_ADJ_RE = /(?<!-)\b(?:graceful(?:ly)?|correct(?:ly)?|robust(?:ly)?|proper(?:ly)?|appropriate(?:ly)?|reliab(?:le|ly)|seamless(?:ly)?|smooth(?:ly)?|efficient(?:ly)?|intuitive(?:ly)?|user-friendly|fast|quick(?:ly)?)\b(?!-)/i;
const MEASURABLE_ANCHOR_RE = /\d|`|\/|\b(?:match(?:es|ing)?|equals?|identical to|same as)\b/i;

// First criterion that flags, or null — the lint reports one per task.
export const vagueCriterion = (acceptance) =>
  (acceptance ?? []).find((c) => VAGUE_ADJ_RE.test(c) && !MEASURABLE_ANCHOR_RE.test(c)) ?? null;

// The lint doctor and triage consume: non-done tasks whose Verify line the
// tier check is sure about. Done tasks already shipped — their weak lines
// are history, not work. With `indexText`, the feed is also scoped to
// ACTIVE milestones (owner ruling, T-044): a not-started milestone's lines
// get their look at promote time, and 84 of 91 fleet hits sat there —
// noise for a triage that cannot finish the list. blocked/needs-human stay
// IN: their blocks are still editable and their work is near-term. Solo
// tier first; only lines that pass it get the acceptance cross-check (tier
// "engine"), then the wording check (tier "vague", which alone carries the
// offending `criterion`) — one report per task, the more fundamental
// defect wins.
export const lintVerify = (tasks, gateCommand = null, indexText = null) => {
  const inactive = indexText == null ? new Map() : inactiveEpics(indexText);
  return tasks
    .filter((t) => t.status !== "done" && !inactive.has(t.epic))
    .map((t) => {
      let tier = verifyTier(t.verify, gateCommand);
      let criterion = null;
      if (tier === "product" && acceptanceNamesEngineTests(t.acceptance) && !invokesEngineTests(t.verify)) tier = "engine";
      else if (tier === "product" && (criterion = vagueCriterion(t.acceptance))) tier = "vague";
      const entry = { id: t.id, epic: t.epic, status: t.status, verify: t.verify ?? null, tier };
      return criterion ? { ...entry, criterion } : entry;
    })
    .filter((t) => t.tier !== "product");
};

// Epics of every non-active milestone, keyed by epic id (file base name),
// each mapped to its milestone's {id, status}. Fail-open, same semantics as
// the dev plan's milestone guard: no active milestone anywhere (statusless
// dialects) = no signal, empty map; unparseable text = empty map; an epic
// listed under no milestone never appears, so it always passes.
export const inactiveEpics = (indexText) => {
  try {
    const ms = parseMilestones(indexText);
    if (!ms.some((m) => m.status === "active")) return new Map();
    const out = new Map();
    for (const m of ms) {
      if (m.status === "active" || !m.status) continue;
      for (const e of m.epics) out.set(epicKey(e.file), { id: m.id, status: m.status });
    }
    return out;
  } catch { return new Map(); }
};

// An epic's key: its file's base name. Tasks carry it as `epic`, milestone
// entries carry the file — this is the ONE join between them, so the strip
// lives once (two private copies of it already diverged before this module
// existed; see the header).
export const epicKey = (file) => file.replace(/\.md$/, "");

// Every task in a backlog directory. index.md holds milestones, never tasks.
export const parseBacklogTasks = (backlogDir) => {
  if (!fs.existsSync(backlogDir)) return [];
  return fs.readdirSync(backlogDir)
    .filter((f) => f.endsWith(".md") && f !== "index.md")
    .flatMap((f) => parseTaskFile(fs.readFileSync(path.join(backlogDir, f), "utf8"), epicKey(f)));
};
