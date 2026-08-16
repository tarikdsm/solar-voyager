# T0144 Audio Engine — Performance Summary

**Date:** 2026-08-16
**Feature head measured:** `task/T0144-audio-engine` (working tree at `a5649f9`)
**Baseline:** `331ebd6` — this branch's merge base
**Adapter:** ANGLE D3D11, Intel(R) UHD Graphics (0x00009A60), hardware (`softwareRasterizer=false`)
**Canonical bench viewport:** 640×360, high-quality lock, 900-frame deterministic route

## Why this task has a bench

T0144 adds a subsystem to the animation-frame path: `frameLoop.ts` now calls
`AudioSystem.update()` once per frame, in the UI window. The Global Constraints require bench
evidence for anything touching the frame loop, and there are two specific questions worth
answering:

1. **Does the per-frame decision pass cost measurable time?** `AudioDirector.update()` runs every
   frame whether or not audio is unlocked — that is deliberate, so the decisions stay live and
   observable while the output is correctly silent.
2. **Does it allocate?** The heap-growth gate is the contract, and an audio subsystem is a natural
   place to leak: option objects for `setTargetAtTime`, arrays of layer gains, string layer names.

Both answers are no.

## Method

Both runs used `npm run bench` on the production build with the standard route
(`leo` → `moon-flyby` → `jupiter-approach`, focus events at frames 300 and 600), the same Chrome
channel, the same settle/measurement heap windows, and the **same harness**. The baseline was
produced by swapping only `src/` to the merge base (`rm -rf src/game/audio && git checkout 331ebd6
-- src`), rebuilding, and benching; the tree was then restored with `git checkout HEAD -- src` and
verified clean. `tools/`, `tests/` and `package.json` were identical for both runs. The paired JSON
is committed as `T0144-before.json` and `T0144-after.json`.

**The `gitSha` field in both files reads `a5649f9`.** It records the committed `HEAD` at the moment
of the run, not the source that was built — the baseline run built the merge base's `src/` out of
the working tree. This is the same caveat `T0113-summary.md` and `T0112-summary.md` carry; the
harness has no way to record a working tree.

**Machine caveat:** this bench ran on a machine with two other v2 lanes (T0126, T0127) building and
benching concurrently — the bench port was occupied twice and had to be waited for. The absolute
numbers are therefore noisier than a quiet machine's, and the `after` run happened to get the
quieter slot. Read the deltas below as "within noise", not as an improvement: the audio path cannot
plausibly have made rendering 1.1 ms/frame faster.

## Paired canonical flight benchmark

| Metric                |  Baseline |     T0144 |     Delta |
| --------------------- | --------: | --------: | --------: |
| Frame median          |    6.1 ms |    6.1 ms |    0.0 ms |
| Frame p75             |   12.1 ms |    6.1 ms |   −6.0 ms |
| Frame p99             |   36.4 ms | 36.301 ms |  −0.10 ms |
| Work median           |    3.3 ms |    2.2 ms |   −1.1 ms |
| Work p75              |    5.8 ms |  3.725 ms |  −2.08 ms |
| Work p99              | 22.405 ms | 21.013 ms |  −1.39 ms |
| Stabilized heap delta | 115,716 B |  93,568 B | −22,148 B |
| Max draw calls        |        49 |        49 |         0 |
| Max triangles         |    70,452 |    70,452 |         0 |
| Entry gzip            | 150,616 B | 153,876 B |  +3,260 B |
| Total gzip            | 582,872 B | 586,252 B |  +3,380 B |

Per-leg medians (frame / work, ms):

| Leg                | Baseline  | T0144     |
| ------------------ | --------- | --------- |
| `leo`              | 6.1 / 5.7 | 6.1 / 4.5 |
| `moon-flyby`       | 6.1 / 2.4 | 6.1 / 2.1 |
| `jupiter-approach` | 6.1 / 2.6 | 6.1 / 1.9 |

Both runs: zero browser errors, zero stability findings, route evidence
`['earth', 'moon', 'jupiter', 'jupiter']`, final focus label `Focus: Jupiter`.

## Reading the numbers

**Frame median is flat at 6.1 ms and every timing delta is negative**, on a run where the audio
subsystem was added. That is the machine, not the code: the work-time spread between the two runs
(up to 2.1 ms at p75) is larger than any per-frame cost this subsystem could have, and it moves in
the direction of "the second-measured build had less competition", which is what happened. The
honest reading is **no measurable regression**, with the caveat that this machine could not have
resolved one below roughly ±1 ms of work time on the day.

**The heap is the number that actually answers the allocation question**, and it is unambiguous:
stabilized growth fell from 115,716 B to 93,568 B, and the separate CI heap gate
(`npm run test:perf-gates`) reports a 15,132 B delta against a 196,608 B budget with `settled: true`
after 6 stable steps. The frame path allocates nothing new.

**The browser gate measures the thing directly.** `npm run test:audio` asserts that a settled mix
writes **zero** `AudioParam`s across a window covering at least 8 rendered frames, and it passes:
`steadyFlight: { framesObserved: 8, paramWrites: 0 }`. Unchanged state costs one comparison per
param and no browser call at all.

**Bundle cost: +3,260 B entry gzip, +3,380 B total gzip.** That is the whole audio subsystem —
director, engine, system, body-class table, mixer UI and the v6 settings generation — against a
400,000 B entry budget with ~246,000 B of headroom. Nothing was re-baselined.

## Budget and golden movement

**None.** No budget was raised, no golden re-baselined, no gate weakened. Draw calls and triangle
counts are byte-identical between the runs, which is expected: this task adds no geometry, no
material and no render pass.
