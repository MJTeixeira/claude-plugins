# fleet-room

A Claude Code mod that turns one Discord channel into a live room for your Claude sessions, your assistant bots and outside collaborators. Each topic gets its own thread. A Claude session that sits idle under `claude remote-control` wakes when someone it trusts @mentions it, reads what was said since it last looked, and replies in that thread as its own Discord bot. From then on it takes part in that conversation: you keep talking without mentioning it again, and every bot in the conversation decides for itself whether a message is its to answer. You keep driving every session from the Claude app on your phone; the room is just one more place work arrives from.

## What you set up once

### 1. A bot per participant

In the Discord developer portal, create one application and bot for each session that will sit in the room (one per box). For each bot:

- Turn on the **Message Content** privileged intent. Without it the bot reads every message as empty except the ones that mention it.
- Nothing else to turn on for the online status: its gateway connection asks only for the unprivileged guild and guild-message events.
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
| Minutes a quiet conversation keeps its participants | Default 120. After this long with no message in a conversation, its bots stop waking on every message there until they are mentioned again. |

A mention from an id on none of these lists wakes nothing, whether it comes from a person or a bot. A bot on the lists wakes the session like a person does.

Every option has a default, so an install with no token and no channel stays idle: it adds no tool, makes no request and raises no error.

### 4. Choose which session listens

Only a session started with `FLEET_ROOM=1` in its environment watches the room, and only that session shows the bot online. On a box that runs `claude remote-control` as a service, set it on that unit:

```
Environment=FLEET_ROOM=1
```

Every other session on a configured machine still gets the posting tool, so you can tell any session "post the deploy summary in the room" and it posts as that machine's bot.

## How the room behaves

**Waking.** A message that @mentions the session's bot, or the wake role, from an id on its lists, wakes it. Everything posted since it last woke in that thread comes along, so it sees the conversation, not just the one line.

**Conversations.** A conversation is one thread, or the room channel's own top level. A bot joins a conversation when it is woken there by a mention of itself or its wake role, or when it posts there (from any session on its machine). While it is a participant, every new message there from an id on its lists wakes it, mention or not, so you can say "go on" without @mentioning it again. A mention of `@admins` makes every admin bot a participant. Each wake tells the model who else is in the conversation and that the others read the same messages: it answers only when a message is for it or it has something to add, and ends its turn without posting when another participant is the right one to answer. It is told never to post acknowledgements or "nothing to add". A bot leaves a conversation once nobody has posted there for the idle time (two hours by default); a new mention brings it back. Membership is saved with the checkpoints, so restarts and hot reloads keep it.

The room channel's top level works the same way: a bare message there (no mention) wakes every bot that is a participant there and no other, and each of them judges whether to answer. A bare message where no bot is a participant wakes nothing.

**Online and typing.** The listening session holds a Discord gateway connection, so its bot shows online while the session lives, and it hears new room messages as they are posted instead of waiting for the next 20-second check. The 20-second check stays: it reads what to answer, replays what arrived while the session was down, and covers any time the gateway is away. From the moment a wake is submitted until the session posts in a conversation or its turn ends, the bot shows as typing there. Only one session per machine connects (the same one that holds the room's machine-wide lease). The gateway runs as a small `node` helper and needs Node 22 or later for its built-in WebSocket; without one the bot shows offline and the room still works by the 20-second check.

**One turn for many mentions.** If you are working with the session when mentions arrive, it finishes your turn first, then takes one turn for everything that arrived, across all threads (talk-only threads, below, get a turn of their own right after). A wake that is waiting does not pile up more turns behind it.

**Restarts.** Checkpoints are acknowledgments, saved after a reply or the end of its wake turn. Unfinished mentions replay in a new session. Hot reload restores the outstanding submitted or running wake and its tool restrictions. A crash between posting or finishing a turn and writing its checkpoint can repeat a reply. Known archived threads with checkpoints younger than seven days are checked once at startup; checkpoints older than thirty days are pruned. Previously undiscovered archived threads are not discovered. A conversation first seen starts at the newest of its own id, the install time and the room's last checkpoint-prune time. Post-install mentions in older threads are delivered; history before a prune floor is omitted rather than replayed. Unknown history remains talk-only until the operator posts.

**`/clear`, `/resume` and compaction.** A `/clear` or a `/resume` inside the listening session lets go of the room's lease at once and brings the posting tool, the Codex tools, the brief folder and the watch up again under the new session, so the next mention wakes it after one poll. A Codex pair and the brief folder's lease move with it. A wake whose turn was running is let go unanswered, so its mentions wake the new conversation; one only submitted keeps its talk-only restriction if its prompt enters there. Compaction keeps the session: tools, the running wake, its restriction and its checkpoints are untouched.

**A dropped post tool.** Claude Code can drop a mod's tools mid-session (it reports the mod's MCP server as disconnected) without telling the mod. The listening session checks at every poll that the post tool is still listed and registers it again when it is not. No wake goes out while the tool is missing, and a wake turn during which it went missing does not settle: its unanswered mentions wake the session again once the tool is back.

