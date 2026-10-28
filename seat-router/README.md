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

- `reviewer` seats report and are not meant to commit. A codex reviewer is sandboxed to its folder, with no
  `.git` writes; its commands reach the network, so a brief can have it run `gh issue view` or fetch a
  page; an agy reviewer runs outside agy's sandbox, as an owner does. A seat called without
  `isolation: "worktree"` starts in an empty folder, so the session is told to pass the worktree for any seat that reads the repository, a review included. A codex
  reviewer also runs without your `~/.codex/config.toml` (so none of your codex MCP servers start)
  and with codex's apps, plugins and web search off. This needs codex-cli 0.163 or later; an older
  codex refuses the flags and the seat moves to its next model. An agy reviewer starts none of your
  agy MCP servers.
- Every agy seat runs outside agy's sandbox (`--dangerously-skip-permissions`), behind the guard below.
  agy offers no reviewer to a headless run, and its sandbox refuses what a seat needs: on Windows node
  cannot even read the attributes of `%APPDATA%`, so no npm-installed CLI starts, and no read grant fixes
  it. Permissions narrow later, once seats do their work. When agy refuses an action but the
  seat still answers, the answer is its report, with a line naming what agy refused; a seat that did not
  answer fails and moves on. An agy seat whose guard hook could not run fails too, though agy calls
  the run a success. agy keeps a run open while a background task the seat started (a long command,
  a timer) still runs, so the brief tells the seat to wait for or stop each one before its final answer.
  A run agy ends in error still fails, and wherever its report is given, it carries agy's error and the
  text the seat produced before it.
- On Windows a codex reviewer runs codex's mxc sandbox where it starts (Windows 11 24H2 26100.9278 or
  25H2 26200.9278 and later; each session start checks, and a seat launched before the first check
  runs the unelevated sandbox), with a temp folder of its own in the seat folder: mxc gives programs a temp
  folder they cannot clean up, and its brief tells it to set `TEMP` and `TMP` to its own. Elsewhere it runs
  codex's unelevated sandbox, where node cannot read the output of a program it starts and a program cannot
  use the folders it makes (npm scripts, node tools that capture git's output, pip and python's tempfile fail;
  its brief names the first). A codex reviewer starts without the
  `WindowsApps` folders on PATH (the Store's `pwsh.exe` cannot start inside that sandbox), so where PowerShell 7
  came from the Store it runs Windows PowerShell 5.1, which turns each non-ASCII character it pipes into a
  program into `?`; PowerShell 7 from its MSI installer runs there. agy runs its commands in Windows
  PowerShell 5.1 whatever is installed, and no agy setting picks the shell. So the brief of a codex reviewer
  and of every agy seat says its shell may be 5.1 and tells it to write files with its file tools or with
  Python, never through a pipe. A codex owner keeps the `WindowsApps` folders on PATH and runs PowerShell 7;
  on a machine without PowerShell 7 it runs 5.1 with no such note, so install PowerShell 7 there. codex seats
  run PowerShell without your profile (`-NoProfile`; PowerShell 5.1 misreads a UTF-8 profile without a BOM),
  and every codex and agy seat, and a Claude account owner, runs Python in UTF-8 mode (`PYTHONUTF8=1`), so a
  script's file reads and writes keep non-ASCII text. The
  sandbox cannot write to a folder whose path has non-ASCII letters, so when your profile path has
  them, seat folders go under `%PUBLIC%\seat-router`, which every local user of the machine can read.
- `owner` seats may commit, push and open pull requests, with your codex and agy config. Their commands
  reach the network, `.git`, Docker and the rest of the machine, as a Claude account owner's do. A codex
  owner runs outside codex's sandbox (`danger-full-access`). An agy owner runs outside its sandbox (`--dangerously-skip-permissions`), as an agy reviewer does. Force-push, `git reset --hard`, `rm -rf`,
  `gh pr merge --admin` and `gh repo delete` stay refused, however the command spells them
  (`git -C . reset --hard`, `rm -fr`), and so do `git worktree remove` and `git worktree move` of any
  worktree: another is someone else's checkout, and the mod removes the seat's own when it ends. So do
  `git clean -f`, `git checkout`, `git restore` and a forced `git switch` that `-C`, `--work-tree` or
  `GIT_WORK_TREE` aims at a directory other than the one the command runs in, and `git branch -D` of any
  branch, which another agent may own (`git branch -d` keeps unmerged commits and passes). A PreToolUse hook (`bin/owner-guard.mjs`) checks every command line, and
  the brief tells the seat a refusal is final, since python, node or a script could reach the same result
  (it refuses with a deny decision, never exit 2, which codex on Windows reports as 1 and lets pass).
  One force push passes: `--force-with-lease=<branch>:<sha>` onto the branch checked out where the
  command runs, when that is not `main`, `master`, `dev`, `develop` or `trunk`, as a rebase flow needs. An owner seat whose turn falls to Claude runs as a Claude subagent, and the mod refuses the same commands in its Bash and PowerShell calls. A codex owner runs with `--dangerously-bypass-hook-trust`, since codex runs a
  hook from the command line only past its trust check; for that run codex also runs any hook in your
  codex config or the repo's `.codex/` that you have not trusted.

## Other Claude accounts

```
seat: <account> <light|standard|heavy> <reviewer|owner>
<the brief>
```

A second Claude subscription on the same machine (a work account, say) lives in its own config
folder, the one `CLAUDE_CONFIG_DIR` points at when you run it. `/seats setup` finds the `~/.claude-<name>`
folders that are logged in and offers them, named after the folder; one kept elsewhere is typed
under Other. Once listed under `claudeAccounts`, a seat line naming it runs the size's Claude model (sonnet high for light, opus medium for
standard, opus high for heavy) as `claude -p` on that account. It runs only where a seat line names
it, never by rotation, and stays on the account while its quota is busy; only when the account is
out, or its folder is missing, does the seat move to the size's other candidates. The mod reads
the account's quota without a model turn (`bin/claude-usage.mjs`); the band above the prompt still
shows the session's own Claude.

