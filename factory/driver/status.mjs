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
  if (open.some((t) => !parked(t) && !depBlocked(t, statusById))) return { status: "normal", detail: null };
  const nh = open.filter((t) => t.status === "needs-human").map((t) => t.id);
  if (nh.length) return { status: "waiting-on-owner", detail: `waiting on owner (${nh.length}): ${nh.join(", ")}` };
  return { status: "deadlocked", detail: `deadlocked — every open task is dependency-blocked: ${open.map((t) => t.id).join(", ")}` };
};
