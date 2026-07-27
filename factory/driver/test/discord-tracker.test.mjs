// Discord tracker: the issue surface of the forge contract backed by
// Discord REST v10 (cfg.tracker: "discord"), for factories whose owner
// answers in a Discord channel instead of any issue tracker — the shape
// left when a shared Jira is off-limits (spec: factory/specs/discord-tracker.md).
// Threads are issues: a question thread with a human reply after the bot's
// last ✔ marker is ANSWERED (issueListClosed — where triage reads owner
// answers); ✔+quiet is resolved (listed nowhere); everything else is open,
// including auto-archived-but-unanswered questions (a Discord timer must
// never hide a question). These tests pin the shape mapping and the
// security property that the bot token rides stdin, never argv.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createForge, createTracker } from "../forge.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "discord-tracker-test-"));

// Programmable stub curl: dispatches on the request URL (last argv), canned
// responses live next to it. Captures argv (calls.log) and stdin
// (last-stdin) so tests can assert what crossed which channel.
const binDir = path.join(root, "bin");
fs.mkdirSync(binDir);
fs.writeFileSync(
  path.join(binDir, "curl"),
  `#!/bin/sh
ROOT="$(dirname "$0")"
printf '%s\\n' "$*" >> "$ROOT/calls.log"
cat > "$ROOT/last-stdin"
for a in "$@"; do url="$a"; done
case "$url" in
  *"/users/@me"*)
    if [ -s "$ROOT/auth-fail" ]; then cat "$ROOT/auth-fail" >&2; exit 22; fi
    cat "$ROOT/me.json" ;;
  *"/threads/active"*)
    if [ -s "$ROOT/active-fail" ]; then cat "$ROOT/active-fail" >&2; exit 22; fi
    cat "$ROOT/active.json" ;;
  *"/threads/archived/public"*) cat "$ROOT/archived.json" ;;
  *"/messages"*)
    case "$*" in
      *"-X POST"*)
        if [ -s "$ROOT/post-fail-once" ]; then : > "$ROOT/post-fail-once"; echo '{"message":"Thread is archived"}' >&2; exit 22; fi
        echo '{"id":"900"}' ;;
      *)
        tid=$(printf '%s' "$url" | sed -n 's#.*/channels/\\([0-9]*\\)/messages.*#\\1#p')
        if [ -f "$ROOT/messages-$tid.json" ]; then cat "$ROOT/messages-$tid.json"; else echo '[]'; fi ;;
    esac ;;
  *"/threads"*) cat "$ROOT/thread-create.json" ;;
  *"/channels/"*)
    case "$*" in
      *"-X PATCH"*) echo '{}' ;;
      *) cat "$ROOT/channel.json" ;;
    esac ;;
  *) echo '{}' ;;
esac
exit 0
`
);
fs.chmodSync(path.join(binDir, "curl"), 0o755);
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;

const set = (name, content) => fs.writeFileSync(path.join(binDir, name), content);
const calls = () => {
  const p = path.join(binDir, "calls.log");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim().split("\n") : [];
};
const clearCalls = () => fs.rmSync(path.join(binDir, "calls.log"), { force: true });
const lastStdin = () => fs.readFileSync(path.join(binDir, "last-stdin"), "utf8");

// The tracker falls back to process.env for credentials — the host machine's
// keys must not bleed into the missing-credential tests.
delete process.env.DISCORD_BOT_TOKEN;

const ENV = { DISCORD_BOT_TOKEN: "sekret-discord-tok" };
const CFG = { tracker: "discord", discordChannel: "111", discordTag: "colab", discordOwnerId: "7" };
const tracker = createTracker({ cfg: CFG, env: ENV });

// One channel, one bot, three-and-some threads — the canned world most
// tests share. Message fixtures are NEWEST-FIRST, as the API answers.
const bot = (content) => ({ id: "1", author: { id: "42", username: "factory-bot", bot: true }, content, timestamp: "2026-07-27T10:00:00Z" });
const owner = (content) => ({ id: "2", author: { id: "7", username: "marcos" }, content, timestamp: "2026-07-27T11:00:00Z" });
set("channel.json", JSON.stringify({ id: "111", guild_id: "999", name: "factory", type: 0 }));
set("me.json", JSON.stringify({ id: "42", username: "factory-bot", bot: true }));
set("active.json", JSON.stringify({ threads: [
  { id: "201", name: "[colab] [factory] question: pick a color", parent_id: "111", owner_id: "42" },
  { id: "202", name: "[colab] [factory] question: which db", parent_id: "111", owner_id: "42" },
  { id: "203", name: "[colab] [factory] daily log", parent_id: "111", owner_id: "42" },
  { id: "204", name: "[entcert] [factory] question: someone else's", parent_id: "111", owner_id: "43" },
  { id: "205", name: "[colab] [factory] question: other channel", parent_id: "555", owner_id: "42" },
] }));
set("archived.json", JSON.stringify({ threads: [
  { id: "206", name: "[colab] [factory] question: resolved one", parent_id: "111", owner_id: "42" },
  { id: "207", name: "[colab] [factory] question: stranded", parent_id: "111", owner_id: "42" },
  { id: "208", name: "[colab] [factory] question: round two", parent_id: "111", owner_id: "42" },
  { id: "209", name: "[colab] [factory] question: teammate chimed in", parent_id: "111", owner_id: "42" },
] }));
set("messages-201.json", JSON.stringify([bot("which color?")]));
set("messages-202.json", JSON.stringify([owner("answer: postgres"), bot("pg or mysql?")]));
set("messages-206.json", JSON.stringify([bot("✔ folded into the backlog"), owner("blue"), bot("which?")]));
set("messages-207.json", JSON.stringify([bot("still waiting")]));
set("messages-208.json", JSON.stringify([owner("more thoughts"), bot("✔ folded into the backlog"), owner("first answer"), bot("round?")]));
// A teammate (non-owner human) replied — context, never the answer.
set("messages-209.json", JSON.stringify([
  { id: "3", author: { id: "8", username: "teammate" }, content: "I think postgres?", timestamp: "2026-07-27T12:00:00Z" },
  bot("db choice?"),
]));