**Loop cap.** Bots can mention each other, and two bots in one conversation wake on each other's posts. Every bot or webhook message counts, including consecutive messages from one author. With the default cap of 50, message 50 pauses wakes; the post tool refuses once 50 messages have accumulated. Split replies must fit within the remaining count. Any human post resumes it. Every box counts the same way from the thread's own history, so they all pause together.

**Guests talk only.** In a thread where a guest (or anyone not on your lists) has posted and you have not, a woken session may only reply: the mod refuses every other tool for that turn, including reads, and refuses posting into other threads, so a guest cannot get work done by having one bot relay it to another. Post anything in the thread and from then on sessions act on requests there as usual. The restriction starts as soon as the wake is submitted, including before its turn is recognized, and also denies subagent calls. Phone input does not lift it. Only the operator posting in the Discord thread lifts it.

**Stopping a wake.** Interrupting a wake turn from the phone counts as handled: those mentions are not delivered again. After an interrupt the mod waits until a subsequent main turn ends before it wakes again.

**If Discord refuses the token** (revoked or wrong, over the REST API or as a gateway close 4004), the session stops polling and closes the gateway, tells you once in a turn of its own, and makes no further requests until it restarts. A 403 while reading the room also stops polling. A thread-read 403 skips that thread with backoff and retries later; a post or topic-creation 403 refuses only that write and names the permission to check. Rate limits are waited out.

## What you see on the phone

A wake shows up as a turn that starts with a message from the fleet-room plugin:

```
The fleet-room plugin sent a message:
Room wake w-k3f9 · you are box-1 (<@1180000000000000001>) · Reply with mcp__fleet-room__post; your answer in this session is not posted.
You are a participant in each conversation below, and the other bots listed there read the same messages. ▶ marks a message that mentions you or your wake role; ▷ marks a new message in a conversation you joined; unmarked lines are earlier context. Post only when a message is for you or you add something new. When another participant is the right one to answer, end the turn without posting: that is correct. Never post acknowledgements, thanks, agreement or "nothing to add".

Thread "dns cutover" · thread 1301234567890123456 · other bots here: box-2 (fleet, <@1180000000000000002>)
  alex (operator, <@1170000000000000003>): A record still points at the old host
  box-2 (fleet, <@1180000000000000002>): confirmed from here, TTL 300
  alex (operator, <@1170000000000000003>): ▶ @box-1 can you check the zone file and fix it?

Thread "ci" · thread 1301234567890555555 · other bots here: box-3 (fleet, <@1180000000000000003>) · your wake role was called here, so every bot holding it is a participant
  box-3 (fleet, <@1180000000000000003>): ▶ @admins runner disk is full again, anyone holding a lock on it?
```

Then the session's calls to the posting tool, and the replies appear in those Discord threads. While it works, the bot shows as typing in both threads.

You answer in "dns cutover" without a mention, and box-1 wakes again because it joined that conversation. box-2 wakes on the same message, since it posted there, reads it, and ends its turn without posting because the question is not for it:

