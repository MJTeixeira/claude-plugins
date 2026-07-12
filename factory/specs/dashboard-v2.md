# Spec — dashboard v2: config file, controls, version currency, layout

STATUS: BUILT (2026-07-10) — see NOTES item 48. This is the original build
spec, kept as the design record; §7 (Layout) was rewritten to the code4food
admin console that actually shipped — the original "keep the card layout"
direction was dropped on the owner's call mid-build.

Scope agreed with the owner: single machine only — one dashboard shows the
factories registered on the machine it runs on. No multi-machine fleet view.
Schedule editing is explicitly deferred (see "Out of scope").

Spec'd 2026-07-09 in a planning session with the owner. Goal: the dashboard
graduates from "my monitoring page" to a product component — installable on
machines that are not the owner's Mac or VPS without editing source or unit
files, and able to operate a factory (start, stop, enable/disable), not just
watch it.

## Principles

- **Zero deps, one file, no build step.** `dashboard.mjs` stays a single
  self-contained module with inline HTML/CSS/JS. Anything that needs npm is
  out.
- **File state is the interface.** Every mutation the dashboard performs is
  a file the driver already honors: `.factory/STOP` (graceful stop) and
  `.factory/config.json → enabled` (item 47's declared switch). The
  dashboard never kills processes, never touches systemd units, never edits
  backlogs.
- **Tailnet is primary auth; token is the mutation gate.** Unchanged: no
  token → mutation endpoints refuse (403). Keep the timing-safe compare.
- **The 5s UI tick never waits on the network.** gh facts and the new
  version-currency check refresh on their own background intervals; the
  tick reads caches only (existing pattern, `GH_REFRESH_MS`).

## What exists today (read `factory/driver/dashboard.mjs` first — 615 lines)

- Flags: `--port` (7788), `--listen` (127.0.0.1), `--token`.
- Reads `~/.factory/registry.json` (written by `init.mjs step_registry`);
  per-factory state from file state: `window.lock` + pid liveness,
  `STOP`, `config.json`, backlog parse, `log/state.json` runtime overlay,
  `doctor.json`, `usage.jsonl` rollup, driver-log tail, merge-gate lines.
- gh PR/issue facts, background-cached 2 min.
- ONE mutation: `POST /api/run` (dev/triage, optional `sessions`), gated on
  token; refuses on STOP present, `enabled: false`, or live lock.
- Pages `/` and `/log`; APIs `/api/state`, `/api/log`, `/api/run`.
- Status computed as: `running | stopped | disabled | idle | missing`.
- Deployed via `factory/schedulers/factory-dashboard.service`, which today
  bakes the Tailscale IP and the token into `ExecStart` (portability wart
  and the token is visible in `ps` args — both fixed by this spec).

Related driver facts (do not re-derive — verify by reading):

- `config.json → enabled` (boolean, required — doctor check 11b) is the
  declared OFF switch: dev/triage/report refuse, scheduled fires exit
  silently. `config.json → schedule` declares the scheduler kind
  (`systemd|cron|launchd|schtasks|manual`) — doctor checks declared vs
  installed drift. See `factory.mjs` around lines 963–1030 and NOTES item 47.
- `.factory/STOP`: driver checks it at session boundaries and ends the
  window gracefully (`factory.mjs:1314`, `:2090`). Existence is the signal;
  content is free-form.
- Machine runtime = `~/.factory/runtime`, a git checkout advanced ONLY by
  `deploy-runtime.mjs` (gated ff-only). Last deploy recorded in
  `~/.factory/runtime-deploy.json` (`{ts, from, to, ref, factoriesChecked}`).
- `init.mjs` copies runtime files into projects at init time — at minimum
  `.factory/hooks/guard.mjs` and `.factory/spec-template.md` — which can go
  stale relative to the checkout the dashboard runs from.

## In scope

1. Config file replacing per-machine flag editing.
2. Surface declared state (enabled / schedule kind) and version currency.
3. Stop (write STOP) and resume (remove STOP) from the UI.
4. Enable/disable a factory from the UI (flip the declared switch).
5. Layout refresh.
6. Keep everything the dashboard shows today, and `POST /api/run` as is.

## Out of scope (do not build)

- Schedule editing (changing `OnCalendar`/cron lines). Deferred to its own
  spec — it is the only mutation where bad input silently breaks the
  nightly cadence.
- Multi-machine fleet view, remote agents, state push. One dashboard = one
  machine.
- Kill/force-stop of a running window. STOP-at-boundary is the product.
- Any auth beyond tailnet + token (no users, no sessions, no HTTPS —
  Caddy/Tailscale terminate transport).
- Registry editing (add/remove factories stays `init.mjs`).

## Design

### 1. Config file — `~/.factory/dashboard.json`

```json
{
  "port": 7788,
  "listen": "tailscale",
  "token": "…"
}
```

- All keys optional; defaults `7788` / `"127.0.0.1"` / no token.
- CLI flags still work and override the file (backward compatible; tests
  and one-off runs use flags).
- `"listen": "tailscale"` resolves the machine's Tailscale IPv4 at startup
  via `tailscale ip -4` (first line). If resolution fails, exit with a
  clear message — never silently fall back to 0.0.0.0 or 127.0.0.1: the
  operator declared an intent, honor it or stop.
- If the file holds a `token` and its mode allows group/other read, print a
  startup warning naming the fix (`chmod 600`). Do not chmod for the user.
- Startup line reports where config came from (file, flags, defaults).
- Update `factory/schedulers/factory-dashboard.service`: `ExecStart` becomes
  flagless (`… dashboard.mjs`), install comment says "create
  ~/.factory/dashboard.json first" — the unit file becomes machine-agnostic
  and the token leaves `ps`-visible argv.

### 2. Declared state on the card

- Show `enabled` and `schedule` from each factory's `config.json` as chips
  on the card head (e.g. `⏻ disabled`, `systemd`, `manual`). The `disabled`
  status badge exists — keep it; add the schedule-kind chip.
- `enabled` missing or non-boolean (doctor 11b would fail): show a warning
  chip, and the enable/disable button still works (writing a proper boolean
  fixes the config).

### 3. Stop / resume

- `POST /api/stop?factory=<path>` → write `.factory/STOP`, content
  `stopped from dashboard at <ISO>\n`. 200 whether or not a window is
  running (STOP also blocks future runs — pausing an idle factory before a
  scheduled window is a valid use). 409 only if STOP already exists.
- `POST /api/resume?factory=<path>` → remove `.factory/STOP`. 409 if absent.
- UI copy must say what STOP means: "finishes the current session, then
  stops" when running; "blocks runs until resumed" when idle.

### 4. Enable / disable

- `POST /api/enabled?factory=<path>&value=true|false` → read
  `.factory/config.json`, set `enabled`, write back atomically (write
  `config.json.tmp` in the same dir, `fs.renameSync` over). Preserve every
  other key; 2-space indent + trailing newline (match `init.mjs` output).
- 409 if `config.json` is missing or unparseable — the dashboard never
  invents a config file.
- This flips item 47's declared switch. Timers stay installed; scheduled
  fires exit silently while disabled. Say so in the confirm dialog.

### 5. Version currency

Two independent signals, both cached in the background (new refresh loop,
~30 min interval plus one run at startup; the tick never waits on it):

- **Checkout currency** (header): the checkout the dashboard itself runs
  from — `path.dirname(fileURLToPath(import.meta.url))` resolved to its git
  root. `git rev-parse --short HEAD`, then `git fetch origin <default
  branch> --quiet` and `git rev-list --count HEAD..origin/<branch>`. Render
  `runtime abc1234 · current` or `· N behind — deploy-runtime.mjs`. On the
  VPS this is `~/.factory/runtime`; on a dev Mac it is the repo clone —
  same code path covers both. Any git/network failure → cache
  `{error}` and render `version unknown`, never break the page. If
  `~/.factory/runtime-deploy.json` exists, show last-deploy time in the
  chip's tooltip.
- **Scaffold currency** (per card): byte-compare the project's
  `.factory/hooks/guard.mjs` against the running checkout's
  `factory/driver/hooks/guard.mjs` (and `spec-template.md` against
  `factory/templates/spec-template.md`). Differ → `scaffold stale` chip,
  tooltip "re-run init.mjs on this project to refresh copies". Local reads,
  no network — computable inside `factoryState`.

### 6. HTTP API after this spec

| Route | Method | Gate | Effect |
|---|---|---|---|
| `/api/state` | GET | token if set | reads (now includes declared state, version, scaffold currency) |
| `/api/log` | GET | token if set | driver-log sessions (unchanged) |
| `/api/run` | POST | token REQUIRED | start dev/triage (unchanged) |
| `/api/stop` | POST | token REQUIRED | write `.factory/STOP` |
| `/api/resume` | POST | token REQUIRED | remove `.factory/STOP` |
| `/api/enabled` | POST | token REQUIRED | flip `config.json → enabled` |

Every mutation: POST only; factory param `path.resolve`d and checked
against the registry (existing `handleRun` pattern); plain-text error
bodies with the reason; all effects via `node:fs` — nothing is ever
interpolated into a shell.

### 7. Layout — code4food admin console (as shipped)

The original plan here was "keep the card layout, just add a header strip."
That was dropped mid-build on the owner's call: the dashboard was rebuilt as a
conventional **admin console** in the code4food brand — tokens and logo taken
from code4food.tech (near-black canvas `#0a0a0a`, accent `#5b8cff`, the `>_`
terminal-glyph mark, Nunito / Inter / JetBrains Mono delivered via system-font
fallbacks so the single file stays self-contained; no webfonts). Structure:

- **Left sidebar** — `code4food` wordmark + logo; fleet **filters** (all /
  running / needs-human / paused, with live counts; client-side, they survive
  the tick); footer with machine, runtime version, and mutation state.
- **Top bar** — "Fleet overview" + machine crumb; the checkout version-currency
  chip (`runtime <sha> · current` / `· N behind` / `version unknown`) and the
  last-refresh time.
- **KPI row** — factories · running · needs-human (red when >0) · spend-today
  (with a sparkline).
- **Factory table** — one row per factory: status pill, schedule chip, a mini
  progress bar, sessions-today, cost-today, and health chips (doctor, needs-
  human, ⚠ enabled?, scaffold stale). Each row **expands** to a detail panel:
  - the state-appropriate **control cluster** — `idle` → dev window · next
    task · triage · pause · disable; `running` → stop after session; `stopped`
    → resume · disable; `disabled` → enable; `missing` → none — rendered only
    when the server reports mutations possible (`canRun`); each action
    confirms, disables in flight, and re-ticks;
  - needs-human + PR rows, the last-session line, and collapsed accordions for
    **usage & spend** (cost/tokens/all-time/gate/turn-capped/died/models/
    missing-model-effort tiles + spend sparkline), **tasks** (full table), and
    **driver log**.
- The `/log` page carries the same brand.
- **Responsive** (Tailscale/phone): at ≤900px the sidebar collapses to a top
  strip and the table's secondary columns fold into the row; KPIs go 2-up on
  narrow phones. Dark + light via `prefers-color-scheme`.

## Security invariants (verify before finishing)

1. No token → no mutation route responds with anything but 403.
2. Token compare stays timing-safe (`timingSafeEqual`, length-guarded).
3. Mutations are POST; GETs have no side effects.
4. Factory param validated against the registry before any fs access.
5. Config writes are atomic (tmp + rename) and preserve unknown keys.
6. Default bind stays 127.0.0.1; `"tailscale"` never falls back to a wider
   bind on failure.
7. The token never appears in argv (config-file path), page HTML, or logs.

## Tests — `factory/driver/test/dashboard.test.mjs` (new)

The dashboard has no tests today. Follow the existing conventions
(`helpers.mjs` temp world: fake HOME with its own `~/.factory`, temp
project with `.factory/` scaffold). Support `--port 0` (bind an ephemeral
port and print the real one on the startup line) so tests spawn the real
server and parse the port from stdout. Cover at least:

- config precedence: file < flags; defaults with neither.
- token gating: mutations 403 without token; wrong token 401 everywhere;
  correct token passes.
- stop/resume: STOP file appears with content, `/api/run` then 409s;
  resume removes it; double-stop and resume-without-stop 409.
- enabled flip: `enabled` toggles, sibling keys and formatting survive,
  missing/corrupt `config.json` → 409 and no file created.
- unknown factory → 404 on every route that takes one.
- `/api/state` carries the new fields (declared state, scaffold currency;
  version cache may be `{error}` in the sandbox — assert shape, not value).

`node --check` on the file is already a deploy gate (gate 1 walks
`factory/driver/`); no gate changes needed.

## Docs to update (same session)

- `factory/FACTORY.md` — dashboard paragraph: config file, new controls,
  version chips.
- `ONBOARDING.md` — wherever dashboard launch/flags are described.
- `factory/schedulers/factory-dashboard.service` — per §1.
- `factory/NOTES.md` — append the item per house convention.

## Acceptance checklist

- [ ] Fresh machine: clone runtime, write `~/.factory/dashboard.json`,
      install the (now machine-agnostic) unit — dashboard serves on the
      tailnet with zero source/unit edits.
- [ ] Header shows checkout sha and current/behind/unknown correctly
      (test "behind" by checking out `HEAD~1` in a scratch clone).
- [ ] A factory can be paused, resumed, disabled, enabled, and a window
      started — from a phone — and each action's effect is visible to the
      driver (STOP honored, disabled window refuses).
- [ ] Stale scaffold (edit a byte in a project's `guard.mjs`) shows the
      chip; restoring clears it.
- [ ] All existing information from v1 is still present on the page.
- [ ] `node --test factory/driver/test/` green, including the new file.

## PR-E addendum — honesty + timing batch (2026-07-12, plan .docs/PLAN-factory-dev.md)

Built on top of v2, same principles (zero deps, file state, cached network):

- **Stale-clone guard.** Per-factory, on the 2-min gh cycle: local
  `baseBranch` head vs origin's head (`gh api repos/{owner}/{repo}/branches/
  <base>` — no fetch, the clone is never touched). Verdict `gh.clone
  {base, localSha, remoteSha, behind}`; behind = local head does not contain
  origin's. Behind → "clone behind" badge and run/stop/enabled refuse (409);
  resume stays open (removing a STOP needs no current picture). Unknown
  (gh down, no origin) never blocks. Accepted residual gap: a clone pulled
  fresh during a remote mid-window still looks current.
- **Window timing per card.** Running: `mode · session n/m · time left` from
  window.lock + `maxSessionsPerWindow`. Always: `next <mode> HH:MM` in the
  schedule cell from the P3 declaration via `nextFire()` (schedule.mjs,
  pure, tested; DST-approximate by design). Disabled and manual/legacy
  kind-only render the kind chip alone.
- **Derived factory status** (PR-C): `deriveFactoryStatus` extracted to
  `status.mjs` (shared with factory.mjs); post-overlay task pool renders
  `waiting on owner` (warn) / `deadlocked` (danger) badges — idle with only
  gated work never reads as plain idle. Empty backlog stays "normal".
- **Per-task needs-human pill** links the task's `- Question:` issue.
- **Version chip** wording: `factory <sha> · up to date` / `factory <sha> ·
  N behind — deploy to update` (action in visible text, not tooltip).
