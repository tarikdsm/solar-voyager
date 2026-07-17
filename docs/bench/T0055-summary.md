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

To isolate browser composition from the software-renderer scheduler, an A/B
diagnostic on the same production build measured 120 frames with the navball
visible and 120 frames after removing its panel. On the machine's Intel UHD
D3D11 renderer, both variants measured 6.20 ms at p99; maxima were 6.40 ms with
the navball and 6.50 ms without it. This rules out the SVG/CSS panel as the cause
of the external SwiftShader tail.

The first and third after samples retained about 0.7 MB, while the immediate
repeat ended with a negative heap delta. This non-GC-forced browser metric is
sensitive to collection timing and does not indicate consistent retained
growth. The static SVG adds no WebGL work, signal publication remains gated to
10 Hz, and all six marker updates preserve component render count at one.

Absolute approximately 7 fps scaffold throughput is SwiftShader performance
and is not evidence for the reference-hardware 60 fps gate. The hardware A/B
diagnostic remained comfortably below a 16.67 ms frame interval.
