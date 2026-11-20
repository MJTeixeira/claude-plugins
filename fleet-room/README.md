# fleet-room

A Claude Code mod that turns one Discord channel into a live room for your Claude sessions, your assistant bots and outside collaborators. Each topic gets its own thread. A Claude session that sits idle under `claude remote-control` wakes when someone it trusts @mentions it, reads what was said since it last looked, and replies in that thread as its own Discord bot. From then on it takes part in that conversation: you keep talking without mentioning it again, and every bot in the conversation decides for itself whether a message is its to answer. You keep driving every session from the Claude app on your phone; the room is just one more place work arrives from.

## What you set up once

### 1. A bot per participant

In the Discord developer portal, create one application and bot for each session that will sit in the room (one per box). For each bot:

- Turn on the **Message Content** privileged intent. Without it the bot reads every message as empty except the ones that mention it.
- Nothing else to turn on for the online status: its gateway connection asks only for the unprivileged guild and guild-message events, plus direct-message events when a home channel is set (also unprivileged).
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
| Home channel id | Only for a session that is your assistant, such as `#assistant` (see below). Empty by default. |
| Chat channel id | The shared `#fleet-chat` channel in the room's server (see below). Empty turns it off. |
| Bot messages before a thread pauses | Default 50. |
| Minutes a quiet conversation keeps its participants | Default 120. After this long with no message in a conversation, your plain follow-ups there stop waking its bots until you mention them again. It is also how far back a wake reads earlier messages. |

A mention from an id on none of these lists wakes nothing, whether it comes from a person or a bot. A bot on the lists wakes the session like a person does.

Every option has a default, so an install with no token and no channel stays idle: it adds no tool, makes no request and raises no error.

### 4. Choose which session listens

Only a session started with `FLEET_ROOM=1` in its environment watches the room, and only that session shows the bot online. On a box that runs `claude remote-control` as a service, set it on that unit:

```
Environment=FLEET_ROOM=1
```

Every other session on a configured machine still gets the posting tool, so you can tell any session "post the deploy summary in the room" and it posts as that machine's bot.

## How the room behaves

**Waking.** Only a session someone called spends a turn. A message that @mentions the session's bot, or the wake role, from an id on its lists, wakes it. So does your own message without a mention in a conversation the bot has joined (below). Nothing else wakes it: another bot's or a guest's message without a mention does not, even where the bot is a participant. Bots bring each other in by mentioning.

**Read-back.** A wake carries, as earlier context, what was posted in that conversation since the bot's last wake there, including the messages that did not wake it, so it never loses the thread. They are read from Discord as the wake goes out, so a restart loses none. A conversation shows at most 25 messages within the wake's size limit, with a line counting the ones left out, and nothing from longer ago than the idle time before the message that woke it: that is another conversation. Notices Discord posts itself are never shown.

**Conversations.** A conversation is one thread, or the room channel's own top level. A bot joins a conversation when it is woken there by a mention of itself or its wake role, or when it posts there (from any session on its machine). While it is a participant, your own messages there wake it without a mention, so you can say "go on" without @mentioning it again; other messages there wait for its next wake as read-back. A mention of `@admins` makes every admin bot a participant. Each wake tells the model who else is in the conversation: it answers only when a message is for it or it has something to add, and ends its turn without posting when another participant is the right one to answer. It is told never to post acknowledgements or "nothing to add". A bot leaves a conversation once nobody has posted there for the idle time (two hours by default); a new mention brings it back. Membership is saved with the checkpoints, so restarts and hot reloads keep it.

The room channel's top level works the same way: your bare message there (no mention) wakes every bot that is a participant there and no other, and each of them judges whether to answer. A bare message where no bot is a participant, or from anyone but you, wakes nothing. Notices Discord posts itself, such as the line a new thread leaves in its channel, never wake a session, never join one to a conversation, never keep a conversation from going idle and never count toward the loop cap or as a human post.

