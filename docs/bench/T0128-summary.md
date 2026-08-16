# T0128 Body Rotation, Tilt, Oblateness — Performance Summary

**Date:** 2026-08-16
**Feature head measured:** `task/T0128-body-rotation` at `8b96ad1`
**Baseline:** `331ebd6` — this branch's start point, its `src/` checked into the working tree
**Adapter:** ANGLE D3D11, Intel(R) UHD Graphics (0x00009A60), hardware (`softwareRasterizer=false`)
**Canonical bench viewport:** 640×360, high-quality lock, 900-frame deterministic route

## What was added to the frame path

Three things, all in `BodyVisualSystem.update`:

1. `BodySpin.update(simTimeSec)` — one pass over 43 bodies, two `Math.sin`/`Math.cos` of a half
   angle and four multiplies each, into two preallocated typed arrays. The tilt half-angle terms are
   constant and computed at construction.
2. `applyAttitude(index)` — up to three `Quaternion.set` calls per body (two tier-2 spheres and the
   tier-3 root when loaded). The matrices are composed by `updateCameraRelative`, which already
   walked those same objects, so no extra `updateMatrix` was added for them.
3. Ringed bodies only (4 of 43): two extra vector rotations and one `updateMatrix` on the particle
   instanced mesh.

No new draw call, material, geometry, texture, render target or allocation.

## Read the paired flight benchmark with its caveat

**This machine was running other agents' benches and browser gates throughout the measurement
window, and `npm run bench` said so itself** — both sets tripped its own ≤5 % variance stability
gate (baseline: p99 variance 39.48 %; feature: p75 65.93 %, p99 78.48 %). Several attempts to take
the pair back-to-back in one quiet window failed: the second baseline attempt lost the port race to
another worktree's bench (`EADDRINUSE` on 4177) and never ran. The two JSONs are therefore honest
measurements of their own source trees taken in _different_ load conditions, not a clean A/B.

| Metric (run 1 / run 2) |          Baseline |             T0128 |
| ---------------------- | ----------------: | ----------------: |
| Frame median           |      6.1 / 6.1 ms |      6.1 / 6.1 ms |
| Frame p75              |      6.1 / 6.1 ms |     12.1 / 6.1 ms |
| Frame p99              |    18.2 / 12.2 ms |    42.3 / 18.5 ms |
| Work median            |      2.0 / 1.7 ms |      4.1 / 1.9 ms |
| Work p75               |      2.9 / 2.2 ms |      6.7 / 2.6 ms |
| Work p99               |     17.8 / 7.3 ms |     25.9 / 8.3 ms |
| Max draw calls         |           49 / 49 |           49 / 49 |
| Max triangles          |   70,452 / 70,452 |   70,452 / 70,452 |
| Stabilized heap delta  | 91,400 / 96,632 B | 92,548 / 91,256 B |

The structural metrics — draw calls, triangles, stabilized heap delta — are identical, which is the
part of this table load cannot move. The timing spread is the machine: the feature build's own two
runs differ from each other by more than either differs from the baseline, and its quieter run
(p75 6.1 ms, work median 1.9 ms) lands on the baseline's quieter run (p75 6.1 ms, work median
1.7 ms).

## The measurement that is not load-dependent

Because the flight bench could not be trusted to resolve tens of microseconds under that
contention, the added work was timed in isolation — 129 `Quaternion.set` + `updateMatrix` calls,
the worst case of 43 bodies with every tier resident, three.js 0.185, Node:

```
per frame: 13.92 us
```

**0.014 ms per frame.** A regression of the size the noisy runs suggest (2 ms) is three orders of
magnitude away from what this code can cost, and the arithmetic pass in `BodySpin.update` is
smaller again (43 × 2 trig calls).

## Allocation

| Probe                                                                        |            Result |                Budget |
| ---------------------------------------------------------------------------- | ----------------: | --------------------: |
| `test:visual-tiers` — 20,000 `BodyVisualSystem.update` at advancing sim time |           7,276 B |              65,536 B |
| `test:ring-flythrough` — 50,000 `PreparedRingSystem.update` (unchanged gate) |          19,928 B |              65,536 B |
| Stabilized heap delta, 900-frame route                                       | 92,548 / 91,256 B | unchanged vs baseline |

The tier probe's first invocation reports 167,208 B and its second 7,276 B; the first pass is
first-touch (lazy sphere/model state reaching steady state), which is why the gate asserts on a
warmed second probe, matching the ring flythrough's existing pattern.

## Bundle

| Metric           |  Baseline |     T0128 |  Delta |      Budget |
| ---------------- | --------: | --------: | -----: | ----------: |
| Entry chunk gzip | 150,616 B | 151,577 B | +961 B |   400,000 B |
| Total gzip       | 582,872 B | 583,833 B | +961 B | 1,000,000 B |

`bodySpin.ts` costs 961 gzipped bytes. Headroom after this task: 248,423 B on the entry chunk and
416,167 B on the total.

## Goldens and budgets

None moved. No golden trajectory, draw-call, triangle, heap or bundle baseline was re-based by this
task.
