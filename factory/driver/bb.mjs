#!/usr/bin/env node
// bb — the machine's Bitbucket PR CLI. Fills the `gh` gap for interactive
// and plain sessions in Bitbucket repos (Atlassian ships no PR-capable CLI;
// session credential forms are proven dead; raw curl recipes die on
// permission matchers). Factory sessions keep the driver-wired create_pr —
// bb is for humans and the sessions they run.
//
// A thin skin over bitbucket.mjs: one source of truth for auth quirks and
// API shapes — if Bitbucket changes, the adapter is fixed once and both
// the driver and bb heal together.
//
// Credentials, in order:
//   1. BITBUCKET_EMAIL + BITBUCKET_API_TOKEN in the environment.
//   2. The registered factory whose origin matches this folder's origin —
//      the same state .env the driver reads (factory machines only).
// The matched factory also supplies the default PR destination
// (config.json baseBranch); without one, the repo's mainbranch from the
// API. The destination is ALWAYS sent explicitly: an omitted destination
// makes Bitbucket target the repo's main branch, which on develop-based
// repos ships to the wrong branch silently (fleet gotcha, 2026-07).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bitbucketForge, bitbucketRepoPath } from "./bitbucket.mjs";
import { stateDir, readEnvFile, execGit } from "./paths.mjs";

const USAGE = `bb — Bitbucket PRs from the terminal, gh-style

usage:
  bb pr list                                open PRs
  bb pr view <id|url>                       state, title, checks
  bb pr create --title <t> [--body <b>] [--base <branch>]
                                            source = current branch
  bb pr merge <id|url>                      merge
  bb pr comment <id|url> <body>             comment

credentials: BITBUCKET_EMAIL + BITBUCKET_API_TOKEN in the environment, or
resolved automatically from this machine's registered factory for the repo
(the same state .env the factory driver uses). The API-token username is
the account EMAIL. PR destination defaults to the factory's baseBranch,
else the repo's mainbranch — always sent explicitly.
`;

const fail = (msg) => { process.stderr.write(`bb: ${msg}\n`); process.exit(1); };

const gitIn = (cwd, args) => execGit(cwd, args, { timeoutMs: 15_000 });
const originOf = (dir) => { try { return gitIn(dir, ["remote", "get-url", "origin"]); } catch { return null; } };
const repoPathOf = bitbucketRepoPath; // the one bitbucket-origin parser (bitbucket.mjs)

// Find the registered factory whose origin names the same bitbucket repo as
// `cwd`, and return its machine-side context (credentials + config).
const factoryFor = (cwd) => {
  const mine = repoPathOf(originOf(cwd));
  if (!mine) return null;
  let registry = {};
  try { registry = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".factory", "registry.json"), "utf8")).factories ?? {}; }
  catch { return null; }
  for (const project of Object.keys(registry)) {
    if (!fs.existsSync(project)) continue; // moved/retired checkout, stale row
    if (repoPathOf(originOf(project)) !== mine) continue;
    const sd = stateDir(project);
    let config = {};
    try { config = JSON.parse(fs.readFileSync(path.join(sd, "config.json"), "utf8")); } catch { /* state without config */ }
    return { env: readEnvFile(sd), config };
  }
  return null;
};

const KEYS = ["BITBUCKET_EMAIL", "BITBUCKET_API_TOKEN"];
// Credentials and config resolve INDEPENDENTLY: env keys win the credential
// race, but the matched factory's config still owns the destination default —
// otherwise exported env creds silently retarget `pr create` at the repo's
// mainbranch in develop-based factory repos (review finding, 2026-07-31).
const resolveContext = (cwd) => {
  const fac = factoryFor(cwd);
  const config = fac?.config ?? {};
  if (KEYS.every((k) => process.env[k])) return { env: {}, config }; // forge falls through to process.env
  if (fac && KEYS.every((k) => fac.env[k])) {
    // Only the two forge keys cross into the child environment — the rest
    // of the factory's .env is not bb's to spread.
    return { env: Object.fromEntries(KEYS.map((k) => [k, fac.env[k]])), config };
  }
  fail(`no Bitbucket credentials: set ${KEYS.join(" + ")} in the environment, or run inside a repo this machine has a registered factory for (bb reads the factory's state .env)`);
};

