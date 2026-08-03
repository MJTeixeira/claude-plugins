// Owner-notification router (spec: factory/specs/owner-message-format.md):
// Telegram carries errors and emergencies ONLY; routine owner traffic rides
// the Discord tracker's per-type channels. Three lanes:
//
//   notify(text)          Telegram — the KEEP class (aborts, quarantines,
//                         divergence, doctor-red refusals, dead sessions,
//                         unrecoverable repos). Exactly the old behavior.
//   notifyActivity(text)  the tracker's activity channel — the MOVE class
//                         (merged PRs, review requests, parks).
//   notifyDigest(text)    the digests channel — cycle digests.
//
// Both tracker lanes fall back to the Telegram lane when the tracker
// cannot carry the message (not a posting tracker, channel unset, or the
// post throws): a GitHub-tracker factory without Discord still tells the
// owner its PR merged — nothing goes silent. And like every notification
// path (the notify.mjs contract), failures log and never throw: callers
// must behave identically with notifications broken.
export const makeNotifiers = ({ telegram, tracker, log = () => {} }) => {
  const keep = async (text) => telegram(text);
  const viaTracker = (kind) => async (text) => {
    if (typeof tracker?.post !== "function") return keep(text);
    try {
      tracker.post(kind, text);
    } catch (e) {
      log(`notify: ${kind} post failed (${String(e.message ?? e).split("\n")[0]}) — falling back to telegram`);
      return keep(text);
    }
  };
  return { notify: keep, notifyActivity: viaTracker("activity"), notifyDigest: viaTracker("digests") };
};
