// Jira board sync — the backlog mirrored as issues in a Jira project (or
// under one anchor epic of a shared project, cfg.jiraEpic), the Jira twin
// of factory.mjs's GitHub Projects sync: deterministic driver code, no
// model tokens, backlog markdown stays the source of truth. Factory wins
// on status, humans win on new work. Deltas are RETURNED to the caller
// (factory.mjs owns the inbox + meta-worktree commit); state lives in
// <state>/jira-board.json. Nothing here ever deletes a Jira issue —
// archival is a paid Jira feature and deletion is destructive, so pruned
// cards get the `factory-archived` label and captured human issues get
// `factory-captured`.

import * as fs from "node:fs";
import * as path from "node:path";

// The backlog vocabulary (BOARD_STATUSES in factory.mjs — keep in step).
const STATUSES = ["todo", "in-progress", "review", "blocked", "needs-human", "done"];
// Init maps vocabulary → the project's real workflow statuses by normalized
// name, then via these aliases. Deliberately tight: a wrong guess moves
// real team cards; a missing mapping just degrades to "column not synced".
const ALIASES = {
  todo: ["to do", "open", "backlog"],
  "in-progress": ["in progress", "in dev"],
  review: ["in review", "code review"],
  blocked: ["on hold"],
  "needs-human": ["needs human", "waiting on owner"],
  done: ["closed", "resolved"],
};
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const CARD_LABEL = "factory-task";
const CAPTURED_LABEL = "factory-captured";
const ARCHIVED_LABEL = "factory-archived";

const boardPathIn = (stateD) => path.join(stateD, "jira-board.json");
const readBoard = (stateD) => {
  try { return JSON.parse(fs.readFileSync(boardPathIn(stateD), "utf8")); } catch { return null; }
};
const writeBoard = (stateD, board) =>
  fs.writeFileSync(boardPathIn(stateD), JSON.stringify(board, null, 2) + "\n");

const cardSummary = (t) => `${t.id} — ${t.title}`;
const cardDescription = (t) =>
  [t.model || t.effort ? `Model: ${t.model ?? "?"} · Effort: ${t.effort ?? "?"}` : null, ...(t.links ?? [])]
    .filter(Boolean).join("\n") || "(no links yet)";
// Jira rejects labels containing whitespace; epic names are arbitrary
// backlog filenames.
const cardLabels = (t) => [CARD_LABEL, ...(t.epic ? [`epic:${String(t.epic).trim().replace(/\s+/g, "-")}`] : [])];

// One-time `sync-board --init`: map the vocabulary onto the project's
// workflow and write the state file. Missing columns are LOUD but not
// fatal (owner decision 2026-07-18): the board works minus those lanes,
// and the owner adds columns in Jira's UI whenever — re-init picks them up.
export const jiraBoardInit = ({ jira, stateD, say }) => {
  const available = jira.board.projectStatuses();
  const byNorm = new Map(available.map((s) => [norm(s.name), s.name]));
  const statusMap = {};
  const missing = [];
  for (const v of STATUSES) {
    const hit = byNorm.get(norm(v)) ?? (ALIASES[v] ?? []).map((a) => byNorm.get(a)).find(Boolean);
    if (hit) statusMap[v] = hit;
    else missing.push(v);
  }
  const prev = readBoard(stateD);
  writeBoard(stateD, {
    statusMap, missing,
    // Same lesson as the GitHub board's phantom-cards incident (NOTES,
    // fleet incident 2026-07-12): re-init must never orphan tracked cards.
    items: prev?.items ?? {}, pendingMoves: prev?.pendingMoves ?? {},
  });
  say(`status map: ${Object.entries(statusMap).map(([k, v]) => `${k} → "${v}"`).join(", ")}`);
  if (missing.length) {
    say(`MISSING columns (these lanes will not sync until the Jira workflow grows them and --init reruns): ${missing.join(", ")}`);
  }
};

