# seat-router

seat-router is a Claude Code mod that runs subagents outside the session. An Agent call whose
prompt starts with a seat line runs on the Codex CLI (`codex`), on the Antigravity CLI (`agy`),
or as a separate `claude -p` process. The mod picks the model by quota, watches the seat until it
ends, and posts the seat's report into the session as a message from the seat-router plugin. A
seat keeps running after the session that started it ends.

You do not write rules for the session. The mod adds the seat-line grammar, each size's models and
the jobs this machine can run to the session's system prompt, so the session writes seat lines
itself when you ask for work on another model family.

## What you need

- macOS, Linux or Windows, with Node.js on the `PATH`.
- At least one of `codex` and `agy`, installed and logged in. When a session starts, the mod runs
  each with `--version` and offers only the ones that answer. With neither, it adds nothing to the
  session's system prompt.
- `claude` on the `PATH`, for Claude seats.
- `git`, for seats that work in a worktree of your repository.
- `gh`, logged in, for owner seats that push or open pull requests. An owner on a machine where
  `gh auth token` prints no token runs without GitHub credentials, and its report says so.
- codex-cli 0.163 or later. An older codex refuses the flags a reviewer seat runs with, and the
  seat moves to its next model.

## Install

```
/plugin marketplace add MJTeixeira/claude-plugins
/plugin install seat-router@code4food
```

## Write a seat line

The seat line is the first line of the Agent call's prompt, and the brief follows it. A line has
one of two forms. With the shipped jobs and no other Claude accounts, the mod spells them this way
when it refuses a line:

```
seat: [<codex|agy|claude|gpt|gemini>] <light|standard|heavy> <reviewer|owner> [<code|image>]
seat: <codex|agy> <model> <effort> <reviewer|owner> [<code|image>]
```

Write the line in lower case, with single spaces and nothing after its last word. A line that ends
in CRLF is fine. A prompt whose first line starts with `seat` and a colon, in any case, but is not
exactly one of the two forms is refused, and never runs as an ordinary subagent. Examples are a
blank line or a space before it, a trailing space, `Seat:`, a misspelt family and
`seat: claude opus high reviewer`.

The sized form leaves the model to the mod, which starts the size's best candidate by quota. To
keep the seat on one CLI (`codex`, `agy`) or one model family (`claude`, `gpt`, `gemini`), name it
in the first slot. The seat then never runs anywhere else. When all of that CLI or family is out of
quota, the mod refuses the line, and a seat that is already running waits for a reset.

The explicit form runs the named model on that CLI at that effort. The effort also picks a size.
`low` or `medium` is light, `high` is standard, and `xhigh` or `max` is heavy. The named model runs
first even while its quota is busy. When it is out of quota or fails, the seat moves to the other
models of the same family in that size, each at the line's effort. So
`seat: agy claude-opus-5-5 high reviewer` can fall back to Claude on the session's account, never
to codex. agy runs an effort above `high` at `high`.