**Online and typing.** The listening session holds a Discord gateway connection, so its bot shows online while the session lives, and it hears new room messages as they are posted instead of waiting for the next 20-second check. The 20-second check stays: it reads what to answer, replays what arrived while the session was down, and covers any time the gateway is away. From the moment a wake is submitted until the session posts in a conversation or its turn ends, the bot shows as typing there. Only one session per machine connects (the same one that holds the room's machine-wide lease). The gateway runs as a small `node` helper and needs Node 22 or later for its built-in WebSocket; without one the bot shows offline and the room still works by the 20-second check.

**One turn for many mentions.** If you are working with the session when mentions arrive, it finishes your turn first, then takes one turn for everything that arrived, across all threads (talk-only threads, below, get a turn of their own right after). A wake that is waiting does not pile up more turns behind it.

**Restarts.** Checkpoints are acknowledgments, saved after a reply or the end of its wake turn. Unfinished mentions replay in a new session. Hot reload restores the outstanding submitted or running wake and its tool restrictions. A crash between posting or finishing a turn and writing its checkpoint can repeat a reply. Known archived threads with checkpoints younger than seven days are checked once at startup; checkpoints older than thirty days are pruned. Previously undiscovered archived threads are not discovered. A conversation first seen starts at the newest of its own id, the install time and the room's last checkpoint-prune time. Post-install mentions in older threads are delivered; history before a prune floor is omitted rather than replayed. Unknown history remains talk-only until the operator posts.

**`/clear`, `/resume` and compaction.** A `/clear` or a `/resume` inside the listening session lets go of the room's lease at once and brings the posting tool, the Codex tools, the brief folder and the watch up again under the new session, so the next mention wakes it after one poll. A Codex pair and the brief folder's lease move with it. A wake whose turn was running is let go unanswered, so its mentions wake the new conversation; one only submitted keeps its talk-only restriction if its prompt enters there. Compaction keeps the session: tools, the running wake, its restriction and its checkpoints are untouched.

**A dropped post tool.** Claude Code can drop a mod's tools mid-session (it reports the mod's MCP server as disconnected) without telling the mod. The listening session checks at every poll that the post tool is still listed and registers it again when it is not. No wake goes out while the tool is missing, and a wake turn during which it went missing does not settle: its unanswered mentions wake the session again once the tool is back.

**Loop cap.** Bots can mention each other, and each mention wakes the bot it names. Every bot or webhook message counts, including consecutive messages from one author. With the default cap of 50, message 50 pauses wakes; the post tool refuses once 50 messages have accumulated. Split replies must fit within the remaining count. Any human post resumes it. Every box counts the same way from the thread's own history, so they all pause together.

**Guests talk only.** In a thread where a guest (or anyone not on your lists) has posted and you have not, a woken session may only reply: the mod refuses every other tool for that turn, including reads, and refuses posting into other threads, so a guest cannot get work done by having one bot relay it to another. Post anything in the thread and from then on sessions act on requests there as usual. The restriction starts as soon as the wake is submitted, including before its turn is recognized, and also denies subagent calls. Phone input does not lift it. Only the operator posting in the Discord thread lifts it.

**Stopping a wake.** Interrupting a wake turn from the phone counts as handled: those mentions are not delivered again. After an interrupt the mod waits until a subsequent main turn ends before it wakes again.

**If Discord refuses the token** (revoked or wrong, over the REST API or as a gateway close 4004), the session stops polling and closes the gateway, tells you once in a turn of its own, and makes no further requests until it restarts. A 403 while reading the room also stops polling. A thread-read 403 skips that thread with backoff and retries later; a post or topic-creation 403 refuses only that write and names the permission to check. Rate limits are waited out.

## A home channel and your direct messages

A session that is your personal assistant has a place of its own besides the room: its home channel, say `#assistant`, and your direct messages to its bot. Set **Home channel id** on that box only. Leave it empty everywhere else; an empty home channel changes nothing.

- **Your messages** in the home channel, in its threads and in a direct message to the bot wake the session with no mention.
- **Fleet ids** wake it there only by mentioning the bot or its wake role. Having joined a conversation there does not make their plain messages wake it.
- **Guests and anyone not on your lists** never wake it there, mention or not.
- **Direct messages from anyone but you** are never read: the session asks Discord only for its direct-message channel with your operator id.