const arg = (args, name) => {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const v = args[i + 1];
  // A dangling flag must fail, not fall back to a default — for --base the
  // fallback is a silently wrong PR destination, the exact gotcha bb kills.
  if (v === undefined || v.startsWith("--")) fail(`${name} needs a value`);
  return v;
};

// A PR reference that names a DIFFERENT repo must be refused: prId() keeps
// only the trailing number and every request targets the cwd repo, so a
// pasted cross-repo URL would silently act on the same-numbered PR HERE.
// (Web PR urls have their own shape — repoPathOf's regex is end-anchored
// for REMOTE urls and never matches `/pull-requests/<n>` tails.)
const prUrlRepo = (ref) =>
  String(ref).match(/bitbucket\.org\/([^/]+)\/([^/]+?)\/pull-requests\//)?.slice(1, 3).join("/") ?? null;
const assertSameRepo = (ref, cwd) => {
  const target = prUrlRepo(ref);
  const mine = repoPathOf(originOf(cwd));
  if (target && target !== mine) {
    fail(`${ref} names ${target}, but this folder is a checkout of ${mine} — run bb from a checkout of ${target}`);
  }
};

const main = () => {
  const [group, verb, ...rest] = process.argv.slice(2);
  if (!group || group === "help" || group === "--help") { process.stdout.write(USAGE); return; }
  if (group !== "pr" || !verb) fail(`unknown command '${[group, verb].filter(Boolean).join(" ")}' — run bb with no arguments for usage`);

  const cwd = process.cwd();
  const ctx = resolveContext(cwd);
  const forge = bitbucketForge({ project: cwd, env: ctx.env });

  if (verb === "list") {
    const rows = forge.prListOpen();
    process.stdout.write(rows.length
      ? rows.map((r) => `#${r.number}\t${r.title}\t${r.headRefName}${r.isDraft ? "\t(draft)" : ""}\n\t${r.url}`).join("\n") + "\n"
      : "no open PRs\n");
  } else if (verb === "view") {
    if (!rest[0]) fail("bb pr view <id|url>");
    assertSameRepo(rest[0], cwd);
    const p = forge.prView(rest[0]);
    const checks = p.statusCheckRollup.length
      ? p.statusCheckRollup.map((c) => c.conclusion ?? c.status).join(", ")
      : "none";
    process.stdout.write(`#${p.number} ${p.title}\nstate: ${p.state}\nbranch: ${p.headRefName}\nchecks: ${checks}\n`);
  } else if (verb === "create") {
    const title = arg(rest, "--title");
    if (!title) fail("bb pr create --title <t> [--body <b>] [--base <branch>]");
    const head = gitIn(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (head === "HEAD") fail("detached HEAD — check out the branch the PR should come from");
    const base = arg(rest, "--base") ?? ctx.config.baseBranch ?? forge.repoMainBranch();
    const url = forge.prCreate({ title, body: arg(rest, "--body") ?? "", head, base });
    process.stdout.write(`${url}\n`);
  } else if (verb === "merge") {
    if (!rest[0]) fail("bb pr merge <id|url>");
    assertSameRepo(rest[0], cwd);
    forge.prMerge(rest[0]);
    process.stdout.write("merged\n");
  } else if (verb === "comment") {
    if (!rest[0] || !rest[1]) fail("bb pr comment <id|url> <body>");
    assertSameRepo(rest[0], cwd);
    forge.prComment(rest[0], rest.slice(1).join(" "));
    process.stdout.write("commented\n");
  } else {
    fail(`unknown verb 'pr ${verb}' — run bb with no arguments for usage`);
  }
};

try { main(); } catch (e) {
  // Human tool, human errors: first line of the real cause, no stack.
  // stderr can be empty-but-present (a timed-out curl) — || past it.
  fail((String(e.stderr ?? "").trim() || String(e.message ?? e).trim()).split("\n")[0]);
}
