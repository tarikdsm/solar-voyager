# T0001 scaffold benchmark summary

## Method

Both reports use unchanged measurement logic from `npm run bench:scaffold` with a production build,
Playwright Chromium, a 1280 x 720 viewport, 120 warm-up frames, 600 sampled frames, and fixed
preview port 4174. The final build was measured twice. Both final runs recorded commit
`f5688114b662c023fd6a0b7fddf43c8628dcb8c1`, completed without console or page errors, and
released port 4174.

## Dependency decisions

The scaffold's runtime dependencies are covered by existing accepted decisions:
[ADR-005](../decisions/ADR-005-preact-hud.md) selects Preact plus `@preact/signals` for the HUD,
and [ADR-008](../decisions/ADR-008-webgl2-adaptive-quality.md) selects three.js `WebGLRenderer`
with WebGL2. These records satisfy the runtime-dependency ADR requirement in
`docs/coding-standards.md`; ADR-008 also owns the renderer policy referenced by
`docs/performance-spec.md`. No duplicate ADR is needed for T0001.

## Before and after

| Metric                   |                                2D baseline |                          Three.js + Preact |           Change |
| ------------------------ | -----------------------------------------: | -----------------------------------------: | ---------------: |
| Commit                   | `bec528937b703b41c6e1ed86da4699340d6870ea` | `f5688114b662c023fd6a0b7fddf43c8628dcb8c1` |                - |
| Median frame time        |                                    16.7 ms |                                    16.7 ms |           0.0 ms |
| p75 frame time           |                                    16.7 ms |                                    16.7 ms |           0.0 ms |
| p99 frame time           |                                    16.8 ms |                                    16.8 ms |           0.0 ms |
| Heap delta after warm-up |                              +61,148 bytes |                             -963,808 bytes | -1,024,956 bytes |
| Canvas CSS size          |                                 1280 x 720 |                                 1280 x 720 |        unchanged |
| Canvas backing size      |                                 1280 x 720 |                                 1280 x 720 |        unchanged |
| Console errors           |                                          0 |                                          0 |        unchanged |
| Page errors              |                                          0 |                                          0 |        unchanged |

The repeated final run measured median/p75/p99 at 16.7/16.7/16.8 ms and a heap delta of
-944,020 bytes. Its p75 variance from the canonical final run was 0%, below the required 5%.

The frame-time values show no measurable change at the harness resolution. Headless Chromium's
requestAnimationFrame cadence is the limiting signal here, so this result does not prove that the
renderer has zero cost; it shows that adding the placeholder renderer did not move the sampled
frame percentiles beyond that cadence.

## Final bundle measurement

The final production build artifacts were measured directly after `npm run build`; gzip values use
gzip level 9.

| Artifact   | Raw bytes | Gzip bytes |
| ---------- | --------: | ---------: |
| JavaScript |   531,429 |    133,593 |
| CSS        |       627 |        406 |
| HTML       |       870 |        515 |

The baseline benchmark did not record bundle bytes, so a before/after bundle delta is unavailable.
The final Vite build also reports its standard warning that the JavaScript chunk exceeds 500 kB
before gzip.

## Limitations

- Heap deltas are point-in-time `performance.memory` readings and are sensitive to garbage
  collection. A negative final delta indicates no retained heap growth over the sample; it does
  not mean that the loop made a negative number of allocations.
- The harness does not capture GPU time, draw calls, triangle counts, or shader compilation time.
- Headless results do not establish frame rate on the reference integrated-GPU hardware described
  in `docs/performance-spec.md`.
- The committed final report is the second run. The first final run exists only as repeatability
  evidence and measured a -944,020-byte heap delta.
