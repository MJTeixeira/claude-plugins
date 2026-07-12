# Backward tracing

For when the failure point is far from the origin: bad data surfaces in layer
N, but was created in layer N-3.

## Method

1. Start at the failure point. Identify the exact value/state that is wrong.
2. Ask: who produced this value? Move one step up the call chain (caller,
   queue producer, previous pipeline stage) and inspect the value THERE.
3. If it's already wrong there, keep moving up. If it's correct there, the
   corruption happened in the step you just crossed — you found the layer.
4. Within that layer, repeat at finer granularity until you can point at the
   line that first produces the wrong value.

## Instrumentation

- When you can't inspect a hop by reading code, add a temporary log/assert at
  that hop printing the value and enough identity to correlate (id, timestamp).
  Prefix every temporary line with a unique marker (e.g. `DBGTRACE`) so they
  are trivially greppable.
- Assertions beat logs when you know the invariant: `assert x is not None`
  fails loudly exactly at the first violation.
- Re-run the repro after each added probe; don't add five probes speculatively.

## Ordering/pollution bugs

If a test fails in the suite but passes alone, the state pollution comes from
an earlier test. Bisect: run the first half of the suite plus the failing
test; whichever half reproduces contains the polluter; recurse.

## Exit rule

Before finishing: `grep` for your marker and delete every temporary probe.
The repro test stays; the instrumentation never ships.