test("createTracker returns the discord tracker for cfg.tracker discord", () => {
  const forge = createForge({ kind: "github", project: root });
  assert.equal(createTracker({ cfg: CFG, forge }).kind, "discord");
  assert.throws(() => createTracker({ cfg: { tracker: "linear" }, forge }), /discord/,
    "the unknown-tracker error must list discord among the supported values");
});

test("bot token rides stdin as a curl header directive, never argv", () => {
  clearCalls();
  tracker.issueComments("201");
  assert.doesNotMatch(calls().join("\n"), /sekret-discord-tok/, "token must not be visible to ps");
  assert.match(lastStdin(), /header = "Authorization: Bot sekret-discord-tok"/);
});

test("issueListOpen lists unanswered questions and non-question threads, prefix-scoped, stripped, archived-rescue included", () => {
  clearCalls();
  const rows = tracker.issueListOpen();
  assert.deepEqual(rows.map((r) => r.number), ["209", "207", "203", "201"],
    "answered (202/208) and resolved (206) drop out; foreign prefix (204) and foreign parent (205) are invisible; archived-unanswered (207) and teammate-only (209) stay open");
  assert.deepEqual(rows[3], {
    number: "201", title: "[factory] question: pick a color",
    url: "https://discord.com/channels/999/201", author: null, authorId: "42",
  }, "the [colab] scope prefix must be stripped — the driver round-trips its own titles");
});

test("issueListClosed lists answered questions — an OWNER reply after the bot's last ✔ marker", () => {
  const rows = tracker.issueListClosed();
  assert.deepEqual(rows.map((r) => r.number), ["208", "202"],
    "202 = plain owner answer, 208 = owner reply AFTER an earlier ✔ reopens; 206 = ✔ with no later reply stays resolved; 209 = a teammate's reply is context, never the answer");
});

test("issueCreate opens a prefixed thread and posts the body, returning the thread url", () => {
  clearCalls();
  set("thread-create.json", JSON.stringify({ id: "301", name: "x" }));
  const url = tracker.issueCreate({ title: "[factory] question: pick", body: "which one?\nsecond line" });
  assert.equal(url, "https://discord.com/channels/999/301");
  const create = calls().find((l) => /-X POST/.test(l) && /channels\/111\/threads/.test(l));
  const body = JSON.parse(create.match(/--data (\{.*\}) https/)[1]);
  assert.equal(body.name, "[colab] [factory] question: pick");
  assert.equal(body.type, 11, "public thread");
  const post = calls().find((l) => /-X POST/.test(l) && /channels\/301\/messages/.test(l));
  assert.match(post, /which one\?/);
  assert.match(post, /second line/);
});

test("issueCreate truncates the thread name to Discord's 100-char cap", () => {
  clearCalls();
  set("thread-create.json", JSON.stringify({ id: "302" }));
  tracker.issueCreate({ title: `[factory] question: ${"x".repeat(200)}`, body: "b" });
  const create = calls().find((l) => /-X POST/.test(l) && /channels\/111\/threads/.test(l));
  assert.equal(JSON.parse(create.match(/--data (\{.*\}) https/)[1]).name.length, 100);
});

test("issueComment chunks long bodies at the 2000-char message cap", () => {
  clearCalls();
  tracker.issueComment("203", "a".repeat(4500));
  const posts = calls().filter((l) => /-X POST/.test(l) && /channels\/203\/messages/.test(l));
  assert.equal(posts.length, 3, "4500 chars = 2000 + 2000 + 500");
});

