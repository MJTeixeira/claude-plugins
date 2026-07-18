# Spec red-team checklist

Adversarial review of `.factory/spec/*.md` before backlog compilation.
Goal: find what will stall or mislead an unattended session BEFORE weeks
of autonomy start. Run every check against every spec file; report
findings as a table (finding → resolution) and resolve each per the three
outcomes in SKILL.md (answer now / `Gate: human` stamp / dated open
decision).

## 1. Undefined behavior

For each REQ, probe the paths the happy sentence skips: error and
rejection paths, empty/zero states, limits and overflow (longest input,
most items, slowest network), ordering and ties, concurrent actors on the
same data, offline/retry. A session that hits an undefined path invents
an answer — and cheap models invent confidently.

## 2. Untestable acceptance

Flag every requirement whose acceptance can't be checked by a command or
a concrete observation: "fast", "intuitive", "clean", "like <product>".
Rewrite as numbers or named behaviors, or move the judgment to a
`Gate: human` stamp.

## 3. Owner-judgment detector

Hunt decisions no agent should make alone — these are the 3am stalls:
visual/aesthetic taste, game feel and playtest calls, naming and copy
tone, pricing, legal/compliance interpretation, anything a stakeholder
must sign off. Each becomes: answered now, or a `Gate: human` note on the
affected REQs.

## 4. Accounts & credentials inventory

List every external thing only the owner can create or pay for: app-store
and console accounts, OAuth apps, API keys, domains, SMTP, analytics,
payment providers. Each is a future hard block — record it in Open
decisions with WHO provides it and WHICH milestone first needs it, so
triage schedules around it instead of discovering it mid-window.

## 5. Milestone shape

Milestone 1 must end in something runnable/demoable and include
scaffolding + CI + a walking skeleton (the factory needs a green test
command from day one). Later milestones: check the REQ ordering doesn't
strand a foundation task behind a gated milestone.

## 6. NFR and platform gaps

Missing performance/capacity targets, security constraints, supported
platforms/OS/browser versions. If the spec is silent, the factory picks —
silence is a decision made by default.

## 7. Scope creep and orphans

REQs nobody asked for (cut or justify), and goals stated in the Overview
that no REQ delivers (add the REQ or soften the overview). The compile
step's coverage table will catch REQ↔task gaps later; this check catches
prose↔REQ gaps it can't see.
