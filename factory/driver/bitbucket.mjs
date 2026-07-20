// Bitbucket Cloud forge — second implementation of the forge contract
// (capability surface + return shapes: forge.mjs header). Transport is
// curl: Node has no sync HTTP and the driver contract is sync; curl ships
// on every supported factory host (macOS/Linux — Windows was dropped).
//
// Auth: Atlassian API token, Basic auth — the username for API calls is
// the account EMAIL, not the Bitbucket username (app passwords are gone
// as of 2026-07-28). Keys come from .factory/.env: BITBUCKET_EMAIL +
// BITBUCKET_API_TOKEN, passed to curl as a config file on STDIN so they
// never appear in argv (`ps` must not see them).
//
// Contract deltas, by design:
// - no `github` escape hatch → board sync is unavailable (GitHub-only).
// - `mergeable` is always "UNKNOWN" (the API exposes no conflict flag);
//   the merge gate's local merge is what detects conflicts anyway.
// - dashboard `async.prList` rows carry an empty statusCheckRollup (per-PR
//   status fetches would N+1 every refresh; chips read "none" — revisit
//   when a Bitbucket factory actually runs Pipelines).
// - needs-human issues target the repo's NATIVE tracker; where it's off,
//   filing throws and the driver's question queue retries — the Jira
//   route (roadmap) supersedes this.

import { execFileSync, spawn } from "node:child_process";

const API = "https://api.bitbucket.org/2.0";

// Bitbucket PR states → the contract's gh vocabulary.
const mapPrState = (s) => (s === "OPEN" || s === "MERGED" ? s : "CLOSED"); // DECLINED | SUPERSEDED
// Commit-status states → gh-shaped rollup entries. Terminal states map to
// concrete conclusions; anything else (INPROGRESS, future additions) maps
// to in-flight, which rollupState reads as "wait" — fail requires evidence.
const STATUS_MAP = {
  SUCCESSFUL: { conclusion: "SUCCESS", status: "COMPLETED" },
  FAILED: { conclusion: "FAILURE", status: "COMPLETED" },
  STOPPED: { conclusion: "CANCELLED", status: "COMPLETED" },
};
const mapStatus = (v) => STATUS_MAP[v.state] ?? { conclusion: null, status: "IN_PROGRESS" };
const OPEN_ISSUE_STATES = new Set(["new", "open", "on hold"]);
// Server-side filter: a page of 100 must hold OPEN issues (parity with
// `gh issue list --state open --limit 100`), not the tracker's full history
// — resolved needs-human questions accumulate past 100 in normal operation.
const OPEN_ISSUE_Q = encodeURIComponent([...OPEN_ISSUE_STATES].map((s) => `state="${s}"`).join(" OR "));
const CLOSED_ISSUE_Q = encodeURIComponent(["resolved", "closed", "invalid", "duplicate", "wontfix"].map((s) => `state="${s}"`).join(" OR "));