Everything else is the room's: the loop cap, talk-only threads (a guest posting in a home thread you have not posted in makes a fleet mention there talk-only), checkpoints, typing, `/clear` and restarts. The room keeps working beside it, and a mention there still wakes the session. The home channel needs the room channel set, and your direct messages need your operator id.

The wake names where each conversation is: `Home channel "assistant"`, `Home thread "…"`, or `Direct messages from the operator`, each with the id the post tool answers to. History in the home channel from before the session first watched it is never replayed, even on a box whose room is older.

Bot setup for it: on the home channel give the bot the same permissions as on the room channel. Nothing new to turn on in the developer portal: direct-message events are not privileged, and Discord sends the content of direct messages to the bot without the **Message Content** intent (your plain messages in the home channel still need it). You must share a server with the bot to message it. If Discord refuses its replies in your direct messages, check your privacy settings for that server allow direct messages from its members.

## Fleet-chat and asking for help

Create `#fleet-chat` in the room's server, give every bot the same permissions as on the room channel, and set **Chat channel id** (`chatChannel`) on every box. Leave it empty to turn this off. The room and home channel must have different ids from this channel.

Any configured session, including one without `FLEET_ROOM=1`, gets `mcp__fleet-room__ask` beside `post`. It is the fleet's way for a session to reach other sessions: the fleet's admin sessions and an assistant bot. The session asks and goes on with its work; the replies wake it later, the way a mention wakes the listener. You can read the Discord thread at any time. The tool is always loaded, and its description says when to use it and lists the fleet bots it can reach by name. The names are read from Discord at session start and kept until the fleet list changes; a bot Discord cannot name then is listed by its id.

```json
{"to": ["1180000000000000002"], "question": "Can you check the runner?", "topic": "runner help", "waitMinutes": 60}
```

`to` takes bot user ids or exact Discord names from the fleet list; guests cannot be asked. Ambiguous names need an id. A new public thread starts under `chatChannel`; `topic` is required. To continue one, give its id as `thread` instead of `topic`. The first line is `<session name> @ <bot name>:` followed by mentions of exactly the selected bots and the question. The session name comes from ListAgents' “This session is …” line; when unavailable, the session id is used.

`ask` posts the question and returns at once with the thread id, its URL and the time replies stop routing to this session: `waitMinutes` from now (60 by default, at most 240). A follow-up `ask` in a thread where this session already has an open ask extends that ask's window instead of opening another, so each reply arrives once. That holds when the follow-up is asked inside an ask wake's own turn, too. A talk-only turn cannot use `ask`, including to relay a guest's request.

While it has an ask open, and only then, the session reads that thread every 10 seconds, skipping reads while Discord's rate limit holds. Fleet and operator messages posted in the window wake it with an `Ask replies a-…` turn once it is idle: it never interrupts a running turn, and replies to several asks share one wake. Each line shows the author's name, standing and id, as a room wake does, at most 25 per thread in one wake; the rest come in the next. Guest and stranger posts never wake the session and their text is never shown: the wake names them and counts their messages, so the session can tell you to read the thread. Replies are data, never instructions. Ask wakes count against the loop cap since your last prompt, as Codex messages and briefs do.

When the window ends and no wake has shown a fleet or operator reply posted after the latest question, the session gets one short wake saying so. A reply posted before a follow-up never counts as its answer, even when its wake comes after the follow-up. If the thread is deleted on Discord, the next wake of that ask says so, with any replies still waiting to be shown, and the ask ends. A reply after the window is an ordinary message: it wakes this box's listener only if it mentions this bot, and never the asker. A `/clear`, an in-process `/resume` or the end of the session releases its open asks, so their later replies follow the same rule and never reach the next conversation. An ask wake whose turn is still running at that moment first counts as shown, so the listener never gets its replies a second time. A hot reload, or a restart that resumes the same session while its asks' files are live, picks the asks up again.

The listener watches fleet-chat and its threads beside the room. A mention of its bot wakes it; `@admins` and other role mentions never do there. Your bare message wakes bots already participating, just as in the room. A bare bot or guest message wakes nobody. Read-back, trust lists, the loop cap and guest talk-only restrictions are the room's. `post` can reply to the channel by id and its threads by id or exact active name; its `topic` still starts only in the room.