The optional last word is a job, which names the kind of work and can limit and order the
candidates. See [Jobs](#jobs).

The tier says what the seat may do. A `reviewer` reports and does not commit. An `owner` may commit,
push and open pull requests. See [What a seat may do](#what-a-seat-may-do).

Pass `isolation: "worktree"` on the Agent call whenever the seat reads or changes your repository,
a review included. The seat then works in a new worktree on the branch `seat/<id>`, made from the
commit the session's folder is on. Without it, the seat starts in an empty folder of its own and
knows only the absolute paths its brief names.

A seat cannot be continued. Give follow-up work to a new seat with the whole scope.

### Other Claude accounts

A second Claude subscription on the same machine lives in its own config folder, the one
`CLAUDE_CONFIG_DIR` names when you run it. List it in the `claudeAccounts` setting, and the session
learns one more form:

```
seat: <account> <light|standard|heavy> <reviewer|owner>
```

The seat runs the size's Claude model as `claude -p` on that account's own login. That model is
sonnet high for light, opus medium for standard and opus high for heavy. The session writes this
form only when you ask for the account, and the seat never leaves it. An account's name also joins
the first slot of the sized form, so a job word can follow it. `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` and the `CLAUDE_CODE_USE_*` variables in the
session's environment would outrank the account's login, so the seat runs without them.

## How the mod picks a model

Each size has a list of candidates. With the shipped `auto` setting, a size tries codex's default
model, agy's Gemini Flash and Argon, Claude on the session's account, and then agy's Claude, each at
the size's effort as far as the model takes it. The codex and agy models are the ones each CLI
reports when the session starts. `/seats setup` names each size's list, and the session's system
prompt lists them too.

A model's family comes from its name, whichever CLI serves it, so agy's `claude-opus-5-5` counts
as Claude.

From the candidates that the line and its job allow, the mod drops each one that cannot run on this
machine, such as a CLI that is not installed or an account whose folder is missing. It never waits
for those. It orders the rest by these rules, the first rule first:

1. An explicit line's named model, or an account line's account, goes first unless it is out.
2. Quota state. A reviewer tries free, then unknown, then busy. An owner tries free, then busy,
   then unknown, because an owner that runs out of quota after it commits cannot move. A candidate
   that is out is never tried.
3. The job's `first` rules.
4. The model family with the fewest seats running on this machine, from every session. Three sized
   seats called in one message land on three families when all three are free.
5. The order of the size's list.

Two candidates in one state keep their order whatever their percentages, so a reading that moves a
point does not reorder them. A running seat that fails over orders its candidates again by the same
rules, with quota as it stands at that moment.

## Quota

The mod keeps a state for each quota scope. A scope is one vendor bucket:

- codex has one scope for the account, plus a model's own bucket where codex reports one.
- agy's Gemini models draw on its Gemini bucket. Argon draws on its own bucket where agy lists one,
  and on Gemini's elsewhere. agy's Claude and GPT-OSS models draw on its third-party bucket. A
  bucket that agy marks disabled counts for nothing.
- Each Claude account has one scope, named by a short hash of its config folder, plus a model's
  own cap, such as Fable's weekly window.

A candidate stands at the worst state of the scopes it draws on.

| State | When |
| --- | --- |
| `free` | Every window of a fresh reading is under the rules below. |
| `unknown` | No reading, or a reading that turned stale. |
| `busy` | A window at or over `busyAt`, or a long window used ahead of its time. |
| `out` | A window at 95% or more, or the CLI's own error said the run hit its limit. |

`/seats` prints the rules this way, with the default `busyAt`:

```
Quota rules: busy at 80% (busyAt), out at 95%; a window of 7 days or more is busy when its use runs more than 15 points ahead of the time passed; a reading under busyAt counts for 30 minutes, one at or over it until its window resets.
```

1. A window at 95% used or more is out until it resets.
2. A window at `busyAt` or more is busy until it resets.
3. A window of 7 days or more is busy while its used percentage is more than 15 points ahead of the
   percentage of the window that has passed. Halfway through the third day of a week, a window is
   busy above 51% used.
4. A reading under `busyAt` counts for 30 minutes and then turns unknown. A reading at or over
   `busyAt` holds until its window resets, however old it is. A window with no reset time turns
   unknown after 30 minutes.
5. When a CLI's own error says a run hit its limit, the candidate's scopes are out until the reset
   time the vendor gave, or for 30 minutes when it gave none. A newer reading does not clear that.
6. A window whose reset time has passed no longer counts.

The rules name no window. A vendor that adds or drops a window changes only the readings, and the
`busyAt` and 95% rules apply to every window a reading carries.

The readings come from three sources:

- Claude Code's own rate limits for the session's account.
- Each seat's own output, which carries codex's rate limits and Claude's rate-limit events.
- A background read of codex, agy and your other Claude accounts. It reads a vendor at most once
  every 10 minutes on the machine, and only while a session on the machine had a prompt in the last
  10 minutes. It reads only scopes that a size or account uses and that have no reading from the
  last 10 minutes, and each account at least once a day.

## Jobs

A job is the optional last word of a seat line. The mod ships two:

- `code`, for work that writes or fixes code. It has no rules, so it routes like a line with no job
  until your `jobs` setting gives it some. Delegate mode writes it.
- `image`, for work that makes images. It runs only on a model that makes images, which is every
  codex model and agy's Gemini models, and never on Claude.

Add jobs, or give the shipped ones rules, in the `jobs` setting. Separate entries with `;`. Each
entry has this form:

```
<job> [(<what it is for>)]: <rule>, ...
```

A rule is `only`, `not` or `first`, then one word. The word is a CLI (`codex`, `agy`), a family
(`claude`, `gpt`, `gemini`, `other`), an account name, or `session` for the session's own account.
Any other word is a model pattern. A pattern matches the whole model id in any case, with `*` for
any run of characters and `?` for one character.

- `only` is the hard rule. The job keeps only the candidates that match one of its `only` words.
- `not` drops every candidate that matches.
- `first` orders the candidates that are left, within one quota state. A candidate that matches an
  earlier `first` rule goes before one that matches a later rule, and both go before the rest. A
  `first` rule never runs a busy candidate ahead of a free one.

For example, this entry adds an `art` job that runs only on codex and agy, never on a Claude model,
codex first:

```
art (layouts, styling, images, diagrams): only codex, only agy, not claude, first codex
```

With it, `seat: standard reviewer art` never runs a Claude model, even on a size whose list starts
with Claude: `not claude` names the family, so it drops agy's Claude models as well as the `claude`
CLI. It starts codex while codex and agy are both free, agy's Gemini while codex is busy and agy is
free, and agy while codex is out. While both are out the mod refuses the seat, naming the job's
`only` rules.

An entry for `default` gives its rules to every line that ends without a job word, for example
`default: not fable`. A line cannot end in the word `default` itself.

A job word is lower-case letters, digits and hyphens, and starts with a letter. It may not be a
size, tier, CLI, family or account word, and an account may not be named `default` or after a job.
The text in parentheses tells the session what the job is for. An entry needs rules, a description
or both. When a job has two entries, the first one counts.
An `image` entry keeps the job's need for a model that makes images. `/seats` lists the problems of
the saved setting, and its other entries still apply.

The session's system prompt names only the jobs that every size can run on this machine, with what
each is for and its rules. It tells the session to send work that fits one of them, other than
`code`, to a seat with that job instead of doing the work itself, with delegate mode on or off. When
the mod refuses such a seat, the session tells the person and does not do that work itself.
`code` goes to a seat only in delegate mode. A line can still use any job you defined. When a job
and a line leave no candidate, the mod refuses the seat and names the step that emptied the list,
which is the job's need, its `only` rules or its `not` rules.

## Settings

Nothing needs setting, so leave every field as the install screen shows it. To change them, run
`/seats setup`, or `claude plugin configure seat-router@code4food`. The `/config` menu does not list
plugin fields.

| Setting | Default | What it does |
| --- | --- | --- |
| `heavySeats`, `standardSeats`, `lightSeats` | `auto` | Each size's candidates in list order, as `auto` or as comma-separated `<codex\|agy\|claude> <model> [effort]`. The mod drops an entry that names no known CLI. |
| `busyAt` | `80` | The percentage used at which a window makes its scope busy. See [Quota](#quota). |
| `mixFanouts` | on | Tells the session to add one reviewer seat per other model family beside its Claude agents in every review or verification fan-out, all in one message. |
| `delegate` | `auto` | When code work goes to owner seats. `auto` sends it while the session's Claude account is busy or out, `on` always, `off` never. See [Delegate mode](#delegate-mode). |
| `claudeAccounts` | empty | Your other Claude accounts on this machine, as comma-separated `<name> <config folder>`, such as `work ~/.claude-work`. A name may not be a CLI, family, size or tier word, `other` or `session`. |
| `jobs` | empty | Your jobs, as `<job> [(<what it is for>)]: <rule>, ...` entries separated by `;`. See [Jobs](#jobs). |

`/seats setup` asks these questions in order:

1. For each size, which model goes first. **Auto** keeps the shipped list. A model you pick goes
   first, with the rest of the auto list after it. Under **Other**, type
   `<codex|agy|claude> <model> [effort]`.
2. Delegate mode. The answers are **Auto**, **On** and **Off**.
3. Which other Claude accounts seats may use. It asks only when your home folder has a logged-in
   `~/.claude-<name>` folder, or the setting names an account already. Under **Other**, type
   `<name> <config folder>` entries, comma-separated.
4. Your jobs. The answers are **Keep as is**, **None**, or the whole setting typed under **Other**.
   A setting with problems is not saved, and the answer lists them.

If you dismiss a question, the ones after it are not asked and keep their values. `/seats setup`
saves through `claude plugin configure`. A mod loaded with `--plugin-dir` cannot save that way, so
for it set `pluginConfigs["<id>"].options` in `settings.json`.

## Delegate mode

While delegate mode is on, the session sends code work to owner seats. Code work is a feature, a
refactor, a bug fix or a performance task, a PR owner with its fix rounds, and their helpers. Each
goes out as `seat: <size> owner code` with `isolation: "worktree"`, at the size its effort maps to,
or standard when none is named. The mod spreads these seats across model families by quota. The
session keeps the planning, the briefs, the verdicts, the merges it owns and every reply to you.

With `delegate` at `auto`, the mode is on while any window of the session's Claude account is busy
or out by the quota rules. Until then, code work stays on Claude unless you ask to delegate it. A
line in the transcript says when the mode turns on, why, and when it turns off. When the mod cannot
read the quota, code work stays on Claude.

## What a seat may do

A reviewer of any CLI starts with only a few environment variables, such as the path, home, locale,
temp and proxy variables and the CLI's config folder. It gets no `gh` login and no git credentials.
An owner keeps the session's environment and gets your `gh` login's token.

### codex

- A reviewer runs in codex's sandbox. It writes only its folder, and its commands reach the
  network, so a brief can have it run `gh issue view` or fetch a page. It runs without your
  `~/.codex/config.toml` (so none of your codex MCP servers start) and without your codex rules,
  with codex's apps, plugins and web search off.
- An owner runs outside codex's sandbox (`danger-full-access`), with your codex config, behind the
  guard. Because codex runs a hook from the command line only past its trust check, an owner runs
  with `--dangerously-bypass-hook-trust`. For that run codex also runs any hook in your codex config
  or the repository's `.codex/` that you have not trusted.

### agy

- Every agy seat runs outside agy's sandbox (`--dangerously-skip-permissions`), behind the guard.
  agy's sandbox refuses what a seat needs. On Windows, node cannot even read the attributes of
  `%APPDATA%` there, so no npm-installed CLI starts.
- A seat's agy settings are yours with the guard's deny list added, and a seat never spends AI
  credits once the plan's quota runs out. A reviewer starts none of your agy MCP servers and gets no
  `gh` login or keychain. An owner keeps them.
- Each agy seat runs under a home folder of its own whose links reach your agy sign-in. The mod
  deletes that folder when each attempt ends. agy saves the images it makes there, so the mod first
  copies them to the seat's `artifacts` folder, and the report names each copy.
- A run in which agy refused an action fails and names the refusal, because the refusal halts the
  conversation that asked. A seat whose guard hook could not run fails too, though agy calls the run
  a success.
- agy keeps a run open while a background task the seat started still runs. The brief tells the seat
  to wait for or stop each one before its final answer, and to have each subagent it starts report
  first.
- A long run can end with `UNAUTHENTICATED (code 401)`, an open agy bug
  ([antigravity-cli#1091](https://github.com/google-antigravity/antigravity-cli/issues/1091)). The
  seat then resumes its agy conversation in a new process, told why, up to three times.

### Claude

Every Claude seat runs as `claude -p` from the config folder of its account, recorded when the seat
starts. The plugins that the session's settings or the account's own settings enable are disabled
in the seat, and so is every plugin claude.ai synced into the account's folder. The mods the session
loads through `--plugin-dir` or `CLAUDE_CODE_PLUGIN_DIRS` stay out too, and so does auto memory. A
copy of seat-router that loads anyway does nothing, so a seat never starts seats.

- A reviewer runs in Claude Code's sandbox. Its shell writes only its folder and has no network,
  and its file tools stay off `.git`. It gets Bash, Read, Grep, Glob, Edit, Write, NotebookEdit and
  Skill, and no MCP server. If the sandbox cannot start, the seat fails and moves on rather than run
  unsandboxed.
- An owner runs without permission prompts and without MCP servers or claude.ai connectors. Its
  Bash and PowerShell commands pass the guard.

### The guard

The guard checks each shell command of an owner seat, and of every agy seat, before it runs. It
refuses these commands:

- A force push, except `--force-with-lease=<branch>:<sha>` onto the branch checked out where the
  command runs, inside the seat's folder, when that branch is not `main`, `master`, `dev`,
  `develop` or `trunk`.
- `git reset --hard`, and `git branch -D` of any branch.
- `git worktree remove` and `git worktree move` of any worktree. The mod removes the seat's own
  worktree when the seat ends.
- `git clean -f`, `git checkout`, `git restore` and a forced `git switch` that `-C` or
  `--work-tree` aims at another folder, or that runs outside the seat's folder.
- A forced recursive delete, such as `rm -rf`.
- `gh pr merge --admin` and `gh repo delete`.
- A `git push` that deletes a remote branch other than the seat's own `seat/<id>` or one its
  worktree checked out, `git push --mirror` or `--prune`, and anything that skips the repository's
  push hooks (`--no-verify`, or `core.hooksPath` set for the command).

The commands that discard work (`git clean -f`, `git checkout`, `git restore`, a forced
`git switch`, `git stash`, `git rm`, `git reset`) run only on a line of plain `cd` and `git`
commands inside the seat's folder. Run such a command as its own plain call. The brief tells each
owner that a refusal is final. The guard reads the command text, so it stops a confused agent's
mistake (the wrong folder, a forgotten `cd`, a wrapper around git), not a command built to get
around it.

### Windows

- A codex reviewer runs codex's mxc sandbox on Windows 11 24H2 26100.9278 or 25H2 26200.9278 and
  later. Each session start checks for it, and a seat that starts before the first check runs the
  unelevated sandbox. Elsewhere it runs the unelevated sandbox, where node cannot read the output of
  a program it starts, so npm scripts and node tools that capture git's output fail. The brief says
  so.
- A codex reviewer starts without the `WindowsApps` folders on the `PATH`, because the Store's
  `pwsh.exe` cannot start in its sandbox. Where PowerShell 7 came from the Store, the reviewer runs
  Windows PowerShell 5.1, which turns each non-ASCII character piped into a program into `?`.
  PowerShell 7 from its MSI installer runs there.
- agy runs its commands in Windows PowerShell 5.1, whatever is installed. The brief of every agy
  seat and every codex reviewer says the shell may be 5.1 and tells it to write files with its file
  tools or Python, never through a pipe.
- A codex owner keeps the `WindowsApps` folders and runs PowerShell 7. On a machine without
  PowerShell 7 it runs 5.1 with no such note, so install PowerShell 7 there.
- codex seats run PowerShell without your profile. codex seats, agy seats and Claude owners run
  Python in UTF-8 mode (`PYTHONUTF8=1`).
- A Claude reviewer has no shell, since Claude Code's sandbox does not run on Windows. It reads,
  searches and edits with its file tools, and its brief says so.
- One Claude seat on the session's account runs at a time on the machine, because concurrent
  Claude processes on one config folder can replace its `.claude.json`
  ([anthropics/claude-code#78439](https://github.com/anthropics/claude-code/issues/78439)). While
  one runs, another moves to its next candidate, or waits for the slot when none is left, and its
  report says how long it waited.

## Follow and stop a seat

The band above the prompt shows each vendor's quota state, and the time an out vendor is back.
While seats run, it shows a `×N` button that opens the seats pane. When the session reports an
autopilot queue through the mod's `queue` tool, the band also shows the queue's progress.

`/seats` opens or closes the pane, with one card per seat of this session. Opening it also prints
these lines:

1. Whether GitHub protects the repository's default branch. The answer is on, off, or not
   available on this plan, as for a private repository on a free plan.
2. Any problems in the `jobs` setting.
3. The quota rules, then each scope with its state, the rule that set it, its source and its age,
   and each background read that failed.
4. Every report that no session has delivered, with its path.

To stop a seat, the session calls TaskStop with the seat's id. The mod answers at once with
"Stopping seat <id>; its report follows.", ends the seat's CLI, and sends the report as usual. For
a finished seat, it answers with the report's path. TaskStop stops only the seats this conversation
started, before or after a `/clear`.

## How a seat ends

The Agent call answers at once with the seat's id, and Claude Code lists the seat as a background
agent whose output file is the seat's `report.md`. The seat starts only once that answer enters the
conversation, so a cancelled call starts nothing.

One supervisor process per seat runs it. It starts detached, outlives the session, and runs from a
copy of the mod taken when the seat started, with the environment that session had. A plugin update
or another session never changes a running seat. When a supervisor is gone (a crash, a killed
process, a reboot), any session running on the machine starts it again within a minute. The new
supervisor keeps watching a CLI that still runs, or treats the attempt as one that died.

A seat moves along its candidates by these rules:

- A candidate that failed is not tried again, except as below. A candidate that is out of quota
  waits until its reset. When every candidate left is out, the seat waits for the soonest reset.
- A CLI that died without an exit code runs once more on the same model, for a reviewer, or for an
  owner whose worktree is as it started.
- An owner whose worktree changed, or that ran without a worktree, never moves to another candidate
  and never reruns, whatever ended it, its quota included. Rerunning one that committed would repeat
  its work.
- A seat whose last 24 tool calls repeat one cycle at least three times, with no write between, and
  keep doing so for 30 minutes, is stuck. The mod ends it and fails it, naming the cycle. The 30
  minutes spare a seat that waits on CI or a background task.
- No seat launches anything 6 hours after it started. A CLI still running then is ended with its
  process group, and the report says "Gave up after 6 hours". A seat whose every known reset falls
  after that deadline reports at once.
- A seat whose every candidate failed reports that no CLI could take it, with the floor of its size
  (the size's Claude model) and the last candidate's output.

The report starts with `Seat <id> ("<description>", <vendor> <model> <effort> <tier>) finished.`
The lines after it give the fallback trail, any wait for quota or for the Windows Claude slot, and
notes about the seat's folder. Then comes the seat's answer, or what ended the seat and its output
so far.

When a seat finishes, the mod removes its worktree. A worktree with uncommitted changes, untracked
files or files git ignores stays, and the report names it. A reviewer's `seat/<id>` branch goes with
its worktree. An owner's branch stays, and its report names it. The mod keeps a worktree while a
process still uses it, and the report names those processes. A seat run again keeps each earlier
attempt's logs in its folder, numbered (`agy.1.jsonl`, `agy.1.err`, `final.1.md`).

## Delivery

Each finished seat's report waits in a mailbox for the conversation that started it, which posts it
once as a message from the seat-router plugin. The report counts as delivered when it enters the
conversation.

- A seat that a subagent started reports to that subagent while it runs, and to the main
  conversation after.
- After `/clear`, the new conversation takes the reports of seats started before it. Each report's
  first line then ends with "(started before /clear)."
- A report the session refuses is tried again after its next turn. After three refusals the mod
  gives it up, and `/seats` lists it with its path. A refusal after you interrupt a turn does not
  count.
- A report that no session takes waits until the session that started the seat runs again, and
  `/seats` in any session lists it.

Claude Code never learns that a seat ended, so a resumed session lists every seat as a background
agent that did not finish. The mod corrects that notice before the model reads it.

## Where seats live

The seat-router home is `~/.seat-router` on macOS and Linux, and `%LOCALAPPDATA%\seat-router` on
Windows. `SEAT_ROUTER_HOME` moves it. Each seat has a folder there, `seats/<id>`, which survives a
reboot. The folder holds the brief, the CLI's transcript and `report.md`. An agy seat's folder also
holds `artifacts`, and a worktree seat's folder holds the worktree in `wt`.

On Windows, codex's sandbox cannot write to a folder whose path has non-ASCII letters. When your
profile path has them, the home is a folder of your own under `%PUBLIC%\seat-router`. Before the
mod writes there, it makes your account the folder's owner and its only access entry, with nothing
inherited, and checks that no link or junction leads to it. When any check fails, the mod refuses
the seat.

When a session starts, the mod deletes seat folders whose report is more than a week old. It keeps
a worktree with changes or untracked files, a seat that a process still uses, and a seat whose
worktree or branch git could not remove, which it tries again next time. An owner's `seat/<id>`
branch stays. The home also keeps a record of how each seat ended (`outcomes/`) and of each
delivery (`deliveries/`) for 60 days.

Seats that seat-router 1.x started under `/tmp` (`TEMP` on Windows) are drained. The session
delivers how each one ended, once, and moves none of them on.

## Refusals and what to write instead

A refused Agent call runs nothing, on Claude or anywhere else. Each refusal starts with
`seat-router` and says why.

| The refusal says | What to do |
| --- | --- |
| `"<line>" is not a seat line` | Write one of the two forms it quotes, in lower case with single spaces. |
| `the prompt starts with a blank line` | Put the seat line on the prompt's first line. |
| `its last word, "<word>", is not a job` | Use a job it lists, drop the word, or add the job to `jobs`. |
| `... model this machine can run, so job <job> has nothing to try` | Name another CLI or family, or none, or install and log in that CLI. |
| `job <job> needs image generation` | Name a CLI or family it lists as having it, or drop the job word. |
| `job <job> runs only on ...` or `job <job> excludes ...` | Name a CLI or family the job allows, or change the `jobs` setting. |
| `the line names <model>, ...` | Name a model the job allows. |
| `none of its candidates can run on this machine` | Install and log in the CLI it names, fix the account's folder, or name another CLI or family. |
| `every candidate is out of quota` | Wait for the reset time it names, or name another CLI or family. |
| `isolation: "worktree" needs a git repository with a commit` | Start the seat from a git repository with a commit, or drop `isolation`. |
| `git did not answer in <n> seconds` | Call it again once git answers in that folder. |
| `the seat-router home ... is too deep` | Set `SEAT_ROUTER_HOME` to a shorter folder. |
| `... under %PUBLIC% could not be locked to this user` | Set `SEAT_ROUTER_HOME` to a folder whose path is ASCII. |
| `seat-router took too long to start this seat` | Call it again. |
| `the call was cancelled` | Call it again if you still want the seat. |

## How a release is checked

A seat-router version publishes only after CI passed on its exact content, on Linux, on a hosted
Windows runner and with the real CLIs on a self-hosted Windows machine, and after the Mac smoke run
with the real CLIs passed on the same seat-router content.
