# T0122 Plume, RCS puffs, running lights — Performance Summary

**Date:** 2026-08-16
**Feature head measured:** `task/T0122-plume-rcs-lights`, working tree at `b4b3a1b`
**Baseline:** `origin/main` at `00ecae9` (this branch's merge parent), `src/` only
**Adapter:** ANGLE D3D11, Intel(R) UHD Graphics (0x00009A60), hardware (`softwareRasterizer=false`)
**Canonical bench viewport:** 640×360, high-quality lock, 900-frame deterministic route
(`leo` → `moon-flyby` → `jupiter-approach`), `--runs 2`

Reports: `docs/bench/T0122-before.json`, `docs/bench/T0122-after.json`.

## Why this task has a bench

Three new draw objects, a new per-frame `writeState`/`update` pair in the frame loop, a new
binding in `spaceScene.updateCameraRelative`, and a quaternion differentiation every frame. All of
it is on the render path, so plan §Global Constraints requires numbers.

It also has an obvious prediction, and the prediction is the interesting part: **the bench route
never touches the throttle and never issues a rotation command.** `flightBench.mjs` drives focus
and zoom, not the drive. So the beam, the nozzle glow and the puff pool are all `visible = false`
for all 900 frames, and the only cost that can show up is the bookkeeping: one snapshot read, one
quaternion difference, one magnitude evaluation, one extra effect binding. The bench is here to
confirm that is _all_ it costs, and that nothing about what is drawn moved.

## Method

Both configurations were built and benched from the same worktree, swapping only `src/`
(`git checkout origin/main -- src`, then `git checkout HEAD -- src`). `tools/`, `tests/`, `data/`
and `package.json` were identical for every run.

**Read the `gitSha` field with care.** Both reports record `b4b3a1b9`, the committed `HEAD` at run
time, not the source that was built. The harness has no way to record a working tree; this is the
same caveat `T0129-summary.md`, `T0113-summary.md` and `T0112-summary.md` carry.

## What is drawn: identical

|                | baseline | feature    |
| -------------- | -------- | ---------- |
| `maxDrawCalls` | 43       | **43**     |
| `maxTriangles` | 88,494   | **88,494** |

Byte-identical across both runs of both configurations. A coasting ship costs exactly nothing,
which is the design's claim (`visible = false`, not a zero-length beam).

The separate CI workload — `npm run test:perf-gates`, `?autostart=1` in LEO — agrees:
**27 draw calls, 100,471 triangles, `findings: []`**, matching `performance-golden.json` exactly.
**No golden was re-baselined.** The task allowed up to +4; the measured movement is 0, because the
gate's scenario also coasts. The worst case a _player_ can reach is +3 (beam, glow, puff pool),
asserted by `test:ship-vfx` in both its fixture and production phases.

## Frame time: inside this host's noise

Milliseconds, per run. `work*` are the harness's CPU-work percentiles, which are the numbers worth
reading here — the raw `p75`/`p99` on this host are dominated by compositor pacing (see below).

| metric         | baseline r0 | baseline r1 | feature r0 | feature r1 |
| -------------- | ----------- | ----------- | ---------- | ---------- |
| `medianMs`     | 6.1         | 6.1         | 6.1        | 6.1        |
| `workMedianMs` | 3.7         | 3.7         | 3.9        | 3.7        |
| `workP75Ms`    | 5.7         | 5.6         | 5.6        | 5.7        |
| `workP99Ms`    | 9.50        | 10.61       | 10.60      | 9.60       |
| `p75Ms`        | 17.93       | 18.1        | 18.1       | 18.0       |
| `p99Ms`        | 30.56       | 36.30       | 36.20      | 36.30      |

`workP99` moves by ±1.1 ms and swaps direction between the two runs of each configuration — the
spread _within_ a configuration is larger than the spread _between_ them. Median and `workP75`
are flat to the harness's 0.1 ms quantum. There is no signal here, which is the expected result
for a feature whose objects are hidden.

**T0127's host finding governs this bench and reproduced exactly.** The baseline pair failed the
harness's own stability gate — `Benchmark p99Ms variance must be < 5.0%; measured 17.18%` — while
the feature pair passed it clean (`findings: []`). That is bimodal frame pacing on this machine,
not a baseline that is worse than the feature: run 0 of the baseline landed in the fast mode
(`p99 30.3`) and run 1 in the slow one (`p99 36.3`), while both feature runs landed slow. Reading
that as "the feature made p99 better" would be reading the pacing mode, not the code. It is
recorded rather than chased, per T0127's and T0129's handoffs.

## Heap

|                                 | baseline r0 | baseline r1 | feature r0 | feature r1 |
| ------------------------------- | ----------- | ----------- | ---------- | ---------- |
| `heapDeltaBytes` (steady state) | 98,720      | 102,256     | 98,544     | 90,488     |

Steady-state retained growth is flat to slightly lower. The CI heap gate is the authority and it
is green: **15,292 B retained over the 30 s window** against a 196,608 B budget, settled in 6
steps. Zero per-frame allocation was the design constraint and the numbers do not contradict it:
every buffer, material, geometry and pool entry is built at setup, the frame path writes only into
typed arrays and uniforms, and the one place a string is built (`effectBindingGuard`'s warning) is
behind a once-per-session flag.

`pathHeapDeltaBytes` is noisier (16.3 MB baseline vs 19–29 MB feature) but that counter measures
the _whole_ 900-frame route including asset streaming and GC scheduling, not retention; the
settled figures above and the CI gate are what the budget is written against.

## Bundle

|            | baseline  | feature   | delta                             |
| ---------- | --------- | --------- | --------------------------------- |
| entry gzip | 166,154 B | 170,925 B | **+4,771 B** (budget 400,000 B)   |
| total gzip | 599,307 B | 604,078 B | **+4,771 B** (budget 1,000,000 B) |

+4.8 KB gzip for six new modules, two GLSL hook sets and a 32×32 procedural sprite texture.
Headroom after this task: 229 KB on the entry chunk, 396 KB on the total.

## Verdict

Nothing drawn changed, nothing measurable in frame time changed, retained heap is flat, and the
bundle grew by 4.8 KB against 396 KB of headroom. No golden and no budget moved.