// The recurring sync. Returns { newcomers, humanMoves } for the caller to
// write into inbox/board-delta.md (empty arrays = nothing to report), or
// null when there is no state file yet. THROWS on API failure — the caller
// wraps (sync must never affect the run, same rule as the GitHub path).
export const syncJiraBoard = ({ jira, stateD, tasks, log }) => {
  const board = readBoard(stateD);
  if (!board) { log("jira board sync: no jira-board.json — run sync-board --init once"); return null; }
  board.pendingMoves ??= {};
  const cards = jira.board.searchCards();
  const byKey = new Map(cards.map((c) => [c.key, c]));
  const jiraToVocab = new Map(Object.entries(board.statusMap).map(([v, name]) => [norm(name), v]));
  // Orphan adoption: a card with our label whose summary names a task we
  // do not track means the state file lost a create (crash mid-sync).
  // Re-adopting by summary beats recreating — a duplicate on a shared
  // board can never be deleted again.
  const adoptable = new Map();
  for (const c of cards) {
    if (!c.labels.includes(CARD_LABEL)) continue;
    const id = c.summary.split(" — ")[0].trim();
    if (id && !adoptable.has(id)) adoptable.set(id, c);
  }
  const humanMoves = [];
  let created = 0, adopted = 0, moved = 0, archived = 0, edited = 0;

  for (const t of tasks) {
    let rec = board.items[t.id];
    if (!rec || !byKey.has(rec.key)) {
      const orphan = adoptable.get(t.id);
      if (orphan) {
        rec = board.items[t.id] = { key: orphan.key, status: null, seenName: null };
        adopted += 1;
      } else {
        const { key } = jira.board.createCard({ summary: cardSummary(t), description: cardDescription(t), labels: cardLabels(t) });
        rec = board.items[t.id] = { key, status: null, seenName: null };
        byKey.set(key, { key, summary: cardSummary(t), status: null, labels: cardLabels(t), done: false });
        created += 1;
      }
    }
    const cur = byKey.get(rec.key);
    const curVocab = cur.status ? (jiraToVocab.get(norm(cur.status)) ?? null) : null;
    // seenName: the raw Jira status we last left the card in (pre-seenName
    // state files derive it from what we last pushed). Comparing raw names
    // — not vocabulary — keeps the human-move detector alive for drags to
    // columns OUTSIDE the vocabulary (QA, In Deployment, ...).
    rec.seenName ??= rec.status ? board.statusMap[rec.status] ?? null : null;

    // Inbound: the card differs both from where we left it AND from the
    // backlog — MAYBE a human moved it. One observation proves nothing
    // (stale reads; the GitHub board earned phantom moves this way, NOTES
    // item 31): hold, remember, and only report when the SAME value is
    // still there on the next sync.
    let holdOff = false;
    let confirmedMove = null;
    if (cur.status && rec.seenName && norm(cur.status) !== norm(rec.seenName) && curVocab !== t.status) {
      if (board.pendingMoves[t.id] === norm(cur.status)) {
        confirmedMove = { taskId: t.id, boardStatus: cur.status, backlogStatus: t.status, restored: false };
        humanMoves.push(confirmedMove);
        delete board.pendingMoves[t.id];
        // fall through: the outbound write below tries to restore
      } else {
        board.pendingMoves[t.id] = norm(cur.status);
        holdOff = true;
      }
    } else if (board.pendingMoves[t.id]) {
      delete board.pendingMoves[t.id]; // healed itself — stale read
    }

    if (!holdOff) {
      const target = board.statusMap[t.status];
      if (!target) {
        if (rec.status !== t.status) log(`jira board sync: ${t.id} is "${t.status}" — no mapped column, card stays in "${cur.status ?? "?"}"`);
        rec.status = t.status; // remember anyway: log once, not every sync
        rec.seenName = cur.status ?? rec.seenName; // accept board reality — no re-report loop
      } else if (norm(cur.status ?? "") !== norm(target)) {
        const tr = jira.board.transitions(rec.key).find((x) => norm(x.toStatus ?? "") === norm(target));
        if (tr) {
          jira.board.transition(rec.key, tr.id);
          moved += 1; rec.status = t.status; rec.seenName = target;
          if (confirmedMove) confirmedMove.restored = true;
        } else {
          log(`jira board sync: no transition from "${cur.status}" to "${target}" for ${t.id} — workflow forbids it`);
          rec.status = t.status;
          rec.seenName = cur.status ?? rec.seenName; // accept board reality — no re-report loop
        }
      } else {
        rec.status = t.status; rec.seenName = cur.status;
      }
    }

    if (cur.summary !== cardSummary(t)) { jira.board.updateCard(rec.key, { summary: cardSummary(t) }); edited += 1; }
  }

  // Checkpoint the map BEFORE the newcomer/prune writes: a curl failure
  // below must not orphan the cards created above (orphans get adopted,
  // but never earning them is better).
  writeBoard(stateD, board);

  // Inbound: issues in scope no one tracks — human-filed work. Tracker
  // issues ([factory] prefix: questions, daily log), factory cards
  // (orphans carry our label), already-processed captures, and CLOSED
  // history (a pre-existing epic's resolved issues are noise, not new
  // work) are not newcomers. Captured issues stay on the board until
  // triage folds them in and closes them (no deletion, ever).
  const trackedKeys = new Set(Object.values(board.items).map((r) => r.key));
  const newcomers = cards.filter((c) =>
    !trackedKeys.has(c.key)
    && !c.done
    && !/^\[factory\]/i.test(c.summary)
    && !c.labels.includes(CARD_LABEL)
    && !c.labels.includes(CAPTURED_LABEL)
    && !c.labels.includes(ARCHIVED_LABEL));
  for (const n of newcomers) {
    try { jira.board.addLabel(n.key, CAPTURED_LABEL); } catch { /* recaptured next sync */ }
  }

  // Prune: tasks gone from the backlog. Label and forget.
  const live = new Set(tasks.map((t) => t.id));
  for (const [taskId, rec] of Object.entries(board.items)) {
    if (live.has(taskId)) continue;
    if (byKey.has(rec.key)) { try { jira.board.addLabel(rec.key, ARCHIVED_LABEL); archived += 1; } catch { /* keep it */ } }
    delete board.items[taskId];
  }

  writeBoard(stateD, board);
  if (created || adopted || moved || archived || edited) {
    log(`jira board sync: ${created} created, ${adopted} adopted, ${moved} moved, ${edited} retitled, ${archived} archived-by-label`);
  }
  return { newcomers, humanMoves };
};
