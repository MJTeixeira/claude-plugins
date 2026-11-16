# conduit

A Claude Code mod that pairs the session you work in with a companion: another of your own Claude Code sessions. The companion reads short digests of your turns and answers with cards in a sidebar tab: a better prompt you can send with one press, a note with context, or a yes/no question. Cards never enter your session's transcript, and the session's model never reads them. Nothing reaches the conversation unless you press a button.

The companion is any session you already run: a second terminal on this machine, or a Remote Control session on another machine. It needs nothing installed, and no particular project, persona or tool. Each digest tells it how to answer.

conduit is built on Claude Code's native cross-session messages. A digest goes out as an ordinary message to the companion. The companion's turn text does not come back: to answer, it sends a message to your session with its own send tool, and sending nothing is how it stays quiet. conduit catches that message before your session reads it and draws it as cards.

## One Claude account

Both sessions must be signed in to the same Claude account. conduit can only reach a session that your session's native peer list shows, and that list holds only your own sessions. A Remote Control session on another machine shows there only when both sessions are signed in with claude.ai.

## Install

```
/plugin marketplace add MJTeixeira/claude-plugins
/plugin install conduit@code4food
```

Install it in the session you want watched. The companion needs nothing.

## Choosing the companion

1. Start the companion session and give it a name your peer list will show: on this machine, any running session; on another machine, run it under `claude remote-control`.
2. In the session to be watched, run `/conduit on <name>`. If no session by that name is in the peer list, conduit refuses and lists the names it does see.
3. The conduit tab opens. With another plugin's pane already open, it opens as a second tab beside that pane; alone, it is the sidebar.

To pair with the same companion every time, set **Companion session** in the plugin's settings (`/config`, or the install screen) and turn on **Pair with the companion when a session starts**. `/conduit on` with no name also uses that setting.

## Modes

| Mode | What is sent | How the companion answers |
|---|---|---|
| `on-call` (the default) | Nothing, until you press **Ask** or run `/conduit ask [question]`. Then everything since the last send, with your question. | Cards |
| `watch` | One digest each time a turn ends. With **Send your prompt to the companion while the session works on it** on (the default), also your prompt, 20 seconds into the turn; a turn that ends sooner carries it in its turn-end digest instead. | On the prompt, only when the prompt will mislead the session; at the turn end, cards when it has something useful to say |
| `autopilot` | One digest each time a turn ends. Never a prompt digest: the companion wrote the prompt. | A `prompt` line, which conduit holds and submits as your next prompt when the turn ends (at once when the session is idle), with no button; `done` when the work is finished |
| `off` | Nothing. Not paired. | |

Switch with `/conduit on-call`, `/conduit watch`, `/conduit autopilot` or `/conduit off`, or with the tab's **Mode** selector. `/conduit off` stops sending and closes the tab.

On-call keeps the digests in your session until you ask. It keeps at most 300 rows; past that the oldest go, and the next send says how many were dropped.

### What a digest carries

Your prompts, the session's replies, each tool call's name with one short argument (a command, a file path, a URL), and errors. Never a tool's output. Each row is cut short and one digest carries at most about 8,000 characters of rows; older rows are dropped first, and the digest says how many.

Its first lines say which digest it is: your prompt while the session works on it, a turn's end, or one you asked for, and whether a turn is still running. Its closing lines tell the companion how to answer: by sending a message back with the send tool the digest's own envelope names, each card a line in the format below.

Everything a digest carries is sent to your other session, which may run on another machine. Do not pair with a session you would not show your work to.

### Autopilot

Autopilot hands the prompt box to the companion: it acts as you. It is entered only with `/conduit autopilot` or the tab's **Mode** selector, never from the settings, so no session starts driving itself.

It stops, and the tab says why, when:

- you run `/conduit off` or choose another mode,
- you press Stop (interrupt the turn),
- you start typing in the prompt box, or send a prompt of your own (see below),
- the companion sends `done`,
- it has sent **Prompts autopilot may send** prompts (20 by default; `0` means no cap),
- a permission dialog opens, under the `stop` permission setting.

A stopped autopilot goes back to `watch`. A `prompt` the companion sent that has not gone yet is dropped with it, and its card says it was not sent; one turn end sends at most one prompt.

What counts as you taking over, by surface:

- **Terminal**: a key or a paste in the prompt box, and Enter on a prompt of your own.
- **Desktop app, VS Code and phone**: sending a prompt of your own. Typing there without sending may not stop autopilot: Claude Code's mod API describes its edit event for the main prompt box's own editor only, and says a remote surface's composer changes raise nothing yet.

A prompt of your own is one you typed or sent from a phone or web client; a peer session's message, a background task's notification, a schedule and another plugin's prompt are not, and none of them stops autopilot or reaches the companion as yours.