export const bitbucketForge = ({ project, env = {} }) => {
  const key = (k) => env[k] ?? process.env[k];
  const cred = () => {
    const missing = ["BITBUCKET_EMAIL", "BITBUCKET_API_TOKEN"].filter((k) => !key(k));
    if (missing.length) throw new Error(`${missing.join(" and ")} not set in .factory/.env`);
    return `user = "${key("BITBUCKET_EMAIL")}:${key("BITBUCKET_API_TOKEN")}"\n`;
  };

  let repoPath = null; // "workspace/slug", lazily parsed from origin
  const repo = () => {
    if (repoPath) return repoPath;
    const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: project, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
    const m = url.match(/bitbucket\.org[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
    if (!m) throw new Error(`origin '${url}' is not a bitbucket.org repo — cfg.forge says bitbucket`);
    repoPath = `${m[1]}/${m[2]}`;
    return repoPath;
  };
  const base = () => `${API}/repositories/${repo()}`;

  const curlArgs = (url, { method, body } = {}) => [
    "-sS", "--fail-with-body", "-K", "-", "-H", "Accept: application/json",
    ...(method ? ["-X", method] : []),
    ...(body !== undefined ? ["-H", "Content-Type: application/json", "--data", JSON.stringify(body)] : []),
    url,
  ];
  const req = (url, opts) =>
    execFileSync("curl", curlArgs(url, opts), { cwd: project, env: { ...process.env, ...env }, input: cred(), timeout: 60_000, encoding: "utf8" });
  const json = (url, opts) => JSON.parse(req(url, opts));

  const prId = (pr) => {
    const m = String(pr).match(/(\d+)\/?$/);
    if (!m) throw new Error(`cannot parse a PR id from '${pr}'`);
    return m[1];
  };

  const listOpen = () => (json(`${base()}/pullrequests?state=OPEN&pagelen=30`).values ?? []).map((p) => ({
    number: p.id, url: p.links?.html?.href ?? null, title: p.title, headRefName: p.source?.branch?.name ?? null,
    isDraft: p.draft ?? false,
  }));

  // Dashboard transport: async, resolve-{data|error}, never rejects — even
  // on sync throws (missing keys, non-bitbucket origin).
  const reqAsync = (url) => new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    // Resolve credential problems BEFORE spawning: curl blocks on `-K -`
    // until stdin closes, so a late cred() throw would surface as a
    // meaningless 15s-timeout "curl exit null" instead of the real message.
    let config;
    try { config = cred(); } catch (e) { done({ error: String(e.message ?? e).split("\n")[0].slice(0, 120) }); return; }
    const child = spawn("curl", curlArgs(url), { cwd: project, timeout: 15_000 });
    const out = [], errBuf = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => errBuf.push(d));
    child.on("error", (e) => done({ error: e.code === "ENOENT" ? "curl not installed" : String(e.message).split("\n")[0].slice(0, 120) }));
    child.on("close", (code) => {
      if (code !== 0) { done({ error: (Buffer.concat(errBuf).toString().trim() || `curl exit ${code}`).split("\n")[0].slice(0, 120) }); return; }
      try { done({ data: JSON.parse(Buffer.concat(out).toString()) }); } catch { done({ error: "unparseable curl output" }); }
    });
    try { child.stdin.write(config); child.stdin.end(); } catch { /* EPIPE on a dead child — close/error handles it */ }
  });
  const safe = async (fn) => {
    try { return await fn(); } catch (e) { return { error: String(e.message ?? e).split("\n")[0].slice(0, 120) }; }
  };

  return {
    kind: "bitbucket",
    bin: "curl",

    prListText: () => listOpen().map((r) => `#${r.number}\t${r.title}\t${r.headRefName}`).join("\n"),
    prListOpen: listOpen,
    prView: (pr) => {
      const id = prId(pr);
      const p = json(`${base()}/pullrequests/${id}`);
      const st = json(`${base()}/pullrequests/${id}/statuses?pagelen=100`).values ?? [];
      return {
        state: mapPrState(p.state), number: p.id, title: p.title,
        headRefName: p.source?.branch?.name ?? null, mergeable: "UNKNOWN",
        statusCheckRollup: st.map(mapStatus),
      };
    },
    prState: (pr) => mapPrState(json(`${base()}/pullrequests/${prId(pr)}?fields=state`).state),
    prMerge: (pr) => { req(`${base()}/pullrequests/${prId(pr)}/merge`, { method: "POST", body: {} }); },
    prCreate: ({ title, body, head, base: baseBranch }) => {
      const r = json(`${base()}/pullrequests`, { method: "POST", body: {
        title, description: body,
        source: { branch: { name: head } }, destination: { branch: { name: baseBranch } },
      } });
      return r.links?.html?.href ?? `https://bitbucket.org/${repo()}/pull-requests/${r.id}`;
    },
    prComment: (pr, body) => { req(`${base()}/pullrequests/${prId(pr)}/comments`, { method: "POST", body: { content: { raw: body } } }); },
    prComments: (pr) => (json(`${base()}/pullrequests/${prId(pr)}/comments?pagelen=100`).values ?? [])
      .map((c) => ({ author: c.user?.display_name ?? null, body: c.content?.raw ?? "", createdAt: c.created_on ?? null })),
    prListMerged: () => (json(`${base()}/pullrequests?state=MERGED&pagelen=30`).values ?? []).map((p) => ({
      number: p.id, url: p.links?.html?.href ?? null, title: p.title, headRefName: p.source?.branch?.name ?? null,
    })),

    issueListOpen: () => (json(`${base()}/issues?pagelen=100&q=${OPEN_ISSUE_Q}`).values ?? [])
      .filter((i) => OPEN_ISSUE_STATES.has(i.state)) // belt over the q= braces
      .map((i) => ({ number: i.id, title: i.title, url: i.links?.html?.href ?? null })),
    issueListClosed: () => (json(`${base()}/issues?pagelen=20&q=${CLOSED_ISSUE_Q}&sort=-updated_on`).values ?? [])
      .map((i) => ({ number: i.id, title: i.title, url: i.links?.html?.href ?? null })),
    issueCreate: ({ title, body }) => {
      const r = json(`${base()}/issues`, { method: "POST", body: { title, content: { raw: body } } });
      return r.links?.html?.href ?? `https://bitbucket.org/${repo()}/issues/${r.id}`;
    },
    issueComment: (number, body) => { req(`${base()}/issues/${number}/comments`, { method: "POST", body: { content: { raw: body } } }); },
    issueComments: (number) => (json(`${base()}/issues/${number}/comments?pagelen=100`).values ?? [])
      .map((c) => ({ author: c.user?.display_name ?? null, body: c.content?.raw ?? "", createdAt: c.created_on ?? null })),

    authCheck: ({ wantBoard = false } = {}) => {
      const rows = [];
      const missing = ["BITBUCKET_EMAIL", "BITBUCKET_API_TOKEN"].filter((k) => !key(k));
      if (missing.length) {
        rows.push({ level: "fail", name: "bitbucket auth", detail: `set ${missing.join(" and ")} in .factory/.env (Atlassian API token; the basic-auth username is the account EMAIL)` });
      } else {
        try {
          const u = JSON.parse(execFileSync("curl", curlArgs(`${API}/user`), { input: cred(), timeout: 15_000, encoding: "utf8" }));
          rows.push({ level: "ok", name: "bitbucket auth", detail: `authenticated as ${u.display_name ?? u.username ?? "?"}` });
        } catch (e) {
          rows.push({ level: "fail", name: "bitbucket auth", detail: (String(e.stderr ?? "").trim() || e.message).split("\n")[0].slice(0, 160) });
        }
      }
      if (wantBoard) rows.push({ level: "warn", name: "board", detail: 'the GitHub board needs a github forge — on bitbucket use "board": {"jira": true} or remove "board" from config.json' });
      return rows;
    },

    async: {
      prList: () => safe(async () => {
        const r = await reqAsync(`${base()}/pullrequests?state=OPEN&pagelen=30`);
        if (r.error) return r;
        return { data: (r.data.values ?? []).map((p) => ({
          number: p.id, title: p.title, url: p.links?.html?.href ?? null,
          isDraft: p.draft ?? false, headRefName: p.source?.branch?.name ?? null,
          statusCheckRollup: [],
        })) };
      }),
      issueList: () => safe(async () => {
        const r = await reqAsync(`${base()}/issues?pagelen=100&q=${OPEN_ISSUE_Q}`);
        if (r.error) return r;
        return { data: (r.data.values ?? []).filter((i) => OPEN_ISSUE_STATES.has(i.state))
          .map((i) => ({ number: i.id, title: i.title, url: i.links?.html?.href ?? null, labels: [] })) };
      }),
      remoteBranchSha: async (branch) => {
        const r = await safe(() => reqAsync(`${base()}/refs/branches/${encodeURIComponent(branch)}`));
        return r.data?.target?.hash ?? null;
      },
    },
  };
};
