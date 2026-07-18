# T0071 Trajectory Rendering Benchmark

## Environment and method

- Date: 2026-07-18
- Browser renderer: ANGLE / NVIDIA GeForce RTX 3070 Laptop GPU / D3D11
- Viewport: 640 x 360, hardware rasterizer
- Command: `npm run bench -- --output <ignored-json-path>`
- Schedule: deterministic 900-frame LEO → Moon flyby → Jupiter approach,
  seed `1511506142`
- Baseline: `c2f4353` (documentation-only commits above production `b2fd514`)
- After: `5b64aa0`

Both runs completed with no browser errors and no stability findings. The
prediction worker was active during the post-change production benchmark.

## Results

| Metric                   |     Before |      After |     Delta |
| ------------------------ | ---------: | ---------: | --------: |
| Frame median             |   6.100 ms |   6.100 ms |  0.000 ms |
| Frame p75                |   6.100 ms |   6.100 ms |  0.000 ms |
| Frame p99                |   6.200 ms |   6.201 ms | +0.001 ms |
| Frame-work median        |   1.100 ms |   1.200 ms | +0.100 ms |
| Frame-work p75           |   1.300 ms |   1.400 ms | +0.100 ms |
| Frame-work p99           |   1.900 ms |   2.100 ms | +0.200 ms |
| Maximum draw calls       |         26 |         26 |         0 |
| Maximum triangles        |     66,246 |     66,246 |         0 |
| Steady heap delta        |  +85,732 B |  +75,836 B |  -9,896 B |
| Scripted-path heap delta | +652,156 B | +704,320 B | +52,164 B |
| Entry gzip               |  261,407 B |  267,235 B |  +5,828 B |
| Total build gzip         |  519,825 B |  538,486 B | +18,661 B |

The total includes the new separately emitted 42,350-byte uncompressed
`predictor.worker` asset. The benchmark route completed before the long-horizon
line became visible, so its maximum draw-call count remained unchanged. A real
Chrome playtest with a completed prediction measured 27 total calls, one above
the 26-call baseline and consistent with a visible line plus a hidden
zero-event marker batch. The deterministic overlay regression separately
measured exactly two prediction calls when both line and markers were visible.

## Acceptance evidence

- Dedicated WebGL regression at FOV 45 degrees and 20 degrees: 3 markers,
  3 segments, 2 prediction draw calls, maximum marker/polyline projection
  error `0 px` at both zooms.
- Production module-worker request loaded successfully from Vite.
- Real Chrome playtest: initial prediction completed; changing the target to
  Moon transitioned from `Calculating…` to
  `353,539 km · T−82d 23:25:54.356` in 14.744 s; warp 5× and camera zoom
  remained responsive; 0 console errors and 0 warnings.
- Production completed-trajectory scene: 27 total draw calls, still far below
  the 150-call budget.

## CI workload calibration

The production performance gate waits through its 60-second settle window, so
the real predictor completes and the trajectory line is intentionally visible
when its workload snapshot is taken. T0071 therefore advances the committed
golden from 9 calls / 65,077 triangles to 10 calls / 77,071 triangles. The
single added call and 11,994 added triangles are exactly one maximum-capacity
1,999-segment `Line2`; the zero-event marker batch remains hidden. These values
are the deterministic feature workload, remain far below the 150-call / 500k-
triangle typical-view budgets, and retain the existing +/-10% regression
tolerance for later changes.
