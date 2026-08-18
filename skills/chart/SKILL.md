---
name: chart
description: Plan a huge chunk of work — more than one agent session can hold — as a shared map at the head of the backlog index, with decision tickets beside the tasks the effort will eventually carry, and resolve them one at a time until the way to the destination is clear.
disable-model-invocation: true
---

A loose idea has arrived — too big for one agent session, and wrapped in fog: the way from here to the **destination** isn't visible yet. Wayfinding is about finding that way, not charging at the destination. This skill charts the way as a **shared map** in the repo's backlog, then works its **decision tickets** — questions whose resolution is a decision, not slices of a build to execute — one at a time until the route is clear.

The destination varies per effort, and naming it is the first act of charting — it shapes every ticket. It might be a spec to hand off and iterate on, a decision to lock before planning starts, or a change made in place like a data-structure migration. The map is domain-agnostic — engineering work, course content, whatever fits the shape.

## Plan, don't do

Charting is **planning** by default: each ticket resolves a decision, and the map is done when the way is clear — nothing left to decide before someone goes and does the thing. The pull to just do the work is usually the signal you've reached the edge of the map and it's time to hand off. An effort can override this in its **Notes** — carrying execution into the map itself — but absent that, produce decisions, not deliverables.

## Refer by name

Every map and ticket has a **name** — its title. In everything the human reads — narration, the map's Decisions-so-far — refer to it by that name, never by a bare id, number, or slug. A wall of `D-042, D-043, D-044` is illegible; names read at a glance. The id and the link don't vanish — a name wraps its link — but they ride _inside_ the name, never stand in for it.

## The Map

The map is the head of `.factory/backlog/index.md` — the canonical artifact — and its tickets are `## D-NNN:` blocks in the effort's epic file, `.factory/backlog/e<n>-<slug>.md`. There is one index, so there is one map at a time.

The map is an **index**, not a store. It lists the decisions made and points at the tickets that hold their detail; a decision lives in exactly one place — its ticket — so the map never restates it, only gists it and links.

**The map's sections go above the first `## M<n>:` milestone heading, and nothing else in `index.md` changes.** The driver's index parser adopts every `- [name](file) — note` bullet beneath a milestone heading as an epic of that milestone, so a Decisions-so-far bullet written below one would be read as an epic file that does not exist. Above the first milestone heading there is no milestone to adopt it. The `## M<n>: … — <status>` headings are machine-read: leave their shape exactly as found.

### The map body

The whole map at low resolution, loaded once per session. Open tickets are **not** listed — they are the unresolved `D-` blocks in the epic file, found by reading it.

```markdown
## Destination

<what reaching the end of this map looks like — the spec, decision, or change this effort is finding its way to. One or two lines; every session orients to it before choosing a ticket.>

## Notes

<domain; skills every session should consult; standing preferences for this effort>

## Decisions so far

<!-- the index — one line per resolved ticket: enough to judge relevance, then zoom the link for the detail the ticket holds -->

- [<resolved ticket title>](e4-billing.md#d-003-ticket-title-slug) — <one-line gist of the answer>

<!-- the anchor is the ticket's whole heading, lowercased, punctuation dropped, spaces hyphenated — `## D-003: Which store holds the ledger` → `#d-003-which-store-holds-the-ledger`. Link the file alone if you can't build it. -->

## Not yet specified

<!-- see "Fog of war": in-scope fog you can't ticket yet; graduates as the frontier advances -->

## Out of scope

<!-- see "Out of scope": work ruled beyond the destination; closed, never graduates -->
```

### Tickets

Each ticket is a `## D-NNN:` block in the effort's epic file, sitting alongside the tasks that effort will eventually carry; the `D-` id is its identity. The driver's task parser skips every `## ` block whose heading is not `T-<id>`, so decision tickets are invisible to the picker, the grader and the dashboard — they are read by the humans and the live sessions working the map, and by nothing else. The block is the question, sized to one 100K token agent session:

```markdown
## D-003: <Ticket title>
- Question: <the decision or investigation this ticket resolves>
- Kind: grilling
- Type: HITL
- Status: todo
- Deps: D-001
- Answer: <written on resolution; absent until then>
```