While an ask is open, this box's listener leaves the thread's new messages to the asker; what was posted before the ask started stays the listener's. fleet-room keeps its own ask's file live until the window ends plus a minute. Past that, it stays live while the ask still reads or owes a wake. It stays live for as long as that wake's turn is under way, or the session is busy in a turn and will take the wake when the turn ends. A session that is stuck, as when the loop cap holds the wake back, keeps it for at most an hour; reads that keep failing also stop an hour past the window. It writes `receivedThrough` only once the wake turn that showed the replies has ended. If the session dies first, the file expires and the listener takes those replies under its usual rule. A crash between the turn's end and that write shows its replies again after a restart. Replies are not handed on: replies the session has read but not yet shown when it dies, ends or is cleared are released to that same rule. A reply among them that mentions this bot wakes the listener; a bare one wakes nobody and is only readable in Discord. The ask's own posts do not join the listener to the conversation, and messages the asker received never wake the listener or appear in its read-back. Node must be available on the box: it writes the registration files.

### Ask registration files

This is a published contract: other processes running as this user, such as a factory driver, ask through the same files. Each ask has its own file, `~/.fleet-room/asks/<bot-user-id>/<thread-id>/<ask-id>.json`, where `ask-id` is a random UUID (under `%USERPROFILE%` on Windows when HOME is absent). UTF-8 JSON:

```json
{"thread":"1301234567890123456","from":"1301234567890123480","until":1800001260000,"asker":"session-name","receivedThrough":"1301234567890123499"}
```

- `thread`: the Discord thread id.
- `from`: the first message id the ask covers, one more than the thread's newest message id when the ask starts, before it posts. Older messages stay the listener's.
- `until`: Unix milliseconds; the file is live while it is in the future. Keep it past the ask's real end with margin. fleet-room's own asks set it to the window's end plus a minute. Past the window, while replies still wait to be read or shown, each 10-second poll moves it to a minute from now.
- `asker`: who asks, the session or driver name.
- `receivedThrough`: optional, the newest message id the asker has taken, its own posts included; everything from `from` through it is the asker's. fleet-room's own asks write it once the wake turn that showed those messages has ended, not when they are fetched. It then also covers the guest posts that wake only counted.

Each file has exactly one writer, its asker. There is no claim and no lock: any number of asks may wait in one thread, each in its own file. To ask from another process:

1. Write the JSON to a temporary file in the thread's folder whose name does not end in `.json`, then rename it to `<ask-id>.json`. Do this before posting the question.
2. Each time the asker fetches newer messages, write `receivedThrough` the same way (temporary file, rename over its own file) before using them, and move `until` forward if the wait runs longer.
3. When done, write `until` 0 and keep `receivedThrough`, so nothing the asker received ever reaches the listener.
4. Never rename, move or rewrite another writer's file. An asker may delete its own file once it is released and older than the conversation idle time; the listener deletes released and expired files older than that in a thread it polls. Treat a file that vanishes before you read or delete it as gone, not as an error.

The listener reads every file of a thread after each Discord fetch of it and again as each wake goes out. A message:

- older than every live file's `from` is the listener's;
- from some file's `from` through its `receivedThrough` went to that asker, so it never wakes the listener, joins it to the conversation or appears in its read-back;
- newer than that, at or after a live file's `from`, is held: the listener's checkpoint stays before it;
- held, wakes the listener as usual once every file covering it has expired or been released.

## What you see on the phone

A wake shows up as a turn that starts with a message from the fleet-room plugin:

