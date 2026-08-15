# T0111 surface collision benchmark

## Environment and method

- Before SHA: `56a4bd9b8775727dfc13a75b452b8a908aa5c6af` (this branch's base, post-T0108)
- Harness: `npm run bench:sim` (`SimulationCore.step` arm A, 1,000 warm-up +
  10,000 sampled frames at 1/60 s), plus a one-off restore-ring arm described
  below and `tools/perf/bundleMeasurement.mjs` against a production build.
- Before and after were measured **serially on an otherwise idle machine**, three
  runs each. An earlier interleaved measurement was discarded: a background
  browser harness was running during it and inflated the baseline to 0.15 ms,
  which would have made this change look free.

This PR adds a per-accepted-step collision scan inside `SimulationCore.step`, so
it touches the frame loop and bench evidence is required by the v2 plan's Global
Constraints even though no `render/` module changed.

## `bench:sim` — cost of the collision scan

| Run      | Before `averageStepMs` | After `averageStepMs` |
| -------- | ---------------------: | --------------------: |
| 1        |               0.078354 |              0.092375 |
| 2        |               0.078375 |              0.089435 |
| 3        |               0.076957 |              0.092342 |
| **Mean** |           **0.077895** |          **0.091384** |

**Delta: +0.013489 ms per step (+17.3%).** Against the 2 ms sim-step budget the
step now costs **4.6%** of budget, up from 3.9%; against a 16.7 ms frame the
added work is 0.08%.

Re-measured after the review fixes — which add one counter increment on a branch
that never fires in normal flight and change nothing else in the step path:
0.087574, 0.089235, 0.090619, mean **0.089143**, inside the spread above.

The increase is real and is dominated by **one extra rails evaluation per
accepted step**, not by the collision arithmetic. The scan needs body positions
at both ends of the accepted segment, and it keeps its own `RailsState` rather
than sharing the derivative's cache. The in-repo rails benchmark reports
0.0237 ms per 50 bodies, so a 43-body evaluation is ≈ 0.020 ms — the same order
as the whole measured delta, while the chord scan itself is 43 iterations of
about twenty flops with an early exit on the common miss.

Sharing `gravityRailsState` would remove most of that: after an accepted step
the derivative has already evaluated rails at the step end (stages k6 and k7 are
both at `t + h`), so the call would usually be a cache hit. It was **not** done,
for two reasons. The cache is keyed on exact time and DP54 snaps `timeSec` to
`endTimeSec` after the final step of a segment, so the common 1x case — one
accepted step clamped to the frame end — can miss by one ULP and recompute
anyway. And sharing one mutable cache between the integrator's force evaluation
and the collision search couples two subsystems that currently cannot corrupt
each other, to buy 0.08% of a frame. Recorded here so a future task that needs
the headroom knows the option exists and what it costs.

`retainedHeapGrowthBytes` stays negative (−205,384 B after, −204,592 B before):
the frame loop retains nothing, and `snapshotBuffers` remains 2.

## Restore ring — allocation evidence (ADR-036 "Allocation")

ADR-036 accepts one allocation per capture instead of a parallel
non-allocating persistence path. Measured with a one-off arm mirroring
`simulationCoreBench.mjs` (forced double GC around the window), 36,000 frames =
**600 s of wall time = 60 capture cycles** at the 10 s cadence:

| Metric                                   |         Value |
| ---------------------------------------- | ------------: |
| Captures retained (ring capacity)        |             6 |
| Retained heap growth over the window     | **−24,880 B** |
| Cost of one `exportPersistentState()`    |   **0.91 µs** |
| Transient bytes per capture              | **≈ 1,029 B** |
| Steady-state bytes held by the full ring |      ≈ 6.2 KB |

So the ring costs about **1 KB of collectable garbage and 0.9 µs once every 600
frames**, and holds ~6 KB steady. Retained growth is negative, i.e. the CI heap
gate (≤ 196,608 B over a 30 s window, measured across a forced double GC) cannot
see it. A frame-overhead column was measured and is deliberately **not** reported:
the with-ring and without-ring arms disagreed by more than their own run-to-run
spread and in the wrong direction, so the number is measurement noise, not a
result. The per-capture figures above are stable across repeats (0.886 µs /
1,015 B and 0.910 µs / 1,029 B on two runs).

## `test:perf-gates`

Passes with empty top-level `findings`. Production heap delta over the 30 s
window: **7,024 B** (gate 196,608 B). Draw calls 10 and triangles 77,071 are
unchanged — this task adds no geometry. The harness's own fault-injection arms
still report their expected findings, so the gate is proving it can still fail.

## Bundle

Measured with `measureBundleSizes('dist')` — the same function the gate uses,
which recurses **all** of `dist/` for `.js`/`.css`, not just `dist/assets` — on
real `npm run build` output for the base commit and for this branch's final
state.

| Metric     |    Before |         After |        Delta |
| ---------- | --------: | ------------: | -----------: |
| Entry gzip | 129,865 B | **133,677 B** | **+3,812 B** |
| Total gzip | 559,645 B | **563,698 B** | **+4,053 B** |

Entry is far inside its 285,000 B ceiling. **Total gzip is not comfortable:** the
golden ceiling is 570,000 B, so after this PR the headroom is **6,302 B (1.1%)**,
down from 10,355 B. This task consumed 39% of the remaining headroom for an
overlay, a signal store and a restore ring.

Per-file gzip of the shipped build, so the next task can plan against real
numbers rather than a single total:

|       Bytes | File                                            |
| ----------: | ----------------------------------------------- |
|     137,341 | `assets/draco_decoder-*.js`                     |
|     133,677 | `assets/index-*.js` (entry)                     |
|      98,299 | `assets/trajectoryOverlay-*.js`                 |
|      58,123 | `assets/three.core-*.js`                        |
|      23,981 | `assets/KTX2Loader-*.js`                        |
|      15,169 | `assets/codecs/basis/basis_transcoder.js`       |
|      13,136 | `assets/GLTFLoader-*.js`                        |
|      12,704 | `assets/predictor.worker-*.js`                  |
|      11,748 | `assets/codecs/draco/draco_wasm_wrapper.js`     |
|      11,348 | `assets/draco_wasm_wrapper-*.js`                |
|      11,219 | `assets/draco_wasm_wrapper-*.js` (second build) |
|      11,116 | `assets/jsxRuntime.module-*.js`                 |
|      10,417 | `assets/basis_transcoder-*.js`                  |
|       6,112 | `assets/index-*.css`                            |
|       3,472 | `assets/systemMapScene-*.js`                    |
|       2,992 | `assets/DRACOLoader-*.js`                       |
|       2,774 | `assets/burnLogRuntime-*.js`                    |
|          70 | `assets/constants-*.js`                         |
| **563,698** | **total, 18 files**                             |

Worth noting for whoever does the re-baseline: the two largest entries are the
Draco decoder (137,341 B) and three separate `draco_wasm_wrapper` copies plus a
`basis_transcoder` duplicated between `assets/` and `assets/codecs/`
(≈ 45,000 B of apparent duplication). None of that is this task's, and none of it
is a budget decision I am authorised to make, but it is where the headroom is if
someone needs it.

No budget is changed here and none needs to be for this PR to land, but the next
UI-bearing task on this milestone — T0112's HUD rebuild is the obvious one — will
very likely need either a deliberate ceiling re-baseline under the plan's §6
procedure or a code-splitting pass. Flagged rather than absorbed, per the
"budgets are revised deliberately, never silently" constraint.

## Goldens

`git diff -- tests/golden/` is empty. Structurally unreachable: the golden
harness drives `createRelativisticDerivative` and `propagate` directly with a
seven-component state and never constructs `SimulationCore`, so no collision code
is on its path, and it omits the new optional `propagate` observer argument.
