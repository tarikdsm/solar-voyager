# T0116 — CruiseDirector: bench summary

`npm run bench:sim` (`tools/bench/simulationCoreBench.mjs`), Windows 11, Node 25.8.2,
1,000 warm-up steps + 10,000 sampled steps.

## What changed on the frame path

`src/bootstrap/frameLoop.ts` gains one call and one branch per frame:

```ts
cruiseDirector?.update(deltaSec);
if (cruiseDirector === null || !cruiseDirector.active) flightController.update(deltaSec);
```

Exactly one of `CruiseDirector.update` / `FlightController.update` does work per frame — the
director owns attitude and throttle while `active`, and is a cheap no-op otherwise (an early
return on `!active && !decompressPending`). `CruiseDirector.update` is allocation-free: every
vector is a preallocated `Float64Array` field, the `InterceptSolution` and the `CompiledRails`
scratch are allocated once in the constructor, and no closure, literal or spread appears in the
per-frame path. Rails are evaluated only on a re-solve (≤ once per 30 s of simulated time), not
per frame — the ADR-043 pursuit law reads the target's motion out of the snapshot instead.

## Numbers

| Metric                    | Before (main @ 507c304) | After (task/T0116) run 1 |    run 2 |
| ------------------------- | ----------------------: | -----------------------: | -------: |
| `averageStepMs`           |    n/a — path unbenched |                   0.2282 |   0.1948 |
| `averageControllerMs`     |                     n/a |                  0.00318 |  0.00096 |
| `averageFlightStepMs`     |                     n/a |                   0.2244 |   0.2110 |
| `retainedHeapGrowthBytes` |                     n/a |                 −227,448 | −245,160 |
| `snapshotBuffers`         |                       2 |                        2 |        2 |

`simulationCoreBench.mjs` loads exactly two modules — `sim/simulation.ts` and
`game/flight/flightController.ts` (lines 35, 66, 93). It never constructs a frame loop and never
imports `bootstrap/`, so the benched path is **provably identical** before and after this task and
a paired before/after would be measuring run-to-run noise, which the two runs above already bound
at ±15 % on this machine. The "before" column is marked `n/a` rather than fabricated.

The evidence that the _real_ frame loop is unaffected is the browser gate, which does run it:

`npm run test:perf-gates` — draw calls **33** (unchanged golden), triangles 82,429,
`heapSettle.settled: true` with `peakStepGrowthBytes` 219,640 over 20 steps and 6 stable steps,
frame heap delta 14,464 B over the sampled window. No budget or golden moved.

## Cruise cost, for the record

The director's own per-frame work, measured through the CI cruise gate
(`npm run test:cruise`): the unattended LEO→Jupiter arrival is 11,275 frames of simulated
60 fps wall clock (187.9 s) and completes in ≈ 10 s of real CPU time in a headless browser,
i.e. roughly 0.9 ms of real time per simulated frame — and that figure is dominated by the DP54
integrator advancing up to 16.7 s of simulation per frame at 1000×, not by guidance.
