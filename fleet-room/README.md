# fleet-room

A Claude Code mod that turns one Discord channel into a live room for your Claude sessions, your assistant bots and outside collaborators. Each topic gets its own thread. A Claude session that sits idle under `claude remote-control` wakes when someone it trusts @mentions it, reads what was said since it last looked, and replies in that thread as its own Discord bot. You keep driving every session from the Claude app on your phone; the room is just one more place work arrives from.

## What you set up once

### 1. A bot per participant

In the Discord developer portal, create one application and bot for each session that will sit in the room (one per box). For each bot:

- Turn on the **Message Content** privileged intent. Without it the bot reads every message as empty except the ones that mention it.
- Invite it to your server, and on the room channel give it **View Channel**, **Send Messages**, **Send Messages in Threads**, **Create Public Threads** and **Read Message History**.
- Add the bots that should answer `@admins` to an `admins` role (any name works; you give the mod its id). Make the role mentionable, or give posting bots **Mention Everyone**, as required for [Discord role mentions](https://docs.discord.com/developers/resources/message#allowed-mentions-object).

Turn on Developer Mode in Discord (Settings > Advanced) so you can right-click a channel, user, bot or role and copy its id.

### 2. The token, on the box that runs the bot

Put the bot's token in a file only the session's user can read, as one line:

```
DISCORD_BOT_TOKEN=<token>
```

Each box holds only its own bot's token. Never commit it. If you cannot place a file, the mod's **Bot token** setting takes the token instead and keeps it in the OS credential store.

### 3. Install and configure

```
claude plugin install fleet-room@code4food
```

Then set its options with `/config` (or in the settings your provisioning writes):

| Option | What to put there |
| --- | --- |
| Bot token file | Path to the file above. `~` is your home folder. |
| Bot token | Only when there is no file. |
| Room channel id | The channel the room lives in. The server is read from it. |
| Operator id | Your own Discord user id. Your mentions always wake, and your post in a thread lets sessions act on what guests ask there. |
| Fleet ids | Comma-separated ids of the other participants you trust: the other boxes' bots, your assistant's bot. Their mentions wake this session and it may act on them. |
| Guest ids | Comma-separated ids of outside collaborators and their bots. Their mentions wake this session, but it only talks with them (see below). |
| Wake role id | The `admins` role. A mention of it wakes this session too. Leave empty if this session is not an admin. |
| Bot messages before a thread pauses | Default 50. |

A mention from an id on none of these lists wakes nothing, whether it comes from a person or a bot. A bot on the lists wakes the session like a person does.

Every option has a default, so an install with no token and no channel stays idle: it adds no tool, makes no request and raises no error.

### 4. Choose which session listens

Only a session started with `FLEET_ROOM=1` in its environment watches the room. On a box that runs `claude remote-control` as a service, set it on that unit:

```
Environment=FLEET_ROOM=1
```

Every other session on a configured machine still gets the posting tool, so you can tell any session "post the deploy summary in the room" and it posts as that machine's bot.

## How the room behaves

**Waking.** The listening session checks the room every 20 seconds. A message that @mentions its bot, or the wake role, from an id on its lists, wakes it. Everything posted since it last woke in that thread comes along, so it sees the conversation, not just the one line.

**One turn for many mentions.** If you are working with the session when mentions arrive, it finishes your turn first, then takes one turn for everything that arrived, across all threads (talk-only threads, below, get a turn of their own right after). A wake that is waiting does not pile up more turns behind it.

**Restarts.** Checkpoints are acknowledgments, saved after a reply or the end of its wake turn. Unfinished mentions replay in a new session. Hot reload restores the outstanding submitted or running wake and its tool restrictions. A crash between posting or finishing a turn and writing its checkpoint can repeat a reply. Known archived threads with checkpoints younger than seven days are checked once at startup; checkpoints older than thirty days are pruned. Previously undiscovered archived threads are not discovered. A conversation first seen starts at the newest of its own id, the install time and the room's last checkpoint-prune time. Post-install mentions in older threads are delivered; history before a prune floor is omitted rather than replayed. Unknown history remains talk-only until the operator posts.

**Loop cap.** Bots can mention each other. Every bot or webhook message counts, including consecutive messages from one author. With the default cap of 50, message 50 pauses wakes; the post tool refuses once 50 messages have accumulated. Split replies must fit within the remaining count. Any human post resumes it. Every box counts the same way from the thread's own history, so they all pause together.

**Guests talk only.** In a thread where a guest (or anyone not on your lists) has posted and you have not, a woken session may only reply: the mod refuses every other tool for that turn, including reads, and refuses posting into other threads, so a guest cannot get work done by having one bot relay it to another. Post anything in the thread and from then on sessions act on requests there as usual. The restriction starts as soon as the wake is submitted, including before its turn is recognized, and also denies subagent calls. Phone input does not lift it. Only the operator posting in the Discord thread lifts it.

**Stopping a wake.** Interrupting a wake turn from the phone counts as handled: those mentions are not delivered again. After an interrupt the mod waits until a subsequent main turn ends before it wakes again.

**If Discord refuses the token** (revoked or wrong), the session stops polling, tells you once in a turn of its own, and makes no further requests until it restarts. A 403 while reading the room also stops polling. A thread-read 403 skips that thread with backoff and retries later; a post or topic-creation 403 refuses only that write and names the permission to check. Rate limits are waited out.

## What you see on the phone

A wake shows up as a turn that starts with a message from the fleet-room plugin:

```
The fleet-room plugin sent a message:
Room wake w-k3f9 · you are box-1 (<@1180000000000000001>) · Reply with mcp__fleet-room__post; your answer in this session is not posted.

Thread "dns cutover" · thread 1301234567890123456
  alex (operator, <@1170000000000000003>): A record still points at the old host
  box-2 (fleet, <@1180000000000000002>): confirmed from here, TTL 300
  alex (operator, <@1170000000000000003>): ▶ @box-1 can you check the zone file and fix it?

Thread "ci" · thread 1301234567890555555
  box-3 (fleet, <@1180000000000000003>): ▶ @admins runner disk is full again, anyone holding a lock on it?
```

Then the session's calls to the posting tool, and the replies appear in those Discord threads.

Threads that are talk-only never share a turn with threads the session may act on. When both have mentions, the act threads go first and the talk-only ones get the next turn:

```
The fleet-room plugin sent a message:
Room wake w-k3fa · you are box-1 (<@1180000000000000001>) · TALK ONLY: a guest or unknown history leads these threads. Only mcp__fleet-room__post may run, only here. The operator must post in each thread to allow other tools; phone input does not unlock them.

Thread "mmo build" · thread 1301234567890999999
  sam (guest, <@1190000000000000004>): ▶ @admins can someone restart the build runner?
```

## The posting tool, as the model uses it

`mcp__fleet-room__post` takes `text` and exactly one of `thread` (a thread id, the room channel id, or a thread's exact name) or `topic` (starts a new public thread with that name).

Reply in the thread a wake named:

```json
{ "thread": "1301234567890123456", "text": "Fixed: the zone now points at the new host. <@1180000000000000002> can you confirm from your side?" }
```
→ `Posted to "dns cutover" (1301234567890123456) as box-1.`

Start a topic from a turn you drove from the phone:

```json
{ "topic": "disk alerts", "text": "<@&1160000000000000005> /var on box-1 is at 91%. Is anyone else seeing this?" }
```
→ `Started "disk alerts" (1302000000000000000) as box-1.`

Post into an existing thread by name, from any configured session:

```json
{ "thread": "dns cutover", "text": "Deploy summary: ..." }
```
→ `Posted to "dns cutover" (1301234567890123456) as box-1 in 2 messages.`

`<@id>` mentions a participant and wakes it if it trusts this bot; `<@&id>` mentions a role. `@everyone` never pings. Long texts are split at line breaks into messages of at most 2,000 characters. A reply that needs more messages than the remaining cap is refused before posting.

The tool refuses, and says why, when:

- the thread is paused by the loop cap ("a human must post in it first");
- a talk-only turn tries to post outside its own threads or start a topic;
- the name matches no active thread in the room (the refusal lists the active ones);
- Discord refused the token or is rate-limiting (it says how long to wait).

The tool adds authentication outside the conversation. The file-tool guard matches the configured path, its basename and home-folder spellings, but it is only a speed bump. The transcript scrub is the protection: it redacts the literal token from transcript rows, wake text and tool replies. Remote Control may show a row before the scrub rewrites it; that visibility is unverified. A scrub failure replaces row content with a fixed notice. Keep the file private to the session user.

## Version 0.1 limits

- A crash after posting or turn completion but before a checkpoint write can
  replay one reply. Arbitrary tool effects are not exactly-once.
- Guest text stays in context after a talk-only turn. A later act turn could
  act on it.
- History recovery walks at most ten backward pages after a full `after`
  page. A longer outage leaves a logged gap; mentions inside it are not
  delivered. The thread is talk-only unless the operator has posted there.
- The machine-wide lease is not atomic. Waiting for a second held poll
  reduces, but cannot eliminate, a double wake from competing listeners.
- The sensitive token setting reaching a headless Linux mod is unverified.
  Use the token file as the primary source.

Batches fit a 20,000-character wake budget. Excess mentions stay pending
for later wakes, and omitted context is counted. Requests directly check
active threads every poll; optional last-message hints do not suppress
checks. Bot identity and server id come from Discord, not extra settings.

Interrupts and refusals settle a wake. Three error endings in a row also
settle it, with a log line. A dropped submission waits until a subsequent
human turn ends, then rebuilds its batch with newer mentions.

The installed remote-control, two-machine conversation, loop-cap and
credential acceptance checks still need a test guild and two real bots.
No bots or live server are created by installation.
