// Factory-level status derived from the task pool (PR-C vocabulary). Pure —
// shared by factory.mjs (window skip, digest) and dashboard.mjs (card badge)
// so the two can never disagree about what "waiting on owner" means.
//
// Anything not parked (blocked/needs-human) or done counts as actionable —
// unknown statuses too, so a typo can never silently skip windows. "Idle with
// only gated work" is `waiting-on-owner`, never plain idle; `deadlocked`
// (nothing even the owner is asked to clear) is the louder alarm.
// A task the plan picker would skip is not work this factory can do, so it
// must not read as `normal` here either — that gap ran dev windows against
// backlogs where nothing was runnable and paid for the sessions (T-026).
// The rule matches the picker's exactly (factory.mjs, plan loop): a dep
// blocks only when it names a task we KNOW about that is not done, so an id
// pointing outside this pool is not a block. `Gate: human` is deliberately
// not consulted — a gated task with satisfied deps is still buildable work.
const depBlocked = (t, statusById) =>
  (t.deps ?? []).some((d) => statusById.has(d) && statusById.get(d) !== "done");

export const deriveFactoryStatus = (tasks) => {
  const open = tasks.filter((t) => t.status !== "done");
  if (!open.length) return { status: "done", detail: "backlog complete — nothing left to build" };
  const statusById = new Map(tasks.map((t) => [t.id, t.status]));
  const parked = (t) => t.status === "blocked" || t.status === "needs-human";
  // `Gate: owner-runs` marks work only the owner may DO — creating a
  // credential, a deploy only he may run (T-084). It is open, but it is not
  // capacity: a backlog holding nothing else has nothing a session could
  // touch, and a window that spawned one would burn it confirming that.
  const ownerRuns = (t) => t.gate === "owner-runs";
  if (open.some((t) => !parked(t) && !ownerRuns(t) && !depBlocked(t, statusById))) return { status: "normal", detail: null };
  const nh = open.filter((t) => t.status === "needs-human").map((t) => t.id);
  const or = open.filter((t) => !parked(t) && ownerRuns(t)).map((t) => `${t.id} (owner-runs)`);
  const waiting = [...nh, ...or];
  if (waiting.length) return { status: "waiting-on-owner", detail: `waiting on owner (${waiting.length}): ${waiting.join(", ")}` };
  return { status: "deadlocked", detail: `deadlocked — every open task is dependency-blocked: ${open.map((t) => t.id).join(", ")}` };
};
