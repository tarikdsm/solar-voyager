# T0055 Navball Benchmark

## Method

All scaffold captures used the unchanged `npm run bench:scaffold` harness with
a production build, Playwright Chromium, a 1280x720 viewport, 120 warmup frames,
and 600 measured frames. The baseline is `main` immediately before T0055. Three
after captures exercise the same exact implementation head. Every scaffold run
selected SwiftShader, recorded no console/page errors, and released its preview
port.

## Before / After

| Metric            | Before (`2cfd14c`) | After (`13d5219`) | Repeat (`13d5219`) | Third (`13d5219`) |
| ----------------- | -----------------: | ----------------: | -----------------: | ----------------: |
| Median frame time |          149.90 ms |         150.00 ms |          150.00 ms |         150.00 ms |
| p75 frame time    |          150.00 ms |         150.10 ms |          150.00 ms |         150.00 ms |
| p99 frame time    |          166.70 ms |         183.30 ms |          183.30 ms |         183.40 ms |
| Internal p99      |          166.68 ms |         166.70 ms |          166.70 ms |         166.70 ms |
| JS heap delta     |         +858,453 B |        +695,776 B |         -358,946 B |        +679,301 B |
| Draw calls        |                  6 |                 6 |                  6 |                 6 |
| Triangles         |             48,564 |            48,564 |             48,564 |            48,564 |
| Sampled UI time   |            0.00 ms |           0.00 ms |            0.00 ms |           0.10 ms |
| Console errors    |                  0 |                 0 |                  0 |                 0 |
| Page errors       |                  0 |                 0 |                  0 |                 0 |

The exact-head captures preserve the median, p75, draw calls, and triangle
count. The outer requestAnimationFrame collector consistently observed one
additional SwiftShader scheduling interval at p99, while the independent
in-loop telemetry remained 166.70 ms in all three after captures. The navball
publisher is included in the measured UI interval and sampled at 0.10 ms or
less, within the 1 ms HUD budget.

## Post-review exact head

| Metric            | Final (`430327d`) | Final repeat (`430327d`) |
| ----------------- | ----------------: | -----------------------: |
| Median frame time |         150.00 ms |                150.00 ms |
| p75 frame time    |         150.00 ms |                150.00 ms |
| p99 frame time    |         183.30 ms |                183.30 ms |
| Internal p99      |         180.23 ms |                183.40 ms |
| JS heap delta     |        +718,161 B |               +340,212 B |
| Draw calls        |                 6 |                        6 |
| Triangles         |            48,564 |                   48,564 |
| Sampled UI time   |           0.00 ms |                  0.00 ms |
| Console errors    |                 0 |                        0 |
| Page errors       |                 0 |                        0 |

The exact post-review implementation replaces the incorrect straight ground
fill with static visible half-ellipse caps. Median/p75 and renderer counts remain
unchanged. Both rolling telemetry windows contained the same approximately one
SwiftShader scheduling-interval tail seen by the outer collector; synchronous UI
publication remained 0.00 ms in both final snapshots.

## Hardware composition A/B

To isolate browser composition from the software-renderer scheduler, an A/B on
the exact final code measured 600 frames with the production navball visible and
600 frames after removing its panel. The simulation and signal publisher remained
active in both variants.

| Metric            | Navball visible | Panel removed |
| ----------------- | --------------: | ------------: |
| Median frame time |         6.10 ms |       6.10 ms |
| p75 frame time    |         6.10 ms |       6.10 ms |
| p99 frame time    |         6.20 ms |       6.20 ms |
| Maximum           |         6.30 ms |       6.50 ms |

The Intel UHD D3D11 renderer produced identical p99 with and without navball
composition, and both variants stayed below the 16.67 ms reference interval.
The exact collector metadata and result are preserved in
`T0055-hardware-ab.json`.

The first and third after samples retained about 0.7 MB, while the immediate
repeat ended with a negative heap delta. This non-GC-forced browser metric is
sensitive to collection timing and does not indicate consistent retained
growth. The static SVG adds no WebGL work, signal publication remains gated to
10 Hz, and all six marker updates preserve component render count at one.

Absolute approximately 7 fps scaffold throughput is SwiftShader performance.
The hardware A/B directly exercises the 60 fps floor and remained comfortably
below a 16.67 ms frame interval.
