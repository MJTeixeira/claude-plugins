# Spec — Discord tracker: the owner Q&A + daily-log surface

> Design record, NOT current contract — on conflict, `FACTORY.md` and the
> driver source win.

STATUS: APPROVED 2026-07-27 (PR #139, owner-merged) — BUILT the same day
(discord.mjs + createTracker wiring + driver answer-flow ack, factory
1.18.0), STUB-TESTED ONLY like the Jira track before its pilot. Live
verification (the "Verify at build" list below) happens on the first
live run once the owner's bot exists.

Owner decisions behind this (2026-07-27 session): Jira is RULED OUT for
the client-hosted factories — their Jira projects are shared with a scrum master
and team, and the tracker/board behaviors (hardcoded issue type,
capture+close of human issues, factory-wins-on-status, gated
transitions, sprint/metrics pollution) clash with company patterns. In
shared projects the factory backlog is the only source and Jira is
ignored entirely; the Jira tracker+board stay available for future
free-running projects. Meanwhile GitHub issues are, in the owner's
words, "a mirror, not really used"; Telegram carries no digests; the
dashboard catches up only after windows. Both of those factories strand
their needs-human questions today (Bitbucket trackers OFF, API 410 —
questions queue in `state.pendingQuestions` forever). The owner's pick:
**daily reports and questions/needs-human land in Discord**, in the
existing #factory channel. Existing webhooks there are write-only, so
the tracker runs on a **bot** the owner will create.

## Principles

- **Same seam as Jira, no bespoke side channel.** `createTracker`
  (forge.mjs) gains kind `"discord"` implementing the same issue
  surface. Everything downstream rides unchanged: question filing + the
  pendingQuestions retry queue, driver-collected triage reads (dev#110),
  `post_daily_log`, the dashboard needs-human pill, doctor. PRs stay on
  the forge.
- **Discord is the owner surface, not an input channel (yet).** Reports
  go out, answers come in. Human-initiated threads are NOT captured as
  work input while the channel is shared between factories — inbox and
  backlog remain the input paths. Revisit when/if per-factory channels
  exist.
- **Zero owner ceremony.** Typing a reply in the question thread IS the
  answer — no closing, no emoji, no command. The driver archives the
  thread after triage folds the answer in. (GitHub/Jira expect the human
  to close; that habit never formed and won't.)
- **curl transport, token never on argv.** `Authorization: Bot <token>`
  goes through a `-K -` stdin config (`header = "…"`), same pattern as
  bitbucket.mjs/jira.mjs.
- **Nothing is ever deleted.** Threads archive; archiving is reversible
  by replying.

## Config & env

- `config.json`: `"tracker": "discord"` + `"discordChannel": "<channel
  snowflake id>"` + `"discordTag": "<short-name>"` (the thread-name
  prefix — hand-set: it is identity, a derived name would orphan every
  thread on a checkout rename) + `"discordOwnerId": "<user snowflake>"`
  (the TRUST ANCHOR — as-built addition from the review pass, see
  Answer flow: the driver authenticates as the bot, not the owner, so
  the owner's id cannot be derived and must be declared; without it
  every owner reply tags UNTRUSTED and can never fold).
- `<state>/.env`: `DISCORD_BOT_TOKEN`.
- `guild_id` is derived per run from `GET /channels/{id}` (needed for
  thread URLs and the active-threads listing); not cached in config.
- **Shared-channel scoping**: every thread the factory creates is named
  `[<factory name>] …`, and the factory only ever reads threads carrying
  its own prefix (plus ids tracked in state). Multiple factories coexist
  in one channel; moving one to its own channel later is a config edit,
  zero code.

## Contract mapping (Discord API v10, `https://discord.com/api/v10`)

- `issueCreate({title, body})` → `POST /channels/{ch}/threads` (public
  thread, type 11, name `[<name>] <title>` truncated to Discord's
  100-char thread-name cap, longest available `auto_archive_duration`),
  then the body as the first message, chunked at the 2000-char message
  limit on paragraph boundaries. Returns
  `https://discord.com/channels/{guild}/{thread}`.
- `issueListOpen()` → `GET /guilds/{guild}/threads/active` filtered to
  `parent_id == channel` and the name prefix, UNIONED with recently
  archived threads that have no ✔ marker (see Answer flow — Discord
  auto-archives on a timer, and a timer must never hide an unanswered
  question).
- `issueListClosed()` → `GET /channels/{ch}/threads/archived/public`,
  prefix-filtered, first page (parity with the small closed-list caps
  elsewhere).
- `issueComments(id)` → `GET /channels/{thread}/messages` paginated
  oldest-first via `after`. Author = username, authorId = the user
  snowflake — stable and non-spoofable, the injection-posture id, same
  role as Jira's accountId.
- `issueComment(id, body)` → `POST /channels/{thread}/messages`,
  chunked; unarchive first if required (see Verify).
- `whoami()` → `GET /users/@me`.
- NEW optional tracker surface `issueClose(id)` → `PATCH
  /channels/{thread}` `{archived: true}`. Only discord implements it;
  only the driver calls it (post-triage). Native/Jira trackers are
  untouched — absence of `issueClose` keeps today's human-closes flow.

## Answer flow (as built — three review-pass corrections folded in)

1. Driver files a question → thread `[<tag>] [factory] question: <title>`.
2. Owner replies in the thread. That's everything the owner does.
3. Next triage: the driver collects question threads + messages; a
   thread with a message FROM THE OWNER (`discordOwnerId`) newer than
   the bot's last ✔ marker is presented to triage as ANSWERED. Owner-only
   on purpose (correction 1): the channel is shared — a teammate's
   comment is context, and `whoami()` returns the owner id, never the
   bot, so the trust split tags the owner's reply `(owner)` and triage
   may fold it.
4. Triage folds the answer; the driver posts `✔ folded into the backlog
   (…)` and archives the thread (`issueClose`) — but only threads whose
   owner answer actually RENDERED in that triage's prompt are acked
   (correction 2): a failed comment fetch degrades to "(unavailable)",
   and acking it would archive an answer triage never saw.
5. Owner replying later reopens it (reply auto-unarchives, or the
   driver's scan unarchives) — it surfaces as newly answered at the next
   triage. Reopening = replying, nothing else.
6. Unanswered questions that hit Discord's auto-archive timer still
   count as OPEN (the union in `issueListOpen`).
7. Long titles (correction 3): thread names truncate at 100 chars, so
   the tracker exposes `titleKey` and the driver dedupes re-asked
   questions on the truncated form — otherwise every re-ask of a
   sentence-length question would open a duplicate thread.

## Daily log

One long-lived thread `[<name>] daily log`; each day's report is a
comment (chunked). `post_daily_log` and the queue-on-failure behavior
work unchanged through the seam; a bot post revives the thread if the
auto-archive timer collapsed it.

## Doctor

Same shape as jira.mjs `authCheck`, first failure wins: token present →
`GET /users/@me` live probe → `GET /channels/{id}` (exists, is a text
channel, bot can see it). The Message Content intent cannot be read via
REST; the doctor detail text reminds the owner it must be ON.

## Dashboard

`tracker.async.issueList` implemented like jira.mjs `reqAsync` (spawned
curl, resolve-`{data|error}`, never rejects) — the needs-human pill and
daily-log link work as they do for Jira.

## Setup (owner, ~5 minutes, at build time)

1. discord.com/developers → New Application → Bot → copy the token;
   enable the **Message Content Intent** toggle.
2. Invite the bot to the server with: View Channel, Send Messages, Send
   Messages in Threads, Create Public Threads, Read Message History,
   Manage Threads.
3. Discord developer mode → right-click #factory → Copy Channel ID, and
   right-click your own name → Copy User ID (the `discordOwnerId`).
4. `DISCORD_BOT_TOKEN` into each factory's `<state>/.env`;
   `"tracker": "discord"` + `discordChannel` + `discordTag` +
   `discordOwnerId` into each `config.json`; doctor green.

## Verify at build (API details this spec does not assert)

- Whether REST `GET …/messages` returns `content` without the Message
  Content intent (enable the intent regardless).
- Whether a bot can POST into an archived thread directly
  (auto-unarchive) or must `PATCH archived:false` first.
- Whether the longest `auto_archive_duration` values are boost-free
  (believed universal since 2022); otherwise use the longest available —
  the open-listing union already tolerates early auto-archive.
- Pagination shapes: guild active-threads returns all active threads in
  the guild (fine at one-server scale); archived listing pages by
  timestamp.

## Out of scope

- Any board/kanban behavior — the GitHub Projects and Jira boards are
  untouched by this spec.
- Capturing human-initiated Discord threads as work input (needs
  per-factory channels or a mention convention — deferred).
- `notify.discord` — Telegram notifications and the `notify-fail.sh`
  outer net are unchanged.
- Flipping existing GitHub-tracker factories to Discord (config-only,
  owner's call, later).

## Rollout

colaboratorhub + entitlement-certification first — they are the
factories with no working tracker at all. The build PR updates
`FACTORY.md` §Tracker in the same PR (standing rule) and corrects the
the dev repo's pilot runbook header (the "Jira switch waits only on owner
creds" line is superseded by the 2026-07-27 decision). Factory minor
version bump in both manifests per the distribution rule.