`- Kind:` is one of `research`, `prototype`, `grilling`, `task` (see [Ticket Types](#ticket-types)), and `- Type:` is `HITL` or `AFK`, the same vocabulary the tasks in this file use.

A session **claims** a ticket by writing `- Status: in-progress` on it and saving the file, **first**, before any work, so concurrent sessions skip it. That status _is_ the claim: a `todo` ticket is unclaimed. A file claim is only as visible as the file — if anyone else may work this map from another clone, commit and push that line before starting, or your claim is invisible to them until you do.

Blocking is the `- Deps:` field — the ids of the tickets that must resolve first, or `None`. A ticket is **unblocked** when every ticket blocking it is resolved; the **frontier** is the `todo`, unblocked tickets — the edge of the known.

The answer isn't part of the question — it's recorded on resolution (see [Work through the map](#work-through-the-map)). Assets created while resolving a ticket are linked from the ticket, not pasted in.

## Ticket Types

Every ticket is either **HITL** — human in the loop, worked _with_ a human who speaks for themselves — or **AFK**, driven by the agent alone. A HITL ticket only resolves through that live exchange; the agent never stands in for the human's side of it (a grilling agent that answers its own questions has broken this).

- **Research** (AFK): Reading documentation, third-party APIs, or local resources like knowledge bases to surface a fact a decision waits on. Resolved by a `/research` **subagent**. Use when knowledge outside the current working directory is required.
- **Prototype** (HITL): Raise the fidelity of the discussion by making a cheap, rough, concrete artifact to react to — an outline, a rough take, a stub, or UI/logic code via the /prototype skill. Links the prototype as an asset. Use when "how should it look" or "how should it behave" is the key question.
- **Grilling** (HITL): Conversation. The default case. Always invoke the /grilling and /domain-modeling skills.
- **Task** (HITL or AFK): Manual work that must happen before a _decision_ can be made — nothing to decide, prototype, or research, but the discussion is blocked until it's done. Signing up for a service so its API can be judged, provisioning access, moving data so its shape can be seen. This is the one type that _does_ rather than decides — and it earns its place by unblocking a decision, not by delivering the destination. The agent drives it alone where it can (AFK); otherwise it hands the human a precise checklist (HITL). Resolved when the work is done; the answer records what was done and any resulting facts (credentials location, new URLs, row counts) later tickets depend on.

## Fog of war

The map is _deliberately_ incomplete: don't chart what you can't yet see. Beyond the live tickets lies the **fog of war** — the dim view of decisions and investigations you can tell are coming but can't yet pin down, because they hang on questions still open. Resolving a ticket clears the fog ahead of it, graduating whatever's now specifiable into fresh tickets — one at a time, until the way to the destination is clear and no tickets remain.

The map's **Not yet specified** section is where that dim view is written down: the suspected question, the area to revisit later. It's the undiscovered frontier _toward_ the destination — everything here is in scope, just not sharp enough to ticket. Write as loosely or as fully as the view allows; it doubles as a signpost for collaborators reading where the effort is headed.

**Fog or ticket?** The test is whether you can state the question precisely now — _not_ whether you can answer it now.

- **Ticket when** the question is already sharp — even if it's blocked and you can't act on it yet.
- **Not yet specified when** you can't yet phrase it that sharply. Don't pre-slice the fog into ticket-sized pieces: it's coarser than a ticket, and one patch may graduate into several tickets, or none, once the frontier reaches it.

**Not yet specified** excludes what's already decided (Decisions so far), what's already a live ticket, and what's out of scope (the next section).

## Out of scope

Fog only ever gathers _toward_ the destination. The destination fixes the scope, so work beyond it is **out of scope** — it isn't fog, and it doesn't belong in **Not yet specified**. It gets its own **Out of scope** section on the map: work you've consciously ruled out of _this_ effort. Scope, not sharpness, lands it here.

Out-of-scope work never graduates — the frontier stops at the destination — so it returns only if the destination is redrawn, and then as a fresh effort, not a resumption.

Ruling something out of scope is a scoping act, not a step on the route. When a ticket that already exists turns out to sit past the destination — mis-scoped in while charting, or exposed by a resolution — write `- Status: out-of-scope` on it (a ticket that isn't `todo` is unambiguously off the frontier) and leave one line in the **Out of scope** section: the gist plus why it's out of scope, linking the ticket. It stays out of **Decisions so far**, which records the route actually walked — a scope boundary isn't a step on it.

## Invocation

Two modes. Either way, **never resolve more than one ticket per session** — with the exception of research tickets.

### Chart the map

User invokes with a loose idea.

1. **Name the destination.** Run a `/grilling` and `/domain-modeling` session to pin down what this map is finding its way to — the spec, decision, or change. The destination fixes the scope, so it's settled first.
2. **Map the frontier.** Grill again, **breadth-first** this time: fan out across the whole space rather than deep on any one thread, surfacing the open decisions and the first steps takeable now. **If this surfaces no fog** — the way to the destination is already clear, the whole journey small enough for one session — you don't need a map. Stop and ask the user how they'd like to proceed.
3. **Create the map**: write Destination and Notes, an empty Decisions-so-far, and the fog sketched into **Not yet specified**, into the head of `.factory/backlog/index.md` above the first milestone heading. If the effort has no epic file yet, create `.factory/backlog/e<n>-<slug>.md` for it and list it in `index.md` under the milestone it belongs to.
4. **Create the tickets you can specify now** as `## D-NNN:` blocks in that epic file, ids continuing from the highest `D-` already in the backlog, and wire their `Deps:` edges. Wiring sorts them into the frontier and the blocked; everything you can't yet specify stays in the fog — the **Not yet specified** section.
5. **Fire the research subagents.** For each `research` ticket you just created, spin up a `/research` subagent to resolve it in parallel, capturing its findings on a throwaway `research/<name>` branch with a context pointer from the ticket.
6. Stop — charting is one session's work; it hand-resolves nothing.

### Work through the map

User invokes with a map — the repo's, or a ticket in it. A ticket is **optional** — without one, you pick the next decision, not the user.

1. Load the **map** — the head of `index.md`, the low-res view, not every ticket body.
2. Choose the ticket. If the user named one, use it. Otherwise take the first frontier ticket in order. **Claim it**: write `- Status: in-progress` on it before any work.
3. Resolve it — **zoom as needed**: read the full block of any related or resolved ticket on demand; invoke the skills the `## Notes` block names. If in doubt, use `/grilling` and `/domain-modeling`.
4. Record the resolution: write the answer into the ticket's `- Answer:` field, set `- Status: resolved`, and **append a context pointer** to the map's Decisions-so-far.
5. Add newly-surfaced tickets and wire their edges; graduate any fog the answer has made specifiable, clearing each graduated patch from **Not yet specified** so it lives only as its new ticket. If the answer reveals a ticket — this one or another — sits beyond the destination, **rule it out of scope** rather than resolving it on the route. If the decision invalidates other parts of the map, update or delete those tickets.

The user may run unblocked tickets in parallel, so expect other sessions to be editing the backlog concurrently.
