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

`npm run test:perf-gates` passed unchanged: draw calls 33, triangles 82,429,
heap growth 64,200 B, both bundle budgets satisfied.

## Visual evidence

`docs/bench/T0112-clean-preset.png` — the Clean preset in flight, captured from
the production build by `tools/tests/hudPresetsRegression.mjs`: reticle, throttle
and speed strip, cruise standby line, preset indicator, and the in-world body
labels, with none of the eight v1 mission-control panels in the document.

Two things in the frame are not this task's: the tutorial offer (a fresh profile)
renders its heading over its buttons, which predates this branch and belongs to a
panel T0119/T0149 migrate; and the perf panel and settings summary are always-on
surfaces that no preset gates.
