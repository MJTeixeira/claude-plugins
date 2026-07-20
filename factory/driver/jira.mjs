// Jira tracker — the issue surface of the forge contract (forge.mjs header)
// backed by Jira Cloud REST v3, for factories whose repo's native tracker is
// off (cfg.tracker: "jira" + cfg.jiraProject; typically Bitbucket repos,
// where the issue tracker ships disabled).
// PR traffic never comes here — that stays on the forge.
//
// Transport is curl with credentials on stdin (`-K -`), exactly like
// bitbucket.mjs: Node has no sync HTTP, curl ships on every supported host,
// and `ps` must never see the token. Keys come from .factory/.env:
// JIRA_BASE_URL (https://<site>.atlassian.net) + JIRA_EMAIL +
// JIRA_API_TOKEN (Atlassian API token, Basic auth) — the same three keys
// the Jira report mirror already documents.
//
// v3 throughout, deliberately: the legacy /search endpoints were removed in
// 2025 (410 Gone) and v2's future is unclear, so search is
// /rest/api/3/search/jql (explicit `fields`, first page of 100 — parity
// with `gh issue list --limit 100`) and write bodies are minimal ADF
// documents (one paragraph per line).

import { execFileSync, spawn } from "node:child_process";

const KEYS = ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"];

// Plain text → the minimal ADF document Jira v3 requires for descriptions
// and comment bodies. One paragraph per non-empty line; formatting is lost
// on purpose (question/attribution text is plain anyway).
const adf = (text) => ({
  type: "doc", version: 1,
  content: String(text).split("\n").filter((l) => l.trim()).map((line) => ({
    type: "paragraph", content: [{ type: "text", text: line }],
  })),
});

// The inverse, for reading comments back: flatten an ADF document to plain
// text — one line per top-level block, recursing into nested containers
// (bulletList → listItem → paragraph → text): owners answer questions with
// lists, and only FORMATTING may be lost, never content.
const adfText = (doc) => {
  const walk = (n) => n?.text ?? (n?.content ?? []).map(walk).join(n?.type === "paragraph" ? "" : " ");
  return (doc?.content ?? []).map(walk).filter((l) => l.trim()).join("\n");
};

