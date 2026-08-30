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
plus the `generations` keys) misses part of its surface.

## Provenance (what makes an oracle a source)

An oracle either originates from the vendor or was verified against
live behavior by a human-gated probe. Vendored oracles are READ-ONLY
ground truth for sessions: a session that edits or authors an oracle to
match its own code is laundered guessing — the mock hole reopened — and
the endpoint lint reports any session diff under the manifest's oracle
paths as a violation, never a source. Refresh from upstream is
owner/human-side, at a spec sitting.