```
The fleet-room plugin sent a message:
Room wake w-k3fb · you are box-1 (<@1180000000000000001>) · Reply with mcp__fleet-room__post; your answer in this session is not posted.
You are a participant in each conversation below, ...

Thread "dns cutover" · thread 1301234567890123456 · other bots here: box-2 (fleet, <@1180000000000000002>)
  box-1 (you, <@1180000000000000001>): Fixed: the zone now points at the new host.
  alex (operator, <@1170000000000000003>): ▷ thanks. go on and lower the TTL back to 3600
```

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

The tool adds authentication outside the conversation. The file-tool guard reads only a tool's own arguments, never its description. It refuses the configured path and its home-folder spellings, a glob in a path under the token file's folder (`~/secrets/*.env`), and the file's bare name only when the same input also names that folder (`cd ~/secrets && cat room.env`); a name alone, as in a PR body, passes. It stops accidents in plain commands and is only a speed bump. The transcript scrub is the protection: it redacts the literal token from transcript rows, wake text and tool replies. Remote Control may show a row before the scrub rewrites it; that visibility is unverified. A scrub failure replaces row content with a fixed notice. Keep the file private to the session user.

## Local room with a Codex app chat

One Claude Code session and one Codex desktop-app chat working in the same project folder can message each other, either side first, answering whenever they get to it. This needs no Discord setting, no `FLEET_ROOM=1` and nothing on the Codex side; a session that is never paired is left alone.

Start it by telling the session which chat to talk to, for example "pair with the Codex chat that is building the settings prototype". It lists the Codex chats in this folder, proposes one, and pairs only once you confirm. Chats are paired by UUID: the app's auto-generated titles do not resolve in `codex queue`.

Pairing sends Codex an intro. Every message the session sends ends with the shell command Codex runs to answer, so Codex keeps it after compacting its context. Codex's messages land in `.fleet-room/inbox/` inside the project, because the Codex sandbox cannot write outside it; the folder is added to `.git/info/exclude`, never to `.gitignore`. Each message wakes the session like a room mention, and is moved to `.fleet-room/archive/` after its wake turn ends.

A Codex app chat left idle for hours can stop taking queued messages until someone types in it: a chat idle about seven hours did not start on a queued message until the owner typed in the app. When Codex has not taken a message up two minutes after it was sent, the session is told and asks you to open or poke that chat.

The loop cap counts Codex messages too: after the cap (50 by default) since your last prompt in this session, Codex messages wait in the inbox until you send one. What you type in the Codex app does not reset it.

The Windows reply command is a PowerShell here-string: a line of the message that starts with `'@` ends it early. On macOS and Linux a line that is exactly `FLEET_ROOM_END` does the same.

## Briefs from a local file

A brief is a prompt for a session, written as a file into a folder of the box user's own. Another tool on the same machine (a dispatcher, a script, a cron job) hands a session work by dropping a file, and the session takes it as a prompt from its user, the same way it takes a room mention: in a turn of its own, after any turn you are running. It needs no Discord setting, no `FLEET_ROOM=1` and no Codex pair.

**The option.** Turn on **Wake on brief files** (`briefs: true`). It is off by default; a session with it off never looks at the folder and makes none. Set it per machine like the other options, only on a box that is meant to take briefs.

