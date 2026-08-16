# T0112 HUD Presets, Pause and World Markers — Performance Summary

**Date:** 2026-08-15
**Feature head measured:** `task/T0112-hud-presets` (working tree at the final commit)
**Baseline:** `b29ec08` — T0110 head, this branch's merge base
**Adapter:** ANGLE D3D11, Intel(R) UHD Graphics (0x00009A60), hardware (`softwareRasterizer=false`)
**Canonical bench viewport:** 640×360, high-quality lock, 900-frame deterministic route

## Method

Both runs used `npm run bench` on the production build with the standard route
(`leo` → `moon-flyby` → …, focus events at frames 300 and 600), the same Chrome
channel, and the same settle/measurement heap windows. The baseline was produced
by checking the merge base's `src/`, `tests/`, `tools/` and `package.json` into
the working tree, rebuilding, and benching; the tree was then restored. Both
reports therefore carry the same `gitSha` — it records the committed `HEAD`,
which never moved. The paired JSON is committed as `T0112-before.json` and
`T0112-after.json`.

One deliberate difference in the harness: from T0112 a fresh profile boots into
the **Clean** preset, so `waitForReady` presses the HUD preset key twice to reach
**Engineer** before measuring. That keeps the measured HUD comparable with every
pre-T0112 baseline (all panels on screen) and keeps
`installHighQualitySetting`'s v2 profile fixture doing its job — planting a v5
document instead would short-circuit tier 1 of the settings migration chain and
retire the coverage that fixture exists for.

## Paired canonical flight benchmark

| Metric                |  Baseline |      T0112 |     Delta |
| --------------------- | --------: | ---------: | --------: |
| Frame median          |   12.2 ms |    12.2 ms |    0.0 ms |
| Frame p75             |   36.3 ms |    36.4 ms |   +0.1 ms |
| Frame p99             |   72.7 ms |    66.9 ms |   −5.8 ms |
| Work median           |    4.2 ms |     4.4 ms |   +0.2 ms |
| Work p75              |    6.0 ms |     6.2 ms |   +0.2 ms |
| Work p99              |    9.6 ms |     9.7 ms |   +0.1 ms |
| Stabilized heap delta | +94,120 B | +120,632 B | +26,512 B |
| Max draw calls        |        49 |         49 |         0 |
| Max triangles         |    70,452 |     70,452 |         0 |
| Entry gzip            | 143,772 B |  150,510 B |  +6,738 B |
| Total gzip            | 574,602 B |  582,746 B |  +8,144 B |

Frame p99 moved −5.8 ms, which is noise on this route: the 640×360 canonical
workload has a long tail dominated by asset activation, and the median and p75
are flat to a tenth of a millisecond.

## Reading the numbers

**Work +0.2 ms median** is the honest cost of this task on the frame path, and it
is where it should be. Three things were added inside the loop:

1. `HudSignalStore.publishWorldMarkers` — one camera basis, three marker
   projections and a 43-body label scan, at **10 Hz**, not per frame. It runs only
   on the frames where `publish()` committed.
2. A branch on `sceneManager.state` per frame (pause), which is a property read.
3. Four extra scalar copies per HUD sample (throttle, γ fraction, warning flags,
   radar altitude).

**Draw calls and triangles are unchanged**, which is the design working: the
markers are DOM nodes driven by CSS transforms, not scene objects. A three.js
marker layer would have cost draw calls per body and forced the f32 boundary open
a second time.

**Heap delta +26.5 KB** over the 30 s window, against the 196,608 B CI gate. The
production-page gate (`npm run test:perf-gates`) measured **64,200 B** retained
growth across its forced double-GC window and passed with the golden untouched.
The marker path itself is allocation-free — one preallocated `WorldMarkerBuffer`,
module-level scratch for the basis and the projected point, fixed-size label
slots — so the growth is the same 10 Hz string formatting the HUD has always
done, now over a few more leaf signals.

**Bundle +8.1 KB gzip total** (582,746 B against the 1,000,000 B v2 ceiling,
entry 150,510 B against 400,000 B). No budget or golden was re-baselined by this
task.

## Gates

`npm run test:perf-gates` passes: draw calls 33, triangles 82,429, both bundle
budgets satisfied, retained heap 72,572 B against the 196,608 B ceiling.

### The CI heap failure, and why the ceiling did not move

**Corrected figures.** An earlier revision of this section reported the CI failure
as 1,580,288 B. That number was the **allocation fixture** — the gate's negative
control, which retains 256 kB every frame by design; 1,580,288 / 262,144 = 6.03
frames of its signature. Its finding is printed first and in a shape
indistinguishable from a real one, which is how it was misread. The actual
production failure was **299,104 B**, 1.52x the 196,608 B ceiling, against
62,700 B measured locally — a 4.8x environment gap, not 25x.

The decay curve below was collected while chasing the wrong magnitude. It still
holds and still matters — it is what rules out a leak and establishes
pre-existence — but what it explains is a _1.5x_ overshoot, not an 8x one. Every
figure is a 30 s window at 640x360 with a forced double GC at each end, the
gate's own method:

| Configuration                                             | Retained delta |
| --------------------------------------------------------- | -------------: |
| HEAD, window opened 5 s after readiness                   |      521,887 B |
| HEAD, 5 s, restore-point ring capture disabled            |      520,731 B |
| HEAD, 5 s, trajectory predictor disabled                  |      531,027 B |
| **Branch base `b29ec08`, 5 s — none of this task's code** |  **494,527 B** |
| HEAD, window opened 45 s after readiness                  |       75,779 B |
| HEAD, window opened 90 s after readiness                  |       14,507 B |

1. **Not a leak.** The growth decays monotonically with how long the page is left
   alone and then stops. A leak does not stop.
2. **Not this task's.** The identical measurement on the branch base gives
   494,527 B. T0112 adds roughly 27 kB, about 5%.
3. **Not the obvious suspects.** Disabling the restore-point ring changed nothing
   (520,731 B); disabling the predictor changed nothing (531,027 B); DOM node
   count is constant across every window, and T0112 _cuts_ it from 10,307 to 415
   because Clean unmounts panels rather than hiding them.

**The first fix did not work.** Commit `c457c30` replaced the flat 60 s wait with
a settle loop that required two consecutive quiet 5 s steps. CI run 31932517649
failed the same gate at **277,252 B** — a 7% move, inside noise. Worse, the loop
reported `settled: true` at 65,000 ms and was immediately wrong: the next 30 s
window grew 277 kB, about 46 kB per 5 s against a 16,384 B quiet budget. Ten
seconds of evidence is not enough to certify a thirty second window; the page was
in a lull, not a steady state.

**What the gate does now.**

- **Six consecutive quiet steps, not two** — at least as much quiet evidence as
  the window it certifies (`heapSettleRequiredSteps`). The CI pattern (five quiet
  steps then a 46 kB burst) is a regression test in
  `performanceGateUtils.test.mjs`.
- **Failing to settle is a finding**, not a log line. `validateHeapSettling`
  turns `settled: false` into a gate failure naming the quiet-step count, the
  peak step growth and the budget. Before this, the loop could know it had never
  reached a steady state and the gate would still exit green — demonstrated with
  a 4,000 B/s injected leak (345 MB/day) that passed.
- **The cap is wall clock**, including the GC round-trips, not a sum of timeouts.
- **A missing or non-integer ceiling throws** instead of defaulting to Infinity,
  which would have made every step "quiet" and settled unconditionally.

**What it still does not do.** It is _not_ leak-proof, and it is more permissive
than the fixed wait it replaced for one shape of defect: growth whose rate decays
is simply waited out, now for up to 180 s instead of 60 s. A leak slower than the
per-step budget — 2 kB/s, or 172 MB/day — settles cleanly and must be caught by
the per-window ceiling instead; that limit is stated as a test rather than left to
be discovered. What the gate now guarantees is narrower and worth more: it never
reports a number it knows it could not trust.

**Coverage.** The decision logic is extracted as `createHeapSettleTracker` and
tested deterministically: a constant 4 kB/s leak never settles, a 2 kB/s leak does
(the documented limit), the CI lull-then-burst pattern does not, and decaying
warm-up growth settles once it falls inside the budget. The synthetic leak was
first written as a browser fixture and dropped: the page's own warm-up takes
~111 s to settle here, so any cap cheap enough to run on every CI job would have
reported "did not settle" with or without the injected leak — a control that
proves nothing. The gate additionally throws if a production measurement produces
no settling observation, so the wiring cannot silently regress.

**Measured, properly settled, on this machine:**

| Tree                  | Settled after | Retained delta |
| --------------------- | ------------: | -------------: |
| Branch base `b29ec08` |       111.6 s |       16,228 B |
| HEAD                  |        65.7 s |       71,632 B |
| HEAD (second run)     |       111.2 s |       27,812 B |

Both are far under the 196,608 B ceiling, and the spread between HEAD runs is
wider than the base-to-HEAD difference. **The ceiling did not move and the window
is still 30 s.**

**Open, and honestly unresolved:** whether a properly-settled measurement on the
CI runner lands under the ceiling. It cannot be determined from here — this
machine settles in 65–112 s and CI's warm-up evidently runs longer. If CI settles,
the number it reports is now trustworthy; if it cannot settle within 180 s, the
gate fails with an explicit "never settled" finding instead of a misleading heap
figure. Either outcome is the truth, which the previous version could not
promise. The unanswered question underneath it — what is still allocating in
238 kB steps a minute and a half after a page has reported a stable draw-call,
triangle, texture, geometry and program workload — is pre-existing, reproduces on
the branch base, and is not this task's to chase.

## Visual evidence

`docs/bench/T0112-clean-preset.png` — the Clean preset in flight, captured from
the production build by `tools/tests/hudPresetsRegression.mjs`: reticle, throttle
and speed strip, cruise standby line, preset indicator, and the in-world body
labels, with none of the eight v1 mission-control panels in the document.

Two things in the frame are not this task's: the tutorial offer (a fresh profile)
renders its heading over its buttons, which predates this branch and belongs to a
panel T0119/T0149 migrate; and the perf panel and settings summary are always-on
surfaces that no preset gates.
