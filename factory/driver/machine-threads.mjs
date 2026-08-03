// Doctor machine-thread sensor — the pure half (spec:
// factory/specs/delegation.md seam 1). A red scheduled preflight used to
// only Telegram and die, leaving each affected task to park separately
// (the zeroone shape: one invalid gh token → N parks). Instead, every
// MACHINE-SCOPED red doctor row files or refreshes ONE tracker thread per
// (machine, fact), and the sensor that opened it closes it: the next
// green doctor for that fact ✔-closes with machine-verified evidence.
// No trust machinery — the machine's own probe is the authority here.
//
// This module is deterministic decision logic over injected state; the
// tracker/filesystem glue lives in factory.mjs. State is MACHINE-level
// (~/.factory/machine-threads.json), not per-factory: two factories on
// one box detecting the same dead token must converge on one thread.

// The enumerated machine-scoped row set: rows whose failure is a fact
// about the BOX (auth, tools, scheduler PATH, peer client) — fixable by
// an executor or the owner at the machine, never by a session. Project
// rows (trust, scaffold, backlog drift, config keys) stay out: those are
// factory-config or owner territory, not machine facts.
const MACHINE_ROW = /(^|\s)(on PATH$|auth(\s|$)|auth scopes|peer client|systemd service PATH)/;
export const isMachineRow = (name) => MACHINE_ROW.test(String(name ?? ""));

// Stable fact slug: the row name, lowercased, non-alphanumerics collapsed.
// The thread map keys and thread titles both derive from it, so a detail
// string that varies per run (ports, SHAs) can never fork threads.
export const factSlug = (name) => String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export const threadTitle = (machine, row) => `[${machine}] ${row.name}${row.detail ? ` — ${String(row.detail).split("\n")[0].slice(0, 60)}` : ""}`;

// Decide what the sensor should do this run. Inputs: machine name, the
// doctor results, the persisted map {"<machine>|<slug>": {threadId,
// openedAt, lastCommentDay}}, and today's YYYY-MM-DD. Output: actions
// [{kind: "open"|"comment"|"close", ...}] and the next map. Comment
// throttle: at most one still-red comment per fact per DAY — scheduled
// preflights fire per window, and three windows a day must not triple-post.
export const senseMachineFacts = ({ machine, results, map = {}, today }) => {
  const actions = [];
  const next = { ...map };
  const rows = (results ?? []).filter((r) => isMachineRow(r.name));
  const redByKey = new Map();
  for (const r of rows.filter((r) => r.level === "fail")) redByKey.set(`${machine}|${factSlug(r.name)}`, r);

  for (const [key, row] of redByKey) {
    const known = next[key];
    if (!known?.threadId) {
      actions.push({ kind: "open", key, row });
    } else if (known.lastCommentDay !== today) {
      actions.push({ kind: "comment", key, row, threadId: known.threadId });
    }
  }
  // Green rows close their thread — but only rows this doctor RAN: a fact
  // absent from today's results (row set changed, tracker off) is unknown,
  // not fixed, and its thread stays open.
  const ranKeys = new Set(rows.map((r) => `${machine}|${factSlug(r.name)}`));
  for (const [key, known] of Object.entries(next)) {
    if (!key.startsWith(`${machine}|`) || redByKey.has(key)) continue;
    if (!known?.threadId || !ranKeys.has(key)) continue;
    const row = rows.find((r) => `${machine}|${factSlug(r.name)}` === key);
    actions.push({ kind: "close", key, threadId: known.threadId, row });
  }
  return { actions, next };
};

// Apply an action's outcome back into the map (the glue calls this after
// the tracker call succeeded — a failed post must not mark the fact
// handled, or the retry never happens).
export const recordOutcome = (map, action, { threadId, today }) => {
  const next = { ...map };
  if (action.kind === "open") next[action.key] = { threadId, openedAt: today, lastCommentDay: today };
  else if (action.kind === "comment") next[action.key] = { ...next[action.key], lastCommentDay: today };
  else if (action.kind === "close") delete next[action.key];
  return next;
};
