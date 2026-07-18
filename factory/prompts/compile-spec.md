# Compile spec → backlog

You are compiling product specs into the Factory backlog. This is a one-time
(or re-run after major spec changes) INTERACTIVE session — the user is
present; ask questions rather than guessing.

## Input

- Read every file in `.factory/spec/`.
- Read the machine-side factory config for the autonomy level and base
  branch: `~/.factory/projects/<project-basename>-*/config.json` (config
  lives on the machine, not in the repo; glob the suffix — it is a path
  hash). If it doesn't exist yet, ask instead of guessing. Also read
  `.docs/index.md` if the project has code already.

## Output

Write `.factory/backlog/index.md` and one `.factory/backlog/<epic>.md` per
epic, in exactly the format defined in the `code4food-factory:backlog` skill
(a machine-installed plugin skill — load it with the Skill tool). Rules:

1. **Milestones**: use the spec's milestones if present; otherwise propose
   2-5 ordered stages where each ends in something runnable/demoable. First
   milestone `active`, rest `not-started`. Milestone 1 must include project
   scaffolding, CI, and a walking skeleton — the Factory needs a green test
   command from day one.
2. **Epics**: 3-8 per milestone, one file each (`e<N>-<kebab-name>.md`).
3. **Tasks**: sized for ONE unattended session each (~a focused hour: one
   feature slice with its tests — not "build the backend"). Every task gets:
   testable acceptance criteria, a concrete `Verify` command, `Deps`, and the
   `Reqs:` ids it satisfies (if the spec has REQ ids). EVERY task also gets
   `Model:` and `Effort:` (and `Turns:` where warranted), assigned per the
   rubric in the `code4food-factory:backlog` skill by actually judging the task against the
   spec — a backlog where everything reads sonnet/medium means you didn't
   judge, and one where everything reads opus means you inflated. When
   torn between tiers, take the higher one (wasted sessions cost more than
   tokens), and give first-of-their-kind engine/subsystem integrations
   opus. Spec authors' difficulty notes override your guess; note the
   reason for opus picks in the task's Notes.
4. **Gate propagation**: a spec line carrying a `Gate: human` note (the
   spec skill's red-team pass stamps them on requirements whose acceptance
   needs owner judgment) puts `- Gate: human (<reason>)` on EVERY task
   covering that REQ — the merge gate holds those tasks' green PRs for the
   owner, which is the entire point of the upfront stamp. Never drop one
   silently; if you think a stamp is wrong, ask the user now.
5. **Coverage check**: after writing, produce a table of every REQ/NFR id →
   the tasks covering it. Any uncovered id is a gap: add a task or ask the
   user. Any task citing no REQ is scope creep: justify or cut.
6. **Open decisions**: for each ambiguity (from the spec's Open decisions
   section or discovered while compiling), ask the user now. Answers get
   recorded in the relevant task's Notes or a spec addendum file
   (`.factory/spec/decisions.md`) — never left in chat only.
7. Also seed `.docs/index.md` with a `Commands` section once the stack is
   decided (test/build/run), even if the commands don't exist yet — the first
   scaffolding task makes them real.

Finish by summarizing: milestone plan, task count per epic, coverage gaps
resolved, and decisions recorded.
