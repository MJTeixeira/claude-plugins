// The canonical distribution repo (migration runbook Phase 0). Machine
// runtimes (~/.factory/runtime) are clones of this repo and advance only by
// fetching it — a runtime pointed anywhere else fetches fine and reports
// "up to date" forever, which is a silently frozen machine. deploy-runtime
// refuses on a mismatched origin and doctor carries a standing row for it.
//
// The URL lives in repo CONTENT on purpose: when the mirror moves, the new
// repo ships the new URL, and a final commit to the retired mirror can ship
// it too — so even a machine frozen on the old remote advances into a loud
// refusal instead of staying green forever.
//
// FACTORY_RUNTIME_ORIGIN overrides the expected URL (forks, test worlds).

export const CANONICAL_ORIGIN = "https://github.com/MJTeixeira/claude-plugins";

export const expectedOrigin = (env = process.env) =>
  env.FACTORY_RUNTIME_ORIGIN || CANONICAL_ORIGIN;

// One remote, many spellings: https/ssh/scp-form, user@, .git suffix,
// trailing slash, letter case. Reduce all of them to host/path.
const normalize = (url) =>
  String(url ?? "")
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "") // scheme://
    .replace(/^([^/@]+)@([^:/]+):/, "$2/") // scp form user@host:path
    .replace(/^[^/@]+@/, "") // user@ in URL form
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();

export const sameOrigin = (a, b) => normalize(a) !== "" && normalize(a) === normalize(b);
