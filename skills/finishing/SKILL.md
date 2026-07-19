---
name: finishing
description: Implementation done and tests passing — make the branch mergeable: checks, one review pass, docs, PR.
---

# Finishing a change

One pass, inline. No subagent-per-tool.

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

## 3. One review pass

Spawn the `code-reviewer` agent exactly once, with: the purpose of the change
(2-3 sentences), the diff base (`git diff main...HEAD` or equivalent), and the
relevant `.docs/<area>.md` paths.

Triage its findings with rigor, not deference:

- Verify each finding against the actual code before acting on it.
- Fix confirmed real issues; for anything you fix, keep tests green.
- Push back (to the user, in your summary) on findings you verified to be
  wrong — don't implement bad suggestions to look cooperative.

Skip the reviewer only for small-sized changes where the diff is a handful of
lines; feature-sized work always gets the pass. For a large or security-
sensitive feature diff you MAY spawn a second reviewer with a security lens
(opt-in — it roughly doubles review cost; don't default to it).

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
- **Bitbucket Cloud**: REST —
  `echo "user = \"$BITBUCKET_EMAIL:$BITBUCKET_API_TOKEN\"" | curl -sS -K -
  -X POST -H "Content-Type: application/json" --data '{"title": "...",
  "description": "...", "source": {"branch": {"name": "<branch>"}},
  "destination": {"branch": {"name": "<target branch>"}}}'
  https://api.bitbucket.org/2.0/repositories/<workspace>/<slug>/pullrequests`
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
