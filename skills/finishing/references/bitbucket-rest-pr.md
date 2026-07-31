# Bitbucket Cloud PR via REST — fallback when `bb` is absent

Two steps, in this order — the shape matters more than the endpoint:

1. Write the request body to a scratch file (gitignored scratch dir —
   `.factory/tmp/` in factory projects, the session scratchpad otherwise)
   with the Write tool — never a heredoc, never inline JSON in the command:

   ```json
   {"title": "...", "description": "...",
    "source": {"branch": {"name": "<branch>"}},
    "destination": {"branch": {"name": "<target branch>"}}}
   ```

2. Then ONE single-line command:

   ```sh
   echo "user = \"$BITBUCKET_EMAIL:$BITBUCKET_API_TOKEN\"" | curl -sS -K - -X POST -H "Content-Type: application/json" --data @<scratch>/pr.json https://api.bitbucket.org/2.0/repositories/<workspace>/<slug>/pullrequests
   ```

A multi-line `--data '{...}'` inline in the command is what fails: the
Bash permission matcher cannot decompose a command carrying newlines, so
restricted permission modes deny it outright. The body file keeps the
command one line and short.

Details that bite:

- workspace/slug come from the origin URL.
- The keys are an Atlassian API token — the username is the account
  EMAIL — and they ride stdin via `-K -`, never `-u`: argv is visible to
  every process on the host.
- Always set `destination`; omitted, Bitbucket targets the repo's main
  branch.
- Keys not in the env? Push, then give the user the create-PR link
  instead:
  `https://bitbucket.org/<workspace>/<slug>/pull-requests/new?source=<branch>`
