# T0125 — cinematic camera and photo capture — bench summary

Raw reports: `docs/bench/T0125-before.json` (base commit `f480440`, `src/` restored),
`docs/bench/T0125-after.json` (branch head). Same machine, same session, back to back,
`npm run bench`. Both runs report `gitSha 566a9f7` because only `src/` was swapped between them —
the working tree, not the commit, is what differed.

Environment: ANGLE / Intel UHD Graphics (D3D11), 640×360, `softwareRasterizer: false`.

## What was measured, and why

The change adds a third camera to `CameraDirector.update`, a third input router to the frame loop,
one signal write per frame, and one conditional around the state-vector widget's render. Everything
else — the whole capture path — runs only when the player presses the shutter, and the bench route
never does.

| Metric                            | Before       | After        |
| --------------------------------- | ------------ | ------------ |
| max draw calls                    | 49           | 49           |
| max triangles                     | 70,452       | 70,452       |
| frame median                      | 6.1 ms       | 6.1 ms       |
| frame p75                         | 6.1 ms       | 6.1 ms       |
| frame p99                         | 6.505 ms     | 6.300 ms     |
| work median                       | 1.7 ms       | 1.7 ms       |
| work p99                          | 5.201 ms     | 5.800 ms     |
| steady heap delta over the window | +107,840 B   | +111,860 B   |
| path heap delta                   | 16,219,333 B | 16,224,057 B |
| stability findings                | none         | none         |

Draw calls and triangles — the two figures that move if geometry or state changed — are
bit-identical. The frame-time and heap differences are run-to-run noise: work p99 moved by 0.6 ms
in one direction while frame p99 moved 0.2 ms in the other, and the steady heap deltas differ by
4,020 B on a 155 MB heap (0.003%), well inside the same window's own variation.

## Cost of the new code

Entry bundle gzip **153,453 → 155,575 B (+2,122 B)**; total gzip **585,856 → 587,976 B
(+2,120 B)**. Against the ≤ 400,000 B entry and ≤ 1,000,000 B total ceilings, headroom is
unchanged in any meaningful sense.

## The capture window, deliberately excluded

`npm run test:perf-gates` measures a 30 s heap window on a page that never captures, so the gate
never sees this window — and it must not, because a capture is not steady state. One capture
transiently allocates a PNG `Blob` (41,911 B for the frame the browser gate photographed, order
1–4 MB at 1280×720 over a planet), one object URL, one frozen `CaptureMeta` with its position
triple, one filename string and the promise chain. All become unreachable when the sink resolves and
the URL is revoked in its `finally`. It also spends one extra full render at the moment of capture,
which is a user-initiated frame-time spike, not a per-frame regression.

This exclusion is written down in `docs/performance-spec.md` §5 rather than left for the gate to
discover.

## Gate results on the branch

`npm run test:perf-gates`: findings `[]`, production workload **49 draw calls / 70,452 triangles**
matching the committed golden, heap settled inside the per-step budget, both negative controls
still failing as designed. No golden and no budget was re-baselined by this task.

`npm run test:cinematic-photo` captured `solar-voyager-20260101T000025Z-earth-001.png`, a
**41,911-byte** PNG intercepted from the browser download (verified by its magic bytes), with the
metadata stamped from the live snapshot: τ 25.0489 s, γ_max 1.0000000080, dominant body `earth`,
position 1.47e8 km from the Sun.
