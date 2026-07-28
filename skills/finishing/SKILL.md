---
name: finishing
description: Implementation done and tests passing — make the branch mergeable: checks, review scaled to risk, docs, PR.
---

# Finishing a change

Inline, in order. No subagent-per-tool — a chain of specialist agents
re-reading the same diff adds context churn, not scrutiny.

## 1. Checks (direct Bash, fix what they report)

Run the project's own commands (check package.json/Makefile/CI config for the
canonical ones):

1. Test suite for the affected packages.
2. Formatter.
3. Linter.
4. Typechecker (if the language has one).

Fix every failure, including pre-existing ones. Re-run until clean.

Green checks are ground truth: verify only what YOU changed. Never re-verify
what CI or an earlier session already proved (re-running the suite on an
unchanged branch, re-probing a library's error shapes).

## 2. Verify by driving the app

Tests passing is not the same as the feature working. Exercise the changed
flow in the actual running product once — use the `verify` skill (per-platform
recipes: web, mobile, desktop, CLI/API). Skip only when the change has no
runtime surface (docs, comments, pure refactor already covered by tests you
watched fail).

If the diff touches auth, user input handling, network boundaries, or data
storage: also run the checklist in `references/security-pass.md`.

Claim "done" only on fresh evidence: command output produced in this session
for the thing you changed — not memory of an earlier run, not inference from
code that looks right.

If the plan named `Done evidence`, that exact check is the floor: run it
and show its output — silently substituting a weaker check is not done.
Genuinely can't run it in this environment (no simulator, missing creds,
unseeded data)? Follow the `verify` skill's rule: say so explicitly and
report the strongest check you COULD run — disclosed weaker evidence is
honest, silent substitution is not. No plan or no named check
(small/trivial work)? Derive the check now from what changed and say so.

## 3. Review — scaled to risk

Review depth follows the diff's blast radius, not a fixed ritual. The
implementer is the wrong judge of its own work — the model that wrote the
code is too nice grading its own homework — so the reviewer always runs
in fresh context, briefed with facts, never with your conclusions.

Risk always wins over size: check the high-risk list FIRST — a 4-line
auth fix is high-risk, not small.

- **High-risk diffs** — auth, payments/billing, data storage (schema
  migrations, what gets persisted or logged), network boundaries (new
  outbound calls, request handling), CI/CD or permission config, secrets
  handling, user-input parsing at trust boundaries, or any path the
  project marks high-tier (a factory project's `riskTiers` config, when
  present): spawn the `code-reviewer` agent AND a second reviewer with a
  security lens, whatever the diff's size. Verify-to-refute before
  acting — for each finding you intend to fix, first try to REFUTE it
  against the actual code; findings that survive refutation are real,
  the rest get pushed back with evidence.
- **Small diffs** (a handful of lines, behavior fully covered by the
  tests you watched fail, not high-risk): skip the reviewer.
- **Everything else**: spawn the `code-reviewer` agent once, with: the
  purpose of the change (2-3 sentences), the diff base
  (`git diff main...HEAD` or equivalent), and the relevant
  `.docs/<area>.md` paths.

Triage findings with rigor, not deference:

- Verify each finding against the actual code before acting on it.
- Fix confirmed real issues; for anything you fix, keep tests green.
- Push back (to the user, in your summary) on findings you verified to be
  wrong — don't implement bad suggestions to look cooperative.
- Chase correctness, not polish: a reviewer prompted to find gaps will
  report something regardless, and implementing every "consider…" is how
  over-engineering enters. Correctness and stated-requirement gaps are
  mandatory; the rest is optional by your judgment.

## 4. Docs

Update `.docs/` per the `docs` skill for the areas touched, and delete
`.docs/HANDOFF.md` if this completes the task it describes.

Then sweep user-facing docs (same skill, "User-facing docs" section): if the
change altered install steps, commands, flags, config, or behavior described
in README/ONBOARDING/CLAUDE.md or a docs site, update those in the same
branch — agent docs and human docs both gate the PR.

## 5. Commit / PR — only with user consent

If the user asked for a PR (or already approved it in the plan):

```sh
git add <files> && git commit
git push -u origin <branch>
```

then open the PR per the forge (`git remote get-url origin`):

- **GitHub**: `gh pr create --title "..." --body "..."`
- **Bitbucket Cloud**: REST, in TWO steps:
  1. Write the request body to a scratch file (gitignored scratch dir —
     `.factory/tmp/` in factory projects, the session scratchpad
     otherwise) with
     the Write tool — never a heredoc, never inline JSON in the command:
     `{"title": "...", "description": "...", "source": {"branch": {"name":
     "<branch>"}}, "destination": {"branch": {"name": "<target branch>"}}}`
  2. Then ONE single-line command:
     `echo "user = \"$BITBUCKET_EMAIL:$BITBUCKET_API_TOKEN\"" | curl -sS -K - -X POST -H "Content-Type: application/json" --data @<scratch>/pr.json https://api.bitbucket.org/2.0/repositories/<workspace>/<slug>/pullrequests`

  A multi-line `--data '{...}'` inline in the command is what fails: the
  Bash permission matcher cannot decompose a command carrying newlines, so
  restricted permission modes deny it outright. The body file keeps the
  command one line and short.
  (workspace/slug from the origin URL; keys are an Atlassian API token —
  the username is the account EMAIL — and ride stdin via `-K -`, never
  `-u`: argv is visible to every process on the host. Always set
  `destination`; omitted, Bitbucket targets the repo's main branch.)
  Keys not in the env? Push, then give the user the create-PR link instead:
  `https://bitbucket.org/<workspace>/<slug>/pull-requests/new?source=<branch>`

Commit subject: `<area>: <imperative summary>`, ≤ 72 chars, matching the
repo's existing style (`git log --oneline -10`); body only when the why
isn't visible in the diff.

PR body: what/why/how-verified in ~20 lines. No boilerplate branding. Land
before polish — a mergeable PR now beats prose later.

Then check CI ONCE — `gh pr checks <pr>`, or on Bitbucket
`GET .../pullrequests/<id>/statuses` (empty = the repo has no CI; that's a
pass, not a pending). If it fails, fix and push. If it's still pending,
report the PR URL and stop — do not poll in a loop; the user can ask you to
check later.

If the user hasn't asked for a commit/PR, stop after step 3 and report status.
