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
- Stable-Chrome production regression loaded the real Vite module worker,
  waited for `data-trajectory-ready="true"`, and confirmed the HUD left its
  pending state before evaluating the deterministic zoom fixture. The
  regression supplies a test-only six-hour horizon so the real worker and
  integrator finish deterministically on shared CI runners; normal gameplay,
  the benchmark, and the production performance gate still use the canonical
  90-day-or-longer horizon.
- Malformed success payloads (fewer than two points or non-increasing sample
  times) are rejected before any overlay buffer mutation, surface the
  unavailable state, and leave the client able to retry.
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

## Paused CI status

CI run `29642564311` on head `cf3f1a6` passed Vitest, build, the production
performance gate, application smoke, and every browser regression before the
trajectory step. On the GitHub runner's SwiftShader path, the dedicated test
then remained at `data-trajectory-ready="pending"` for 83.7 seconds and failed
its readiness assertion with no console or page errors. The local six-hour
override is therefore not yet proven at the CI worker boundary. Development is
paused before another fix: the next investigation should instrument the
init-property, main-thread request, protocol payload, and worker executor
horizon in sequence rather than extend the timeout.
