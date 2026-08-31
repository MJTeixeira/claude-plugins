# External APIs — vendored oracles and `docs/apis.json`

The setup interview ends endpoint guessing by putting ground truth IN
the checkout: for every external API the product calls, vendor the
strongest oracle the vendor offers and record it in the project's
`docs/apis.json` manifest. Sessions consult the manifest first; the
endpoint lint reads it to know what to enforce. (Rationale: the dev
repo's api-ground-truth spec, REQ-5..7 and REQ-11..13 — a design record,
not a runtime dependency of this file.)

## The oracle ladder (vendor the STRONGEST rung on offer)

1. `sdk` — compiler-enforced: official typed SDK or compiling IDL (gRPC
   proto). The rule becomes "use the SDK, never raw HTTP to that host";
   the type-checker is the lint.
2. `openapi` / `graphql-sdl` / `asyncapi` / `wsdl` — spec-lintable:
   OpenAPI 3.x for REST (preferred when the product makes HTTP calls
   itself), GraphQL SDL, AsyncAPI/JSON Schema for events and webhooks,
   WSDL/XSD for SOAP.
3. `docs-snapshot` — markdown + source URL + fetch date. Acceptable when
   nothing machine-readable exists; no structural lint is possible, so
   enforcement falls back to grader citation and the manifest carries
   the weaker rung explicitly.
4. Nothing → the project sits in the Tier-1 blocking state: sessions
   must stop and ask on every call to that API. Vendor something. An
   API with nothing to vendor still gets a manifest entry
   (`"oracle": { "rung": "none" }`) — the blocking state must be
   visible in the manifest, never silently skipped.

Vendoring rules:

- Machine-readable oracles land as JSON: convert a YAML upstream at
  vendoring time (keeps the endpoint lint dependency-free). The
  conversion happens here, at the interview — never in a session.
- Pin the upstream to a version or commit and record the fetch date.
- Split-generation vendors (a current per-service surface beside a
  legacy dated one, both still answering): vendor BOTH generations, each
  under its own `docs/apis/<api>/<generation>/` directory (the endpoint
  lint maps spec→generation by that segment), and the project spec +
  manifest name which generation NEW code targets.
- Oracle files live under `docs/apis/<api>/`.
- Upstream versioning that lives in `servers` rather than `paths` (how
  OpenAPI normally versions): prefix every path with the generation
  segment at vendoring time — the lint matches whole request paths, so
  an unprefixed bundle fails every call. Path-level `$ref`-only specs:
  inline one level so methods are present in the vendored JSON (deeper
  schema refs stay as-is). Record each transform in an
  `x-vendored-note` field.
- Mechanical transforms belong in a committed owner-side vendoring
  script (upstream pin as an argument) so a refresh is reproducible —
  the script is owner-side, exactly like the refresh.

## `docs/apis.json`

One entry per external API the product calls:

```json
{
  "apis": [
    {
      "name": "vendor-api",
      "oracle": { "rung": "openapi", "format": "openapi-3.0", "paths": ["docs/apis/vendor-api/"] },
      "upstream": { "source": "https://github.com/<vendor>/api-specs", "pin": "commit 8f41c00" },
      "fetched": "2026-08-30",
      "targetGeneration": "per-service-v1",
      "generations": { "per-service-v1": "current", "v3": "legacy", "beta": "legacy" },
      "services": ["users", "accounts"]
    }
  ]
}
```

Required per entry: `name`; `oracle` (a ladder `rung`, the concrete
`format`, and the vendored `paths`); `upstream` (`source` plus `pin`, a
version or commit); `fetched` (date); `targetGeneration` (the
generation NEW code targets — for a single-generation vendor, its only
surface); `services` (the services/resource areas the project actually
uses — scopes the next refresh, which is human-side). `generations` is required
only for split-generation vendors: every vendored generation marked
`current` or `legacy` (the lint warns on calls into `legacy`).

Optional per entry, consumed by the endpoint lint: `hosts` — the API's
request host(s), required for sdk-rung enforcement (a raw HTTP call
naming one fails: it bypasses the SDK); `claims` — path prefixes this
API owns, when the default claim set (the oracle's first path segments
plus the `generations` keys) misses part of its surface; `documented` —
real endpoints the vendor documents only OUTSIDE its machine-readable
spec (OAuth token endpoints are the norm, not a quirk): a list of
`{"path": "/oauth/token", "source": "<doc path or URL>", "note": "..."}`
— `note` optional but wanted: why this path cannot be in the oracle and
where it is used, the judgement a reviewer cannot reconstruct from
bytes. Unknown keys anywhere in the manifest are ignored by design
(the property that lets manifests land ahead of a runtime). The lint
treats an exact path match as sourced (method-agnostic) while a
near-miss still fails — typo protection without demanding the path
appear in a spec that does not cover it; response-shape evidence stays
grader-citation via the named source. Like everything in this file,
`documented` is owner-side: the lint flags session diffs of
`docs/apis.json` itself. Intended use is proactive: list every real,
cited path — including ones nothing scans today — so a later refactor
into a scanned shape is already sourced instead of newly failing. The
lint verifies the careless case: a missing or nonexistent `source`
FAILS; a URL citation WARNS (vendor a snapshot); a cited file that
never names the path WARNS. The citation check is checkout-relative by
design — a sparse checkout or a `git archive` without the vendored tree
fails on citations that are perfectly real; a citation the gate cannot
read is not a citation. Entries are inert on runtimes older than
the lint (unknown manifest keys are ignored), so manifests can land
ahead of a fleet deploy.

## Provenance (what makes an oracle a source)

An oracle either originates from the vendor or was verified against
live behavior by a human-gated probe. Vendored oracles are READ-ONLY
ground truth for sessions: a session that edits or authors an oracle to
match its own code is laundered guessing — the mock hole reopened — and
the endpoint lint reports any session diff under the manifest's oracle
paths as a violation, never a source. Refresh from upstream is
owner/human-side, at a spec sitting.
