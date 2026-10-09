#!/usr/bin/env node
// bb — the machine's Bitbucket PR CLI. Fills the `gh` gap for sessions in
// Bitbucket repos: Atlassian ships no PR-capable CLI, and raw curl recipes
// die on permission matchers. Each machine links its `bb` on PATH to this
// file in the runtime checkout.
//
// Credentials, in order:
//   1. BITBUCKET_EMAIL + BITBUCKET_API_TOKEN in the environment.
//   2. The same two keys in ~/secrets/factory-shared.env, the machine's
//      shared credential file.
// The token is an Atlassian API token sent as Basic auth, and the username
// is the account EMAIL, not the Bitbucket username. It rides curl's stdin
// config (`-K -`), never argv, so `ps` cannot see it.
//
// A PR's destination is ALWAYS sent explicitly: `--base`, else the repo's
// mainbranch from the API. An omitted destination makes Bitbucket target the
// main branch silently, which on develop-based repos ships to the wrong
// branch.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const API = "https://api.bitbucket.org/2.0";
const KEYS = ["BITBUCKET_EMAIL", "BITBUCKET_API_TOKEN"];
const SHARED = path.join(os.homedir(), "secrets", "factory-shared.env");

const USAGE = `bb — Bitbucket PRs from the terminal, gh-style

usage:
  bb pr list                                open PRs
  bb pr view <id|url>                       state, title, checks
  bb pr create --title <t> [--body <b>] [--base <branch>]
                                            source = current branch
  bb pr merge <id|url>                      merge
  bb pr comment <id|url> <body>             comment

credentials: BITBUCKET_EMAIL + BITBUCKET_API_TOKEN in the environment, else
in ~/secrets/factory-shared.env. The API-token username is the account EMAIL.
PR destination: --base, else the repo's mainbranch — always sent explicitly.
`;

const fail = (msg) => { process.stderr.write(`bb: ${msg}\n`); process.exit(1); };

const git = (cwd, args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 }).trim();
const originOf = (dir) => { try { return git(dir, ["remote", "get-url", "origin"]); } catch { return null; } };

// "workspace/slug" from any bitbucket.org remote shape (ssh or https), null
// when the url is something else.
const repoPathOf = (url) =>
  String(url ?? "").match(/bitbucket\.org[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/)?.slice(1, 3).join("/") ?? null;

// KEY=VALUE lines, # comments, no expansion.
const readEnvLines = (file) => {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0) env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return env;
};

const credentials = () => {
  if (KEYS.every((k) => process.env[k])) return Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const shared = readEnvLines(SHARED);
  if (KEYS.every((k) => shared[k])) return Object.fromEntries(KEYS.map((k) => [k, shared[k]]));
  fail(`no Bitbucket credentials: set ${KEYS.join(" + ")} in the environment or in ${SHARED}`);
};

// Bitbucket PR states → gh's vocabulary.
const mapPrState = (s) => (s === "OPEN" || s === "MERGED" ? s : "CLOSED"); // DECLINED | SUPERSEDED
const mapCheck = (v) => ({ SUCCESSFUL: "SUCCESS", FAILED: "FAILURE", STOPPED: "CANCELLED" })[v.state] ?? "IN_PROGRESS";

const bitbucket = (cwd, cred) => {
  const origin = originOf(cwd);
  const repo = repoPathOf(origin);
  if (!repo) fail(`origin '${origin ?? "(none)"}' is not a bitbucket.org repo`);
  const base = `${API}/repositories/${repo}`;
  const req = (url, { method, body } = {}) => execFileSync("curl", [
    "-sS", "--fail-with-body", "-K", "-", "-H", "Accept: application/json",
    ...(method ? ["-X", method] : []),
    ...(body !== undefined ? ["-H", "Content-Type: application/json", "--data", JSON.stringify(body)] : []),
    url,
  ], { cwd, input: `user = "${cred.BITBUCKET_EMAIL}:${cred.BITBUCKET_API_TOKEN}"\n`, timeout: 60_000, encoding: "utf8" });
  const json = (url, opts) => JSON.parse(req(url, opts));
  const prId = (pr) => String(pr).match(/(\d+)\/?$/)?.[1] ?? fail(`cannot parse a PR id from '${pr}'`);
  return {
    repo,
    prList: () => json(`${base}/pullrequests?state=OPEN&pagelen=30`).values ?? [],
    prView: (pr) => {
      const id = prId(pr);
      return { pr: json(`${base}/pullrequests/${id}`), checks: json(`${base}/pullrequests/${id}/statuses?pagelen=100`).values ?? [] };
    },
    prCreate: ({ title, body, head, dest }) => {
      const r = json(`${base}/pullrequests`, { method: "POST", body: {
        title, description: body, source: { branch: { name: head } }, destination: { branch: { name: dest } },
      } });
      return r.links?.html?.href ?? `https://bitbucket.org/${repo}/pull-requests/${r.id}`;
    },
    prMerge: (pr) => req(`${base}/pullrequests/${prId(pr)}/merge`, { method: "POST", body: {} }),
    prComment: (pr, body) => req(`${base}/pullrequests/${prId(pr)}/comments`, { method: "POST", body: { content: { raw: body } } }),
    mainBranch: () => json(base).mainbranch?.name ?? "main",
  };
};

