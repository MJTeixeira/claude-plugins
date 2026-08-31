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
// owner its PR merged — nothing goes silent. The KEEP lane gets the
// mirror-image floor (T-020): the routine lanes always had Telegram under
// them, but a failed KEEP send simply vanished — the one lane carrying
// emergencies was the only one with nothing under it. When the telegram
// lane reports an actual failed send (false — not "telegram off", which
// is undefined) and the tracker can post, the message also goes to the
// tracker's questions channel, the owner-attention surface. And like
// every notification path (the notify.mjs contract), failures log and
// never throw: callers must behave identically with notifications broken.
export const makeNotifiers = ({ telegram, tracker, log = () => {} }) => {
  const keep = async (text) => {
    const ok = await telegram(text);
    if (ok === false && typeof tracker?.post === "function") {
      try {
        tracker.post("questions", text);
        log("notify: telegram send failed — emergency mirrored to the tracker's questions channel");
      } catch (e) {
        log(`notify: telegram send failed and the tracker mirror failed too (${String(e.message ?? e).split("\n")[0]})`);
      }
    }
    return ok;
  };
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