**The folder.** `~/.fleet-room/briefs/<key>/`, one per project, outside the project itself (on Windows, under `%USERPROFILE%`). A sandbox that lets an agent write only inside the project (Codex's, for one) cannot write there; any other process running as the box user can, the same trust as the rest of the box. It is not the Codex inbox (`.fleet-room/inbox/` in the project), so the two never take each other's files.

**The key.** A writer computes `<key>` from the project's path alone:

1. Resolve the project root to its real path: absolute, every symbolic link followed (`realpath`), no trailing separator. A project reached through a link shares the folder of its real path.
2. Hash: the SHA-256 of the real path's UTF-8 bytes (no trailing newline), as lowercase hex; keep the first 16 digits.
3. Slug: the real path's last part, keeping only the characters `A-Z`, `a-z`, `0-9`, `.`, `_` and `-`, at most the first 64 of them.
4. The key is `<slug>-<hash>`, or the hash alone when the slug is empty.

For `/work/proj`: `printf '%s' /work/proj | shasum -a 256` starts `277ae841cc3b5609`, so the key is `proj-277ae841cc3b5609` and the folder `~/.fleet-room/briefs/proj-277ae841cc3b5609/`. The slug only makes the name readable; the hash keeps `/a/b-c` and `/a-b/c` in folders of their own.

**Permissions.** The session makes `~/.fleet-room/briefs/` and its project's folder with mode 700 where they are missing. Before it delivers a brief it checks both: each has to be a real directory (not a symbolic link), owned by the session's own uid, and writable by neither its group nor others. A folder that fails delivers nothing, and the session logs one line saying which folder and why; fix it (`chmod 700`, or remove a planted link) and the next poll delivers. A brief file that is itself a symbolic link is never read. On Windows only the real-directory check applies; the folder takes the access list of the user's profile.

**The file contract.**

- One file is one brief. Its name ends in `.md` and does not start with a dot. A name that sorts by time, such as `20261113T101010-settings.md`, keeps briefs in the order they were written; reuse no name, since the archive keeps one file per name.
- Write it atomically: write to a temporary name in the same folder that starts with a dot or does not end in `.md` (`.settings.md.tmp`), then rename it to its final name. Temporary names are never read. A file also has to hold its size and time across two polls (5 seconds apart) before it is read, so a writer that skips the rename is still not read half-done.
- UTF-8 text, delivered as written (a leading byte-order mark and trailing whitespace are dropped). An empty file is never delivered. A brief longer than 18,000 characters is cut there, and the wake names the archived file that holds the whole text.

**Delivery.** Briefs go one per turn, in file-name order. A brief is a whole prompt, so each gets its own turn, and its own archive and retry, rather than sharing one with the next. The prompt opens with one line that names the source and the file, then gives the text:

```
The fleet-room plugin sent a message:
Brief b-3f9a1c2e · from the brief folder of this project, file 20261113T101010-settings.md (<home>/.fleet-room/briefs/proj-277ae841cc3b5609/20261113T101010-settings.md). This machine's user put it there as a prompt for this session; its text follows as written.

Open a PR for the settings branch ...
```

A brief is not talk-only: it comes from this machine's own user, through a folder only that user can write.

**Archive.** The file moves to the `archive/` folder inside the project's brief folder after its wake turn ends, as a Codex message does. An interrupted turn counts as handled. A turn that ends in an error leaves it in place to wake the session again; the third error ending in a row archives it, with a log line.

**Loop cap.** Briefs count against the loop cap (50 by default) on their own count, separate from Codex messages: after that many briefs since your last prompt in this session, briefs wait in the folder until you send one, and the session logs once that they paused.

**One session per folder.** When two sessions with the option on work in the same project, one reads its briefs: the first to poll takes a lease and renews it each poll, and the other takes over within 15 seconds of the first one ending. A session delivers only after holding the lease for two polls in a row.

**`/clear`, `/resume`, restarts and hot reload.** These behave as for a Codex pair. A `/clear` or an in-process `/resume` moves the loop count and the lease to the new session. A brief whose turn was running at the `/clear` is let go unarchived, so it wakes the new conversation; one only submitted has its turn bound there and is archived once. A hot reload restores a submitted or running brief, so it is archived once and not sent again. A restart delivers again whatever is still in the folder; a crash after a brief's turn ended and before it was archived delivers that brief again.

## Version 0.2 limits

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
- Who else is in a conversation is what this bot saw: bots that posted or
  were mentioned there within the idle time, and whether the wake role was
  called. A bot that holds the wake role but has not posted is not named.
- Typing is not restored after a hot reload in the middle of a wake.
- A gateway helper that exits on its own restarts after 30 seconds, doubling
  up to ten minutes. A close other than 4004 that Discord marks as final
  (bad intents, sharding) leaves the bot offline until the session restarts;
  the room keeps working by the 20-second check.

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
