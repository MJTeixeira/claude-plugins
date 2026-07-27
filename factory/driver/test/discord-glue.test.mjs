// Discord tracker glue (cfg.tracker: "discord"): the driver-side answer
// flow around discord.mjs — triage prompts carry the answered threads, the
// ✔-and-archive ack fires ONLY after a successful triage, question filing
// carries the reply-here attribution, and daily-log thread ids survive as
// strings (snowflakes overflow Number). The adapter's own shape mapping is
// discord-tracker.test.mjs; this file drives the real driver.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeFactory, queueSessions, runDriver } from "./helpers.mjs";

const RESULT_EVENT = { type: "result", subtype: "success", result: "ok", total_cost_usd: 0.01, num_turns: 3, usage: { input_tokens: 10, output_tokens: 20 } };
const SETTLE = (mode) => `printf '%s\\n' '{"ts":"t","event":"report_status","taskId":null,"status":"completed","summary":"${mode} done","pr":null}' >> "$FACTORY_MCP_EVENTS"`;

// A snowflake past Number.MAX_SAFE_INTEGER: Number() would corrupt it, so
// any curl call carrying a mangled id proves a precision bug.
const BIG_THREAD = "9007199254740993111";

// Stub curl for the Discord API, PATH-first (the driver world's bin dir).
// Canned world: one answered question thread (201), one open one (202).
const withDiscord = (world, files = {}) => {
  const dir = path.join(world.root, "bin"); // runDriver prepends this to PATH
  fs.writeFileSync(path.join(dir, "curl"), `#!/bin/sh
ROOT="$(dirname "$0")"
printf '%s\\n' "$*" >> "$ROOT/curl-calls.log"
cat > /dev/null
for a in "$@"; do url="$a"; done
case "$url" in
  *"/users/@me"*) cat "$ROOT/me.json" ;;
  *"/threads/active"*) cat "$ROOT/active.json" ;;
  *"/threads/archived/public"*) echo '{"threads":[]}' ;;
  *"/messages"*)
    case "$*" in
      *"-X POST"*) echo '{"id":"900"}' ;;
      *)
        tid=$(printf '%s' "$url" | sed -n 's#.*/channels/\\([0-9]*\\)/messages.*#\\1#p')
        n=0; [ -f "$ROOT/m$tid-count" ] && n=$(cat "$ROOT/m$tid-count")
        n=$((n+1)); printf %s "$n" > "$ROOT/m$tid-count"
        if [ -f "$ROOT/messages-fail-$tid-from" ] && [ "$n" -ge "$(cat "$ROOT/messages-fail-$tid-from")" ]; then echo '{"message":"boom"}' >&2; exit 22; fi
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
`);
  fs.chmodSync(path.join(dir, "curl"), 0o755);
  // A gh whose `api user` really answers: the ack guard fails CLOSED when
  // either identity (forge or tracker) is unverifiable, so a glue world
  // without a forge identity could never ack and the tests would pass for
  // the wrong reason.
  const ghDir = path.join(world.root, "stub-gh");
  fs.mkdirSync(ghDir, { recursive: true });
  fs.writeFileSync(path.join(ghDir, "gh"), `#!/bin/sh
case "$1 $2" in
  "api user") echo '{"login":"owner1"}' ;;
  "pr list") echo "[]" ;;
  "issue list") echo "[]" ;;
  "repo view") echo '{"visibility":"PRIVATE"}' ;;
  *) echo "" ;;
esac
exit 0
`);
  fs.chmodSync(path.join(ghDir, "gh"), 0o755);
  world.extraEnv = { ...(world.extraEnv ?? {}), STUB_GH_DIR: ghDir };
  const bot = (content) => ({ id: "1", author: { id: "42", username: "factory-bot", bot: true }, content, timestamp: "2026-07-27T10:00:00Z" });
  const owner = (content) => ({ id: "2", author: { id: "7", username: "marcos" }, content, timestamp: "2026-07-27T11:00:00Z" });
  const defaults = {
    "channel.json": JSON.stringify({ id: "111", guild_id: "999", name: "factory", type: 0 }),
    "me.json": JSON.stringify({ id: "42", username: "factory-bot", bot: true }),
    "active.json": JSON.stringify({ threads: [
      { id: "201", name: "[colab] [factory] question: which db", parent_id: "111", owner_id: "42" },
      { id: "202", name: "[colab] [factory] question: pick a color", parent_id: "111", owner_id: "42" },
    ] }),
    "messages-201.json": JSON.stringify([owner("answer: postgres"), bot("pg or mysql?")]),
    "messages-202.json": JSON.stringify([bot("which color?")]),
    "thread-create.json": JSON.stringify({ id: BIG_THREAD }),
  };
  for (const [k, v] of Object.entries({ ...defaults, ...files })) fs.writeFileSync(path.join(dir, k), v);
  return { calls: () => (fs.existsSync(path.join(dir, "curl-calls.log")) ? fs.readFileSync(path.join(dir, "curl-calls.log"), "utf8") : "") };
};

