# T0054 HUD Framework Benchmark

## Method

Both captures used the unchanged `npm run bench:scaffold` harness with a
production build, Playwright Chromium, a 1280x720 viewport, 120 warmup frames,
and 600 measured frames. The baseline is `main` immediately before T0054 and the
after capture is the independently reviewed implementation head. Both selected
SwiftShader, recorded no console/page errors, and released the preview port.

## Before / After

| Metric            | Before (`7be1878`) | After (`2d4d886`) |      Delta |
| ----------------- | -----------------: | ----------------: | ---------: |
| Median frame time |          149.95 ms |         149.90 ms |   -0.05 ms |
| p75 frame time    |          150.00 ms |         150.00 ms |    0.00 ms |
| p99 frame time    |          166.60 ms |         166.60 ms |    0.00 ms |
| JS heap delta     |       +1,222,220 B |        +332,265 B | -889,955 B |
| Draw calls        |                  6 |                 6 |          0 |
| Triangles         |             48,564 |            48,564 |          0 |
| Console errors    |                  0 |                 0 |          0 |
| Page errors       |                  0 |                 0 |          0 |

The frame-loop integration produced no measurable p75/p99 regression at the
harness resolution, preserved renderer counts, and retained 889,955 fewer bytes
than the baseline sample. Both heap deltas are positive because this existing
scene continues lazy asset work during the measurement window; the lower after
delta is evidence against additional retained growth, not a claim of per-frame
allocation count. Source audit, the simulation benchmark's negative retained
growth, and the browser signal regression complement this GC-sensitive metric.

The after telemetry's latest sampled UI split was 0.100 ms, within the 1 ms HUD
budget. Absolute ~7 fps is SwiftShader throughput and is not evidence for the
reference-hardware 60 fps gate.
