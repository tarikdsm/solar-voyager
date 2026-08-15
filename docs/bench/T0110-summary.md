# T0110 chase camera benchmark

## Environment and method

- Before SHA: `daf51997b633c4f20290a40bf96e6a3dde245761` (this branch's base, post-T0109)
- After SHA: `365f3e959404ebeafb2547fd76b8f31697a081a8` (the branch, golden re-baseline included)
- Renderer: ANGLE / Intel(R) UHD Graphics (0x00009A60) / Direct3D 11
- Canvas: 640 x 360, device scale factor 1
- Harness: `npm run bench`, production Vite build, one deterministic 900-frame
  route (LEO → Moon flyby → Jupiter approach), 30 s steady-heap settle plus 30 s
  measurement, two priming runs discarded
- Raw reports: `T0110-before.json` and `T0110-after.json`
- CI gate evidence: `npm run test:perf-gates` (production page, `?autostart=1`,
  640 x 360, Chromium with `--expose-gc`)
- Visual proof: `T0110-chase-earth.png` — the chase camera in the shipped game,
  ship on a prograde hold over a daylit Earth, half a LEO orbit after the epoch.
  HUD hidden for the shot only.

This PR replaces the camera in the frame loop, so bench evidence is required by
the v2 plan's Global Constraints.

Both runs completed with empty stability findings, zero page errors, and both
ended on `Focus: Jupiter`.

## Before/after — deterministic flight route

| Metric             |       Before |        After |        Delta |
| ------------------ | -----------: | -----------: | -----------: |
| Frame median       |     6.100 ms |     6.200 ms |       +0.100 |
| Frame p75          |    30.300 ms |    30.300 ms |        0.000 |
| Frame p99          |    60.858 ms |    72.801 ms |      +11.943 |
| Frame-work median  |     3.200 ms |     3.200 ms |        0.000 |
| Frame-work p75     |     5.300 ms |     5.100 ms |       -0.200 |
| Frame-work p99     |     9.304 ms |     9.202 ms |       -0.102 |
| Steady heap growth |     92,560 B |     96,700 B |     +4,140 B |
| Path heap delta    | 26,763,041 B | 28,901,738 B | +2,138,697 B |
| Maximum draw calls |           26 |           49 |          +23 |
| Maximum triangles  |       66,246 |       70,452 |       +4,206 |
| Entry gzip         |    138,640 B |    143,783 B |     +5,143 B |
| Total gzip         |    568,884 B |    574,613 B |     +5,729 B |

**Frame _work_ — the CPU time this task actually controls — did not move.**
Median identical, p75 and p99 both slightly down, which is run-to-run variance
on this integrated GPU. That is the expected result: the per-frame cost added is
one orbit-camera update that already ran, one attitude slerp, three exact
critically damped scalar steps, one surface-clearance distance, a handful of
normalisations, and one `Object3D.lookAt`.

**Frame _wall_ p99 rose by 12 ms, and that is the ship being drawn.** Maximum
draw calls went 26 → 49 and maximum triangles 66,246 → 70,452 over the route:
before this task the bench camera sat on a body with the ship sub-pixel at every
checkpoint, and now the ship is resolved and rendered throughout. p99 is a
presentation-interval percentile including GPU and compositor, so it moves with
GPU workload while frame-work does not.

A caveat this summary will not paper over: **this machine's frame wall times were
already well outside 60 fps before the change** (p75 = 30.3 ms on both runs, i.e.
33 fps at the 75th percentile, on an Intel UHD integrated part). The 60 fps floor
is a reference-hardware claim and this box is not reference hardware; what these
numbers legitimately support is the _delta_ — frame work flat, GPU workload up by
exactly the ship's draw calls — not an absolute fps claim in either direction.

**Path heap delta +2.1 MB is a one-time allocation, not a leak.** It is the
`ship.glb` model, its six materials, the base-state arrays and the 8 x 4 ambient
environment texture, allocated once when the ship first resolves. Before this
task the bench route never resolved the ship, so it never paid it. The figure
that gates is _steady_ heap growth over a 30 s settled window: 96,700 B here and
20,264 B on the CI perf-gate page, against a 196,608 B ceiling.

## CI performance gate — the workload golden moved

Run 1, against the **old** golden — the failure that justifies the re-baseline:

```
production workload : { drawCalls: 33, triangles: 82429 }
golden              : { drawCalls: 10, triangles: 77071, toleranceFraction: 0.1 }
production heap     : +20,264 B retained over 30 s (limit 196,608 B)
bundle              : entry 143,783 B / total 574,613 B gzip (limits 400,000 / 1,000,000)
findings            : ["Draw calls must stay within 10.0% of 10; measured 33."]
allocation fixture  : failed as required (+5,283,484 B)
draw-call fixture   : failed as required (52 vs 10)
exit                : 1
```

Run 2, against the **new** golden — the confirmation:

```
production workload : { drawCalls: 33, triangles: 82429 }
golden              : { drawCalls: 33, triangles: 82429, toleranceFraction: 0.1 }
production heap     : -258,660 B retained over 30 s (limit 196,608 B)
bundle              : entry 143,783 B / total 574,613 B gzip
findings            : []
allocation fixture  : failed as required (+5,028,688 B)
draw-call fixture   : failed as required (98 vs 33)
exit                : 0
```

The workload is bit-identical across the two runs, which is what makes this a
re-baseline of a moved number rather than a widened gate: the tolerance
(10 %), the heap ceiling and both bundle ceilings are untouched. Retained heap
came out _negative_ on the second run — the 30 s window ended below where it
started after a forced double-GC, which is what an allocation-free frame path
looks like against collector noise.

### Where the numbers come from, exactly

The perf-gate scenario is `?autostart=1`, which now opens in the chase camera
with the hull filling ~87 px, so the ship is resolved on every frame instead of
subtending 0.001 px from the far side of Earth.

The net delta is **+23 draw calls and +5,358 triangles**, and that is _not_ the
ship's price. It is two separate movements, established by hooking the raw GL
draw entry points on the production page, labelling every draw by the `#define`
set of its shader program, and capturing one settled frame from each build:

|                                 | draw calls |  triangles |
| ------------------------------- | ---------: | ---------: |
| base `daf5199`, v1 camera       |         10 |     77,071 |
| present only in the base frame  |         −1 |       −180 |
| present only in the chase frame |        +24 |     +5,538 |
| branch, chase camera            |     **33** | **82,429** |

`33 = 10 − 1 + 24` and `82,429 = 77,071 − 180 + 5,538`. The +24 / +5,538 is
T0109's hull figure **exactly** — all 24 nodes are present in the chase frame.

The −1 / −180 is a single non-indexed `drawArrays(TRIANGLES, 540)` whose program
is a plain `LAMBERT + USE_MAP` (no procedural-sun shader chunks). 540 vertices is
180 non-indexed triangles, which is `IcosahedronGeometry(1, 2)` — 20 base faces ×
(2+1)² — the shared tier-2 sphere geometry in `bodyVisualSystem.ts`, drawn with
its `MeshLambertMaterial` textured variant. Of the three eagerly textured hero
spheres, Earth is at tier 3 in **both** frames (its three 48,384-index model
draws appear in both) and the Sun's spheres compile through
`prepareProceduralSunMaterial`'s `onBeforeCompile` + `customProgramCacheKey`, so
they are a different program. By elimination the object is the **Moon**.

**It did not stop rendering.** Staying in the chase camera and sweeping the arm's
azimuth with `Shift`+arrows across 42 bearings, the same 540-vertex draw
reappears at 17 of them, and on those frames the workload is **34 draw calls and
82,609 triangles** — precisely `33 + 1` and `82,429 + 180`. The same sweep on the
unmodified base build moves its workload between 9 and 11 draw calls. So the
Moon's presence is a function of camera bearing in v1 exactly as it is in chase:
ordinary view-frustum culling, unchanged by this task. What moved is the bearing
the default camera happens to hold, because the chase arm points along the ship's
attitude rather than at Earth.

This is worth stating plainly because "an object stopped rendering when the
default camera changed" is exactly the class of regression a golden re-baseline
can bury. It is not what happened here, and the sweep is the proof.

Note: commit `365f3e9`'s message attributes the whole delta to the hull and is
therefore imprecise on this point; this section supersedes it. The gate values
themselves are unaffected.

33 of the 150-call budget in `rendering-spec.md` §8. The 24-calls-for-6-materials
shape is the asset's, not the renderer's, and merging by material belongs to the
Front C remodel that owns `tools/blender/build_ship.py` — doing it at load time
would bake away the `engine_nozzle` and `rcs_*` nodes T0122 needs.

One consequence for whoever next touches this golden: **the perf-gate workload is
bearing-sensitive by ±1 draw call / ±180 triangles**, in v1 and in chase alike.
33 and 82,429 are what the deterministic `?autostart=1` opening bearing produces,
reproduced across four independent runs here. The 10 % tolerance absorbs it.

Triangles were re-baselined even though 82,429 sits inside the 10 % tolerance of
77,071 and would not have failed on its own: leaving it would have left 3 % of
headroom before a spurious failure.

The re-baseline is its own commit touching only
`tools/perf/performance-golden.json`, per plan §6.

## Startup — `data/initial-path.json` is unchanged

`npm run test:startup`, exit 0:

```
firstPlayableMs            : 1034   (ceiling 5,000)
programCountAtReady        : 34
programCountAfterFirstFrame: 34     (equal — the first ordinary frame compiled nothing)
requestedCriticalFiles     : data/stars.bin, public/assets/manifest.json,
                             earth_albedo_tier2.ktx2, moon_albedo_tier2.ktx2
```

`ship.glb` is deliberately **not** on the critical path. `test:startup` measures
the window up to first playable, and it reaches `ready` before the space phase
exists; ship lazy loading is only enabled at space-phase activation, so the model
is fetched after that window closes. Putting it on the critical path would move a
megabyte-class asset _into_ the budget it currently sits outside of, to save one
frame of point sprite that `ShipVisual`'s existing cross-fade already hides.

The first-frame program-count assertion holds structurally rather than by luck:
the model fetch is _started by_ frame 1 and resolves asynchronously, so nothing
compiles inside it. The related risk was handled deliberately —
`createEpochWorld` primes the director with the session's real epoch attitude, so
the shader warm-up runs from the same viewpoint as the first ordinary frame.

## Zero allocation in the frame loop

The camera path allocates nothing. Both controllers hold preallocated
`Float64Array` scratch and mutable `{x,y,z}` outputs; the director owns one pose
object mutated in place (unit-tested for reference stability); the rig uses
`Vector3.set`, `Object3D.lookAt` and `PerspectiveCamera.updateProjectionMatrix`,
all of which write in place in three.js 0.185. The projection matrix is only
rebuilt when the field of view moves by more than 1e-4 deg, because the throttle
widening approaches its target exponentially and would otherwise rebuild forever.

Measured: 20,264 B retained over the CI gate's 30 s window against a 196,608 B
ceiling.

## Test threshold changed (not a gate)

`tools/tests/shipVisualRegression.mjs` relaxed its focused-ship size assertion
from `diameterPx > 100` to `> 60`. It is a readability floor in a browser
harness, not a budget or a golden, but it is a relaxation and should not land
silently: T0109 measured 100+ px with the _observatory_ camera framing the ship
at 3 × its bounding radius (39 m), while the chase arm holds it at 157 m by
design. Measured at the new distance: 86.6 px at 720 p in the production phase,
43.3 px at the 640 × 360 perf-gate viewport. 60 keeps the assertion meaningful at
720 p — it still fails if the ship falls back to a point sprite — without
encoding the old camera's distance.

## Known visual limitation (not this task's scope)

`T0110-chase-earth.png` still shows v1's fixed exposure: Earth's sunlit clouds
clip toward white and the hull reads dark against them. That is
`toneMappingExposure = 1` against a daylit planet at 400 km, exactly as T0109
recorded; T0127 (adaptive exposure) owns it. The hull's programmer-art metalness
is Front C's.