const discordFactory = (t) => {
  const world = makeFactory(t, { config: { tracker: "discord", discordChannel: "111", discordTag: "colab", discordOwnerId: "7" } });
  fs.appendFileSync(path.join(world.stateDir, ".env"), "DISCORD_BOT_TOKEN=sekret-discord-tok\n");
  return world;
};

const invocation = (world, n) => JSON.parse(fs.readFileSync(path.join(world.stubDir, `invocation-${n}.json`), "utf8"));

test("triage sees the answered thread, and the driver acks it (✔ + archive) only after success", (t) => {
  const world = discordFactory(t);
  const discord = withDiscord(world);
  queueSessions(world, [{ script: SETTLE("triage"), stdout: RESULT_EVENT, exit: 0 }]);
  const r = runDriver(world, "triage");
  assert.equal(r.code, 0, r.stderr);
  const prompt = invocation(world, 1).prompt;
  assert.match(prompt, /Recently closed tracker issues[\s\S]*\[factory\] question: which db/,
    "the answered thread must land in the closed (owner answers) section");
  assert.match(prompt, /\(owner\) marcos [^\n]*answer: postgres/,
    "the owner's reply must be TRUSTED — whoami is the configured owner id, not the bot, or triage refuses to fold");
  assert.match(prompt, /Open tracker issues[\s\S]*\[factory\] question: pick a color/,
    "the unanswered thread stays in the open section");
  const log = discord.calls();
  assert.match(log, /-X POST[^\n]*channels\/201\/messages/, "ack must post the ✔ marker to the answered thread");
  assert.match(log, /-X PATCH[^\n]*channels\/201(\s|$)/m, "and archive it");
  assert.doesNotMatch(log, /-X PATCH[^\n]*channels\/202/, "the unanswered thread is never touched");
});

test("a failed triage acks nothing — the answer is re-presented next time", (t) => {
  const world = discordFactory(t);
  const discord = withDiscord(world);
  queueSessions(world, [{ script: "", stdout: { type: "result", subtype: "error", result: "boom" }, exit: 1 }]);
  runDriver(world, "triage");
  const log = discord.calls();
  assert.doesNotMatch(log, /-X POST[^\n]*channels\/201\/messages/, "no ✔ post on failure");
  assert.doesNotMatch(log, /-X PATCH/, "no archive on failure");
});

test("an answered thread whose comment fetch failed is NOT acked — triage never saw the answer", (t) => {
  const world = discordFactory(t);
  const discord = withDiscord(world);
  // Thread 201's message fetches: #1 classify (open list), #2 classify
  // (closed list), #3 the closed section's comment render. Failing from #3
  // leaves 201 listed answered but its comments "(unavailable)".
  fs.writeFileSync(path.join(world.root, "bin", "messages-fail-201-from"), "3");
  queueSessions(world, [{ script: SETTLE("triage"), stdout: RESULT_EVENT, exit: 0 }]);
  const r = runDriver(world, "triage");
  assert.equal(r.code, 0, r.stderr);
  const log = discord.calls();
  assert.doesNotMatch(log, /-X POST[^\n]*channels\/201\/messages/,
    "no ✔ on an answer the prompt could not display — archiving it would orphan the answer");
  assert.doesNotMatch(log, /-X PATCH[^\n]*channels\/201(\s|$)/m);
});

