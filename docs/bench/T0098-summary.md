# T0098 burn-log HUD benchmark

## Environment and method

- Before SHA: `7d659844a0f85dd656ccfecdd85a57561765a356`
- After SHA: `cb90e6bb15630c2eacdcd379a63a8cad66e5ffa3`
- Renderer: ANGLE / NVIDIA GeForce RTX 3070 Laptop GPU / Direct3D 11
- Canvas: 640 x 360, device scale factor 1
- Harness: production Vite build, two cache-prime passes, one deterministic
  900-frame/180-second route (LEO, Moon flyby, Jupiter approach), seed
  `1511506142`
- Raw reports: `T0098-before.json` and `T0098-after.json`

## Before/after result

| Metric             |       Before |        After |      Delta |
| ------------------ | -----------: | -----------: | ---------: |
| Frame median       |     6.100 ms |     6.100 ms |   0.000 ms |
| Frame p75          |     6.100 ms |     6.100 ms |   0.000 ms |
| Frame p99          |     6.500 ms |     6.300 ms |  -0.200 ms |
| Frame-work median  |     2.000 ms |     1.500 ms |  -0.500 ms |
| Frame-work p75     |     2.500 ms |     1.700 ms |  -0.800 ms |
| Frame-work p99     |     7.300 ms |     4.305 ms |  -2.995 ms |
| Steady heap growth |    124,524 B |    128,052 B |   +3,528 B |
| Path heap delta    | 26,694,616 B | 26,615,268 B |  -79,348 B |
| Maximum draw calls |           26 |           26 |          0 |
| Maximum triangles  |       65,094 |       49,530 |    -15,564 |
| Entry gzip         |    285,789 B |    120,945 B | -164,844 B |
| Total gzip         |    561,951 B |    567,544 B |   +5,593 B |

Both reports completed with empty error lists and no stability findings. The
triangle difference reflects the adaptive quality rung selected during each
hardware run; the acceptance-relevant draw and triangle ceilings remained
green. The new total bundle cost is 5,593 gzip bytes and remains below the
570,000-byte gate.

## Interpretation and gates

The burn-log runtime is dynamically imported and awaited before application
bootstrap. Its 2.74 kB gzip feature chunk, preallocated signal graph, and 256
mounted row identities therefore exist before the first gameplay frame and are
not created on panel activation. This split also keeps the entry at 120,945
gzip bytes without weakening the 285,000-byte limit.

The exact-head production performance gate measured 39,348 bytes of retained
heap growth, 10 draw calls, and 77,071 triangles, all within their existing
limits. Its allocation and draw negative controls were both rejected. Absolute
timing is from the available RTX 3070 laptop GPU rather than the specification's
integrated reference target; CI remains the portable final arbiter.
