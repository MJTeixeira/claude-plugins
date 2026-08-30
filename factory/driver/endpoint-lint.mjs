// Manifest-driven endpoint lint (api-ground-truth T-011, REQ-8 + REQ-14):
// reads the project's `docs/apis.json`, loads the vendored oracle(s), and
// validates every called path+method literal in the source against them —
// wireable as a project gateCommand so an unsourced endpoint is
// structurally unshippable. Trigger incident: a fabricated
// `GET /v3/identities/self`, flagged as a guess in its own code comment,
// absent from every version of the real spec, passed every gate.
//
// Enforcement maps to the oracle's rung (REQ-14):
//   openapi        → path+method validation; `deprecated: true` operations
//                    and calls only a legacy-marked generation answers WARN
//                    (exit 0) — sunset drift surfaces in review, not at EOL.
//   sdk            → no raw HTTP call may name a host in the entry's
//                    `hosts` list (the SDK + type-checker are the lint).
//   docs-snapshot / none → nothing machine-readable: report
//                    "grader-citation only" and exit 0.
// A manifest or vendored oracle that does not PARSE is a failure, never a
// skip — a typo must never silently turn a floor off. With
// `--diff-base <ref>` it also flags any diffed path under the manifest's
// vendored-oracle dirs: a session editing or authoring an oracle is
// laundered guessing, never a source (REQ-7/13).
//
// Scoping: an entry judges the calls its surface CLAIMS — the first
// segments of its oracle's paths ∪ its `generations` keys ∪ its optional
// `claims` prefixes (apis-manifest reference). A call no entry claims is
// a project's own route, out of scope — EXCEPT a version-shaped first
// segment (v3, beta, v2024): that is an API-generation claim by shape,
// and while a machine-readable oracle is present it FAILS, so the
// fabricated-generation hole (/v4/... against a v3-only oracle) cannot
// pass silently.
//
// Extraction limits (documented, deliberate — this is the per-project
// lint the spec scoped, NOT a universal HTTP linter): only STRING-LITERAL
// paths are seen, and only as the first quoted argument of CLIENT call
// shapes — verb methods on requests|httpx|session|client|axios|http, and
// fetch(...). Server route registrars (app.get, router.post) and other
// receivers' .get() are deliberately invisible; so are literals without a
// leading "/" and paths whose first segment is dynamic. Dynamic segments
// — `{expr}` in f-strings, `${expr}` in template literals — match as
// single-segment parameters against the spec's `{param}` segments. A call
// built from opaque variables is invisible to it; the Tier-1 traceability
// rule and the grader cover that remainder.
//
// Interface: lintProject(root, { diffBase }) → { failures, warnings,
// notices } of printable lines; the CLI prints them and exits 1 iff
// failures exist (gateCommand-friendly; warnings ride stdout).
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SOURCE_EXT = /\.(py|mjs|js|ts|jsx|tsx)$/;
const SKIP_DIRS = new Set([".git", "node_modules", ".factory", ".worktrees", "docs"]);
const firstLine = (s) => String(s).split("\n")[0];

const walkFiles = (dir, keep, skip, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!skip.has(e.name)) walkFiles(p, keep, skip, out); }
    else if (keep.test(e.name)) out.push(p);
  }
  return out;
};

// ---------- oracle loading ----------

// Every *.json under the entry's oracle paths that looks like OpenAPI
// (has `paths`) becomes one spec; its generation is the first directory
// segment below the oracle dir when that segment is a key in the entry's
// `generations` map (the split-generation vendoring layout in the
// apis-manifest reference: docs/apis/<api>/<generation>/...).
const loadSpecs = (root, entry) => {
  const specs = [], errors = [];
  for (const rel of entry.oracle?.paths ?? []) {
    const base = path.join(root, rel);
    if (!fs.existsSync(base)) continue;
    const files = fs.statSync(base).isDirectory() ? walkFiles(base, /\.json$/, new Set()) : [base];
    for (const f of files) {
      let doc;
      try { doc = JSON.parse(fs.readFileSync(f, "utf8")); }
      catch (e) {
        errors.push(`FAIL ${path.relative(root, f)}: vendored oracle does not parse (${firstLine(e.message)}) — a typo must never silently turn the floor off`);
        continue;
      }
      if (!doc || typeof doc.paths !== "object") continue;
      const below = path.relative(base, f).split(path.sep);
      const generation = below.length > 1 && (entry.generations ?? {})[below[0]] ? below[0] : null;
      specs.push({ file: path.relative(root, f), generation, paths: doc.paths });
    }
  }
  return { specs, errors };
};

