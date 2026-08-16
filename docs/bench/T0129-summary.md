# T0129 Far-plane strategy + camera range — Performance Summary

**Date:** 2026-08-16
**Feature head measured:** `task/T0129-far-plane-strategy` (working tree at `5d55d76`, the
`origin/main` merge)
**Baseline:** `origin/main` at `6045b9c`, this branch's merge parent
**Adapter:** ANGLE D3D11, Intel(R) UHD Graphics (0x00009A60), hardware (`softwareRasterizer=false`)
**Canonical bench viewport:** 640×360, high-quality lock, 900-frame deterministic route
(`leo` → `moon-flyby` → `jupiter-approach`)

## Why this task has a bench

`src/render/spaceScene.ts` is on the frame path, and T0129 changes it in two ways that could in
principle cost something:

1. `SPACE_FAR_KM` 1e10 → 2.5e10 — a projection-matrix constant, so any cost would be GPU-side depth
   behaviour, not CPU;
2. a **sixth binding loop** in `updateCameraRelative`, for the new effect-visual family.

The second is the one worth measuring. It is also the one with an obvious prediction: no production
code binds an effect visual yet (plume is T0122, markers T0112/T0117, skybox T0126), so the loop
iterates zero times and costs one array-length read per frame. The bench is here to confirm that
prediction and to prove nothing about _what is drawn_ moved.

## Method, and the host caveat this bench had to work around

Both configurations were built and benched from the same worktree, swapping only `src/`
(`git checkout origin/main -- src` for the baseline, `git checkout HEAD -- src` to restore).
`tools/`, `tests/`, `data/` and `package.json` were identical for every run.

**Read the `gitSha` field with care.** All three reports record `5d55d762`, the committed `HEAD` at
run time, not the source that was built. The harness has no way to record a working tree; this is
the same caveat `T0113-summary.md` and `T0112-summary.md` carry.

`T0127-summary.md`'s handoff finding governs this host: a **single** `npm run bench` invocation is
not comparable across builds here, because one measured run in each pair lands in a slow
frame-pacing mode and can manufacture or hide a 2× p75 move. Every run below therefore used
`--runs 2` with `stability.findings` read. The bimodality reproduced exactly, and it is **not**
run-ordinal — the baseline was slow-then-fast, the first feature bench fast-then-slow:

| Report                     | run0 p75 / work median | run1 p75 / work median |
| -------------------------- | ---------------------- | ---------------------- |
| `T0129-before.json`        | 18.3 ms / 4.3 ms       | **6.1 ms / 1.9 ms**    |
| `T0129-after.json`         | **6.1 ms / 2.6 ms**    | 24.1 ms / 4.7 ms       |
| `T0129-after-confirm.json` | **6.1 ms / 1.9 ms**    | 18.0 ms / 4.5 ms       |

The harness's own 5 % stability gate failed on all three self-comparisons (100 %, 119 %, and a
comparable figure on the third). That gate is doing its job: it is telling us the host is not quiet,
not that the code regressed. The comparable numbers are the settled (fast-mode) run of each report,
bolded above.

A third bench (`T0129-after-confirm.json`) was taken specifically because the first feature run's
settled work median read 2.6 ms against the baseline's 1.9 ms. On a 1.9 ms figure that is a 37 %
swing, on a host that had just shown 100 %+ p75 swings on one binary compared against itself — so it
was resolved by measurement rather than by argument.

## Paired canonical flight benchmark (settled runs)

| Metric                |  Baseline |     T0129 | T0129 confirm |
| --------------------- | --------: | --------: | ------------: |
| Frame median          |    6.1 ms |    6.1 ms |        6.1 ms |
| Frame p75             |    6.1 ms |    6.1 ms |        6.1 ms |
| Frame p99             | 24.358 ms |   18.3 ms |      6.358 ms |
| Work median           |    1.9 ms |    2.6 ms |        1.9 ms |
| Work p75              |    2.4 ms |    3.5 ms |        2.2 ms |
| Work p99              |  8.804 ms |  8.802 ms |             — |
| Stabilized heap delta |  96,244 B |  94,988 B |      94,688 B |
| Max draw calls        |        49 |        49 |            49 |
| Max triangles         |    70,452 |    70,452 |        70,452 |
| Entry gzip            | 152,642 B | 152,642 B |             — |
| Total gzip            | 584,898 B | 585,524 B |             — |

All runs: zero browser errors, route evidence `['earth', 'moon', 'jupiter', 'jupiter']`, final focus
label `Focus: Jupiter`.

## Reading the numbers

**Frame median and p75 are identical at 6.1 ms in every settled run**, and the confirming run
reproduces the baseline's work median to the digit (1.9 ms) with a _lower_ work p75 (2.2 vs 2.4 ms).
The first feature bench's 2.6 ms does not reproduce and is host noise. That is the expected shape:
the new loop runs zero iterations, because nothing binds an effect visual yet.

**Draw calls and triangles are bit-identical (49 / 70,452).** This is the load-bearing line. The far
plane moved by 2.5× and nothing about what is submitted changed — as it should not, since the route
never leaves Jupiter's neighbourhood and the raise only affects clipping beyond 1e10 km. The one
visible consequence of the raise (Eris's point sprite no longer being clipped) is a single vertex in
an already-drawn `Points` batch: **zero additional draw calls, by construction.**

**Heap delta is lower on the feature build in both feature reports** (94,988 B and 94,688 B against
the baseline's 96,244 B), against the 196,608 B CI ceiling — 48 % of the budget. `effectBindingGuard`
allocates one telemetry object per scene at construction and nothing per frame; the degrade path's
warning string is built inside a `warned` branch that no production binding can currently reach.

**Bundle: entry gzip unchanged at 152,642 B, total +626 B** (584,898 → 585,524). The guard module
and the sixth loop cost about half a kilobyte compressed. Entry is 38 % of its 400,000 B budget and
total is 59 % of its 1,000,000 B budget.

**No golden and no budget was re-baselined by this task.** `tools/perf/performanceGate.mjs`'s golden
(draw calls 33 ±10 %, triangles 82,429 ±10 %, heap 196,608 B, bundle 400,000 / 1,000,000 B) is
untouched; `npm run test:perf-gates` measured draw calls 33, triangles 82,429 and a 26,512 B
production heap delta, settling in six consecutive quiet steps.

## Handoff finding for whoever benches next on this host

T0127's finding still holds and this task adds one detail to it: **the slow mode is not the first
measured run.** T0127 observed "run0 slow, run1 fast" and the baseline here matched, but both
feature reports came out the other way round. Do not special-case run ordinals — read
`stability.findings`, take the settled run of each report, and if a delta survives that, take a
third report before believing it.

`T0155` (per-worktree harness ports) was still `IN_PROGRESS` when these numbers were taken, so the
4176/4177/4178 collisions between concurrent lanes are still live. Every run above was taken
serially with no other gate running in this worktree, but nothing prevents a sibling worktree from
contending for the same adapter.
