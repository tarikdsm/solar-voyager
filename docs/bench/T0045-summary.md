# T0045 GPU Context and Telemetry Benchmark

## Scope

This comparison covers the production renderer bootstrap and frame telemetry
introduced by T0045. Both production captures used Playwright Chromium at
1280x720 with 120 warmup frames and 600 measured frames. The browser selected
SwiftShader, so absolute frame rate is not evidence for the reference-hardware
60 fps gate; the comparison is useful for regression, context-policy, and
renderer-counter evidence.

## Before / After

| Metric            | Before (`dc611e0`) | After (`ca8434c`) |        Delta |
| ----------------- | -----------------: | ----------------: | -----------: |
| Median frame time |           150.0 ms |          149.9 ms |      -0.1 ms |
| p75 frame time    |           150.0 ms |          150.0 ms |       0.0 ms |
| p99 frame time    |           166.7 ms |          166.7 ms |       0.0 ms |
| Main JS gzip      |          165.61 kB |         169.05 kB |     +3.44 kB |
| JS heap delta     |         -101,456 B |        +825,328 B | GC-sensitive |
| Console errors    |                  0 |                 0 |            0 |
| Page errors       |                  0 |                 0 |            0 |

The raw captures are `T0045-before.json` and `T0045-after.json`. Repeated after
runs produced heap deltas from -2,826,196 B to +825,328 B with identical frame
timings, demonstrating that this legacy single-delta field is dominated by GC
timing. T0092 owns the deterministic 30-second heap-growth-zero gate. T0045's
allocation evidence is the stable preallocated storage tests, hot-loop source
audit, and the isolated 100,000-iteration telemetry regression below.

## Canonical Telemetry Snapshot

The after benchmark consumed the production `RenderTelemetry` instance rather
than reconstructing renderer counters in the harness. Its final 120-frame ring
reported median/p75/p99 of 149.9/150.0/150.1 ms. The 120-frame p99 differs from
the historical 600-frame p99 because the two windows intentionally have
different lengths.

- WebGL2, reversed depth, high-performance preference;
- SwiftShader correctly classified as software;
- major-performance-caveat fallback and warning both recorded;
- GPU timer queries disabled for the software renderer;
- 6 draw calls, 48,564 triangles, and 9,139 points;
- 5 geometries, 7 textures, and 10 programs;
- latest render split 0.3 ms; sim/UI splits 0 ms in the current scaffold.

## Telemetry Overhead Gate

`npm run test:telemetry` executed 100,000 begin/end frame pairs against stable
preallocated storage. The final full-gate run measured 0.000053 ms/frame of net
telemetry overhead; a repeat measured 0.000100 ms/frame. Even the conservative
repeat is 1,000 times below the task's `< 0.1 ms/frame` acceptance limit. The
snapshot identity remained stable and the ring remained capped at 120 samples.