// ---------- call extraction ----------

// Normalize a captured literal into a path: interpolations become {param},
// a scheme+host prefix or a single leading interpolation is stripped
// (f"{base}/v3/x" and `https://host/v3/x` both yield "/v3/x"). Anything
// else without a leading "/" ("v3/x") is ambiguous and stays invisible.
const toPath = (raw) => {
  let cooked = raw.replace(/\$\{[^}]*\}|\{[^}]*\}/g, "{param}")
    .replace(/^[a-z]+:\/\/[^/]*/i, "");
  if (cooked.startsWith("{param}")) cooked = cooked.slice("{param}".length);
  if (!cooked.startsWith("/")) return null;
  const p = cooked.replace(/[?#].*$/, "").replace(/\/+$/, "");
  return /\/[A-Za-z0-9]/.test(p) ? p : null;
};

const LITERAL = `(?:"([^"\\n]*)"|'([^'\\n]*)'|\`([^\`\\n]*)\`)`;
const CALL_SHAPES = [
  // Client verb calls: requests.get(...), httpx.post(...), session.put(...),
  // axios.delete(...) — receiver-whitelisted so server route registrars
  // (app.get, router.post) and unrelated .get() receivers never read as
  // outbound calls. Groups: 1 = verb, 2-4 = the literal.
  { re: new RegExp(`\\b(?:requests|httpx|session|client|axios|http)\\.(get|post|put|patch|delete|head)\\(\\s*[rbf]{0,2}${LITERAL}`, "g"), lit: [2, 3, 4], method: (m) => m[1].toUpperCase() },
  // fetch("...") / fetch(`...`, { headers: h(), method: "POST" }) — the
  // options scan tolerates call parens but never crosses a ";".
  // Groups: 1-3 = the literal, 4 = the optional method.
  { re: new RegExp(`\\bfetch\\(\\s*${LITERAL}\\s*(?:,\\s*\\{[^;]{0,200}?method\\s*:\\s*["'\`](\\w+)["'\`])?`, "g"), lit: [1, 2, 3], method: (m) => (m[4] ?? "GET").toUpperCase() },
];

const extractCalls = (root) => {
  const calls = [];
  for (const file of walkFiles(root, SOURCE_EXT, SKIP_DIRS)) {
    const text = fs.readFileSync(file, "utf8");
    const rel = path.relative(root, file);
    for (const shape of CALL_SHAPES) {
      shape.re.lastIndex = 0;
      for (const m of text.matchAll(shape.re)) {
        const raw = shape.lit.map((i) => m[i]).find((g) => g !== undefined) ?? "";
        const p = toPath(raw);
        if (p) calls.push({ file: rel, method: shape.method(m), path: p, segs: p.split("/").filter(Boolean), raw });
      }
    }
  }
  return calls;
};

// ---------- matching ----------

// A spec {param} segment matches anything; a call's dynamic segment also
// matches a concrete spec segment (existence is judged permissively — the
// warn lanes below therefore require EVERY hit to agree, so an ambiguous
// dynamic call never warns on one bad candidate).
const segMatch = (specSegs, callSegs) =>
  specSegs.length === callSegs.length && specSegs.every((s, i) =>
    s.startsWith("{") || callSegs[i] === "{param}" ? true : s === callSegs[i]);

const findOps = (specs, call) => {
  const hits = [];
  for (const spec of specs) {
    for (const [p, ops] of Object.entries(spec.paths)) {
      if (!segMatch(p.split("/").filter(Boolean), call.segs)) continue;
      const op = ops[call.method.toLowerCase()];
      if (op) hits.push({ spec, op, specPath: p });
    }
  }
  return hits;
};

const VERSION_SHAPED = /^(v\d+|beta|v20\d\d)$/i;

// ---------- the lint ----------

export const lintProject = (root, { diffBase } = {}) => {
  const failures = [], warnings = [], notices = [];
  const maniPath = path.join(root, "docs", "apis.json");
  if (!fs.existsSync(maniPath)) {
    notices.push("endpoint-lint: no docs/apis.json — nothing to enforce (see the spec skill's apis-manifest reference)");
    return { failures, warnings, notices };
  }
  let mani;
  try { mani = JSON.parse(fs.readFileSync(maniPath, "utf8")); }
  catch (e) { failures.push(`FAIL docs/apis.json does not parse: ${firstLine(e.message)}`); return { failures, warnings, notices }; }

  const entries = mani.apis ?? [];

  // REQ-7/13 enforcement half: in a session context (--diff-base), any
  // diffed file under a vendored-oracle path is a violation — an oracle a
  // session edits or authors is laundered guessing, never a source.
  if (diffBase) {
    let changed = [];
    try {
      changed = execFileSync("git", ["diff", "--name-only", "--no-renames", `${diffBase}...HEAD`],
        { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
    } catch (e) {
      failures.push(`FAIL cannot diff against ${diffBase}: ${firstLine(e.stderr ?? e.message)}`);
    }
    const oracleDirs = entries.flatMap((a) => a.oracle?.paths ?? []);
    for (const f of changed) {
      if (oracleDirs.some((d) => f.startsWith(d.replace(/\/$/, "") + "/") || f === d)) {
        failures.push(`FAIL ${f}: session diff touches a vendored oracle — read-only ground truth, refresh is owner-side (REQ-7/13)`);
      }
    }
  }

  const calls = extractCalls(root);
  const lintable = []; // openapi-rung entries: { entry, specs, claims }
  for (const entry of entries) {
    const rung = entry.oracle?.rung;
    if (rung === "docs-snapshot" || rung === "none") {
      notices.push(`endpoint-lint: ${entry.name} oracle rung is ${rung} — grader-citation only, no structural check`);
      continue;
    }
    if (rung === "sdk") {
      // The type-checker is the lint; the only structural check is that no
      // raw HTTP call bypasses the SDK to a declared host.
      for (const call of calls) {
        const host = (entry.hosts ?? []).find((h) => call.raw.includes(h));
        if (host) failures.push(`FAIL ${call.file}: raw ${call.method} to ${host} bypasses the ${entry.name} SDK (sdk-rung oracle)`);
      }
      continue;
    }
    // Spec-lintable rungs: today OpenAPI (JSON, vendored per the
    // apis-manifest reference). Other spec formats fall back to a notice
    // until a project actually vendors one.
    const { specs, errors } = loadSpecs(root, entry);
    failures.push(...errors);
    if (!specs.length) {
      if (!errors.length) notices.push(`endpoint-lint: ${entry.name} has no parseable JSON oracle under ${entry.oracle?.paths?.join(", ")} — nothing to enforce`);
      continue;
    }
    const claims = new Set([
      ...specs.flatMap((s) => Object.keys(s.paths).map((p) => p.split("/").filter(Boolean)[0]).filter(Boolean)),
      ...Object.keys(entry.generations ?? {}),
      ...(entry.claims ?? []).map((c) => c.split("/").filter(Boolean)[0]).filter(Boolean),
    ]);
    lintable.push({ entry, specs, claims });
  }

  for (const call of calls) {
    const first = call.segs[0];
    if (!first || first === "{param}") continue; // dynamic first segment: invisible, documented
    const owners = lintable.filter((l) => l.claims.has(first));
    if (!owners.length) {
      if (lintable.length && VERSION_SHAPED.test(first)) {
        failures.push(`FAIL ${call.file}: ${call.method} ${call.path} matches no vendored oracle generation — fabricated or unvendored surface, no source, no ship`);
      }
      continue; // a project's own routes are not this lint's to judge
    }
    const hits = owners.flatMap((l) => findOps(l.specs, call).map((h) => ({ ...h, entry: l.entry })));
    if (!hits.length) {
      failures.push(`FAIL ${call.file}: ${call.method} ${call.path} is not in the ${owners.map((o) => o.entry.name).join("/")} oracle — no source, no ship`);
      continue;
    }
    if (hits.every((h) => h.spec.generation && h.entry.generations?.[h.spec.generation] === "legacy")) {
      warnings.push(`WARN ${call.file}: ${call.method} ${call.path} only exists in a legacy generation (${hits[0].spec.generation}) — target ${hits[0].entry.targetGeneration}`);
    }
    if (hits.every((h) => h.op.deprecated === true)) {
      warnings.push(`WARN ${call.file}: ${call.method} ${call.path} is deprecated in the ${hits[0].entry.name} oracle`);
    }
  }
  return { failures, warnings, notices };
};

// ---------- CLI (gateCommand-friendly: nonzero = fail, warnings on stdout) ----------

const main = () => {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
  const root = path.resolve(opt("--root") ?? ".");
  const { failures, warnings, notices } = lintProject(root, { diffBase: opt("--diff-base") });
  for (const line of [...failures, ...warnings, ...notices]) console.log(line);
  if (!failures.length) console.log(`endpoint-lint: OK — ${warnings.length} warning(s)`);
  process.exit(failures.length ? 1 : 0);
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
