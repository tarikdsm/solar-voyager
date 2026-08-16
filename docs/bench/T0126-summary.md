# T0126 Milky Way sky — performance summary

**Date:** 2026-08-16
**Feature head measured:** `task/T0126-milky-way` (working tree at `52b4b8d`)
**Baseline:** the same tree with the two `spaceScene.scene.add(...)` calls for the sky
mesh and the constellation batch removed, rebuilt — i.e. exactly this task's draw
cost and nothing else.
**Adapter:** ANGLE D3D11, Intel(R) UHD Graphics (0x00009A60), hardware (`softwareRasterizer=false`)
**Canonical bench viewport:** 640×360, 900-frame deterministic route
(`leo` → `moon-flyby` → `jupiter-approach`)

## Why this task has a bench

It adds a full-screen textured sphere and a `LineSegments` batch to the space
scene, and one call (`MilkyWaySky.update`) to the animation frame. All three are
in the hot path, so the Global Constraints require evidence.

## Method

`npm run bench` on the production build, same Chrome channel, same harness, same
settle/measurement heap windows. Only `src/render/createEpochWorld.ts` differed
between the two builds, by the two scene-add lines.

`npm run bench` also **runs with the shipped defaults**, not the Engineer profile
fixture — `tools/bench/flightBench.mjs` does not import `hudPresetProfile.mjs`.
So the measured configuration is panorama **on**, zodiacal band **on**,
constellations **off**, which is what a player gets.

## Results

| Metric            | Before (no sky) | After (sky) | Δ          |
| ----------------- | --------------- | ----------- | ---------- |
| Frame median      | 6.1 ms          | 6.1 ms      | 0.0        |
| Frame p75         | 6.1 ms          | 6.1 ms      | 0.0        |
| Work median       | 1.7 ms          | 2.0 ms      | +0.3 ms    |
| Max draw calls    | 49              | 50          | **+1**     |
| Max triangles     | 70,452          | 74,420      | **+3,968** |
| Steady heap delta | 106,844 B       | 106,708 B   | −136 B     |

A second independent run of the feature head (`T0126-after-run2.json`) reports
median 6.1 ms, p75 6.1 ms, work median 2.2 ms, 50 draws, 74,420 triangles,
106,580 B — i.e. the draw-call and triangle deltas are exact and the frame-time
delta is inside run-to-run noise.

**Read p99 with care on this host.** A `--runs 2` attempt failed the harness's own
5% stability gate twice, at 66.67% and 85.84% p99 variance, while median and p75
stayed pinned at 6.1 ms. The p99 column is noise-dominated here and is not
load-bearing evidence; median, p75, draw calls, triangles and heap are.

## Reading the numbers

- **+1 draw call, +3,968 triangles** is exactly the sky sphere
  (`SphereGeometry(1, 64, 32)`), drawn once. The zodiacal band is a term in that
  same fragment shader, not a second pass, and the constellation batch is
  `visible = false` by default so it contributes nothing until switched on
  (`test:milky-way` measures it at 1 draw call and 0 triangles when it is).
- The workload golden is 33 draw calls / 82,429 triangles at ±10%, i.e. 3 draw
  calls and 8,243 triangles of headroom. **No golden was re-baselined.**
- **Zero steady heap growth attributable to the sky** (−136 B, inside noise;
  the CI gate is 196,608 B over 30 s). `MilkyWaySky.update` writes into
  preallocated uniform objects and allocates nothing; the constellation buffer is
  preallocated at setup for 1,024 segments and filled once when its 2.6 kB
  payload arrives.
- The panorama KTX2 is fetched only after the space phase activates and is
  absent from `data/initial-path.json`, so it contributes nothing to the startup
  budget. `npm run check:budgets` reports the critical path unchanged at
  1,341,481 B.

## Governor

`RenderQualityProfile.skyboxTier` drops the panorama to its 2048×1024 source at
tier 3 and switches the sky draw off entirely at tier 1, where it is the single
cheapest full-screen thing left to cut. Measured by `npm run test:milky-way`:
tier `'off'` reports 0 draw calls.