test("a re-asked long-titled question comments the existing (truncated-name) thread instead of duplicating it", (t) => {
  const world = discordFactory(t);
  const longTitle = "q".repeat(120);
  // What discord actually stored: the full name truncated to 100 chars.
  const storedName = `[colab] [factory] question: ${longTitle}`.slice(0, 100);
  const discord = withDiscord(world, {
    "active.json": JSON.stringify({ threads: [{ id: "210", name: storedName, parent_id: "111", owner_id: "42" }] }),
    "messages-210.json": JSON.stringify([{ id: "1", author: { id: "42", username: "factory-bot", bot: true }, content: "the long question", timestamp: "2026-07-27T10:00:00Z" }]),
  });
  queueSessions(world, [{
    script: `${SETTLE("triage")}; printf '%s\\n' '{"ts":"t","event":"open_question","title":"${longTitle}","body":"again","taskId":null}' >> "$FACTORY_MCP_EVENTS"`,
    stdout: RESULT_EVENT, exit: 0,
  }]);
  const r = runDriver(world, "triage");
  assert.equal(r.code, 0, r.stderr);
  const log = discord.calls();
  assert.doesNotMatch(log, /-X POST[^\n]*channels\/111\/threads/,
    "dedupe must match the truncated stored title via titleKey — a new thread is the NOTES-28 duplicate failure");
  assert.match(log, /-X POST[^\n]*channels\/210\/messages/, "the re-ask lands as a comment on the existing thread");
});

test("a filed question opens a tagged thread whose attribution says reply-here, and notify carries the thread url", (t) => {
  const world = discordFactory(t);
  const discord = withDiscord(world, { "active.json": JSON.stringify({ threads: [] }) });
  queueSessions(world, [{
    script: `${SETTLE("triage")}; printf '%s\\n' '{"ts":"t","event":"open_question","title":"deploy target?","body":"prod or staging","taskId":null}' >> "$FACTORY_MCP_EVENTS"`,
    stdout: RESULT_EVENT, exit: 0,
  }]);
  const r = runDriver(world, "triage");
  assert.equal(r.code, 0, r.stderr);
  const log = discord.calls();
  const create = log.split("\n").find((l) => /-X POST/.test(l) && /channels\/111\/threads/.test(l));
  assert.ok(create, "must open a thread in the configured channel");
  assert.match(create, /\[colab\] \[factory\] question: deploy target\?/);
  const post = log.split("\n").find((l) => new RegExp(`-X POST[^\\n]*channels/${BIG_THREAD}/messages`).test(l));
  assert.ok(post, "body must be posted to the new thread by its EXACT snowflake id");
  assert.match(post, /Reply in this thread/, "attribution must carry the discord answer gesture, not close-the-issue");
  assert.doesNotMatch(post, /[Cc]lose this issue/);
});

test("daily log: the created thread's big snowflake id survives as a string for the same-batch comment", (t) => {
  const world = discordFactory(t);
  const discord = withDiscord(world, { "active.json": JSON.stringify({ threads: [] }) });
  queueSessions(world, [{
    script: `${SETTLE("triage")}; printf '%s\\n' '{"ts":"t","event":"daily_log","body":"first entry"}' '{"ts":"t","event":"daily_log","body":"second entry"}' >> "$FACTORY_MCP_EVENTS"`,
    stdout: RESULT_EVENT, exit: 0,
  }]);
  const r = runDriver(world, "triage");
  assert.equal(r.code, 0, r.stderr);
  const posts = discord.calls().split("\n").filter((l) => new RegExp(`-X POST[^\\n]*channels/${BIG_THREAD}/messages`).test(l));
  assert.ok(posts.some((l) => /first entry/.test(l)), "first entry posted to the new thread");
  assert.ok(posts.some((l) => /second entry/.test(l)),
    "second entry must reuse the SAME thread id, unmangled — Number() would have corrupted the snowflake");
});