- A reviewer runs in Claude Code's sandbox: its shell writes only its folder and has no network,
  its file tools are kept off `.git` (a worktree's git folders are denied by absolute path, since
  the sandbox would leave them writable), and it gets only the tools that read and edit files
  (`--tools`): none that fetches, publishes, schedules or messages another session, and no MCP
  server. Should the sandbox not start, the seat fails and moves on rather than run unsandboxed.
- On Windows, where Claude Code's sandbox does not run (it sits behind a feature gate), a reviewer
  has no shell: Bash and PowerShell are denied, and its brief says so. It reads, searches and
  edits with its file tools, which stay held to its folder.
- An owner runs without permission prompts and with the account's own MCP servers; its Bash and
  PowerShell commands pass `bin/owner-guard.mjs`, as codex and agy owners do.
- No mod loads in the seat: nobody would see or approve what it asks. Neither the mods this
  session loads through `--plugin-dir` or `CLAUDE_CODE_PLUGIN_DIRS` (this one among them, so a
  seat cannot start seats) nor those the account's settings name. The account's installed
  plugins, its skills and its settings still load; an account that installs seat-router from the
  marketplace would give its seats the seat line too.

The session learns the seat line from the mod itself: you do not write rules for it. The mod also
shows running seats and each vendor's quota above the prompt, and `/seats` opens a pane with one
card per seat. The session can stop a seat with the mod's `stop` tool (TaskStop does not reach
seats). A codex, agy or account seat whose last 24 tool calls repeat one cycle of calls at least three
times in a row (the same call in the same folder with the same result, no write between), and keep doing so for thirty
minutes, is stuck: the mod stops it as the `stop` tool does and fails it, naming the cycle, so it moves
on as any failed seat does. The thirty minutes spare a seat waiting on CI or a background task. A seat whose process died without an exit code (killed, or the machine restarted) runs once more
on the same model when it is a reviewer, or an owner whose worktree is as it started; otherwise it is
reported as such. A failed owner moves to its next model only when its worktree is as it started, since
rerunning one that committed would repeat its work. A seat line naming a CLI or family stays in it: a
failed candidate there moves the seat only to another of that CLI or family, and the seat is reported
when none is left. A seat run again keeps each earlier attempt's logs in its folder, numbered
(`agy.1.jsonl`, `agy.1.err`, `final.1.md`). Once a seat finishes, its worktree is removed (one with uncommitted changes or
untracked files stays), so the branch it held can be checked out elsewhere; a reviewer's `seat/*`
branch goes with it, and an owner's report names the branch it left. When a session starts,
the mod deletes seat folders that ended more than a week ago, except a worktree with changes or
untracked files; `seat/*` branches stay.
A report leaves out each background-task notice agy fed its model and the model echoed into the
seat's output (a `<SYSTEM_MESSAGE>` block in agy's exact shape, with its preamble line), with a
line saying how many it removed. A seat's own mention of the tag stays, and so does a block with
no closing line.
Claude Code never learns that a seat ended, so resuming a session it lists every seat of it as a
background agent that did not finish. The mod rewrites that notice before the model reads it, for
each seat of this session it names: one that reported points at the report it delivered, one
running or waiting is yet to report and will report here, and one cut off while reporting points at
its report. A notice naming only such seats says nothing else. One naming other tasks too keeps
Claude Code's words, and the note names the seats it corrects and the tasks it leaves alone.

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
your CLIs report, then asks for delegate mode, then which other Claude accounts seats may use, when it finds any. Pick one, keep **Auto**, or type `<codex|agy|claude> <model> [effort]` under Other.

The fields themselves, with `claude plugin configure seat-router@code4food` (`/seats setup` saves through it; the `/config` menu does not list plugin fields):

| Setting | Default | What it does |
| --- | --- | --- |
| `heavySeats`, `standardSeats`, `lightSeats` | `auto` | The models a size tries, in order: `auto`, or comma-separated `<codex\|agy\|claude> <model> [effort]`. |
| `busyAt` | `80` | A model is busy once its 5-hour or weekly quota is this used, or its week is used faster than it has passed; a sized seat then passes it over. |
| `mixFanouts` | on | Asks the session to add one seat per other model family beside the Claude agents in every review or verification fan-out. |
| `claudeAccounts` | empty | Other Claude accounts on this machine, comma-separated `<name> <config folder>`: `work ~/.claude-work, sub2 ~/.claude-sub2`. A name may not be a CLI, family, size or tier word. `/seats setup` asks it after delegate mode, when the home folder has a logged-in `.claude-<name>` folder or the setting has an account. |
| `delegate` | `auto` | When code work (features, fixes, bug and performance tasks, PR owners and their fix rounds) goes to owner seats, which the mod spreads across model families: `auto` while Claude's quota is busy by the `busyAt` rule, `on` always, `off` never. `/seats setup` asks it after the sizes. |

A model's family comes from its name, so `agy claude-opus-5-5` counts as Claude, not as variety.

A sized seat line that names no CLI or family goes to the family (gpt, gemini, claude) with the fewest
of this session's seats and Claude subagents running now, so three such seats in a row land on three
families. A family is passed over only when every candidate in it is busy or out: with native Claude
busy, agy's Claude still serves the claude family. With every family busy, the least loaded model runs.
`auto` sizes list agy's Claude (sonnet for light and standard, opus for heavy) after native Claude.
