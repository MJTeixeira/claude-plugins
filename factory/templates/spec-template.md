# <Product name> — Specification

<!-- Recommended pattern for Factory specs. Any spec compiles, but this shape
compiles best: numbered, independently testable requirements let the backlog
trace every task to REQ ids and report coverage gaps. Split large specs into
multiple files in .factory/spec/ (one per domain); keep REQ ids globally
unique across files. -->

## Overview
2-5 sentences: what the product is, for whom, and the core value.

## Users
- <persona> — <what they need from the product>

## Functional requirements
<!-- One per line, numbered, each independently testable. Write the
observable behavior, not the implementation. Group by domain. -->

### <Domain, e.g. Accounts>
- REQ-1: A visitor can create an account with email + password; duplicate
  emails are rejected with a clear error.
- REQ-2: ...

### <Domain, e.g. Tasks>
- REQ-10: ...

## Non-functional constraints
- NFR-1: <performance / capacity target, measurable>
- NFR-2: <security/compliance constraint>
- NFR-3: <supported platforms, browsers, OS versions>

## Stack & platforms
Target stack if decided (language, framework, DB, hosting); "agent's choice
within <constraints>" is valid.

## Architecture defaults
<!-- Condensed from the skillset's dev-workflow references/architecture.md
(source of truth). Edit per project; delete lines that don't apply. -->
- Vertical slices: colocate UI/logic/tests by feature; one task → one area.
- The first instance of each layer is the exemplar; later tasks copy it.
- Inject clock/randomness/external IO — no module-level singletons.
- Lifecycles as explicit closed state sets, not boolean flags.
- No speculative abstraction: a seam needs a second implementation today.
- Engines: composition + signals over inheritance/direct refs, content as
  data files, many SMALL scenes/prefabs (scene files don't merge — one task
  per scene).

## Out of scope
Explicit non-goals — prevents the agent from building them.

## Milestones (optional)
Ordered delivery stages; each lists the REQ ids it must satisfy.
- M1 <name>: REQ-1..REQ-9 — <the demoable outcome>
- M2 <name>: ...

## Open decisions
Known unknowns and who decides them. The compile step turns these into
questions rather than guessing.