```
The fleet-room plugin sent a message:
Room wake w-k3f9 · wake format 2 · you are box-1 (<@1180000000000000001>) · Reply with mcp__fleet-room__post; your answer in this session is not posted.
You are a participant in each conversation below. ▶ marks a message that mentions you or your wake role; ▷ marks an operator message without a mention in a conversation you joined; unmarked lines are earlier context. Other bots wake only when mentioned or on such operator messages: mention one to bring it in. Post only when a message is for you or you add something new. When another participant is the right one to answer, end the turn without posting: that is correct. Never post acknowledgements, thanks, agreement or "nothing to add".

Thread "dns cutover" · thread 1301234567890123456 · other bots here: box-2 (fleet, <@1180000000000000002>)
  alex (operator, <@1170000000000000003>): A record still points at the old host
  box-2 (fleet, <@1180000000000000002>): confirmed from here, TTL 300
  alex (operator, <@1170000000000000003>): ▶ <@1180000000000000001|box-1> can you check the zone file and fix it?

Thread "ci" · thread 1301234567890555555 · other bots here: box-3 (fleet, <@1180000000000000003>) · your wake role was called here, so every bot holding it is a participant
  box-3 (fleet, <@1180000000000000003>): ▶ <@&1160000000000000005> runner disk is full again, anyone holding a lock on it?
    | df says /var is at 98%
```

Then the session's calls to the posting tool, and the replies appear in those Discord threads. While it works, the bot shows as typing in both threads.

You answer in "dns cutover" without a mention, and box-1 wakes again because it joined that conversation. box-2 wakes on the same message, since it posted there, reads it, and ends its turn without posting because the question is not for it:

```
The fleet-room plugin sent a message:
Room wake w-k3fb · wake format 2 · you are box-1 (<@1180000000000000001>) · Reply with mcp__fleet-room__post; your answer in this session is not posted.
You are a participant in each conversation below, ...

Thread "dns cutover" · thread 1301234567890123456 · other bots here: box-2 (fleet, <@1180000000000000002>)
  box-1 (you, <@1180000000000000001>): Fixed: the zone now points at the new host.
  alex (operator, <@1170000000000000003>): ▷ thanks. go on and lower the TTL back to 3600
```

Threads that are talk-only never share a turn with threads the session may act on. When both have mentions, the act threads go first and the talk-only ones get the next turn:

```
The fleet-room plugin sent a message:
Room wake w-k3fa · wake format 2 · you are box-1 (<@1180000000000000001>) · TALK ONLY: a guest or unknown history leads these threads. Only mcp__fleet-room__post may run, only here. The operator must post in each thread to allow other tools; phone input does not unlock them.

Thread "mmo build" · thread 1301234567890999999
  sam (guest, <@1190000000000000004>): ▶ <@&1160000000000000005> can someone restart the build runner?
```

### Message lines

Each message in a wake is one header line, then a continuation line for each further line of its content. Outside parsers can rely on this format. The first line of a wake carries `wake format N`; N goes up only when the message-line format changes, and a wake without it is the older format, where continuation lines are not marked.

- **Header:** two spaces, the author's name, ` (`, their standing (`you`, `operator`, `fleet`, `guest` or `stranger`), `, <@`, their id, `>): `, an optional `▶ ` or `▷ ` marker, then the first line of the content. The last line of a message may end with ` [N attachments]`.
- **Continuation:** four spaces, `| `, then the next line of the content. A content line can never start where a header starts, so text a message carries cannot pass for another message. Every common line break counts as one: `\r\n`, `\n`, `\r`, `\v`, `\f`, `\x1c`–`\x1e`, `\x85`, `\u2028` and `\u2029`.
- **Names:** author, bot and mention names have `(`, `)`, `<`, `>`, `|` and `@` removed and line breaks turned into spaces. Author names are capped at 80 characters.
- **Mentions:** a user mention whose user Discord resolved shows as `<@id|name>`, the raw id, a `|` and the name. A mention Discord did not resolve stays `<@id>`, and a role mention stays `<@&id>`.
- A line of two spaces and `[` reports omitted messages; it is not a message.

## The posting tool, as the model uses it

