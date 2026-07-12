# Browser debugging

For frontend symptoms: wrong rendering, dead interactions, failing requests,
state bugs in a webapp. Use the browser tools available in the session
(Chrome DevTools MCP or Playwright MCP).

## Setup

- Run the app in real mode against its normal dev backend — do NOT switch to
  mock mode to make debugging easier; mocks hide the bug class you're hunting.
- If the flow needs auth and you have no credentials, ask the user for a test
  login once; don't stub auth out.

## The loop

1. Navigate to the failing flow and reproduce it via the browser tools
   (click/fill/navigate), not by assuming.
2. After reproducing, collect evidence in this order — cheapest first:
   - **Console messages** — errors and warnings that appeared during the repro.
   - **Network requests** — status codes, payloads, and requests that never
     fired (a missing request is as telling as a failed one).
   - **Screenshot/snapshot** — what actually rendered vs what should have.
   - **Evaluate script** — inspect live app state (store contents, DOM
     attributes) when console/network don't explain it.
3. Feed the evidence back into the main debugging loop (one hypothesis →
   cheapest experiment). The experiment is often an `evaluate_script` probe or
   a temporary `console.log` in the source with a `DBGTRACE` marker.
4. Once root-caused: write the repro as a proper test where feasible
   (component/e2e), fix, re-drive the browser flow to confirm, and delete all
   temporary logging.

## Gotchas

- Hard-reload after source changes; stale bundles waste hypotheses.
- Check the terminal running the dev server too — SSR/build errors often
  surface there, not in the browser console.
