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

- `reviewer` seats are sandboxed to their folder, with no network and no `.git` writes. A codex
  reviewer also runs without your `~/.codex/config.toml` (so none of your codex MCP servers start)
  and with codex's apps, plugins and web search off. This needs codex-cli 0.163 or later; an older
  codex refuses the flags and the seat moves to its next model.
- On Windows a codex reviewer runs codex's unelevated sandbox, and codex seats start without the
  `WindowsApps` folders on PATH (the Store's `pwsh.exe` cannot start inside that sandbox). The
  sandbox cannot write to a folder whose path has non-ASCII letters, so when your profile path has
  them, seat folders go under `%PUBLIC%\seat-router`, which every local user of the machine can read.
  An owner seat on a repo whose path has non-ASCII letters still cannot write there.
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

Nothing to set: leave every field as it is on the install screen. Each size starts as `auto`: the mod asks
the CLIs you have for their models when a session starts and tries, in order, codex's default model, agy's
Gemini Flash, then Claude, at the size's effort: light low, standard medium, heavy high, as far as each model
goes (codex ships its default model at low). Claude runs sonnet high for light, opus medium for standard and
opus high for heavy.

To choose which model a size tries first, run `/seats setup`: it asks once per size and offers the models
your CLIs report. Pick one, keep **Auto**, or type `<codex|agy|claude> <model> [effort]` under Other.

The fields themselves, in `/config` or with `claude plugin configure seat-router`:

| Setting | Default | What it does |
| --- | --- | --- |
| `heavySeats`, `standardSeats`, `lightSeats` | `auto` | The models a size tries, in order: `auto`, or comma-separated `<codex\|agy\|claude> <model> [effort]`. |
| `busyAt` | `80` | A model is busy once its 5-hour or weekly quota is this used, or its week is used faster than it has passed; a sized seat then tries the next. |
| `mixFanouts` | on | Asks the session to add one seat per other model family beside the Claude agents in every review or verification fan-out. |

A model's family comes from its name, so `agy claude-opus-5-5` counts as Claude, not as variety.