test("issueComment on a refused (archived) thread unarchives and retries once", () => {
  clearCalls();
  set("post-fail-once", "fail");
  tracker.issueComment("207", "still there?");
  const log = calls();
  const patch = log.findIndex((l) => /-X PATCH/.test(l) && /channels\/207/.test(l));
  assert.ok(patch >= 0, "must PATCH archived:false after the refused post");
  assert.match(log[patch].match(/--data (\{.*\}) https/)[1], /"archived":false/);
  assert.ok(log.slice(patch + 1).some((l) => /-X POST/.test(l) && /channels\/207\/messages/.test(l)), "and retry the post");
});

test("issueComments maps thread messages chronologically to {author, authorId, body, createdAt}", () => {
  assert.deepEqual(tracker.issueComments("202"), [
    { author: "factory-bot", authorId: "42", body: "pg or mysql?", createdAt: "2026-07-27T10:00:00Z" },
    { author: "marcos", authorId: "7", body: "answer: postgres", createdAt: "2026-07-27T11:00:00Z" },
  ]);
});

test("issueClose posts the ✔ marker then archives — the classifier depends on that order", () => {
  clearCalls();
  tracker.issueClose("202");
  const log = calls();
  const ack = log.findIndex((l) => /-X POST/.test(l) && /channels\/202\/messages/.test(l));
  assert.ok(ack >= 0);
  assert.match(JSON.parse(log[ack].match(/--data (\{.*\}) https/)[1]).content, /^✔/);
  const patch = log.findIndex((l) => /-X PATCH/.test(l) && /channels\/202/.test(l));
  assert.ok(patch > ack, "archive must come after the marker post");
  assert.match(log[patch].match(/--data (\{.*\}) https/)[1], /"archived":true/);
});

test("whoami is the OWNER's configured id — the trust anchor — never the bot the driver authenticates as", () => {
  assert.deepEqual(tracker.whoami(), { id: "7", name: "owner" },
    "the trust split believes whoami: the bot's id here would tag every owner answer UNTRUSTED");
});

test("answerHint tells the owner to reply, not to close", () => {
  assert.match(tracker.answerHint, /[Rr]eply in this thread/);
});

test("titleKey caps a question title to what survives thread-name truncation, and is idempotent", () => {
  const long = "x".repeat(200);
  const capped = tracker.titleKey(long);
  // 100 (thread cap) − "[colab] " (8) − "[factory] question: " (20) = 72.
  assert.equal(capped.length, 72);
  assert.equal(tracker.titleKey(capped), capped, "already-truncated stored titles must round-trip unchanged");
  assert.equal(tracker.titleKey("short one"), "short one");
});

test("a failing Discord call throws — the question queue absorbs and retries", () => {
  set("active-fail", '{"message": "Missing Access"}');
  assert.throws(() => tracker.issueListOpen());
  set("active-fail", "");
});

test("authCheck fails fast on a missing token, naming the key", () => {
  const rows = createTracker({ cfg: CFG, env: {} }).authCheck();
  assert.equal(rows[0].level, "fail");
  assert.match(rows[0].detail, /DISCORD_BOT_TOKEN/);
});

test("authCheck fails when the config names no channel, no tag, or no owner id", () => {
  assert.ok(createTracker({ cfg: { tracker: "discord", discordTag: "x", discordOwnerId: "7" }, env: ENV }).authCheck()
    .some((r) => r.level === "fail" && /discordChannel/.test(r.detail)));
  assert.ok(createTracker({ cfg: { tracker: "discord", discordChannel: "111", discordOwnerId: "7" }, env: ENV }).authCheck()
    .some((r) => r.level === "fail" && /discordTag/.test(r.detail)));
  assert.ok(createTracker({ cfg: { tracker: "discord", discordChannel: "111", discordTag: "x" }, env: ENV }).authCheck()
    .some((r) => r.level === "fail" && /discordOwnerId/.test(r.detail)));
});

test("authCheck probes the bot and the channel and reports both", () => {
  const rows = tracker.authCheck();
  assert.deepEqual(rows.map((r) => r.level), ["ok"]);
  assert.match(rows[0].detail, /factory-bot/);
  assert.match(rows[0].detail, /factory/);
});

test("authCheck reports a live auth refusal as a fail row", () => {
  set("auth-fail", '{"message": "401: Unauthorized"}');
  const rows = tracker.authCheck();
  assert.equal(rows[0].level, "fail");
  set("auth-fail", "");
});

test("async.issueList with missing credentials resolves the real error immediately, not a curl timeout", async () => {
  const t0 = Date.now();
  const r = await createTracker({ cfg: CFG, env: {} }).async.issueList();
  assert.match(r.error, /DISCORD_BOT_TOKEN/);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0}ms — must not wait out the curl timeout`);
});

test("async.issueList maps active prefix-scoped threads with empty labels for the dashboard", async () => {
  const r = await tracker.async.issueList();
  assert.deepEqual(r.data.map((t) => t.number), ["201", "202", "203"],
    "active only (no message classification on the dashboard's 15s budget), foreign prefix/parent excluded");
  assert.deepEqual(r.data[0], {
    number: "201", title: "[factory] question: pick a color",
    url: "https://discord.com/channels/999/201", author: null, authorId: "42", labels: [],
  });
});
