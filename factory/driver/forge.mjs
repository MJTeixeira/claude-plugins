// Forge adapter — the ONE place the driver and dashboard talk to a code
// forge. Implementations: github (gh CLI, below) and bitbucket (REST via
// curl, bitbucket.mjs — its header lists the contract deltas). All
// PR/issue/auth traffic goes through the capability surface below; inline
// `gh` calls elsewhere are a regression. Board sync is GitHub-only by
// design and uses the github impl's escape hatch (`forge.github`).
//
// Contract every implementation must honor (return shapes are the gh JSON
// shapes the driver already consumes — a new forge maps its API to these):
//   kind                    "github" | ...
//   bin                     binary the doctor/preflight PATH checks look for
//   prListText()            human-readable open-PR list for the repo snapshot
//   prListOpen()            [{number, url, title, headRefName, isDraft}] —
//                           isDraft is how the driver tells a human's task
//                           claim (draft PR, team affordances) from
//                           mergeable factory work
//   prView(pr)              {state, number, title, headRefName, mergeable,
//                            statusCheckRollup: [{conclusion|state}]}
//   prState(pr)             "OPEN" | "MERGED" | "CLOSED" — cheap state-only
//                           read (never the flaky check-rollup query)
//   prMerge(pr)             merge an open PR (throws on refusal)
//   prComment(pr, body)
//   prComments(pr)          [{author, body, createdAt}] — conversation
//                           comments (how humans answer factory PRs)
//   prCreate({title, body, head, base}) -> new PR url (trimmed)
//   prListMerged()          [{number, url, title, headRefName}] — the
//                           triage safety net's merged-but-status-lags check
//   issueListOpen()         [{number, title, url}]
//   issueListClosed()       [{number, title, url}] — recent first; where
//                           answered needs-human questions live
//   issueCreate({title, body}) -> issue url (trimmed)
//   issueComment(number, body)
//   issueComments(number)   [{author, body, createdAt}]
//   authCheck({wantBoard})  doctor rows [{level: ok|fail|skip, name, detail}]
//                           (tracker reachability is NOT part of authCheck —
//                            nativeTrackerCheck below probes it separately)
//   async.prList()          {data: [{number, title, url, isDraft, headRefName,
//                            statusCheckRollup}]} | {error} — never rejects
//   async.issueList()       {data: [{number, title, url, labels}]} | {error}
//   async.remoteBranchSha(base) -> head sha of origin's base branch, or null
// Sync methods throw on failure (callers' try/catch is load-bearing); the
// async namespace is the dashboard's resolve-never-reject contract.

import { execFile, execFileSync } from "node:child_process";
import { bitbucketForge } from "./bitbucket.mjs";
import { jiraTracker } from "./jira.mjs";

