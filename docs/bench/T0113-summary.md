# T0113 Bootstrap Decomposition — Performance Summary

**Date:** 2026-08-16
**Feature head measured:** `task/T0113-bootstrap-decomposition` (working tree at `864757d`)
**Baseline:** `748691b` — T0112 head, this branch's merge base
**Adapter:** ANGLE D3D11, Intel(R) UHD Graphics (0x00009A60), hardware (`softwareRasterizer=false`)
**Canonical bench viewport:** 640×360, high-quality lock, 900-frame deterministic route

## Why this task has a bench at all

T0113 is a behavior-preserving refactor with no new features. It gets a bench because the **frame
loop moved file**, which the Global Constraints require evidence for, and because the split
introduced exactly one thing that could plausibly cost something on the hot path:
`FrameLoopRuntime`, a single mutable object that replaced the module-level `let`s `renderFrame` used
to close over. Closure-variable reads became property reads. The question this bench answers is
whether that is free. It is.

## Method

Both runs used `npm run bench` on the production build with the standard route
(`leo` → `moon-flyby` → `jupiter-approach`, focus events at frames 300 and 600), the same Chrome
channel, the same settle/measurement heap windows, and the **same harness**. The baseline was
produced by checking the merge base's `src/` into the working tree (`git checkout 748691b -- src`,
then removing `src/bootstrap/`, leaving `main.ts` at its original 1,655 lines), rebuilding, and
benching; the tree was then restored to HEAD and re-benched. Only `src/` was swapped — `tools/`,
`tests/` and `package.json` were identical for both runs. The paired JSON is committed as
`T0113-before.json` and `T0113-after.json`.

**Read the `gitSha` field in those files with care.** It records the committed `HEAD` at the moment
of the run, not the source that was built: the baseline run reports `f3a7f31` and the feature run
reports `864757d`. Neither of those commits touches `src/`; the baseline build really is the merge
base's source and the feature build really is HEAD's. The harness has no way to record a working
tree, and this is the same caveat `T0112-summary.md` carries.

## Paired canonical flight benchmark

| Metric                |  Baseline |     T0113 |    Delta |
| --------------------- | --------: | --------: | -------: |
| Frame median          |    6.1 ms |    6.1 ms |   0.0 ms |
| Frame p75             |   30.3 ms |   30.3 ms |   0.0 ms |
| Frame p99             |  66.70 ms |  66.80 ms | +0.10 ms |
| Work median           |    3.5 ms |    3.5 ms |   0.0 ms |
| Work p75              |  5.325 ms |   5.30 ms | −0.03 ms |
| Work p99              |  9.201 ms |  8.903 ms | −0.30 ms |
| Stabilized heap delta | 119,332 B | 122,336 B | +3,004 B |
| Max draw calls        |        49 |        49 |        0 |
| Max triangles         |    70,452 |    70,452 |        0 |
| Entry gzip            | 150,886 B | 150,616 B |   −270 B |
| Total gzip            | 583,152 B | 582,872 B |   −280 B |

Per-leg medians (frame / work, ms):

| Leg                | Baseline   | T0113      |
| ------------------ | ---------- | ---------- |
| `leo`              | 6.15 / 3.6 | 6.55 / 3.9 |
| `moon-flyby`       | 6.20 / 3.6 | 6.10 / 3.6 |
| `jupiter-approach` | 6.10 / 3.0 | 6.10 / 2.8 |

Both runs: zero browser errors, zero stability findings, route evidence
`['earth', 'moon', 'jupiter', 'jupiter']`, final focus label `Focus: Jupiter`.

## Reading the numbers

**The frame path did not change, and the aggregate numbers say so.** Median and p75 are identical to
the tenth of a millisecond on both frame time and work time. The p99 moves are ±0.3 ms on a route
whose long tail is dominated by asset activation; the per-leg table shows the spread within a single
run (`leo` +0.4 ms, `moon-flyby` −0.1 ms, `jupiter-approach` 0.0 ms) is wider than the difference
between the runs. That is the expected shape for a change that added no work: `FrameLoopRuntime` is
one object allocated once at composition time, and V8 reads a monomorphic property as cheaply as a
closure slot.

**Draw calls and triangles are bit-identical** (49 / 70,452). Nothing about what is drawn moved.

**Heap delta +3,004 B** across the 30 s stabilized window, against the 196,608 B CI ceiling — 2.5%
of the budget, and smaller than the run-to-run spread this window shows on this machine (T0112
recorded 71.6 kB and 27.8 kB on consecutive runs of the same tree). The split allocates exactly one
additional long-lived object; there is no new per-frame allocation, and `npm run test:perf-gates`
measured **77,728 B** retained growth on the production page and passed, settling in six consecutive
quiet steps.

**Bundle: −270 B entry, −280 B total.** Mildly counterintuitive — `runtime.trajectoryPredictionPending`
and its fourteen siblings are property names, which Terser does not mangle, where the old
module-level `let`s compressed to single letters. That cost is real but small, and it is more than
paid back by three module boundaries giving the minifier smaller function bodies to work with.
Either way the direction is favourable and both budgets have wide headroom: entry 150,616 B against
400,000 B, total 582,872 B against 1,000,000 B.

**No budget or golden was re-baselined by this task.** `tools/perf/performanceGate.mjs`'s golden
(draw calls 33 ±10%, triangles 82,429 ±10%, heap 196,608 B, bundle 400,000 / 1,000,000 B) is
untouched and green.

## The harness repair this bench required

`npm run bench` **did not run on `main`**. `validateFlightRoute` waits 5 s for `#orbit-title`; T0112
made **Clean** the out-of-the-box HUD, which unmounts that panel; and `installHighQualitySetting`
deliberately plants the pre-T0106 v2 settings profile, whose migration chain backfills
`hud.preset: 'clean'`. The wait could therefore never succeed, and `bench` is not a CI step, so
nothing caught it. T0112's own summary describes a `waitForReady` fix for exactly this ("presses the
HUD preset key twice to reach Engineer before measuring") which is **not present in
`tools/bench/flightBench.mjs`** — it did not survive to the merge.

Before touching anything, the failure was reproduced on the **pre-split tree**: with `src/` reverted
to the merge base, `npm run bench` fails at the same line with the same `TimeoutError`. It is not
T0113's.

The repair (`tools/bench/flightBench.mjs`, its own commit) presses the bound `hudPresetCycle` key
until `#orbit-title` is mounted, before any measurement starts:

- **Key press, not a planted Engineer profile.** Planting one would replace the v2 fixture and lose
  both things it exists for: `qualityLock: 'high'` (which sets the measured workload) and the
  v2 → v3 → v4 → v5 settings-migration coverage that runs on every bench and perf-gate invocation.
- **A loop, not two fixed presses.** The app persists the preset it lands on, so the two priming
  runs leave a v5 profile that already reads Engineer, and `SettingsRepository` prefers the newest
  generation. A blind double-press would cycle the second run from Engineer straight back past
  Clean. The loop is bounded by the ring length (3) and ends on the only preset that mounts
  `orbitReadout`.

Both runs in the table above used the repaired harness, so the comparison is apples to apples.
