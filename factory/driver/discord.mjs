// Discord tracker — the issue surface of the forge contract (forge.mjs
// header) backed by Discord REST v10, for factories whose owner answers in
// a Discord channel instead of any issue tracker (cfg.tracker: "discord" +
// cfg.discordChannel + cfg.discordTag; born when a client's scrum-shared
// Jira was ruled out — spec: factory/specs/discord-tracker.md).
// PR traffic never comes here — that stays on the forge.
//
// Threads are issues. In a channel SHARED between factories, every thread
// this factory creates is named "[<discordTag>] <title>" and every read is
// scoped to that prefix — the tag is hand-set in config (like jiraProject)
// because it is identity: derived names (directory basename) would orphan
// every thread on a checkout rename. The driver round-trips its own titles,
// so reads strip the prefix again.
//
// The answer flow has NO owner ceremony (the GitHub/Jira "close the issue
// with an answer" habit never formed): the owner just replies in the
// thread. A question thread with a message from the OWNER
// (cfg.discordOwnerId — hand-set, the trust anchor: the driver
// authenticates as the bot here, never as the owner) after this bot's
// last ✔ marker is ANSWERED and surfaces in issueListClosed — the list the
// contract documents as "where answered questions live", which triage
// already reads. After a successful triage the driver calls issueClose:
// post the ✔ marker, then archive. ✔ with no later reply = resolved,
// listed nowhere; replying later reopens (auto-unarchive, or the
// unarchive-and-retry in postMessage). A question that hit Discord's
// auto-archive TIMER with no answer is still OPEN — issueListOpen reads
// active threads plus the first archived page, so a timer never hides an
// unanswered question (older archived pages do fall off; a factory's
// thread count stays far below that horizon).
//
// Transport is curl with the token on stdin (`-K -`), exactly like
// bitbucket.mjs/jira.mjs: Node has no sync HTTP, curl ships on every
// supported host, and `ps` must never see the token. The one key is
// DISCORD_BOT_TOKEN in .factory/.env (bot user, Message Content intent
// enabled in the developer portal — without it message text can read
// empty). Snowflake ids stay STRINGS end to end: they exceed
// Number.MAX_SAFE_INTEGER and a Number() round-trip corrupts them.

import { execFileSync, spawn } from "node:child_process";

const KEYS = ["DISCORD_BOT_TOKEN"];
const API = "https://discord.com/api/v10";
const MSG_MAX = 2000; // Discord message cap; longer bodies post as chunks
const NAME_MAX = 100; // Discord thread-name cap
const PACE_MS = 350; // gap between chunk posts — under the per-channel bucket's burst
// Preflight probes are quick calls to a healthy API; 15s is the production
// budget. Overridable because a test box running the whole suite can take
// longer than that just to spawn the stub, and a preflight that reports
// "auth failed" because the machine was busy is a false alarm either way.
// Read per call, not once at import: a test setting it in its own module body
// runs AFTER this module was evaluated, and a constant would miss it.
const curlTimeoutMs = () => Number(process.env.FACTORY_CURL_TIMEOUT_MS ?? 15_000);
const MAX_429_WAIT_S = 30; // a retry_after above this is a global limit; don't sit on it
// Sync wait, matching this module's execFileSync transport.
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// Mirrors factory.mjs's QUESTION_PREFIX — the one title convention the
// tracker must recognize to classify answer state.
const QUESTION_PREFIX = "[factory] question:";
// Mirrors factory.mjs's DAILY_LOG_TITLE — the other title convention this
// tracker must recognize, to route the daily log to the digests channel
// under the per-type split (spec: factory/specs/owner-message-format.md).
const DAILY_LOG_TITLE = "[factory] daily log";
const ACK_MARK = "✔";
const ACK_TEXT = "✔ folded into the backlog — reply here to reopen.";

// Split on line boundaries first, hard-slice single lines over the cap.
const chunks = (text) => {
  const out = [];
  let cur = "";
  const push = (piece) => {
    if (cur && cur.length + piece.length + 1 > MSG_MAX) { out.push(cur); cur = ""; }
    cur = cur ? `${cur}\n${piece}` : piece;
  };
  for (const line of String(text ?? "").split("\n")) {
    if (line.length <= MSG_MAX) push(line);
    else for (let i = 0; i < line.length; i += MSG_MAX) push(line.slice(i, i + MSG_MAX));
  }
  if (cur.trim()) out.push(cur);
  return out.length ? out : [" "];
};

