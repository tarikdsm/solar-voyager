# T0091 — Adaptive quality governor evidence

Captured by `npm run test:perf-governor` on 2026-07-17. The browser regression applies every concrete quality profile to the same Earth scene and verifies the resulting render resources before taking each screenshot.

## Before / after scaffold benchmark

Both captures used the unchanged `npm run bench:scaffold` harness at 640x360 with 120 warm-up frames and 600 measured frames. They ran sequentially on the same SwiftShader endpoint, recorded no console or page errors, and released the preview port. The baseline is the design-only commit before T0091 implementation; the after capture is the corrected implementation head.

| Metric                   | Before (`4b26897`) | After (`50c258e`) |        Delta |
| ------------------------ | -----------------: | ----------------: | -----------: |
| Median frame             |            83.4 ms |           83.4 ms |       0.0 ms |
| p75 frame                |            83.4 ms |          100.0 ms |     +16.6 ms |
| p99 frame                |           100.1 ms |          116.7 ms |     +16.6 ms |
| Average FPS              |             11.484 |            11.043 |       -0.441 |
| Star points              |              9,139 |             2,043 |       -7,096 |
| Programs                 |                 29 |                29 |            0 |
| Heap delta after warm-up |         -458,560 B |      -2,636,123 B | -2,177,563 B |

The governor performed all 14 reductions and reached the 2,000-star cap without increasing the program count or retaining heap. Absolute frame time is SwiftShader throughput, not a reference-hardware result: the p75/p99 shift is exactly one 16.7 ms software-renderer scheduling interval. The useful evidence here is stable programs, the applied workload reduction, non-positive retained heap, and no console or page errors. Raw captures are `T0091-before.json` and `T0091-after.json`.

## Automated results

- Synthetic overload: converged from R00 to R02 in two actions; final p75 was 14 ms (below the 15.5 ms overload threshold), within the three-rung acceptance limit.
- Manual lock: the low lock selected R14 once, then 20 low-frame-time samples produced no governor step-up actions.
- Shader stability: 41 programs after startup warm-up and 41 programs at every rung, so no quality transition compiled a runtime shader.
- Resource stability: 1,500 rung transitions retained the same composer/bloom render targets and, after forced GC, retained no JS heap (final observed delta -818,654 bytes).
- Window integrity: automatic evidence is ignored until all 120 frame-time samples exist.
- Star coverage: the brightest 2,000 indexed stars reach both hemispheres on X/Y/Z (all extrema beyond ±0.998), instead of retaining an HR-catalog prefix.
- Ordered effects: single-chain viewport/UV render scale, bloom resolution/off, SMAA/FXAA/off, procedural octaves, star draw cap, real texture/model variants, and model threshold are asserted independently.

## Rung evidence

| Rung | Tier | Change introduced                        | Evidence                               |
| ---: | ---: | ---------------------------------------- | -------------------------------------- |
|  R00 |   Q6 | Baseline: scale 1.00, full bloom, SMAA   | [rung-00.png](T0091-rungs/rung-00.png) |
|  R01 |   Q6 | Render scale 0.85                        | [rung-01.png](T0091-rungs/rung-01.png) |
|  R02 |   Q6 | Render scale 0.70                        | [rung-02.png](T0091-rungs/rung-02.png) |
|  R03 |   Q5 | Render scale 0.55                        | [rung-03.png](T0091-rungs/rung-03.png) |
|  R04 |   Q5 | Bloom at half resolution                 | [rung-04.png](T0091-rungs/rung-04.png) |
|  R05 |   Q4 | Bloom disabled                           | [rung-05.png](T0091-rungs/rung-05.png) |
|  R06 |   Q4 | SMAA replaced with FXAA                  | [rung-06.png](T0091-rungs/rung-06.png) |
|  R07 |   Q3 | Anti-aliasing disabled                   | [rung-07.png](T0091-rungs/rung-07.png) |
|  R08 |   Q3 | Procedural shader reduced to two octaves | [rung-08.png](T0091-rungs/rung-08.png) |
|  R09 |   Q2 | Procedural shader reduced to one octave  | [rung-09.png](T0091-rungs/rung-09.png) |
|  R10 |   Q2 | Star draw cap reduced to 4,000           | [rung-10.png](T0091-rungs/rung-10.png) |
|  R11 |   Q2 | Star draw cap reduced to 2,000           | [rung-11.png](T0091-rungs/rung-11.png) |
|  R12 |   Q1 | Future uncached textures capped at 2k    | [rung-12.png](T0091-rungs/rung-12.png) |
|  R13 |   Q1 | Future uncached textures capped at 1k    | [rung-13.png](T0091-rungs/rung-13.png) |
|  R14 |   Q1 | Detailed-model thresholds doubled        | [rung-14.png](T0091-rungs/rung-14.png) |

Texture-cap screenshots intentionally retain already-loaded Earth textures. Deterministic asset ingestion now publishes `_2k` and `_1k` variants for every bound texture and matching capped GLBs in the real manifest. Integration tests assert capped lazy sphere/model selection, inspect every capped GLB URI, and verify every referenced KTX2 stays within its declared maximum dimension without a visible swap or frame-loop allocation.
