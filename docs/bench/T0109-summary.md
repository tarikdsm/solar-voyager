# T0109 ship visual benchmark

## Environment and method

- Before SHA: `56a4bd9b8775727dfc13a75b452b8a908aa5c6af` (this branch's base, post-T0108)
- After: the same branch with the T0109 `feat(render)` commit applied
- Renderer: ANGLE / Intel(R) UHD Graphics (0x00009A60) / Direct3D 11
- Canvas: 640 x 360, device scale factor 1
- Harness: `npm run bench`, production Vite build, one deterministic 900-frame
  route (LEO → Moon flyby → Jupiter approach), 30 s steady-heap settle plus 30 s
  measurement
- Raw reports: `T0109-before.json` and `T0109-after.json`
- CI gate evidence: `npm run test:perf-gates` (production page, `?autostart=1`,
  640 x 360, SwiftShader-free Chromium with `--expose-gc`)
- Visual proof: `T0109-ship-leo.png` — the ship in the shipped game, focused via
  `[`, half a LEO orbit of time warp after the epoch so Earth is daylit behind
  it. HUD hidden for the shot only.

This PR adds a rendered object and a per-frame update to the frame loop, so
bench evidence is required by the v2 plan's Global Constraints.

## Before/after — deterministic flight route

| Metric             |       Before |        After |     Delta |
| ------------------ | -----------: | -----------: | --------: |
| Frame median       |     6.100 ms |     6.100 ms |     0.000 |
| Frame p75          |     6.100 ms |     6.100 ms |     0.000 |
| Frame p99          |     6.400 ms |     6.300 ms |    -0.100 |
| Frame-work median  |     1.400 ms |     1.400 ms |     0.000 |
| Frame-work p75     |     1.600 ms |     1.500 ms |    -0.100 |
| Frame-work p99     |     4.402 ms |     4.301 ms |    -0.101 |
| Steady heap growth |    101,268 B |    100,604 B |    -664 B |
| Path heap delta    | 26,689,066 B | 26,700,674 B | +11,608 B |
| Maximum draw calls |           26 |           26 |         0 |
| Maximum triangles  |       65,094 |       49,530 |   -15,564 |
| Entry gzip         |    129,865 B |    132,309 B |  +2,444 B |
| Total gzip         |    559,645 B |    562,089 B |  +2,444 B |

Both reports completed with empty stability findings and zero page errors, and
both ended on `Focus: Jupiter`.

Every timing column is flat or slightly _down_, which is run-to-run variance on
this integrated GPU: the ship is unresolved at every checkpoint of this route
(the nearest is the LEO leg, where the camera focuses Earth from 6,771 km and
the ship subtends 1.1e-3 px), so the added per-frame work is one distance, one
`projectedDiameterPx`, one `apparentMagnitude` and four attribute writes.

The triangle column needs a note: **49,530 is the normal figure** — T0108's
summary reports 49,530 both before and after. The 65,094 in this task's _before_
run is the outlier, caused by lazy tier-3 model load timing during the route
(the route flies past bodies while their models are still arriving, so the peak
depends on when a `.glb` finishes decoding). It is a decrease, it is not caused
by this change, and it is not the number CI gates: the CI workload golden is
measured by `test:perf-gates` on a settled production page, below.

## CI performance gate — the golden did **not** move

```
production workload : { drawCalls: 10, triangles: 77071 }
golden workload     : { drawCalls: 10, triangles: 77071, toleranceFraction: 0.1 }
production heap     : +74,056 B retained over 30 s (limit 196,608 B)
bundle              : entry 132,309 B / total 562,089 B gzip
findings            : []
allocation fixture  : failed as required (+3,681,116 B)
draw-call fixture   : failed as required (29 vs 10)
```

The plan expected "+2..3 draw calls" and the brief expected the golden to be
exceeded. **Measurement says otherwise, so no workload re-baseline was landed.**
The perf gate scenario is `?autostart=1` with the camera focused on Earth from
LEO. The ship starts diametrically opposite the camera across Earth (the sim
places it anti-sunward at `Earth + r̂·6,771 km`; the epoch camera sits sunward at
the mirror point), 13,542 km away, where a 26.12 m hull subtends **0.00106 px**.
That is three orders of magnitude below the 1.8 px resolve threshold, so the
ship is a point in the _existing_ additive cloud: no extra draw call, no extra
triangle, and no model fetch. Fabricating a re-baseline commit to match the
plan's estimate would have weakened a gate for no reason.

## What the ship actually costs when it is resolved

Measured by the new fixture (`tools/tests/shipVisualRegression.mjs`, 256 x 256,
ship at 90 px, model opacity 1):

| Scene contents                 | Draw calls | Triangles |
| ------------------------------ | ---------: | --------: |
| Ship point only (unresolved)   |          1 |         0 |
| Ship mesh + shared point cloud |         25 |     5,538 |

So a **visible ship costs 24 draw calls and 5,538 triangles**. That is the
number T0110 will have to re-baseline the golden against, because a chase camera
keeps the ship resolved every frame (10 + 24 = 34 draw calls, still far below
the 150-call budget in `rendering-spec.md` §8).

24 calls for 5,538 triangles is poor, and it is the _asset's_ shape, not the
renderer's: `ship.glb` is 24 separate nodes over 6 materials. Merging them per
material at load would cut it to 6, and was deliberately **not** done here:

- it would bake away the `engine_nozzle` node ADR-025 designates as the plume
  attachment point and the eight `rcs_*` pod nodes, which T0122's plume and RCS
  puffs both need;
- `tools/blender/build_ship.py` is the source of truth for asset shape, and the
  Front C remodel (spec §6.3) already owns re-authoring this ship. Joining
  meshes per material belongs in that script, in that task.

## Bundle budget

| Figure     |    Before |     After |    Delta |
| ---------- | --------: | --------: | -------: |
| Entry gzip | 129,865 B | 132,309 B | +2,444 B |
| Total gzip | 559,645 B | 562,089 B | +2,444 B |

Against the **v1 ceilings still in force at the start of this task** (285,000 B
entry / 570,000 B total) that leaves 152,691 B and **7,911 B** of headroom
respectively — 1.4 % of the total ceiling, after a task that added 2.4 kB.
T0108's summary already flagged this: "the next JS-adding task must land the plan
§13 budget raise as its own reviewed commit."

This PR therefore lands, as a **dedicated commit touching only
`tools/perf/performance-golden.json`**:

| Budget              |     Old |       New | Authority                           |
| ------------------- | ------: | --------: | ----------------------------------- |
| `maxTotalGzipBytes` | 570,000 | 1,000,000 | v2 plan §13 / spec §13 ("≈ 1 MB")   |
| `maxEntryGzipBytes` | 285,000 |   400,000 | v2 plan §13 / spec §13 ("≈ 400 KB") |

Justification, per ADR-032's "budgets are revised deliberately, never silently"
policy: the v1 ceilings were sized for v1's shipped feature set and are now 98.6 %
consumed. v2 adds cruise guidance, four camera modes, collision/restore, audio,
atmospheric scattering and the diary — the spec sized that at ≈ 1 MB when the
scope was agreed, before any of it was written. The alternative to raising the
ceiling now is that the next fifteen tasks each fail CI on a budget nobody
intends to hold. No other gate is touched: draw calls, triangles, heap growth,
asset budgets, repo size and the critical-path budget all keep their values, and
the newly authorised headroom is 438 kB of _ceiling_, not 438 kB of shipped code.

Post-raise utilisation: entry 33.1 %, total 56.2 %.

## Heap

The frame path allocates nothing: the composed quaternion, the forward vector
and the nose scratch are preallocated `Float64Array`s, the position write goes
into the shared packed array, and the point-cloud write is four typed-array
stores. Everything the ship allocates — the model, its materials, the base-state
arrays and the 8 x 4 ambient environment texture — is allocated once, on the
first resolve. The gate measured +74,056 B over 30 s against a 196,608 B limit.

## Known visual limitation (not this task's scope)

`T0109-ship-leo.png` shows Earth clipped to white. That is v1's fixed exposure
(`toneMappingExposure = 1`) against a daylit Earth at 400 km, not a ship problem;
T0127 (adaptive exposure) owns it. The hull also reads dark: the authored
material is 0.78–0.9 metalness programmer-art, and a metal with no image-based
environment has almost no response away from its specular lobe. This task gives
it the scene's ambient radiance as a constant environment so it is not literally
black; genuine planetshine and a re-authored PBR hull are Front C work.

## Post-review re-measurement

Code review added two behaviour fixes (the space camera now moves itself on a
body focus instead of relying on the system map to relay it, and the ship's
ambient environment intensity was corrected by `1/π`). Re-measured on the fixed
tree:

| Figure                          | Feature commit | After review fixes |
| ------------------------------- | -------------: | -----------------: |
| Production draw calls           |             10 |                 10 |
| Production triangles            |         77,071 |             77,071 |
| Production retained heap / 30 s |      +74,056 B |           +4,544 B |
| Entry gzip                      |      132,309 B |          132,330 B |
| Total gzip                      |      562,089 B |          562,110 B |

`findings: []` in both runs. The heap figures are two samples of the same
allocation-free frame path, three orders of magnitude apart in noise and both far
below the 196,608 B window; nothing in the fixes touches allocation. The +21 B of
gzip is the extra `SharedCameraControls` module boundary and the corrected
constant.