const snow = (s) => { try { return BigInt(s); } catch { return 0n; } };

export const discordTracker = ({ cfg = {}, env = {} }) => {
  const key = (k) => env[k] ?? process.env[k];
  const cred = () => {
    const missing = KEYS.filter((k) => !key(k));
    if (missing.length) throw new Error(`${missing.join(" and ")} not set in .factory/.env`);
    return `header = "Authorization: Bot ${key("DISCORD_BOT_TOKEN")}"\n`;
  };
  // Per-type channels (owner-message-format spec): questions carries the
  // question threads, digests the daily log; activity is the FYI stream
  // (plain messages, no threads). Any kind unset in discordChannels falls
  // back to the legacy single discordChannel, so a single-channel factory
  // behaves exactly as before the split.
  const chan = (kind) => {
    const id = cfg.discordChannels?.[kind] ?? cfg.discordChannel;
    if (!id) throw new Error(`config.json → discordChannels.${kind} (or legacy discordChannel) not set — tracker "discord" needs the channel id`);
    return String(id);
  };
  const channel = () => chan("questions");
  // Every channel this tracker opens threads in — what reads must span: a
  // daily log living in digests must not vanish from issueListOpen, or
  // postDailyLogs would file a duplicate every window.
  const threadChannels = () => [...new Set([chan("questions"), chan("digests")])];
  const prefix = () => {
    if (!cfg.discordTag) throw new Error(`config.json → discordTag not set — tracker "discord" needs the thread-name tag that scopes this factory in a shared channel`);
    return `[${cfg.discordTag}] `;
  };
  // The trust anchor. Unlike github/bitbucket/jira the driver does NOT
  // authenticate as the owner here — it authenticates as the bot — so the
  // owner's identity cannot be derived and must be declared. Without it,
  // every owner reply would tag (UNTRUSTED) in the triage prompt and the
  // whole answer flow would be dead on arrival (review finding, 2026-07-27).
  const ownerId = () => {
    if (!cfg.discordOwnerId) throw new Error(`config.json → discordOwnerId not set — tracker "discord" needs the owner's Discord user id (developer mode → right-click your name → Copy User ID)`);
    return String(cfg.discordOwnerId);
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

  // Both resolved once per instance: the guild id (thread urls, active-thread
  // listing) and the bot's own id (the ✔-marker classifier below).
  let gid = null;
  const guildId = () => {
    if (!gid) {
      gid = json(`${API}/channels/${channel()}`).guild_id;
      if (!gid) throw new Error(`channel ${channel()} has no guild_id — is it a DM or a wrong id?`);
    }
    return gid;
  };
  // The BOT's own id (marker detection) — distinct from ownerId, the trust
  // anchor. Resolved once per instance.
  let botCache = null;
  const botId = () => (botCache ??= json(`${API}/users/@me`).id ?? null);

  const threadUrl = (id) => `https://discord.com/channels/${guildId()}/${id}`;
  const stripName = (name) => String(name ?? "").slice(prefix().length);
  const isQuestion = (title) => title.startsWith(QUESTION_PREFIX);
  const mapThread = (t) => ({
    number: t.id, title: stripName(t.name), url: threadUrl(t.id),
    author: null, authorId: t.owner_id ?? null,
  });
  const byIdDesc = (a, b) => (snow(b.number) > snow(a.number) ? 1 : -1);

  // Chronological messages (the API answers newest-first). Capped, not
  // unbounded — same rule as jira's searchAll; a question thread that long
  // has bigger problems than pagination.
  const fetchMessages = (threadId) => {
    const out = [];
    let before = null;
    for (let page = 0; page < 10; page++) {
      const q = before ? `&before=${before}` : "";
      const batch = json(`${API}/channels/${threadId}/messages?limit=100${q}`);
      if (!Array.isArray(batch) || !batch.length) break;
      out.push(...batch);
      if (batch.length < 100) break;
      before = batch[batch.length - 1].id;
    }
    return out.reverse();
  };

  // Walk chronologically: this bot's ✔ marker resets the answered flag, a
  // later message FROM AN ANSWERING IDENTITY sets it. answered →
  // issueListClosed; marker-and-quiet → resolved (listed nowhere);
  // neither → still open. Two identities answer, never more (the
  // two-identity rule, delegation.md seam 2): the OWNER always; the
  // RESOLVER (cfg.discordResolverId) only after the owner flips
  // `resolverTrust: "answer"` — tier 2 of the trust ramp. The default
  // ("draft"/unset) keeps tier 1: resolver posts are drafts, and only an
  // owner reply — their "ok" included — closes the thread. Anyone else
  // in the shared channel is context, never the answer: counting a
  // teammate would flip the thread "answered", triage would refuse the
  // untrusted content, and the ack would archive the question unanswered.
  const resolverId = () =>
    cfg.resolverTrust === "answer" && cfg.discordResolverId ? String(cfg.discordResolverId) : null;
  const classifyQuestion = (threadId) => {
    const bot = botId(), owner = ownerId(), resolver = resolverId();
    let sawMark = false, answered = false;
    for (const m of fetchMessages(threadId)) {
      if (m.author?.id === bot && String(m.content ?? "").startsWith(ACK_MARK)) { sawMark = true; answered = false; }
      else if (m.author?.id === owner || (resolver && m.author?.id === resolver)) answered = true;
    }
    return { answered, resolved: sawMark && !answered };
  };

  // Every thread of ours in scope: active (guild-wide endpoint, filtered to
  // the channel) plus the first archived page (the auto-archive rescue).
  const listThreads = () => {
    const pre = prefix();
    const channels = threadChannels();
    const active = json(`${API}/guilds/${guildId()}/threads/active`).threads ?? [];
    const archived = channels.flatMap((c) => json(`${API}/channels/${c}/threads/archived/public?limit=50`).threads ?? []);
    const seen = new Map();
    for (const t of [...active, ...archived]) {
      if (!channels.includes(t.parent_id) || !String(t.name ?? "").startsWith(pre)) continue;
      if (!seen.has(t.id)) seen.set(t.id, t);
    }
    return [...seen.values()];
  };

  // Post one message. Two failures get an in-session remedy: a 429 (the
  // body carries retry_after seconds — honor it and retry; before this, a
  // factory's 12-chunk daily log 429'd and the whole log queued for the
  // NEXT session, landing fragmented and out of order, 2026-07-28) and a
  // refusal on an archived thread (unarchive and retry once — Discord's
  // REST behavior for bots is on the spec's verify list). Anything else
  // still throws; queue-for-next-session remains the backstop, including
  // a global rate limit whose retry_after exceeds the cap.
  const postMessage = (threadId, content) => {
    const send = () => req(`${API}/channels/${threadId}/messages`, { method: "POST", body: { content } });
    let unarchived = false, waits = 0;
    for (;;) {
      try { send(); return; } catch (e) {
        let retryAfter = null;
        try { retryAfter = JSON.parse(String(e.stdout ?? "")).retry_after ?? null; } catch { /* not a rate-limit body */ }
        if (typeof retryAfter === "number" && retryAfter <= MAX_429_WAIT_S && waits++ < 3) { sleepMs(retryAfter * 1000 + 50); continue; }
        if (typeof retryAfter !== "number" && !unarchived) {
          unarchived = true;
          req(`${API}/channels/${threadId}`, { method: "PATCH", body: { archived: false } });
          continue;
        }
        throw e;
      }
    }
  };

  // Chunked bodies post paced: Discord's per-channel bucket tolerates only
  // a short burst, and a stale factory's first daily log is exactly the
  // many-chunk case that trips it.
  const postChunks = (threadId, body) =>
    chunks(body).forEach((c, i) => { if (i) sleepMs(PACE_MS); postMessage(threadId, c); });

  // Dashboard transport: async, resolve-{data|error}, never rejects — even
  // on sync throws (missing token/channel/tag). Same shape and rationale as
  // jira.mjs's reqAsync.
  const reqAsync = (url) => new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    // Resolve credential/config problems BEFORE spawning: curl blocks on
    // `-K -` until stdin closes, so a late throw would surface as a
    // meaningless 15s-timeout "curl exit null" instead of the real message.
    let config;
    try { config = cred(); url = url(); } catch (e) { done({ error: String(e.message ?? e).split("\n")[0].slice(0, 120) }); return; }
    const child = spawn("curl", curlArgs(url), { timeout: curlTimeoutMs() });
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
    kind: "discord",

    issueListOpen: () => {
      const rows = [];
      for (const t of listThreads()) {
        const row = mapThread(t);
        if (isQuestion(row.title)) {
          const c = classifyQuestion(t.id);
          if (c.answered || c.resolved) continue;
        }
        rows.push(row);
      }
      return rows.sort(byIdDesc).slice(0, 100);
    },
    issueListClosed: () => listThreads()
      .filter((t) => isQuestion(stripName(t.name)) && classifyQuestion(t.id).answered)
      .map(mapThread).sort(byIdDesc).slice(0, 20),

    // NOT the authenticated account: whoami is the id whose content the
    // trust split may believe (forge.mjs contract), and here that is the
    // OWNER's user id, never the bot the driver authenticates as. The
    // bot's own messages tag (UNTRUSTED) as a result — conservative and
    // harmless: they are question bodies and ✔ markers, data either way.
    whoami: () => ({ id: ownerId(), name: "owner" }),
    // The dedupe key cap: thread names truncate at 100 chars, so the
    // driver must dedupe question titles on their truncated form or a
    // long-titled question re-asked would open a duplicate thread every
    // window instead of commenting the existing one (NOTES item 28's
    // failure, discord-specific edition). The cap is what survives of the
    // bare question after "[<tag>] [factory] question: " spends its share.
    titleKey: (title) => String(title).slice(0, Math.max(20, NAME_MAX - prefix().length - QUESTION_PREFIX.length - 1)),
    issueCreate: ({ title, body }) => {
      const t = json(`${API}/channels/${title === DAILY_LOG_TITLE ? chan("digests") : chan("questions")}/threads`, { method: "POST", body: {
        name: `${prefix()}${title}`.slice(0, NAME_MAX), type: 11, auto_archive_duration: 10080,
      } });
      if (isQuestion(title)) {
        // Ask-first opener (owner-message-format spec): the notification
        // preview shows the thread's first message, so message 1 is the
        // bare ask + how to answer, and the session's evidence lands as
        // message 2 — reading it becomes optional.
        postMessage(t.id, `❓ ${title.slice(QUESTION_PREFIX.length).trim()}\nReply here with the answer — one line is enough. The factory folds replies in at its next triage.`);
        if (String(body ?? "").trim()) { sleepMs(PACE_MS); postChunks(t.id, body); }
      } else {
        postChunks(t.id, body || " ");
      }
      return threadUrl(t.id);
    },
    issueComment: (threadId, body) => postChunks(threadId, body),
    // Plain channel message — the notification router's Discord leg
    // (notify-route.mjs): activity/digest one-liners, never threads.
    // Tag-prefixed like thread names, so a shared channel still says
    // which factory is talking.
    post: (kind, text) => postChunks(chan(kind), `${prefix()}${text}`),
    // Machine threads (delegation.md seam 1): `[<machine>] <fact>` threads
    // in the questions channel, opened and ✔-closed by the doctor sensor.
    // RAW titles — no factory tag: the fact belongs to the BOX, and every
    // factory on it must converge on the same thread, so these threads
    // deliberately live outside the tag-scoped issue reads.
    machineThreads: {
      open: (title, opener) => {
        const t = json(`${API}/channels/${chan("questions")}/threads`, { method: "POST", body: {
          name: String(title).slice(0, NAME_MAX), type: 11, auto_archive_duration: 10080,
        } });
        postMessage(t.id, opener);
        return t.id;
      },
      comment: (id, body) => postChunks(id, body),
      close: (id, evidence) => {
        postMessage(id, `${ACK_MARK} ${evidence}`);
        req(`${API}/channels/${id}`, { method: "PATCH", body: { archived: true } });
      },
    },
    issueComments: (threadId) => fetchMessages(threadId).map((m) => ({
      author: m.author?.username ?? null, authorId: m.author?.id ?? null,
      body: m.content ?? "", createdAt: m.timestamp ?? null,
    })),
    // The driver calls this after a successful triage consumed the answers
    // this tracker listed as closed. Marker BEFORE archive: posting into
    // the just-archived thread would need the unarchive dance for nothing.
    issueClose: (threadId) => {
      postMessage(threadId, ACK_TEXT);
      req(`${API}/channels/${threadId}`, { method: "PATCH", body: { archived: true } });
    },
    // Replaces the default "close this issue" instruction in the question
    // attribution — closing is not a Discord gesture, replying is.
    answerHint: "Reply in this thread with an answer — the factory folds replies in at its next triage and marks ✔ when done.",

    // Doctor rows: env key → config keys → live probes, first failure wins.
    authCheck: () => {
      const missing = KEYS.filter((k) => !key(k));
      if (missing.length) {
        return [{ level: "fail", name: "discord auth", detail: `set ${missing.join(" and ")} in .factory/.env (bot token; enable the Message Content intent on the app)` }];
      }
      if (!(cfg.discordChannels?.questions ?? cfg.discordChannel)) {
        return [{ level: "fail", name: "discord tracker", detail: `config.json → discordChannels.questions (or legacy discordChannel) not set — tracker "discord" needs the channel id` }];
      }
      if (!cfg.discordTag) {
        return [{ level: "fail", name: "discord tracker", detail: `config.json → discordTag not set — the thread-name tag scoping this factory in a shared channel` }];
      }
      if (!cfg.discordOwnerId) {
        return [{ level: "fail", name: "discord tracker", detail: `config.json → discordOwnerId not set — the owner's Discord user id; without it every owner reply reads UNTRUSTED and answers cannot fold` }];
      }
      // Tier-2 misconfig fails preflight, not the first classified thread:
      // an unset resolver id makes "answer" a no-op the owner believes is
      // on; a resolver id equal to the owner's silently collapses the two
      // trust tiers into one identity.
      if (cfg.resolverTrust != null && !["draft", "answer"].includes(cfg.resolverTrust)) {
        return [{ level: "fail", name: "discord tracker", detail: `config.json → resolverTrust "${cfg.resolverTrust}" is not "draft" | "answer"` }];
      }
      if (cfg.resolverTrust === "answer") {
        if (!cfg.discordResolverId) {
          return [{ level: "fail", name: "discord tracker", detail: `config.json → resolverTrust "answer" needs discordResolverId — without it tier 2 is a silent no-op` }];
        }
        if (String(cfg.discordResolverId) === String(cfg.discordOwnerId)) {
          return [{ level: "fail", name: "discord tracker", detail: `config.json → discordResolverId equals discordOwnerId — the two trust tiers would collapse into one identity` }];
        }
      }
      try {
        const u = JSON.parse(execFileSync("curl", curlArgs(`${API}/users/@me`), { input: cred(), timeout: curlTimeoutMs(), encoding: "utf8" }));
        // Probe every distinct configured channel — a typo'd id must fail
        // preflight, not the first mid-window post to that channel.
        const ids = [...new Set(["questions", "activity", "digests"].map((k) => cfg.discordChannels?.[k] ?? cfg.discordChannel).filter(Boolean).map(String))];
        const names = ids.map((id) => {
          const c = JSON.parse(execFileSync("curl", curlArgs(`${API}/channels/${id}`), { input: cred(), timeout: curlTimeoutMs(), encoding: "utf8" }));
          return `#${c.name ?? id}`;
        });
        return [{ level: "ok", name: "discord auth", detail: `authenticated as ${u.username ?? "?"} — channel${names.length > 1 ? "s" : ""} ${names.join(", ")} reachable (tag [${cfg.discordTag}], owner ${cfg.discordOwnerId})` }];
      } catch (e) {
        return [{ level: "fail", name: "discord auth", detail: (String(e.stderr ?? "").trim() || e.message).split("\n")[0].slice(0, 160) }];
      }
    },

    async: {
      // Active threads only — classifying answer state needs a message
      // fetch per question, which the dashboard's 15s budget is not for.
      // An answered-but-unfolded question stays on the pill until triage
      // acks it; archived threads are off the pill by definition.
      issueList: async () => {
        const ch = await reqAsync(() => `${API}/channels/${channel()}`);
        if (ch.error) return ch;
        const g = ch.data?.guild_id;
        if (!g) return { error: "channel has no guild_id" };
        const r = await reqAsync(() => `${API}/guilds/${g}/threads/active`);
        if (r.error) return r;
        const pre = prefix();
        // Questions channel only: the pill is the needs-owner surface —
        // the daily log (digests) and activity FYIs stay off it.
        return { data: (r.data.threads ?? [])
          .filter((t) => t.parent_id === chan("questions") && String(t.name ?? "").startsWith(pre))
          .map((t) => ({
            number: t.id, title: String(t.name).slice(pre.length),
            url: `https://discord.com/channels/${g}/${t.id}`,
            author: null, authorId: t.owner_id ?? null, labels: [],
          })) };
      },
    },
  };
};