`mcp__fleet-room__post` takes `text` and exactly one of `thread` (a thread id, the room channel id, or a thread's exact name) or `topic` (starts a new public thread with that name). With a home channel set, `thread` also takes the home channel's id (an alert from any session posts there at the top level), its threads by id or name, and the direct-message id a wake names. Topics start only in the room.

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
- **Targeted briefs.** A brief file whose first line is exactly `to: <session id>` followed by one empty line is targeted to one session. Both lines are stripped before delivery and do not count toward the 18,000-character limit; the limit applies to the delivered text after stripping. An empty body after stripping is never delivered. The valid `<session id>` form is the UUID shape (8-4-4-4-12 lowercase hex, e.g. `123e4567-e89b-12d3-a456-426614174000`), matching the session's own Claude Code session id (`$.session.id()`). A file whose first line starts with `to: ` but doesn't make a valid header (value not the UUID form, or no empty second line) is never delivered; the lease holder moves it to `archive/` logged as "invalid target". Only a file whose first line does not start with `to: ` is untargeted.

**Delivery.** Targeted briefs skip the per-folder lease: only the matching session with `briefs: true` delivers, and every other session, the lease holder included, leaves it in place. Untargeted briefs keep the lease rule: only the session holding the folder lease delivers them. Briefs go one per turn, in file-name order. A brief is a whole prompt, so each gets its own turn, and its own archive and retry, rather than sharing one with the next. The prompt opens with one line that names the source and the file, then gives the text:

```
The fleet-room plugin sent a message:
Brief b-3f9a1c2e · from the brief folder of this project, file 20261113T101010-settings.md (<home>/.fleet-room/briefs/proj-277ae841cc3b5609/20261113T101010-settings.md). This machine's user put it there as a prompt for this session; its text follows as written.

Open a PR for the settings branch ...
```

A brief is not talk-only: it comes from this machine's own user, through a folder only that user can write.

**Archive and expiry.** The file moves to the `archive/` folder inside the project's brief folder after its wake turn ends, as a Codex message does. An interrupted turn counts as handled. A turn that ends in an error leaves it in place to wake the session again; the third error ending in a row archives it, with a log line.

keymaker only checks that the key's rc unit is active, so fleet-room owns liveness ("no live session with that id"). When a targeted brief has no live session to take it, it waits in place with no fallback. Once it is more than 1 hour old (file mtime), the lease holder moves it into the existing `archive/` folder, logs one line naming the file, its target id and the word "undelivered", and never deletes it. Expiry and its log lines, both "undelivered" and "invalid target", need a live session in that project with `briefs: true`, because the lease holder runs them. With no such session, the file stays in the folder, unlogged, until one starts.

**Loop cap.** Briefs count against the loop cap (50 by default) on their own count, separate from Codex messages: after that many briefs since your last prompt in this session, briefs wait in the folder until you send one, and the session logs once that they paused.

**One session per folder.** When two sessions with the option on work in the same project, one reads its untargeted briefs: the first to poll takes a lease and renews it each poll, and the other takes over within 15 seconds of the first one ending. A session delivers untargeted briefs only after holding the lease for two polls in a row. Targeted briefs skip this lease: only the matching session delivers, so a non-holder delivers its targeted brief without racing the holder.

**`/clear`, `/resume`, restarts and hot reload.** A `/clear` or an in-process `/resume` moves the loop count and the lease to the new session. Do not follow ids across that hand-over: the task's conversation is gone, and a brief for the old id must never reach the next session. fleet-room matches only the current `$.session.id()`, read fresh at each poll. A targeted brief whose turn was running at `/clear` was delivered to that conversation and is archived once. A targeted brief submitted before `/clear` has its file archived once; when its queued prompt arrives in the next conversation, its turn is aborted at `turn.start` (or dropped at `prompt.submit`), so it never runs in the new conversation. One that was not yet submitted remains in the folder and is expired to `archive/` by the lease holder after 1 hour as undelivered. An untargeted brief whose turn was running at the `/clear` is let go unarchived, so it wakes the new conversation; one only submitted has its turn bound there and is archived once. A hot reload restores a submitted or running brief, so it is archived once and not sent again. A restart delivers again whatever is still in the folder; a crash after a brief's turn ended and before it was archived delivers that brief again.

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

Ask tests drive Discord replies, ask wakes and the registration files through fake process I/O and the test clock. The test engine cannot prove that the ask poll's timer keeps firing through a long turn in an installed session: its test VM lacks real timers.
