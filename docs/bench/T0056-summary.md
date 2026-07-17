# T0056 Warp, Energy, and Target UI Benchmark

## Method

All captures used the unchanged `npm run bench:scaffold` harness with a
production build, Playwright Chromium, a 1280x720 viewport, 120 warmup frames,
and 600 measured frames. The baseline is `main` immediately before T0056. Two
captures exercise the initial implementation head and two more exercise the
exact post-review implementation head. Every run selected SwiftShader, recorded
no console/page errors, and released the preview port.

## Before / After

| Metric            | Before (`352c033`) | After (`6581283`) | Repeat (`6581283`) |
| ----------------- | -----------------: | ----------------: | -----------------: |
| Median frame time |          149.90 ms |         149.90 ms |          149.90 ms |
| p75 frame time    |          150.00 ms |         150.00 ms |          150.00 ms |
| p99 frame time    |          166.70 ms |         166.70 ms |          166.70 ms |
| JS heap delta     |          -48,245 B |        +723,279 B |         +131,257 B |
| Draw calls        |                  6 |                 6 |                  6 |
| Triangles         |             48,564 |            48,564 |             48,564 |
| Console errors    |                  0 |                 0 |                  0 |
| Page errors       |                  0 |                 0 |                  0 |

The feature produced no measurable median/p75/p99 regression and preserved the
renderer counts. The first after sample retained 723,279 bytes and an immediate
repeat retained 131,257 bytes. This non-GC-forced browser metric is sensitive to
collection timing and lazy asset activity, so the reports preserve both values
rather than treating either as a per-frame allocation count.

## Post-review exact head

| Metric            | Final (`18b2f31`) | Final repeat (`18b2f31`) |
| ----------------- | ----------------: | -----------------------: |
| Median frame time |         150.00 ms |                149.90 ms |
| p75 frame time    |         150.00 ms |                150.00 ms |
| p99 frame time    |         166.70 ms |                166.70 ms |
| JS heap delta     |        +825,820 B |                -71,068 B |
| Draw calls        |                 6 |                        6 |
| Triangles         |            48,564 |                   48,564 |
| Console errors    |                 0 |                        0 |
| Page errors       |                 0 |                        0 |

The corrected implementation likewise produced no measurable p75/p99
regression and kept renderer counts unchanged. Its immediate repeat ended with
a negative heap delta, which rules out consistent retained growth in this
non-GC-forced sample. The final simulation benchmark also ended with a negative
retained-byte delta, while sampled UI time stayed at 0.10 ms or less.

## Final responsive-input correction

| Metric            | Camera fix (`897b4fe`) | Repeat (`897b4fe`) |
| ----------------- | ---------------------: | -----------------: |
| Median frame time |              150.00 ms |          149.90 ms |
| p75 frame time    |              150.00 ms |          150.00 ms |
| p99 frame time    |              183.20 ms |          166.70 ms |
| JS heap delta     |             +106,788 B |         +846,607 B |
| Draw calls        |                      6 |                  6 |
| Triangles         |                 48,564 |             48,564 |
| Console errors    |                      0 |                  0 |
| Page errors       |                      0 |                  0 |

The first outer-harness capture contained a single p99 timing excursion, while
its independent in-page telemetry remained at 166.70 ms and the immediate
repeat returned to 166.70 ms. Both samples preserved median/p75, renderer counts,
and the UI budget. The change is CSS plus regression instrumentation and adds no
production frame-loop work. A same-head simulation benchmark averaged 0.080992
ms per step and retained -182,304 bytes across 10,000 measured steps.

The hot-path source adds only primitive snapshot and signal assignments;
numeric energy and target telemetry remains gated to 10 Hz. The full signal DOM
regression confirms that unchanged values do not rerender any HUD component,
and `bench:sim` retained -175,872 bytes over 10,000 measured steps. Sampled UI
time was 0.10 ms or less, within the 1 ms HUD budget. Absolute approximately
7 fps is SwiftShader throughput and is not evidence for the reference-hardware
60 fps gate.