export const jiraTracker = ({ cfg = {}, env = {} }) => {
  const key = (k) => env[k] ?? process.env[k];
  const cred = () => {
    const missing = KEYS.filter((k) => !key(k));
    if (missing.length) throw new Error(`${missing.join(" and ")} not set in .factory/.env`);
    return `user = "${key("JIRA_EMAIL")}:${key("JIRA_API_TOKEN")}"\n`;
  };
  const api = () => `${String(key("JIRA_BASE_URL")).replace(/\/+$/, "")}/rest/api/3`;
  const browse = (issueKey) => `${String(key("JIRA_BASE_URL")).replace(/\/+$/, "")}/browse/${issueKey}`;
  const project = () => {
    if (!cfg.jiraProject) throw new Error(`config.json → jiraProject not set — tracker "jira" needs the Jira project key`);
    return cfg.jiraProject;
  };

  const curlArgs = (url, { method, body } = {}) => [
    "-sS", "--fail-with-body", "-K", "-", "-H", "Accept: application/json",
    ...(method ? ["-X", method] : []),
    ...(body !== undefined ? ["-H", "Content-Type: application/json", "--data", JSON.stringify(body)] : []),
    url,
  ];
  const req = (url, opts) =>
    execFileSync("curl", curlArgs(url, opts), { env: { ...process.env, ...env }, input: cred(), timeout: 60_000, encoding: "utf8" });
  const json = (url, opts) => JSON.parse(req(url, opts));

  // cfg.jiraEpic (optional): the factory owns ONE epic inside a shared Jira
  // project (the shape when a client's Jira is shared across teams) — every
  // scan narrows to the epic's children and every created issue is parented
  // under it. Unset = the factory owns the whole project.
  const scope = () => `project = "${project()}"${cfg.jiraEpic ? ` AND parent = "${cfg.jiraEpic}"` : ""}`;
  const parentField = () => (cfg.jiraEpic ? { parent: { key: cfg.jiraEpic } } : {});
  const searchUrl = () => {
    const jql = `${scope()} AND statusCategory != Done ORDER BY created DESC`;
    return `${api()}/search/jql?jql=${encodeURIComponent(jql)}&fields=summary&maxResults=100`;
  };
  const mapIssue = (i) => ({ number: i.key, title: i.fields?.summary ?? "", url: browse(i.key) });
  // Paginated sync search (nextPageToken; the v3 endpoint returns nothing
  // without an explicit fields list). Capped, not unbounded — a runaway
  // shared project must not stall a window.
  const searchAll = (jql, fields) => {
    const out = [];
    let token = null;
    for (let page = 0; page < 10; page++) {
      const t = token ? `&nextPageToken=${encodeURIComponent(token)}` : "";
      const r = json(`${api()}/search/jql?jql=${encodeURIComponent(jql)}&fields=${encodeURIComponent(fields)}&maxResults=100${t}`);
      out.push(...(r.issues ?? []));
      token = r.nextPageToken ?? null;
      if (!token) break;
    }
    // A partial view is poison: a tracked card past the horizon looks
    // "missing" and would be recreated as a duplicate every sync. Refuse.
    if (token) throw new Error(`search truncated at ${out.length} issues — scope the factory (jiraEpic) tighter; refusing to act on a partial view`);
    return out;
  };

  // Dashboard transport: async, resolve-{data|error}, never rejects — even
  // on sync throws (missing keys, missing jiraProject). Same shape and
  // rationale as bitbucket.mjs's reqAsync.
  const reqAsync = (url) => new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    // Resolve credential/config problems BEFORE spawning: curl blocks on
    // `-K -` until stdin closes, so a late throw would surface as a
    // meaningless 15s-timeout "curl exit null" instead of the real message.
    let config;
    try { config = cred(); url = url(); } catch (e) { done({ error: String(e.message ?? e).split("\n")[0].slice(0, 120) }); return; }
    const child = spawn("curl", curlArgs(url), { timeout: 15_000 });
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

  return {
    kind: "jira",

    issueListOpen: () => (json(searchUrl()).issues ?? []).map(mapIssue),
    issueListClosed: () => {
      const jql = `${scope()} AND statusCategory = Done ORDER BY updated DESC`;
      return (json(`${api()}/search/jql?jql=${encodeURIComponent(jql)}&fields=summary&maxResults=20`).issues ?? []).map(mapIssue);
    },
    issueCreate: ({ title, body }) => {
      const r = json(`${api()}/issue`, { method: "POST", body: { fields: {
        project: { key: project() }, issuetype: { name: "Task" },
        summary: title, description: adf(body || " "), ...parentField(),
      } } });
      return browse(r.key);
    },
    issueComment: (issueKey, body) => { req(`${api()}/issue/${issueKey}/comment`, { method: "POST", body: { body: adf(body) } }); },
    issueComments: (issueKey) => (json(`${api()}/issue/${issueKey}/comment`).comments ?? [])
      .map((c) => ({ author: c.author?.displayName ?? null, body: adfText(c.body), createdAt: c.created ?? null })),

    // Board primitives (jira-board.mjs): the two-way board view over the
    // same scope. Cards are plain Tasks; status is the project's real
    // workflow, moved via transitions (Jira has no direct status write).
    board: {
      // Unique statuses across the project's issue types — init maps the
      // backlog vocabulary onto these by name.
      projectStatuses: () => {
        const seen = new Map();
        for (const type of json(`${api()}/project/${project()}/statuses`) ?? []) {
          for (const s of type.statuses ?? []) if (!seen.has(s.id)) seen.set(s.id, { id: s.id, name: s.name });
        }
        return [...seen.values()];
      },
      transitions: (key) => (json(`${api()}/issue/${key}/transitions`).transitions ?? [])
        .map((t) => ({ id: t.id, name: t.name, toStatus: t.to?.name ?? null })),
      transition: (key, id) => { req(`${api()}/issue/${key}/transitions`, { method: "POST", body: { transition: { id } } }); },
      createCard: ({ summary, description, labels = [] }) => {
        const r = json(`${api()}/issue`, { method: "POST", body: { fields: {
          project: { key: project() }, issuetype: { name: "Task" },
          summary, description: adf(description || " "), labels, ...parentField(),
        } } });
        return { key: r.key };
      },
      updateCard: (key, { summary, description }) => {
        const fields = {};
        if (summary !== undefined) fields.summary = summary;
        if (description !== undefined) fields.description = adf(description || " ");
        req(`${api()}/issue/${key}`, { method: "PUT", body: { fields } });
      },
      addLabel: (key, label) => { req(`${api()}/issue/${key}`, { method: "PUT", body: { update: { labels: [{ add: label }] } } }); },
      // Every issue in scope, done included — the BOARD decides what is a
      // card, a newcomer, or tracker noise; this just fetches.
      searchCards: () => searchAll(`${scope()} ORDER BY created DESC`, "summary,status,labels").map((i) => ({
        key: i.key, summary: i.fields?.summary ?? "",
        status: i.fields?.status?.name ?? null, labels: i.fields?.labels ?? [],
        done: i.fields?.status?.statusCategory?.key === "done",
      })),
    },

    // Doctor rows: env keys → config key → live probe, first failure wins.
    authCheck: () => {
      const missing = KEYS.filter((k) => !key(k));
      if (missing.length) {
        return [{ level: "fail", name: "jira auth", detail: `set ${missing.join(" and ")} in .factory/.env (Atlassian API token; Basic auth username is the account email)` }];
      }
      if (!cfg.jiraProject) {
        return [{ level: "fail", name: "jira tracker", detail: `config.json → jiraProject not set — tracker "jira" needs the Jira project key` }];
      }
      try {
        const u = JSON.parse(execFileSync("curl", curlArgs(`${api()}/myself`), { input: cred(), timeout: 15_000, encoding: "utf8" }));
        return [{ level: "ok", name: "jira auth", detail: `authenticated as ${u.displayName ?? u.emailAddress ?? "?"} (project ${cfg.jiraProject})` }];
      } catch (e) {
        return [{ level: "fail", name: "jira auth", detail: (String(e.stderr ?? "").trim() || e.message).split("\n")[0].slice(0, 160) }];
      }
    },

    async: {
      issueList: async () => {
        const r = await reqAsync(searchUrl);
        if (r.error) return r;
        return { data: (r.data.issues ?? []).map((i) => ({ ...mapIssue(i), labels: [] })) };
      },
    },
  };
};
