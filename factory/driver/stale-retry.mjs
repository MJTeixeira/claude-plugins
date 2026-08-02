// Stale-parked retry lane (spec factory/specs/stale-parked-retry.md): one
// escalated look at a parked task before it rots. Pure pieces only — the
// driver (factory.mjs) owns the trigger points (window skip / no-tasks),
// the session spawn, and the state/marker writes' surroundings.
import * as fs from "node:fs";
import * as path from "node:path";

// Pick the OLDEST eligible parked task, or null. Eligibility (all must hold):
// parked status, parked at least staleRetryDays (a record with no updatedAt
// predates the stamp and counts as old enough), no retry recorded since the
// current park, not claimed by a human's open PR, and its linked question —
// when question state is known (openQuestionUrls is a Set) — still open and
// unanswered: an answered question is triage's fold, never a retry's.
// openQuestionUrls null = tracker unavailable; the lane stays alive.
export const selectStaleRetry = ({ tasks, state, now = Date.now(), staleRetryDays = 1, claimedIds = new Set(), openQuestionUrls = null }) => {
  const days = Number(staleRetryDays);
  if (!Number.isFinite(days) || days <= 0) return null; // 0 disables the lane
  const cutoff = now - days * 24 * 3600 * 1000;
  const recs = state?.tasks ?? {};
  const eligible = [];
  for (const t of tasks ?? []) {
    if (t.status !== "blocked" && t.status !== "needs-human") continue;
    const rec = recs[t.id] ?? {};
    const parkedAt = rec.updatedAt ? Date.parse(rec.updatedAt) : NaN;
    if (Number.isFinite(parkedAt) && parkedAt > cutoff) continue; // too fresh
    // One retry per park: only a park NEWER than the last retry re-arms it.
    const retryAt = rec.retry?.at ? Date.parse(rec.retry.at) : NaN;
    if (Number.isFinite(retryAt) && !(Number.isFinite(parkedAt) && parkedAt > retryAt)) continue;
    if (claimedIds.has(t.id)) continue;
    if (t.question && openQuestionUrls && !openQuestionUrls.has(t.question)) continue;
    eligible.push({ t, parkedAt: Number.isFinite(parkedAt) ? parkedAt : 0 });
  }
  eligible.sort((a, b) => a.parkedAt - b.parkedAt);
  return eligible[0]?.t ?? null;
};

// Outcome vocabulary (spec): `recovered` — the task re-entered the working
// pool (delivered through the graded path, or resumed as a normal task);
// `gate-held` — machine half delivered, waiting at the owner's Gate: human;
// `still-stuck` — blocker confirmed, owner input genuinely required, or the
// session died without reporting.
export const retryOutcome = (result, task) => {
  const status = result?.status ?? null;
  if (status === "review" && task?.gate === "human") return "gate-held";
  if (["completed", "review", "in-progress", "incomplete"].includes(status)) return "recovered";
  return "still-stuck";
};

// Append a `- Retried:` line under the task's Status line (the
// addTaskLinkInFiles precedent) — visible to triage and the owner without
// opening state; inert to backlog-index's field parsers. True = a file changed.
export const appendRetryLine = (backlogDir, taskId, line) => {
  if (!fs.existsSync(backlogDir)) return false;
  for (const f of fs.readdirSync(backlogDir).filter((f) => f.endsWith(".md") && f !== "index.md")) {
    const p = path.join(backlogDir, f);
    const text = fs.readFileSync(p, "utf8");
    const m = text.match(new RegExp(`^## ${taskId}:.*$`, "m"));
    if (!m) continue;
    const start = m.index;
    const nextHead = text.indexOf("\n## ", start + 1);
    const end = nextHead === -1 ? text.length : nextHead;
    const block = text.slice(start, end);
    const updated = block.replace(/^(-\s*Status:.*)$/m, `$1\n${line}`);
    if (updated === block) return false; // no Status line to anchor on
    fs.writeFileSync(p, text.slice(0, start) + updated + text.slice(end));
    return true;
  }
  return false;
};

// The task's block, verbatim, for the exit-criteria-only retry prompt.
export const extractTaskBlock = (backlogDir, taskId) => {
  if (!fs.existsSync(backlogDir)) return null;
  for (const f of fs.readdirSync(backlogDir).filter((f) => f.endsWith(".md") && f !== "index.md")) {
    const text = fs.readFileSync(path.join(backlogDir, f), "utf8");
    const m = text.match(new RegExp(`^## ${taskId}:.*$`, "m"));
    if (!m) continue;
    const nextHead = text.indexOf("\n## ", m.index + 1);
    return text.slice(m.index, nextHead === -1 ? text.length : nextHead).trim();
  }
  return null;
};
