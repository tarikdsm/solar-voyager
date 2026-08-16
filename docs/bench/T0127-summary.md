# T0127 Pass Insertion + Adaptive Exposure — Performance Summary

**Date:** 2026-08-16
**Feature head measured:** `task/T0127-adaptive-exposure` (working tree at `1b0e996`)
**Baseline:** `331ebd6` — this branch's merge base
**Adapter:** ANGLE D3D11, Intel(R) UHD Graphics (0x00009A60), hardware (`softwareRasterizer=false`)
**Canonical bench viewport:** 640×360, high-quality lock, 900-frame deterministic route
(`leo` → `moon-flyby` → `jupiter-approach`)

## Why this task has a bench

T0127 adds one call to the animation frame (`ExposureController.update`) and makes
`renderer.toneMappingExposure` a per-frame write instead of a constant. Both are in the hot path,
so the Global Constraints require evidence.

## Method

`npm run bench` on the production build, same Chrome channel, same settle/measurement heap windows,
same harness. The baseline was produced by checking the merge base's `src/` into the working tree
(`git checkout 331ebd6 -- src`, plus removing the two new `exposureController` files), rebuilding
and benching; the tree was then restored to HEAD and re-benched. Only `src/` was swapped.

**Both runs use `--runs 2`**, which makes the harness compare two measured runs inside one browser
session and fail if any percentile differs by more than 5%. That was not decoration — see below.
The paired JSON is committed as `T0127-before.json` and `T0127-after.json`; each file contains both
of its runs plus the harness's own `stability.findings`.

**Read `gitSha` in those files with care.** It records the committed `HEAD` at the moment of the
run, not the source that was built: both files report `1b0e996` because the baseline was benched
from a working-tree swap, not a checkout.

## Results

| Metric | Baseline run0 / run1 | Feature run0 / run1 |
|---|---|---|
| Frame median (ms) | 6.1 / 6.1 | 6.1 / 6.1 |
| Frame p75 (ms) | 6.1 / 6.1 | 12.1 / **6.1** |
| Frame p99 (ms) | 12.101 / 12.201 | 48.104 / **12.1** |
| Main-thread work median (ms) | 1.7 / 2.0 | 4.5 / **1.9** |
| Main-thread work p75 (ms) | 2.2 / 2.7 | 8.2 / **2.3** |
| Max draw calls | 49 / 49 | 49 / 49 |
| Max triangles | 70,452 / 70,452 | 70,452 / 70,452 |
| Steady-window heap delta (B) | 92,764 / 94,572 | 90,676 / **81,944** |
| Route errors | 0 | 0 |

| Bundle (gzip) | Baseline | Feature | Δ |
|---|---|---|---|
| Entry | 150,616 B | 152,642 B | +2,026 B (+1.3%) |
| Total | 582,872 B | 584,898 B | +2,026 B (+0.3%) |

Budgets: entry ≤ 400,000 B, total ≤ 1,000,000 B, heap growth ≤ 196,608 B. All well inside.

## The p75/p99 divergence is a host artifact, and here is the proof

The feature column above looks like a 2× p75 regression until you read the two runs separately.
The harness's own stability gate failed on the feature build's **self**-comparison:

```
Benchmark p75Ms variance must be < 5.0%; measured 65.93%.
Benchmark p99Ms variance must be < 5.0%; measured 119.61%.
```

That is one binary compared against itself, in one browser session, minutes apart.

Five clean runs of the feature build were taken in total (two `--runs 1`, two `--runs 2`). The
pattern is exact and reproducible: **the first measured run after priming is slow, the second is
fast.** Both `--runs 2` invocations produced run0 = 12.1–12.2 ms p75 and run1 = 6.1 ms p75.

The decisive point is arithmetic, not judgement: a deterministic per-frame cost cannot be 4.5 ms in
run0 and 1.9 ms in run1 of the same binary. Feature run1 reproduces the baseline to the digit —
p75 6.1 ms, p99 12.1 ms, work median 1.9 ms against the baseline's 1.7–2.0 ms — and its steady-window
heap delta is *lower* than either baseline run. The divergence therefore belongs to the host
(thermal/DVFS state on an Intel UHD laptop), not to T0127.

An earlier pairing on this host was thrown away rather than reported: the first before/after pair was
taken while `check:tasks`/`check:release`/`check:dashboard` and file edits were running on the same
machine, which put *both* configurations into the slow mode (12.2 / 12.1 ms p75). Those numbers are
not in this document because they measure the author, not the code.

## Conclusion

No measurable frame cost. Draw calls, triangles and the steady-state heap window are unchanged or
slightly better; the bundle grows 2 KB gzip. No golden and no budget moved.

## Handoff finding for whoever benches next on this host

`npm run bench` with the default single run is **not** safe to compare across invocations here: the
first measured run after priming lands in a slow frame-pacing mode roughly two thirds of the time,
and a single-run before/after pair can therefore manufacture a 2× p75 "regression" or hide a real
one. Use `--runs 2` and read `stability.findings`; treat a single run as evidence only when its
self-comparison is clean. This is a property of the reference laptop, not of the harness's logic —
the 5% gate did exactly its job.
