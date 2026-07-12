// Factory-level status derived from the task pool (PR-C vocabulary). Pure —
// shared by factory.mjs (window skip, digest) and dashboard.mjs (card badge)
// so the two can never disagree about what "waiting on owner" means.
//
// Anything not parked (blocked/needs-human) or done counts as actionable —
// unknown statuses too, so a typo can never silently skip windows. "Idle with
// only gated work" is `waiting-on-owner`, never plain idle; `deadlocked`
// (nothing even the owner is asked to clear) is the louder alarm.
export const deriveFactoryStatus = (tasks) => {
  const open = tasks.filter((t) => t.status !== "done");
  if (!open.length) return { status: "done", detail: "backlog complete — nothing left to build" };
  if (open.some((t) => t.status !== "blocked" && t.status !== "needs-human")) return { status: "normal", detail: null };
  const nh = open.filter((t) => t.status === "needs-human").map((t) => t.id);
  if (nh.length) return { status: "waiting-on-owner", detail: `waiting on owner (${nh.length}): ${nh.join(", ")}` };
  return { status: "deadlocked", detail: `deadlocked — every open task is dependency-blocked: ${open.map((t) => t.id).join(", ")}` };
};
