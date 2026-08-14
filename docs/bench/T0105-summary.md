# T0105 input engine benchmark

## Environment and method

- Before SHA: `6afb1e37e0109dec040464076b8222021f1c889b` (design-doc commit; code
  identical to the pre-T0105 tree)
- After SHA: `857cc25117ed1d01297c3778ec9ed4cece2a8ae0`
- Renderer: ANGLE / Intel(R) UHD Graphics (0x00009A60) / Direct3D 11
- Canvas: 640 x 360, device scale factor 1
- Harness: `npm run bench`, production Vite build, two cache-prime passes, one
  deterministic 900-frame route, 30 s steady-heap settle plus 30 s measurement
- Raw reports: `T0105-before.json` and `T0105-after.json`

This PR touches the frame loop (`src/main.ts`, the per-frame input poll that
replaces `commandInput.update()`), so bench evidence is required by the v2 plan's
Global Constraints even though no `render/` module changed.

## Before/after result

| Metric             |       Before |        After |     Delta |
| ------------------ | -----------: | -----------: | --------: |
| Frame median       |     6.100 ms |     6.100 ms |  0.000 ms |
| Frame p75          |     6.100 ms |     6.100 ms |  0.000 ms |
| Frame p99          |     6.300 ms |     6.300 ms |  0.000 ms |
| Frame-work median  |     1.300 ms |     1.300 ms |  0.000 ms |
| Frame-work p75     |     1.500 ms |     1.500 ms |  0.000 ms |
| Frame-work p99     |     4.802 ms |     4.103 ms | -0.699 ms |
| Steady heap growth |    104,152 B |    103,412 B |    -740 B |
| Path heap delta    | 26,618,507 B | 26,643,666 B | +25,159 B |
| Maximum draw calls |           26 |           26 |         0 |
| Maximum triangles  |       49,530 |       49,530 |         0 |
| Entry gzip         |    125,975 B |    127,190 B |  +1,215 B |
| Total gzip         |    555,755 B |    556,970 B |  +1,215 B |

Both reports completed with empty stability findings and empty error lists.

Frame cost is unchanged: the input engine replaced one per-frame
`KeyboardCommandMapper.update()` call with one `InputEngine.poll()` plus one
`InputCommandBridge.apply()`, both scalar-only and allocation-free. The
frame-work p99 difference and the path-heap difference are run-to-run variance on
this integrated GPU, not attributable signal; the median and p75 columns, which
are stable, show no movement.

## Bundle

The 1,215-gzip-byte entry growth is the whole cost of the task: the engine, the
binding registry with the shared focus policy, the interim command bridge, and
the pointer-lock adapter, minus the deleted `inputMapping.ts`. Measured A/B with
back-to-back production builds and verified deterministic across repeated builds
of the same tree.

Headroom against the v1 ceilings still in force: entry 157,810 B of 285,000 B
free, total 13,030 B of 570,000 B free. No budget or golden re-baseline is
requested.

## Gates

`npm run test:perf-gates` against the after build: all findings empty.

- Production performance fixture: 10 draw calls, 77,071 triangles — both exactly
  on the committed goldens, no re-baseline.
- Retained heap growth over the 30 s window: **-1,823 B** on the final build
  (73,648 B and -202,930 B on two earlier runs of the same code — the measurement
  is noisy around zero and always far below the 196,608 B limit). The engine's
  per-frame state is three preallocated `Uint8Array(13)`, one reused frame object
  and one reused axes object; `poll()` uses only `TypedArray.set`/`fill` and
  scalar math.
- Bundle: 127,190 B entry gzip and 556,970 B total gzip against the fixed
  285,000 B and 570,000 B ceilings.
- Allocation and draw-call negative controls were both rejected as expected.

Vitest: 137 files passed, 1 skipped; 869 tests passed, 3 skipped (base commit:
135 files, 1 skipped; 833 passed, 3 skipped). Browser gates run for this change:
camera controls (extended with the pointer-lock case), session settings, smoke,
main menu, burn log, tutorial, system map, system map panel, burn-log panel,
renderer policy, startup — all green.

Absolute timing here is from this machine's Intel UHD integrated GPU rather than
the discrete reference target used for earlier summaries; CI remains the portable
final arbiter.