const arg = (args, name) => {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const v = args[i + 1];
  // A dangling flag must fail, not fall back to a default: for --base the
  // fallback is a silently wrong PR destination.
  if (v === undefined || v.startsWith("--")) fail(`${name} needs a value`);
  return v;
};

// prId keeps only the trailing number and every request targets the cwd
// repo, so a pasted URL naming another repo would act on the same-numbered
// PR here.
const assertSameRepo = (ref, repo) => {
  const target = String(ref).match(/bitbucket\.org\/([^/]+)\/([^/]+?)\/pull-requests\//)?.slice(1, 3).join("/");
  if (target && target !== repo) fail(`${ref} names ${target}, but this folder is a checkout of ${repo} — run bb from a checkout of ${target}`);
};

const main = () => {
  const [group, verb, ...rest] = process.argv.slice(2);
  if (!group || group === "help" || group === "--help") { process.stdout.write(USAGE); return; }
  if (group !== "pr" || !verb) fail(`unknown command '${[group, verb].filter(Boolean).join(" ")}' — run bb with no arguments for usage`);

  const cwd = process.cwd();
  const bb = bitbucket(cwd, credentials());

  if (verb === "list") {
    const rows = bb.prList();
    process.stdout.write(rows.length
      ? rows.map((p) => `#${p.id}\t${p.title}\t${p.source?.branch?.name ?? ""}${p.draft ? "\t(draft)" : ""}\n\t${p.links?.html?.href ?? ""}`).join("\n") + "\n"
      : "no open PRs\n");
  } else if (verb === "view") {
    if (!rest[0]) fail("bb pr view <id|url>");
    assertSameRepo(rest[0], bb.repo);
    const { pr, checks } = bb.prView(rest[0]);
    process.stdout.write(`#${pr.id} ${pr.title}\nstate: ${mapPrState(pr.state)}\nbranch: ${pr.source?.branch?.name ?? ""}\nchecks: ${checks.length ? checks.map(mapCheck).join(", ") : "none"}\n`);
  } else if (verb === "create") {
    const title = arg(rest, "--title");
    if (!title) fail("bb pr create --title <t> [--body <b>] [--base <branch>]");
    const head = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (head === "HEAD") fail("detached HEAD — check out the branch the PR should come from");
    const dest = arg(rest, "--base") ?? bb.mainBranch();
    process.stdout.write(`${bb.prCreate({ title, body: arg(rest, "--body") ?? "", head, dest })}\n`);
  } else if (verb === "merge") {
    if (!rest[0]) fail("bb pr merge <id|url>");
    assertSameRepo(rest[0], bb.repo);
    bb.prMerge(rest[0]);
    process.stdout.write("merged\n");
  } else if (verb === "comment") {
    if (!rest[0] || !rest[1]) fail("bb pr comment <id|url> <body>");
    assertSameRepo(rest[0], bb.repo);
    bb.prComment(rest[0], rest.slice(1).join(" "));
    process.stdout.write("commented\n");
  } else {
    fail(`unknown verb 'pr ${verb}' — run bb with no arguments for usage`);
  }
};

try { main(); } catch (e) {
  // A human tool: first line of the real cause, no stack. stderr can be
  // empty-but-present (a timed-out curl), so || past it.
  fail((String(e.stderr ?? "").trim() || String(e.message ?? e).trim()).split("\n")[0]);
}