**Permission dialogs during autopilot** follow the **Permission dialogs during autopilot** setting. `stop` (the default) ends autopilot and leaves the dialog to you. `approve` allows the tool call and goes on. A confirmation another plugin asks for is always yours: under `approve` it still stops autopilot. A tool that needs you by its nature, a question or a plan to approve, keeps its dialog under either setting.

> **Warning.** With `approve` and a cap of `0`, a session in autopilot runs tools unattended, with every permission granted, until the companion says `done` or you stop it. Use that only in a session and folder where you would accept any tool call the companion's prompts lead to.

## Cards

| Card | Buttons |
|---|---|
| `suggest` | **Send next** submits its text as your prompt when the running turn ends, or at once when the session is idle. **Edit** puts it in the prompt box instead. While a turn runs, **Stop and send** also shows: it stops the turn and submits the text at once. |
| `ask` | **Yes** / **No** sends your answer back to the companion. |
| `note` | **Dismiss**. |
| `prompt` (autopilot) | None: shown as waiting for the turn end, then as sent, or as not sent when autopilot stopped first. |

A pressed suggestion is your prompt because you chose it. The tab's title carries the count of unread cards, as `conduit (2)`, and each new card raises a toast. conduit never switches tabs by itself.

### How conduit tells the companion's replies apart

A message from another session reaches yours with the sender named only by its session address, not its name, and how the envelope names it depends on the sender's send tool: the native SendMessage tool gives `from="bridge:session_…"`, the Remote Control MCP `send_message` tool gives `from-session="session_…"`. conduit reads both as one address. So each pairing carries a random token: the digest asks the companion to start every card line with it, the first reply carrying it fixes the companion's address, and from then on only lines from that address with that token become cards. Digests still go to the companion's name, never to that address. A card line may start with a list marker or indentation, and the token may be in bold or backticks or followed by a colon. Card text sent with the Remote Control `send_message` tool arrives HTML-escaped (`&lt;`), so conduit unescapes every card. A late card carrying the token of an earlier pairing, or arriving after `/conduit off`, is dropped unread. Any other message reaches your session unchanged; when it came from the companion, the tab says so in a dim line under its name, so a reply that missed the card format does not go unseen. This is routing, not security: the channel is between your own sessions.

## The tab

From the top: the companion's lens and name, centred, and a dim line with its mood and when the last digest went (`idle · last digest 11:57`), with autopilot's count or why it stopped under it. Then **Mode** with the current mode, which you can change at any time, mid-turn included, and **Ask <name>**, which is `/conduit ask` without a question. Below a rule, "Turn running" while a turn runs, the unread count, and the line saying a companion reply had no cards. The cards come last, newest first, scrolling.

The lens is drawn from the companion's name: the same name always gives the same colour and ring pattern. It breathes while idle, narrows and turns its ring for a minute after a digest the companion has not answered, and flares when a card arrives.

- **Terminal**: the lens as block-cell pixel art, the cards as terminal text.
- **Desktop app and VS Code**: the lens as a smooth animated drawing, the cards with formatted text.
- **Phone app**: the phone does not dock panes beside the chat, so the tab opens only when you ask for it (`/conduit`). There **Mode** is a button that asks which mode to switch to. The newest card and its buttons also show above the prompt, so **Send next**, **Yes** and **No** work from the phone without opening the tab. The phone reaches the session only when it runs under Remote Control.

## Commands

| Command | Does |
|---|---|
| `/conduit` | Opens the tab. |
| `/conduit on [name]` | Pairs with the named session, or with the **Companion session** setting, and opens the tab. |
| `/conduit off` | Unpairs, stops sending, closes the tab. |
| `/conduit on-call`, `/conduit watch`, `/conduit autopilot` | Switches mode. |
| `/conduit ask [question]` | Sends what is kept, and the question. |

## Settings

| Setting | Default | |
|---|---|---|
| Companion session (`peer`) | empty | The companion's name as the peer list shows it. |
| Pair when a session starts (`startPaired`) | off | Pairs every new session with `peer`. A reload of the plugin keeps a pairing already live. |
| Starting mode (`mode`) | `on-call` | `on-call` or `watch`. Never `autopilot`. |
| Send your prompt to the companion while the session works on it (`promptDigest`) | on | Off sends one digest per turn, at its end: cheaper, but a misleading prompt is caught only after the turn. |
| Prompts autopilot may send (`autopilotTurns`) | 20 | `0` for no cap. |
| Permission dialogs during autopilot (`autopilotPermissions`) | `stop` | `stop` or `approve`. |

## Limits

- A reply may be held for approval at the companion's side when the two sessions run in different permission modes; one pair of modes has been tried and passed; the others are untested.
- The companion answers on its own turn. A busy companion answers late, and a card may arrive after the turn it is about.

## License

MIT. See `LICENSE`.
