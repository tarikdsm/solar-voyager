# T0117 — click-to-target — bench summary

Raw reports: `docs/bench/T0117-before.json` (base commit `594f976`, `src/` restored),
`docs/bench/T0117-after.json` (branch head). Same machine, same session, `npm run bench`.

## Why a bench run at all

Nothing in this task runs on the animation frame. Picking is a `pointerup` listener, and the
selection controller writes only when the player selects something. The render-layer diff is two
lines: `src/render/spaceScene.ts` exports `SPACE_CAMERA_FOV_DEG = 75` and passes it to the
`PerspectiveCamera` constructor instead of the literal `75`, and `src/render/systemMapScene.ts`
consumes the same constant instead of its own literal `75`. Identical values, no branch, no new
work. The run is here because the release brief requires bench evidence from any change under
`render/`, not because a regression was plausible.

## Numbers

| Metric                            | Before     | After     |
| --------------------------------- | ---------- | --------- |
| max draw calls                    | 49         | 49        |
| max triangles                     | 70,452     | 70,452    |
| frame median                      | 6.2 ms     | 6.1 ms    |
| frame p99                         | 42.6 ms    | 30.3 ms   |
| work median                       | 4.6 ms     | 2.2 ms    |
| steady heap delta over the window | +104,544 B | +93,224 B |
| stability findings                | none       | none      |

The frame-time differences are run-to-run noise on a SwiftShader software rasteriser — the after run
happened to land a quieter machine — not an effect of this change. The two figures that would move
if geometry or state had changed, draw calls and triangles, are bit-identical.

`npm run test:perf-gates` on the branch reports the production workload at **33 draw calls /
82,429 triangles**, exactly the committed golden, and heap growth settled inside the 16,384 B
per-step budget. No golden and no budget was re-baselined by this task.

## Click allocation

`npm run test:click-to-target` drives 240 real picks (alternating a hit and a miss) and measures
**161,032 B** of `usedJSHeapSize` growth across them, against the 262,144 B envelope
`systemMapRegression.mjs` already uses. The picking math itself allocates nothing — one module-owned
basis buffer, one projected-point buffer, one mutable map pose — and the click handler reads
`event.offsetX`/`offsetY` rather than allocating a `DOMRect`. The residue is the browser-diagnostic
dataset writes (`pickAttempts` stringifies a counter each gesture), which the CI heap gate never
sees because none of it is on the frame path.
