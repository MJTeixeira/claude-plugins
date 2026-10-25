# seat-router

A Claude Code mod that runs some subagents on other model families. An Agent call whose prompt
starts with a seat line runs on the Codex CLI or the Antigravity CLI (`agy`) instead of Claude;
its report comes back to the session as a message when the seat finishes.

```
seat: [<cli or family>] <light|standard|heavy> <reviewer|owner>
<the brief>
```

A sized line leaves the model to the mod: it tries the size's candidates in order and runs the
first one whose quota is not busy, else the least loaded. Naming a CLI (`codex`, `agy`) or a model
family (`gpt`, `gemini`, `claude`) keeps the seat there unless all of it is out of quota.

```
seat: <codex|agy> <model> <effort> <reviewer|owner>
<the brief>
```

An explicit line runs exactly that model; it moves only when that vendor is out, then along the
candidates of the size its effort stands for (low or medium is light, high standard, xhigh or max
heavy).

- `reviewer` seats are sandboxed to their folder, with no network and no `.git` writes.
- `owner` seats may commit, push and open pull requests; force-push, `git reset --hard`,
  `rm -rf`, `gh pr merge --admin` and `gh repo delete` stay refused.

The session learns the seat line from the mod itself: you do not write rules for it. The mod also
shows running seats and each vendor's quota above the prompt, and `/seats` opens a pane with one
card per seat.

## Requirements

- Node.js on the `PATH`; the mod launches seats and reads quota through it.
- At least one of the two CLIs, installed and logged in: `codex` (Codex CLI) and `agy`
  (Antigravity CLI). The mod looks for each with `--version` when a session starts and only
  offers the ones it finds. With neither, it adds nothing to the session.

## Install

```
/plugin marketplace add MJTeixeira/claude-plugins
/plugin install seat-router@code4food
```

## Settings

In `/config`, or with `claude plugin configure seat-router`:

| Setting | Default | What it does |
| --- | --- | --- |
| `heavySeats` | `codex gpt-5.6-terra xhigh, agy claude-opus-5-5 high, agy gemini-4-argon high, claude opus xhigh` | The candidates of a heavy seat, in the order tried. |
| `standardSeats` | `codex gpt-5.6-terra high, agy claude-sonnet-5-5 high, agy gemini-3.8-flash high, claude sonnet high` | The same for standard. |
| `lightSeats` | `codex gpt-6-luna medium, agy gemini-3.8-flash medium, agy claude-sonnet-5-5 low, claude haiku` | The same for light. |
| `busyAt` | `80` | A candidate is busy when its 5-hour or weekly window is used this much, or its week is used faster than it has passed. |
| `mixFanouts` | on | Asks the session to add one seat per other model family beside the Claude agents in every review or verification fan-out. |

A candidate is `<codex|agy|claude> <model> [effort]`; `claude` entries run as Claude subagents.
A model's family comes from its name, so `agy claude-opus-5-5` counts as Claude, not as variety.
