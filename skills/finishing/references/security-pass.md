# Security pass — for diffs touching auth, input, network, or storage

Run through once against the diff; fix what fails, note in your summary what
you checked.

## Input handling

- Every new external input (request params, form fields, file uploads, env,
  CLI args) is validated/bounded before use — type, length, range, allowlist
  where possible.
- No user input reaches an interpreter unparameterized: SQL/query builders use
  bindings; shell commands use arg arrays not string interpolation; HTML
  output is escaped or framework-rendered (no dangerouslySetInnerHTML /
  innerHTML with user data).
- Deserialization of untrusted data uses safe formats/parsers (JSON with
  schema validation — never pickle/eval/yaml.load-unsafe on external data).

## AuthN / AuthZ

- Every new endpoint/route/handler has an explicit authorization check —
  not just authentication. Verify object-level access (user A cannot fetch
  user B's resource by changing an id).
- Session/token logic changes reuse the project's existing mint/verify paths
  (see `.docs` Contracts); no second token path introduced.

## Secrets & data

- No secrets in code, committed config, logs, or error messages. New config
  values that are secret come from env/secret store.
- New logging doesn't capture credentials, tokens, or full PII records.
- New storage of sensitive data matches how the project already protects
  equivalents (hashing for passwords, encryption where the codebase does it).

## Network / boundaries

- New outbound calls: TLS, timeouts, and no user-controlled URLs without an
  allowlist (SSRF).
- CORS/CSRF posture unchanged unless the task explicitly asked; new
  state-changing endpoints aren't GET.

Anything you can't verify from the code (deployment config, infra), flag in
the summary instead of assuming.