const githubForge = ({ project, env = {} }) => {
  const out = (args) =>
    execFileSync("gh", args, { cwd: project, env: { ...process.env, ...env }, timeout: 60_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const jsonOut = (args) => JSON.parse(out(args));

  // Dashboard transport: async, 15s cap, resolves {data|error} — a gh
  // outage must degrade a card, never crash the server loop.
  const jsonAsync = (args) => new Promise((resolve) => {
    execFile("gh", args, { cwd: project, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const reason = err.code === "ENOENT" ? "gh not installed"
          : (String(stderr ?? "").trim() || err.message || "gh failed").split("\n")[0].slice(0, 120);
        resolve({ error: reason });
        return;
      }
      try { resolve({ data: JSON.parse(stdout) }); } catch { resolve({ error: "unparseable gh output" }); }
    });
  });

  return {
    kind: "github",
    bin: "gh",

    // Repo-snapshot options kept verbatim from the pre-forge driver: 30s cap
    // (the died-session wrap-up path must not stall a full minute) and
    // stderr passthrough (the failure reason lands in the driver log).
    prListText: () =>
      execFileSync("gh", ["pr", "list", "--state", "open", "--limit", "10"], { cwd: project, env: { ...process.env, ...env }, timeout: 30_000, encoding: "utf8" }),
    prListOpen: () => jsonOut(["pr", "list", "--state", "open", "--json", "number,url,title,headRefName,isDraft", "--limit", "30"]),
    prView: (pr) => jsonOut(["pr", "view", pr, "--json", "state,number,title,headRefName,mergeable,statusCheckRollup"]),
    prState: (pr) => jsonOut(["pr", "view", pr, "--json", "state"]).state,
    prMerge: (pr) => { out(["pr", "merge", pr, "--merge"]); },
    prComment: (pr, body) => { out(["pr", "comment", pr, "--body", body]); },
    prComments: (pr) => (jsonOut(["pr", "view", pr, "--json", "comments"]).comments ?? [])
      .map((c) => ({ author: c.author?.login ?? null, body: c.body ?? "", createdAt: c.createdAt ?? null })),
    prCreate: ({ title, body, head, base }) => out(["pr", "create", "--head", head, "--base", base, "--title", title, "--body", body]).trim(),
    prListMerged: () => jsonOut(["pr", "list", "--state", "merged", "--json", "number,url,title,headRefName", "--limit", "30"]),

    issueListOpen: () => jsonOut(["issue", "list", "--state", "open", "--limit", "100", "--json", "number,title,url"]),
    // sort:updated-desc, not gh's created-desc default: an old question
    // closed-with-answer today must surface in the 20-item window.
    issueListClosed: () => jsonOut(["issue", "list", "--state", "closed", "--search", "sort:updated-desc", "--limit", "20", "--json", "number,title,url"]),
    issueCreate: ({ title, body }) => out(["issue", "create", "--title", title, "--body", body]).trim(),
    issueComment: (number, body) => { out(["issue", "comment", String(number), "--body", body]); },
    issueComments: (number) => (jsonOut(["issue", "view", String(number), "--json", "comments"]).comments ?? [])
      .map((c) => ({ author: c.author?.login ?? null, body: c.body ?? "", createdAt: c.createdAt ?? null })),

    // Doctor rows. Runs OUTSIDE the project cwd and without the .factory
    // .env merge, like every other doctor probe — auth is host-level state.
    authCheck: ({ wantBoard = false } = {}) => {
      let auth;
      try {
        auth = execFileSync("gh", ["auth", "status"], { timeout: 15_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        return [{ level: "fail", name: "gh auth", detail: (String(e.stderr ?? "").trim() || e.message).split("\n")[0].slice(0, 160) }];
      }
      const scopes = auth.match(/Token scopes:\s*(.+)/)?.[1];
      if (!scopes) return [{ level: "ok", name: "gh auth", detail: "authenticated (scopes not listed — fine-grained/oauth token)" }];
      const need = ["repo", ...(wantBoard ? ["project"] : [])];
      const missing = need.filter((s) => !scopes.includes(`'${s}'`) && !scopes.includes(s));
      return [{
        level: missing.length ? "fail" : "ok", name: "gh auth scopes",
        detail: missing.length ? `missing ${missing.join(", ")} — gh auth refresh -s ${missing.join(" -s ")}` : scopes.trim(),
      }];
    },

    // GitHub-only escape hatch: Projects v2 board sync (factory.mjs) stays a
    // github feature and never becomes part of the forge contract.
    github: { out, jsonOut },

    async: {
      prList: () => jsonAsync(["pr", "list", "--state", "open", "--json", "number,title,url,isDraft,headRefName,statusCheckRollup"]),
      issueList: () => jsonAsync(["issue", "list", "--state", "open", "--json", "number,title,url,labels"]),
      remoteBranchSha: async (base) => (await jsonAsync(["api", `repos/{owner}/{repo}/branches/${base}`])).data?.commit?.sha ?? null,
    },
  };
};

// `kind` comes from cfg.forge (default github; documented in FACTORY.md's
// auth note since the bitbucket forge shipped).
export const createForge = ({ kind = "github", project, env = {} }) => {
  if (kind === "github") return githubForge({ project, env });
  if (kind === "bitbucket") return bitbucketForge({ project, env });
  throw new Error(`unknown forge "${kind}" — supported: github, bitbucket`);
};

// Native-tracker reachability, as a doctor row. Every other forge call can
// succeed while the repo's own issue tracker is switched OFF — Bitbucket
// ships it off by default and answers 410 Gone — and then needs-human
// filings queue forever with nothing on screen to say so (the first live Bitbucket pilot,
// 2026-07-19: three questions "kept pending" through a whole window).
// One cheap list call is the only way to see it before a window burns.
//
// Everything here warns rather than fails, including a definite tracker-is-off
// signal: doctor doubles as the scheduled-run preflight, and a closed question
// mailbox must not cancel a window that would otherwise ship working code (the
// 2026-07-19 pilot window shipped T-001 with its tracker off). Filings queue in
// state and retry; the driver announces the stranded count out-of-band on every
// session end, which is the visibility this row cannot provide on its own. The
// off-vs-unreachable split stays because the two need different fixes.
export const nativeTrackerCheck = (forge) => {
  const name = `${forge.kind} issue tracker`;
  try {
    forge.issueListOpen();
    return { level: "ok", name, detail: "reachable" };
  } catch (e) {
    const msg = (String(e.stderr ?? "").trim() || e.message || "").split("\n")[0].slice(0, 160);
    const off = /\b410\b/.test(msg) || /issues? (?:are |is )?disabled|disabled.*issues?/i.test(msg);
    return off
      ? { level: "warn", name, detail: `the repo's issue tracker is OFF — needs-human questions cannot be filed and will queue silently; enable it in the repo settings, or set "tracker": "jira" in config.json (${msg})` }
      : { level: "warn", name, detail: `could not read the issue tracker: ${msg}` };
  }
};

// Tracker seam: where needs-human questions and the daily log live. Default
// is the forge's own tracker — the forge already implements the issue
// surface, and the legacy config value "github" means the same thing.
// `"jira"` routes issues to a Jira Cloud project instead (jira.mjs), for
// repos whose native tracker is off. PR capabilities stay on the forge
// either way.
export const createTracker = ({ cfg = {}, forge, env = {} }) => {
  const kind = cfg.tracker ?? "native";
  if (kind === "native" || kind === "github") return forge;
  if (kind === "jira") return jiraTracker({ cfg, env });
  throw new Error(`unknown tracker "${kind}" — supported: native (default), jira`);
};
