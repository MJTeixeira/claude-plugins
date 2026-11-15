# conduit

A Claude Code mod that pairs the session you work in with a companion: another of your own Claude Code sessions. The companion reads short digests of your turns and answers with cards in a sidebar tab: a better prompt you can send with one press, a note with context, or a yes/no question. Cards never enter your session's transcript, and the session's model never reads them. Nothing reaches the conversation unless you press a button.

The companion is any session you already run: a second terminal on this machine, or a Remote Control session on another machine. It needs nothing installed, and no particular project, persona or tool. Each digest tells it how to answer.

conduit is built on Claude Code's native cross-session messages. A digest goes out as an ordinary message to the companion, and the companion's plain reply comes back the same way. conduit catches that reply before your session reads it and draws it as cards.

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
| `watch` | One digest each time you submit a prompt and one each time a turn ends. | Cards, only when it has something useful to say |
| `autopilot` | The same digests as `watch`. | A `prompt` line, which conduit holds and submits as your next prompt when the turn ends (at once when the session is idle), with no button; `done` when the work is finished |
| `off` | Nothing. Not paired. | |

Switch with `/conduit on-call`, `/conduit watch`, `/conduit autopilot` or `/conduit off`, or with the buttons in the tab. `/conduit off` stops sending and closes the tab.

On-call keeps the digests in your session until you ask. It keeps at most 300 rows; past that the oldest go, and the next send says how many were dropped.

### What a digest carries

Your prompts, the session's replies, each tool call's name with one short argument (a command, a file path, a URL), and errors. Never a tool's output. Each row is cut short and one digest carries at most about 8,000 characters of rows; older rows are dropped first, and the digest says how many. Its closing lines tell the companion the card format.

Everything a digest carries is sent to your other session, which may run on another machine. Do not pair with a session you would not show your work to.

### Autopilot

Autopilot hands the prompt box to the companion: it acts as you. It is entered only with `/conduit autopilot` or the tab's button, never from the settings, so no session starts driving itself.

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
| `suggest` | **Send next** submits its text as your prompt when the running turn ends, or at once when the session is idle. **Edit** puts it in the prompt box instead. |
| `ask` | **Yes** / **No** sends your answer back to the companion. |
| `note` | **Dismiss**. |
| `prompt` (autopilot) | None: shown as waiting for the turn end, then as sent, or as not sent when autopilot stopped first. |

A pressed suggestion is your prompt because you chose it. The tab's title carries the count of unread cards, as `conduit (2)`, and each new card raises a toast. conduit never switches tabs by itself.

### How conduit tells the companion's replies apart

A message from another session reaches yours with the sender named only by its session address, not its name. So each pairing carries a random token: the digest asks the companion to start every card line with it, the first reply carrying it fixes the companion's address, and from then on only lines from that address with that token become cards. A card line may start with a list marker, and the token may be in bold or backticks or followed by a colon. A late card carrying the token of an earlier pairing, or arriving after `/conduit off`, is dropped unread. Any other message, from that session or another, reaches your session unchanged. This is routing, not security: the channel is between your own sessions.

## The tab

The companion's avatar sits at the top left with its name and mode beside it, and the cards fill the space below, scrolling, so long answers get the room. The avatar is a lens drawn from the companion's name: the same name always gives the same colour and ring pattern. It breathes while idle, narrows and turns its ring for a minute after a digest the companion has not answered, and flares when a card arrives.

- **Terminal**: the lens as block-cell pixel art, the cards as terminal text.
- **Desktop app and VS Code**: the lens as a smooth animated drawing, the cards with formatted text.
- **Phone app**: the phone does not dock panes beside the chat, so the tab opens only when you ask for it (`/conduit`). The newest card and its buttons also show above the prompt, so **Send next**, **Yes** and **No** work from the phone without opening the tab. The phone reaches the session only when it runs under Remote Control.

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
| Prompts autopilot may send (`autopilotTurns`) | 20 | `0` for no cap. |
| Permission dialogs during autopilot (`autopilotPermissions`) | `stop` | `stop` or `approve`. |

## Limits

- A reply may be held for approval at the companion's side when the two sessions run in different permission modes; one pair of modes has been tried and passed; the others are untested.
- The companion answers on its own turn. A busy companion answers late, and a card may arrive after the turn it is about.

## License

MIT. See `LICENSE`.
