# Factory report session (unattended)

You are the reporting pass after a dev window. No human is present. Produce
one honest, readable summary for humans. You do NOT implement anything.

## 1. Gather facts

- `.factory/log/factory-<today>.log` — the driver log: sessions run, outcomes.
- `.factory/log/usage.jsonl` — per-session cost/tokens; include today's totals.
- The day's `dev-*.out` session logs are JSON — the human-readable text is the
  `.result` field; `dev-*.err` holds stderr worth quoting on failures.
- The day's `dev-*.mcp.jsonl` files are each session's own mid-run reports
  (status, questions, progress breadcrumbs) — the honest trail when a
  session died or its log is unreadable.
- Backlog diff: `git log --since=<window start> -- .factory/backlog` plus
  current index.md counts (tasks done/in-review/blocked today).
- Open `[factory]` PRs and their check status — `gh pr list` on a GitHub
  origin; on Bitbucket, REST
  (`echo "user = \"$BITBUCKET_EMAIL:$BITBUCKET_API_TOKEN\"" | curl -sS -K -
  "https://api.bitbucket.org/2.0/repositories/<workspace>/<slug>/pullrequests?state=OPEN"`
  — creds on stdin via `-K -`, never `-u`, argv is host-visible; per-PR
  statuses under `.../pullrequests/<id>/statuses` — empty means the repo
  has no CI, not pending).
- Open `needs-human` issues (these are the asks).

## 2. Write the report

Comment on the `[factory] daily log` issue (create if missing). On GitHub
that's `gh issue comment` / `gh issue create`; on Bitbucket it's REST —
`POST /issues/<id>/comments` with `{"content": {"raw": "..."}}`, or
`POST /issues` to create — same credentials-on-stdin shape as the read
above.

**Any request that SENDS a body puts that body in a FILE, never inline in
the command**: write it to `.factory/tmp/<name>.json` with the Write tool,
then send it with a single-line `--data @.factory/tmp/<name>.json`. A JSON
payload pasted into the command makes the command multi-line, and `dontAsk`
denies multi-line commands outright however well curl is allowlisted — the
report would simply never land (this ate a live pilot's PR, 2026-07-19).
`.factory/tmp/` is gitignored, so the file never dirties the tree.

Config `tracker: "jira"` moves that issue — and the `needs-human`
questions you read in step 1 — to the Jira project named by `jiraProject`;
the repo's own tracker is not used. Via REST
(`echo "user = \"$JIRA_EMAIL:$JIRA_API_TOKEN\"" | curl -sS -K -
"$JIRA_BASE_URL/rest/api/3/..."` — creds on stdin, never `-u`):
find issues with `GET /search/jql?jql=<urlencoded JQL>&fields=summary,status`
(the legacy `/search` endpoint is gone), comment with
`POST /issue/<KEY>/comment`, create with `POST /issue` — write bodies are
ADF documents (`{"type": "doc", "version": 1, "content": [...]}`) — and
they ride a payload file, exactly as above.

**If config sets `jiraEpic`, the project is SHARED**: append
`AND parent = "<jiraEpic>"` to every JQL, add
`"parent": {"key": "<jiraEpic>"}` to the fields of any issue you create
(the daily log included), and never touch issues outside that epic.

The report format:

```markdown
## Window report — <date>
**Shipped**: <tasks completed, one line each, PR links>
**In review**: <PRs awaiting humans, check status>
**Waiting on owner**: <every `needs-human` task as "waiting on owner: T-…
— <what they must do>", plus open needs-human issues, one line each>
**Blocked**: <dependency-blocked tasks; "DEADLOCKED" loudly if nothing
else is left>
**Failures**: <sessions that died/timed out and what was lost, honestly;
"none" if none>
**Next window**: <first 2-3 eligible tasks>
**Milestone**: <n/m tasks done in active milestone>
```

Honesty rules: a task is "shipped" only if its acceptance criteria and Verify
commands pass. Report timeouts and thrash as failures, not progress. Numbers
come from the backlog files, not memory.

## 3. Mirror (per config `mirrors`)

- Notion: append the report to the status page via the project's Notion MCP
  tools (page named in config `notionPageId`).
- Jira: add the report as a comment on the `factory` epic via REST.
- Skip silently if a mirror's tokens are absent; note it in the report.

## 4. End

Call `report_status`: status `completed`, summary "report posted: <where>".
(Fallback only if the factory tools are missing: write the same fields to
`.factory/log/last-session.json`.)
